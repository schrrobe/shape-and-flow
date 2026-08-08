import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_FAILED_ATTEMPTS } from '../../src/auth/auth.controller.js';
import { AuthModule } from '../../src/auth/auth.module.js';
import { hashResetToken } from '../../src/auth/password-reset.service.js';
import { PasswordService } from '../../src/auth/password.service.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { NotificationService } from '../../src/notification/notification.service.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { connectRedis, redis } from '../redis.harness.js';

import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * Office authentication, against a real database and a real Redis.
 *
 * The session store is the reason this cannot be a unit suite: the idle TTL, the
 * absolute cap and revocation are Redis behaviours, and a fake would prove only that
 * the fake behaves as written.
 *
 * Everything is mounted under `/api`, unlike the other integration suites, because the
 * cookie is scoped to `Path=/api` and a path that never appears is a path never tested.
 *
 * The cookie is carried by hand rather than by `request.agent`. An agent keeps a
 * keep-alive socket open against the application under test, and this suite builds a new
 * application per test — the sockets outlive their server, `app.close()` waits on them,
 * and the *next file* then finds a stray connection blocking its `TRUNCATE`. That showed
 * up as unrelated suites failing intermittently, which is a considerably worse bargain
 * than passing one header explicitly.
 */

const NOW = new Date('2026-08-10T06:00:00.000Z');

const OWNER_EMAIL = 'owner@shape-and-flow.example';
const ARCHIVED_EMAIL = 'archived@shape-and-flow.example';
const OWNER_PASSWORD = 'correct-horse-battery-staple';

const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let server: () => Server;
let sessions: SessionStore;
let notifications: NotificationService;

/** Remove every session this suite left behind. Queue keys are the harness's business. */
async function clearSessions(): Promise<void> {
  await connectRedis();
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);
}

const login = (body: { email: string; password: string }) =>
  request(server())
    .post('/api/auth/login')
    .set(...CSRF)
    .send(body);

const loginOk = async () =>
  await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD }).expect(200);

/**
 * The `Set-Cookie` the response carried.
 *
 * Supertest types the header as a bare string while Node hands over an array, so this is
 * one place that copes with both rather than a cast repeated at every call site.
 */
function setCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? String(header[0]) : String(header);
}

/** A signed-in caller: the cookie to send, and the session id behind it. */
interface SignedIn {
  cookie: string;
  sid: string;
}

async function signIn(): Promise<SignedIn> {
  const header = setCookie(await loginOk());
  const match = /sf_office_session=([^;]+)/.exec(header);

  if (match?.[1] === undefined) throw new Error(`no session cookie in: ${header}`);

  // Just the name=value pair; the attributes are the browser's business, not ours.
  return { cookie: String(header.split(';')[0]), sid: decodeURIComponent(match[1]) };
}

const asUser = (user: SignedIn) => ({
  get: (path: string) => request(server()).get(path).set('Cookie', user.cookie),
  post: (path: string) => request(server()).post(path).set('Cookie', user.cookie),
});

/**
 * Send whatever is queued, so a test can read the message rather than the row.
 *
 * The worker is what does this in production; calling the service directly keeps the
 * suite about authentication instead of about job scheduling, while still going through
 * the real render and the real provider port.
 */
async function deliverQueuedEmail(): Promise<void> {
  const pending = await prisma.notification.findMany({
    where: { status: 'PENDING' },
    select: { id: true },
  });

  for (const row of pending) await notifications.send(row.id);
}

/** The token out of the link in the email, where a person would click it. */
function extractResetToken(body: string): string {
  const match = /reset-password#([A-Za-z0-9_-]+)/.exec(body);
  if (match?.[1] === undefined) throw new Error(`no reset link in: ${body}`);
  return match[1];
}

async function requestResetFor(email: string): Promise<void> {
  await request(server()).post('/api/auth/password-reset/request').send({ email }).expect(202);
  await deliverQueuedEmail();
}

const confirmReset = (body: { token: string; newPassword: string }) =>
  request(server()).post('/api/auth/password-reset/confirm').send(body);

/** The token from the most recent reset email. */
function latestResetToken(index = 0): string {
  return extractResetToken(testApp.email.sent[index]?.text ?? '');
}

