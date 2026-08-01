import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { CLOCK } from '../domain/time/clock.js';
import { BookingNotificationData } from '../notification/booking-notification-data.service.js';
import { NotificationService } from '../notification/notification.service.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { PasswordService } from './password.service.js';
import { SessionStore } from './session.store.js';

import type { AppConfig } from '../config/env.schema.js';
import type { Clock } from '../domain/time/clock.js';

/** 256 bits, base64url, so it drops into a link with no escaping. */
const TOKEN_BYTES = 32;

/**
 * How long a reset link lives.
 *
 * An hour is long enough to survive a slow mail server and a person who reads their
 * inbox after lunch, and short enough that a link sitting in an old mailbox is not a
 * standing key to the account.
 */
export const RESET_TOKEN_TTL_MINUTES = 60;

/** The stored form. Exported so a test can assert the plaintext is nowhere in the row. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Losing and regaining an office password.
 *
 * The whole flow is built around one rule: it must reveal nothing about who has an
 * account. `request` therefore answers 202 whatever happened — the address exists, does
 * not exist, or belongs to an archived user — and does the work only in the first case.
 *
 * SHA-256 rather than argon2 for the token, unlike the password beside it. The token is
 * 256 bits of system-generated randomness, so there is no dictionary to attack and no
 * work factor worth paying; what hashing buys here is only that a database dump cannot
 * be used to take over accounts, and a fast hash buys that just as completely.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordReset');

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionStore,
    private readonly notifications: NotificationService,
    private readonly notificationData: BookingNotificationData,
    private readonly organizations: OrganizationContextService,
    @Inject(ENV) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Issue a reset link, if there is anybody to issue it to.
   *
   * Returns nothing in every case. The caller answers 202 unconditionally, so no
   * branch of this method can become a way to ask "does this address have an account".
   */
  async request(email: string): Promise<void> {
    const organization = this.organizations.get();

    const user = await this.prisma.officeUser.findFirst({
      where: {
        organizationId: organization.id,
        email: { equals: email, mode: 'insensitive' },
        archivedAt: null,
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    if (user === null) {
      // Debug rather than warn: a typo'd address is ordinary, and a log line per attempt
      // at warn level would be a way to see which addresses exist by reading the logs.
      this.logger.debug('password reset requested for an address with no active user');
      return;
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(this.clock.now().getTime() + RESET_TOKEN_TTL_MINUTES * 60_000);

    await this.prisma.$transaction(async (tx) => {
      const row = await tx.passwordResetToken.create({
        data: {
          organizationId: organization.id,
          officeUserId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt,
        },
        select: { id: true },
      });

      await this.notifications.queue(tx, {
        organizationId: organization.id,
        kind: 'OFFICE_PASSWORD_RESET',
        channel: 'EMAIL',
        // The office has no per-user locale column; staff read the business's own.
        locale: organization.defaultLocale,
        recipient: user.email,
        officeUserId: user.id,
        // The token row's id, so asking twice sends twice. A stable discriminator would
        // make the second request produce a link nobody receives.
        dedupeDiscriminator: row.id,
        data: {
          ...this.notificationData.commonData(),
          officeUserName: `${user.firstName} ${user.lastName}`,
          resetUrl: this.resetUrl(token),
          expiresAt,
        },
      });
    });
  }

  /**
   * Consume a token and write the new password.
   *
   * The token is claimed with a conditional update rather than a read followed by a
   * write, so two requests arriving with the same link cannot both succeed: exactly one
   * of them sees `count === 1`.
   */
  async confirm(token: string, newPassword: string): Promise<void> {
    const now = this.clock.now();

    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
      select: { id: true, officeUserId: true, expiresAt: true, usedAt: true },
    });

    // One error for unknown, spent, and expired. Distinguishing them would tell a caller
    // which of their guesses was closer. Two statements rather than one condition only
    // because the narrowing reads better that way.
    if (row === null) throw invalidToken();
    if (row.usedAt !== null || row.expiresAt <= now) throw invalidToken();

    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });

      if (claimed.count !== 1) throw invalidToken();

      await tx.officeUser.update({
        where: { id: row.officeUserId },
        // The lockout goes with the old password. Somebody who has just proved they
        // control the mailbox should not be kept out by a stranger's failed guesses.
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
        select: { id: true },
      });

      // Any other live link for this user was issued against the password that no
      // longer exists.
      await tx.passwordResetToken.updateMany({
        where: { officeUserId: row.officeUserId, usedAt: null },
        data: { usedAt: now },
      });
    });

    // After the commit, not inside it: revoking sessions for a password change that then
    // rolled back would sign somebody out for nothing. If this throws, the password has
    // changed and the sessions have not — which sounds worse than it is, because a
    // session is only usable by reading the same Redis this just failed to write.
    const revoked = await this.sessions.destroyAllForUser(row.officeUserId);
    this.logger.log(`password reset completed; ${String(revoked)} session(s) revoked`);
  }

  /**
   * The link that goes in the email.
   *
   * The token is in the fragment, so it never reaches a server log, a proxy access log,
   * or a `Referer` header — the same reason the customer's management link is built this
   * way.
   */
  private resetUrl(token: string): string {
    return `${this.config.PUBLIC_WEB_ORIGIN}/office/reset-password#${token}`;
  }
}

function invalidToken(): AppError {
  return new AppError('UNAUTHENTICATED', {
    message: 'This reset link is not valid. It may have expired or already been used.',
  });
}
