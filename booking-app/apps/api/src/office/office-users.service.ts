import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { PasswordResetService } from '../auth/password-reset.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionStore } from '../auth/session.store.js';
import { AppError } from '../common/errors/app-error.js';
import { isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { CLOCK } from '../domain/time/clock.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type { Clock } from '../domain/time/clock.js';
import type { OfficeUser } from '../prisma/client.js';
import type {
  CreateOfficeUserRequest,
  OfficeUserListItem,
  OfficeUserListResponse,
  OfficeUserMutationResponse,
  UpdateOfficeUserRequest,
} from '@shape-and-flow/booking-contracts';

/**
 * Office user management. `OWNER` only, enforced at the controller.
 *
 * Three rules are worth reading before changing anything here.
 *
 * **No password ever travels in.** A new user is created with a hash of random bytes
 * nobody has seen, and a reset link is sent. An owner who chooses a colleague's first
 * password knows it, and it passes through a form and a request body for no benefit —
 * the colleague has to be sent something regardless.
 *
 * **A session carries a copy of what it may do.** Role and refund capability are read
 * into the session at login rather than queried per request, so anything that changes
 * either has to end the sessions holding the old copy. That is the price of the copy,
 * and it is paid here rather than left as a window.
 *
 * **You cannot demote or archive yourself.** The last owner locking themselves out of
 * their own business is not hypothetical, and there is no support desk to call.
 */
@Injectable()
export class OfficeUsersService {
  private readonly logger = new Logger('OfficeUsers');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly passwords: PasswordService,
    private readonly passwordResets: PasswordResetService,
    private readonly sessions: SessionStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(includeArchived: boolean): Promise<OfficeUserListResponse> {
    const rows = await this.prisma.officeUser.findMany({
      where: {
        organizationId: this.organizationId(),
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ role: 'asc' }, { lastName: 'asc' }],
    });

    return { items: rows.map(toDto) };
  }

  /**
   * Create a user and send them a link to set their own password.
   *
   * The reset request runs after the user row is committed, and a failure to queue the
   * mail does not undo the account: the owner can resend from the login page, whereas a
   * rolled-back create would leave them repeating the form with no explanation.
   */
  async create(input: CreateOfficeUserRequest): Promise<OfficeUserMutationResponse> {
    const organizationId = this.organizationId();
    await this.assertEmployeeUsable(input.employeeId);

    // Argon2 over 32 random bytes: a real hash of a password that does not exist, so
    // there is no sentinel value for a future reader to mistake for a usable one, and
    // no branch in the login path that has to know about it.
    const passwordHash = await this.passwords.hash(randomBytes(32).toString('base64url'));

    let user: OfficeUser;
    try {
      user = await this.prisma.officeUser.create({
        data: {
          organizationId,
          email: input.email.toLowerCase(),
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          role: input.role,
          canIssueRefunds: input.canIssueRefunds,
          ...(input.employeeId === undefined || input.employeeId === null
            ? {}
            : { employeeId: input.employeeId }),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) {
        throw new AppError('VALIDATION_FAILED', {
          message: 'That address already has an account.',
          details: { issues: [{ path: ['email'], message: 'already in use', code: 'duplicate' }] },
        });
      }
      throw error;
    }

    await this.passwordResets.request(input.email);

    return { user: toDto(user), revokedSessions: 0 };
  }

  /**
   * Patch a user, revoking their sessions when the patch changes what those sessions
   * are allowed to do.
   *
   * Name changes do not revoke; role, refund capability and the employee link do. The
   * last one matters as much as the first two: an `EMPLOYEE` session is scoped to
   * `session.employeeId`, so repointing it while a session is live would leave that
   * session reading a colleague's calendar.
   */
  async update(
    actor: OfficeSession,
    id: string,
    patch: UpdateOfficeUserRequest,
  ): Promise<OfficeUserMutationResponse> {
    const existing = await this.load(id);

    if (patch.role !== undefined && patch.role !== existing.role) {
      this.assertNotSelf(actor, id, 'You cannot change your own role.');
    }
    if (patch.canIssueRefunds !== undefined && patch.canIssueRefunds !== existing.canIssueRefunds) {
      this.assertNotSelf(actor, id, 'You cannot change your own refund permission.');
    }

    await this.assertEmployeeUsable(patch.employeeId);

    const user = await this.prisma.officeUser.update({
      where: { id },
      data: {
        ...optional('firstName', patch.firstName),
        ...optional('lastName', patch.lastName),
        ...optional('role', patch.role),
        ...optional('canIssueRefunds', patch.canIssueRefunds),
        ...optional('employeeId', patch.employeeId),
      },
    });

    const authorizationChanged =
      user.role !== existing.role ||
      user.canIssueRefunds !== existing.canIssueRefunds ||
      user.employeeId !== existing.employeeId;

    const revokedSessions = authorizationChanged ? await this.sessions.destroyAllForUser(id) : 0;

    if (authorizationChanged) {
      this.logger.log(
        `office user ${id} had their access changed; ${String(revokedSessions)} session(s) revoked`,
      );
    }

    return { user: toDto(user), revokedSessions };
  }

  /**
   * Archive a user and end every session they hold.
   *
   * The revocation is the point. Archiving only sets a column, and the login path
   * checks it — but a session that already exists never touches the login path, so
   * without this an archived user keeps working until their cookie expires.
   */
  async archive(actor: OfficeSession, id: string): Promise<OfficeUserMutationResponse> {
    const existing = await this.load(id);
    this.assertNotSelf(actor, id, 'You cannot archive your own account.');

    if (existing.archivedAt !== null) {
      return { user: toDto(existing), revokedSessions: 0 };
    }

    const user = await this.prisma.officeUser.update({
      where: { id },
      data: { archivedAt: this.clock.now() },
    });

    const revokedSessions = await this.sessions.destroyAllForUser(id);
    this.logger.log(`office user ${id} archived; ${String(revokedSessions)} session(s) revoked`);

    return { user: toDto(user), revokedSessions };
  }

  /* ── internals ──────────────────────────────────────────────────────────────── */

  private async load(id: string): Promise<OfficeUser> {
    const user = await this.prisma.officeUser.findFirst({
      where: { id, organizationId: this.organizationId() },
    });

    if (user === null) throw new AppError('NOT_FOUND', { message: 'Office user not found.' });
    return user;
  }

  private assertNotSelf(actor: OfficeSession, id: string, message: string): void {
    if (actor.officeUserId !== id) return;

    throw new AppError('CANNOT_MODIFY_SELF', { message });
  }

  /** The employee link must point at a live employee of this organization. */
  private async assertEmployeeUsable(employeeId: string | null | undefined): Promise<void> {
    if (employeeId === null || employeeId === undefined) return;

    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId: this.organizationId(), archivedAt: null },
      select: { id: true },
    });

    if (employee === null) throw new AppError('NOT_FOUND', { message: 'Employee not found.' });
  }

  private organizationId(): string {
    return this.organizations.getOrganizationId();
  }
}

function toDto(user: OfficeUser): OfficeUserListItem {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    canIssueRefunds: user.canIssueRefunds,
    employeeId: user.employeeId,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    archivedAt: user.archivedAt?.toISOString() ?? null,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
  };
}

/** Present only when the caller sent it. See the note in `employees.service.ts`. */
function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}
