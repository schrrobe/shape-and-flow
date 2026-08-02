import { Injectable } from '@nestjs/common';

import { correlationId, hasCorrelation } from '../../common/correlation/correlation.store.js';
import { AppError } from '../../common/errors/app-error.js';
import { parseJobPayload } from '../queues/job-contracts.js';

import type { Prisma } from '../../prisma/client.js';
import type { JobName } from '../queues/job-contracts.js';

export interface OutboxEventInput {
  organizationId: string;
  /** The entity the event is about — `'Booking'`, `'Refund'`. Free text, for diagnosis. */
  aggregateType: string;
  aggregateId: string;
  eventType: JobName;
  payload: unknown;
  /** Withhold the event until this instant. Absent means immediately. */
  availableAt?: Date;
}

/**
 * True when the client is an interactive transaction client rather than a root one.
 *
 * Determined by `$connect`, verified against Prisma 7 rather than assumed: a
 * transaction client omits `$connect`, `$disconnect` and `$extends` while a root
 * client — including one wrapped by the tenant guard, whose proxy forwards them —
 * has all three. `$transaction` is *not* usable for this: Prisma 7 exposes it on
 * the transaction client too.
 */
function isTransactionClient(client: object): boolean {
  return !('$connect' in client);
}

/**
 * Fail loudly when a caller passes the root client instead of its transaction.
 *
 * This is the whole point of the outbox. A row written outside the transaction
 * that changed the state can commit when the state change does not, or fail when
 * it does — either way the guarantee is gone, and nothing about the code looks
 * wrong. So it is a runtime error rather than a convention.
 */
export function assertTransactionClient(client: object, caller: string): void {
  if (isTransactionClient(client)) return;

  throw new AppError('OUTBOX_NOT_TRANSACTIONAL', {
    status: 500,
    message:
      `${caller} was given a root Prisma client. Pass the transaction client from ` +
      '$transaction(async (tx) => ...), so the event commits with the state change.',
  });
}

/**
 * Writes the event that says what happened, in the transaction that made it happen.
 *
 * Nothing enqueues a job from a request handler. The handler records here; the
 * dispatcher enqueues from the committed row. That is what makes "state changed"
 * and "job will run" the same decision instead of two that can disagree.
 */
@Injectable()
export class OutboxRecorder {
  async record(tx: Prisma.TransactionClient, event: OutboxEventInput): Promise<void> {
    assertTransactionClient(tx, 'OutboxRecorder.record');

    // Validated here, before the insert, so a malformed payload fails in the
    // request that produced it rather than in a worker minutes later — by which
    // time the state change has committed and there is nothing left to reject.
    const payload = parseJobPayload(event.eventType, event.payload);

    // The correlation id is captured now, not at dispatch: the interesting id is
    // the request that caused the change, not the drain tick that happened to pick
    // the row up. Outside any scope it is left absent rather than stored as the
    // placeholder, so the dispatcher can supply its own.
    const correlated =
      payload.correlationId === undefined && hasCorrelation()
        ? { ...payload, correlationId: correlationId() }
        : payload;

    await tx.outboxEvent.create({
      data: {
        organizationId: event.organizationId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: correlated,
        ...(event.availableAt === undefined ? {} : { availableAt: event.availableAt }),
      },
    });
  }
}
