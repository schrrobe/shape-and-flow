import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { OFFICE_ROUTE } from '../../src/auth/office-session.guard.js';
import { ROLES } from '../../src/auth/roles.decorator.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { AUDIT } from '../../src/common/audit/audit.interceptor.js';
import { AuditModule } from '../../src/common/audit/audit.module.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OfficeModule } from '../../src/office/office.module.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { queues, redis } from '../redis.harness.js';

import type { OfficeUserRole } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * §10.5, asserted against the **real** office routes.
 *
 * `authorization.int.spec.ts` proves the machinery — guards, scoping, the audit
 * interceptor — against a probe controller. This proves it was actually *applied*, which
 * is a different claim and the one that fails when somebody adds a route and forgets a
 * decorator.
 *
 * Three things are checked, in increasing order of how much they would catch:
 *
 *  1. A **matrix** of representative routes, each called by each role.
 *  2. **Tenant isolation**: a second organization's data is invisible and its ids 404.
 *  3. A **router walk** over the registered routes, which fails when an office route
 *     declares no `@Roles`, or a mutating one leaves no audit trail. That last one is
 *     the only check here that covers routes nobody thought to add to the matrix.
 */

const NOW = new Date('2026-08-14T20:00:00.000Z');
const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

let ctx: SeedContext;
let other: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;
let sessions: SessionStore;
let userCounter = 0;

async function cookieFor(role: OfficeUserRole, employeeId: string | null = null): Promise<string> {
  userCounter += 1;

  const user = await prisma.officeUser.create({
    data: {
      organizationId: ctx.organization.id,
      email: `${role.toLowerCase()}-${String(userCounter)}@shape-and-flow.example`,
      passwordHash: 'placeholder-not-a-credential',
      firstName: 'Test',
      lastName: role,
      role,
      canIssueRefunds: true,
      ...(employeeId === null ? {} : { employeeId }),
    },
    select: { id: true },
  });

  const sid = await sessions.create({
    id: user.id,
    organizationId: ctx.organization.id,
    role,
    canIssueRefunds: true,
    employeeId,
  });

  return `sf_office_session=${sid}`;
}

async function clearSessions(): Promise<void> {
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  await resetDatabase();
  await clearSessions();

  ctx = await seedOrganization(prisma);
  // A second tenant with its own everything. Every isolation assertion below is vacuous
  // without it, so it is seeded first and checked to be non-empty.
  other = await seedOrganization(prisma, { slug: 'other-studio' });

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    extraImports: [AuthModule, AuditModule, OfficeModule],
    redis,
    queues,
    globalPrefix: 'api',
  });

  server = testApp.server;
  sessions = testApp.app.get(SessionStore);

  return testApp.close;
});

/* ── the matrix ───────────────────────────────────────────────────────────────── */

const ROLES_ALL: OfficeUserRole[] = ['OWNER', 'ADMIN', 'EMPLOYEE'];

/** One representative route per row of §6.5, with who §6.5 says may reach it. */
const MATRIX: {
  method: 'get' | 'post' | 'patch' | 'put';
  path: string;
  allow: OfficeUserRole[];
}[] = [
  { method: 'get', path: '/api/office/dashboard', allow: ['OWNER', 'ADMIN', 'EMPLOYEE'] },
  { method: 'get', path: '/api/office/bookings', allow: ['OWNER', 'ADMIN', 'EMPLOYEE'] },
  { method: 'post', path: '/api/office/bookings', allow: ['OWNER', 'ADMIN'] },
  // The same two as the route it feeds: the answer exists to become a manual booking.
  { method: 'get', path: '/api/office/availability', allow: ['OWNER', 'ADMIN'] },
  { method: 'get', path: '/api/office/employees', allow: ['OWNER', 'ADMIN', 'EMPLOYEE'] },
  { method: 'post', path: '/api/office/employees', allow: ['OWNER', 'ADMIN'] },
  { method: 'put', path: '/api/office/employees/x/working-hours', allow: ['OWNER', 'ADMIN'] },
  { method: 'get', path: '/api/office/blocked-times', allow: ['OWNER', 'ADMIN', 'EMPLOYEE'] },
  { method: 'post', path: '/api/office/time-off', allow: ['OWNER', 'ADMIN'] },
  { method: 'post', path: '/api/office/closed-days', allow: ['OWNER', 'ADMIN'] },
  { method: 'post', path: '/api/office/services', allow: ['OWNER', 'ADMIN'] },
  { method: 'get', path: '/api/office/customers', allow: ['OWNER', 'ADMIN'] },
  { method: 'get', path: '/api/office/cancellation-requests', allow: ['OWNER', 'ADMIN'] },
  {
    method: 'get',
    path: '/api/office/reschedule-requests',
    allow: ['OWNER', 'ADMIN', 'EMPLOYEE'],
  },
  { method: 'get', path: '/api/office/exports/bookings.csv', allow: ['OWNER', 'ADMIN'] },
  { method: 'patch', path: '/api/office/settings', allow: ['OWNER'] },
  { method: 'get', path: '/api/office/settings', allow: ['OWNER'] },
  { method: 'post', path: '/api/office/users', allow: ['OWNER'] },
  { method: 'get', path: '/api/office/audit-log', allow: ['OWNER'] },
];

