import { Test } from '@nestjs/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { runWithCorrelation } from '../../src/common/correlation/correlation.store.js';
import { EnqueueService } from '../../src/messaging/queues/enqueue.service.js';
import { JOB, QUEUE, jobIdFor } from '../../src/messaging/queues/job-contracts.js';
import { QueuesModule, DEFAULT_JOB_OPTIONS } from '../../src/messaging/queues/queues.module.js';
import { REDIS, RedisLifecycle } from '../../src/messaging/queues/redis.provider.js';
import { QUEUE_PREFIX, disconnectRedis, queues, redis, resetQueues } from '../redis.harness.js';
import { TestConfigModule } from '../test-config.module.js';

import type { JobName, JobPayload } from '../../src/messaging/queues/job-contracts.js';
import type { Redis } from 'ioredis';

const ORG = 'cms9gryv30000ja32145w5gke';
const BOOKING = 'cms9gryvd0002ja32s1nvydb2';

const enqueue = new EnqueueService(queues);

beforeEach(async () => {
  await resetQueues();
});

afterAll(async () => {
  await disconnectRedis();
});

describe('EnqueueService against a real Redis', () => {
  it('places a job on the queue its name maps to, and on no other', async () => {
    await enqueue.enqueue(JOB.BOOKING_CONFIRMED, { organizationId: ORG, bookingId: BOOKING });

    const booking = await queues[QUEUE.BOOKING].getJobs(['waiting', 'delayed']);
    expect(booking).toHaveLength(1);
    expect(booking[0]?.name).toBe(JOB.BOOKING_CONFIRMED);
    expect(booking[0]?.data).toMatchObject({ organizationId: ORG, bookingId: BOOKING });

    for (const other of [QUEUE.PAYMENT, QUEUE.NOTIFICATION, QUEUE.WEBHOOK, QUEUE.MAINTENANCE]) {
      expect(await queues[other].getJobCounts('waiting', 'delayed')).toMatchObject({
        waiting: 0,
        delayed: 0,
      });
    }
  });

  it('applies the shared default job options to a job it did not specify them for', async () => {
    // Retry policy is a queue-level default. If it silently stopped being applied,
    // every job would become fire-and-forget and nothing else would notice.
    await enqueue.enqueue(JOB.SWEEP_OUTBOX, {});

    const [job] = await queues[QUEUE.MAINTENANCE].getJobs(['waiting']);
    expect(job?.opts.attempts).toBe(DEFAULT_JOB_OPTIONS.attempts);
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential', delay: 5_000 });
  });

  it('stamps the ambient correlation id onto the payload', async () => {
    await runWithCorrelation('corr-from-request', async () => {
      await enqueue.enqueue(JOB.REFUND_REQUESTED, { organizationId: ORG, refundId: BOOKING });
    });

    const [job] = await queues[QUEUE.PAYMENT].getJobs(['waiting']);
    expect(job?.data.correlationId).toBe('corr-from-request');
  });

  it('keeps an explicit correlation id rather than overwriting it', async () => {
    // A job enqueued by the outbox dispatcher carries the correlation id of the
    // request that wrote the row, not of the dispatcher tick.
    await runWithCorrelation('corr-dispatcher-tick', async () => {
      await enqueue.enqueue(JOB.REFUND_REQUESTED, {
        organizationId: ORG,
        refundId: BOOKING,
        correlationId: 'corr-original-request',
      });
    });

    const [job] = await queues[QUEUE.PAYMENT].getJobs(['waiting']);
    expect(job?.data.correlationId).toBe('corr-original-request');
  });

  it('rejects an invalid payload without enqueueing anything', async () => {
    // The cast bypasses the compile-time guard on purpose, to prove the runtime one
    // holds for a payload built somewhere the types were not checked.
    const missingTenant = {
      bookingId: BOOKING,
    } as unknown as JobPayload<typeof JOB.BOOKING_CONFIRMED>;

    await expect(enqueue.enqueue(JOB.BOOKING_CONFIRMED, missingTenant)).rejects.toThrow(
      /organizationId/,
    );

    expect(await queues[QUEUE.BOOKING].getJobCounts('waiting')).toMatchObject({ waiting: 0 });
  });

  it('rejects an undeclared job name without enqueueing anything', async () => {
    await expect(enqueue.enqueue('booking.invented' as JobName, {})).rejects.toThrow(
      /Unknown job name/,
    );

    const counts = await Promise.all(
      Object.values(queues).map((queue) => queue.getJobCounts('waiting')),
    );
    expect(counts.every((count) => count.waiting === 0)).toBe(true);
  });
});

