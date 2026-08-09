import {
  Injectable,
  SetMetadata,
  UseGuards,
  UseInterceptors,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';

import { MANAGED_BOOKING, requireManagedBooking } from './managed-booking.request.js';
import { ManagementTenantInterceptor } from './management-tenant.interceptor.js';
import { MANAGEMENT_TOKEN_ROUTE } from './management-token.metadata.js';
import { ManagementTokenService } from './management-token.service.js';

import type { WithManagedBooking } from './managed-booking.request.js';
import type { ResolvedToken } from './management-token.service.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Marks a route as reachable with a management token, and binds the guard that checks
 * one and the interceptor that opens the tenant scope for it.
 *
 * All three in one decorator, deliberately. The metadata alone tells the global `AuthGuard`
 * "this route has a way in" — so a route that set the metadata and forgot `@UseGuards`
 * would be open to anyone. Composing them makes that combination unexpressible. The
 * interceptor rides along for the same reason: a `/manage` route that forgot to open the
 * tenant scope would silently serve the bootstrap default organization's data, which is
 * exactly the bug this exists to close — see `ManagementTenantInterceptor` for why it has
 * to be an interceptor and not more guard logic.
 */
export const ManagementToken = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(MANAGEMENT_TOKEN_ROUTE, true),
    UseGuards(ManagementTokenGuard),
    UseInterceptors(ManagementTenantInterceptor),
  );

/**
 * The booking the presented token identified.
 *
 * A handler asks for this rather than for an id from the path, which is what makes
 * "customers can only see their own booking" structural: there is no id to tamper with.
 */
export const ManagedBooking = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedToken => {
    const request = context.switchToHttp().getRequest<Request & WithManagedBooking>();
    return requireManagedBooking(request);
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
