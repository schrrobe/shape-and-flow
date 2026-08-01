import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

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

  /** Reload after settings change, so cached policy cannot go stale. */
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
    if (!this.organization) {
      throw new Error(
        'Organization context read before bootstrap completed. ' +
          'Inject OrganizationContextService rather than calling it at module construction time.',
      );
    }
    return this.organization;
  }

  getSettings(): OrganizationSettings {
    return this.get().settings;
  }

  getTimezone(): string {
    return this.get().timezone;
  }
}
