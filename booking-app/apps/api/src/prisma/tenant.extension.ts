import { AppError } from '../common/errors/app-error.js';

import { Prisma } from './client.js';

import type { PrismaClient } from './client.js';

/**
 * Makes an unscoped query a loud failure instead of a silent cross-tenant leak.
 *
 * Phase 1 runs a single organization, so nothing here is load-bearing *today*.
 * That is exactly why it belongs here now: the day a second organization exists,
 * every query written in the meantime is already scoped, and the ones that are
 * not have been failing tests since they were written.
 *
 * Three layers enforce the same invariant. This is the second; the first is a
 * contract test asserting no request schema accepts an organizationId, and the
 * third is integration tests that seed two organizations and assert isolation
 * through the HTTP surface.
 */

/**
 * Models whose `organizationId` is NOT NULL, and which therefore must never be
 * queried without it.
 *
 * Prisma 7 no longer exposes `Prisma.dmmf`, so this cannot be derived at
 * runtime. It is instead cross-checked against schema.prisma by
 * tenant.extension.spec.ts, which fails if a model gains or loses a required
 * organizationId without this list changing — so the set cannot drift.
 *
 * Deliberately excluded:
 *  - Organization, which is the tenant root.
 *  - IdempotencyKey, StripeWebhookEvent and MessagingWebhookEvent, whose
 *    organizationId is nullable because the row is written before the tenant is
 *    known. They are addressed by their own unique provider keys, and the
 *    reconcilers legitimately scan them globally.
 */
export const ORG_SCOPED_MODELS: readonly Prisma.ModelName[] = [
  'OrganizationSettings',
  'ClosedDay',
  'OfficeUser',
  'PasswordResetToken',
  'Employee',
  'WorkingHours',
  'Break',
  'AvailabilityException',
  'TimeOff',
  'BlockedTime',
  'ServiceCategory',
  'Service',
  'EmployeeService',
  'Customer',
  'Booking',
  'BookingStatusHistory',
  'ManagementToken',
  'Payment',
  'ManualPayment',
  'Refund',
  'CancellationRequest',
  'RescheduleRequest',
  'Notification',
  'OutboxEvent',
  'AuditLog',
];

const SCOPED = new Set<string>(ORG_SCOPED_MODELS);

/**
 * Operations that must carry organizationId in `where`.
 *
 * findUnique, findUniqueOrThrow and upsert are absent on purpose: they address a
 * row by a unique key, which cannot express a tenant filter. Their callers must
 * assert ownership on the result instead — see `assertOwned`.
 */
const GUARDED_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operations that get organizationId injected when it is absent. */
const INJECTED_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * True when a `where` clause constrains organizationId, including inside a
 * top-level AND — which is how a composed filter usually looks.
 */
function hasOrganizationScope(where: unknown): boolean {
  if (where === null || typeof where !== 'object') return false;

  const clause = where as Record<string, unknown>;
  if (clause.organizationId !== undefined) return true;

  const and = clause.AND;
  if (Array.isArray(and)) return and.some(hasOrganizationScope);
  return hasOrganizationScope(and);
}

function throwUnscoped(model: string, operation: string): never {
  throw new AppError('UNSCOPED_TENANT_QUERY', {
    status: 500,
    message:
      `${model}.${operation} requires organizationId in its where clause. ` +
      'Scope the query, or use the raw PrismaService if this is deliberately global.',
    details: { model, operation },
  });
}

/**
 * Assert that a row addressed by unique key belongs to the expected
 * organization. Returns 404 rather than 403: a 403 confirms the id exists,
 * which is an enumeration oracle.
 */
export function assertOwned<T extends { organizationId: string }>(
  row: T | null,
  organizationId: string,
): T {
  if (row?.organizationId !== organizationId) {
    throw new AppError('NOT_FOUND', { status: 404, message: 'Resource not found.' });
  }
  return row;
}

/** Adds organizationId to create payloads that omit it, leaving explicit values alone. */
function injectOrganizationId(args: unknown, organizationId: string): unknown {
  if (args === null || typeof args !== 'object') return args;

  const typed = args as { data?: unknown };
  const { data } = typed;

  if (Array.isArray(data)) {
    const rows: unknown[] = data.map((row: unknown) =>
      row !== null && typeof row === 'object' && !('organizationId' in row)
        ? { ...row, organizationId }
        : row,
    );
    return { ...typed, data: rows };
  }

  if (data !== null && typeof data === 'object' && !('organizationId' in data)) {
    return { ...typed, data: { ...data, organizationId } };
  }

  return args;
}

function tenantGuardExtension(getOrganizationId: () => string) {
  return Prisma.defineExtension({
    name: 'tenant-guard',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!SCOPED.has(model)) return query(args);

          if (INJECTED_OPERATIONS.has(operation)) {
            return query(injectOrganizationId(args, getOrganizationId()) as typeof args);
          }

          if (GUARDED_OPERATIONS.has(operation)) {
            const { where } = args as { where?: unknown };
            if (!hasOrganizationScope(where)) throwUnscoped(model, operation);
          }

          return query(args);
        },
      },
    },
  });
}

/**
 * The tenant-guarded client every service should depend on.
 *
 * Typed as PrismaClient rather than as the extension's own return type. That is
 * accurate — a query extension intercepts calls but adds no model, field or
 * method, so the surface really is PrismaClient — and it matters in practice:
 * `$extends` produces a type built from unions of every argument shape for every
 * model, and propagating it made type-aware linting of this package take over ten
 * minutes.
 */
export type TenantPrismaClient = PrismaClient;

/** Injection token for the guarded client. */
export const TENANT_PRISMA = 'TENANT_PRISMA';

/** Wrap a client so tenant scoping is enforced. */
export function createTenantGuardedClient(
  client: PrismaClient,
  getOrganizationId: () => string,
): TenantPrismaClient {
  return client.$extends(tenantGuardExtension(getOrganizationId)) as unknown as TenantPrismaClient;
}
