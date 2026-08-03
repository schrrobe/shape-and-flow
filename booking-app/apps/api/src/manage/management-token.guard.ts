import {
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';

import { MANAGEMENT_TOKEN_ROUTE } from './management-token.metadata.js';
import { ManagementTokenService } from './management-token.service.js';

import type { ResolvedToken } from './management-token.service.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export { MANAGEMENT_TOKEN_ROUTE };

/**
 * Marks a route as reachable with a management token, and binds the guard that checks one.
 *
 * Both in one decorator, deliberately. The metadata alone tells the global `AuthGuard` "this
 * route has a way in" — so a route that set the metadata and forgot `@UseGuards` would be
 * open to anyone. Composing them makes that combination unexpressible.
 */
export const ManagementToken = (): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(MANAGEMENT_TOKEN_ROUTE, true), UseGuards(ManagementTokenGuard));

/** Where the guard leaves what it resolved. */
export const MANAGED_BOOKING = 'managedBooking';

interface WithManagedBooking {
  [MANAGED_BOOKING]?: ResolvedToken;
}

/**
 * The booking the presented token identified.
 *
 * A handler asks for this rather than for an id from the path, which is what makes
 * "customers can only see their own booking" structural: there is no id to tamper with.
 */
export const ManagedBooking = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedToken => {
    const request = context.switchToHttp().getRequest<Request & WithManagedBooking>();
    const managed = request[MANAGED_BOOKING];

    if (managed === undefined) {
      // Only reachable if a route used this decorator without the guard, which is a
      // wiring mistake rather than a client error.
      throw new AppError('INTERNAL_ERROR', {
        message: 'ManagedBooking used on a route without ManagementTokenGuard.',
      });
    }

    return managed;
  },
);

/**
 * Turns a bearer token into the one booking it grants access to.
 *
 * Reads the header itself rather than accepting the token as a parameter, so no handler
 * ever sees the plaintext — a token that never reaches a controller cannot be logged by
 * one, echoed into a response, or passed somewhere it does not belong.
 */
@Injectable()
export class ManagementTokenGuard implements CanActivate {
  constructor(private readonly tokens: ManagementTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & WithManagedBooking>();

    const token = bearerToken(request);
    if (token === null) {
      throw new AppError('UNAUTHENTICATED', {
        message: 'This management link is not valid. It may have expired or been replaced.',
      });
    }

    // `resolve` throws the same error for every failure mode, so this adds no
    // distinguishing branch of its own.
    request[MANAGED_BOOKING] = await this.tokens.resolve(token);

    return true;
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (header === undefined) return null;

  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.length === 0) return null;

  return value;
}
