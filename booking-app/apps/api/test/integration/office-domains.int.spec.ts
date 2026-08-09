import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { AuditModule } from '../../src/common/audit/audit.module.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OfficeModule } from '../../src/office/office.module.js';
import { OfficeTenantMiddleware } from '../../src/organization/office-tenant.middleware.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { queues, redis } from '../redis.harness.js';

import type { AppConfig } from '../../src/config/env.schema.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * `/office/domains`, against a real database.
 *
 * The service spec covers the decisions; this covers what only the database can answer:
 * that the unique index actually stops a second organization from claiming a hostname,
 * that the partial index actually permits many non-primary domains and only one primary,
 * and that the audit interceptor writes a row for each mutation.
 */

const NOW = new Date('2026-08-14T20:00:00.000Z');
const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

const officeConfig = {
  SESSION_COOKIE_NAME: 'sf_office_session',
  SESSION_IDLE_TTL_MINUTES: 60,
  SESSION_ABSOLUTE_TTL_MINUTES: 10_080,
} as unknown as AppConfig;

let ctx: SeedContext;
let other: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;
let sessions: SessionStore;

async function ownerCookie(organizationId: string): Promise<string> {
  const user = await prisma.officeUser.create({
    data: {
      organizationId,
      email: `owner-${organizationId}@shape-and-flow.example`,
      firstName: 'Owner',
      lastName: 'Person',
      passwordHash: 'placeholder-not-a-credential',
      role: 'OWNER',
    },
    select: { id: true },
  });

  const sid = await sessions.create({
    id: user.id,
    organizationId,
    role: 'OWNER',
    canIssueRefunds: true,
    employeeId: null,
  });

  return `${officeConfig.SESSION_COOKIE_NAME}=${sid}`;
}

beforeEach(async () => {
  await resetDatabase();

  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);

  ctx = await seedOrganization(prisma);
  other = await seedOrganization(prisma, { slug: 'other-studio' });

  // Built directly rather than resolved from the container, and before the app exists:
  // `main.ts` mounts the office tenant middleware with a raw `app.use()` ahead of the
  // Nest router, so it has to be handed in through the harness rather than added
  // afterwards — an `app.use()` after `init()` lands behind the router and never runs.
  // Sessions written through this instance are read by the guard's own, because both
  // sit on the same Redis.
  sessions = new SessionStore(redis, officeConfig, new FixedClock(NOW));
  const officeTenant = new OfficeTenantMiddleware(sessions, prisma, officeConfig);

  testApp = await createBookingTestApp({
    // The bootstrap organization is `ctx`, so every cross-tenant assertion below is
    // written from `other`'s side: a session that failed to switch the tenant would
    // fall back to `ctx` and the test would fail rather than quietly agree.
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    extraImports: [AuthModule, AuditModule, OfficeModule],
    redis,
    queues,
    globalPrefix: 'api',
    middleware: [['/api/office', officeTenant.middleware]],
  });

  server = testApp.server;

  return testApp.close;
});

describe('registering a domain', () => {
  it('stores the normalized hostname and lists it back', async () => {
    const cookie = await ownerCookie(ctx.organization.id);

    const created = await request(server())
      .post('/api/office/domains')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({ hostname: 'https://Studio-Muster.DE./', isPrimary: true });

    expect(created.status).toBe(201);
    expect((created.body as { domain: { hostname: string } }).domain.hostname).toBe(
      'studio-muster.de',
    );

    const listed = await request(server()).get('/api/office/domains').set('Cookie', cookie);

    expect(listed.status).toBe(200);
    expect((listed.body as { domains: { hostname: string }[] }).domains).toMatchObject([
      { hostname: 'studio-muster.de', isPrimary: true, verifiedAt: null },
    ]);
  });

  it('accepts several non-primary domains alongside one primary', async () => {
    const cookie = await ownerCookie(ctx.organization.id);

    for (const [hostname, isPrimary] of [
      ['studio-muster.de', true],
      ['www.studio-muster.de', false],
      ['studio-muster.com', false],
    ] as const) {
      const response = await request(server())
        .post('/api/office/domains')
        .set('Cookie', cookie)
        .set(...CSRF)
        .send({ hostname, isPrimary });

      expect(response.status, hostname).toBe(201);
    }

    const listed = await request(server()).get('/api/office/domains').set('Cookie', cookie);
    const domains = (listed.body as { domains: { isPrimary: boolean }[] }).domains;

    expect(domains).toHaveLength(3);
    expect(domains.filter((domain) => domain.isPrimary)).toHaveLength(1);
  });

  // The partial unique index would reject the insert outright if the demotion did not
  // happen in the same transaction, so this asserts the transaction, not just the flag.
  it('moves the primary flag rather than rejecting a second primary', async () => {
    const cookie = await ownerCookie(ctx.organization.id);

    await request(server())
      .post('/api/office/domains')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({ hostname: 'studio-muster.de', isPrimary: true });

    const second = await request(server())
      .post('/api/office/domains')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({ hostname: 'studio-muster.com', isPrimary: true });

    expect(second.status).toBe(201);

    const listed = await request(server()).get('/api/office/domains').set('Cookie', cookie);

    expect(
      (listed.body as { domains: { hostname: string; isPrimary: boolean }[] }).domains,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostname: 'studio-muster.com', isPrimary: true }),
        expect.objectContaining({ hostname: 'studio-muster.de', isPrimary: false }),
      ]),
    );
  });

  it('rejects a hostname that is not a plain domain name', async () => {
    const cookie = await ownerCookie(ctx.organization.id);

    const response = await request(server())
      .post('/api/office/domains')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({ hostname: 'studio-muster.de/booking' });

    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('refuses the platform address', async () => {
    const cookie = await ownerCookie(ctx.organization.id);

    const response = await request(server())
      .post('/api/office/domains')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({ hostname: 'localhost' });

    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });
});

