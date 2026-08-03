import { Inject, Injectable, Logger } from '@nestjs/common';
import { render } from '@shape-and-flow/booking-notification-templates';

import { ExpiryService } from '../booking/expiry.service.js';
import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { CLOCK } from '../domain/time/clock.js';
import { QUEUE_REGISTRY } from '../messaging/queues/enqueue.service.js';
import { EnqueueService } from '../messaging/queues/enqueue.service.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { REDIS } from '../messaging/queues/redis.provider.js';
import { reviveDates } from '../notification/revive-dates.js';
import { seedDemoOrganization } from '../organization/demo-seed.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { Prisma } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePaymentProvider } from '../providers/payment/fake-payment.provider.js';

import type { AppConfig } from '../config/env.schema.js';
import type { Clock } from '../domain/time/clock.js';
import type { QueueRegistry } from '../messaging/queues/enqueue.service.js';
import type { DemoSeedResult } from '../organization/demo-seed.js';
import type { NotificationKind } from '../prisma/client.js';
import type { TemplateData } from '@shape-and-flow/booking-notification-templates';
import type { Redis } from 'ioredis';

/**
 * The four things a browser cannot do for itself.
 *
 * An end-to-end suite drives the product through its own interface, and that is the
 * point of it — but four operations have no interface, because in production they
 * belong to somebody else: the database's initial state, Stripe's opinion of a
 * Checkout session, Stripe's webhook signature, and the mailbox the message landed
 * in. Faking those inside the browser would prove nothing; skipping them would leave
 * the payment half of the product untested.
 *
 * Everything else the suite needs it does the way a customer or a member of staff
 * does: through the public API and the office API, with a real session.
 *
 * Reachable only when ENABLE_TEST_SUPPORT is true, which the environment schema
 * refuses in production. See test-support.module.ts.
 */
@Injectable()
export class TestSupportService {
  private readonly logger = new Logger('TestSupport');

  constructor(
    private readonly prisma: PrismaService,
    private readonly expiry: ExpiryService,
    private readonly enqueue: EnqueueService,
    private readonly payments: FakePaymentProvider,
    private readonly organizations: OrganizationContextService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QUEUE_REGISTRY) private readonly queues: QueueRegistry,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  // ── 1. the database's initial state ───────────────────────────────────────

