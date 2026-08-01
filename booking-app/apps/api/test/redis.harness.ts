import { buildQueueRegistry } from '../src/messaging/queues/queues.module.js';
import { createRedisConnection } from '../src/messaging/queues/redis.provider.js';

import type { QueueRegistry } from '../src/messaging/queues/enqueue.service.js';
import type { Redis } from 'ioredis';

/**
 * Redis connection and BullMQ queues for the integration suite.
 *
 * The reset below is destructive, so the prefix guard is not a formality: with a
 * dedicated prefix, a reset cannot reach the queues a running application uses
 * even if REDIS_URL is pointed at the development instance by mistake.
 */
const prefix = process.env.REDIS_QUEUE_PREFIX;

if (prefix?.startsWith('test-') !== true) {
  throw new Error(
    `Integration tests refuse to obliterate queues under prefix "${prefix ?? '(unset)'}". ` +
      'Set REDIS_QUEUE_PREFIX to a value starting with "test-" in vitest.integration.config.ts.',
  );
}

export const QUEUE_PREFIX = prefix;

export const redis: Redis = createRedisConnection(
  process.env.REDIS_URL ?? 'redis://localhost:6381',
);

/**
 * Queues built exactly the way QueuesModule builds them.
 *
 * Constructing them differently from production would leave the difference
 * untested, which is the opposite of what an integration test is for.
 */
export const queues: QueueRegistry = buildQueueRegistry(redis, QUEUE_PREFIX);

/**
 * Wait for the connection, the way RedisLifecycle does.
 *
 * Not `connect()`: BullMQ has already started connecting the shared client by the
 * time `buildQueueRegistry` returns, and a second `connect()` throws.
 */
export async function connectRedis(): Promise<void> {
  await redis.ping();
}

/**
 * Remove every job, in every state, from every queue.
 *
 * `obliterate` is BullMQ's own reset and touches only keys under this prefix —
 * unlike FLUSHDB, which would take anything else sharing the instance with it.
 */
export async function resetQueues(): Promise<void> {
  await connectRedis();
  await Promise.all(Object.values(queues).map((queue) => queue.obliterate({ force: true })));
}

export async function disconnectRedis(): Promise<void> {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  // `quit` rather than `disconnect`: the former drains in-flight commands, and a
  // half-written obliterate would leave the next run's state unexplained.
  if (redis.status !== 'end') await redis.quit();
}
