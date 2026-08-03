import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module.js';

import { AuthController } from './auth.controller.js';
import { CsrfHeaderGuard } from './csrf-header.guard.js';
import { EmployeeScopeService } from './employee-scope.service.js';
import { OfficeSessionGuard } from './office-session.guard.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { RefundCapabilityGuard } from './refund-capability.guard.js';
import { RolesGuard } from './roles.guard.js';
import { SessionStore } from './session.store.js';

/**
 * Who an office user is, and how they prove it.
 *
 * The two guards are exported rather than bound globally. Every office controller from
 * Task 8.3 on declares them, which keeps "this route needs a session" visible at the
 * route instead of implied by a path prefix somewhere else — and means the global
 * AuthGuard's closed-by-default rule still has something to refuse.
 */
@Module({
  imports: [NotificationModule],
  controllers: [AuthController],
  providers: [
    PasswordService,
    SessionStore,
    PasswordResetService,
    OfficeSessionGuard,
    CsrfHeaderGuard,
    RolesGuard,
    RefundCapabilityGuard,
    EmployeeScopeService,
  ],
  exports: [
    PasswordService,
    // Exported for the office's user management: creating an account sends a reset
    // link rather than accepting a password, so the two flows share one implementation.
    PasswordResetService,
    SessionStore,
    OfficeSessionGuard,
    CsrfHeaderGuard,
    RolesGuard,
    RefundCapabilityGuard,
    EmployeeScopeService,
  ],
})
export class AuthModule {}
