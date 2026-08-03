import { Controller, Get, Module } from '@nestjs/common';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { CLOCK } from '../../src/domain/time/clock.js';
import { PublicModule } from '../../src/public/public.module.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { BERLIN, seedOrganization } from '../factories/index.js';
import { createPublicTestApp, loadOrganization } from '../public-app.harness.js';

import type { Clock } from '../../src/domain/time/clock.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

const NOW = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let server: () => Server;

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);

  const testApp = await createPublicTestApp({
    organization: await loadOrganization(ctx.organization.id),
    now: NOW,
    imports: [PublicModule],
  });

  server = testApp.server;
  return testApp.close;
});

describe('GET /public/organizations/current', () => {
  it('keeps organization, clock, and query count isolated between two live apps', async () => {
    const other = await seedOrganization(prisma, { slug: 'other-studio' });
    const firstNow = new Date('2026-08-10T06:00:00.000Z');
    const secondNow = new Date('2026-09-10T06:00:00.000Z');
    const first = await createPublicTestApp({
      organization: await loadOrganization(ctx.organization.id),
      now: firstNow,
      imports: [PublicModule],
    });
    const second = await createPublicTestApp({
      organization: await loadOrganization(other.organization.id),
      now: secondNow,
      imports: [PublicModule],
    });

    try {
      const firstResponse = await request(first.server())
        .get('/public/organizations/current')
        .expect(200);
      const secondResponse = await request(second.server())
        .get('/public/organizations/current')
        .expect(200);
      expect(firstResponse.body).toMatchObject({ id: ctx.organization.id });
      expect(secondResponse.body).toMatchObject({ id: other.organization.id });
      expect(first.app.get<Clock>(CLOCK).now()).toEqual(firstNow);
      expect(second.app.get<Clock>(CLOCK).now()).toEqual(secondNow);

      first.queryCounter.reset();
      second.queryCounter.reset();
      await request(first.server()).get('/public/services').expect(200);
      expect(first.queryCounter.total()).toBeGreaterThan(0);
      expect(second.queryCounter.total()).toBe(0);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('returns identity and the policy a booking page needs to explain itself', async () => {
    const response = await request(server()).get('/public/organizations/current').expect(200);

    const body = response.body as Record<string, unknown>;

    expect(body).toMatchObject({
      id: ctx.organization.id,
      timezone: BERLIN,
      currency: 'EUR',
      // Policy, so the front end can say "72 hours" without hard-coding it.
      bookingHorizonDays: 180,
      minimumNoticeHours: 24,
      freeCancellationHours: 72,
      customerNoteEnabled: true,
    });
    expect(body.address).toMatchObject({ city: 'Berlin', country: 'DE' });
  });

  it('does not leak the Stripe account or anything else internal', async () => {
    const response = await request(server()).get('/public/organizations/current').expect(200);
    const body = response.body as Record<string, unknown>;

    // Written field by field, so a column added to the model does not appear here by
    // default. These are the ones it would be most costly to leak.
    expect(body.stripeAccountId).toBeUndefined();
    expect(body.slug).toBeUndefined();
    expect(body.legalName).toBeUndefined();
    expect(body.settings).toBeUndefined();
  });
});

describe('GET /public/services', () => {
  it('lists the bookable services with their price as minor units', async () => {
    const response = await request(server()).get('/public/services').expect(200);
    const body = response.body as { items: { id: string; price: unknown; name: string }[] };

    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.price).toEqual({
      amountCents: ctx.service30.priceCents,
      currency: 'EUR',
    });
  });

  it('omits an archived service', async () => {
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { archivedAt: NOW },
    });

    const response = await request(server()).get('/public/services').expect(200);
    const body = response.body as { items: { id: string }[] };

    expect(body.items.map((item) => item.id)).not.toContain(ctx.service30.id);
  });

  it('omits a service that is not offered online', async () => {
    // An office-only service exists in the catalog but must never appear on a public
    // booking page.
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { isBookableOnline: false },
    });

    const response = await request(server()).get('/public/services').expect(200);
    const body = response.body as { items: { id: string }[] };

    expect(body.items.map((item) => item.id)).not.toContain(ctx.service30.id);
  });
});

