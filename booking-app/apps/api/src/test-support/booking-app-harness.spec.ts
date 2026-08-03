import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../test/database.harness.js', () => ({ prisma: {} }));
vi.mock('../../test/public-app.harness.js', () => ({
  countingPrisma: {},
  loadOrganization: vi.fn(),
}));

import { BookingTestHarnessModule } from '../../test/booking-app.harness.js';
import { REDIS } from '../messaging/queues/redis.provider.js';

import type { Redis } from 'ioredis';

@Injectable()
class NeedsRedis {
  constructor(@Inject(REDIS) readonly redis: Redis) {}
}

@Module({ imports: [BookingTestHarnessModule], providers: [NeedsRedis] })
// A Nest module is a declaration carrier with an empty body by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class NeedsRedisModule {}

describe('BookingTestHarnessModule', () => {
  it('fails at injection when a suite forgets its Redis connection', async () => {
    await expect(
      Test.createTestingModule({ imports: [NeedsRedisModule] }).compile(),
    ).rejects.toThrow(/pass .*redis.*redis\.harness\.ts/i);
  });
});
