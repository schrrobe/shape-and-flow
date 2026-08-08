import { Inject, Injectable } from '@nestjs/common';

import { readCookie } from '../auth/office-session.guard.js';
import { SessionStore } from '../auth/session.store.js';
import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { runWithTenant } from './tenant-context.store.js';

import type { AppConfig } from '../config/env.schema.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * Resolves the tenant for office traffic from the session, never from the
 * query string: a query parameter must never be able to redirect an
 * authenticated request into a different organization's data.
 *
 * Absent a session cookie, or a cookie that does not resolve to a live session,
 * this falls through to the bootstrap default — that is the intentional
 * not-logged-in case. But a session that DOES resolve and names an organization
 * that no longer resolves is different: an identity was offered and it is
 * invalid, so this rejects rather than silently serving a different
 * organization's data under someone else's session.
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
      // A session exists but its organization no longer resolves — never silently serve
      // a different organization's data for an authenticated request.
      throw new AppError('ORGANIZATION_NOT_FOUND', {
        message: 'The organization for this session no longer exists.',
      });
    }

    runWithTenant({ ...organization, settings: organization.settings }, () => {
      next();
    });
  };
}
