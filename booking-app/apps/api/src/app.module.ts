import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module.js';
import { DomainModule } from './domain/domain.module.js';
import { HealthModule } from './health/health.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

/** The HTTP application. Queue processors live in WorkerModule instead. */
@Module({
  imports: [ConfigModule, PrismaModule, DomainModule, OrganizationModule, HealthModule],
})
export class AppModule {}