describe('GET /public/service-categories', () => {
  it('nests the bookable services under their category', async () => {
    const response = await request(server()).get('/public/service-categories').expect(200);
    const body = response.body as { items: { id: string; services: { id: string }[] }[] };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.services.map((service) => service.id)).toContain(ctx.service30.id);
  });

  it('omits an archived service from its category', async () => {
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { archivedAt: NOW },
    });

    const response = await request(server()).get('/public/service-categories').expect(200);
    const body = response.body as { items: { services: { id: string }[] }[] };

    expect(body.items[0]?.services.map((service) => service.id)).not.toContain(ctx.service30.id);
  });
});

describe('GET /public/services/:serviceId/employees', () => {
  it('returns the employees who perform the service, at the list price', async () => {
    const response = await request(server())
      .get(`/public/services/${ctx.service30.id}/employees`)
      .expect(200);

    const body = response.body as {
      items: { id: string; displayName: string; price: { amountCents: number } }[];
    };

    expect(body.items.map((item) => item.id).sort()).toEqual(
      [ctx.employee1.id, ctx.employee2.id].sort(),
    );
    expect(body.items[0]?.price.amountCents).toBe(ctx.service30.priceCents);
  });

  it('applies an employee price override', async () => {
    // The join table carries the override, which is the whole reason it is an explicit
    // model rather than an implicit many-to-many.
    await prisma.employeeService.updateMany({
      where: { employeeId: ctx.employee2.id, serviceId: ctx.service30.id },
      data: { priceOverrideCents: 9900 },
    });

    const response = await request(server())
      .get(`/public/services/${ctx.service30.id}/employees`)
      .expect(200);

    const body = response.body as { items: { id: string; price: { amountCents: number } }[] };
    const overridden = body.items.find((item) => item.id === ctx.employee2.id);
    const standard = body.items.find((item) => item.id === ctx.employee1.id);

    expect(overridden?.price.amountCents).toBe(9900);
    expect(standard?.price.amountCents).toBe(ctx.service30.priceCents);
  });

  it('omits an employee who is not bookable online', async () => {
    await prisma.employee.update({
      where: { id: ctx.employee2.id },
      data: { isBookableOnline: false },
    });

    const response = await request(server())
      .get(`/public/services/${ctx.service30.id}/employees`)
      .expect(200);

    const body = response.body as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toEqual([ctx.employee1.id]);
  });

  it('never returns an employee email or their office-user link', async () => {
    const response = await request(server())
      .get(`/public/services/${ctx.service30.id}/employees`)
      .expect(200);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('@');
    expect(serialised).not.toContain('officeUser');
    expect(serialised).not.toContain('email');
  });

  it('404s an archived service', async () => {
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { archivedAt: NOW },
    });

    const response = await request(server())
      .get(`/public/services/${ctx.service30.id}/employees`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an id that is not a cuid rather than querying with it', async () => {
    const response = await request(server())
      .get('/public/services/not-an-id/employees')
      .expect(400);

    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

/**
 * A route nobody remembered to think about, which is the case the guard exists for.
 *
 * It has to be a route that *exists*: Nest resolves the handler before it runs guards,
 * so a path matching nothing is a 404 and no guard is consulted. Proving "closed by
 * default" therefore needs a real endpoint with no `@Public()` on it.
 */
@Controller('probe')
class ForgottenController {
  @Get('secret')
  secret(): { leaked: true } {
    return { leaked: true };
  }
}

@Module({ controllers: [ForgottenController] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ForgottenModule {}

describe('the global guard', () => {
  let closedServer: () => Server;

  beforeEach(async () => {
    const testApp = await createPublicTestApp({
      organization: await loadOrganization(ctx.organization.id),
      now: NOW,
      imports: [PublicModule, ForgottenModule],
    });

    closedServer = testApp.server;
    return testApp.close;
  });

  it('closes a route that was never marked public', async () => {
    const response = await request(closedServer()).get('/probe/secret').expect(401);

    expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(JSON.stringify(response.body)).not.toContain('leaked');
  });

  it('still lets the public routes through', async () => {
    await request(closedServer()).get('/public/services').expect(200);
  });
});
