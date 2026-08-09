import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OrganizationRegistrationController } from '../../src/organization/organization-registration.controller.js';
import { OrganizationRegistrationService } from '../../src/organization/organization-registration.service.js';
import { StripeConnectService } from '../../src/organization/stripe-connect.service.js';
import { TenantResolutionMiddleware } from '../../src/organization/tenant-resolution.middleware.js';
import { STRIPE_CLIENT } from '../../src/providers/providers.module.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { connectRedis, redis } from '../redis.harness.js';

import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type {
  RegisterOrganizationResponse,
  ServiceListResponse,
} from '@shape-and-flow/booking-contracts';
import type { Server } from 'node:http';

/**
 * `POST /api/public/organizations`, the full public self-service registration
 * flow (Task 6): an anonymous caller creates an Organization, an owner
 * OfficeUser, and is logged in immediately via the session cookie the endpoint
 * sets, with no separate login step.
 *
 * This suite wires a small ad-hoc module around `OrganizationRegistrationController`
 * rather than importing the real `OrganizationModule` wholesale, mirroring
 * `organization-onboarding.int.spec.ts`'s own documented reasoning: `OrganizationModule`
 * also declares `OrganizationContextService` and `TENANT_PRISMA`, both of which the
 * booking test harness already substitutes with its own stand-ins (`BookingTestHarnessModule`
 * is itself `@Global()`), and both modules being `@Global()` while providing the same
 * tokens leaves it to Nest's internal resolution order which instance wins -- exactly the
 * kind of ambiguity worth avoiding rather than depending on. The registration path itself
 * never touches `OrganizationContextService` or `TENANT_PRISMA` (`OrganizationRegistrationService`
 * only injects `PrismaService`, `PasswordService`, `SessionStore`, `StripeConnectService` and
 * `ENV`), so nothing here needs the full module.
 *
 * `STRIPE_CLIENT` is not provided anywhere in `createBookingTestApp`'s module graph --
 * `ProvidersModule`, which owns it in production, is only imported by the real `AppModule`
 * and `WorkerModule`, never by `BookingModule`/`PublicModule`. This suite supplies `null`
 * directly, which is exactly what `ProvidersModule`'s own factory would produce given the
 * harness's `PAYMENT_PROVIDER: 'fake'` config -- so `onboardingLink: null` on every
 * registration here is the accurate, by-design behavior (Task 6: organization creation
 * never rolls back on a later Stripe failure), not a gap being routed around.
 *
 * `TenantResolutionMiddleware` is instantiated directly (it depends on `PrismaService`
 * alone) and mounted the same way `main.ts` mounts it in production -- scoped to
 * `/api/public` -- via the harness's `middleware` option, so the "resolves by
 * `?organizer=<slug>`" case exercises the real middleware, not a stand-in for it.
 */

const NOW = new Date('2026-08-14T09:00:00.000Z');

@Module({
  imports: [
    AuthModule,
    // Real, Redis-backed throttler storage -- wired the same way ThrottlingModule wires
    // it in production (same default bucket, same storage class), just handed the
    // `redis` connection this file already imports rather than resolving it through DI.
    // `createBookingTestApp`'s own harness module deliberately does not register a
    // ThrottlerGuard (see public-app.harness.ts's note that `@Throttle` is inert there
    // as a result), so the new rate-limit test below needs its own, registered as an
    // additional `APP_GUARD` alongside the harness's `AuthGuard`.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      storage: new ThrottlerStorageRedisService(redis),
    }),
  ],
  controllers: [OrganizationRegistrationController],
  providers: [
    OrganizationRegistrationService,
    StripeConnectService,
    { provide: STRIPE_CLIENT, useValue: null },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
// Nest module declaration: an empty body by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class RegistrationProbeModule {}

let ctx: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;

/** Supertest types a response body as `any`; the registration endpoint's shape is known. */
function registered(res: { body: unknown }): RegisterOrganizationResponse {
  return res.body as RegisterOrganizationResponse;
}

/** Same, for the public services list the tenant-resolution case reads back. */
function services(res: { body: unknown }): ServiceListResponse {
  return res.body as ServiceListResponse;
}

async function clearSessions(): Promise<void> {
  await connectRedis();
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);
}

