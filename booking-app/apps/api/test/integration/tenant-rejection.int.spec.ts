import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionStore } from '../../src/auth/session.store.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OfficeTenantMiddleware } from '../../src/organization/office-tenant.middleware.js';
import { TenantResolutionMiddleware } from '../../src/organization/tenant-resolution.middleware.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { connectRedis, redis } from '../redis.harness.js';
import { TENANT_RESOLUTION_CONFIG } from '../test-config.module.js';

import type { AppConfig } from '../../src/config/env.schema.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * Both `TenantResolutionMiddleware` and `OfficeTenantMiddleware` now reject an
 * offered-but-invalid identity instead of falling through to the bootstrap
 * default (see their own spec files for the branch matrix). Both are mounted
 * with a raw `app.use()` in main.ts, outside Nest's own routing — which raised
 * a question a direct-invocation unit test structurally cannot answer: does
 * the thrown `AppError` still reach a client as the documented error envelope,
 * or does it leak whatever Express's own default error page produces?
 *
 * It reaches the client correctly. `RoutesResolver.registerExceptionHandler()`
 * (`@nestjs/core/router/routes-resolver.js`) installs its own catch-all 4-arg
 * Express error handler at the end of `registerRouter()`, applied to the whole
 * adapter via `applicationRef.setErrorHandler(proxy, prefix)` — and for the
 * Express adapter specifically, that prefix argument is ignored:
 * `setErrorHandler(handler, prefix) { return this.use(handler); }`
 * (`@nestjs/platform-express/adapters/express-adapter.js`). Because that
 * handler is registered last, after every route and every raw-mounted
 * middleware in the stack, Express routes any `next(err)` — including the one
 * Express 5 synthesises from a rejected promise — to it regardless of whether
 * the throwing middleware was ever wrapped by `RouterProxy`. It forwards the
 * error unchanged (`mapExternalException`'s default case is `return err`) into
 * the same `ExceptionsHandler` that consults the `APP_FILTER` — the very
 * `GlobalExceptionFilter` these two middlewares' errors were suspected of
 * bypassing. This suite exists to prove that, not to fix a gap: closing the
 * coverage hole the review correctly flagged (no test exercised the reject
 * path at the HTTP layer), without touching production code that already
 * behaves correctly.
 *
 * The two middlewares are wired here exactly the way `main.ts` wires them —
 * mounted via `app.use(prefix, handler)` at `/api/public` and `/api/office`
 * respectively (the harness's `middleware` option accepts a `[prefix, handler]`
 * pair for exactly this reason, rather than this suite reimplementing Express's
 * own path scoping), constructed directly rather than resolved from Nest's
 * container, mirroring `organization-registration.int.spec.ts`'s own
 * justification for doing the same with `TenantResolutionMiddleware` alone.
 */
const NOW = new Date('2026-08-14T09:00:00.000Z');

const officeConfig = {
  SESSION_COOKIE_NAME: 'sf_office_session',
  SESSION_IDLE_TTL_MINUTES: 60,
  SESSION_ABSOLUTE_TTL_MINUTES: 10_080,
} as unknown as AppConfig;

let ctx: SeedContext;
let sessions: SessionStore;
let testApp: BookingTestApp;
let server: () => Server;

beforeEach(async () => {
  await resetDatabase();
  await connectRedis();
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);

  ctx = await seedOrganization(prisma);

  // Built directly rather than resolved from a container: SessionStore's only
  // dependencies are a Redis client, a clock, and config, all of which the harness
  // already has to hand — matching how TenantResolutionMiddleware is constructed
  // directly in organization-registration.int.spec.ts.
  sessions = new SessionStore(redis, officeConfig, new FixedClock(NOW));

  const tenantResolution = new TenantResolutionMiddleware(prisma, TENANT_RESOLUTION_CONFIG);
  const officeTenant = new OfficeTenantMiddleware(sessions, prisma, officeConfig);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    globalPrefix: 'api',
    middleware: [
      ['/api/public', tenantResolution.middleware],
      ['/api/office', officeTenant.middleware],
    ],
  });
  server = testApp.server;
  return testApp.close;
});

describe('an offered-but-invalid tenant identity, at the HTTP layer', () => {
  it('answers the documented envelope, not a bare error page, when ?organizer= names no organization', async () => {
    const response = await request(server()).get('/api/public/does-not-matter?organizer=ghost-org');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
    expect(typeof (response.body as { correlationId?: unknown }).correlationId).toBe('string');
  });

  it('answers the documented envelope when the session names an organization that no longer resolves', async () => {
    const sid = await sessions.create({
      id: 'ghost-office-user',
      organizationId: 'org-does-not-exist',
      role: 'OWNER',
      canIssueRefunds: true,
      employeeId: null,
    });

    const response = await request(server())
      .get('/api/office/does-not-matter')
      .set('Cookie', `${officeConfig.SESSION_COOKIE_NAME}=${sid}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
    expect(typeof (response.body as { correlationId?: unknown }).correlationId).toBe('string');
  });
});
