import { Logger } from '@nestjs/common';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '../../src/domain/time/clock.js';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
  OutboxDispatcher,
  outboxBackoffMs,
} from '../../src/messaging/outbox/outbox.dispatcher.js';
import {
  OUTBOX_RETENTION_DAYS,
  OUTBOX_STALLED_AFTER_MS,
  OutboxReconciler,
} from '../../src/messaging/outbox/outbox.reconciler.js';
import { OutboxRecorder } from '../../src/messaging/outbox/outbox.recorder.js';
import { EnqueueService as RealEnqueueService } from '../../src/messaging/queues/enqueue.service.js';
import { JOB, QUEUE } from '../../src/messaging/queues/job-contracts.js';
import { Prisma } from '../../src/prisma/client.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { disconnectRedis, queues, resetQueues } from '../redis.harness.js';

import type { EnqueueService } from '../../src/messaging/queues/enqueue.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import type { SeedContext } from '../factories/index.js';

/**
 * The harness exposes a plain PrismaClient; the services declare PrismaService,
 * which is that class plus a driver adapter. Structurally the same client.
 */
const db = prisma as unknown as PrismaService;

const recorder = new OutboxRecorder();

let ctx: SeedContext;
let clock: FixedClock;
let enqueue: { enqueue: ReturnType<typeof vi.fn> };
let dispatcher: OutboxDispatcher;
let reconciler: OutboxReconciler;

afterAll(async () => {
  await disconnectRedis();
});

/**
 * Bookings for the same employee cannot overlap — `bookings_no_overlap` enforces
 * it — so each one is pushed an hour further out than the last.
 */
let bookingSlot = 0;

async function seedBooking(): Promise<string> {
  bookingSlot += 1;
  const booking = await prisma.booking.create({
    data: makeBooking(ctx, {
      startsAt: new Date(SLOT_FRIDAY_0900.getTime() + bookingSlot * 60 * 60_000),
    }),
  });
  return booking.id;
}

/**
 * Record one event for a booking, in its own transaction, then bring the test
 * clock up to the present.
 *
 * The clock sync is the part worth explaining. A row recorded without an explicit
 * `availableAt` gets one from Prisma's client-side `@default(now())` — the instant
 * of the insert, which is necessarily later than the instant `beforeEach` anchored
 * the clock to. Without this, every freshly recorded row would be a few
 * milliseconds in the test clock's future and no drain would ever claim it. A test
 * that wants a row held back sets `availableAt` explicitly.
 */
async function record(
  bookingId: string,
  overrides: { availableAt?: Date; payload?: unknown } = {},
): Promise<void> {
  await prisma.$transaction((tx) =>
    recorder.record(tx, {
      organizationId: ctx.organization.id,
      aggregateType: 'Booking',
      aggregateId: bookingId,
      eventType: JOB.BOOKING_CONFIRMED,
      payload: overrides.payload ?? { organizationId: ctx.organization.id, bookingId },
      ...(overrides.availableAt === undefined ? {} : { availableAt: overrides.availableAt }),
    }),
  );

  clock.set(new Date());
}

/** The booking ids the fake enqueue was called with, in call order. */
function enqueuedBookingIds(): string[] {
  return enqueue.enqueue.mock.calls.map((call) => (call[1] as { bookingId: string }).bookingId);
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  bookingSlot = 0;

  // Anchored to the real clock, then moved by hand. It has to be the real one:
  // Prisma writes `@default(now())` from this same process, so a clock pinned to
  // some arbitrary instant would disagree with the rows these tests insert.
  clock = new FixedClock(new Date());

  enqueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  dispatcher = new OutboxDispatcher(db, enqueue as unknown as EnqueueService, clock);
  reconciler = new OutboxReconciler(db, clock);
});

