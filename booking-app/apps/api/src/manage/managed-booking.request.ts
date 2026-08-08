import { AppError } from '../common/errors/app-error.js';

import type { ResolvedToken } from './management-token.service.js';
import type { Request } from 'express';

/**
 * Where `ManagementTokenGuard` leaves what it resolved, for anything downstream that
 * needs it.
 *
 * Split out from `management-token.guard.ts` so the guard, the `ManagedBooking()` param
 * decorator and `ManagementTenantInterceptor` can each read it without the guard and the
 * interceptor importing one another.
 */
export const MANAGED_BOOKING = 'managedBooking';

export interface WithManagedBooking {
  [MANAGED_BOOKING]?: ResolvedToken;
}

/**
 * The resolved token, or a loud failure if this is read on a route the guard never ran
 * on.
 *
 * Shared between the `ManagedBooking()` param decorator and `ManagementTenantInterceptor`
 * so "used without the guard" has one message and one code path instead of two.
 */
export function requireManagedBooking(request: Request & WithManagedBooking): ResolvedToken {
  const managed = request[MANAGED_BOOKING];

  if (managed === undefined) {
    // Only reachable if a route used the token decorator or the tenant interceptor
    // without the guard, which is a wiring mistake rather than a client error.
    throw new AppError('INTERNAL_ERROR', {
      message: 'Management token metadata read on a route without ManagementTokenGuard.',
    });
  }

  return managed;
}