describe('deduplication by job id', () => {
  it('keeps one job when the same jobId is enqueued twice', async () => {
    // This is what makes the outbox at-least-once delivery safe: a redelivered
    // outbox row produces the same jobId, so the work happens once.
    const options = { jobId: jobIdFor('outbox', BOOKING) };

    await enqueue.enqueue(
      JOB.BOOKING_CONFIRMED,
      { organizationId: ORG, bookingId: BOOKING },
      options,
    );
    await enqueue.enqueue(
      JOB.BOOKING_CONFIRMED,
      { organizationId: ORG, bookingId: BOOKING },
      options,
    );

    expect(await queues[QUEUE.BOOKING].getJobs(['waiting'])).toHaveLength(1);
  });

  it('rejects a job id BullMQ would reject, before reaching BullMQ', async () => {
    // Proof the rule this enforces is BullMQ's real rule and not a guess: the
    // first call fails at our boundary, and the second shows what BullMQ does with
    // the same id if the boundary is bypassed.
    await expect(
      enqueue.enqueue(
        JOB.BOOKING_CONFIRMED,
        { organizationId: ORG, bookingId: BOOKING },
        { jobId: 'outbox:1' },
      ),
    ).rejects.toThrow(/must not contain ":"/);

    await expect(
      queues[QUEUE.BOOKING].add(
        JOB.BOOKING_CONFIRMED,
        { organizationId: ORG, bookingId: BOOKING },
        { jobId: 'outbox:1' },
      ),
    ).rejects.toThrow(/Custom Id cannot contain/);

    expect(await queues[QUEUE.BOOKING].getJobCounts('waiting')).toMatchObject({ waiting: 0 });
  });

  it('keeps both jobs when the jobIds differ', async () => {
    await enqueue.enqueue(
      JOB.BOOKING_CONFIRMED,
      { organizationId: ORG, bookingId: BOOKING },
      { jobId: jobIdFor('outbox', 'row1') },
    );
    await enqueue.enqueue(
      JOB.BOOKING_CONFIRMED,
      { organizationId: ORG, bookingId: BOOKING },
      { jobId: jobIdFor('outbox', 'row2') },
    );

    expect(await queues[QUEUE.BOOKING].getJobs(['waiting'])).toHaveLength(2);
  });
});

describe('delayed jobs', () => {
  it('holds a delayed job out of the waiting set', async () => {
    // Reminders and the expiry saga both depend on this, so it is worth pinning
    // rather than assuming.
    await enqueue.enqueue(
      JOB.BOOKING_EXPIRY_REQUESTED,
      { organizationId: ORG, bookingId: BOOKING },
      { delay: 60_000 },
    );

    expect(await queues[QUEUE.BOOKING].getJobCounts('waiting', 'delayed')).toMatchObject({
      waiting: 0,
      delayed: 1,
    });
  });
});

describe('RedisLifecycle', () => {
  it('completes start-up on a client BullMQ has already connected', async () => {
    // The order this reproduces is the one that happens at boot: the queue
    // registry is built first, which makes BullMQ connect the shared client, and
    // only then do lifecycle hooks run. An explicit connect() here throws
    // "Redis is already connecting/connected" and the application never starts.
    await expect(new RedisLifecycle(redis).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('the module lifecycle, through a real Nest container', () => {
  it('connects on init and releases everything on close', async () => {
    // Verified here rather than by reading the log of a booted process: pino may
    // not flush before the process dies, so a missing "connection closed" line
    // proves nothing either way. A container that opens and closes does.
    const moduleRef = await Test.createTestingModule({
      imports: [TestConfigModule, QueuesModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const connection = app.get<Redis>(REDIS);
    expect(connection.status).toBe('ready');

    // A round trip through the container's own queues, not the harness's, so this
    // exercises the wiring QueuesModule produces.
    const enqueueService = app.get(EnqueueService);
    await enqueueService.enqueue(JOB.SWEEP_OUTBOX, {});
    expect(await enqueueService.queue(QUEUE.MAINTENANCE).getJobCounts('waiting')).toMatchObject({
      waiting: 1,
    });

    // Listener registered before close, and awaited after: ioredis flips `status`
    // to 'end' on the socket close event, which lands after `quit()` resolves, so
    // reading the property straight after `close()` races it. If the shutdown hook
    // ever stops running, this waits out the test timeout and names itself.
    const ended = new Promise<void>((resolve) => {
      connection.once('end', resolve);
    });

    await app.close();
    await ended;

    // Anything other than the terminal state means the socket outlived the
    // application, which is what keeps a worker process alive after shutdown.
    expect(connection.status).toBe('end');
  });
});

describe('key namespacing', () => {
  it('writes every key under the configured prefix and nowhere else', async () => {
    // The guarantee the destructive test reset depends on. If BullMQ ever stopped
    // honouring the prefix, `resetQueues` would start reaching real queues.
    await enqueue.enqueue(JOB.BOOKING_CONFIRMED, { organizationId: ORG, bookingId: BOOKING });

    expect((await redis.keys(`${QUEUE_PREFIX}:*`)).length).toBeGreaterThan(0);
    expect(await redis.keys('bull:*')).toEqual([]);
  });

  it('uses a prefix that cannot collide with the application default', () => {
    expect(QUEUE_PREFIX).not.toBe('bull');
    expect(QUEUE_PREFIX).toMatch(/^test-/);
  });
});
