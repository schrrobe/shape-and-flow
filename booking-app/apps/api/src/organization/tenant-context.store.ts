import { AsyncLocalStorage } from 'node:async_hooks';

import type { OrganizationWithSettings } from './organization-context.service.js';

/**
 * The tenant resolved for the current request, carried without threading it
 * through every signature.
 *
 * Mirrors `common/correlation/correlation.store.ts`: a public route resolves the
 * organization from `?organizer=<slug>` and opens a scope with `runWithTenant`; an
 * office route resolves it from the session instead. `OrganizationContextService.get()`
 * checks this scope first and falls back to its bootstrap snapshot when none is
 * active, which is what keeps worker and cron paths — which never open a scope —
 * unaffected.
 */
interface TenantContext {
  organization: OrganizationWithSettings;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Run `fn` inside the tenant scope resolved for this request. */
export function runWithTenant<T>(organization: OrganizationWithSettings, fn: () => T): T {
  return storage.run({ organization }, fn);
}

/** The organization resolved for the current request, or `undefined` outside any scope. */
export function currentTenant(): OrganizationWithSettings | undefined {
  return storage.getStore()?.organization;
}

/** True when a tenant scope is active, for assertions and diagnostics. */
export function hasTenant(): boolean {
  return storage.getStore() !== undefined;
}
