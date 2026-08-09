import { Module } from '@nestjs/common';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { PasswordService } from '../../src/auth/password.service.js';
import { AuditModule } from '../../src/common/audit/audit.module.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OrganizationContextService } from '../../src/organization/organization-context.service.js';
import { OrganizationPaymentsController } from '../../src/organization/organization-payments.controller.js';
import { StripeConnectService } from '../../src/organization/stripe-connect.service.js';
import { OfficeUserRole } from '../../src/prisma/client.js';
import { STRIPE_CLIENT } from '../../src/providers/providers.module.js';
import { createBookingTestApp, STRIPE_PUBLISHABLE_KEY } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { connectRedis, redis } from '../redis.harness.js';

import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * `POST /office/organization/account-session`, which is what lets `/office/payments`
 * mount Stripe's Connect embedded components.
 *
 * Wired the same way as `organization-onboarding.int.spec.ts`, and for the same reason:
 * importing `OrganizationModule` wholesale would fight the booking test harness over
 * `OrganizationContextService` and `TENANT_PRISMA`, so the probe module below provides
 * only what the controller under test needs.
 *
 * The publishable key comes from the harness's own `ENV`, not from a provider declared
 * here. Overriding `ENV` in this module would also rebind it for the enhancers Nest
 * instantiates in this module's context — `OfficeSessionGuard` among them — and a guard
 * that cannot read `SESSION_COOKIE_NAME` turns every authenticated case into a 401.
 */

const NOW = new Date('2026-08-14T09:00:00.000Z');
const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const ADMIN_PASSWORD = 'another-strong-password-2';
const fakeStripe = {
  accountSessions: { create: vi.fn() },
};

@Module({
  imports: [AuthModule],
  controllers: [OrganizationPaymentsController],
  providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: fakeStripe }],
})
// Nest module declaration: an empty body by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class PaymentsProbeModule {}

let ctx: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;

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

/** The `name=value` pair off a login response's `Set-Cookie`, ready for the next request. */
function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const raw = Array.isArray(header) ? String(header[0]) : String(header);
  return raw.split(';')[0] ?? '';
}

/**
 * The harness's `OrganizationContextService` stub snapshots the organization once, at app
 * creation, so a write straight through Prisma needs an explicit refresh before the
 * controller can see it.
 */
async function setStripeState(state: {
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
}): Promise<void> {
  await prisma.organization.update({ where: { id: ctx.organization.id }, data: state });
  await testApp.app.get(OrganizationContextService).refresh();
}

async function ownerCookie(): Promise<string> {
  const response = await login({
    email: `owner@${ctx.organization.slug}.example`,
    password: OWNER_PASSWORD,
  }).expect(200);

  return cookieFrom(response);
}

const post = (cookie?: string) => {
  const pending = request(server())
    .post('/api/office/organization/account-session')
    .set(...CSRF);

  return cookie === undefined ? pending.send({}) : pending.set('Cookie', cookie).send({});
};

beforeEach(async () => {
  await resetDatabase();
  await clearSessions();
  fakeStripe.accountSessions.create.mockReset();

  ctx = await seedOrganization(prisma);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    extraImports: [AuthModule, AuditModule, PaymentsProbeModule],
    redis,
    globalPrefix: 'api',
  });
  server = testApp.server;

  const passwordHash = await testApp.app.get(PasswordService).hash(OWNER_PASSWORD);
  await prisma.officeUser.update({ where: { id: ctx.owner.id }, data: { passwordHash } });

  return testApp.close;
});