beforeEach(async () => {
  await resetDatabase();
  await clearSessions();

  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    extraImports: [AuthModule],
    redis,
    globalPrefix: 'api',
  });

  server = testApp.server;
  sessions = testApp.app.get(SessionStore);
  notifications = testApp.app.get(NotificationService);

  // The factory writes a placeholder, because no other suite verifies a password.
  const passwordHash = await testApp.app.get(PasswordService).hash(OWNER_PASSWORD);

  await prisma.officeUser.update({ where: { id: ctx.owner.id }, data: { passwordHash } });

  await prisma.officeUser.create({
    data: {
      organizationId: ctx.organization.id,
      email: ARCHIVED_EMAIL,
      passwordHash,
      firstName: 'Rita',
      lastName: 'Alt',
      role: 'ADMIN',
      archivedAt: NOW,
    },
  });

  return testApp.close;
});

describe('POST /api/auth/login', () => {
  it('sets an HttpOnly, SameSite=Lax cookie scoped to /api', async () => {
    const cookie = setCookie(await loginOk());

    expect(cookie).toMatch(/^sf_office_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // Not `/`: the browser then sends it to the API and to nothing else served here.
    expect(cookie).toContain('Path=/api');
    // The server owns both idle and absolute expiry. A browser max-age fixed at login
    // would discard an otherwise active sliding session.
    expect(cookie).not.toContain('Max-Age');
    expect(cookie).not.toContain('Expires');
    // Not Secure outside production, or a plain-HTTP development server would never
    // receive the cookie it just set.
    expect(cookie).not.toContain('Secure');
  });

  it('rejects a cross-site form login without the csrf header', async () => {
    await request(server())
      .post('/api/auth/login')
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
      .expect(403);
  });

  it('returns the user without anything resembling a credential', async () => {
    const response = await loginOk();
    const body = response.body as { user: Record<string, unknown> };

    expect(body.user).toMatchObject({ role: 'OWNER', canIssueRefunds: true });
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(body)).not.toContain(OWNER_PASSWORD);
    expect(JSON.stringify(body)).not.toContain('argon2');
  });

  it.each([
    ['an unknown email', { email: 'nobody@example.com', password: 'whatever-long-enough' }],
    ['a wrong password', { email: OWNER_EMAIL, password: 'wrong-but-long' }],
    ['an archived user', { email: ARCHIVED_EMAIL, password: OWNER_PASSWORD }],
  ])('answers %s with an identical 401 and no cookie', async (_label, body) => {
    const response = await login(body).expect(401);

    expect(response.body).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Invalid credentials.',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('does not distinguish an unknown email by timing', async () => {
    const time = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await login({ email, password: 'x'.repeat(20) });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm up, so the first measurement does not pay for a cold argon2 and a cold pool.
    await time(OWNER_EMAIL);

    // The best of three on each side: the minimum is the least noise-prone estimator, and
    // this runs beside a database on shared hardware.
    const unknown = Math.min(await time('nobody@example.com'), await time('nobody@example.com'));
    const known = Math.min(await time(OWNER_EMAIL), await time(OWNER_EMAIL));

    // Without the dummy verify this is roughly 50ms against 1ms.
    expect(Math.abs(unknown - known)).toBeLessThan(Math.max(unknown, known) * 0.5);
  });

  it('locks the account after ten failures and still answers identically', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await login({ email: OWNER_EMAIL, password: 'wrong-but-long' }).expect(401);
    }

    const user = await prisma.officeUser.findFirstOrThrow({ where: { email: OWNER_EMAIL } });
    expect(user.failedLoginAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(user.lockedUntil).not.toBeNull();

    // The right password, refused — and refused in the same words, so the lockout is not
    // itself a signal that the password was right.
    const response = await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD }).expect(401);
    expect((response.body as { message: string }).message).toBe('Invalid credentials.');
  });

  it('counts parallel failures without losing increments', async () => {
    // Read-then-write on a stale counter: two requests in flight both read the same
    // value and both store it plus one, so the attempt that should have crossed the
    // threshold leaves the account one below it and unlocked.
    await prisma.officeUser.updateMany({
      where: { email: OWNER_EMAIL },
      data: { failedLoginAttempts: MAX_FAILED_ATTEMPTS - 2 },
    });

    const responses = await Promise.all([
      login({ email: OWNER_EMAIL, password: 'wrong-but-long' }),
      login({ email: OWNER_EMAIL, password: 'wrong-but-long' }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401]);

    const user = await prisma.officeUser.findFirstOrThrow({ where: { email: OWNER_EMAIL } });
    expect(user.failedLoginAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(user.lockedUntil).not.toBeNull();
  });

  it('accepts the password again once the lockout has passed', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await login({ email: OWNER_EMAIL, password: 'wrong-but-long' }).expect(401);
    }

    clock.set(new Date(NOW.getTime() + 16 * 60_000));

    await loginOk();
  });

  it('rotates the session id on login, so a planted cookie is worthless', async () => {
    const first = await signIn();
    const second = await signIn();

    expect(first.sid).not.toBe(second.sid);
  });

  it('resets the failure counter on success', async () => {
    await login({ email: OWNER_EMAIL, password: 'wrong-but-long' }).expect(401);
    await loginOk();

    const user = await prisma.officeUser.findFirstOrThrow({ where: { email: OWNER_EMAIL } });
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('matches the address case-insensitively', async () => {
    await login({ email: OWNER_EMAIL.toUpperCase(), password: OWNER_PASSWORD }).expect(200);
  });

  /**
   * Login is an exact match now (`findUnique` on a lowercased input), not the
   * case-insensitive `findFirst` this replaced. The test above seeds its row already
   * lowercase and so cannot tell the two implementations apart — it passes under both.
   * This one seeds the row the way it would actually sit in production before the
   * `office_user_email_global_unique` migration ran: written with whatever casing the
   * owner originally typed. The migration's own `UPDATE ... SET email = lower(email)` is
   * applied by hand here, because this suite's migrations run once against an empty
   * database, before any factory has written a row for them to normalize.
   */
  it('finds a legacy mixed-case address once the email migration has normalized it', async () => {
    await prisma.officeUser.update({
      where: { id: ctx.owner.id },
      data: { email: 'Owner@Shape-And-Flow.example' },
    });

    // Before normalization: the exact-match lookup on a lowercased login input misses the
    // mixed-case row entirely. That silent miss is the lockout this migration exists to fix.
    await login({ email: 'OWNER@SHAPE-AND-FLOW.EXAMPLE', password: OWNER_PASSWORD }).expect(401);

    await prisma.$executeRawUnsafe(
      'UPDATE "office_users" SET email = lower(email) WHERE id = $1',
      ctx.owner.id,
    );

    await login({ email: 'OWNER@SHAPE-AND-FLOW.EXAMPLE', password: OWNER_PASSWORD }).expect(200);
  });

  it('logs in an owner belonging to a different organization than the bootstrap default', async () => {
    const other = await prisma.organization.create({
      data: {
        slug: 'second-org',
        name: 'Second Org',
        legalName: 'Second Org GmbH',
        contactEmail: 'owner@second-org.example',
        contactPhone: '+49301234567',
        addressLine1: 'Beispielstraße 1',
        postalCode: '10115',
        city: 'Berlin',
      },
    });
    await prisma.organizationSettings.create({
      data: { organizationId: other.id, officeNotificationEmail: 'owner@second-org.example' },
    });
    await prisma.officeUser.create({
      data: {
        organizationId: other.id,
        email: 'owner@second-org.example',
        passwordHash: await new PasswordService().hash('Correct-Horse-Battery-9'),
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'OWNER',
        canIssueRefunds: true,
      },
    });

    const res = await login({ email: 'owner@second-org.example', password: 'Correct-Horse-Battery-9' });

    expect(res.status).toBe(200);
    expect((res.body as { user: { email: string } }).user.email).toBe('owner@second-org.example');
  });
});

