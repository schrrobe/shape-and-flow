import { Inject, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';

import { CURRENT_USER, SessionStore } from './session.store.js';

import type { OfficeSession } from './session.store.js';
import type { AppConfig } from '../config/env.schema.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Marks a route as reachable with an office session. Read by the global AuthGuard. */
export const OFFICE_ROUTE = 'auth:office-session';

export const OfficeRoute = (): MethodDecorator & ClassDecorator => SetMetadata(OFFICE_ROUTE, true);

interface WithSession {
  [CURRENT_USER]?: OfficeSession;
}

/**
 * The session behind the request.
 *
 * Handlers take this instead of reading a user id out of a body or a query parameter,
 * which is what makes "an office user acts as themselves, in their own organization"
 * structural rather than something each handler has to remember.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OfficeSession => {
    const request = context.switchToHttp().getRequest<Request & WithSession>();
    const session = request[CURRENT_USER];

    if (session === undefined) {
      // Only reachable if a route used this decorator without the guard, which is a
      // wiring mistake rather than a client error.
      throw new AppError('INTERNAL_ERROR', {
        message: 'CurrentUser used on a route without OfficeSessionGuard.',
      });
    }

    return session;
  },
);

/**
 * Turns the session cookie into the user it belongs to.
 *
 * Reads the cookie itself rather than accepting a session id as a parameter, for the
 * same reason ManagementTokenGuard reads its own header: a credential that never
 * reaches a controller cannot be logged, echoed, or passed somewhere it does not
 * belong.
 */
@Injectable()
export class OfficeSessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionStore,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & WithSession>();

    const sid = readCookie(request, this.config.SESSION_COOKIE_NAME);
    if (sid === null) throw unauthenticated();

    const session = await this.sessions.read(sid);
    if (session === null) throw unauthenticated();

    request[CURRENT_USER] = session;

    return true;
  }
}

/** One error, one message, for every way a session can be unusable. */
function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', { message: 'Not signed in.' });
}

/**
 * Read one cookie off the request.
 *
 * Deliberately not `cookie-parser`. Exactly one cookie is read, in exactly two places,
 * and a global parser would make both of them depend silently on a middleware being
 * mounted: forget it and every office request answers 401 with nothing in the logs
 * pointing at the cause. Its `req.cookies` is also typed `any`, which this codebase
 * cannot use without disabling the type-aware rules that make guards safe to change.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (header === undefined) return null;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;

    if (pair.slice(0, separator).trim() !== name) continue;

    const value = pair.slice(separator + 1).trim();
    if (value.length === 0) return null;

    try {
      return decodeURIComponent(value);
    } catch {
      // A malformed percent-escape is not a session id.
      return null;
    }
  }

  return null;
}
