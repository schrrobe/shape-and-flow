import { Module } from '@nestjs/common';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { PasswordService } from '../../src/auth/password.service.js';
import { AuditModule } from '../../src/common/audit/audit.module.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OrganizationContextService } from '../../src/organization/organization-context.service.js';
import { OrganizationOnboardingController } from '../../src/organization/organization-onboarding.controller.js';
import { StripeConnectService } from '../../src/organization/stripe-connect.service.js';
import { OfficeUserRole } from '../../src/prisma/client.js';
import { STRIPE_CLIENT } from '../../src/providers/providers.module.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { connectRedis, redis } from '../redis.harness.js';

import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * `POST /office/organization/onboarding-link`, Task 7's recovery path for a
 * registration (Task 6) whose Stripe call failed.
 *
 * `OrganizationModule` is not imported wholesale here: it also provides
 * `OrganizationContextService` and `TENANT_PRISMA`, both of which the booking test
 * harness already substitutes with its own stand-ins, and importing the real module
 * alongside those substitutes would fight over the same tokens. Instead this suite
 * wires only what the controller under test needs — mirroring how
 * `authorization.int.spec.ts` mounts a probe controller through an ad-hoc module rather
 * than the real one.
 *
 * Stripe itself is a `vi.fn()` pair rather than the fake payment provider: the fake
 * payment provider is the checkout side (§ `providers/payment`), while
 * `StripeConnectService` is Connect onboarding, a different port with no fake
 * implementation of its own yet.
 */

const NOW = new Date('2026-08-14T09:00:00.000Z');
const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const ADMIN_PASSWORD = 'another-strong-password-2';

const fakeStripe = {
  accounts: { create: vi.fn() },
  accountLinks: { create: vi.fn() },
};

/**
 * Mounts the controller under test without pulling in the rest of `OrganizationModule`.
 *
 * Imports `AuthModule` itself, exactly as the real `OrganizationModule` does: the
 * controller's guards (`OfficeSessionGuard` via `@OfficeRoute()`, `RolesGuard`,
 * `CsrfHeaderGuard`) are resolved from this module's own injector, not the top-level
 * test module, so they must be reachable from here.
 */
@Module({
  imports: [AuthModule],
  controllers: [OrganizationOnboardingController],
  providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: fakeStripe }],
})
// Nest module declaration: an empty body by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class OnboardingProbeModule {}

let ctx: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;

async function clearSessions(): Promise<void> {
  await connectRedis();
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);
}

const login = (body: { email: string; password: string }) =>
  request(server()).post('/api/auth/login').set(...CSRF).send(body);

/** The `name=value` pair off a login response's `Set-Cookie`, ready for the next request. */
function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const raw = Array.isArray(header) ? String(header[0]) : String(header);
  return raw.split(';')[0] ?? '';
}

beforeEach(async () => {
  await resetDatabase();
  await clearSessions();
  fakeStripe.accounts.create.mockReset();
  fakeStripe.accountLinks.create.mockReset();

  ctx = await seedOrganization(prisma);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    extraImports: [AuthModule, AuditModule, OnboardingProbeModule],
    redis,
    globalPrefix: 'api',
  });
  server = testApp.server;

  const passwordHash = await testApp.app.get(PasswordService).hash(OWNER_PASSWORD);
  await prisma.officeUser.update({ where: { id: ctx.owner.id }, data: { passwordHash } });

  return testApp.close;
});

