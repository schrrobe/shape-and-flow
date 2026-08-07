import { Inject, Injectable } from '@nestjs/common';

import { readCookie } from '../auth/office-session.guard.js';
import { SessionStore } from '../auth/session.store.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { runWithTenant } from './tenant-context.store.js';

import type { AppConfig } from '../config/env.schema.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * Resolves the tenant for office traffic from the session, never from the
 * query string: a query parameter must never be able to redirect an
 * authenticated request into a different organization's data.
 */
@Injectable()
export class OfficeTenantMiddleware {
  constructor(
    private readonly sessions: SessionStore,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  middleware = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    const sid = readCookie(request, this.config.SESSION_COOKIE_NAME);
    if (sid === null) {
      next();
      return;
    }

    const session = await this.sessions.read(sid);
    if (session === null) {
      next();
      return;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: session.organizationId },
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
