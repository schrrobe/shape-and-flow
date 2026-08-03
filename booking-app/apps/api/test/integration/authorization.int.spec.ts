import { Controller, Get, Global, Module, Patch, Post, Req, UseGuards } from '@nestjs/common';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { CsrfHeaderGuard } from '../../src/auth/csrf-header.guard.js';
import { EmployeeScopeService } from '../../src/auth/employee-scope.service.js';
import { CurrentUser, OfficeRoute } from '../../src/auth/office-session.guard.js';
import {
  RefundCapabilityGuard,
  RequiresRefundCapability,
} from '../../src/auth/refund-capability.guard.js';
import { Roles } from '../../src/auth/roles.decorator.js';
import { RolesGuard } from '../../src/auth/roles.guard.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { Audited, recordAuditDetail } from '../../src/common/audit/audit.interceptor.js';
import { AuditModule } from '../../src/common/audit/audit.module.js';
import { correlationMiddleware } from '../../src/common/correlation/correlation.middleware.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { redis } from '../redis.harness.js';

import type { OfficeSession } from '../../src/auth/session.store.js';
import type { OfficeUserRole } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Request } from 'express';
import type { Server } from 'node:http';

/**
 * The enforcement machinery of §10.5, over real HTTP.
 *
 * The routes here are a probe rather than the real `/office` surface, which arrives in
 * tasks 8.3 to 8.5. That is deliberate and not a shortcut: what is under test is the
 * guards, the scope service and the audit interceptor, and a probe declares them exactly
 * the way a real controller will while depending on none of the services those routes
 * need. When the real routes land, the §10.5 matrix is asserted against *them* in this
 * same file, plus a router walk that fails if any of them forgot a decorator.
 *
 * Sessions are minted through SessionStore rather than by logging in. Login has its own
 * suite; going through it here would make an authorization failure look like an
 * authentication failure.
 */

const NOW = new Date('2026-08-10T06:00:00.000Z');
const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

const ROLES: OfficeUserRole[] = ['OWNER', 'ADMIN', 'EMPLOYEE'];

let ctx: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;
let sessions: SessionStore;
let scope: EmployeeScopeService;

/* ── the probe surface ───────────────────────────────────────────────────────── */

/**
 * A controller wired the way every `/office` controller will be.
 *
 * Guard order matters and is the order the real ones use: session, then CSRF, then role,
 * then capability. Anything else answers the wrong question first — a role check on a
 * request with no session has no role to check.
 */
@Controller('office/probe')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
class ProbeOfficeController {
  constructor(private readonly employees: EmployeeScopeService) {}

  @Get('dashboard')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  dashboard(): { ok: true } {
    return { ok: true };
  }

  @Post('bookings')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'BOOKING_CREATED_MANUALLY', entityType: 'Booking' })
  createBooking(): { id: string; customer: { email: string } } {
    // The email is here to prove the audit row redacts what it stores.
    return { id: 'booking-1', customer: { email: 'anna@example.com' } };
  }

  @Post('refunds')
  @Roles('OWNER', 'ADMIN')
  @RequiresRefundCapability()
  @Audited({ action: 'REFUND_ISSUED', entityType: 'Refund' })
  refund(): { id: string; amountCents: number } {
    return { id: 'refund-1', amountCents: 4500 };
  }

  @Patch('settings')
  @Roles('OWNER')
  @Audited({ action: 'SETTINGS_UPDATED', entityType: 'OrganizationSettings' })
  updateSettings(@CurrentUser() session: OfficeSession, @Req() request: Request): { ok: true } {
    recordAuditDetail(request, {
      entityId: session.organizationId,
      summary: 'changed the cancellation window',
      // `email` is on the redaction list and `contactEmail` deliberately is not — the
      // first is a person's address, the second is the business's own, printed on the
      // booking page. The test asserts both halves of that.
      before: { freeCancellationHours: 72, email: 'old@example.com', contactEmail: 'a@b.example' },
      after: { freeCancellationHours: 24, email: 'new@example.com', contactEmail: 'c@d.example' },
    });

    return { ok: true };
  }

  @Post('explodes')
  @Roles('OWNER')
  @Audited({ action: 'SETTINGS_UPDATED', entityType: 'OrganizationSettings' })
  explodes(): never {
    throw new Error('handler exploded');
  }

  /** Guarded but silent about roles — the wiring mistake the guard must not reward. */
  @Post('undeclared')
  undeclared(): { ok: true } {
    return { ok: true };
  }

  @Get('mine')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  mine(@CurrentUser() session: OfficeSession): { filter: unknown } {
    return { filter: this.employees.employeeFilter(session) };
  }
}

