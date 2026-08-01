import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';

import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

/**
 * Owns the database connection's lifetime.
 *
 * This exists as a separate provider rather than as hooks on PrismaService
 * because `$extends` proxies unknown properties through to the base client: a
 * lifecycle hook on PrismaService would also be visible on the tenant-guarded
 * client, and Nest would invoke it once per provider — opening and logging two
 * connection pools. Nothing proxies this class, so its hooks run exactly once.
 *
 * Connecting eagerly is deliberate. Prisma would otherwise connect on first
 * query, which turns an unreachable database into a failed customer request
 * instead of a failed start-up.
 */
@Injectable()
export class PrismaLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Prisma');

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.$connect();
    this.logger.log('Database connection established');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
    this.logger.log('Database connection closed');
  }
}
