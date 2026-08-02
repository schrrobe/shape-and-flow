import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OFFICE_ROUTE } from '../../auth/office-session.guard.js';
import { MANAGEMENT_TOKEN_ROUTE } from '../../manage/management-token.guard.js';
import { AppError } from '../errors/app-error.js';

import { IS_PUBLIC } from './public.decorator.js';

import type { CanActivate, ExecutionContext } from '@nestjs/common';

/**
 * Denies every route that has not said it is open.
 *
 * Bound globally, so the question "is this endpoint protected?" has one answer for
 * the whole application instead of one per controller. Two things open a route:
 * `@Public()`, `@ManagementToken()`, and `@OfficeRoute()` — whose own guards do the
 * actual work of resolving the credential.
 *
 * Everything else is denied. A controller written without thinking about auth fails
 * loudly on its first request instead of quietly serving the public.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Class-level too, so a controller can open all of its routes at once — which is
    // what the public controllers do.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) return true;

    // Delegated rather than decided: ManagementTokenGuard runs after this one and
    // rejects a token it cannot resolve. This branch only says the route has a way in.
    const managementToken = this.reflector.getAllAndOverride<boolean | undefined>(
      MANAGEMENT_TOKEN_ROUTE,
      [context.getHandler(), context.getClass()],
    );

    if (managementToken === true) return true;

    // The third branch, delegated the same way: OfficeSessionGuard resolves the cookie
    // and refuses a session it cannot load. This only says the route has a way in.
    const officeSession = this.reflector.getAllAndOverride<boolean | undefined>(OFFICE_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (officeSession === true) return true;

    throw new AppError('UNAUTHENTICATED', {
      message: 'Authentication is required for this endpoint.',
    });
  }
}