/**
 * The throttler's Redis keys, not the session's.
 *
 * `ThrottlerStorageRedisService` keys are content-addressed from the controller class
 * name, the handler name, the throttler name, and the tracker (the caller's IP) --
 * deterministic across tests, since every request in this file comes from the same
 * local supertest connection to the same handler. Left uncleared, hits from earlier
 * tests in this file would count against the rate-limit test's own budget before it
 * sends a single request of its own.
 */
async function clearThrottleState(): Promise<void> {
  await connectRedis();
  const keys = [...(await redis.keys('{*}:hits')), ...(await redis.keys('{*}:blocked'))];
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  await resetDatabase();
  await clearSessions();
  await clearThrottleState();

  ctx = await seedOrganization(prisma);

  const tenantResolution = new TenantResolutionMiddleware(prisma);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    extraImports: [RegistrationProbeModule],
    redis,
    globalPrefix: 'api',
    // The `[prefix, handler]` form, not a hand-rolled path check: it mounts via
    // `app.use(prefix, handler)`, the same call `main.ts` makes and the same one
    // `tenant-rejection.int.spec.ts` relies on for Express 5 to turn a middleware
    // rejection into `next(err)` on its own. A bare `RequestHandler` wrapping a
    // `void`-called async middleware — the previous shape here — discarded that
    // promise instead, so a rejection would have become an unhandled one rather
    // than reaching the `GlobalExceptionFilter`.
    middleware: [['/api/public', tenantResolution.middleware]],
  });
  server = testApp.server;

  return testApp.close;
});

