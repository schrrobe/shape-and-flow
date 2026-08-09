import { Injectable, Logger } from '@nestjs/common';

import { runWithOrganization } from '../../organization/tenant-context.store.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RefundService } from '../refund.service.js';

import type { JOB, JobPayload } from '../../messaging/queues/job-contracts.js';

/**
 * Drives a requested refund to settlement.
 *
 * Thin, and deliberately so: `execute` returns early for a refund that has already
 * settled, so a redelivered job is a no-op rather than a second provider call.
 *
 * A transient provider failure propagates, which is what makes BullMQ retry — with the
 * refund's stored idempotency key, so the retry cannot move the money twice.
 */
@Injectable()
export class RefundProcessor {
  private readonly logger = new Logger('RefundProcessor');

  constructor(
    private readonly refunds: RefundService,
    private readonly prisma: PrismaService,
  ) {}

  async handle(payload: JobPayload<typeof JOB.REFUND_REQUESTED>): Promise<void> {
    // Open the job's own tenant scope before executing. `execute` reads the Stripe
    // account from context, and refunding from the wrong account is not a mistake that
    // can be taken back.
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      const outcome = await this.refunds.execute(payload.refundId);
      this.logger.debug(`refund ${payload.refundId} settled as ${outcome}`);
    });
  }
}
