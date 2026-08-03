import { Inject, Injectable, Logger } from '@nestjs/common';

import { isUniqueViolation } from '../../common/prisma-errors/prisma-errors.js';
import { CLOCK } from '../../domain/time/clock.js';
import { PrismaService } from '../../prisma/prisma.service.js';

import type { Clock } from '../../domain/time/clock.js';
import type { Prisma } from '../../prisma/client.js';

/** `state` is a string column, not an enum, so the two values live here. */
export const IDEMPOTENCY_STATE = {
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
} as const;

/**
 * How long a completed key replays for.
 *
 * A client that retries a booking a day later means a new booking, not a replay of
 * yesterday's. Twenty-four hours is long enough to cover a client retrying across a
 * network outage, and short enough that a reused key is not a surprise a week later.
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

/**
 * How long an in-flight attempt holds the key.
 *
 * This is a lease, not a timeout on the request. Its only job is to stop a key
 * being blocked forever when a process is killed mid-request: the normal failure
 * path is `abandon`, which frees the key immediately. Two minutes comfortably
 * exceeds a booking request, which creates a Checkout session.
 *
 * The residual race is worth naming. If an attempt somehow outlives its lease, a
 * second attempt can take the key over and both run. What makes that safe is not
 * this lease but the exclusion constraint on `bookings`: the second reservation
 * cannot overlap the first, so one of them fails with SLOT_UNAVAILABLE rather than
 * double-booking. See the Phase 1 limitations in the progress document.
 */
export const IDEMPOTENCY_LEASE_MS = 2 * 60_000;

export type BeginResult =
  | { outcome: 'NEW' }
  | { outcome: 'REPLAY'; statusCode: number; body: unknown }
  | { outcome: 'IN_PROGRESS' }
  | { outcome: 'MISMATCH' };

/** What a completed attempt records alongside its response. */
export interface CompleteMeta {
  organizationId?: string;
  bookingId?: string;
}

