import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
} from '@shape-and-flow/booking-contracts';

import { AppError } from '../common/errors/app-error.js';
import { Public } from '../common/guards/public.decorator.js';
import { ENV } from '../config/env.schema.js';
import { CLOCK } from '../domain/time/clock.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { CsrfHeaderGuard } from './csrf-header.guard.js';
import { CurrentUser, OfficeRoute, readCookie } from './office-session.guard.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { SessionStore } from './session.store.js';

import type { OfficeSession } from './session.store.js';
import type { AppConfig } from '../config/env.schema.js';
import type { Clock } from '../domain/time/clock.js';
import type { LoginResponse, OfficeUserDto } from '@shape-and-flow/booking-contracts';
import type { CookieOptions, Request, Response } from 'express';

/**
 * Ten attempts per quarter hour, per IP.
 *
 * This is the network-level half of the defence and it is deliberately not the whole
 * of it: an attacker with a botnet has many IPs but still only one target account, so
 * the per-account lockout below is what actually bounds guessing. Neither is a
 * substitute for the other.
 */
const LOGIN_LIMIT = { default: { limit: 10, ttl: 900_000 } };

/** Five per hour per IP. Enough for somebody who is genuinely confused. */
const RESET_LIMIT = { default: { limit: 5, ttl: 3_600_000 } };

/** Failed attempts before the account stops accepting even the right password. */
export const MAX_FAILED_ATTEMPTS = 10;

/** How long that lockout lasts. Long enough to be expensive, short enough to wait out. */
const LOCKOUT_MINUTES = 15;

/** What login needs to decide, and what the response is built from. */
const USER_FOR_LOGIN = {
  id: true,
  organizationId: true,
  email: true,
  passwordHash: true,
  firstName: true,
  lastName: true,
  role: true,
  canIssueRefunds: true,
  employeeId: true,
  failedLoginAttempts: true,
  lockedUntil: true,
  archivedAt: true,
} as const;