describe('POST /api/office/organization/account-session', () => {
  it('returns a client secret and the publishable key for an onboarded organization', async () => {
    await setStripeState({ stripeAccountId: 'acct_ready', stripeChargesEnabled: true });
    fakeStripe.accountSessions.create.mockResolvedValue({ client_secret: 'accs_secret_123' });

    const response = await post(await ownerCookie()).expect(201);

    expect(response.body).toEqual({
      clientSecret: 'accs_secret_123',
      publishableKey: STRIPE_PUBLISHABLE_KEY,
    });
  });

  // Asserted on the call rather than the response, because the response says nothing about
  // which controls the organizer will actually be handed. Turning `capture_payments` on, or
  // dropping `refund_management`, would change the page without changing anything a
  // response-shape assertion can see.
  it('asks Stripe for exactly the components the page mounts', async () => {
    await setStripeState({ stripeAccountId: 'acct_components', stripeChargesEnabled: true });
    fakeStripe.accountSessions.create.mockResolvedValue({
      client_secret: 'accs_secret_components',
    });

    await post(await ownerCookie()).expect(201);

    expect(fakeStripe.accountSessions.create).toHaveBeenCalledTimes(1);
    expect(fakeStripe.accountSessions.create).toHaveBeenCalledWith({
      account: 'acct_components',
      components: {
        payments: {
          enabled: true,
          features: {
            refund_management: true,
            dispute_management: true,
            capture_payments: false,
          },
        },
        payouts: { enabled: true, features: { instant_payouts: false } },
      },
    });
  });

  // The default `after` is the response body, and that body carries a live AccountSession
  // secret — anyone who could read the audit table could open the organizer's payments view.
  it('records the request without the client secret itself', async () => {
    await setStripeState({ stripeAccountId: 'acct_audit', stripeChargesEnabled: true });
    fakeStripe.accountSessions.create.mockResolvedValue({ client_secret: 'accs_secret_audit' });

    await post(await ownerCookie()).expect(201);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ORGANIZATION_ACCOUNT_SESSION_CREATED' },
      orderBy: { createdAt: 'desc' },
    });

    expect(JSON.stringify(audit.after)).not.toContain('accs_secret_audit');
    expect(audit.after).toMatchObject({
      stripeAccountId: 'acct_audit',
      components: ['payments', 'payouts'],
    });
  });

  it('refuses with ORGANIZATION_ONBOARDING_INCOMPLETE when no Stripe account exists', async () => {
    await setStripeState({ stripeAccountId: null, stripeChargesEnabled: false });

    const response = await post(await ownerCookie()).expect(422);

    expect((response.body as { code: string }).code).toBe('ORGANIZATION_ONBOARDING_INCOMPLETE');
    expect(fakeStripe.accountSessions.create).not.toHaveBeenCalled();
  });

  // The account exists but Stripe has not cleared it. Without this branch the page would
  // mount a component that renders empty, which reads as our bug rather than unfinished
  // onboarding.
  it('refuses with ORGANIZATION_ONBOARDING_INCOMPLETE when charges are not enabled yet', async () => {
    await setStripeState({ stripeAccountId: 'acct_pending', stripeChargesEnabled: false });

    const response = await post(await ownerCookie()).expect(422);

    expect((response.body as { code: string }).code).toBe('ORGANIZATION_ONBOARDING_INCOMPLETE');
    expect(fakeStripe.accountSessions.create).not.toHaveBeenCalled();
  });

  it('rejects a non-OWNER role with 403 FORBIDDEN_ROLE', async () => {
    await setStripeState({ stripeAccountId: 'acct_roles', stripeChargesEnabled: true });

    const admin = await prisma.officeUser.create({
      data: {
        organizationId: ctx.organization.id,
        email: 'admin-payments@shape-and-flow.example',
        passwordHash: await testApp.app.get(PasswordService).hash(ADMIN_PASSWORD),
        firstName: 'Test',
        lastName: 'Admin',
        role: OfficeUserRole.ADMIN,
        canIssueRefunds: true,
      },
      select: { id: true, email: true },
    });

    const loginResponse = await login({ email: admin.email, password: ADMIN_PASSWORD }).expect(200);

    const response = await post(cookieFrom(loginResponse)).expect(403);

    expect((response.body as { code: string }).code).toBe('FORBIDDEN_ROLE');
    expect(fakeStripe.accountSessions.create).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const response = await post().expect(401);

    expect((response.body as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(fakeStripe.accountSessions.create).not.toHaveBeenCalled();
  });
});