describe('recording', () => {
  it('rolls the event back with the state change', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({ data: makeBooking(ctx) });
        await recorder.record(tx, {
          organizationId: ctx.organization.id,
          aggregateType: 'Booking',
          aggregateId: booking.id,
          eventType: JOB.BOOKING_CONFIRMED,
          payload: { organizationId: ctx.organization.id, bookingId: booking.id },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // The point of the whole mechanism: neither survives without the other.
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.booking.count()).toBe(0);
  });

  it('refuses the root client, so a forgotten transaction is loud', async () => {
    const bookingId = await seedBooking();

    await expect(
      recorder.record(prisma, {
        organizationId: ctx.organization.id,
        aggregateType: 'Booking',
        aggregateId: bookingId,
        eventType: JOB.BOOKING_CONFIRMED,
        payload: { organizationId: ctx.organization.id, bookingId },
      }),
    ).rejects.toThrow(/root Prisma client/);

    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it('refuses an event whose payload does not match its schema', async () => {
    const bookingId = await seedBooking();

    await expect(record(bookingId, { payload: { nope: true } })).rejects.toThrow(/organizationId/);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it('stores the payload as given, undispatched and unattempted', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);

    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.payload).toEqual({ organizationId: ctx.organization.id, bookingId });
    expect(row.eventType).toBe(JOB.BOOKING_CONFIRMED);
    expect(row.dispatchedAt).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });
});

describe('dispatching', () => {
  it('dispatches an undispatched row exactly once and marks it', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);

    expect(await dispatcher.drainOnce()).toBe(1);
    expect(await dispatcher.drainOnce()).toBe(0);
    expect(enqueue.enqueue).toHaveBeenCalledTimes(1);

    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.dispatchedAt).toEqual(clock.now());
  });

  it('derives the job id from the row id, so a redelivery is a no-op', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);
    await dispatcher.drainOnce();

    const row = await prisma.outboxEvent.findFirstOrThrow();
    // `outbox-<id>`, not the plan's `outbox:<id>`: BullMQ rejects a colon in a
    // custom job id. See Task 4.1.
    expect(enqueue.enqueue.mock.calls[0]?.[2]).toEqual({ jobId: `outbox-${row.id}` });
  });

  it('passes the event type and payload through unchanged', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);
    await dispatcher.drainOnce();

    expect(enqueue.enqueue.mock.calls[0]?.[0]).toBe(JOB.BOOKING_CONFIRMED);
    expect(enqueue.enqueue.mock.calls[0]?.[1]).toEqual({
      organizationId: ctx.organization.id,
      bookingId,
    });
  });

  it('leaves availableAt in the future alone, then claims it once it is due', async () => {
    const bookingId = await seedBooking();
    await record(bookingId, { availableAt: new Date(clock.now().getTime() + 60_000) });

    expect(await dispatcher.drainOnce()).toBe(0);

    clock.advanceMinutes(1);
    expect(await dispatcher.drainOnce()).toBe(1);
  });

  it('backs off and records the error when enqueue throws, without dispatching', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);
    enqueue.enqueue.mockRejectedValueOnce(new Error('redis down'));

    expect(await dispatcher.drainOnce()).toBe(0);

    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.dispatchedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('redis down');
    expect(row.availableAt).toEqual(new Date(clock.now().getTime() + outboxBackoffMs(0)));
  });

  it('grows the backoff with each failure', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      enqueue.enqueue.mockRejectedValueOnce(new Error('still down'));
      await dispatcher.drainOnce();

      const row = await prisma.outboxEvent.findFirstOrThrow();
      expect(row.attempts, `attempt ${String(attempt)}`).toBe(attempt + 1);
      expect(row.availableAt, `backoff after attempt ${String(attempt)}`).toEqual(
        new Date(clock.now().getTime() + outboxBackoffMs(attempt)),
      );

      // Move to the row's new due time so the next iteration can claim it.
      clock.set(row.availableAt);
    }
  });

  it('caps the backoff at an hour rather than growing without bound', () => {
    expect(outboxBackoffMs(0)).toBe(30_000);
    expect(outboxBackoffMs(1)).toBe(60_000);
    expect(outboxBackoffMs(20)).toBe(3_600_000);
  });

  it('stops claiming a row once it has exhausted its attempts', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);
    await prisma.outboxEvent.updateMany({ data: { attempts: OUTBOX_MAX_ATTEMPTS } });

    expect(await dispatcher.drainOnce()).toBe(0);
    expect(enqueue.enqueue).not.toHaveBeenCalled();
  });

  it('fails the row rather than the batch when the event type is no longer declared', async () => {
    const broken = await seedBooking();
    const healthy = await seedBooking();
    await record(broken);
    await record(healthy);

    // Simulates a job removed from JOB while rows naming it are still in flight.
    await prisma.outboxEvent.updateMany({
      where: { aggregateId: broken },
      data: { eventType: 'booking.removed_in_a_later_release' },
    });

    // The healthy row still goes out; only the undeclared one is held back.
    expect(await dispatcher.drainOnce()).toBe(1);
    expect(enqueuedBookingIds()).toEqual([healthy]);

    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: broken } });
    expect(row.dispatchedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('not a declared job');
  });

  it('dispatches in availableAt order, so a delayed event does not jump the queue', async () => {
    const later = await seedBooking();
    const earlier = await seedBooking();

    await record(later);
    await record(earlier, { availableAt: new Date(clock.now().getTime() - 60_000) });

    await dispatcher.drainOnce();

    expect(enqueuedBookingIds()).toEqual([earlier, later]);
  });
});

