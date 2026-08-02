import { Module } from '@nestjs/common';

import { AuditService } from './audit.service.js';

/**
 * The transactional audit writer, on its own.
 *
 * Extracted from BookingModule when the manual-payment service — which lives in
 * PaymentModule, because it is money rather than scheduling — needed it. BookingModule
 * already imports PaymentModule, so the alternative was a cycle.
 *
 * It is not `@Global()`: an audit row is written by a handful of services, and making it
 * ambient would hide which ones. `AuditService` has no dependencies of its own, so a
 * module that needs it just says so.
 */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditWriterModule {}