/**
 * Office authentication.
 *
 * The one design decision worth stating: **login branches only after both the lookup
 * and a verify have happened.** Returning early when no user matched would answer in
 * microseconds while a real address spends ~50ms hashing, and that gap is a working
 * account-enumeration oracle no matter how identical the error bodies are. So the
 * unknown-email path deliberately does the same work, against a dummy hash, and
 * every failure — unknown, wrong, archived, locked — leaves through one exit.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionStore,
    private readonly resets: PasswordResetService,
    private readonly organizations: OrganizationContextService,
    @Inject(ENV) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `POST /auth/login`. */
  @Public()
  @UseGuards(CsrfHeaderGuard)
  @Throttle(LOGIN_LIMIT)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const { email, password } = loginRequestSchema.parse(rawBody);
    const now = this.clock.now();

    const user = await this.prisma.officeUser.findFirst({
      // Never from the request: an office user belongs to the organization this
      // deployment serves, and the credential is only meaningful within it.
      where: {
        organizationId: this.organizations.getOrganizationId(),
        email: { equals: email, mode: 'insensitive' },
      },
      select: USER_FOR_LOGIN,
    });

    let verified = false;

    if (user === null) {
      await this.passwords.verifyDummy(password);
    } else {
      verified = await this.passwords.verify(user.passwordHash, password);
    }

    const locked = user !== null && user.lockedUntil !== null && user.lockedUntil > now;
    const archived = user !== null && user.archivedAt !== null;

    if (user === null || !verified || locked || archived) {
      // Counted even while locked, so a lockout that expires does not hand an attacker
      // a fresh budget of ten. Not counted when the password was right: the caller who
      // is being refused for being archived or locked is probably the legitimate owner.
      if (user !== null && !verified) await this.recordFailure(user.id);
      throw invalidCredentials();
    }

    // Conditional, and the condition is the same one checked above. Between that check
    // and this write a parallel attempt can have locked the account, and an
    // unconditional reset would clear the lock it just earned.
    const reset = await this.prisma.officeUser.updateMany({
      where: {
        id: user.id,
        archivedAt: null,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
    });

    if (reset.count !== 1) throw invalidCredentials();

    const sid = await this.sessions.create({
      id: user.id,
      organizationId: user.organizationId,
      role: user.role,
      canIssueRefunds: user.canIssueRefunds,
      employeeId: user.employeeId,
    });

    response.cookie(this.config.SESSION_COOKIE_NAME, sid, this.cookieOptions());

    return { user: toDto(user) };
  }

  /**
   * `POST /auth/logout`.
   *
   * Marked public on purpose, and it is not a hole: logging out takes no authenticated
   * identity, it invalidates whatever cookie was presented. Requiring a valid session
   * would make the second click of a double-click answer 401, and would leave somebody
   * holding an expired-but-still-in-Redis session unable to clear it.
   */
  @Public()
  @UseGuards(CsrfHeaderGuard)
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const sid = readCookie(request, this.config.SESSION_COOKIE_NAME);

    if (sid !== null) await this.sessions.destroy(sid);

    // Cleared with the same attributes it was set with; a mismatched Path leaves the
    // browser holding a cookie it will keep sending.
    response.clearCookie(this.config.SESSION_COOKIE_NAME, this.clearOptions());
  }

  /**
   * `GET /auth/me`.
   *
   * Reads the row rather than answering from the session, so a renamed user does not
   * see their old name until they sign in again.
   */
  @OfficeRoute()
  @Get('me')
  async me(@CurrentUser() session: OfficeSession): Promise<LoginResponse> {
    const user = await this.prisma.officeUser.findFirst({
      where: { id: session.officeUserId, organizationId: session.organizationId },
      select: USER_FOR_LOGIN,
    });

    if (user === null) {
      // The row went away under a live session. Ending the session is the only honest
      // answer; leaving it usable would be a session with nobody behind it.
      await this.sessions.destroy(session.sid);
      throw invalidCredentials();
    }

    return { user: toDto(user) };
  }

  /** `POST /auth/password-reset/request`. Always 202. */
  @Public()
  @Throttle(RESET_LIMIT)
  @Post('password-reset/request')
  @HttpCode(202)
  async requestPasswordReset(@Body() rawBody: unknown): Promise<void> {
    const { email } = passwordResetRequestSchema.parse(rawBody);
    await this.resets.request(email);
  }

  /** `POST /auth/password-reset/confirm`. */
  @Public()
  @Throttle(RESET_LIMIT)
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmPasswordReset(@Body() rawBody: unknown): Promise<void> {
    // Parsed before anything is looked up, so a password that breaks the rules is a 400
    // whatever the token turns out to be. The alternative — checking the token first —
    // would answer 401 for a request that has two things wrong with it and mention only
    // the one that reveals more.
    const { token, newPassword } = passwordResetConfirmSchema.parse(rawBody);
    await this.resets.confirm(token, newPassword);
  }

  /**
   * `POST /auth/password`.
   *
   * Revokes every *other* session: changing your password is the thing you do when you
   * think somebody else has it, and it would be a poor answer to sign that person's
   * browser out of nothing while signing yourself out too.
   */
  @UseGuards(CsrfHeaderGuard)
  @OfficeRoute()
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() session: OfficeSession,
    @Body() rawBody: unknown,
  ): Promise<void> {
    const { currentPassword, newPassword } = changePasswordRequestSchema.parse(rawBody);

    const user = await this.prisma.officeUser.findFirst({
      where: { id: session.officeUserId, organizationId: session.organizationId },
      select: { id: true, passwordHash: true },
    });

    if (user === null || !(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw invalidCredentials();
    }

    await this.prisma.officeUser.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(newPassword) },
      select: { id: true },
    });

    await this.sessions.destroyOthersForUser(session.officeUserId, session.sid);
  }

  /**
   * Record a failed attempt, locking the account once there have been enough.
   *
   * The counter is incremented by the database and the new value read back, rather than
   * computed from the one this request happened to read. Two wrong passwords arriving
   * together both read the same number and both stored it plus one, so ten attempts
   * counted as nine and the account that should have locked stayed open — which is
   * precisely the situation the lockout exists for.
   *
   * Both writes are one transaction, so a counter that crosses the threshold cannot
   * commit without the lock that goes with it.
   */
  private async recordFailure(officeUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.officeUser.update({
        where: { id: officeUserId },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true },
      });

      if (user.failedLoginAttempts < MAX_FAILED_ATTEMPTS) return;

      await tx.officeUser.update({
        where: { id: officeUserId },
        data: { lockedUntil: new Date(this.clock.now().getTime() + LOCKOUT_MINUTES * 60_000) },
        select: { id: true },
      });
    });
  }

  /**
   * How the session cookie is written.
   *
   * `Path=/api` rather than `/`: the browser then sends it to the API and to nothing
   * else — not to the static assets, not to anything else that might one day be served
   * from this origin. `Secure` is conditional because a development server is plain
   * HTTP and a Secure cookie there would simply never arrive.
   */
  private cookieOptions(): CookieOptions {
    return this.clearOptions();
  }

  private clearOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api',
    };
  }
}

/** One error, one message, for every way a credential can be unacceptable. */
function invalidCredentials(): AppError {
  return new AppError('UNAUTHENTICATED', { message: 'Invalid credentials.' });
}

/** The response shape. `passwordHash` is not in it, and cannot be added by accident. */
function toDto(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: OfficeUserDto['role'];
  canIssueRefunds: boolean;
  employeeId: string | null;
}): OfficeUserDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    canIssueRefunds: user.canIssueRefunds,
    employeeId: user.employeeId,
  };
}
