import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

import { REDIS } from '../messaging/queues/redis.provider.js';

import type { HealthIndicatorResult } from '@nestjs/terminus';
import type { Redis } from 'ioredis';

/**
 * How long a `PING` may take before Redis counts as unreachable.
 *
 * The same two seconds the database check allows. A readiness probe that waits
 * longer than the interval it is polled at stops being a probe and becomes a queue.
 */
const REDIS_PING_TIMEOUT_MS = 2_000;

/**
 * Redis, through the connection the queues actually use.
 *
 * Deliberately the injected client rather than a connection of its own: what
 * readiness has to answer is "can this process reach the Redis it enqueues to",
 * and a second connection could be healthy while the shared one is wedged.
 *
 * A round trip rather than a status flag, for the reason RedisLifecycle pings at
 * start-up: ioredis reports `ready` from its own state machine, and a server that
 * has stopped answering can still leave a socket that looks connected.
 */
@Injectable()
export class QueueHealthIndicator {
  private readonly logger = new Logger('QueueHealthIndicator');

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly health: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'redis'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);

    try {
      await this.pingWithin(REDIS_PING_TIMEOUT_MS);
      return indicator.up();
    } catch (error) {
      this.logger.error(
        `redis did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
      return indicator.down({ message: 'Redis did not answer a ping.' });
    }
  }

  /**
   * A ping, or a rejection.
   *
   * The timer is cleared on both paths and unreferenced regardless: a pending
   * `setTimeout` would keep the event loop alive, which turns a clean shutdown into
   * a process that hangs for two seconds after every probe.
   */
  private async pingWithin(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`no response within ${String(timeoutMs)}ms`));
      }, timeoutMs);
      timer.unref();
    });

    try {
      await Promise.race([this.redis.ping(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
