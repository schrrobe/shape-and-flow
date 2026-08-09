import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/domain/time/clock.js';
import { TenantResolutionMiddleware } from '../../src/organization/tenant-resolution.middleware.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { TENANT_RESOLUTION_CONFIG } from '../test-config.module.js';

import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Express } from 'express';
import type { Server } from 'node:http';

/**
 * Domain-based tenant resolution, through the HTTP surface.
 *
 * The unit spec covers the branch matrix against a fake Prisma. What it structurally
 * cannot answer is the question this file exists for: does a real request, carrying a
 * real `Host` header, reach a real handler with the right organization in scope — and,
 * because the tenant now lives in an AsyncLocalStorage scope opened per request, does
 * one request's tenant leak into the next one's. Two organizations are seeded for
 * exactly that, and every assertion below is vacuous without both.
 */

const NOW = new Date('2026-08-14T06:00:00.000Z');

const HOST_A = 'studio-muster.de';
const HOST_A_WWW = 'www.studio-muster.de';
const HOST_B = 'praxis-nord.de';

let alpha: SeedContext;
let beta: SeedContext;
let fallback: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;

beforeEach(async () => {
  await resetDatabase();

  alpha = await seedOrganization(prisma, {
    slug: 'studio-muster',
    domains: [HOST_A, HOST_A_WWW],
  });
  beta = await seedOrganization(prisma, { slug: 'praxis-nord', domains: [HOST_B] });
  // The bootstrap tenant is a third organization with no domain of its own. Without
  // that, "resolved alpha from alpha's hostname" and "resolved nothing and fell back"
  // produce the same catalogue, and every assertion below would pass unresolved.
  fallback = await seedOrganization(prisma, { slug: 'zentrale' });

  const tenantResolution = new TenantResolutionMiddleware(prisma, TENANT_RESOLUTION_CONFIG);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(fallback.organization.id),
    clock: new FixedClock(NOW),
    globalPrefix: 'api',
    middleware: [['/api/public', tenantResolution.middleware]],
  });

  server = testApp.server;
  return testApp.close;
});

async function servicesFor(host: string, query = ''): Promise<request.Response> {
  return await request(server()).get(`/api/public/services${query}`).set('Host', host);
}

/** The service ids a catalogue response carries, which differ per organization. */
const idsOf = (response: request.Response): string[] =>
  (response.body as { items: { id: string }[] }).items.map((item) => item.id);

describe('resolving the tenant from the hostname', () => {
  it('serves the organization the hostname is registered to, with no query parameter', async () => {
    const response = await servicesFor(HOST_A);

    expect(response.status).toBe(200);
    const ids = idsOf(response);
    expect(ids).toContain(alpha.service30.id);
    expect(ids).not.toContain(beta.service30.id);
  });

  it('serves the same organization under its second registered hostname', async () => {
    const response = await servicesFor(HOST_A_WWW);

    expect(response.status).toBe(200);
    const ids = idsOf(response);
    expect(ids).toContain(alpha.service30.id);
    expect(ids).not.toContain(fallback.service30.id);
  });

  it('resolves a hostname that arrives with a port and a trailing dot', async () => {
    const response = await servicesFor(`${HOST_A}.:443`);

    expect(response.status).toBe(200);
    const ids = idsOf(response);
    expect(ids).toContain(alpha.service30.id);
  });

  // The reason domain resolution exists at all: a link a customer kept from the central
  // address cannot redirect the visit into somebody else's calendar.
  it('ignores a contradicting ?organizer= on a registered domain', async () => {
    const response = await servicesFor(HOST_A, '?organizer=praxis-nord');

    expect(response.status).toBe(200);
    const ids = idsOf(response);
    expect(ids).toContain(alpha.service30.id);
    expect(ids).not.toContain(beta.service30.id);
  });

  it('reads the forwarded host, which is what nginx sets and the client cannot', async () => {
    // Production runs behind exactly one proxy hop; without this the app would read the
    // TCP-level Host and the header nginx spends a line setting would do nothing.
    const express = testApp.app.getHttpAdapter().getInstance() as Express;
    express.set('trust proxy', 1);

    const response = await request(server())
      .get('/api/public/services')
      .set('Host', 'localhost')
      .set('X-Forwarded-Host', HOST_B);

    expect(response.status).toBe(200);
    const ids = idsOf(response);
    expect(ids).toContain(beta.service30.id);
    expect(ids).not.toContain(alpha.service30.id);
  });
});

describe('not mixing tenants across consecutive requests', () => {
  // The tenant lives in an AsyncLocalStorage scope opened per request. A scope that
  // outlived its request, or a snapshot cached on the provider, would show up here and
  // nowhere else in the suite.
  it('answers each host with its own catalogue, in sequence', async () => {
    for (const [host, ctx] of [
      [HOST_A, alpha],
      [HOST_B, beta],
      [HOST_A, alpha],
      [HOST_B, beta],
    ] as const) {
      const response = await servicesFor(host);

      expect(response.status, host).toBe(200);
      const ids = idsOf(response);
      expect(ids, host).toContain(ctx.service30.id);
      expect(ids.length, host).toBe(2);
    }
  });

  it('answers each host with its own catalogue, concurrently', async () => {
    const [a, b] = await Promise.all([servicesFor(HOST_A), servicesFor(HOST_B)]);

    expect(idsOf(a)).toContain(alpha.service30.id);
    expect(idsOf(b)).toContain(beta.service30.id);
    expect(idsOf(a)).not.toContain(beta.service30.id);
  });

  it('keeps employee selection scoped to the resolved organization', async () => {
    const response = await request(server())
      .get(`/api/public/services/${alpha.service30.id}/employees`)
      .set('Host', HOST_B);

    // Alpha's service does not exist as far as beta's catalogue is concerned, and the
    // 404 must not distinguish "not yours" from "never existed".
    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('a foreign hostname', () => {
  // Without this gate, any hostname somebody points at this server becomes a working
  // front end for every tenant: pick a slug, get the catalogue.
  it('may not choose a tenant with ?organizer=', async () => {
    const response = await servicesFor('attacker.example', '?organizer=studio-muster');

    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('is refused identically for a slug that does not exist', async () => {
    const response = await servicesFor('attacker.example', '?organizer=ghost-org');

    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe('ORGANIZATION_NOT_FOUND');
  });

  // No identity was offered, so there is none to get wrong. This is the single-organizer
  // deployment and the central address's own landing page.
  it('falls through to the bootstrap organization when it offers no slug', async () => {
    const response = await servicesFor('unregistered.example');

    expect(response.status).toBe(200);
    const ids = idsOf(response);
    expect(ids).toContain(fallback.service30.id);
    expect(ids).not.toContain(alpha.service30.id);
  });
});

describe('the central host', () => {
  // 127.0.0.1 is central because NODE_ENV is not production — see
  // TENANT_RESOLUTION_CONFIG. This is the pre-existing behaviour, unchanged.
  it('still resolves the tenant from ?organizer=', async () => {
    const response = await request(server()).get('/api/public/services?organizer=praxis-nord');

    expect(response.status).toBe(200);
    const ids = idsOf(response);
    expect(ids).toContain(beta.service30.id);
  });

  it('rejects an unresolvable slug rather than serving the default organization', async () => {
    const response = await request(server()).get('/api/public/services?organizer=ghost-org');

    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe('ORGANIZATION_NOT_FOUND');
  });
});