describe('POST /api/office/organization/onboarding-link', () => {
  it('creates a Stripe Express account and returns the link when none exists yet', async () => {
    fakeStripe.accounts.create.mockResolvedValue({ id: 'acct_new123' });
    fakeStripe.accountLinks.create.mockResolvedValue({
      url: 'https://connect.stripe.com/setup/acct_new123',
    });

    const loginResponse = await login({
      email: `owner@${ctx.organization.slug}.example`,
      password: OWNER_PASSWORD,
    }).expect(200);
    const cookie = cookieFrom(loginResponse);

    const response = await request(server())
      .post('/api/office/organization/onboarding-link')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({})
      .expect(201);

    expect(response.body).toEqual({
      onboardingLink: 'https://connect.stripe.com/setup/acct_new123',
    });
    expect(fakeStripe.accounts.create).toHaveBeenCalledTimes(1);
    expect(fakeStripe.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'hallo@shape-and-flow.example', country: 'DE' }),
    );

    const updated = await prisma.organization.findUniqueOrThrow({
      where: { id: ctx.organization.id },
    });
    expect(updated.stripeAccountId).toBe('acct_new123');
  });

  it('reuses an existing Stripe account and only creates a new link', async () => {
    await prisma.organization.update({
      where: { id: ctx.organization.id },
      data: { stripeAccountId: 'acct_existing' },
    });
    // The booking test harness's OrganizationContextService stub snapshots the
    // organization once, at app creation, rather than resolving it per-request the
    // way the real service does — so a write straight through Prisma needs an explicit
    // refresh to become visible to the controller under test.
    await testApp.app.get(OrganizationContextService).refresh();
    fakeStripe.accountLinks.create.mockResolvedValue({
      url: 'https://connect.stripe.com/setup/acct_existing',
    });

    const loginResponse = await login({
      email: `owner@${ctx.organization.slug}.example`,
      password: OWNER_PASSWORD,
    }).expect(200);
    const cookie = cookieFrom(loginResponse);

    const response = await request(server())
      .post('/api/office/organization/onboarding-link')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({})
      .expect(201);

    expect(response.body).toEqual({
      onboardingLink: 'https://connect.stripe.com/setup/acct_existing',
    });
    expect(fakeStripe.accounts.create).not.toHaveBeenCalled();
    expect(fakeStripe.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'acct_existing', type: 'account_onboarding' }),
    );
  });

  it('rejects a non-OWNER role with 403 FORBIDDEN_ROLE', async () => {
    const admin = await prisma.officeUser.create({
      data: {
        organizationId: ctx.organization.id,
        email: 'admin-onboarding@shape-and-flow.example',
        passwordHash: await testApp.app.get(PasswordService).hash(ADMIN_PASSWORD),
        firstName: 'Test',
        lastName: 'Admin',
        role: OfficeUserRole.ADMIN,
        canIssueRefunds: true,
      },
      select: { id: true, email: true },
    });

    const loginResponse = await login({ email: admin.email, password: ADMIN_PASSWORD }).expect(
      200,
    );
    const cookie = cookieFrom(loginResponse);

    const response = await request(server())
      .post('/api/office/organization/onboarding-link')
      .set('Cookie', cookie)
      .set(...CSRF)
      .send({})
      .expect(403);

    expect((response.body as { code: string }).code).toBe('FORBIDDEN_ROLE');
    expect(fakeStripe.accounts.create).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const response = await request(server())
      .post('/api/office/organization/onboarding-link')
      .set(...CSRF)
      .send({})
      .expect(401);

    expect((response.body as { code: string }).code).toBe('UNAUTHENTICATED');
  });
});

describe('GET /api/office/organization', () => {
  it('returns stripeChargesEnabled for any authenticated office role', async () => {
    const admin = await prisma.officeUser.create({
      data: {
        organizationId: ctx.organization.id,
        email: 'admin-status@shape-and-flow.example',
        passwordHash: await testApp.app.get(PasswordService).hash(ADMIN_PASSWORD),
        firstName: 'Test',
        lastName: 'Admin',
        role: OfficeUserRole.ADMIN,
        canIssueRefunds: true,
      },
      select: { id: true, email: true },
    });

    const loginResponse = await login({ email: admin.email, password: ADMIN_PASSWORD }).expect(
      200,
    );
    const cookie = cookieFrom(loginResponse);

    const response = await request(server())
      .get('/api/office/organization')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body).toEqual({ stripeChargesEnabled: false });
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const response = await request(server()).get('/api/office/organization').expect(401);

    expect((response.body as { code: string }).code).toBe('UNAUTHENTICATED');
  });
});
