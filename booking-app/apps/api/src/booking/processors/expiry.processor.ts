import { Injectable, Logger } from '@nestjs/common';

import { OrganizationContextService } from '../../organization/organization-context.service.js';
import { ExpiryService } from '../expiry.service.js';

import type { JOB, JobPayload } from '../../messaging/queues/job-contracts.js';

/**
 * Drives the expiry saga from the queue.
 *
 * Thin on purpose. It runs whichever phase the booking is actually in rather than being
 * told: `beginExpiry` no-ops on anything but a due PENDING_PAYMENT, and `completeExpiry`
 * no-ops on anything but EXPIRING. So one job type serves both phases, and a redelivered
 * job is harmless whichever phase it arrives in.
 *
 * Errors propagate, which is what makes BullMQ retry. That is the correct response to a
 * Stripe outage: the booking stays EXPIRING and the slot stays blocked until we know
 * whether the customer paid.
 */
@Injectable()
export class ExpiryProcessor {
  private readonly logger = new Logger('ExpiryProcessor');

  constructor(
    private readonly expiry: ExpiryService,
    private readonly organizations: OrganizationContextService,
  ) {}

  async handle(payload: JobPayload<typeof JOB.BOOKING_EXPIRY_REQUESTED>): Promise<void> {
    const { bookingId } = payload;

    // The payload names the tenant, so it is checked rather than ignored. A worker has no
    // request to resolve an organization from, and the saga talks to Stripe — so a job
    // running against the wrong organization would expire a session on the wrong account.
    this.organizations.require(payload.organizationId);

    // Phase one first. Usually a no-op — the delayed job normally arrives when the
    // booking is already EXPIRING because phase one ran from the sweeper — but running it
    // means the delayed job alone is sufficient if the sweeper never fires.
    const began = await this.expiry.beginExpiry(bookingId);

    if (began === 'NOT_DUE') {
      // The job fired early. Nothing to do: the sweeper will pick the booking up once it
      // really is due, and the reservation is still blocking until then.
      this.logger.debug(`booking ${bookingId} is not due yet`);
      return;
    }

    const outcome = await this.expiry.completeExpiry(bookingId);
    this.logger.debug(`booking ${bookingId} expiry settled as ${outcome}`);
  }
}
