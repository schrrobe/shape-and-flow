# Organizer/Owner Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new Organizer self-register a tenant Organization with its first Owner account, complete Stripe Connect onboarding, and be resolvable by public traffic via a `?organizer=<slug>` query parameter — while every existing single-tenant code path keeps working unchanged.

**Architecture:** `Organization` gains the Promoter/Owner fields directly (no separate table). `OrganizationContextService` gains an `AsyncLocalStorage`-backed tenant scope that a new middleware populates from the query parameter (public routes) or the session (office routes), falling back to the existing bootstrap singleton when no scope is active — so all 37 existing injection sites are untouched. Registration is one transaction (`Organization` + `OrganizationSettings` + `OfficeUser` OWNER) followed by a Stripe Express account + AccountLink, then an immediate session so the new Owner is logged in before being redirected to Stripe.

**Tech Stack:** NestJS, Prisma/Postgres, Zod (`@shape-and-flow/booking-contracts`), Stripe Connect (`stripe` SDK, Express accounts), Vue 3 + Pinia (`apps/web`), Vitest.

## Global Constraints

- No separate Promoter table or microservice — everything lives in `Organization` and the existing `apps/api` app.
- Tenant resolution for public routes is `?organizer=<slug>` only — no subdomain routing, root domain keeps resolving to `DEFAULT_ORGANIZATION_SLUG`.
- Stripe Connect (Express accounts), not Adyen.
- First Owner sets their password directly in the registration form — no reset-link flow.
- No cross-organization email uniqueness — `@@unique([organizationId, email])` on `OfficeUser` stays as-is (confirmed YAGNI).
- All new `Organization` columns are nullable or defaulted — the existing seeded production Organization has no `taxId`/`entityType` and must not break.
- `OrganizationContextService`'s public interface (`get()`, `getOrganizationId()`, `getSettings()`, `getTimezone()`, `require()`) does not change shape — only its internals gain an ALS check in front of the existing singleton fallback.

---

### Task 1: Prisma schema — `EntityType` enum, `Organization`/`AuditAction` changes, migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Test: `apps/api/src/prisma/enum-drift.spec.ts` (updated in Task 2, but the migration this task runs is what that test needs to pass against)

**Interfaces:**
- Produces: Prisma model `Organization` with new columns `entityType`, `taxId`, `vatId`, `isSmallBusiness`, `ownerFirstName`, `ownerLastName`, `stripeDetailsSubmitted`, `stripeChargesEnabled`; `Organization.stripeAccountId` now `@unique`; new enum `EntityType`; new `AuditAction` member `ORGANIZATION_ONBOARDING_LINK_REQUESTED`.

- [ ] **Step 1: Add the `EntityType` enum immediately above `model Organization`**

In `apps/api/prisma/schema.prisma`, find `model Organization {` (currently line 218) and insert directly above it:

```prisma
enum EntityType {
  INDIVIDUAL
  SOLE_PROPRIETORSHIP
  ORGANIZATION
}

```

- [ ] **Step 2: Add the new `Organization` columns and the `@unique` on `stripeAccountId`**

Inside `model Organization`, change:

```prisma
  stripeAccountId String? @map("stripe_account_id")
```

to:

```prisma
  stripeAccountId String? @unique @map("stripe_account_id")

  entityType             EntityType?
  taxId                  String?
  vatId                  String?
  isSmallBusiness        Boolean     @default(false)
  ownerFirstName         String?
  ownerLastName          String?
  stripeDetailsSubmitted Boolean     @default(false)
  stripeChargesEnabled   Boolean     @default(false)
```

- [ ] **Step 3: Add the new `AuditAction` value**

Find the `enum AuditAction` block ending in `CUSTOMER_UPDATED` / `CUSTOMER_ERASED` and add a new member after `CUSTOMER_ERASED`:

```prisma
  CUSTOMER_ERASED
  ORGANIZATION_ONBOARDING_LINK_REQUESTED
```

(Remove the trailing `CUSTOMER_ERASED` you are replacing — this is one line becoming two, not a duplicate.)

- [ ] **Step 4: Generate and run the migration**

Run: `pnpm --filter @shape-and-flow/booking-api prisma:migrate:dev -- --name organizer_onboarding`
Expected: migration file created under `apps/api/prisma/migrations/`, applies cleanly against the dev database, Prisma Client regenerated.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(db): add organizer onboarding fields to Organization"
```

---

### Task 2: Contracts — `EntityType` schema, enum-drift test, error codes

**Files:**
- Modify: `packages/contracts/src/enums.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `apps/api/src/prisma/enum-drift.spec.ts`
- Test: `packages/contracts/src/enums.spec.ts` (new assertions alongside existing enum tests, same file if one exists — otherwise `packages/contracts/src/enums.spec.ts` new file)

**Interfaces:**
- Consumes: Prisma `EntityType` enum and `AuditAction.ORGANIZATION_ONBOARDING_LINK_REQUESTED` from Task 1.
- Produces: `entityTypeSchema`, `EntityType` type, exported from `packages/contracts/src/enums.ts`; error codes `INVALID_RETURN_URL` (400), `ORGANIZATION_CREATE_ERROR` (422), `ONBOARDING_LINK_ERROR` (500) in `errorCodeSchema`/`ERROR_STATUS`.

- [ ] **Step 1: Write the failing enum-drift case**

In `apps/api/src/prisma/enum-drift.spec.ts`, add to the `PAIRS` array (alongside the existing `['AuditAction', AuditAction, auditActionSchema.options]` tuple):

```typescript
['EntityType', EntityType, entityTypeSchema.options],
```

Add the matching imports at the top of the file:

```typescript
import { EntityType } from '../prisma/client.js';
import { entityTypeSchema } from '@shape-and-flow/booking-contracts';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- enum-drift`
Expected: FAIL — `entityTypeSchema` is not exported from `@shape-and-flow/booking-contracts`.

- [ ] **Step 3: Add `entityTypeSchema` to `packages/contracts/src/enums.ts`**

Add near the other enum schemas (alongside `auditActionSchema`):

```typescript
export const entityTypeSchema = z.enum(['INDIVIDUAL', 'SOLE_PROPRIETORSHIP', 'ORGANIZATION']);
export type EntityType = z.infer<typeof entityTypeSchema>;
```

Add `'ORGANIZATION_ONBOARDING_LINK_REQUESTED'` to the end of `auditActionSchema`'s array (after `'CUSTOMER_ERASED'`).

