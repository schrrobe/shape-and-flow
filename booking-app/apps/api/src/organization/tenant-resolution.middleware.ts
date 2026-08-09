import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { hostnameFromRequest, isCentralHost } from './hostname.js';
import { runWithTenant } from './tenant-context.store.js';

import type { OrganizationWithSettings } from './organization-context.service.js';
import type { AppConfig } from '../config/env.schema.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * Resolves the tenant for public traffic, hostname first and query string second.
 *
 * 1. The hostname the request arrived on, looked up in `organization_domains`. This is
 *    the identity an organizer running the booking flow under its own address offers,
 *    and it wins outright: a `?organizer=` on a resolved domain is not consulted at
 *    all. Ignoring it rather than rejecting it is the friendlier of the two options the
 *    contradiction allows — a stale link a customer kept from the central address still
 *    books with the organizer whose site they are actually on, which is what both
 *    parties want, and it cannot book with anybody else.
 *
 * 2. Failing that, `?organizer=<slug>` — but only on a central host, meaning one of the
 *    origins this deployment declares (plus loopback outside production). A hostname
 *    nobody registered, arriving with a slug, is not our front door offering a choice of
 *    organizer; it is an address we have no relationship with asking to be served as
 *    one. Honouring it would make every unclaimed hostname pointed at this server a
 *    working front end for any tenant.
 *
 * 3. Failing both, nothing: `next()` runs outside any scope and
 *    `OrganizationContextService.get()` answers from its bootstrap snapshot. That is
 *    the single-organizer deployment and the central address's own landing page, and
 *    neither offered an identity to get wrong.
 *
 * "Present" for the query parameter means the key is in the query string, whatever its
 * value. A present parameter that is not a single non-empty slug is malformed rather
 * than absent, and is rejected on the same reasoning as an unresolvable one: an
 * explicit, wrong identity was offered, and falling through would silently serve some
 * other organization's data under a slug that does not belong to it.
 */
@Injectable()
export class TenantResolutionMiddleware {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  middleware = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    const hostname = hostnameFromRequest(request);
    const central = isCentralHost(hostname, this.config);

    // The central address is never an organizer domain — `OrganizationDomainService`
    // refuses to register one — so on the central host there is nothing to look up.
    // Skipping the query keeps the single-organizer deployment, which is every
    // deployment until somebody registers a domain, at exactly the database work it did
    // before. It also makes the invariant structural: a central hostname inserted into
    // `organization_domains` out of band still cannot take over the central address.
    if (!central && hostname !== null) {
      const byDomain = await this.resolveByHostname(hostname);

      if (byDomain !== null) {
        runWithTenant(byDomain, () => {
          next();
        });
        return;
      }
    }

    // Absence of the key, not falsiness of the value. `?organizer=` yields an empty
    // string and `?organizer=a&organizer=b` yields an array; treating either as "no
    // organizer was supplied" is how a malformed or tampered link reads and writes under
    // the bootstrap tenant instead of failing. Only a URL with no `organizer` at all is
    // the root-domain case this falls through for.
    if (!Object.hasOwn(request.query, 'organizer')) {
      next();
      return;
    }

    if (!central) {
      // Same 404 as an unresolvable slug, deliberately: whoever is pointing this
      // hostname at us learns only that it names no organizer, not whether the slug
      // they guessed exists.
      throw new AppError('ORGANIZATION_NOT_FOUND', {
        message: 'No organizer matches that address.',
      });
    }

    const slug = request.query.organizer;

    if (typeof slug !== 'string' || slug.length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'The organizer parameter must be a single non-empty slug.',
      });
    }

    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      include: { settings: true },
    });

    if (!organization?.settings) {
      // An identity WAS offered and it does not resolve — never silently serve a
      // different organization's data for an explicit, wrong slug.
      throw new AppError('ORGANIZATION_NOT_FOUND', {
        message: 'No organizer matches that address.',
      });
    }

    runWithTenant({ ...organization, settings: organization.settings }, () => {
      next();
    });
  };

  /**
   * The organization this hostname is registered to, or null if none is.
   *
   * An unregistered hostname is not an error here — the central address is itself
   * unregistered, and so is every host in a single-organizer deployment. Only the
   * caller knows whether falling through is acceptable.
   */
  private async resolveByHostname(hostname: string): Promise<OrganizationWithSettings | null> {
    const domain = await this.prisma.organizationDomain.findUnique({
      where: { hostname },
      select: { organization: { include: { settings: true } } },
    });

    if (domain === null) return null;

    const { organization } = domain;

    // A registered domain whose organization has no settings row is a database
    // modified out of band, not a routing decision. Returning null would serve the
    // bootstrap tenant's catalogue under somebody else's domain, so this fails instead.
    if (!organization.settings) {
      throw new AppError('ORGANIZATION_NOT_FOUND', {
        message: 'No organizer matches that address.',
      });
    }

    return { ...organization, settings: organization.settings };
  }
}
