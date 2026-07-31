import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

/** The HTTP application. Queue processors live in WorkerModule instead. */
@Module({
  imports: [ConfigModule, PrismaModule, HealthModule],
})
export class AppModule {}