describe('a hostname belongs to one organization', () => {
  it('refuses a duplicate within the same organization', async () => {
    const cookie = await ownerCookie(ctx.organization.id);

    for (const expected of [201, 409]) {
      const response = await request(server())
        .post('/api/office/domains')
        .set('Cookie', cookie)
        .set(...CSRF)
        .send({ hostname: 'studio-muster.de' });

      expect(response.status).toBe(expected);
    }
  });

  // The claim the whole feature rests on: a hostname resolves to exactly one tenant, and
  // it is the database that guarantees it rather than a read-then-write in the service.
  it('refuses a hostname another organization already holds, without saying whose', async () => {
    const mine = await ownerCookie(ctx.organization.id);
    const theirs = await ownerCookie(other.organization.id);

    const first = await request(server())
      .post('/api/office/domains')
      .set('Cookie', theirs)
      .set(...CSRF)
      .send({ hostname: 'studio-muster.de' });

    expect(first.status).toBe(201);

    const second = await request(server())
      .post('/api/office/domains')
      .set('Cookie', mine)
      .set(...CSRF)
      .send({ hostname: 'studio-muster.de' });

    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe('ORGANIZATION_DOMAIN_TAKEN');
    expect(JSON.stringify(second.body)).not.toContain(other.organization.id);
  });

  it("does not list another organization's domains", async () => {
    const mine = await ownerCookie(ctx.organization.id);
    const theirs = await ownerCookie(other.organization.id);

    await request(server())
      .post('/api/office/domains')
      .set('Cookie', theirs)
      .set(...CSRF)
      .send({ hostname: 'other-studio.de' });

    const listed = await request(server()).get('/api/office/domains').set('Cookie', mine);

    expect((listed.body as { domains: unknown[] }).domains).toEqual([]);
  });
});

describe('removing a domain', () => {
  it('deletes it and stops listing it', async () => {
    const cookie = await ownerCookie(ctx.organization.id);

    const created = await request(server())
      .post('/api/office/domains')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({ hostname: 'studio-muster.de' });

    const id = (created.body as { domain: { id: string } }).domain.id;

    const removed = await request(server())
      .delete(`/api/office/domains/${id}`)
      .set('Cookie', cookie)
      .set(...CSRF);

    expect(removed.status).toBe(200);

    const listed = await request(server()).get('/api/office/domains').set('Cookie', cookie);
    expect((listed.body as { domains: unknown[] }).domains).toEqual([]);
  });

  it("answers 404 for another organization's domain, and leaves it in place", async () => {
    const mine = await ownerCookie(ctx.organization.id);
    const theirs = await ownerCookie(other.organization.id);

    const created = await request(server())
      .post('/api/office/domains')
      .set('Cookie', theirs)
      .set(...CSRF)
      .send({ hostname: 'other-studio.de' });

    const id = (created.body as { domain: { id: string } }).domain.id;

    const removed = await request(server())
      .delete(`/api/office/domains/${id}`)
      .set('Cookie', mine)
      .set(...CSRF);

    expect(removed.status).toBe(404);
    expect((removed.body as { code: string }).code).toBe('NOT_FOUND');
    expect(await prisma.organizationDomain.findUnique({ where: { id } })).not.toBeNull();
  });
});

describe('audit trail', () => {
  // Adding a domain changes who the public flow answers as. A change like that with no
  // trace leaves nobody to ask when a hostname quietly stops resolving.
  it('records both the addition and the removal', async () => {
    const cookie = await ownerCookie(ctx.organization.id);

    const created = await request(server())
      .post('/api/office/domains')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({ hostname: 'studio-muster.de' });

    const id = (created.body as { domain: { id: string } }).domain.id;

    await request(server())
      .delete(`/api/office/domains/${id}`)
      .set('Cookie', cookie)
      .set(...CSRF);

    const rows = await prisma.auditLog.findMany({
      where: { organizationId: ctx.organization.id, entityType: 'OrganizationDomain' },
      orderBy: { createdAt: 'asc' },
      select: { action: true, entityId: true, summary: true },
    });

    expect(rows).toMatchObject([
      { action: 'ORGANIZATION_DOMAIN_ADDED', entityId: id, summary: 'studio-muster.de' },
      { action: 'ORGANIZATION_DOMAIN_REMOVED', entityId: id, summary: 'studio-muster.de' },
    ]);
  });
});
