import { describe, expect, it } from 'vitest';

import { FixedClock } from '../domain/time/clock.js';
import { QUEUES } from '../messaging/queues/job-contracts.js';

import { OPERATIONS_CACHE_MS, OperationsService } from './operations.service.js';

import type { InboxReconciler } from '../messaging/inbox/inbox.reconciler.js';
import type { OutboxReconciler } from '../messaging/outbox/outbox.reconciler.js';
import type { QueueRegistry } from '../messaging/queues/enqueue.service.js';
import type { NotificationReconciler } from '../notification/notification.reconciler.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const NOW = new Date('2026-08-02T09:00:00.000Z');

interface Counters {
  waiting?: number;
  active?: number;
  delayed?: number;
  failed?: number;
}

/** Every queue answers with the same counts unless one is named. */
function queuesWith(counts: Counters, only?: string): { registry: QueueRegistry; calls: number } {
  const state = { calls: 0 };
  const zero = { waiting: 0, active: 0, delayed: 0, failed: 0 };

  const registry = Object.fromEntries(
    QUEUES.map((name) => [
      name,
      {
        name,
        getJobCounts: () => {
          state.calls += 1;
          return Promise.resolve(
            only === undefined || only === name ? { ...zero, ...counts } : zero,
          );
        },
      },
    ]),
  );

  return {
    registry: registry as unknown as QueueRegistry,
    get calls() {
      return state.calls;
    },
  };
}

function serviceWith(options: {
  queues?: QueueRegistry;
  outbox?: { stalled: number; exhausted: number };
  inbox?: { stalled: number; poisoned: number };
  notifications?: { stalled: number };
  oldestExpiringUpdatedAt?: Date | null;
  clock?: FixedClock;
}): OperationsService {
  const outbox = {
    health: () =>
      Promise.resolve({
        pending: 0,
        stalled: options.outbox?.stalled ?? 0,
        exhausted: options.outbox?.exhausted ?? 0,
        oldestPendingAgeSeconds: null,
      }),
  } as unknown as OutboxReconciler;

  const kind = (stalled: number, poisoned: number) => ({ pending: 0, stalled, poisoned });

  const inbox = {
    health: () =>
      Promise.resolve({
        stripe: kind(options.inbox?.stalled ?? 0, options.inbox?.poisoned ?? 0),
        messaging: kind(0, 0),
      }),
  } as unknown as InboxReconciler;

  const notifications = {
    health: () =>
      Promise.resolve({ pending: 0, stalled: options.notifications?.stalled ?? 0, failed: 0 }),
  } as unknown as NotificationReconciler;

  const prisma = {
    booking: {
      findFirst: () =>
        Promise.resolve(
          options.oldestExpiringUpdatedAt === undefined || options.oldestExpiringUpdatedAt === null
            ? null
            : { updatedAt: options.oldestExpiringUpdatedAt },
        ),
    },
  } as unknown as PrismaService;

  return new OperationsService(
    prisma,
    outbox,
    inbox,
    notifications,
    options.queues ?? queuesWith({}).registry,
    options.clock ?? new FixedClock(NOW),
  );
}

describe('OperationsService', () => {
  it('reports the depth of every queue', async () => {
    const snapshot = await serviceWith({
      queues: queuesWith({ waiting: 3, active: 1, delayed: 2, failed: 4 }, 'booking').registry,
    }).snapshot();

    expect(snapshot.queues.booking).toEqual({ waiting: 3, active: 1, delayed: 2, failed: 4 });
    expect(snapshot.queues.maintenance).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
    });
    expect(Object.keys(snapshot.queues)).toEqual([...QUEUES]);
  });

  it('totals failed jobs across every queue', async () => {
    const snapshot = await serviceWith({
      queues: queuesWith({ failed: 2 }).registry,
    }).snapshot();

    expect(snapshot.failedJobs).toBe(2 * QUEUES.length);
  });

  it('counts an outbox row as stuck when it stalled or ran out of attempts', async () => {
    const snapshot = await serviceWith({ outbox: { stalled: 2, exhausted: 3 } }).snapshot();

    expect(snapshot.stuckOutboxRows).toBe(5);
  });

  it('counts a webhook as unprocessed only once it is older than the stall window', async () => {
    // Not "pending": a webhook received a second ago and not yet handled is the
    // system working. The dashboard tile counts those; this endpoint answers
    // "is something stuck", which is a different question.
    const snapshot = await serviceWith({ inbox: { stalled: 1, poisoned: 2 } }).snapshot();

    expect(snapshot.unprocessedWebhooks).toBe(3);
  });

  it('counts notifications that have been pending past the stall window', async () => {
    const snapshot = await serviceWith({ notifications: { stalled: 4 } }).snapshot();

    expect(snapshot.pendingNotifications).toBe(4);
  });

  it('reports how long the oldest EXPIRING booking has been in that state', async () => {
    const snapshot = await serviceWith({
      oldestExpiringUpdatedAt: new Date(NOW.getTime() - 90_000),
    }).snapshot();

    expect(snapshot.oldestExpiringBookingAgeSeconds).toBe(90);
  });

  it('reports null rather than zero when nothing is EXPIRING', async () => {
    // Zero would read as "one just entered the state", which is a different fact.
    const snapshot = await serviceWith({ oldestExpiringUpdatedAt: null }).snapshot();

    expect(snapshot.oldestExpiringBookingAgeSeconds).toBeNull();
  });

  it('degrades a figure it cannot read to -1 instead of failing the endpoint', async () => {
    const service = serviceWith({});
    // The one dependency that is not the database: an unreachable Redis must not
    // take the endpoint that would explain it.
    const broken = Object.fromEntries(
      QUEUES.map((name) => [name, { name, getJobCounts: () => Promise.reject(new Error('down')) }]),
    ) as unknown as QueueRegistry;

    const snapshot = await serviceWith({ queues: broken }).snapshot();

    expect(snapshot.failedJobs).toBe(-1);
    expect(snapshot.queues).toEqual({});
    // Everything else still answers.
    expect(snapshot.stuckOutboxRows).toBe(0);
    expect(await service.snapshot()).toBeDefined();
  });

  it('serves a second read from cache, so a dashboard poll is not a load source', async () => {
    const queues = queuesWith({});
    const service = serviceWith({ queues: queues.registry });

    await service.snapshot();
    await service.snapshot();

    expect(queues.calls).toBe(QUEUES.length);
  });

  it('recomputes once the cache is older than its window', async () => {
    const clock = new FixedClock(NOW);
    const queues = queuesWith({});
    const service = serviceWith({ queues: queues.registry, clock });

    await service.snapshot();
    clock.set(new Date(NOW.getTime() + OPERATIONS_CACHE_MS + 1));
    await service.snapshot();

    expect(queues.calls).toBe(2 * QUEUES.length);
  });
});