describe('concurrency', () => {
  it('does not double-dispatch under two concurrent dispatchers', async () => {
    const bookingId = await seedBooking();
    for (let i = 0; i < 2 * OUTBOX_BATCH_SIZE; i += 1) await record(bookingId);

    const second = new OutboxDispatcher(db, enqueue as unknown as EnqueueService, clock);
    const [a, b] = await Promise.all([dispatcher.drainOnce(), second.drainOnce()]);

    // Every row goes out, none of them twice. Note what this does and does not
    // show: it rules out claiming without a lock, which would enqueue 40 times. It
    // cannot tell FOR UPDATE from FOR UPDATE SKIP LOCKED, because a blocking claim
    // would also end at 20 — that distinction is the next test's job.
    expect(a + b).toBe(2 * OUTBOX_BATCH_SIZE);
    expect(enqueue.enqueue).toHaveBeenCalledTimes(2 * OUTBOX_BATCH_SIZE);
    expect(await prisma.outboxEvent.count({ where: { dispatchedAt: null } })).toBe(0);

    const jobIds = enqueue.enqueue.mock.calls.map((call) => (call[2] as { jobId: string }).jobId);
    expect(new Set(jobIds).size).toBe(2 * OUTBOX_BATCH_SIZE);
  });

  it('skips a row another transaction holds, rather than waiting for it', async () => {
    // This is the test that pins SKIP LOCKED specifically. Without it the claim
    // would block on the held row until the holder commits — the drain would stall
    // for as long as another worker's batch takes, which is the throughput problem
    // SKIP LOCKED exists to avoid.
    const held = await seedBooking();
    const free = await seedBooking();
    await record(held);
    await record(free);

    const heldRow = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: held } });

    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM outbox_events WHERE id = ${heldRow.id} FOR UPDATE`,
        );
        signalLocked();
        await release;
      },
      { timeout: 20_000 },
    );

    try {
      await Promise.race([locked, holder]);

      // Only the free row is claimable. If the claim blocked instead of skipping,
      // this would sit here until the drain's own transaction timeout fired.
      expect(await dispatcher.drainOnce()).toBe(1);
      expect(enqueuedBookingIds()).toEqual([free]);
    } finally {
      releaseLock();
      await holder;
    }

    // Once released, the previously locked row is claimed as normal.
    expect(await dispatcher.drainOnce()).toBe(1);
    expect(enqueuedBookingIds()).toEqual([free, held]);
  });

  it('claims at most one batch per drain', async () => {
    const bookingId = await seedBooking();
    for (let i = 0; i < OUTBOX_BATCH_SIZE + 10; i += 1) await record(bookingId);

    expect(await dispatcher.drainOnce()).toBe(OUTBOX_BATCH_SIZE);
    expect(await dispatcher.drainOnce()).toBe(10);
  });
});

describe('reconciling', () => {
  it('reports nothing when the outbox is empty', async () => {
    expect(await reconciler.health()).toEqual({
      pending: 0,
      stalled: 0,
      exhausted: 0,
      oldestPendingAgeSeconds: null,
    });
  });

  it('counts a fresh row as pending but not stalled', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);

    const health = await reconciler.health();
    expect(health.pending).toBe(1);
    expect(health.stalled).toBe(0);
    expect(health.exhausted).toBe(0);
    expect(health.oldestPendingAgeSeconds).toBeLessThan(60);
  });

  it('counts a row that has sat undispatched as stalled', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);

    clock.set(new Date(clock.now().getTime() + OUTBOX_STALLED_AFTER_MS + 60_000));

    const health = await reconciler.health();
    expect(health.pending).toBe(1);
    expect(health.stalled).toBe(1);
    expect(health.oldestPendingAgeSeconds).toBeGreaterThan(OUTBOX_STALLED_AFTER_MS / 1000);
  });

  it('counts an exhausted row separately, and not as pending', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);
    await prisma.outboxEvent.updateMany({ data: { attempts: OUTBOX_MAX_ATTEMPTS } });

    const health = await reconciler.health();
    expect(health.exhausted).toBe(1);
    expect(health.pending).toBe(0);
    expect(health.stalled).toBe(0);
  });

  it('does not use an exhausted row to calculate the oldest pending age', async () => {
    const exhausted = await seedBooking();
    const pending = await seedBooking();
    await record(exhausted);
    await record(pending);
    await prisma.outboxEvent.updateMany({
      where: { aggregateId: exhausted },
      data: {
        attempts: OUTBOX_MAX_ATTEMPTS,
        createdAt: new Date(clock.now().getTime() - OUTBOX_STALLED_AFTER_MS - 60_000),
      },
    });

    expect((await reconciler.health()).oldestPendingAgeSeconds).toBeLessThan(60);
  });

  it('logs the total stalled count while naming only a bounded sample', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const bookingId = await seedBooking();
    for (let index = 0; index < 21; index += 1) await record(bookingId);
    clock.set(new Date(clock.now().getTime() + OUTBOX_STALLED_AFTER_MS + 1));

    await reconciler.reconcile();

    expect(String(error.mock.calls.at(-1)?.[0])).toMatch(/^21 stalled outbox rows/);
    error.mockRestore();
  });

  it('prunes dispatched rows past the retention window and keeps the rest', async () => {
    const old = await seedBooking();
    const recent = await seedBooking();
    const undelivered = await seedBooking();
    await record(old);
    await record(recent);
    await record(undelivered);

    const now = clock.now();
    await prisma.outboxEvent.updateMany({
      where: { aggregateId: old },
      data: { dispatchedAt: new Date(now.getTime() - (OUTBOX_RETENTION_DAYS + 1) * 86_400_000) },
    });
    await prisma.outboxEvent.updateMany({
      where: { aggregateId: recent },
      data: { dispatchedAt: new Date(now.getTime() - 86_400_000) },
    });

    const result = await reconciler.reconcile();

    expect(result.deleted).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: old } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: recent } })).toBe(1);
    // An undispatched row is never pruned, however old it is.
    expect(await prisma.outboxEvent.count({ where: { aggregateId: undelivered } })).toBe(1);
  });

  it('returns counts alongside what it pruned', async () => {
    const bookingId = await seedBooking();
    await record(bookingId);

    expect(await reconciler.reconcile()).toEqual({
      pending: 1,
      stalled: 0,
      exhausted: 0,
      oldestPendingAgeSeconds: expect.any(Number) as number,
      deleted: 0,
    });
  });
});

describe('end to end, through the real queue', () => {
  // Everything above uses a fake enqueue, which proves the outbox's own logic but
  // not that a committed row actually reaches Redis. This closes that loop with the
  // real EnqueueService and the real BullMQ queues.
  beforeEach(async () => {
    await resetQueues();
  });

  it('lands a recorded event on the queue its job maps to', async () => {
    const real = new RealEnqueueService(queues);
    const liveDispatcher = new OutboxDispatcher(db, real, clock);

    const bookingId = await seedBooking();
    await record(bookingId);

    expect(await liveDispatcher.drainOnce()).toBe(1);

    const row = await prisma.outboxEvent.findFirstOrThrow();
    const [job] = await queues[QUEUE.BOOKING].getJobs(['waiting']);

    expect(job?.name).toBe(JOB.BOOKING_CONFIRMED);
    expect(job?.id).toBe(`outbox-${row.id}`);
    expect(job?.data).toMatchObject({ organizationId: ctx.organization.id, bookingId });
  });

  it('does not enqueue twice when the same row is dispatched again', async () => {
    const real = new RealEnqueueService(queues);
    const liveDispatcher = new OutboxDispatcher(db, real, clock);

    const bookingId = await seedBooking();
    await record(bookingId);
    await liveDispatcher.drainOnce();

    // Simulates the crash window the design accepts: the job reached Redis but the
    // row was never marked, so the next drain re-enqueues it. BullMQ discards the
    // duplicate because the job id is derived from the row id.
    await prisma.outboxEvent.updateMany({ data: { dispatchedAt: null } });
    expect(await liveDispatcher.drainOnce()).toBe(1);

    expect(await queues[QUEUE.BOOKING].getJobs(['waiting'])).toHaveLength(1);
  });
});
