import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { REDIS } from '../../messaging/queues/redis.provider.js';

import type { Redis } from 'ioredis';

/**
 * The default limit, which every route inherits unless it says otherwise.
 *
 * Generous on purpose: it is a backstop against a runaway client, not the real
 * policy. The routes that need a real limit declare it with `@Throttle`, and the
 * ones that must not be limited at all — webhooks, whose gate is signature
 * verification — use `@SkipThrottle`.
 */
export const DEFAULT_THROTTLE = { ttl: 60_000, limit: 300 };

/**
 * Rate limiting, counted in Redis rather than in memory.
 *
 * In-memory counting would mean the limit multiplies by the number of instances,
 * which makes it not a limit. The store is the connection BullMQ already uses: one
 * fewer socket, and one fewer thing to configure. Its `disconnectRequired` flag is
 * only set when it opens its own connection, so its `onModuleDestroy` will not close
 * a connection it was handed.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({
        throttlers: [DEFAULT_THROTTLE],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
  ],
  exports: [ThrottlerModule],
})
export class ThrottlingModule {}