  /**
   * Truncate, reseed, and clear everything Redis is holding.
   *
   * Guarded on the database name as well as on the flag. The flag is a boolean
   * somebody can set by accident in a shell; "the URL says booking_test or
   * booking_e2e" is a second, independent thing that has to be true before this
   * drops every row, and it is the one that would still hold if the flag leaked.
   */
  async reset(logins: { ownerPassword: string; staffPassword: string }): Promise<DemoSeedResult> {
    this.assertDisposableDatabase();

    const tables = await this.prisma.$queryRaw<{ tablename: string }[]>(Prisma.sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `);

    const list = tables.map((row) => `"${row.tablename}"`).join(', ');

    await this.prisma.$transaction([
      // A truncate takes ACCESS EXCLUSIVE. Failing in five seconds beats a request
      // that hangs because something else still holds the tables.
      this.prisma.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`),
      this.prisma.$executeRaw(
        Prisma.sql`TRUNCATE TABLE ${Prisma.raw(list)} RESTART IDENTITY CASCADE`,
      ),
    ]);

    // Everything durable, not only the rows. A reset that left Redis alone handed the
    // next test a delayed expiry job for a booking that no longer exists, a session
    // cookie for a truncated user, and — the one that actually bit — a rate-limit
    // counter, which is per IP and per hour and does not care that the database was
    // emptied. The suite spent its allowance on the first few bookings and every later
    // one came back 429.
    await Promise.all(Object.values(this.queues).map((queue) => queue.obliterate({ force: true })));
    await this.payments.reset();
    await this.clearTransientRedisKeys();

    const seeded = await seedDemoOrganization(this.prisma, logins);

    // The organization is resolved once at bootstrap and cached. Its id survives a
    // reseed — demo-seed.ts pins it — but its settings do not: a test that changed the
    // cancellation policy would otherwise leave this process enforcing the old one
    // against the freshly seeded row.
    await this.organizations.refresh();

    this.logger.warn(`reset: reseeded ${seeded.slug}`);

    return seeded;
  }

  // ── 2. Stripe's opinion of a Checkout session ─────────────────────────────

  /** Mark the session paid, as completing Checkout would. */
  async payCheckoutSession(sessionId: string): Promise<{ chargeId: string }> {
    await this.payments.markPaid(sessionId);
    return { chargeId: await this.payments.chargeIdFor(sessionId) };
  }

  /**
   * Make the next Checkout call fail, once.
   *
   * The one provider failure a browser cannot provoke. It is the failure the retry path
   * exists for — the reservation commits, the provider call does not, and the customer
   * is asked to try again — and armed in *this* process because that is where the API
   * calls the provider from.
   */
  failNextCheckout(): { armed: true } {
    this.payments.failNextWith(new Error('ECONNRESET reaching the payment provider'));
    return { armed: true };
  }

  // ── 3. Stripe's webhook signature ─────────────────────────────────────────

  /**
   * Build a signed event, and hand back the exact bytes to send.
   *
   * Deliberately not delivered from here. The caller POSTs the body to the real
   * `/api/webhooks/stripe` route, so signature verification, inbox deduplication and
   * the enqueue all run exactly as they do for Stripe. Only the signing is privileged,
   * because only the signing needs a secret the browser must never hold.
   */
  async signStripeEvent(input: {
    type: string;
    sessionId: string;
    eventId?: string | undefined;
  }): Promise<{ body: string; signature: string; eventId: string }> {
    const session = await this.payments.retrieveCheckoutSession(
      { organizationId: '', stripeAccountId: undefined },
      input.sessionId,
    );

    const eventId = input.eventId ?? `evt_fake_${input.sessionId}_${input.type}`;

    const body = JSON.stringify({
      id: eventId,
      type: input.type,
      api_version: '2026-07-29.dahlia',
      data: {
        object: {
          id: session.sessionId,
          object: 'checkout.session',
          status: session.status,
          payment_status: session.paymentStatus,
          client_reference_id: session.clientReferenceId,
          amount_total: session.amountTotalCents,
          currency: session.currency.toLowerCase(),
          payment_intent: session.paymentIntentId ?? null,
        },
      },
    });

    return { body, signature: this.payments.signatureFor(Buffer.from(body, 'utf8')), eventId };
  }

  // ── 4. the mailbox ────────────────────────────────────────────────────────

  /**
   * Every message the system decided to send, rendered.
   *
   * Read from the `notifications` table rather than from the fake providers'
   * arrays, and not for convenience: the notification worker is a different
   * process, so its in-memory outbox is not reachable from here at all. The row is
   * also the better source — it is what the product itself considers sent, and the
   * body is a pure render of the payload frozen at queue time, so re-rendering it
   * yields the same bytes the provider received.
   */
  async outbox(): Promise<OutboxMessage[]> {
    const rows = await this.prisma.notification.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        channel: true,
        locale: true,
        recipient: true,
        subject: true,
        status: true,
        payload: true,
        createdAt: true,
      },
    });

    return rows.map((row) => {
      const rendered =
        row.payload === null
          ? undefined
          : render(
              row.kind,
              row.channel,
              row.locale,
              // The same revival the send path does, from the same module: a body
              // rendered from differently-revived data is not the body that was sent.
              reviveDates(row.payload) as TemplateData[NotificationKind],
            );

      return {
        id: row.id,
        kind: row.kind,
        channel: row.channel,
        locale: row.locale,
        to: row.recipient,
        status: row.status,
        subject: rendered?.subject ?? row.subject ?? '',
        text: rendered?.text ?? '',
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  // ── the reservation clock ─────────────────────────────────────────────────

  /**
   * Phase one of the expiry saga, now rather than in five minutes.
   *
   * Moves the deadline into the past and claims the expiry. The slot stays blocked
   * afterwards — EXPIRING is in the blocking set — which is the state the suite
   * asserts on before it lets phase two run.
   */
  async expireReservationNow(sessionId: string): Promise<{ bookingId: string; outcome: string }> {
    const bookingId = await this.bookingIdFor(sessionId);

    await this.prisma.$executeRaw(
      Prisma.sql`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = ${bookingId}`,
    );

    return { bookingId, outcome: await this.expiry.beginExpiry(bookingId) };
  }

  /**
   * Phase two, in the worker.
   *
   * Enqueued rather than called directly, so the process that asks Stripe and
   * releases the slot in production is the process that does it here.
   */
  async runExpiryJob(sessionId: string): Promise<{ bookingId: string }> {
    const bookingId = await this.bookingIdFor(sessionId);
    const { organizationId } = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { organizationId: true },
    });

    await this.enqueue.enqueue(JOB.BOOKING_EXPIRY_REQUESTED, { organizationId, bookingId });

    return { bookingId };
  }

  // ── draining ──────────────────────────────────────────────────────────────

  /**
   * What is still outstanding, uncached.
   *
   * The operations snapshot behind `/health/detail` answers a similar question and
   * is deliberately cached for ten seconds, which makes it useless for deciding
   * whether the worker has caught up. This is the same numbers, read fresh.
   */
  async pending(): Promise<PendingWork> {
    const counts = await Promise.all(
      Object.entries(this.queues).map(async ([name, queue]) => {
        const jobs = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        return [name, jobs] as const;
      }),
    );

    // `now`, not "ever": a confirmed booking immediately schedules a reminder for the
    // day before the appointment, as an outbox row with a future `availableAt` and a
    // notification with a future `scheduledFor`. Counting those as outstanding work
    // means the system is never idle and every drain ends in a timeout.
    const now = this.clock.now();

    const [outbox, inbox, notifications] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { dispatchedAt: null, availableAt: { lte: now } } }),
      this.prisma.stripeWebhookEvent.count({ where: { processedAt: null } }),
      this.prisma.notification.count({
        where: { status: 'PENDING', OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
      }),
    ]);

    // Delayed jobs are excluded on purpose: a confirmed booking schedules its
    // reminder days ahead, and waiting for that to clear would never return.
    const queued = counts.reduce(
      (total, [, jobs]) => total + (jobs.waiting ?? 0) + (jobs.active ?? 0),
      0,
    );

    return {
      queued,
      failed: counts.reduce((total, [, jobs]) => total + (jobs.failed ?? 0), 0),
      unprocessedOutbox: outbox,
      unprocessedWebhooks: inbox,
      pendingNotifications: notifications,
      idle: queued === 0 && outbox === 0 && inbox === 0 && notifications === 0,
      queues: Object.fromEntries(counts),
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * The Redis state that is not a queue: sessions and rate-limit counters.
   *
   * By pattern rather than FLUSHDB, deliberately. This runs inside the API, and a
   * FLUSHDB would obey a REDIS_URL that points somewhere it should not — the
   * database-name guard above says nothing about Redis. Deleting only the two families
   * this router is responsible for cannot destroy anything else, whatever it is
   * pointed at. UNLINK rather than DEL so a large batch does not block the server.
   */
  private async clearTransientRedisKeys(): Promise<void> {
    // `{...}:hits` and `{...}:blocked` are @nestjs/throttler's; `session:*` is ours.
    for (const pattern of ['session:*', '*:hits', '*:blocked']) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        if (keys.length > 0) await this.redis.unlink(...keys);
      } while (cursor !== '0');
    }
  }

  private async bookingIdFor(sessionId: string): Promise<string> {
    const booking = await this.prisma.booking.findFirst({
      where: { stripeCheckoutSessionId: sessionId },
      select: { id: true },
    });

    if (booking === null) {
      throw new AppError('NOT_FOUND', {
        status: 404,
        message: `No booking holds checkout session ${sessionId}.`,
      });
    }

    return booking.id;
  }

  private assertDisposableDatabase(): void {
    const name = databaseNameOf(this.config.DATABASE_URL);

    if (name === null || !/^booking_(test|e2e)/.test(name)) {
      throw new AppError('TEST_SUPPORT_REFUSED', {
        status: 400,
        message:
          `Refusing to truncate "${name ?? '(unparseable)'}". The test-support reset only ` +
          'runs against a database whose name starts with booking_test or booking_e2e.',
      });
    }
  }
}

export interface OutboxMessage {
  id: string;
  kind: string;
  channel: string;
  locale: string;
  to: string;
  status: string;
  subject: string;
  text: string;
  createdAt: string;
}

export interface PendingWork {
  queued: number;
  failed: number;
  unprocessedOutbox: number;
  unprocessedWebhooks: number;
  pendingNotifications: number;
  idle: boolean;
  queues: Record<string, Record<string, number>>;
}

/** The path component of a Postgres URL, without its query string. */
function databaseNameOf(url: string): string | null {
  try {
    const name = new URL(url).pathname.replace(/^\//, '');
    return name === '' ? null : name;
  } catch {
    return null;
  }
}