describe('session and csrf', () => {
  /**
   * `/auth/me` stands in for an office route here. Stage 8.3 is what adds `/office/*`;
   * the guard being exercised is the one those routes will declare.
   */
  it('rejects a session-authenticated request without a session', async () => {
    const response = await request(server()).get('/api/auth/me').expect(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a cookie naming a session that no longer exists', async () => {
    const user = await signIn();
    await clearSessions();

    await asUser(user).get('/api/auth/me').expect(401);
  });

  it('allows a GET without X-Requested-With', async () => {
    const user = await signIn();

    const response = await asUser(user).get('/api/auth/me').expect(200);
    expect((response.body as { user: { email: string } }).user.email).toBe(OWNER_EMAIL);
  });

  it('rejects a state-changing request without X-Requested-With', async () => {
    const user = await signIn();

    const response = await asUser(user)
      .post('/api/auth/password')
      .send({ currentPassword: OWNER_PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(403);

    expect(response.body).toMatchObject({ code: 'CSRF_FAILED' });
  });

  it('slides the idle expiry on every read', async () => {
    const user = await signIn();

    const before = await redis.ttl(`session:${user.sid}`);
    // Spend some of it, then use the session.
    await redis.expire(`session:${user.sid}`, before - 100);
    await sessions.read(user.sid);

    expect(await redis.ttl(`session:${user.sid}`)).toBeGreaterThan(before - 100);
  });

  it('expires the session after the absolute cap even while it is being used', async () => {
    const user = await signIn();

    // Age the session by moving *its own record*, not the clock: the idle TTL is a real
    // Redis expiry that winding a FixedClock forward would not touch, and `createdAt` is
    // what the absolute cap reads. Same rule the outbox and expiry suites learned — to
    // control a comparison against a stored value, move the value.
    const raw = JSON.parse(String(await redis.get(`session:${user.sid}`))) as { createdAt: number };
    raw.createdAt = NOW.getTime() - 8 * 86_400_000;
    await redis.set(`session:${user.sid}`, JSON.stringify(raw), 'KEEPTTL');

    await asUser(user).get('/api/auth/me').expect(401);
    // And it is gone, not merely refused.
    expect(await redis.exists(`session:${user.sid}`)).toBe(0);
  });

  it('logout is idempotent, clears the cookie, and ends the session', async () => {
    const user = await signIn();

    const first = await asUser(user)
      .post('/api/auth/logout')
      .set(...CSRF)
      .expect(204);
    // Cleared with the attributes it was set with, or the browser keeps sending it.
    expect(setCookie(first)).toContain('Path=/api');
    expect(setCookie(first)).toMatch(/sf_office_session=;/);

    await asUser(user)
      .post('/api/auth/logout')
      .set(...CSRF)
      .expect(204);

    await asUser(user).get('/api/auth/me').expect(401);
    expect(await redis.keys('session:*')).toEqual([]);
  });

  it('refuses a logout without the CSRF header', async () => {
    const user = await signIn();

    await asUser(user).post('/api/auth/logout').expect(403);
    // Still signed in, which is the point: a cross-site page cannot sign somebody out.
    await asUser(user).get('/api/auth/me').expect(200);
  });
});

describe('POST /api/auth/password', () => {
  it('changes the password and revokes the other sessions but not this one', async () => {
    const other = await signIn();
    const user = await signIn();

    await asUser(user)
      .post('/api/auth/password')
      .set(...CSRF)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(204);

    // The browser you are typing in stays signed in; the others do not.
    await asUser(user).get('/api/auth/me').expect(200);
    await asUser(other).get('/api/auth/me').expect(401);

    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD }).expect(401);
    await login({ email: OWNER_EMAIL, password: 'a-brand-new-password' }).expect(200);
  });

  it('refuses a wrong current password', async () => {
    const user = await signIn();

    await asUser(user)
      .post('/api/auth/password')
      .set(...CSRF)
      .send({ currentPassword: 'not-the-current-one', newPassword: 'a-brand-new-password' })
      .expect(401);
  });

  it('refuses a weak new password before doing anything', async () => {
    const user = await signIn();

    await asUser(user)
      .post('/api/auth/password')
      .set(...CSRF)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: 'short' })
      .expect(400);

    await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD }).expect(200);
  });
});

