import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { currentTenant } from './tenant-context.store.js';

import type { AppConfig } from '../config/env.schema.js';
import type { Organization, OrganizationSettings } from '../prisma/client.js';
import type { OnApplicationBootstrap } from '@nestjs/common';

export type OrganizationWithSettings = Organization & { settings: OrganizationSettings };

/**
 * Resolves the organization server-side, once, at bootstrap.
 *
 * This is the only place a tenant is decided for a public request. The
 * organization id is never read from a request body, query parameter, header or
 * path segment — see §10.1 of the implementation plan. The future host-based or
 * slug-based resolver replaces exactly this provider and nothing else, which is
 * what keeps the multi-tenant migration additive.
 */
@Injectable()
export class OrganizationContextService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrganizationContextService.name);
  private organization: OrganizationWithSettings | null = null;

  constructor(
    @Inject(ENV) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
  }

  /**
   * Reload this process after a settings change. Phase 1 runs one API process;
   * before horizontal scaling, settings writes must publish cross-process
   * invalidation (or this cache must gain a short TTL).
   */
  async refresh(): Promise<void> {
    const slug = this.config.DEFAULT_ORGANIZATION_SLUG;

    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      include: { settings: true },
    });

    if (!organization) {
      throw new Error(
        `Organization with slug "${slug}" not found. ` +
          'Run `pnpm db:seed`, or correct DEFAULT_ORGANIZATION_SLUG.',
      );
    }

    if (!organization.settings) {
      throw new Error(
        `Organization "${slug}" has no settings row. The seed creates one; ` +
          'a missing row means the database was modified out of band.',
      );
    }

    this.organization = { ...organization, settings: organization.settings };
    this.logger.log(`Organization context: ${organization.name} (${slug})`);
  }

  /**
   * Called on every request path and inside the tenant guard, so it must never
   * be reached before bootstrap completed.
   */
  getOrganizationId(): string {
    return this.get().id;
  }

  get(): OrganizationWithSettings {
    const scoped = currentTenant();
    if (scoped) return scoped;

    if (!this.organization) {
      throw new Error(
        'Organization context read before bootstrap completed. ' +
          'Inject OrganizationContextService rather than calling it at module construction time.',
      );
    }
    return this.organization;
  }

  /**
   * The organization a background job says it is working on.
   *
   * A worker has no request to resolve a tenant from, so it would otherwise fall back to
   * whichever organization bootstrap happened to load. Today that is always the right
   * one; the day it is not, a refund would be issued from the wrong Stripe account. So
   * the job's own `organizationId` is checked against the resolved context rather than
   * ignored, and a mismatch is a loud failure instead of a silent cross-tenant write.
   */
  require(organizationId: string): OrganizationWithSettings {
    const organization = this.get();

    if (organization.id !== organizationId) {
      throw new AppError('UNSCOPED_TENANT_QUERY', {
        status: 500,
        message:
          `A job for organization ${organizationId} ran with ${organization.id} in context. ` +
          'Resolve the organization from the job payload before calling tenant-scoped code.',
        details: { expected: organizationId, resolved: organization.id },
      });
    }

    return organization;
  }

  getSettings(): OrganizationSettings {
    return this.get().settings;
  }

  getTimezone(): string {
    return this.get().timezone;
  }
}
