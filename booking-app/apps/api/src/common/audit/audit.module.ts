import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuditInterceptor } from './audit.interceptor.js';

/**
 * The audit trail, bound globally and inert without `@Audited`.
 *
 * Global for the reason the idempotency interceptor is global: a per-controller binding
 * that somebody forgets fails silently, and "this action left no trace" is the kind of
 * silence nobody notices until it is being asked about in retrospect.
 */
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AuditModule {}