describe('POST /api/public/organizations', () => {
  it('registers an INDIVIDUAL organizer, creates the owner, and logs them in', async () => {
    const res = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        entityType: 'INDIVIDUAL',
        displayName: 'Acme Studio',
        email: 'owner@example.com',
        password: 'Correct-Horse-Battery-9',
        firstName: 'Jane',
        lastName: 'Doe',
        contactPhone: '+49 30 1234567',
        addressLine1: 'Musterstraße 1',
        postalCode: '10115',
        city: 'Berlin',
        country: 'DE',
      });

    expect(res.status).toBe(201);
    expect(registered(res).slug).toBe('acme-studio');
    // STRIPE_CLIENT is wired to null in this suite (see module doc comment above),
    // so a real Stripe call is impossible here -- the endpoint must still return
    // 201 with onboardingLink: null rather than rolling back or erroring.
    expect(registered(res).onboardingLink).toBeNull();
    expect(res.headers['set-cookie']).toBeDefined();

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { slug: 'acme-studio' },
    });
    expect(organization.entityType).toBe('INDIVIDUAL');

    const owner = await prisma.officeUser.findFirstOrThrow({
      where: { organizationId: organization.id },
    });
    expect(owner.email).toBe('owner@example.com');
    expect(owner.role).toBe('OWNER');
  });

  it('registers a SOLE_PROPRIETORSHIP organizer with a company name and owner name', async () => {
    const res = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        entityType: 'SOLE_PROPRIETORSHIP',
        displayName: 'Solo Studio',
        companyName: 'Solo Studio e.K.',
        email: 'solo@example.com',
        password: 'Correct-Horse-Battery-9',
        firstName: 'Max',
        lastName: 'Mustermann',
        contactPhone: '+49 30 7654321',
        addressLine1: 'Beispielweg 5',
        postalCode: '10117',
        city: 'Berlin',
        country: 'DE',
      });

    expect(res.status).toBe(201);
    expect(registered(res).slug).toBe('solo-studio');
    expect(res.headers['set-cookie']).toBeDefined();

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { slug: 'solo-studio' },
    });
    expect(organization.entityType).toBe('SOLE_PROPRIETORSHIP');
    expect(organization.legalName).toBe('Solo Studio e.K.');
  });

  it('retries the slug on collision', async () => {
    const first = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        entityType: 'INDIVIDUAL',
        displayName: 'Acme Studio',
        email: 'first@example.com',
        password: 'Correct-Horse-Battery-9',
        firstName: 'Jane',
        lastName: 'Doe',
        contactPhone: '+49 30 1234567',
        addressLine1: 'Musterstraße 1',
        postalCode: '10115',
        city: 'Berlin',
        country: 'DE',
      });

    const res = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        entityType: 'INDIVIDUAL',
        displayName: 'Acme Studio',
        email: 'second@example.com',
        password: 'Correct-Horse-Battery-9',
        firstName: 'John',
        lastName: 'Smith',
        contactPhone: '+49 30 1234567',
        addressLine1: 'Musterstraße 2',
        postalCode: '10115',
        city: 'Berlin',
        country: 'DE',
      });

    expect(first.status).toBe(201);
    expect(res.status).toBe(201);
    expect(registered(res).slug).not.toBe('acme-studio');
    expect(registered(res).slug).toMatch(/^acme-studio-/);
  });

  it('rejects a second registration with an already-registered email as 409 EMAIL_ALREADY_REGISTERED', async () => {
    const first = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        entityType: 'INDIVIDUAL',
        displayName: 'Acme Studio',
        email: 'owner@example.com',
        password: 'Correct-Horse-Battery-9',
        firstName: 'Jane',
        lastName: 'Doe',
        contactPhone: '+49 30 1234567',
        addressLine1: 'Musterstraße 1',
        postalCode: '10115',
        city: 'Berlin',
        country: 'DE',
      });
    expect(first.status).toBe(201);

    // A different studio, a different slug, but the same email -- the global unique
    // index on office_users.email is what this is proving against, not a slug collision.
    const res = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        entityType: 'INDIVIDUAL',
        displayName: 'Different Studio',
        email: 'owner@example.com',
        password: 'Another-Correct-1',
        firstName: 'John',
        lastName: 'Smith',
        contactPhone: '+49 30 7654321',
        addressLine1: 'Beispielweg 5',
        postalCode: '10117',
        city: 'Berlin',
        country: 'DE',
      });

    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('EMAIL_ALREADY_REGISTERED');

    // Rejected, not merely errored: no second organization was created for the attempt.
    expect(await prisma.organization.count({ where: { slug: 'different-studio' } })).toBe(0);
  });

  it('resolves the public catalog to the newly registered organization via ?organizer=<slug>', async () => {
    const created = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        entityType: 'ORGANIZATION',
        displayName: 'Second Org',
        companyName: 'Second Org GmbH',
        email: 'owner2@example.com',
        password: 'Correct-Horse-Battery-9',
        contactPhone: '+49 30 1234567',
        addressLine1: 'Musterstraße 3',
        postalCode: '10115',
        city: 'Berlin',
        country: 'DE',
      });

    expect(created.status).toBe(201);

    // The default (seeded) organization has two bookable services. A request
    // scoped to the freshly registered organization -- which has none yet --
    // proves tenant resolution actually switched context rather than merely
    // succeeding against the default organization's own catalog.
    const res = await request(server()).get(
      `/api/public/services?organizer=${registered(created).slug}`,
    );

    expect(res.status).toBe(200);
    expect(services(res).items).toEqual([]);
  });

  it('rejects registration without the CSRF header', async () => {
    const res = await request(server()).post('/api/public/organizations').send({
      entityType: 'INDIVIDUAL',
      displayName: 'No CSRF Studio',
      email: 'nocsrf@example.com',
      password: 'Correct-Horse-Battery-9',
      firstName: 'Jane',
      lastName: 'Doe',
      contactPhone: '+49 30 1234567',
      addressLine1: 'Musterstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    });

    expect(res.status).toBe(403);
  });

  it('rate-limits registration to 5 per hour per IP', async () => {
    const body = (n: number) => ({
      entityType: 'INDIVIDUAL',
      displayName: `Rate Studio ${String(n)}`,
      email: `rate${String(n)}@example.com`,
      password: 'Correct-Horse-Battery-9',
      firstName: 'Jane',
      lastName: 'Doe',
      contactPhone: '+49 30 1234567',
      addressLine1: 'Musterstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(server())
        .post('/api/public/organizations')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send(body(i));
      expect(res.status).toBe(201);
    }

    const sixth = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send(body(5));

    expect(sixth.status).toBe(429);
  });
});
