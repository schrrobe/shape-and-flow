import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import { runWithTenant } from './tenant-context.store.js';

import type { NextFunction, Request, Response } from 'express';

/**
 * Resolves the tenant for public traffic from `?organizer=<slug>`.
 *
 * Absent the query parameter, or when it does not resolve, this falls through
 * to the bootstrap default — `OrganizationContextService.get()` returns its
 * process-local snapshot when no ALS scope is set, so this middleware simply
 * does nothing in that case rather than rejecting the request.
 */
@Injectable()
export class TenantResolutionMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  middleware = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    const slug = request.query.organizer;

    if (typeof slug !== 'string' || slug.length === 0) {
      next();
      return;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      include: { settings: true },
    });

    if (!organization?.settings) {
      next();
      return;
    }

    runWithTenant({ ...organization, settings: organization.settings }, () => {
      next();
    });
  };
}
