import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../errors/app-error.js';

import { IS_PUBLIC } from './public.decorator.js';

import type { CanActivate, ExecutionContext } from '@nestjs/common';

/**
 * Denies every route that has not said it is open.
 *
 * Bound globally, so the question "is this endpoint protected?" has one answer for
 * the whole application instead of one per controller. Only `@Public()` opens a
 * route today; office sessions arrive in Task 6.2 and management tokens in 6.4, and
 * each adds a branch here rather than a second guard somewhere else.
 *
 * Until then this is not a placeholder — it is already load-bearing. Every
 * controller written between now and then is closed by default, and the first
 * request to an endpoint whose author forgot to think about auth fails loudly.
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

    throw new AppError('UNAUTHENTICATED', {
      message: 'Authentication is required for this endpoint.',
    });
  }
}
