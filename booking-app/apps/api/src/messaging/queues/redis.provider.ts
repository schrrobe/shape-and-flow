import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { ENV } from '../../config/env.schema.js';

import type { AppConfig } from '../../config/env.schema.js';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

export const REDIS = 'REDIS';

/**
 * One shared Redis connection for BullMQ.
 *
 * `maxRetriesPerRequest: null` is not a preference — BullMQ requires it. Its
 * blocking commands sit on a connection for as long as they need to, and ioredis's
 * default retry limit would abort them and make workers appear to stop consuming
 * for no visible reason.
 */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Nothing connects on construction; RedisLifecycle does it at bootstrap, so
    // an unreachable Redis fails start-up rather than the first request that
    // happens to need a queue.
    lazyConnect: true,
  });
}

/**
 * Owns the connection's lifetime, separately from its construction.
 *
 * A separate class for the same reason PrismaLifecycle is one: lifecycle hooks
 * belong on something nothing else wraps or proxies, so they run exactly once.
 */
@Injectable()
export class RedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    // A round trip rather than `connect()`. Two reasons, and the first one is not
    // optional: BullMQ connects the shared client itself as soon as a Queue is
    // constructed, and a second `connect()` throws "Redis is already
    // connecting/connected" — which would make the application fail to boot. A
    // command is safe either way, because a lazy client connects on its first
    // command and an in-flight connection just queues it. Second, PING proves the
    // server actually answers, which is what start-up should be checking.
    await this.redis.ping();
    this.logger.log('Redis connection established');
  }

  async onApplicationShutdown(): Promise<void> {
    // `quit` waits for in-flight commands; `disconnect` would drop them.
    await this.redis.quit();
    this.logger.log('Redis connection closed');
  }
}

export const REDIS_PROVIDERS = [
  {
    provide: REDIS,
    inject: [ENV],
    useFactory: (config: AppConfig): Redis => createRedisConnection(config.REDIS_URL),
  },
  {
    provide: RedisLifecycle,
    inject: [REDIS],
    useFactory: (redis: Redis): RedisLifecycle => new RedisLifecycle(redis),
  },
];
