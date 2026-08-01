import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module.js';

import { AuthController } from './auth.controller.js';
import { CsrfHeaderGuard } from './csrf-header.guard.js';
import { OfficeSessionGuard } from './office-session.guard.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
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
  ],
  exports: [PasswordService, SessionStore, OfficeSessionGuard, CsrfHeaderGuard],
})
export class AuthModule {}
