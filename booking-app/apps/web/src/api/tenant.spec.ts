import { afterEach, describe, expect, it } from 'vitest';

import {
  captureTenantSlug,
  readOrganizerParam,
  rememberTenantSlug,
  resetTenantSlugForTest,
  tenantSlug,
  withOrganizer,
} from './tenant.js';

afterEach(() => {
  resetTenantSlugForTest();
});

describe('readOrganizerParam', () => {
  // Express turns `?organizer=` into an empty string and repeated values into an array,
  // and the API rejects both. Remembering either would carry a request the server will
  // refuse into every later call.
  it.each([
    ['an empty value', ''],
    ['repeated values', ['a', 'b']],
    ['a missing value', undefined],
    ['a null value', null],
  ])('refuses %s', (_label, value) => {
    expect(readOrganizerParam(value)).toBeNull();
  });

  it('accepts a single slug', () => {
    expect(readOrganizerParam('acme')).toBe('acme');
  });
});

describe('captureTenantSlug', () => {
  it('lifts the slug out of a landing URL', () => {
    captureTenantSlug('?organizer=acme');

    expect(tenantSlug()).toBe('acme');
  });

  it('leaves the root address without one', () => {
    captureTenantSlug('');

    expect(tenantSlug()).toBeNull();
  });

  it('survives a reload, because it is stored rather than only held', () => {
    captureTenantSlug('?organizer=acme');

    // What a fresh page load looks like: module state gone, storage intact.
    expect(sessionStorage.getItem('shape-and-flow:organizer')).toBe('acme');
  });
});

describe('withOrganizer', () => {
  it('appends to a URL that has no query', () => {
    rememberTenantSlug('acme');

    expect(withOrganizer('https://example.com/booking/canceled')).toBe(
      'https://example.com/booking/canceled?organizer=acme',
    );
  });

  // Stripe substitutes `{CHECKOUT_SESSION_ID}` itself, so the braces have to survive
  // untouched — building this with `URL` would percent-encode them and Stripe would hand
  // back the literal placeholder.
  it("joins an existing query and leaves Stripe's placeholder intact", () => {
    rememberTenantSlug('acme');

    expect(withOrganizer('https://example.com/booking/success?session_id={CHECKOUT_SESSION_ID}')).toBe(
      'https://example.com/booking/success?session_id={CHECKOUT_SESSION_ID}&organizer=acme',
    );
  });

  it('changes nothing on the root address', () => {
    expect(withOrganizer('https://example.com/booking/canceled')).toBe(
      'https://example.com/booking/canceled',
    );
  });
});
