import { Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { runWithTenant } from './tenant-context.store.js';

import type { NextFunction, Request, Response } from 'express';

/**
 * Resolves the tenant for public traffic from `?organizer=<slug>`.
 *
 * Absent the query parameter, this falls through to the bootstrap default —
 * `OrganizationContextService.get()` returns its process-local snapshot when no
 * ALS scope is set, so this middleware simply does nothing in that case rather
 * than rejecting the request. But when the parameter IS present and does not
 * resolve, that is a different situation entirely: an explicit, wrong identity
 * was offered, and falling through would silently serve some other
 * organization's data under a slug that does not belong to it.
 *
 * "Present" means the key is in the query string, whatever its value. A present
 * parameter that is not a single non-empty slug is malformed rather than absent,
 * and is rejected on the same reasoning.
 */
@Injectable()
export class TenantResolutionMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  middleware = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    // Absence of the key, not falsiness of the value. `?organizer=` yields an empty
    // string and `?organizer=a&organizer=b` yields an array; treating either as "no
    // organizer was supplied" is how a malformed or tampered link reads and writes under
    // the bootstrap tenant instead of failing. Only a URL with no `organizer` at all is
    // the root-domain case this falls through for.
    if (!Object.hasOwn(request.query, 'organizer')) {
      next();
      return;
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
      throw new AppError('ORGANIZATION_NOT_FOUND', { message: 'No organizer matches that address.' });
    }

    runWithTenant({ ...organization, settings: organization.settings }, () => {
      next();
    });
  };
}