describe('password reset', () => {
  it('does not distinguish an unknown address by timing', async () => {
    const time = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await request(server()).post('/api/auth/password-reset/request').send({ email }).expect(202);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    await time(OWNER_EMAIL);
    const unknown = Math.min(await time('nobody@example.com'), await time('nobody@example.com'));
    const known = Math.min(await time(OWNER_EMAIL), await time(OWNER_EMAIL));

    expect(Math.abs(unknown - known)).toBeLessThan(Math.max(unknown, known) * 0.5);
  });

  it('answers 202 for an unknown address and sends nothing', async () => {
    await requestResetFor('nobody@example.com');

    expect(testApp.email.sent).toHaveLength(0);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('answers 202 for an archived user and sends nothing', async () => {
    await requestResetFor(ARCHIVED_EMAIL);

    expect(testApp.email.sent).toHaveLength(0);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('stores only a hash of the token', async () => {
    await requestResetFor(OWNER_EMAIL);

    const token = latestResetToken();
    const row = await prisma.passwordResetToken.findFirstOrThrow({});

    expect(row.tokenHash).toBe(hashResetToken(token));
    // A dump, a backup, or a support engineer reading rows cannot reset anybody's
    // password with what they find.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('consumes the token exactly once', async () => {
    await requestResetFor(OWNER_EMAIL);
    const token = latestResetToken();

    await confirmReset({ token, newPassword: 'a-new-long-password' }).expect(204);
    await confirmReset({ token, newPassword: 'another-long-password' }).expect(401);

    await login({ email: OWNER_EMAIL, password: 'a-new-long-password' }).expect(200);
    await login({ email: OWNER_EMAIL, password: 'another-long-password' }).expect(401);
  });

  it('sends a second link when asked twice, and retires the first', async () => {
    await requestResetFor(OWNER_EMAIL);
    await requestResetFor(OWNER_EMAIL);

    expect(testApp.email.sent).toHaveLength(2);

    const first = latestResetToken(0);
    const second = latestResetToken(1);
    expect(first).not.toBe(second);

    await confirmReset({ token: second, newPassword: 'a-new-long-password' }).expect(204);
    // The older link was issued against a password that no longer exists.
    await confirmReset({ token: first, newPassword: 'another-long-password' }).expect(401);
  });

  it('revokes every existing session', async () => {
    const user = await signIn();
    await requestResetFor(OWNER_EMAIL);

    await confirmReset({ token: latestResetToken(), newPassword: 'a-new-long-password' }).expect(
      204,
    );

    await asUser(user).get('/api/auth/me').expect(401);
  });

  it('still succeeds when post-commit session revocation is unavailable', async () => {
    await requestResetFor(OWNER_EMAIL);
    const revoke = vi.spyOn(sessions, 'destroyAllForUser').mockRejectedValueOnce(new Error('down'));

    try {
      await confirmReset({ token: latestResetToken(), newPassword: 'a-new-long-password' }).expect(
        204,
      );
    } finally {
      revoke.mockRestore();
    }

    await login({ email: OWNER_EMAIL, password: 'a-new-long-password' }).expect(200);
  });

  it('clears a lockout, because the person proved they hold the mailbox', async () => {
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await login({ email: OWNER_EMAIL, password: 'wrong-but-long' }).expect(401);
    }

    await requestResetFor(OWNER_EMAIL);
    await confirmReset({ token: latestResetToken(), newPassword: 'a-new-long-password' }).expect(
      204,
    );

    await login({ email: OWNER_EMAIL, password: 'a-new-long-password' }).expect(200);
  });

  it('rejects an expired token, and rejects a weak password before looking at it', async () => {
    await requestResetFor(OWNER_EMAIL);
    const token = latestResetToken();

    await prisma.passwordResetToken.updateMany({
      data: { expiresAt: new Date(NOW.getTime() - 1000) },
    });

    await confirmReset({ token, newPassword: 'a-new-long-password' }).expect(401);
    // 400 rather than 401 for the same expired token: the body is checked first, so the
    // answer names the problem the caller can fix without confirming anything about the
    // token.
    await confirmReset({ token, newPassword: 'short' }).expect(400);
  });

  it('names the reset link in the email it sends', async () => {
    await requestResetFor(OWNER_EMAIL);
    const message = testApp.email.sent[0];

    expect(message?.to).toBe(OWNER_EMAIL);
    // The fragment is what keeps the token out of server logs and Referer headers.
    expect(message?.text).toContain('/office/reset-password#');
  });

  it("queues the reset notification under the requesting user's own organization, not the bootstrap default", async () => {
    const other = await prisma.organization.create({
      data: {
        slug: 'third-org',
        name: 'Third Org',
        legalName: 'Third Org GmbH',
        contactEmail: 'owner@third-org.example',
        contactPhone: '+49301234567',
        addressLine1: 'Beispielstraße 1',
        postalCode: '10115',
        city: 'Berlin',
        defaultLocale: 'en',
      },
    });
    await prisma.organizationSettings.create({
      data: { organizationId: other.id, officeNotificationEmail: 'owner@third-org.example' },
    });
    const user = await prisma.officeUser.create({
      data: {
        organizationId: other.id,
        email: 'owner@third-org.example',
        passwordHash: await new PasswordService().hash('Correct-Horse-Battery-9'),
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'OWNER',
        canIssueRefunds: true,
      },
    });

    await requestResetFor('owner@third-org.example');

    const token = await prisma.passwordResetToken.findFirstOrThrow({
      where: { officeUserId: user.id },
    });
    expect(token.organizationId).toBe(other.id);

    // The row was already scoped correctly before; the mail's *content* was not. The
    // reset request carries no tenant middleware, so the branding fields fell back to the
    // bootstrap organization — a member of Third Org read Shape and Flow's name, address
    // and phone number on a mail about their own account.
    const notification = await prisma.notification.findFirstOrThrow({
      where: { officeUserId: user.id, kind: 'OFFICE_PASSWORD_RESET' },
    });

    expect(notification.payload).toMatchObject({
      businessName: 'Third Org',
      businessEmail: 'owner@third-org.example',
    });
  });
});