// Imports AuthModule for the same reason every real office module will: a guard named in
// `@UseGuards` is constructed in the declaring module's injector, so the module has to be
// able to see it.
@Global()
@Module({ imports: [AuthModule], controllers: [ProbeOfficeController] })
// A Nest module is a declaration carrier with an empty body by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ProbeModule {}

/* ── helpers ─────────────────────────────────────────────────────────────────── */

let userCounter = 0;

/** An office user of one role, and a live session cookie for them. */
async function signedInAs(
  role: OfficeUserRole,
  overrides: { canIssueRefunds?: boolean; employeeId?: string | null } = {},
): Promise<{ cookie: string; officeUserId: string; session: OfficeSession }> {
  userCounter += 1;

  const employeeId =
    overrides.employeeId === undefined
      ? role === 'EMPLOYEE'
        ? ctx.employee1.id
        : null
      : overrides.employeeId;

  const user = await prisma.officeUser.create({
    data: {
      organizationId: ctx.organization.id,
      email: `${role.toLowerCase()}-${String(userCounter)}@shape-and-flow.example`,
      passwordHash: 'placeholder-not-a-credential',
      firstName: 'Test',
      lastName: role,
      role,
      canIssueRefunds: overrides.canIssueRefunds ?? false,
      ...(employeeId === null ? {} : { employeeId }),
    },
    select: { id: true },
  });

  const subject = {
    id: user.id,
    organizationId: ctx.organization.id,
    role,
    canIssueRefunds: overrides.canIssueRefunds ?? false,
    employeeId,
  };

  const sid = await sessions.create(subject);

  return {
    cookie: `sf_office_session=${sid}`,
    officeUserId: user.id,
    session: { ...subject, sid, officeUserId: user.id, createdAt: 0, lastSeenAt: 0 },
  };
}

function call(cookie: string, method: 'get' | 'post' | 'patch', path: string) {
  return request(server())
    [method](path)
    .set('Cookie', cookie)
    .set(...CSRF);
}

/**
 * The error code a synchronous refusal carried.
 *
 * `toThrow` matches messages, and the message here is deliberately uninformative — the
 * code is the assertion worth making.
 */
function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : 'not-an-AppError';
  }

  return 'no-error';
}

async function clearSessions(): Promise<void> {
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  await resetDatabase();
  await clearSessions();

  ctx = await seedOrganization(prisma);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    extraImports: [AuthModule, AuditModule, ProbeModule],
    redis,
    globalPrefix: 'api',
    // Registered with `app.use` rather than as Nest middleware, exactly as main.ts does,
    // so the correlation id an audit row carries is the one a real request would have.
    middleware: [correlationMiddleware],
  });

  server = testApp.server;
  sessions = testApp.app.get(SessionStore);
  scope = testApp.app.get(EmployeeScopeService);

  return testApp.close;
});

/* ── the matrix ──────────────────────────────────────────────────────────────── */

const MATRIX: { method: 'get' | 'post' | 'patch'; path: string; allow: OfficeUserRole[] }[] = [
  { method: 'get', path: 'dashboard', allow: ['OWNER', 'ADMIN', 'EMPLOYEE'] },
  { method: 'post', path: 'bookings', allow: ['OWNER', 'ADMIN'] },
  { method: 'patch', path: 'settings', allow: ['OWNER'] },
];

