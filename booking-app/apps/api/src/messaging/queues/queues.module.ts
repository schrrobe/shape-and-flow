import { Global, Inject, Logger, Module } from '@nestjs/common';
import { Queue } from 'bullmq';

import { ENV } from '../../config/env.schema.js';

import { EnqueueService, QUEUE_REGISTRY } from './enqueue.service.js';
import { QUEUES } from './job-contracts.js';
import { REDIS, REDIS_PROVIDERS } from './redis.provider.js';

import type { QueueRegistry } from './enqueue.service.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Default job options, applied to every queue.
 *
 * Eight attempts with exponential backoff spans roughly twenty minutes, which
 * covers a provider blip without hammering it. Completed jobs are kept for a day
 * so a support question about "did the email go out" is answerable; failed jobs
 * are kept for a week, because those are the ones someone needs to read.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: { age: 604_800, count: 20_000 },
};

/**
 * One Queue per declared queue name, all sharing the injected connection.
 *
 * Exported so the integration suite and the worker build their queues exactly
 * the way the API does — a test that constructs queues differently from
 * production proves less than it appears to.
 */
export function buildQueueRegistry(redis: Redis, prefix: string): QueueRegistry {
  const entries = QUEUES.map((name) => [
    name,
    new Queue(name, { connection: redis, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
  ]);

  return Object.fromEntries(entries) as QueueRegistry;
}

@Global()
@Module({
  providers: [
    ...REDIS_PROVIDERS,
    {
      provide: QUEUE_REGISTRY,
      inject: [REDIS, ENV],
      useFactory: (redis: Redis, config: AppConfig): QueueRegistry =>
        buildQueueRegistry(redis, config.REDIS_QUEUE_PREFIX),
    },
    EnqueueService,
  ],
  exports: [EnqueueService, QUEUE_REGISTRY, REDIS],
})
export class QueuesModule implements OnApplicationShutdown {
  private readonly logger = new Logger('Queues');

  constructor(@Inject(QUEUE_REGISTRY) private readonly queues: QueueRegistry) {}

  async onApplicationShutdown(): Promise<void> {
    // Queues share the injected connection and do not own it, so closing them
    // releases their own resources while RedisLifecycle quits the connection.
    // Failures here are logged rather than thrown: a shutdown that cannot finish
    // is worse than one that leaves a socket for the process exit to reclaim.
    await Promise.all(
      Object.values(this.queues).map(async (queue) => {
        try {
          await queue.close();
        } catch (error) {
          this.logger.warn(
            `Failed to close queue ${queue.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }
}
