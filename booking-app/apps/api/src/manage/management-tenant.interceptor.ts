import { Injectable } from '@nestjs/common';
import { firstValueFrom, from } from 'rxjs';

import { runWithOrganization } from '../organization/tenant-context.store.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { requireManagedBooking } from './managed-booking.request.js';

import type { WithManagedBooking } from './managed-booking.request.js';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

/**
 * Opens the tenant scope for every `/manage` route, from the booking's own organization
 * rather than whichever one the process happened to boot with.
 *
 * `/manage/*` is reached from a link in a confirmation email, not from the office or the
 * public site, so `main.ts` mounts neither tenant-resolution middleware on it (see
 * `tenant-context.store.ts`). Without a scope, `OrganizationContextService.get()` — and
 * everything built on it: settings, timezone, the availability snapshot, cancellation and
 * reschedule — silently resolves the bootstrap default organization instead of the
 * booking's own. For every organization but that one, the booking is not found, or is
 * found and answered with someone else's cancellation policy.
 *
 * Seated as an interceptor, not the guard that resolves the token, because a guard
 * cannot be the thing that opens this. `canActivate` returns a boolean and returns —
 * there is no callback of the guard's still running by the time the controller executes,
 * so an `AsyncLocalStorage.run` opened inside it would already be closed. An
 * interceptor's `next.handle()` is the seam Nest itself uses for exactly this: it is
 * invoked eagerly and synchronously (see `@nestjs/core`'s `InterceptorsConsumer`, which
 * binds it with `AsyncResource` for this reason), so calling it from inside
 * `runWithOrganization`'s callback makes the scope cover the handler and everything the
 * handler awaits, the same way the public and office tenant middleware make their scope
 * cover the rest of the Express chain by calling `next()` from inside theirs.
 *
 * Bound through `ManagementToken()` rather than listed on each controller, so a new
 * `/manage` controller inherits this the same way it inherits the guard — by using the
 * one decorator that already marks a route as reachable with a management token. That is
 * what makes the scope cover every `/manage` route, present and future, rather than a
 * list someone has to remember to extend.
 */
@Injectable()
export class ManagementTenantInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & WithManagedBooking>();
    // The guard runs before interceptors, so this is always present here — the same
    // guarantee `ManagedBooking()` relies on.
    const managed = requireManagedBooking(request);

    return from(
      runWithOrganization(managed.organizationId, this.prisma, () => firstValueFrom(next.handle())),
    );
  }
}
