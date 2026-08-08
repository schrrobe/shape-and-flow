import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it } from 'vitest';

import { resetTenantSlugForTest, tenantSlug } from '../api/tenant.js';

import { router } from './index.js';

describe('the router', () => {
  it('resolves the home route', () => {
    expect(router.resolve('/').name).toBe('home');
  });

  it('sends an unknown path to the not-found page rather than a blank screen', () => {
    expect(router.resolve('/does/not/exist').name).toBe('not-found');
  });

  it('declares no route pointing at a component that cannot be loaded', async () => {
    // A lazy route is only checked when somebody visits it, so a typo in an import path is a
    // 404 in production and nothing in CI. Loading every component here turns that into a
    // failing test.
    for (const route of router.getRoutes()) {
      const loader = route.components?.default;
      if (typeof loader !== 'function') continue;

      await expect((loader as () => Promise<unknown>)(), route.path).resolves.toBeTruthy();
    }
  });
});

/**
 * The address bar has to keep naming the organizer.
 *
 * The API client remembers the slug, so a booking would still work with it dropped — but
 * the URL would stop meaning anything: reloading, bookmarking or sharing the page would
 * land on the default tenant.
 */
describe('the organizer parameter', () => {
  afterEach(() => {
    resetTenantSlugForTest();
  });

  it('survives a navigation that carries no query of its own', async () => {
    await router.push('/?organizer=acme');
    await router.push({ name: 'booking-slot' });

    expect(router.currentRoute.value.query.organizer).toBe('acme');
  });

  it('is remembered from the landing URL rather than re-read from each link', async () => {
    await router.push('/?organizer=acme');
    await router.push('/booking/details');

    expect(router.currentRoute.value.query.organizer).toBe('acme');
  });

  it('leaves an explicit organizer alone', async () => {
    await router.push('/?organizer=acme');
    await router.push('/booking/slot?organizer=other');

    expect(router.currentRoute.value.query.organizer).toBe('other');
  });

  it('keeps the rest of the query', async () => {
    await router.push('/?organizer=acme');
    await router.push('/booking/success?session_id=cs_123');

    expect(router.currentRoute.value.query).toMatchObject({
      organizer: 'acme',
      session_id: 'cs_123',
    });
  });

  it('ignores an organizer on an office URL rather than repointing the tab', async () => {
    // The office session guard reaches for its store on every office navigation, and
    // `/office/forgot-password` is the one office route that needs no session — so this
    // exercises the organizer handling without standing up a signed-in session.
    setActivePinia(createPinia());

    await router.push('/?organizer=acme');
    await router.push('/office/forgot-password?organizer=other');
    await router.push('/booking/slot');

    // The office resolves its tenant from the session cookie, so `other` named nothing
    // there — and must not have replaced the organizer the public pages are booking with.
    expect(tenantSlug()).toBe('acme');
    expect(router.currentRoute.value.query.organizer).toBe('acme');
  });

  it('adds nothing on the root address', async () => {
    resetTenantSlugForTest();
    await router.push('/booking/service');

    expect(router.currentRoute.value.query.organizer).toBeUndefined();
  });
});
