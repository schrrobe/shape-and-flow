import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV } from '../config/env.schema.js';
import { CLOCK } from '../domain/time/clock.js';
import { REDIS } from '../messaging/queues/redis.provider.js';

import type { AppConfig } from '../config/env.schema.js';
import type { Clock } from '../domain/time/clock.js';
import type { OfficeUserRole } from '../prisma/client.js';
import type { Redis } from 'ioredis';

/** Where the office-session guard leaves what it resolved. */
export const CURRENT_USER = 'CURRENT_USER';

/**
 * What a session id buys you.
 *
 * The role and the refund capability are copied in at login rather than read from the
 * database per request, which is the usual trade: one fewer query on every office
 * request, at the cost of a demotion not taking effect until the user's sessions end.
 * That cost is paid down deliberately — changing a user's role destroys their sessions
 * (Task 8.4) — so the copy can never be stale for longer than one request.
 */
export interface OfficeSession {
  sid: string;
  officeUserId: string;
  organizationId: string;
  role: OfficeUserRole;
  canIssueRefunds: boolean;
  employeeId: string | null;
  /** Epoch milliseconds. The absolute cap is measured from here and never slides. */
  createdAt: number;
  lastSeenAt: number;
}

/** The office user, as much of it as a session needs. */
export interface SessionSubject {
  id: string;
  organizationId: string;
  role: OfficeUserRole;
  canIssueRefunds: boolean;
  employeeId: string | null;
}

/** 256 bits, base64url — the same shape and strength as a management token. */
const SID_BYTES = 32;

const sessionKey = (sid: string): string => `session:${sid}`;

/**
 * The revocation index.
 *
 * Note that it shares the `session:` namespace with the session keys but holds a set
 * rather than a string, so anything sweeping `session:*` has to distinguish the two —
 * `GET` against this key answers WRONGTYPE. A session id is base64url and can never
 * begin with `user:`, so the prefix is an unambiguous discriminator.
 */
const userKey = (officeUserId: string): string => `session:user:${officeUserId}`;

/**
 * Office sessions, in Redis.
 *
 * Server-side rather than a signed cookie, and that is the whole point: logging
 * someone out, revoking every session on a password reset, and ending the sessions of
 * a user who has just been demoted all have to *work*, and a stateless token cannot be
 * withdrawn before it expires.
 *
 * Two lifetimes, doing different jobs. The **idle TTL** is the Redis key's own
 * expiry, refreshed on every read, so an abandoned browser stops being a way in. The
 * **absolute cap** is checked against `createdAt` and never slides, so a session that
 * is kept warm by an open tab still ends — which is what stops a stolen cookie being
 * usable indefinitely.
 *
 * The `session:user:<id>` set is what makes revocation possible without scanning the
 * keyspace. It may hold ids of sessions that have since expired; every read of it
 * deletes what it names, so a stale entry costs one no-op DEL rather than correctness.
 */
@Injectable()
export class SessionStore {
  private readonly logger = new Logger('Session');

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Seconds a session survives without being used. */
  get idleTtlSeconds(): number {
    return this.config.SESSION_IDLE_TTL_MINUTES * 60;
  }

  /** Milliseconds after `createdAt` at which a session ends however active it is. */
  get absoluteTtlMs(): number {
    return this.config.SESSION_ABSOLUTE_TTL_MINUTES * 60_000;
  }

  /**
   * Start a session and return its id.
   *
   * A fresh id every time, never a reused or caller-supplied one, which is what makes
   * session fixation impossible: an attacker who plants a cookie value before login
   * finds it replaced by the login they tricked someone into performing.
   */
  async create(user: SessionSubject): Promise<string> {
    const sid = randomBytes(SID_BYTES).toString('base64url');
    const now = this.clock.now().getTime();

    const session: OfficeSession = {
      sid,
      officeUserId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      canIssueRefunds: user.canIssueRefunds,
      employeeId: user.employeeId,
      createdAt: now,
      lastSeenAt: now,
    };

    await this.redis
      .multi()
      .set(sessionKey(sid), JSON.stringify(session), 'EX', this.idleTtlSeconds)
      .sadd(userKey(user.id), sid)
      // The index cannot outlive the longest session it could name, or a busy account
      // would accumulate one set entry per login forever.
      .expire(userKey(user.id), Math.ceil(this.absoluteTtlMs / 1000))
      .exec();

    return sid;
  }

