import { Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../common/errors/app-error.js';

import { ROLES } from './roles.decorator.js';
import { CURRENT_USER } from './session.store.js';

import type { OfficeSession } from './session.store.js';
import type { OfficeUserRole } from '../prisma/client.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

interface WithSession {
  [CURRENT_USER]?: OfficeSession;
}

/**
 * The role half of §10.5.
 *
 * Only the half: the "own only" rows of that matrix — an employee acting on their own
 * calendar — cannot be expressed by a decorator, because they depend on which row is
 * being touched. EmployeeScopeService is the other half, and it answers 404 rather than
 * 403 so that a scoped-out user cannot use the error code to learn that an id exists.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger('Roles');

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<OfficeUserRole[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (allowed === undefined || allowed.length === 0) {
      // A route guarded by this class but declaring no roles is a wiring mistake. It is
      // denied rather than allowed, and logged loudly, because the alternative — opening
      // it to everybody — is the failure nobody notices.
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} is guarded by RolesGuard but declares no @Roles`,
      );
      throw forbidden();
    }

    const request = context.switchToHttp().getRequest<Request & WithSession>();
    const session = request[CURRENT_USER];

    if (session === undefined) {
      // OfficeSessionGuard runs first and would have thrown. Reaching here means the
      // guards were declared in the wrong order.
      throw new AppError('INTERNAL_ERROR', {
        message: 'RolesGuard ran before OfficeSessionGuard.',
      });
    }

    if (!allowed.includes(session.role)) throw forbidden();

    return true;
  }
}

/**
 * One message for every insufficient role.
 *
 * It names no role and no requirement: telling a caller which role would have worked
 * describes the permission model to somebody who has just been refused by it.
 */
function forbidden(): AppError {
  return new AppError('FORBIDDEN_ROLE', {
    message: 'Your account may not perform this action.',
  });
}