describe('the role matrix', () => {
  it.each(MATRIX)('$method $path is restricted to $allow', async (row) => {
    for (const role of ROLES) {
      // Refund capability on, so this test measures the role rule and nothing else.
      const { cookie } = await signedInAs(role, { canIssueRefunds: true });
      const response = await call(cookie, row.method, `/api/office/probe/${row.path}`);

      if (row.allow.includes(role)) {
        expect(response.status, `${role} should reach ${row.path}`).not.toBe(403);
      } else {
        expect(response.status, `${role} should be refused ${row.path}`).toBe(403);
        expect((response.body as { code: string }).code).toBe('FORBIDDEN_ROLE');
      }
    }
  });

  it('names no role in the refusal', async () => {
    const { cookie } = await signedInAs('EMPLOYEE');
    const response = await call(cookie, 'patch', '/api/office/probe/settings').expect(403);

    // Saying "OWNER only" would describe the permission model to somebody who has just
    // been refused by it.
    const message = (response.body as { message: string }).message;
    for (const role of ROLES) expect(message).not.toContain(role);
  });

  it('denies a guarded route that declares no roles', async () => {
    const { cookie } = await signedInAs('OWNER', { canIssueRefunds: true });

    // Closed by default, the same direction the global AuthGuard chose: forgetting the
    // decorator produces a 403 on the first request rather than an open endpoint.
    await call(cookie, 'post', '/api/office/probe/undeclared').expect(403);
  });

  it('still refuses without a session, before any role is considered', async () => {
    await request(server())
      .get('/api/office/probe/dashboard')
      .expect(401)
      .expect((response) => {
        expect((response.body as { code: string }).code).toBe('UNAUTHENTICATED');
      });
  });

  it('still enforces CSRF on a route the role allows', async () => {
    const { cookie } = await signedInAs('OWNER', { canIssueRefunds: true });

    await request(server())
      .post('/api/office/probe/bookings')
      .set('Cookie', cookie)
      .expect(403)
      .expect((response) => {
        expect((response.body as { code: string }).code).toBe('CSRF_FAILED');
      });
  });
});

describe('the refund capability', () => {
  it('is required independently of the role', async () => {
    const without = await signedInAs('ADMIN', { canIssueRefunds: false });
    const response = await call(without.cookie, 'post', '/api/office/probe/refunds').expect(403);
    expect((response.body as { code: string }).code).toBe('FORBIDDEN_ROLE');

    const capable = await signedInAs('ADMIN', { canIssueRefunds: true });
    const allowed = await call(capable.cookie, 'post', '/api/office/probe/refunds');
    expect(allowed.status).not.toBe(403);
  });

  it('is implicit for an OWNER, whatever the flag says', async () => {
    // An owner locked out of their own refunds by a flag would be a support call.
    const { cookie } = await signedInAs('OWNER', { canIssueRefunds: false });

    const response = await call(cookie, 'post', '/api/office/probe/refunds');
    expect(response.status).not.toBe(403);
  });

  it('does not let the capability substitute for the role', async () => {
    const { cookie } = await signedInAs('EMPLOYEE', { canIssueRefunds: true });

    // The matrix says employees do not issue refunds at all; the capability is a
    // narrowing of ADMIN, not a widening of EMPLOYEE.
    await call(cookie, 'post', '/api/office/probe/refunds').expect(403);
  });
});

describe('employee scope', () => {
  it('lets an unscoped role see everyone', async () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      const { cookie } = await signedInAs(role);
      const response = await call(cookie, 'get', '/api/office/probe/mine').expect(200);

      expect((response.body as { filter: unknown }).filter).toEqual({});
    }
  });

  it('narrows an EMPLOYEE to their own id', async () => {
    const { cookie } = await signedInAs('EMPLOYEE', { employeeId: ctx.employee1.id });
    const response = await call(cookie, 'get', '/api/office/probe/mine').expect(200);

    expect((response.body as { filter: unknown }).filter).toEqual({
      employeeId: { in: [ctx.employee1.id] },
    });
  });

  it('answers NOT_FOUND, not FORBIDDEN, for a colleague', async () => {
    const { session } = await signedInAs('EMPLOYEE', { employeeId: ctx.employee1.id });

    // A 403 would confirm the id exists and belongs to somebody — which is exactly what
    // an employee must not be able to enumerate.
    expect(
      refusalCode(() => {
        scope.assertMayAccessEmployee(session, ctx.employee2.id);
      }),
    ).toBe('NOT_FOUND');
    expect(
      refusalCode(() => {
        scope.assertMayAccessEmployee(session, ctx.employee1.id);
      }),
    ).toBe('no-error');
  });

  it('lets an unscoped role reach any employee', async () => {
    const { session } = await signedInAs('ADMIN');

    expect(
      refusalCode(() => {
        scope.assertMayAccessEmployee(session, ctx.employee2.id);
      }),
    ).toBe('no-error');
  });

  it('refuses an EMPLOYEE with no linked employee rather than showing them everything', async () => {
    const { session } = await signedInAs('EMPLOYEE', { employeeId: null });

    // The dangerous reading of "no employee id" is "no filter".
    expect(refusalCode(() => scope.visibleEmployeeIds(session))).toBe('FORBIDDEN_ROLE');
  });
});

