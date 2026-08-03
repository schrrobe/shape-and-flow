import { Global, Module } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { TENANT_PRISMA, createTenantGuardedClient } from '../prisma/tenant.extension.js';

import { OrganizationContextService } from './organization-context.service.js';

import type { TenantPrismaClient } from '../prisma/tenant.extension.js';

/**
 * Tenancy: the resolved organization, and the tenant-guarded Prisma client.
 *
 * The guarded client is provided here rather than by PrismaModule on purpose.
 * It needs both PrismaService and OrganizationContextService, and the latter
 * needs PrismaService — so providing it from PrismaModule would make the two
 * modules mutually dependent. Tenancy is the right owner of a tenant guard
 * anyway.
 *
 * Services should inject TENANT_PRISMA. Injecting the raw PrismaService is
 * still possible and is visible in a constructor, which is the point: a
 * deliberately global query has to be declared, not slipped in.
 */
@Global()
@Module({
  providers: [
    OrganizationContextService,
    {
      provide: TENANT_PRISMA,
      inject: [PrismaService, OrganizationContextService],
      useFactory: (
        prisma: PrismaService,
        organizations: OrganizationContextService,
      ): TenantPrismaClient =>
        // Resolved lazily per query, so this factory does not depend on
        // bootstrap ordering.
        createTenantGuardedClient(prisma, () => organizations.getOrganizationId()),
    },
  ],
  exports: [OrganizationContextService, TENANT_PRISMA],
})
export class OrganizationModule {}