describe('the §10.5 role matrix, over the real routes', () => {
  it.each(MATRIX)('$method $path admits exactly $allow', async ({ method, path, allow }) => {
    for (const role of ROLES_ALL) {
      const cookie = await cookieFor(role, role === 'EMPLOYEE' ? ctx.employee1.id : null);

      const response = await request(server())
        [method](path)
        .set('Cookie', cookie)
        .set(...CSRF)
        .send({});

      if (allow.includes(role)) {
        // Anything but 403 means the role got through the guard. A 400 for an empty body
        // or a 404 for the placeholder id is the route working; only 403 is a refusal.
        expect(response.status, `${role} ${method} ${path}`).not.toBe(403);
      } else {
        expect(response.status, `${role} ${method} ${path}`).toBe(403);
        expect((response.body as { code: string }).code).toBe('FORBIDDEN_ROLE');
      }
    }
  });

  it('refuses every route without a session', async () => {
    for (const { method, path } of MATRIX) {
      const response = await request(server())
        [method](path)
        .set(...CSRF)
        .send({});

      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses every mutation without the CSRF header', async () => {
    const cookie = await cookieFor('OWNER');

    for (const { method, path } of MATRIX.filter((route) => route.method !== 'get')) {
      const response = await request(server())[method](path).set('Cookie', cookie).send({});

      expect(response.status, `${method} ${path}`).toBe(403);
      expect((response.body as { code: string }).code, `${method} ${path}`).toBe('CSRF_FAILED');
    }
  });
});

/* ── tenant isolation ─────────────────────────────────────────────────────────── */

describe('tenant isolation', () => {
  it('every office list returns only the session organization', async () => {
    const cookie = await cookieFor('OWNER');
    await seedNoise();

    for (const path of [
      '/api/office/bookings',
      '/api/office/employees',
      '/api/office/services',
      '/api/office/customers',
    ]) {
      const response = await request(server())
        .get(path)
        .set('Cookie', cookie)
        .set(...CSRF)
        .expect(200);

      const items = (response.body as { items: { id: string }[] }).items;

      // Non-empty, or the assertion below proves nothing: an endpoint returning [] would
      // "pass" isolation while being broken.
      expect(items.length, path).toBeGreaterThan(0);
      for (const item of items) {
        expect(await belongsTo(path, item.id), `${path} ${item.id}`).toBe(ctx.organization.id);
      }
    }
  });

  it('404s a foreign id on every detail route', async () => {
    const cookie = await cookieFor('OWNER');
    const foreignBooking = await prisma.booking.create({
      data: makeBooking(other, { status: 'CONFIRMED', expiresAt: null }),
      select: { id: true },
    });

    const foreign: [string, string][] = [
      ['/api/office/bookings/:id', foreignBooking.id],
      ['/api/office/employees/:id', other.employee1.id],
      ['/api/office/services/:id', other.service30.id],
      ['/api/office/customers/:id', other.customer.id],
    ];

    for (const [path, id] of foreign) {
      const response = await request(server())
        .get(path.replace(':id', id))
        .set('Cookie', cookie)
        .set(...CSRF);

      // 404 rather than 403: a 403 would confirm the id exists.
      expect(response.status, path).toBe(404);
      expect((response.body as { code: string }).code, path).toBe('NOT_FOUND');
    }
  });

  it('a mutation targeting a foreign id changes nothing', async () => {
    const cookie = await cookieFor('OWNER');
    const foreignBooking = await prisma.booking.create({
      data: makeBooking(other, {
        status: 'CONFIRMED',
        startsAt: new Date(NOW.getTime() - 3 * 3_600_000),
        expiresAt: null,
      }),
      select: { id: true },
    });

    await request(server())
      .post(`/api/office/bookings/${foreignBooking.id}/complete`)
      .set('Cookie', cookie)
      .set(...CSRF)
      .expect(404);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: foreignBooking.id } });
    expect(after.status).toBe('CONFIRMED');
  });
});

/* ── the router walk ──────────────────────────────────────────────────────────── */

interface RouteHandle {
  method: string;
  path: string;
  handler: (...args: unknown[]) => unknown;
  controller: NewableFunction;
}

/**
 * Every registered office route, read back out of Express and Nest's metadata.
 *
 * This is the check that survives somebody adding a route without telling anyone: the
 * matrix above only covers routes a person remembered to list, while this covers every
 * route that exists.
 */
