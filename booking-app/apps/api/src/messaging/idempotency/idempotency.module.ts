import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * Idempotency.
 *
 * The interceptor is registered globally and does nothing unless a route carries
 * `@Idempotent`. That is deliberate: binding it per controller would mean every new
 * money-moving route needs someone to remember two things instead of one, and
 * forgetting the binding fails silently — the route would simply accept retries.
 */
@Global()
@Module({
  providers: [IdempotencyService, { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
