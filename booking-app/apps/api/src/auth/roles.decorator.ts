import { SetMetadata } from '@nestjs/common';

import type { OfficeUserRole } from '../prisma/client.js';

/** Metadata key the roles guard reads. */
export const ROLES = 'auth:roles';

/**
 * Which roles may reach this route.
 *
 * Declared at the route rather than derived from the path, because the authorization
 * matrix in §10.5 is not a function of the URL: `/office/bookings/:id/complete` is open
 * to all three roles while `/office/bookings/:id/cancel` beside it is not. Writing it
 * where the handler is means a reviewer reading the handler can see who may call it.
 *
 * A route that this guard protects and that declares nothing is denied to everybody —
 * see RolesGuard. Forgetting therefore produces a 403 on the first request rather than
 * an endpoint anybody can reach.
 */
export const Roles = (...roles: OfficeUserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles);