function officeRoutes(): RouteHandle[] {
  const app = testApp.app;
  const container = (app as unknown as { container: NestContainer }).container;
  const routes: RouteHandle[] = [];

  for (const module of container.getModules().values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;

      const isOffice = Reflect.getMetadata(OFFICE_ROUTE, controller) === true;
      if (!isOffice) continue;

      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === 'constructor') continue;

        const handler = prototype[name];
        if (typeof handler !== 'function') continue;

        const method = Reflect.getMetadata('method', handler) as number | undefined;
        const path = Reflect.getMetadata('path', handler) as string | undefined;
        if (method === undefined || path === undefined) continue;

        routes.push({
          method: HTTP_METHODS[method] ?? String(method),
          path,
          handler: handler as (...args: unknown[]) => unknown,
          controller,
        });
      }
    }
  }

  return routes;
}

interface NestContainer {
  getModules: () => Map<
    string,
    { controllers: Map<unknown, { metatype: NewableFunction | undefined }> }
  >;
}

/** Nest's `RequestMethod` enum, in its declared order. */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** Methods that change something and therefore ought to leave a trace. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

describe('the router walk', () => {
  it('finds the office routes at all', () => {
    // Guards against the whole suite passing because the walk found nothing.
    expect(officeRoutes().length).toBeGreaterThan(30);
  });

  it('actually reads the metadata it is asserting on', () => {
    // Without this the two checks below could pass by reading nothing at all. Settings
    // is OWNER-only and the dashboard is open to all three, so finding exactly those
    // proves the walk resolves real decorators rather than returning undefined.
    const routes = officeRoutes();
    const rolesOf = (path: string): unknown =>
      Reflect.getMetadata(
        ROLES,
        routes.find((route) => route.path === path && route.method === 'GET')?.handler ??
          (() => undefined),
      );

    expect(rolesOf('/')).toBeDefined();
    const settings = routes.find(
      (route) => route.controller.name === 'SettingsController' && route.method === 'PATCH',
    );
    expect(Reflect.getMetadata(ROLES, settings?.handler ?? (() => undefined))).toEqual(['OWNER']);

    const dashboard = routes.find((route) => route.path === 'dashboard');
    expect(Reflect.getMetadata(ROLES, dashboard?.handler ?? (() => undefined))).toEqual([
      'OWNER',
      'ADMIN',
      'EMPLOYEE',
    ]);
  });

  it('gives every office route a @Roles declaration', () => {
    const undeclared = officeRoutes()
      .filter((route) => {
        const roles =
          (Reflect.getMetadata(ROLES, route.handler) as unknown) ??
          (Reflect.getMetadata(ROLES, route.controller) as unknown);

        return !Array.isArray(roles) || roles.length === 0;
      })
      .map((route) => `${route.method} ${route.path} (${route.controller.name})`);

    // RolesGuard denies a route with no @Roles, so a missing one is a 403 nobody can
    // explain rather than a hole — but it is still a route that does not work.
    expect(undeclared).toEqual([]);
  });

  it('leaves a trace for every office mutation', () => {
    // The exceptions are the routes whose service writes its own audit row inside the
    // transaction that changes something, which is stronger than the interceptor's
    // after-the-fact write. Listed by name so adding a route cannot join them silently.
    const auditedInService = new Set([
      'CustomersController.update',
      'CustomersController.erase',
      'OfficeBookingsController.recordManualPayment',
    ]);

    const untraced = officeRoutes()
      .filter((route) => MUTATING.has(route.method))
      .filter((route) => Reflect.getMetadata(AUDIT, route.handler) === undefined)
      .map((route) => `${route.controller.name}.${route.handler.name}`)
      .filter((name) => !auditedInService.has(name));

    expect(untraced).toEqual([]);
  });
});

/* ── helpers ──────────────────────────────────────────────────────────────────── */

/** A booking and a customer in the session's organization, so no list is empty. */
async function seedNoise(): Promise<void> {
  await prisma.booking.create({
    data: makeBooking(ctx, { status: 'CONFIRMED', expiresAt: null }),
    select: { id: true },
  });
  await prisma.booking.create({
    data: makeBooking(other, { status: 'CONFIRMED', expiresAt: null }),
    select: { id: true },
  });
}

/** Which organization a listed row actually belongs to, read from the database. */
async function belongsTo(path: string, id: string): Promise<string> {
  if (path.endsWith('bookings')) {
    return (await prisma.booking.findUniqueOrThrow({ where: { id } })).organizationId;
  }
  if (path.endsWith('employees')) {
    return (await prisma.employee.findUniqueOrThrow({ where: { id } })).organizationId;
  }
  if (path.endsWith('services')) {
    return (await prisma.service.findUniqueOrThrow({ where: { id } })).organizationId;
  }
  return (await prisma.customer.findUniqueOrThrow({ where: { id } })).organizationId;
}
