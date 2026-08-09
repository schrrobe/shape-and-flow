/**
 * Which organizer this browser tab is booking with.
 *
 * The API resolves the tenant for `/api/public/*` from `?organizer=<slug>`, and the only
 * place that slug ever appears is the link the customer opened. `fetch` does not inherit
 * the page's query string, router navigation drops it, and Stripe returns the browser to
 * whatever URL we handed it — so without somewhere to keep it, every request after the
 * first landing resolves to the default tenant instead. A second organizer would show the
 * default organizer's services and take bookings into the default organizer's calendar.
 *
 * Kept here rather than in a store: `api/client.ts` is deliberately free of Pinia and
 * router dependencies, and this is the one piece of ambient state it needs.
 *
 * `sessionStorage`, not `localStorage`: the scope is this tab's visit. A slug that
 * outlived the tab would silently re-point a later visit to the root address at an
 * organizer the customer has since left.
 */

const STORAGE_KEY = 'shape-and-flow:organizer';

/** Query parameter name, shared with the API's tenant middleware. */
export const ORGANIZER_PARAM = 'organizer';

/**
 * Read once, then held in memory.
 *
 * `undefined` means "not read yet", `null` means "read, and there is none" — so a browser
 * that refuses storage costs one failed access rather than one per request.
 */
let cached: string | null | undefined;

function readStorage(): string | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored === null || stored === '' ? null : stored;
  } catch {
    // Private modes and hardened settings throw on access rather than returning null.
    // Booking still works for whichever organizer the current URL names.
    return null;
  }
}

/**
 * A usable slug, or null.
 *
 * Express turns `?organizer=a&organizer=b` into an array and `?organizer=` into an empty
 * string, and the API rejects both rather than treating them as absent. Neither is worth
 * remembering, so neither gets past here.
 */
export function readOrganizerParam(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Remember the organizer this visit is for. Ignores anything unusable. */
export function rememberTenantSlug(slug: string | null): void {
  if (slug === null || slug === '') return;

  cached = slug;

  try {
    sessionStorage.setItem(STORAGE_KEY, slug);
  } catch {
    // In-memory only for the rest of this page load. A reload falls back to the URL,
    // which is where the slug came from in the first place.
  }
}

/** The organizer this tab is booking with, or null on the root address. */
export function tenantSlug(): string | null {
  cached ??= readStorage();
  return cached;
}

/**
 * Take the slug out of a URL's query string.
 *
 * Called once at start-up, before anything can fetch, because the first request the page
 * makes is a catalogue read that must already be scoped.
 */
export function captureTenantSlug(search: string): void {
  rememberTenantSlug(readOrganizerParam(new URLSearchParams(search).get(ORGANIZER_PARAM)));
}

/** Append the organizer to an absolute URL handed to a third party, such as Stripe. */
export function withOrganizer(url: string): string {
  const slug = tenantSlug();
  if (slug === null) return url;

  // String concatenation rather than `new URL`, because these URLs carry Stripe's
  // `{CHECKOUT_SESSION_ID}` placeholder and `URL` would percent-encode the braces into
  // something Stripe no longer substitutes.
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${ORGANIZER_PARAM}=${encodeURIComponent(slug)}`;
}

/** Test seam: forget what this module has cached. */
export function resetTenantSlugForTest(): void {
  cached = undefined;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if storage was never reachable.
  }
}