- [ ] **Step 4: Run the enum-drift test again to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- enum-drift`
Expected: PASS, including the existing `'is not vacuous'` check (`EntityType` has 3 options).

- [ ] **Step 5: Write the failing error-code test**

In `packages/contracts/src/errors.spec.ts` (or wherever `ERROR_STATUS`/`errorCodeSchema` exhaustiveness is already tested — extend that file), add:

```typescript
it('has a status for INVALID_RETURN_URL, ORGANIZATION_CREATE_ERROR, and ONBOARDING_LINK_ERROR', () => {
  expect(ERROR_STATUS.INVALID_RETURN_URL).toBe(400);
  expect(ERROR_STATUS.ORGANIZATION_CREATE_ERROR).toBe(422);
  expect(ERROR_STATUS.ONBOARDING_LINK_ERROR).toBe(500);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-contracts test -- errors`
Expected: FAIL — the three codes are not in `errorCodeSchema`/`ERROR_STATUS` yet.

- [ ] **Step 7: Add the three error codes**

In `packages/contracts/src/errors.ts`, add `'INVALID_RETURN_URL'`, `'ORGANIZATION_CREATE_ERROR'`, `'ONBOARDING_LINK_ERROR'` to `errorCodeSchema`'s enum list (grouped with their matching status per the file's existing comment grouping — 400s, 422s, 500s respectively), and add matching entries to `ERROR_STATUS`:

```typescript
INVALID_RETURN_URL: 400,
ORGANIZATION_CREATE_ERROR: 422,
ONBOARDING_LINK_ERROR: 500,
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `pnpm --filter @shape-and-flow/booking-contracts test -- errors && pnpm --filter @shape-and-flow/booking-api test -- enum-drift`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/enums.ts packages/contracts/src/errors.ts apps/api/src/prisma/enum-drift.spec.ts packages/contracts/src/errors.spec.ts
git commit -m "feat(contracts): add EntityType schema and onboarding error codes"
```

---

### Task 3: Contracts — registration request/response schema

**Files:**
- Create: `packages/contracts/src/public/organizations.ts`
- Modify: `packages/contracts/src/public/index.ts`
- Test: `packages/contracts/src/public/organizations.spec.ts`

**Interfaces:**
- Consumes: `entityTypeSchema` (Task 2), `cuidSchema` from `packages/contracts/src/primitives.ts`, `newPasswordSchema` from `packages/contracts/src/auth/index.ts`.
- Produces: `registerOrganizationRequestSchema`, `RegisterOrganizationRequest`, `registerOrganizationResponseSchema`, `RegisterOrganizationResponse`.

- [ ] **Step 1: Write the failing schema tests**

Create `packages/contracts/src/public/organizations.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { registerOrganizationRequestSchema } from './organizations.js';

const BASE = {
  email: 'owner@example.com',
  password: 'Correct-Horse-Battery-9',
  displayName: 'Acme Studio',
  contactPhone: '+49 30 1234567',
  addressLine1: 'Musterstraße 1',
  postalCode: '10115',
  city: 'Berlin',
};

describe('registerOrganizationRequestSchema', () => {
  it('accepts an INDIVIDUAL registration with firstName/lastName', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'INDIVIDUAL',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    expect(result.success).toBe(true);
  });

  it('rejects INDIVIDUAL without lastName', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'INDIVIDUAL',
      firstName: 'Jane',
    });
    expect(result.success).toBe(false);
  });

  it('requires companyName for ORGANIZATION', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'ORGANIZATION',
    });
    expect(result.success).toBe(false);
  });

  it('accepts ORGANIZATION with companyName and isSmallBusiness in Germany', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'ORGANIZATION',
      companyName: 'Acme GmbH',
      country: 'DE',
      isSmallBusiness: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects isSmallBusiness outside Germany', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'ORGANIZATION',
      companyName: 'Acme GmbH',
      country: 'FR',
      isSmallBusiness: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'INDIVIDUAL',
      firstName: 'Jane',
      lastName: 'Doe',
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-contracts test -- public/organizations`
Expected: FAIL — `./organizations.js` does not exist.

- [ ] **Step 3: Write `packages/contracts/src/public/organizations.ts`**

```typescript
import { z } from 'zod';

import { newPasswordSchema } from '../auth/index.js';
import { entityTypeSchema } from '../enums.js';
import { cuidSchema } from '../primitives.js';

const baseFields = {
  email: z.email().max(320),
  password: newPasswordSchema,
  displayName: z.string().min(1).max(70),
  contactPhone: z.string().min(1),
  whatsappNumber: z.string().min(1).optional(),
  addressLine1: z.string().min(1),
  addressLine2: z.string().min(1).optional(),
  postalCode: z.string().min(1),
  city: z.string().min(1),
  country: z.string().length(2).default('DE'),
  taxId: z.string().min(1).optional(),
  vatId: z.string().min(1).optional(),
  returnUrl: z.url().optional(),
};

const individualSchema = z
  .object({
    entityType: z.literal('INDIVIDUAL'),
    firstName: z.string().min(1).max(70),
    lastName: z.string().min(1).max(70),
    isSmallBusiness: z.literal(false).default(false),
    ...baseFields,
  })
  .strict();

const soleProprietorshipSchema = z
  .object({
    entityType: z.literal('SOLE_PROPRIETORSHIP'),
    companyName: z.string().min(1).max(110),
    firstName: z.string().min(1).max(70),
    lastName: z.string().min(1).max(70),
    isSmallBusiness: z.boolean().default(false),
    ...baseFields,
  })
  .strict();

const organizationEntitySchema = z
  .object({
    entityType: z.literal('ORGANIZATION'),
    companyName: z.string().min(1).max(110),
    isSmallBusiness: z.boolean().default(false),
    ...baseFields,
  })
  .strict();

export const registerOrganizationRequestSchema = z
  .discriminatedUnion('entityType', [
    individualSchema,
    soleProprietorshipSchema,
    organizationEntitySchema,
  ])
  .superRefine((value, ctx) => {
    if (value.isSmallBusiness && value.country !== 'DE') {
      ctx.addIssue({
        code: 'custom',
        path: ['isSmallBusiness'],
        message: 'isSmallBusiness is only available for country "DE".',
      });
    }
  });

export type RegisterOrganizationRequest = z.infer<typeof registerOrganizationRequestSchema>;

export const registerOrganizationResponseSchema = z.object({
  id: cuidSchema,
  slug: z.string(),
  onboardingLink: z.url().nullable(),
});

export type RegisterOrganizationResponse = z.infer<typeof registerOrganizationResponseSchema>;
```

Note: `entityTypeSchema` itself (the plain enum) is not reused here beyond validating the discriminant shape conceptually — the discriminated union's literal branches are what Zod actually dispatches on. `entityTypeSchema` remains the source of truth for the enum-drift test in Task 2.

- [ ] **Step 4: Export it from the public barrel**

In `packages/contracts/src/public/index.ts`, add:

```typescript
export * from './organizations.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @shape-and-flow/booking-contracts test -- public/organizations`
Expected: PASS, all 6 cases.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/public/organizations.ts packages/contracts/src/public/index.ts packages/contracts/src/public/organizations.spec.ts
git commit -m "feat(contracts): add registerOrganizationRequestSchema"
```

---

### Task 4: ALS-based tenant resolution

**Files:**
- Create: `apps/api/src/organization/tenant-context.store.ts`
- Create: `apps/api/src/organization/tenant-resolution.middleware.ts`
- Create: `apps/api/src/organization/office-tenant.middleware.ts`
- Modify: `apps/api/src/organization/organization-context.service.ts`
- Modify: `apps/api/src/organization/organization.module.ts`
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/src/organization/tenant-context.store.spec.ts`
- Modify (test): `apps/api/src/organization/organization-context.service.spec.ts` — **this file already exists on `main` with 5 passing tests covering bootstrap/refresh behavior. Do not overwrite it — append the two new `it()` blocks from Step 5 below to its existing `describe('OrganizationContextService', ...)` block, matching its existing construction style (`new OrganizationContextService(config, prisma)`, no NestJS `Test.createTestingModule`).**

**Interfaces:**
- Consumes: `OrganizationWithSettings` type (already exported from `organization-context.service.ts`), `PrismaService`, `SessionStore`/`OfficeSession` from `apps/api/src/auth/session.store.ts`, `readCookie` from `apps/api/src/auth/office-session.guard.ts`, `ENV`/`AppConfig` from `apps/api/src/config/env.schema.ts`.
- Produces: `runWithTenant<T>(organization: OrganizationWithSettings, fn: () => T): T`, `currentTenant(): OrganizationWithSettings | undefined`, `hasTenant(): boolean` — all exported from `tenant-context.store.ts`. `OrganizationContextService.get()` now checks `currentTenant()` first.

- [ ] **Step 1: Write the failing store test**

Create `apps/api/src/organization/tenant-context.store.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { currentTenant, hasTenant, runWithTenant } from './tenant-context.store.js';

import type { OrganizationWithSettings } from './organization-context.service.js';

const ORG = { id: 'org_1', slug: 'acme' } as unknown as OrganizationWithSettings;

describe('tenant-context.store', () => {
  it('has no tenant outside a scope', () => {
    expect(hasTenant()).toBe(false);
    expect(currentTenant()).toBeUndefined();
  });

  it('exposes the organization inside runWithTenant', () => {
    runWithTenant(ORG, () => {
      expect(hasTenant()).toBe(true);
      expect(currentTenant()).toBe(ORG);
    });
  });

  it('does not leak the scope after runWithTenant returns', () => {
    runWithTenant(ORG, () => undefined);
    expect(hasTenant()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- tenant-context.store`
Expected: FAIL — `./tenant-context.store.js` does not exist.

- [ ] **Step 3: Write `apps/api/src/organization/tenant-context.store.ts`**

Mirrors `apps/api/src/common/correlation/correlation.store.ts` exactly:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

import type { OrganizationWithSettings } from './organization-context.service.js';

interface TenantContext {
  organization: OrganizationWithSettings;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Run `fn` inside a tenant scope resolved for this request. */
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
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- tenant-context.store`
Expected: PASS.

- [ ] **Step 5: Write the failing `OrganizationContextService` test**

Modify `apps/api/src/organization/organization-context.service.spec.ts` — add the import and the two new `it()` blocks below to the existing file, without touching its 5 existing tests. Add the import alongside the existing ones at the top:

```typescript
import { runWithTenant } from './tenant-context.store.js';
```

Add these two cases inside the existing `describe('OrganizationContextService', () => { ... })` block, after the existing tests:

```typescript
  it('returns the bootstrap organization outside any tenant scope', async () => {
    const { service } = serviceReturning(organization);

    await service.onApplicationBootstrap();

    expect(service.get().id).toBe('org-1');
  });

  it('returns the scoped organization inside runWithTenant', async () => {
    const { service } = serviceReturning(organization);
    await service.onApplicationBootstrap();

    const scoped = {
      ...organization,
      id: 'org-2',
      slug: 'acme',
    } as OrganizationWithSettings;

    runWithTenant(scoped, () => {
      expect(service.get().id).toBe('org-2');
      expect(service.getOrganizationId()).toBe('org-2');
      expect(service.getTimezone()).toBe('Europe/Berlin');
    });
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-context.service`
Expected: FAIL — `service.get()` inside `runWithTenant` still returns `org-1`, not `org-2`.

- [ ] **Step 7: Modify `OrganizationContextService.get()`**

In `apps/api/src/organization/organization-context.service.ts`, add the import:

```typescript
import { currentTenant } from './tenant-context.store.js';
```

Change:

```typescript
  get(): OrganizationWithSettings {
    if (!this.organization) {
      throw new Error(
        'Organization context read before bootstrap completed. ' +
          'Inject OrganizationContextService rather than calling it at module construction time.',
      );
    }
    return this.organization;
  }
```

to:

```typescript
  get(): OrganizationWithSettings {
    const scoped = currentTenant();
    if (scoped) return scoped;

    if (!this.organization) {
      throw new Error(
        'Organization context read before bootstrap completed. ' +
          'Inject OrganizationContextService rather than calling it at module construction time.',
      );
    }
    return this.organization;
  }
```

Every other method (`getOrganizationId()`, `getSettings()`, `getTimezone()`, `require()`) already delegates to `get()`, so they pick up the ALS check automatically — no further changes needed in this file.

- [ ] **Step 8: Run both tests to verify they pass**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-context.service tenant-context.store`
Expected: PASS.

- [ ] **Step 9: Write `TenantResolutionMiddleware` (public routes)**

Create `apps/api/src/organization/tenant-resolution.middleware.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';

import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { runWithTenant } from './tenant-context.store.js';

import type { AppConfig } from '../config/env.schema.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * Resolves the tenant for public traffic from `?organizer=<slug>`.
 *
 * Absent the query parameter, falls through to the bootstrap default —
 * `OrganizationContextService.get()` does that itself when no ALS scope is set, so
 * this middleware simply does nothing in that case rather than duplicating the
 * fallback.
 */
@Injectable()
export class TenantResolutionMiddleware {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  middleware = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const slug = request.query['organizer'];

    if (typeof slug !== 'string' || slug.length === 0) {
      next();
      return;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      include: { settings: true },
    });

    if (!organization || !organization.settings) {
      next();
      return;
    }

    runWithTenant({ ...organization, settings: organization.settings }, () => next());
  };
}
```

- [ ] **Step 10: Write `OfficeTenantMiddleware` (office routes)**

Create `apps/api/src/organization/office-tenant.middleware.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';

import { readCookie } from '../auth/office-session.guard.js';
import { SessionStore } from '../auth/session.store.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { runWithTenant } from './tenant-context.store.js';

import type { AppConfig } from '../config/env.schema.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * Resolves the tenant for office traffic from the session, never from the query
 * string — a query parameter must never be able to redirect an authenticated
 * request into a different organization's data.
 */
@Injectable()
export class OfficeTenantMiddleware {
  constructor(
    private readonly sessions: SessionStore,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  middleware = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const sid = readCookie(request, this.config.SESSION_COOKIE_NAME);
    if (sid === null) {
      next();
      return;
    }

    const session = await this.sessions.read(sid);
    if (session === null) {
      next();
      return;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: session.organizationId },
      include: { settings: true },
    });

    if (!organization || !organization.settings) {
      next();
      return;
    }

    runWithTenant({ ...organization, settings: organization.settings }, () => next());
  };
}
```

- [ ] **Step 11: Register both middlewares in `OrganizationModule`**

In `apps/api/src/organization/organization.module.ts`, add `TenantResolutionMiddleware` and `OfficeTenantMiddleware` to `providers` and `exports`, and import `AuthModule` (for `SessionStore`):

```typescript
imports: [AuthModule],
providers: [
  OrganizationContextService,
  TenantResolutionMiddleware,
  OfficeTenantMiddleware,
  {
    provide: TENANT_PRISMA,
    inject: [PrismaService, OrganizationContextService],
    useFactory: (prisma, organizations) =>
      createTenantGuardedClient(prisma, () => organizations.getOrganizationId()),
  },
],
exports: [OrganizationContextService, TENANT_PRISMA, TenantResolutionMiddleware, OfficeTenantMiddleware],
```

- [ ] **Step 12: Mount both middlewares in `main.ts`**

In `apps/api/src/main.ts`, right after `app.use(correlationMiddleware);` and before `app.setGlobalPrefix('api');`, add:

```typescript
app.use('/api/public', app.get(TenantResolutionMiddleware).middleware);
app.use('/api/office', app.get(OfficeTenantMiddleware).middleware);
```

Add the matching imports at the top of `main.ts`:

```typescript
import { OfficeTenantMiddleware } from './organization/office-tenant.middleware.js';
import { TenantResolutionMiddleware } from './organization/tenant-resolution.middleware.js';
```

- [ ] **Step 13: Run the full API unit suite to verify nothing regressed**

Run: `pnpm --filter @shape-and-flow/booking-api test`
Expected: PASS — all 37 existing `OrganizationContextService` consumers unaffected.

- [ ] **Step 14: Commit**

```bash
git add apps/api/src/organization apps/api/src/main.ts
git commit -m "feat(api): resolve tenant via ALS from query param or session"
```

---

### Task 5: `STRIPE_CLIENT` provider and `StripeConnectService`

**Files:**
- Modify: `apps/api/src/providers/providers.module.ts`
- Create: `apps/api/src/organization/stripe-connect.service.ts`
- Test: `apps/api/src/organization/stripe-connect.service.spec.ts`

**Interfaces:**
- Consumes: `ENV`/`AppConfig`, `required()` (already exported from `providers.module.ts`).
- Produces: `STRIPE_CLIENT` injection token (`Stripe | null`); `StripeConnectService.createExpressAccount(input): Promise<{ stripeAccountId: string }>`, `StripeConnectService.createAccountLink(stripeAccountId: string, returnUrl: string): Promise<{ url: string }>`.

- [ ] **Step 1: Add the `STRIPE_CLIENT` token**

In `apps/api/src/providers/providers.module.ts`, add near the top (after the existing token exports):

```typescript
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');
```

Add to the `providers` array:

```typescript
{
  provide: STRIPE_CLIENT,
  inject: [ENV],
  useFactory: (config: AppConfig): Stripe | null =>
    config.PAYMENT_PROVIDER === 'stripe'
      ? new Stripe(required(config.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY'), {
          apiVersion: Stripe.API_VERSION,
          maxNetworkRetries: 2,
          timeout: 15_000,
        })
      : null,
},
```

Add `STRIPE_CLIENT` to the module's `exports` array.

- [ ] **Step 2: Write the failing `StripeConnectService` test**

Create `apps/api/src/organization/stripe-connect.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { STRIPE_CLIENT } from '../providers/providers.module.js';

import { StripeConnectService } from './stripe-connect.service.js';

describe('StripeConnectService', () => {
  it('throws when Stripe is not configured', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: null }],
    }).compile();

    const service = moduleRef.get(StripeConnectService);
    await expect(
      service.createExpressAccount({ email: 'a@b.com', country: 'DE', businessType: 'individual' }),
    ).rejects.toThrow('PAYMENT_PROVIDER');
  });

  it('creates an Express account with the given business type', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'acct_123' });
    const stripe = { accounts: { create } };

    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: stripe }],
    }).compile();

    const service = moduleRef.get(StripeConnectService);
    const result = await service.createExpressAccount({
      email: 'a@b.com',
      country: 'DE',
      businessType: 'individual',
    });

    expect(result).toEqual({ stripeAccountId: 'acct_123' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'express', country: 'DE', email: 'a@b.com' }),
    );
  });

  it('creates an account link with the given return url', async () => {
    const create = vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/setup/xyz' });
    const stripe = { accountLinks: { create } };

    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: stripe }],
    }).compile();

    const service = moduleRef.get(StripeConnectService);
    const result = await service.createAccountLink('acct_123', 'https://app.example.com/return');

    expect(result).toEqual({ url: 'https://connect.stripe.com/setup/xyz' });
    expect(create).toHaveBeenCalledWith({
      account: 'acct_123',
      type: 'account_onboarding',
      return_url: 'https://app.example.com/return',
      refresh_url: 'https://app.example.com/return',
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- stripe-connect.service`
Expected: FAIL — `./stripe-connect.service.js` does not exist.

- [ ] **Step 4: Write `apps/api/src/organization/stripe-connect.service.ts`**

```typescript
import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { STRIPE_CLIENT } from '../providers/providers.module.js';

import type Stripe from 'stripe';

export interface ExpressAccountInput {
  email: string;
  country: string;
  businessType: 'individual' | 'company';
}

/**
 * Creates Stripe Express accounts and onboarding links for newly registered
 * Organizations.
 *
 * Kept separate from `PAYMENT_PROVIDER`: that port is the checkout side (creating
 * Checkout Sessions, handling refunds), this is the Connect side (onboarding the
 * merchant itself). The two never need the same abstraction.
 */
@Injectable()
export class StripeConnectService {
  constructor(@Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null) {}

  async createExpressAccount(input: ExpressAccountInput): Promise<{ stripeAccountId: string }> {
    const stripe = this.require();
    const account = await stripe.accounts.create({
      type: 'express',
      country: input.country,
      email: input.email,
      business_type: input.businessType,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    });

    return { stripeAccountId: account.id };
  }

  async createAccountLink(stripeAccountId: string, returnUrl: string): Promise<{ url: string }> {
    const stripe = this.require();
    const link = await stripe.accountLinks.create({
      account: stripeAccountId,
      type: 'account_onboarding',
      return_url: returnUrl,
      refresh_url: returnUrl,
    });

    return { url: link.url };
  }

  private require(): Stripe {
    if (!this.stripe) {
      throw new AppError('ONBOARDING_LINK_ERROR', {
        message: 'PAYMENT_PROVIDER is not "stripe"; Stripe Connect onboarding is unavailable.',
      });
    }
    return this.stripe;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @shape-and-flow/booking-api test -- stripe-connect.service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/providers/providers.module.ts apps/api/src/organization/stripe-connect.service.ts apps/api/src/organization/stripe-connect.service.spec.ts
git commit -m "feat(api): add STRIPE_CLIENT provider and StripeConnectService"
```

---

### Task 6: Slug helper + registration endpoint

**Files:**
- Create: `apps/api/src/organization/slug.ts`
- Create: `apps/api/src/organization/organization-registration.service.ts`
- Create: `apps/api/src/organization/organization-registration.controller.ts`
- Modify: `apps/api/src/organization/organization.module.ts`
- Test: `apps/api/src/organization/slug.spec.ts`
- Test: `apps/api/src/organization/organization-registration.service.spec.ts`

**Interfaces:**
- Consumes: `RegisterOrganizationRequest`/`RegisterOrganizationResponse` (Task 3), `PasswordService.hash(plain: string): Promise<string>`, `SessionStore.create(user: SessionSubject): Promise<string>`, `isUniqueViolation(error: unknown, target?: string): boolean` from `apps/api/src/common/prisma-errors/prisma-errors.ts`, `StripeConnectService` (Task 5).
- Produces: `slugify(input: string): string`, `POST /public/organizations` returning `RegisterOrganizationResponse` and setting the session cookie.

- [ ] **Step 1: Write the failing slug test**

Create `apps/api/src/organization/slug.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Acme Studio')).toBe('acme-studio');
  });

  it('strips diacritics', () => {
    expect(slugify('Café Müller')).toBe('cafe-muller');
  });

  it('collapses repeated separators', () => {
    expect(slugify('  Acme   & Co.  ')).toBe('acme-co');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- slug`
Expected: FAIL — `./slug.js` does not exist.

- [ ] **Step 3: Write `apps/api/src/organization/slug.ts`**

```typescript
/** A URL-safe, lowercase slug from a display name. Collisions are handled by the caller. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A short, unambiguous suffix for retrying a slug collision. */
export function slugSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- slug`
Expected: PASS.

- [ ] **Step 5: Write the failing registration service test**

Create `apps/api/src/organization/organization-registration.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PasswordService } from '../auth/password.service.js';
import { SessionStore } from '../auth/session.store.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { ENV } from '../config/env.schema.js';

import { OrganizationRegistrationService } from './organization-registration.service.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { RegisterOrganizationRequest } from '@shape-and-flow/booking-contracts';

const REQUEST: RegisterOrganizationRequest = {
  entityType: 'INDIVIDUAL',
  email: 'owner@example.com',
  password: 'Correct-Horse-Battery-9',
  displayName: 'Acme Studio',
  contactPhone: '+49 30 1234567',
  addressLine1: 'Musterstraße 1',
  postalCode: '10115',
  city: 'Berlin',
  country: 'DE',
  firstName: 'Jane',
  lastName: 'Doe',
  isSmallBusiness: false,
};

describe('OrganizationRegistrationService', () => {
  it('creates the organization, the owner, a Stripe account and a session', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          organization: {
            create: vi.fn().mockResolvedValue({ id: 'org_1', slug: 'acme-studio' }),
          },
          organizationSettings: { create: vi.fn().mockResolvedValue({ id: 'settings_1' }) },
          officeUser: {
            create: vi.fn().mockResolvedValue({
              id: 'user_1',
              organizationId: 'org_1',
              role: 'OWNER',
              canIssueRefunds: true,
              employeeId: null,
            }),
          },
        }),
      ),
      organization: { update: vi.fn().mockResolvedValue({}) },
    };

    const passwords = { hash: vi.fn().mockResolvedValue('hashed') };
    const sessions = { create: vi.fn().mockResolvedValue('sid_1') };
    const stripeConnect = {
      createExpressAccount: vi.fn().mockResolvedValue({ stripeAccountId: 'acct_1' }),
      createAccountLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/x' }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationRegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwords },
        { provide: SessionStore, useValue: sessions },
        { provide: StripeConnectService, useValue: stripeConnect },
        { provide: ENV, useValue: { PUBLIC_WEB_ORIGIN: 'https://app.example.com' } },
      ],
    }).compile();

    const service = moduleRef.get(OrganizationRegistrationService);
    const result = await service.register(REQUEST);

    expect(result.response).toEqual({
      id: 'org_1',
      slug: 'acme-studio',
      onboardingLink: 'https://connect.stripe.com/x',
    });
    expect(result.sid).toBe('sid_1');
    expect(passwords.hash).toHaveBeenCalledWith(REQUEST.password);
    expect(stripeConnect.createExpressAccount).toHaveBeenCalledWith({
      email: REQUEST.email,
      country: 'DE',
      businessType: 'individual',
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-registration.service`
Expected: FAIL — `./organization-registration.service.js` does not exist.

- [ ] **Step 7: Write `apps/api/src/organization/organization-registration.service.ts`**

```typescript
import { Injectable } from '@nestjs/common';

import { PasswordService } from '../auth/password.service.js';
import { SessionStore } from '../auth/session.store.js';
import { AppError } from '../common/errors/app-error.js';
import { isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { slugify, slugSuffix } from './slug.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { RegisterOrganizationRequest, RegisterOrganizationResponse } from '@shape-and-flow/booking-contracts';

const MAX_SLUG_ATTEMPTS = 5;

/** Business type Stripe expects, derived from the same discriminant the request already carries. */
function businessTypeFor(entityType: RegisterOrganizationRequest['entityType']): 'individual' | 'company' {
  return entityType === 'ORGANIZATION' ? 'company' : 'individual';
}

/** Legal name Stripe and the Organization row both use. */
function legalNameFor(request: RegisterOrganizationRequest): string {
  if (request.entityType === 'INDIVIDUAL') {
    return `${request.firstName} ${request.lastName}`;
  }
  return request.companyName;
}

@Injectable()
export class OrganizationRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionStore,
    private readonly stripeConnect: StripeConnectService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  async register(
    request: RegisterOrganizationRequest,
  ): Promise<{ response: RegisterOrganizationResponse; sid: string }> {
    const passwordHash = await this.passwords.hash(request.password);
    const { organization, owner } = await this.createOrganizationAndOwner(request, passwordHash);

    const onboardingLink = await this.startStripeOnboarding(request, organization.id);

    const sid = await this.sessions.create({
      id: owner.id,
      organizationId: owner.organizationId,
      role: owner.role,
      canIssueRefunds: owner.canIssueRefunds,
      employeeId: owner.employeeId,
    });

    return {
      response: { id: organization.id, slug: organization.slug, onboardingLink },
      sid,
    };
  }

  private async createOrganizationAndOwner(
    request: RegisterOrganizationRequest,
    passwordHash: string,
  ): Promise<{
    organization: { id: string; slug: string };
    owner: { id: string; organizationId: string; role: 'OWNER'; canIssueRefunds: boolean; employeeId: string | null };
  }> {
    const base = slugify(request.displayName);
    const legalName = legalNameFor(request);

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const slug = attempt === 0 ? base : `${base}-${slugSuffix()}`;

      try {
        return await this.prisma.$transaction(async (tx) => {
          const organization = await tx.organization.create({
            data: {
              slug,
              name: request.displayName,
              legalName,
              contactEmail: request.email,
              contactPhone: request.contactPhone,
              ...(request.whatsappNumber === undefined ? {} : { whatsappNumber: request.whatsappNumber }),
              addressLine1: request.addressLine1,
              ...(request.addressLine2 === undefined ? {} : { addressLine2: request.addressLine2 }),
              postalCode: request.postalCode,
              city: request.city,
              country: request.country,
              entityType: request.entityType,
              isSmallBusiness: request.isSmallBusiness,
              ...(request.entityType === 'INDIVIDUAL' || request.entityType === 'SOLE_PROPRIETORSHIP'
                ? { ownerFirstName: request.firstName, ownerLastName: request.lastName }
                : {}),
              ...(request.entityType === 'SOLE_PROPRIETORSHIP' || request.entityType === 'ORGANIZATION'
                ? {}
                : {}),
              ...(request.taxId === undefined ? {} : { taxId: request.taxId }),
              ...(request.vatId === undefined ? {} : { vatId: request.vatId }),
            },
          });

          await tx.organizationSettings.create({
            data: {
              organizationId: organization.id,
              officeNotificationEmail: request.email,
            },
          });

          const owner = await tx.officeUser.create({
            data: {
              organizationId: organization.id,
              email: request.email,
              passwordHash,
              firstName: request.entityType === 'ORGANIZATION' ? request.companyName : request.firstName,
              lastName: request.entityType === 'ORGANIZATION' ? '' : request.lastName,
              role: 'OWNER',
              canIssueRefunds: true,
            },
          });

          return {
            organization: { id: organization.id, slug: organization.slug },
            owner: {
              id: owner.id,
              organizationId: owner.organizationId,
              role: 'OWNER' as const,
              canIssueRefunds: owner.canIssueRefunds,
              employeeId: null,
            },
          };
        });
      } catch (error) {
        if (isUniqueViolation(error, 'slug') && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
        if (isUniqueViolation(error, 'slug')) {
          throw new AppError('ORGANIZATION_CREATE_ERROR', {
            message: 'Could not allocate a unique slug for this organization.',
          });
        }
        throw error;
      }
    }

    throw new AppError('ORGANIZATION_CREATE_ERROR', {
      message: 'Could not allocate a unique slug for this organization.',
    });
  }

  private async startStripeOnboarding(
    request: RegisterOrganizationRequest,
    organizationId: string,
  ): Promise<string | null> {
    try {
      const { stripeAccountId } = await this.stripeConnect.createExpressAccount({
        email: request.email,
        country: request.country,
        businessType: businessTypeFor(request.entityType),
      });

      await this.prisma.organization.update({
        where: { id: organizationId },
        data: { stripeAccountId },
      });

      const returnUrl = request.returnUrl ?? this.defaultReturnUrl();
      const { url } = await this.stripeConnect.createAccountLink(stripeAccountId, returnUrl);
      return url;
    } catch {
      // The organization and its owner are already committed. Onboarding can be
      // retried from the office via POST /office/organization/onboarding-link
      // (Task 7) — there is nothing to roll back here.
      return null;
    }
  }

  private defaultReturnUrl(): string {
    return `${this.config.PUBLIC_WEB_ORIGIN}/office/onboarding-status`;
  }
}
```

Add the matching imports at the top of this file:

```typescript
import { Inject, Injectable } from '@nestjs/common';

import { ENV } from '../config/env.schema.js';

import type { AppConfig } from '../config/env.schema.js';
```

(`Inject`/`Injectable` replace the earlier bare `Injectable`-only import; `ENV`/`AppConfig` are new.)

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-registration.service`
Expected: PASS.

- [ ] **Step 9: Write `apps/api/src/organization/organization-registration.controller.ts`**

```typescript
import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { registerOrganizationRequestSchema } from '@shape-and-flow/booking-contracts';

import { Public } from '../common/guards/public.decorator.js';
import { ENV } from '../config/env.schema.js';

import { OrganizationRegistrationService } from './organization-registration.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type { RegisterOrganizationResponse } from '@shape-and-flow/booking-contracts';
import type { CookieOptions, Response } from 'express';

@Controller('public')
@Public()
export class OrganizationRegistrationController {
  constructor(
    private readonly registrations: OrganizationRegistrationService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  @Post('organizations')
  @HttpCode(201)
  async register(
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegisterOrganizationResponse> {
    const body = registerOrganizationRequestSchema.parse(rawBody);
    const { response: result, sid } = await this.registrations.register(body);

    response.cookie(this.config.SESSION_COOKIE_NAME, sid, this.cookieOptions());
    return result;
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api',
    };
  }
}
```

- [ ] **Step 10: Register the new providers and controller in `OrganizationModule`**

In `apps/api/src/organization/organization.module.ts`, add `OrganizationRegistrationService`, `OrganizationRegistrationController`, and `StripeConnectService` to `providers`; add `controllers: [OrganizationRegistrationController]`.

- [ ] **Step 11: Run the full API suite to verify nothing regressed**

Run: `pnpm --filter @shape-and-flow/booking-api test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/organization
git commit -m "feat(api): add POST /public/organizations registration endpoint"
```

---

### Task 7: OWNER-only onboarding-link retry endpoint

**Files:**
- Create: `apps/api/src/organization/organization-onboarding.controller.ts`
- Modify: `apps/api/src/organization/organization.module.ts`
- Test: `apps/api/test/integration/organization-onboarding.int.spec.ts`

**Interfaces:**
- Consumes: `StripeConnectService` (Task 5), `CsrfHeaderGuard`, `RolesGuard`, `Roles`, `OfficeRoute`, `CurrentUser` (all from `apps/api/src/auth/`), `Audited` (from `apps/api/src/common/audit/audit.interceptor.ts`), `OrganizationContextService.getOrganizationId()`.
- Produces: `POST /office/organization/onboarding-link` → `{ onboardingLink: string }`.

- [ ] **Step 1: Write `apps/api/src/organization/organization-onboarding.controller.ts`**

```typescript
import { Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute } from '../auth/office-session.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited } from '../common/audit/audit.interceptor.js';
import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { OrganizationContextService } from './organization-context.service.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { AppConfig } from '../config/env.schema.js';

@Controller('office/organization')
@UseGuards(CsrfHeaderGuard, RolesGuard)
@OfficeRoute()
export class OrganizationOnboardingController {
  constructor(
    private readonly organizations: OrganizationContextService,
    private readonly stripeConnect: StripeConnectService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  @Get()
  @Roles('OWNER', 'STAFF')
  current(): { stripeChargesEnabled: boolean } {
    return { stripeChargesEnabled: this.organizations.get().stripeChargesEnabled };
  }

  @Post('onboarding-link')
  @Roles('OWNER')
  @Audited({ action: 'ORGANIZATION_ONBOARDING_LINK_REQUESTED', entityType: 'Organization' })
  async requestOnboardingLink(): Promise<{ onboardingLink: string }> {
    const organization = this.organizations.get();
    const returnUrl = `${this.config.PUBLIC_WEB_ORIGIN}/office/onboarding-status`;

    let stripeAccountId = organization.stripeAccountId;

    if (stripeAccountId === null) {
      const created = await this.stripeConnect.createExpressAccount({
        email: organization.contactEmail,
        country: organization.country,
        businessType: organization.entityType === 'ORGANIZATION' ? 'company' : 'individual',
      });
      stripeAccountId = created.stripeAccountId;

      await this.prisma.organization.update({
        where: { id: organization.id },
        data: { stripeAccountId },
      });
    }

    try {
      const { url } = await this.stripeConnect.createAccountLink(stripeAccountId, returnUrl);
      return { onboardingLink: url };
    } catch (error) {
      throw new AppError('ONBOARDING_LINK_ERROR', {
        message: 'Could not create a Stripe onboarding link. Please try again shortly.',
        cause: error,
      });
    }
  }
}
```

- [ ] **Step 2: Register the controller in `OrganizationModule`**

Add `OrganizationOnboardingController` to `organization.module.ts`'s `controllers` array.

- [ ] **Step 3: Write the integration test**

Create `apps/api/test/integration/organization-onboarding.int.spec.ts` (using the same `createBookingTestApp`/`resetDatabase` harness pattern as the existing suites in `apps/api/test/integration/`, seeding an `Organization` + `OWNER` `OfficeUser`, logging in via `POST /api/auth/login`, then asserting `POST /api/office/organization/onboarding-link` returns 201 with `onboardingLink` when the fake Stripe provider is wired, and 403 when called by a non-OWNER role).

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- organization-onboarding`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/organization/organization-onboarding.controller.ts apps/api/src/organization/organization.module.ts apps/api/test/integration/organization-onboarding.int.spec.ts
git commit -m "feat(api): add OWNER-only onboarding-link retry endpoint"
```

---

### Task 8: `account.updated` webhook handling

**Files:**
- Create: `apps/api/src/organization/organization-webhook.handler.ts`
- Modify: `apps/api/src/booking/processors/stripe-event.processor.ts`
- Modify: `apps/api/src/organization/organization.module.ts` (export the handler if `stripe-event.processor.ts` lives in `BookingModule` and needs it injected — see Step 4)
- Test: `apps/api/src/organization/organization-webhook.handler.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `OrganizationWebhookHandler.handles(type: string): boolean`, `OrganizationWebhookHandler.handle(type: string, object: unknown): Promise<void>` — same shape as `RefundWebhookHandler`.

- [ ] **Step 1: Write the failing handler test**

Create `apps/api/src/organization/organization-webhook.handler.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma/prisma.service.js';

import { OrganizationWebhookHandler } from './organization-webhook.handler.js';

describe('OrganizationWebhookHandler', () => {
  it('handles only account.updated', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrganizationWebhookHandler, { provide: PrismaService, useValue: {} }],
    }).compile();

    const handler = moduleRef.get(OrganizationWebhookHandler);
    expect(handler.handles('account.updated')).toBe(true);
    expect(handler.handles('checkout.session.completed')).toBe(false);
  });

  it('updates stripeDetailsSubmitted and stripeChargesEnabled from the account object', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = { organization: { update } };

    const moduleRef = await Test.createTestingModule({
      providers: [OrganizationWebhookHandler, { provide: PrismaService, useValue: prisma }],
    }).compile();

    const handler = moduleRef.get(OrganizationWebhookHandler);
    await handler.handle('account.updated', {
      id: 'acct_1',
      details_submitted: true,
      charges_enabled: false,
    });

    expect(update).toHaveBeenCalledWith({
      where: { stripeAccountId: 'acct_1' },
      data: { stripeDetailsSubmitted: true, stripeChargesEnabled: false },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-webhook.handler`
Expected: FAIL — `./organization-webhook.handler.js` does not exist.

- [ ] **Step 3: Write `apps/api/src/organization/organization-webhook.handler.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

const ACCOUNT_EVENT_TYPES = {
  UPDATED: 'account.updated',
} as const;

interface AccountObjectShape {
  id?: unknown;
  details_submitted?: unknown;
  charges_enabled?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Translates a Stripe Connect `account.updated` event into the Organization's
 * verification flags.
 *
 * Kept apart from the Stripe event processor for the same reason
 * `RefundWebhookHandler` is: that class decides which booking (here,
 * organization) an event is about, this one decides what the event means.
 */
@Injectable()
export class OrganizationWebhookHandler {
  private readonly logger = new Logger('OrganizationWebhook');

  constructor(private readonly prisma: PrismaService) {}

  handles(type: string): boolean {
    return (Object.values(ACCOUNT_EVENT_TYPES) as string[]).includes(type);
  }

  async handle(type: string, object: unknown): Promise<void> {
    const account = (object ?? {}) as AccountObjectShape;
    const stripeAccountId = readString(account.id);

    if (stripeAccountId === undefined) {
      this.logger.debug(`${type} carried no account id; nothing to apply`);
      return;
    }

    await this.prisma.organization.update({
      where: { stripeAccountId },
      data: {
        stripeDetailsSubmitted: account.details_submitted === true,
        stripeChargesEnabled: account.charges_enabled === true,
      },
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-webhook.handler`
Expected: PASS.

- [ ] **Step 5: Wire it into `StripeEventProcessor`**

In `apps/api/src/booking/processors/stripe-event.processor.ts`, add the import:

```typescript
import { OrganizationWebhookHandler } from '../../organization/organization-webhook.handler.js';
```

Change the constructor:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: InboxRecorder,
    private readonly confirmations: BookingConfirmationService,
    private readonly refunds: RefundWebhookHandler,
    private readonly organizations: OrganizationWebhookHandler,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
```

Change `dispatch()`'s start:

```typescript
  private async dispatch(type: string, rawPayload: unknown, eventId: string): Promise<void> {
    const event = rawPayload as StripeEventShape;
    const object = event.data?.object ?? {};

    // Refund events are a separate concern: this class decides which booking an event is
    // about, and that one decides what a refund event means.
    if (this.refunds.handles(type)) {
      await this.refunds.handle(type, object);
      return;
    }

    if (this.organizations.handles(type)) {
      await this.organizations.handle(type, object);
      return;
    }

    switch (type) {
```

- [ ] **Step 6: Register `OrganizationWebhookHandler` where `StripeEventProcessor` is provided**

Find the module that provides `StripeEventProcessor` (the `BookingModule`) and add `OrganizationWebhookHandler` to its `providers`, importing `OrganizationModule` if `PrismaService` scoping requires it (it does not — `OrganizationWebhookHandler` only depends on `PrismaService`, already global via `PrismaModule`).

- [ ] **Step 7: Run the full API unit suite to verify nothing regressed**

Run: `pnpm --filter @shape-and-flow/booking-api test`
Expected: PASS, including existing `stripe-event.processor.spec.ts` cases (refund dispatch untouched, new branch added but not triggered by existing fixtures).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/organization/organization-webhook.handler.ts apps/api/src/organization/organization-webhook.handler.spec.ts apps/api/src/booking/processors/stripe-event.processor.ts
git commit -m "feat(api): update Organization Stripe flags from account.updated webhook"
```

---

### Task 9: Frontend — registration page, onboarding status page, router, client, copy

**Files:**
- Create: `apps/web/src/pages/public/RegisterOrganizerPage.vue`
- Create: `apps/web/src/pages/office/OnboardingStatusPage.vue`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/errors.ts`
- Modify: `apps/web/src/office/messages.ts`
- Test: `apps/web/src/pages/public/RegisterOrganizerPage.spec.ts`

**Interfaces:**
- Consumes: `registerOrganizationRequestSchema`/`RegisterOrganizationResponse` from `@shape-and-flow/booking-contracts`, `SfInput`/`SfSelect` from `@shape-and-flow/booking-ui` (`packages/ui/src/components/`).
- Produces: `api.public.registerOrganization(body: RegisterOrganizationRequest): Promise<RegisterOrganizationResponse>`, `api.office.organization.requestOnboardingLink(): Promise<{ onboardingLink: string }>`, routes `/organizer/registrieren` and `/office/onboarding-status`.

- [ ] **Step 1: Add the client methods**

In `apps/web/src/api/client.ts`, inside the `api.public` namespace object, add:

```typescript
registerOrganization: (body: RegisterOrganizationRequest) =>
  request<RegisterOrganizationResponse>('/public/organizations', { method: 'POST', body }),
```

Inside the `api.office` namespace, add an `organization` sub-object (or extend an existing one):

```typescript
organization: {
  current: () =>
    request<{ stripeChargesEnabled: boolean }>('/office/organization', { session: true }),
  requestOnboardingLink: () =>
    request<{ onboardingLink: string }>('/office/organization/onboarding-link', {
      method: 'POST',
      session: true,
    }),
},
```

Add the matching type imports at the top of the file:

```typescript
import type { RegisterOrganizationRequest, RegisterOrganizationResponse } from '@shape-and-flow/booking-contracts';
```

- [ ] **Step 2: Add error-code copy**

In `apps/web/src/api/errors.ts`, add `INVALID_RETURN_URL`, `ORGANIZATION_CREATE_ERROR`, `ONBOARDING_LINK_ERROR` to the `MessageKey` union and to `messageKeyFor()`'s mapping — plain English, per the existing `ENGLISH_ONLY` convention for this file (public-facing).

In `apps/web/src/office/messages.ts`, add `ONBOARDING_LINK_ERROR` to the `MESSAGES` record (used by the retry button on the office side):

```typescript
ONBOARDING_LINK_ERROR: 'Could not reach Stripe. Please try again in a moment.',
```

- [ ] **Step 3: Write the failing component test**

Create `apps/web/src/pages/public/RegisterOrganizerPage.spec.ts`:

```typescript
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client.js';

import RegisterOrganizerPage from './RegisterOrganizerPage.vue';

vi.mock('../../api/client.js', () => ({
  api: { public: { registerOrganization: vi.fn() } },
}));

describe('RegisterOrganizerPage', () => {
  it('redirects to the onboarding link on successful submit', async () => {
    vi.mocked(api.public.registerOrganization).mockResolvedValue({
      id: 'org_1',
      slug: 'acme-studio',
      onboardingLink: 'https://connect.stripe.com/x',
    });

    const originalLocation = window.location;
    // @ts-expect-error -- test-only reassignment to observe the redirect
    delete window.location;
    // @ts-expect-error -- test-only stub
    window.location = { href: '' };

    const wrapper = mount(RegisterOrganizerPage);
    await wrapper.find('[data-test="entity-type"]').setValue('INDIVIDUAL');
    await wrapper.find('[data-test="display-name"]').setValue('Acme Studio');
    await wrapper.find('[data-test="email"]').setValue('owner@example.com');
    await wrapper.find('[data-test="password"]').setValue('Correct-Horse-Battery-9');
    await wrapper.find('[data-test="first-name"]').setValue('Jane');
    await wrapper.find('[data-test="last-name"]').setValue('Doe');
    await wrapper.find('form').trigger('submit');
    await wrapper.vm.$nextTick();

    expect(window.location.href).toBe('https://connect.stripe.com/x');
    window.location = originalLocation;
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-web test -- RegisterOrganizerPage`
Expected: FAIL — `./RegisterOrganizerPage.vue` does not exist.

- [ ] **Step 5: Write `apps/web/src/pages/public/RegisterOrganizerPage.vue`**

```vue
<script setup lang="ts">
import { computed, reactive } from 'vue';
import { SfInput, SfSelect } from '@shape-and-flow/booking-ui';

import { api } from '../../api/client.js';
import { toApiError } from '../../api/errors.js';

const form = reactive({
  entityType: 'INDIVIDUAL' as 'INDIVIDUAL' | 'SOLE_PROPRIETORSHIP' | 'ORGANIZATION',
  displayName: '',
  companyName: '',
  email: '',
  password: '',
  firstName: '',
  lastName: '',
  contactPhone: '',
  addressLine1: '',
  postalCode: '',
  city: '',
  country: 'DE',
  isSmallBusiness: false,
});

const error = reactive<{ message: string | null }>({ message: null });
const submitting = reactive<{ value: boolean }>({ value: false });

const needsCompanyName = computed(() => form.entityType !== 'INDIVIDUAL');
const needsOwnerName = computed(() => form.entityType !== 'ORGANIZATION');

async function onSubmit(): Promise<void> {
  error.message = null;
  submitting.value = true;

  try {
    const body = {
      entityType: form.entityType,
      displayName: form.displayName,
      email: form.email,
      password: form.password,
      contactPhone: form.contactPhone,
      addressLine1: form.addressLine1,
      postalCode: form.postalCode,
      city: form.city,
      country: form.country,
      isSmallBusiness: form.isSmallBusiness,
      ...(needsCompanyName.value ? { companyName: form.companyName } : {}),
      ...(needsOwnerName.value ? { firstName: form.firstName, lastName: form.lastName } : {}),
    };

    const result = await api.public.registerOrganization(
      body as Parameters<typeof api.public.registerOrganization>[0],
    );

    if (result.onboardingLink) {
      window.location.href = result.onboardingLink;
    }
  } catch (caught) {
    error.message = toApiError(caught).message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="mx-auto flex max-w-md flex-col gap-4 p-6" @submit.prevent="onSubmit">
    <SfSelect
      data-test="entity-type"
      v-model="form.entityType"
      label="Account type"
      :options="[
        { value: 'INDIVIDUAL', label: 'Individual' },
        { value: 'SOLE_PROPRIETORSHIP', label: 'Sole proprietorship' },
        { value: 'ORGANIZATION', label: 'Organization' },
      ]"
      required
    />
    <SfInput data-test="display-name" v-model="form.displayName" label="Business name" required />
    <SfInput
      v-if="needsCompanyName"
      data-test="company-name"
      v-model="form.companyName"
      label="Legal company name"
      required
    />
    <SfInput data-test="email" v-model="form.email" type="email" label="Email" required />
    <SfInput data-test="password" v-model="form.password" type="password" label="Password" required />
    <SfInput
      v-if="needsOwnerName"
      data-test="first-name"
      v-model="form.firstName"
      label="First name"
      required
    />
    <SfInput
      v-if="needsOwnerName"
      data-test="last-name"
      v-model="form.lastName"
      label="Last name"
      required
    />
    <SfInput data-test="contact-phone" v-model="form.contactPhone" type="tel" label="Phone" required />
    <SfInput data-test="address-line-1" v-model="form.addressLine1" label="Address" required />
    <SfInput data-test="postal-code" v-model="form.postalCode" label="Postal code" required />
    <SfInput data-test="city" v-model="form.city" label="City" required />
    <p v-if="error.message" class="text-sm font-medium text-text-primary">{{ error.message }}</p>
    <button type="submit" :disabled="submitting.value" class="rounded-sf bg-primary px-4 py-2.5 text-white">
      Create account
    </button>
  </form>
</template>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-web test -- RegisterOrganizerPage`
Expected: PASS.

- [ ] **Step 7: Write `apps/web/src/pages/office/OnboardingStatusPage.vue`**

```vue
<script setup lang="ts">
import { onMounted, reactive } from 'vue';

import { api } from '../../api/client.js';
import { MESSAGES } from '../../office/messages.js';

type Status = 'checking' | 'ready' | 'pending' | 'failed';

const state = reactive<{ status: Status; error: string | null }>({
  status: 'checking',
  error: null,
});

onMounted(async () => {
  try {
    const organization = await api.office.organization.current();
    state.status = organization.stripeChargesEnabled ? 'ready' : 'pending';
  } catch {
    state.status = 'failed';
  }
});

async function retry(): Promise<void> {
  state.error = null;
  try {
    const { onboardingLink } = await api.office.organization.requestOnboardingLink();
    window.location.href = onboardingLink;
  } catch {
    state.error = MESSAGES.ONBOARDING_LINK_ERROR;
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-4 p-6">
    <p v-if="state.status === 'checking'">Checking your Stripe onboarding status…</p>
    <p v-else-if="state.status === 'ready'">Your account is ready. <a href="/office">Go to the dashboard</a>.</p>
    <p v-else-if="state.status === 'pending'">
      Stripe is still processing your details. Reload this page in a minute.
    </p>
    <div v-else>
      <p>Something went wrong finishing your Stripe onboarding.</p>
      <button type="button" @click="retry">Retry onboarding</button>
      <p v-if="state.error">{{ state.error }}</p>
    </div>
  </div>
</template>
```

- [ ] **Step 8: Add the router entries**

In `apps/web/src/router/index.ts`, add to the flat public routes:

```typescript
{
  path: '/organizer/registrieren',
  name: 'register-organizer',
  component: () => import('../pages/public/RegisterOrganizerPage.vue'),
},
```

Add to the `/office` parent's `children`:

```typescript
{
  path: 'onboarding-status',
  name: 'onboarding-status',
  component: () => import('../pages/office/OnboardingStatusPage.vue'),
  meta: { area: 'office', requiresSession: true },
},
```

- [ ] **Step 9: Run the web unit suite to verify nothing regressed**

Run: `pnpm --filter @shape-and-flow/booking-web test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/pages/public/RegisterOrganizerPage.vue apps/web/src/pages/office/OnboardingStatusPage.vue apps/web/src/pages/public/RegisterOrganizerPage.spec.ts apps/web/src/router/index.ts apps/web/src/api/client.ts apps/web/src/api/errors.ts apps/web/src/office/messages.ts
git commit -m "feat(web): add organizer registration and onboarding status pages"
```

---

### Task 10: Integration test — full registration flow

**Files:**
- Create: `apps/api/test/integration/organization-registration.int.spec.ts`
- Modify: `apps/api/test/booking-app.harness.ts` (only if the fake Stripe Connect double needs a new export — see Step 2)

**Interfaces:**
- Consumes: `createBookingTestApp` and `resetDatabase`/`prisma` from `apps/api/test/booking-app.harness.ts` / `apps/api/test/database.harness.ts` (the existing harness pattern used by every `*.int.spec.ts` file in `apps/api/test/integration/`), `OrganizationModule`.

- [ ] **Step 1: Write the integration test**

Create `apps/api/test/integration/organization-registration.int.spec.ts`, following the same `beforeAll`/`afterAll`/`beforeEach` shape as the existing suites in `apps/api/test/integration/` (e.g. `auth.int.spec.ts`): build the app via the harness with `OrganizationModule` in `imports`, call `resetDatabase()` in `beforeEach`, then:

```typescript
import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { OrganizationModule } from '../../src/organization/organization.module.js';
import { resetDatabase } from '../database.harness.js';

import { createBookingTestApp } from '../booking-app.harness.js';

import type { TestApp } from '../public-app.harness.js';

describe('POST /api/public/organizations', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createBookingTestApp({ imports: [OrganizationModule] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('registers an INDIVIDUAL organizer and returns an onboarding link', async () => {
    const res = await request(app.server())
      .post('/api/public/organizations')
      .send({
        entityType: 'INDIVIDUAL',
        displayName: 'Acme Studio',
        email: 'owner@example.com',
        password: 'Correct-Horse-Battery-9',
        firstName: 'Jane',
        lastName: 'Doe',
        contactPhone: '+49 30 1234567',
        addressLine1: 'Musterstraße 1',
        postalCode: '10115',
        city: 'Berlin',
        country: 'DE',
      });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('acme-studio');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('retries the slug on collision', async () => {
    await request(app.server()).post('/api/public/organizations').send({
      entityType: 'INDIVIDUAL',
      displayName: 'Acme Studio',
      email: 'first@example.com',
      password: 'Correct-Horse-Battery-9',
      firstName: 'Jane',
      lastName: 'Doe',
      contactPhone: '+49 30 1234567',
      addressLine1: 'Musterstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    });

    const res = await request(app.server()).post('/api/public/organizations').send({
      entityType: 'INDIVIDUAL',
      displayName: 'Acme Studio',
      email: 'second@example.com',
      password: 'Correct-Horse-Battery-9',
      firstName: 'John',
      lastName: 'Smith',
      contactPhone: '+49 30 1234567',
      addressLine1: 'Musterstraße 2',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    });

    expect(res.status).toBe(201);
    expect(res.body.slug).not.toBe('acme-studio');
    expect(res.body.slug).toMatch(/^acme-studio-/);
  });

  it('resolves the public availability endpoint by ?organizer=<slug>', async () => {
    const created = await request(app.server()).post('/api/public/organizations').send({
      entityType: 'ORGANIZATION',
      displayName: 'Second Org',
      companyName: 'Second Org GmbH',
      email: 'owner2@example.com',
      password: 'Correct-Horse-Battery-9',
      contactPhone: '+49 30 1234567',
      addressLine1: 'Musterstraße 3',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    });

    const res = await request(app.server()).get(
      `/api/public/services?organizer=${created.body.slug}`,
    );

    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement any missing wiring it surfaces**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- organization-registration`
Expected: FAIL initially if `createBookingTestApp` does not yet accept an `imports` option that layers `OrganizationModule` on top of `BookingModule`/`PublicModule` — if so, extend `apps/api/test/booking-app.harness.ts`'s `createBookingTestApp` to merge caller-supplied `imports` the same way `createPublicTestApp` already does (`...options.imports` in the `Test.createTestingModule` call), rather than introducing a second harness function.

- [ ] **Step 3: Run it again to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- organization-registration`
Expected: PASS, all 3 cases.

- [ ] **Step 4: Run the full test suite (unit + integration) once more end-to-end**

Run: `pnpm --filter @shape-and-flow/booking-api test && pnpm --filter @shape-and-flow/booking-api test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/integration/organization-registration.int.spec.ts apps/api/test/booking-app.harness.ts
git commit -m "test(api): add organization registration integration coverage"
```

---

## Verification

- `pnpm --filter @shape-and-flow/booking-api test` and `pnpm --filter @shape-and-flow/booking-api test:integration` both green.
- `pnpm --filter @shape-and-flow/booking-contracts test` green.
- `pnpm --filter @shape-and-flow/booking-web test` green.
- Manual run: `POST /public/organizations` against a local DB with Stripe test-mode keys, all three `entityType` variants, followed by the Stripe test-mode redirect and return to `OnboardingStatusPage`, confirming the session cookie is present and `/office` is reachable without a second login.
- `?organizer=<slug>` resolves a second Organization's public catalog/availability without touching the office session middleware's resolution.
