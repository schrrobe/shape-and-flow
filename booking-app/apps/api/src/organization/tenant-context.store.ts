import { AsyncLocalStorage } from 'node:async_hooks';

import type { OrganizationWithSettings } from './organization-context.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

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

/**
 * Replace the organization the active scope is serving.
 *
 * The snapshot is taken by the middleware before the handler runs, so a request that
 * *writes* to its own organization goes on reading the pre-write state — a settings PATCH
 * would answer with the old values and audit a before/after pair that is identical.
 * Reloading the row and calling this makes the rest of the request see what it just
 * stored.
 *
 * Returns false outside any scope, where there is nothing to replace and the caller
 * should refresh the bootstrap snapshot instead.
 */
export function setCurrentTenant(organization: OrganizationWithSettings): boolean {
  const store = storage.getStore();
  if (store === undefined) return false;

  store.organization = organization;
  return true;
}

/** True when a tenant scope is active, for assertions and diagnostics. */
export function hasTenant(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Run `fn` inside the tenant scope for an explicit organization id.
 *
 * Workers have no request to resolve a tenant from, so this is the queue-side
 * equivalent of the two request middlewares: load the organization once, then open the
 * same ALS scope they open, so anything the job calls that reads `OrganizationContextService`
 * resolves the job's own organization instead of the bootstrap default.
 */
export async function runWithOrganization<T>(
  organizationId: string,
  prisma: PrismaService,
  fn: () => T | Promise<T>,
): Promise<T> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    include: { settings: true },
  });
  if (!organization.settings) {
    throw new Error(`Organization "${organizationId}" has no settings row.`);
  }
  return await runWithTenant({ ...organization, settings: organization.settings }, fn);
}