  /**
   * Load a session, sliding its idle TTL.
   *
   * Returns null for every reason a session can be unusable — absent, expired, past
   * its absolute cap, unparseable — so a caller has one branch rather than four, and
   * cannot accidentally treat "corrupt" as "valid".
   */
  async read(sid: string): Promise<OfficeSession | null> {
    const raw = await this.redis.get(sessionKey(sid));
    if (raw === null) return null;

    const session = parse(raw);
    if (session === null) {
      // Nothing writes this key but this class, so a value that will not parse means
      // the data was tampered with or a deploy changed the shape. Either way it is not
      // a session, and it should not survive to be read again.
      this.logger.warn('discarding an unparseable session');
      await this.redis.del(sessionKey(sid));
      return null;
    }

    const now = this.clock.now().getTime();

    if (now - session.createdAt >= this.absoluteTtlMs) {
      await this.destroy(sid);
      return null;
    }

    const touched: OfficeSession = { ...session, lastSeenAt: now };

    // One command that both writes lastSeenAt and slides the expiry. A separate
    // EXPIRE could succeed while the SET failed, leaving a session alive with a stale
    // last-seen — small, but there is no reason to allow it.
    await this.redis.set(sessionKey(sid), JSON.stringify(touched), 'EX', this.idleTtlSeconds);

    return touched;
  }

  /** End one session. Safe to call for a session that is already gone. */
  async destroy(sid: string): Promise<void> {
    const raw = await this.redis.get(sessionKey(sid));
    const session = raw === null ? null : parse(raw);

    const pipeline = this.redis.multi().del(sessionKey(sid));
    if (session !== null) pipeline.srem(userKey(session.officeUserId), sid);

    await pipeline.exec();
  }

  /**
   * End every session of one user.
   *
   * Used by the password reset, and by anything that changes what a session is allowed
   * to do. Returns how many session keys actually existed, which is what a test needs
   * to distinguish "revoked two" from "revoked nothing and said so".
   */
  async destroyAllForUser(officeUserId: string): Promise<number> {
    return await this.destroySessionsOf(officeUserId, null);
  }

  /**
   * End every session of one user except the one making the request.
   *
   * What `POST /auth/password` needs: changing your own password should sign out the
   * other browsers, not the one you are typing in.
   */
  async destroyOthersForUser(officeUserId: string, keepSid: string): Promise<number> {
    return await this.destroySessionsOf(officeUserId, keepSid);
  }

  private async destroySessionsOf(officeUserId: string, keepSid: string | null): Promise<number> {
    const sids = (await this.redis.smembers(userKey(officeUserId))).filter(
      (sid) => sid !== keepSid,
    );

    if (sids.length === 0) return 0;

    const pipeline = this.redis.multi().del(...sids.map(sessionKey));
    pipeline.srem(userKey(officeUserId), ...sids);

    const results = await pipeline.exec();

    // The DEL reply is how many keys existed, not how many ids the set held: sessions
    // whose idle TTL already expired leave their id behind in the set, and counting
    // those would report revocations that did not happen.
    const deleted = results?.[0]?.[1];
    return typeof deleted === 'number' ? deleted : 0;
  }
}

/** Parse a stored session, rejecting anything that is not one. */
function parse(raw: string): OfficeSession | null {
  try {
    const value = JSON.parse(raw) as Partial<OfficeSession>;

    if (
      typeof value.sid !== 'string' ||
      typeof value.officeUserId !== 'string' ||
      typeof value.organizationId !== 'string' ||
      typeof value.createdAt !== 'number'
    ) {
      return null;
    }

    return value as OfficeSession;
  } catch {
    return null;
  }
}