describe('the audit trail', () => {
  it('writes one row naming the actor, the action and the correlation id', async () => {
    const owner = await signedInAs('OWNER', { canIssueRefunds: true });

    await call(owner.cookie, 'post', '/api/office/probe/bookings').expect(201);

    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: ctx.organization.id,
      officeUserId: owner.officeUserId,
      action: 'BOOKING_CREATED_MANUALLY',
      entityType: 'Booking',
      // Resolved from the response body, which is where a created id lives.
      entityId: 'booking-1',
    });
    expect(rows[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]?.ipAddress).not.toBeNull();
  });

  it('redacts what it stores', async () => {
    const owner = await signedInAs('OWNER');
    await call(owner.cookie, 'post', '/api/office/probe/bookings').expect(201);

    const row = await prisma.auditLog.findFirstOrThrow({});

    // An audit row is read by name and kept for years; it must not become the place a
    // customer's address outlives its deletion.
    expect(JSON.stringify(row.after)).not.toContain('anna@example.com');
    expect(JSON.stringify(row.after)).toContain('[Redacted]');
    // The shape survives, so the row still says an address was involved.
    expect(JSON.stringify(row.after)).toContain('email');
  });

  it('records what only the handler could know', async () => {
    const owner = await signedInAs('OWNER');

    await call(owner.cookie, 'patch', '/api/office/probe/settings').expect(200);

    const row = await prisma.auditLog.findFirstOrThrow({});
    expect(row.summary).toBe('changed the cancellation window');
    expect(row.entityId).toBe(ctx.organization.id);
    expect(row.before).toMatchObject({ freeCancellationHours: 72 });
    expect(row.after).toMatchObject({ freeCancellationHours: 24 });

    // Redaction reaches the handler's own values too, not just the response body.
    expect(JSON.stringify(row.before)).not.toContain('old@example.com');
    // But the business's own contact address survives, because hiding it would remove
    // exactly the detail an owner reviewing "who changed our contact address" needs.
    expect(row.before).toMatchObject({ contactEmail: 'a@b.example' });
  });

  it('writes nothing when the handler failed', async () => {
    const owner = await signedInAs('OWNER');

    await call(owner.cookie, 'post', '/api/office/probe/explodes').expect(500);

    // A trace of something that did not happen is worse than no trace.
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('writes nothing for a route that declares no action', async () => {
    const owner = await signedInAs('OWNER');

    await call(owner.cookie, 'get', '/api/office/probe/dashboard').expect(200);

    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('writes the row before the response reaches the caller', async () => {
    const owner = await signedInAs('OWNER');

    await call(owner.cookie, 'post', '/api/office/probe/bookings').expect(201);

    // No wait, no polling: a trace that lands after the caller has acted on the answer
    // can be missing during exactly the window somebody is looking for it.
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('attributes each action to the user who performed it', async () => {
    const first = await signedInAs('OWNER');
    const second = await signedInAs('OWNER');

    await call(first.cookie, 'post', '/api/office/probe/bookings').expect(201);
    await call(second.cookie, 'patch', '/api/office/probe/settings').expect(200);

    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => row.officeUserId)).toEqual([first.officeUserId, second.officeUserId]);
  });
});
