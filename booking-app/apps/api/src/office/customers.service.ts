import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../booking/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import { isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { Money } from '../domain/money/money.js';
import { CLOCK } from '../domain/time/clock.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { decodeCursor, keysetOrderBy, keysetWhere, toPage } from './cursor.js';
import { receivedFrom, refundedFrom } from './received.js';

import type { Clock } from '../domain/time/clock.js';
import type { Customer, Prisma } from '../prisma/client.js';
import type {
  AuditLogQuery,
  AuditLogResponse,
  CustomerListQuery,
  CustomerListResponse,
  EraseCustomerResponse,
  OfficeCustomer,
  OfficeCustomerDetail,
  UpdateCustomerRequest,
} from '@shape-and-flow/booking-contracts';

/**
 * Customers, and the audit log.
 *
 * **Erasure pseudonymises rather than deletes**, and that is the design rather than a
 * shortcut. The bookings are the business's own record of what it sold — it owes tax on
 * them and may have to produce them for years — so deleting the customer would either
 * cascade away that record or fail on a foreign key. What erasure removes is everything
 * that identifies the person: name, address, phone, and the email, which is replaced
 * with a value unique enough to keep the `(organizationId, emailNormalized)` constraint
 * satisfied without being reachable.
 *
 * It is refused while money is unsettled. A pending refund needs somewhere to go, and a
 * booking that has been paid for but not yet held is one the customer may still want.
 */
@Injectable()
export class CustomersService {
  private readonly logger = new Logger('Customers');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(query: CustomerListQuery): Promise<CustomerListResponse> {
    const rows = await this.prisma.customer.findMany({
      where: {
        organizationId: this.organizationId(),
        AND: [
          search(query.q),
          ...(query.cursor === undefined
            ? []
            : [keysetWhere('createdAt', 'desc', decodeCursor(query.cursor))]),
        ],
      },
      orderBy: keysetOrderBy('createdAt', 'desc'),
      take: query.limit + 1,
    });

    const page = toPage(rows, query.limit, (row) => row.createdAt.toISOString());

    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async detail(id: string): Promise<OfficeCustomerDetail> {
    const customer = await this.load(id);

    const bookings = await this.prisma.booking.findMany({
      where: { customerId: id, organizationId: this.organizationId() },
      select: {
        id: true,
        reference: true,
        status: true,
        startsAt: true,
        serviceNameSnapshot: true,
        employeeId: true,
        priceCentsSnapshot: true,
        currency: true,
        payments: { select: { amountCents: true, currency: true, status: true } },
        manualPayments: { select: { amountCents: true, currency: true } },
        refunds: { select: { amountCents: true, currency: true, status: true } },
      },
      orderBy: { startsAt: 'desc' },
    });

    // What they have actually paid, net of refunds that have settled. A pending refund
    // is money still with the business, and counting it as returned would understate the
    // relationship until Stripe answers.
    const currency = this.organizations.get().currency;
    const lifetimeValue = bookings.reduce(
      (total, booking) =>
        total.plus(receivedFrom(booking, currency)).minus(refundedFrom(booking, currency)),
      Money.zero(currency),
    );

    return {
      ...toDto(customer),
      bookings: bookings.map((booking) => ({
        id: booking.id,
        reference: booking.reference,
        status: booking.status,
        startsAt: booking.startsAt.toISOString(),
        serviceName: booking.serviceNameSnapshot,
        employeeId: booking.employeeId,
        price: { amountCents: booking.priceCentsSnapshot, currency: booking.currency },
      })),
      lifetimeValue: lifetimeValue.toJSON(),
    };
  }

  async update(
    id: string,
    officeUserId: string,
    patch: UpdateCustomerRequest,
  ): Promise<OfficeCustomer> {
    const before = await this.load(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const customer = await this.write(tx, id, {
        ...(patch.firstName === undefined ? {} : { firstName: patch.firstName }),
        ...(patch.lastName === undefined ? {} : { lastName: patch.lastName }),
        ...(patch.email === undefined
          ? {}
          : { email: patch.email, emailNormalized: patch.email.trim().toLowerCase() }),
        ...(patch.phone === undefined ? {} : { phone: patch.phone }),
        ...(patch.locale === undefined ? {} : { locale: patch.locale }),
        ...(patch.internalNote === undefined ? {} : { internalNote: patch.internalNote }),
      });

      await this.audit.record(tx, {
        organizationId: customer.organizationId,
        officeUserId,
        action: 'CUSTOMER_UPDATED',
        entityType: 'Customer',
        entityId: customer.id,
        summary: `customer ${customer.id} updated`,
        // Both sides pass through the audit service's redaction, so the email and phone
        // are censored there rather than here — the shape survives, the values do not.
        before: toDto(before),
        after: toDto(customer),
      });

      return customer;
    });

    return toDto(updated);
  }

  /**
   * Pseudonymise, keeping the bookings.
   *
   * Refused while a payment or refund is unsettled, because both are conversations that
   * are not over: a pending refund has a destination, and a booking that is paid for but
   * has not happened is one somebody may still turn up for.
   */
  async erase(id: string, officeUserId: string): Promise<EraseCustomerResponse> {
    const customer = await this.load(id);
    const organizationId = customer.organizationId;
    const now = this.clock.now();

    const [unsettledPayments, unsettledRefunds] = await Promise.all([
      this.prisma.payment.count({
        where: { organizationId, booking: { customerId: id }, status: 'PENDING' },
      }),
      this.prisma.refund.count({
        where: { organizationId, booking: { customerId: id }, status: 'PENDING' },
      }),
    ]);

    if (unsettledPayments + unsettledRefunds > 0) {
      throw new AppError('PAYMENT_NOT_REFUNDABLE', {
        message: 'Settle the outstanding payment or refund before erasing this customer.',
        details: { unsettledPayments, unsettledRefunds },
      });
    }

    const bookingsRetained = await this.prisma.booking.count({
      where: { organizationId, customerId: id },
    });

    await this.prisma.$transaction(async (tx) => {
      // Unique enough to keep the (organizationId, emailNormalized) constraint satisfied,
      // and not an address anybody can be reached at. `.invalid` is reserved by RFC 2606
      // for exactly this, so it can never route anywhere.
      const pseudonym = `erased-${customer.id}@erased.invalid`;

      await this.write(tx, id, {
        firstName: 'Erased',
        lastName: 'Customer',
        email: pseudonym,
        emailNormalized: pseudonym,
        phone: null,
        internalNote: null,
        marketingConsentAt: null,
        archivedAt: now,
      });

      // The one audit row that has to outlive its subject: after this transaction there
      // is no other record that the request was made and honoured.
      await this.audit.record(tx, {
        organizationId,
        officeUserId,
        action: 'CUSTOMER_ERASED',
        entityType: 'Customer',
        entityId: id,
        summary: `customer ${id} pseudonymised, ${String(bookingsRetained)} booking(s) retained`,
        after: { erasedAt: now.toISOString(), bookingsRetained },
      });
    });

    this.logger.log(`customer ${id} erased; ${String(bookingsRetained)} booking(s) retained`);

    return { customerId: id, erasedAt: now.toISOString(), bookingsRetained };
  }

  /* ── audit log ────────────────────────────────────────────────────────────────── */

  async auditLog(query: AuditLogQuery): Promise<AuditLogResponse> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId: this.organizationId(),
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.officeUserId === undefined ? {} : { officeUserId: query.officeUserId }),
        ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
        ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
        ...(query.cursor === undefined
          ? {}
          : keysetWhere('createdAt', 'desc', decodeCursor(query.cursor))),
      },
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        summary: true,
        officeUserId: true,
        correlationId: true,
        ipAddress: true,
        createdAt: true,
        officeUser: { select: { firstName: true, lastName: true } },
      },
      orderBy: keysetOrderBy('createdAt', 'desc'),
      take: query.limit + 1,
    });

    const page = toPage(rows, query.limit, (row) => row.createdAt.toISOString());

    return {
      items: page.items.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        officeUserId: row.officeUserId,
        officeUserName:
          row.officeUser === null ? null : `${row.officeUser.firstName} ${row.officeUser.lastName}`,
        correlationId: row.correlationId,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /* ── internals ──────────────────────────────────────────────────────────────── */

  private async load(id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId: this.organizationId() },
    });

    if (customer === null) throw new AppError('NOT_FOUND', { message: 'Customer not found.' });
    return customer;
  }

  /** Write, turning a colliding address into a 400 that names the field. */
  private async write(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CustomerUncheckedUpdateInput,
  ): Promise<Customer> {
    try {
      return await tx.customer.update({ where: { id }, data });
    } catch (error) {
      if (isUniqueViolation(error, 'emailNormalized')) {
        throw new AppError('VALIDATION_FAILED', {
          message: 'Another customer already uses that address.',
          details: { issues: [{ path: ['email'], message: 'already in use', code: 'duplicate' }] },
        });
      }
      throw error;
    }
  }

  private organizationId(): string {
    return this.organizations.getOrganizationId();
  }
}

/** Last name, first name, email or phone — the four things an office types. */
function search(q: string | undefined): Prisma.CustomerWhereInput {
  if (q === undefined) return {};

  return {
    OR: [
      { lastName: { contains: q, mode: 'insensitive' } },
      { firstName: { contains: q, mode: 'insensitive' } },
      { emailNormalized: { contains: q.toLowerCase() } },
      { phone: { contains: q } },
    ],
  };
}

function toDto(customer: Customer): OfficeCustomer {
  return {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    locale: customer.locale,
    internalNote: customer.internalNote,
    marketingConsentAt: customer.marketingConsentAt?.toISOString() ?? null,
    archivedAt: customer.archivedAt?.toISOString() ?? null,
    createdAt: customer.createdAt.toISOString(),
  };
}
