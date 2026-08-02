import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { CLOCK } from '../domain/time/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { Clock } from '../domain/time/clock.js';
import type { Prisma } from '../prisma/client.js';

/** 256 bits. base64url so the token drops straight into a link with no escaping. */
const TOKEN_BYTES = 32;

/**
 * How long a link outlives the appointment.
 *
 * Two weeks after `endsAt`, not a fixed period from issue: the link's purpose is
 * managing *that* appointment, and a customer looking at a receipt a fortnight later is
 * the last plausible use. Tying it to the appointment also means a booking made a year
 * out does not carry a year-long credential.
 */
export const MANAGEMENT_TOKEN_GRACE_DAYS = 14;

export interface ResolvedToken {
  bookingId: string;
  organizationId: string;
}

/** The stored form. Exported so a test can assert the plaintext is nowhere in the row. */
export function hashManagementToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The customer's only credential.
 *
 * There are no accounts, so this token is what stands between a booking and the
 * internet. Three properties matter and each is enforced here rather than by
 * convention:
 *
 *  - **Only a hash is stored.** A database dump, a backup, or a support engineer
 *    reading rows cannot reconstruct a working link. The plaintext exists exactly once,
 *    in the return value, on its way into an email.
 *  - **Comparison is constant-time.** The lookup is by hash, so an attacker cannot
 *    learn a prefix by timing — but the final comparison is `timingSafeEqual` anyway,
 *    because the lookup is an optimisation and the comparison is the guarantee.
 *  - **It selects exactly one booking.** Nothing takes a booking id, so a token cannot
 *    be pointed at a different appointment.
 */
@Injectable()
export class ManagementTokenService {
  private readonly logger = new Logger('ManagementToken');

  constructor(
    // The root client: a token is resolved before any tenant is known — resolving it is
    // how the tenant becomes known.
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Mint a token for a booking, returning the plaintext once.
   *
   * Takes the transaction client on purpose. The token is issued as part of confirming
   * or rescheduling a booking, and if that transaction rolls back the token must go with
   * it — otherwise a live credential exists for a booking that does not.
   */
  async issue(
    tx: Prisma.TransactionClient,
    bookingId: string,
    organizationId: string,
    endsAt: Date,
  ): Promise<{ token: string }> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await tx.managementToken.create({
      data: {
        organizationId,
        bookingId,
        tokenHash: hashManagementToken(token),
        expiresAt: new Date(endsAt.getTime() + MANAGEMENT_TOKEN_GRACE_DAYS * 86_400_000),
      },
      select: { id: true },
    });

    return { token };
  }

  /**
   * Revoke every live token for one booking and issue one for another.
   *
   * Used when a reschedule replaces a booking. Revoking matters as much as issuing: the
   * old link is in the customer's mailbox and would otherwise keep working against a
   * booking that has been cancelled, showing them a stale appointment.
   */
  async rotate(
    tx: Prisma.TransactionClient,
    oldBookingId: string,
    newBookingId: string,
    organizationId: string,
    endsAt: Date,
  ): Promise<{ token: string }> {
    await tx.managementToken.updateMany({
      where: { bookingId: oldBookingId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });

    return await this.issue(tx, newBookingId, organizationId, endsAt);
  }

  /**
   * Resolve a presented token, or refuse.
   *
   * Every failure — unknown, revoked, expired, malformed — produces the same error with
   * the same message. Distinguishing them would tell a caller which of their guesses
   * was closer.
   */
  async resolve(token: string): Promise<ResolvedToken> {
    const row = await this.prisma.managementToken.findUnique({
      where: { tokenHash: hashManagementToken(token) },
      select: {
        id: true,
        bookingId: true,
        organizationId: true,
        tokenHash: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    if (row === null) throw unauthenticated();

    // The lookup already matched on the hash, so this can only fail on a hash
    // collision. It is here because the guarantee should not depend on the lookup being
    // the thing that compares secrets.
    if (!constantTimeEquals(row.tokenHash, hashManagementToken(token))) throw unauthenticated();

    if (row.revokedAt !== null) throw unauthenticated();
    if (row.expiresAt <= this.clock.now()) throw unauthenticated();

    this.touch(row.id);

    return { bookingId: row.bookingId, organizationId: row.organizationId };
  }

  /**
   * Record that the link was used, without making the request depend on it.
   *
   * Deliberately not awaited. `lastUsedAt` is diagnostic — it answers "did the customer
   * ever open the link" — and a write failure must not turn a working request into a
   * 500.
   */
  private touch(id: string): void {
    void this.prisma.managementToken
      .update({ where: { id }, data: { lastUsedAt: this.clock.now() }, select: { id: true } })
      .catch((error: unknown) => {
        this.logger.warn(
          `could not record lastUsedAt: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}

/** One error, one message, for every way a token can be unacceptable. */
function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', {
    message: 'This management link is not valid. It may have expired or been replaced.',
  });
}

/** Length-checked before comparing, because `timingSafeEqual` throws on a mismatch. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  return left.length === right.length && timingSafeEqual(left, right);
}
