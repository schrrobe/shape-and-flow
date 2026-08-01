import { Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../common/errors/app-error.js';

import { CURRENT_USER } from './session.store.js';

import type { OfficeSession } from './session.store.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Metadata key the refund guard reads. */
export const REQUIRES_REFUND_CAPABILITY = 'auth:refund-capability';

/**
 * This route moves money back to a customer.
 *
 * A capability rather than a fourth role, because "an admin who may not issue refunds"
 * is a real thing a business asks for, and expressing it as a role would double the
 * matrix. OWNER holds it implicitly — an owner who could be locked out of their own
 * refunds by a flag would be a support call, not a security control.
 */
export const RequiresRefundCapability = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_REFUND_CAPABILITY, true);

@Injectable()
export class RefundCapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRES_REFUND_CAPABILITY,
      [context.getHandler(), context.getClass()],
    );

    // Absent means the route does not move money; RolesGuard has already had its say.
    if (required !== true) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { [CURRENT_USER]?: OfficeSession }>();
    const session = request[CURRENT_USER];

    if (session === undefined) {
      throw new AppError('INTERNAL_ERROR', {
        message: 'RefundCapabilityGuard ran before OfficeSessionGuard.',
      });
    }

    if (session.role === 'OWNER' || session.canIssueRefunds) return true;

    throw new AppError('FORBIDDEN_ROLE', {
      message: 'Your account may not perform this action.',
    });
  }
}