/**
 * Makes a mutation safely retryable.
 *
 * The contract is narrow on purpose. A key identifies one attempt at one operation
 * with one body: the same key with a different body, or in a different scope, is a
 * client bug and is refused rather than guessed at. For `POST /public/bookings` the
 * key is also the only thing that can return the Checkout URL again, so answering
 * the wrong request with a stored response would hand out a payment link for
 * somebody else's booking.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger('Idempotency');

  constructor(
    // The root client. These rows have a nullable organizationId — the key is minted
    // before the tenant is known for certain — and the sweeper scans globally, which
    // is why IdempotencyKey is excluded from ORG_SCOPED_MODELS.
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Claim a key, or report what the existing one says.
   *
   * Insert first and catch the unique violation, rather than reading and then
   * inserting: two simultaneous retries of the same request would both find nothing
   * on a read and both proceed, which is the exact thing this exists to prevent.
   */
  async begin(key: string, scope: string, requestHash: string): Promise<BeginResult> {
    const now = this.clock.now();

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key,
          scope,
          requestHash,
          state: IDEMPOTENCY_STATE.IN_PROGRESS,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_LEASE_MS),
        },
        select: { id: true },
      });

      return { outcome: 'NEW' };
    } catch (error) {
      if (!isUniqueViolation(error, 'key')) throw error;
    }

    return await this.inspect(key, scope, requestHash, now);
  }

  /** Decide what an existing row means for this attempt. */
  private async inspect(
    key: string,
    scope: string,
    requestHash: string,
    now: Date,
  ): Promise<BeginResult> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: { key },
      select: {
        scope: true,
        requestHash: true,
        state: true,
        statusCode: true,
        responseSnapshot: true,
        expiresAt: true,
        bookingId: true,
      },
    });

    // Swept between the failed insert and this read. Rare, and the honest answer is
    // to let the caller try again rather than invent an outcome.
    if (row === null) return { outcome: 'IN_PROGRESS' };

    // Checked before anything else: a key reused for a different operation must be
    // refused whatever state it is in. Replaying across scopes would answer a refund
    // request with a booking's Checkout URL.
    if (row.scope !== scope || row.requestHash !== requestHash) {
      this.logger.warn(
        `idempotency key reused: scope ${row.scope} vs ${scope}, hash ${row.requestHash === requestHash ? 'same' : 'different'}`,
      );
      return { outcome: 'MISMATCH' };
    }

    if (row.state === IDEMPOTENCY_STATE.COMPLETED) {
      return {
        outcome: 'REPLAY',
        // A completed row always has both, but the columns are nullable because they
        // are absent while in progress. Defaulted rather than asserted.
        statusCode: row.statusCode ?? 200,
        body: row.responseSnapshot ?? null,
      };
    }

    if (row.expiresAt > now) return { outcome: 'IN_PROGRESS' };

    return await this.takeOverExpiredLease(key, now, row.bookingId !== null);
  }

  /**
   * Take over a key whose lease has run out.
   *
   * Conditional on the row still being an expired in-progress one, so of several
   * retries arriving together exactly one takes it over and the rest are told the
   * attempt is in progress.
   *
   * Two different situations reach here and only one is a surprise. A bound key was
   * released deliberately by `abandon` and the caller is retrying an attempt that
   * failed after reserving — routine. An unbound one means the process holding it
   * died without abandoning it, which is worth a warning.
   */
  private async takeOverExpiredLease(key: string, now: Date, bound: boolean): Promise<BeginResult> {
    const { count } = await this.prisma.idempotencyKey.updateMany({
      where: {
        key,
        state: IDEMPOTENCY_STATE.IN_PROGRESS,
        expiresAt: { lte: now },
      },
      data: { expiresAt: new Date(now.getTime() + IDEMPOTENCY_LEASE_MS) },
    });

    if (count === 0) return { outcome: 'IN_PROGRESS' };

    if (bound) {
      this.logger.debug(`idempotency key ${key} retried after an attempt that held a reservation`);
    } else {
      this.logger.warn(`idempotency key ${key} taken over from an attempt that never finished`);
    }

    return { outcome: 'NEW' };
  }

  /**
   * Store the response so the next identical request replays it.
   *
   * Scoped to `state: IN_PROGRESS`, so a late completion cannot overwrite a response
   * already recorded.
   */
  async complete(
    key: string,
    statusCode: number,
    body: unknown,
    meta: CompleteMeta = {},
  ): Promise<void> {
    const now = this.clock.now();

    await this.prisma.idempotencyKey.updateMany({
      where: { key, state: IDEMPOTENCY_STATE.IN_PROGRESS },
      data: {
        state: IDEMPOTENCY_STATE.COMPLETED,
        statusCode,
        responseSnapshot: (body ?? null) as Prisma.InputJsonValue,
        ...(meta.organizationId === undefined ? {} : { organizationId: meta.organizationId }),
        ...(meta.bookingId === undefined ? {} : { bookingId: meta.bookingId }),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
  }

  /**
   * Release a key without storing a response.
   *
   * Called when the attempt failed. The distinction matters to the client: a stored
   * 500 would replay forever and the retry would never actually retry, so a failed
   * attempt has to leave the key as unused as it found it.
   *
   * Unused, though, is not the same as gone. An attempt that got as far as committing
   * a reservation left something behind, and the key is the only thing that names it:
   * deleting the row would send the retry off to book the same slot again, where it
   * would be refused by its own predecessor's hold. So a bound key keeps its row and
   * only gives up its lease — expired as of now, so the retry is told the attempt is
   * over rather than still running, and `ReservationService.resume()` can find the
   * reservation through it. An unbound key has nothing to point at and is deleted, as
   * before.
   */
  async abandon(key: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.idempotencyKey.deleteMany({
        where: { key, state: IDEMPOTENCY_STATE.IN_PROGRESS, bookingId: null },
      }),
      this.prisma.idempotencyKey.updateMany({
        where: { key, state: IDEMPOTENCY_STATE.IN_PROGRESS, bookingId: { not: null } },
        data: { expiresAt: this.clock.now() },
      }),
    ]);
  }

  /** Delete keys past their expiry. Runs as the `sweep.idempotency_keys` job. */
  async sweep(): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: this.clock.now() } },
    });

    if (count > 0) this.logger.debug(`swept ${String(count)} expired idempotency keys`);
    return count;
  }
}
