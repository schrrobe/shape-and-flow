# Organizer-Onboarding Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 3 Critical + 6 Important findings from the organizer-onboarding final whole-branch review (ledger: `.superpowers/sdd/2026-08-07-organizer-onboarding/progress.md`) so a second organization can log back in, never has its live payments hijacked by an incomplete Stripe Connect account, and can always recover from a failed onboarding — before this branch merges.

**Architecture:** `OfficeUser.email` becomes globally unique (was `@@unique([organizationId, email])`), so login/password-reset become a plain global lookup instead of depending on tenant context that `/api/auth` never had. Stripe Connect routing gates on `stripeChargesEnabled`, not merely `stripeAccountId` presence, via one shared `connectAccountId()` helper used at all four call sites. Worker/queue paths and `/api/manage` get direct, ALS-independent ways to reach a specific organization's context, instead of silently reading the bootstrap default. Both tenant-resolution middlewares reject an offered-but-invalid identity instead of falling through to the default org.

**Tech Stack:** NestJS, Prisma 7.9.1/Postgres, Zod (`@shape-and-flow/booking-contracts`), Stripe Connect, Vue 3 (`apps/web`), Vitest/Supertest.

## Global Constraints

- Package names for `pnpm --filter`: API `@shape-and-flow/booking-api`, web `@shape-and-flow/booking-web`, contracts `@shape-and-flow/booking-contracts`. Working directory for every command in this plan is `booking-app/` (the pnpm workspace root inside this worktree).
- Every existing suite must stay green throughout: unit + integration for the API, contracts, and web. Run the full suite at the end of every task, not just the new test.
- No cross-task placeholders — every step below has the exact code to write.
- `OrganizationContextService`'s existing public methods (`get()`, `getOrganizationId()`, `getSettings()`, `getTimezone()`, `require()`) keep their exact current shape; this plan only adds new methods alongside them.
- New error codes added to `packages/contracts/src/errors.ts`'s `errorCodeSchema` MUST get a copy entry in `apps/web/src/i18n/en.json`, `apps/web/src/i18n/de.json`, and `apps/web/src/office/messages.ts` in the same task — the web test suite (`i18n.spec.ts`, `messages.spec.ts`) asserts exhaustiveness against `errorCodeSchema.options` and will fail to compile/pass otherwise.
- Migration folders under `apps/api/prisma/migrations/` follow `YYYYMMDDHHMMSS_snake_case_name`. The most recent existing folder is `20260807051525_organizer_onboarding` — the new one in this plan must sort after it.

---

### Task 1: Schema/contracts prep — global email uniqueness + 3 error codes

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260807120000_office_user_email_global_unique/migration.sql`
- Modify: `apps/api/src/organization/demo-seed.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/contracts.spec.ts`
- Modify: `apps/web/src/office/messages.ts`
- Modify: `apps/web/src/office/messages.spec.ts` (no code change needed — its exhaustiveness test already iterates `errorCodeSchema.options`; run it to confirm)
- Modify: `apps/web/src/i18n/en.json`
- Modify: `apps/web/src/i18n/de.json`

**Interfaces:**
- Produces: `OfficeUser.email` is globally unique (Prisma `@unique`, no composite). `errorCodeSchema` gains `ORGANIZATION_NOT_FOUND` (404) and `ORGANIZATION_ONBOARDING_INCOMPLETE` (422). Later tasks (3, 2, 7) throw these codes.

- [ ] **Step 1: Write failing tests for the two new error codes**

In `packages/contracts/src/contracts.spec.ts`, add a new `it` right after the existing `'has a status for INVALID_RETURN_URL, ORGANIZATION_CREATE_ERROR, and ONBOARDING_LINK_ERROR'` test (inside the `describe('error codes', ...)` block):

```ts
  it('has a status for ORGANIZATION_NOT_FOUND and ORGANIZATION_ONBOARDING_INCOMPLETE', () => {
    expect(ERROR_STATUS.ORGANIZATION_NOT_FOUND).toBe(404);
    expect(ERROR_STATUS.ORGANIZATION_ONBOARDING_INCOMPLETE).toBe(422);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-contracts test -- contracts.spec`
Expected: FAIL — `ERROR_STATUS.ORGANIZATION_NOT_FOUND` is `undefined`, so `toBe(404)` fails (and TypeScript itself will already flag `ORGANIZATION_NOT_FOUND` as not a key of `ErrorCode`).

- [ ] **Step 3: Add the two codes to `errorCodeSchema` and `ERROR_STATUS`**

In `packages/contracts/src/errors.ts`, change:

```ts
export const errorCodeSchema = z.enum([
  'VALIDATION_FAILED', 'INVALID_RETURN_URL',
  'UNAUTHENTICATED',
  'CSRF_FAILED', 'FORBIDDEN_ROLE',
  'NOT_FOUND',
  'SLOT_UNAVAILABLE', 'IDEMPOTENT_REQUEST_IN_PROGRESS', 'BOOKING_NOT_CANCELLABLE', 'BOOKING_NOT_RESCHEDULABLE', 'REQUEST_ALREADY_DECIDED', 'EMPLOYEE_HAS_FUTURE_BOOKINGS', 'SERVICE_HAS_FUTURE_BOOKINGS', 'CATEGORY_NOT_EMPTY', 'CANNOT_MODIFY_SELF', 'PAYMENT_NOT_REFUNDABLE', 'NO_EMPLOYEE_AVAILABLE',
  'IDEMPOTENCY_KEY_REUSED', 'OUTSIDE_BOOKING_WINDOW', 'INVALID_STATUS_TRANSITION', 'ORGANIZATION_CREATE_ERROR',
  'RATE_LIMITED',
  'INTERNAL_ERROR', 'ONBOARDING_LINK_ERROR',
]);
```

to:

```ts
export const errorCodeSchema = z.enum([
  'VALIDATION_FAILED', 'INVALID_RETURN_URL',
  'UNAUTHENTICATED',
  'CSRF_FAILED', 'FORBIDDEN_ROLE',
  'NOT_FOUND', 'ORGANIZATION_NOT_FOUND',
  'SLOT_UNAVAILABLE', 'IDEMPOTENT_REQUEST_IN_PROGRESS', 'BOOKING_NOT_CANCELLABLE', 'BOOKING_NOT_RESCHEDULABLE', 'REQUEST_ALREADY_DECIDED', 'EMPLOYEE_HAS_FUTURE_BOOKINGS', 'SERVICE_HAS_FUTURE_BOOKINGS', 'CATEGORY_NOT_EMPTY', 'CANNOT_MODIFY_SELF', 'PAYMENT_NOT_REFUNDABLE', 'NO_EMPLOYEE_AVAILABLE',
  'IDEMPOTENCY_KEY_REUSED', 'OUTSIDE_BOOKING_WINDOW', 'INVALID_STATUS_TRANSITION', 'ORGANIZATION_CREATE_ERROR', 'ORGANIZATION_ONBOARDING_INCOMPLETE',
  'RATE_LIMITED',
  'INTERNAL_ERROR', 'ONBOARDING_LINK_ERROR',
]);
```

And change:

```ts
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400, INVALID_RETURN_URL: 400,
  UNAUTHENTICATED: 401,
  CSRF_FAILED: 403, FORBIDDEN_ROLE: 403,
  NOT_FOUND: 404,
  SLOT_UNAVAILABLE: 409, IDEMPOTENT_REQUEST_IN_PROGRESS: 409, BOOKING_NOT_CANCELLABLE: 409, BOOKING_NOT_RESCHEDULABLE: 409, REQUEST_ALREADY_DECIDED: 409, EMPLOYEE_HAS_FUTURE_BOOKINGS: 409, SERVICE_HAS_FUTURE_BOOKINGS: 409, CATEGORY_NOT_EMPTY: 409, CANNOT_MODIFY_SELF: 409, PAYMENT_NOT_REFUNDABLE: 409, NO_EMPLOYEE_AVAILABLE: 409,
  IDEMPOTENCY_KEY_REUSED: 422, OUTSIDE_BOOKING_WINDOW: 422, INVALID_STATUS_TRANSITION: 422, ORGANIZATION_CREATE_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500, ONBOARDING_LINK_ERROR: 500,
};
```

to:

```ts
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400, INVALID_RETURN_URL: 400,
  UNAUTHENTICATED: 401,
  CSRF_FAILED: 403, FORBIDDEN_ROLE: 403,
  NOT_FOUND: 404, ORGANIZATION_NOT_FOUND: 404,
  SLOT_UNAVAILABLE: 409, IDEMPOTENT_REQUEST_IN_PROGRESS: 409, BOOKING_NOT_CANCELLABLE: 409, BOOKING_NOT_RESCHEDULABLE: 409, REQUEST_ALREADY_DECIDED: 409, EMPLOYEE_HAS_FUTURE_BOOKINGS: 409, SERVICE_HAS_FUTURE_BOOKINGS: 409, CATEGORY_NOT_EMPTY: 409, CANNOT_MODIFY_SELF: 409, PAYMENT_NOT_REFUNDABLE: 409, NO_EMPLOYEE_AVAILABLE: 409,
  IDEMPOTENCY_KEY_REUSED: 422, OUTSIDE_BOOKING_WINDOW: 422, INVALID_STATUS_TRANSITION: 422, ORGANIZATION_CREATE_ERROR: 422, ORGANIZATION_ONBOARDING_INCOMPLETE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500, ONBOARDING_LINK_ERROR: 500,
};
```

- [ ] **Step 4: Run the contracts test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-contracts test -- contracts.spec`
Expected: PASS (all tests in the file, including the generic exhaustiveness test that iterates `errorCodeSchema.options`).

- [ ] **Step 5: Add copy for both codes to the office message map**

In `apps/web/src/office/messages.ts`, change:

```ts
  INVALID_STATUS_TRANSITION: 'That is not possible in the current status.',
  INVALID_RETURN_URL: 'That link is not valid. Please try again.',
  ORGANIZATION_CREATE_ERROR: 'The account could not be created. Check the details and try again.',
```

to:

```ts
  INVALID_STATUS_TRANSITION: 'That is not possible in the current status.',
  INVALID_RETURN_URL: 'That link is not valid. Please try again.',
  ORGANIZATION_CREATE_ERROR: 'The account could not be created. Check the details and try again.',
  ORGANIZATION_NOT_FOUND: 'That organizer could not be found.',
  ORGANIZATION_ONBOARDING_INCOMPLETE: 'This organizer has not finished setting up payments yet.',
```

- [ ] **Step 6: Add copy for both codes to both locale files**

In `apps/web/src/i18n/en.json`, inside the `"errors"` block, change:

```json
    "ORGANIZATION_CREATE_ERROR": "We could not create your account. Please check your details and try again.",
```

to:

```json
    "ORGANIZATION_CREATE_ERROR": "We could not create your account. Please check your details and try again.",
    "ORGANIZATION_NOT_FOUND": "We could not find that organizer.",
    "ORGANIZATION_ONBOARDING_INCOMPLETE": "This organizer has not finished setting up payments yet. Please check back soon.",
```

In `apps/web/src/i18n/de.json`, inside the `"errors"` block, change:

```json
    "ORGANIZATION_CREATE_ERROR": "Ihr Konto konnte nicht angelegt werden. Bitte überprüfen Sie Ihre Angaben und versuchen Sie es erneut.",
```

to:

```json
    "ORGANIZATION_CREATE_ERROR": "Ihr Konto konnte nicht angelegt werden. Bitte überprüfen Sie Ihre Angaben und versuchen Sie es erneut.",
    "ORGANIZATION_NOT_FOUND": "Wir konnten diesen Anbieter nicht finden.",
    "ORGANIZATION_ONBOARDING_INCOMPLETE": "Dieser Anbieter hat die Zahlungseinrichtung noch nicht abgeschlossen. Bitte versuchen Sie es später erneut.",
```

- [ ] **Step 7: Run the web test suite to verify the new copy compiles and passes exhaustiveness**

Run: `pnpm --filter @shape-and-flow/booking-web test -- messages.spec i18n.spec`
Expected: PASS — `messages.spec.ts`'s `'covers the codes contracts declares, and no more'` test and `i18n.spec.ts`'s `'cover every error code the api can return'`/`'have identical key sets'`/`'keeps German and English genuinely different'` tests all pass with the two new keys.

- [ ] **Step 8: Change the `OfficeUser` Prisma model to a global unique on `email`**

In `apps/api/prisma/schema.prisma`, inside `model OfficeUser`, change:

```prisma
  email               String
```

to:

```prisma
  email               String         @unique
```

and remove this line entirely:

```prisma
  @@unique([organizationId, email])
```

(Keep `@@index([organizationId, role])` and `@@index([organizationId, archivedAt])` — only the composite unique is removed.)

- [ ] **Step 9: Write the migration**

Create `apps/api/prisma/migrations/20260807120000_office_user_email_global_unique/migration.sql`:

```sql
-- DropIndex
DROP INDEX "office_users_organization_id_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "office_users_email_key" ON "office_users"("email");
```

- [ ] **Step 10: Apply the migration and regenerate the Prisma client**

Run: `pnpm --filter @shape-and-flow/booking-api prisma:migrate:dev --skip-seed`
Expected: migration applies cleanly against the local dev database (only one organization exists locally, so no duplicate-email collision is possible) and the Prisma client regenerates with `OfficeUser.email` as a plain unique field (no more `organizationId_email` compound-unique input type).

- [ ] **Step 11: Fix `demo-seed.ts`'s composite-key lookup, which no longer compiles**

In `apps/api/src/organization/demo-seed.ts`, inside `ensureUser()`, change:

```ts
  const existing = await prisma.officeUser.findUnique({
    where: { organizationId_email: { organizationId: user.organizationId, email: user.email } },
  });
```

to:

```ts
  const existing = await prisma.officeUser.findUnique({
    where: { email: user.email },
  });
```

- [ ] **Step 12: Verify the workspace typechecks and the full API suite still passes**

Run: `pnpm --filter @shape-and-flow/booking-api typecheck && pnpm --filter @shape-and-flow/booking-api test`
Expected: PASS. (This also confirms no other call site depended on the now-removed `organizationId_email` compound-unique input.)

- [ ] **Step 13: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260807120000_office_user_email_global_unique apps/api/src/organization/demo-seed.ts apps/api/src/generated packages/contracts/src/errors.ts packages/contracts/src/contracts.spec.ts apps/web/src/office/messages.ts apps/web/src/i18n/en.json apps/web/src/i18n/de.json
git commit -m "fix(api): make OfficeUser.email globally unique; add ORGANIZATION_NOT_FOUND/ORGANIZATION_ONBOARDING_INCOMPLETE error codes"
```

---

### Task 2: Critical 2 — gate Stripe Connect routing on `stripeChargesEnabled`

**Files:**
- Modify: `apps/api/src/providers/payment/payment-provider.ts`
- Modify: `apps/api/src/booking/booking-checkout.service.ts`
- Modify: `apps/api/src/booking/expiry.service.ts`
- Modify: `apps/api/src/payment/refund.service.ts`
- Modify: `apps/api/src/public/public-bookings.controller.ts`
- Test: `apps/api/src/providers/payment/payment-provider.spec.ts` (new)
- Test: `apps/api/test/integration/public-bookings.int.spec.ts` (existing file, new test case)

**Interfaces:**
- Consumes: `ORGANIZATION_ONBOARDING_INCOMPLETE` error code (Task 1).
- Produces: `connectAccountId(organization: { stripeAccountId: string | null; stripeChargesEnabled: boolean }): string | undefined`, exported from `apps/api/src/providers/payment/payment-provider.ts`. Used at all four Stripe-routing call sites in place of `organization.stripeAccountId ?? undefined`.

- [ ] **Step 1: Write the failing unit test for `connectAccountId`**

Create `apps/api/src/providers/payment/payment-provider.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { connectAccountId } from './payment-provider.js';

describe('connectAccountId', () => {
  it('returns undefined when no Stripe account exists yet', () => {
    expect(connectAccountId({ stripeAccountId: null, stripeChargesEnabled: false })).toBeUndefined();
  });

  it('returns undefined when an account exists but charges are not yet enabled', () => {
    expect(
      connectAccountId({ stripeAccountId: 'acct_123', stripeChargesEnabled: false }),
    ).toBeUndefined();
  });

  it('returns the account id once charges are enabled', () => {
    expect(connectAccountId({ stripeAccountId: 'acct_123', stripeChargesEnabled: true })).toBe(
      'acct_123',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- payment-provider.spec`
Expected: FAIL — `connectAccountId` is not exported from `payment-provider.ts`.

- [ ] **Step 3: Add `connectAccountId` to `payment-provider.ts`**

In `apps/api/src/providers/payment/payment-provider.ts`, right after the `PaymentAccountContext` interface, add:

```ts
/**
 * The Stripe Connect account to route to, or `undefined` to charge the platform account.
 *
 * Presence of `stripeAccountId` alone is not enough: the onboarding-link retry endpoint
 * persists it the moment a Stripe Express account is *created*, before onboarding
 * completes. Routing must wait for Stripe's own `account.updated` confirmation
 * (`stripeChargesEnabled`), or an organization mid-onboarding would have its checkout,
 * expiry, and refund calls silently rerouted to an account that cannot yet take charges.
 */
export function connectAccountId(organization: {
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
}): string | undefined {
  return organization.stripeAccountId !== null && organization.stripeChargesEnabled
    ? organization.stripeAccountId
    : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- payment-provider.spec`
Expected: PASS (3/3).

- [ ] **Step 5: Replace the four call sites**

In `apps/api/src/booking/booking-checkout.service.ts`, add the import:

```ts
import { connectAccountId } from '../providers/payment/payment-provider.js';
```

and change:

```ts
        const session = await this.payments.createCheckoutSession(
          {
            organizationId: organization.id,
            stripeAccountId: organization.stripeAccountId ?? undefined,
          },
```

to:

```ts
        const session = await this.payments.createCheckoutSession(
          {
            organizationId: organization.id,
            stripeAccountId: connectAccountId(organization),
          },
```

In `apps/api/src/booking/expiry.service.ts`, add the same import (`../providers/payment/payment-provider.js` — adjust the relative path to match this file's location, i.e. `../providers/payment/payment-provider.js`), and change (call site inside `completeExpiry`):

```ts
    const organization = this.organizations.require(booking.organizationId);
    const result = await this.payments.expireCheckoutSession(
      { organizationId: organization.id, stripeAccountId: organization.stripeAccountId ?? undefined },
      booking.stripeCheckoutSessionId,
    );
```

to:

```ts
    const organization = this.organizations.require(booking.organizationId);
    const result = await this.payments.expireCheckoutSession(
      { organizationId: organization.id, stripeAccountId: connectAccountId(organization) },
      booking.stripeCheckoutSessionId,
    );
```

and the call site inside `confirmInstead`:

```ts
    const organization = this.organizations.require(organizationId);
    const session = await this.payments.retrieveCheckoutSession(
      { organizationId: organization.id, stripeAccountId: organization.stripeAccountId ?? undefined },
      sessionId,
    );
```

to:

```ts
    const organization = this.organizations.require(organizationId);
    const session = await this.payments.retrieveCheckoutSession(
      { organizationId: organization.id, stripeAccountId: connectAccountId(organization) },
      sessionId,
    );
```

In `apps/api/src/payment/refund.service.ts`, add the import (`../providers/payment/payment-provider.js`), and change:

```ts
    const organization = this.organizations.require(refund.organizationId);
    try {
      const result = await this.payments.createRefund(
        { organizationId: organization.id, stripeAccountId: organization.stripeAccountId ?? undefined },
```

to:

```ts
    const organization = this.organizations.require(refund.organizationId);
    try {
      const result = await this.payments.createRefund(
        { organizationId: organization.id, stripeAccountId: connectAccountId(organization) },
```

- [ ] **Step 6: Run the full API unit suite to verify nothing broke**

Run: `pnpm --filter @shape-and-flow/booking-api test`
Expected: PASS. (No existing test constructs an organization with `stripeAccountId` set but `stripeChargesEnabled: false`, so behavior for every existing scenario — `stripeAccountId: null`, or both set — is identical to before.)

- [ ] **Step 7: Commit the routing gate**

```bash
git add apps/api/src/providers/payment/payment-provider.ts apps/api/src/providers/payment/payment-provider.spec.ts apps/api/src/booking/booking-checkout.service.ts apps/api/src/booking/expiry.service.ts apps/api/src/payment/refund.service.ts
git commit -m "fix(api): gate Stripe Connect routing on stripeChargesEnabled, not stripeAccountId presence"
```

- [ ] **Step 8: Write the failing integration test for booking-block hardening**

Open `apps/api/test/integration/public-bookings.int.spec.ts` and find its `beforeEach` — note how it seeds the organization via `seedOrganization(prisma)` and builds `testApp` via `createBookingTestApp`. Add a new test inside the existing `describe('POST /api/public/bookings', ...)` block (match the existing file's request-body shape used by its own happy-path test for `successUrl`/`cancelUrl`/`serviceId`/etc. — copy that shape verbatim from the neighboring test in the same file):

```ts
  it('refuses to start a booking while Stripe Connect onboarding is incomplete', async () => {
    await prisma.organization.update({
      where: { id: ctx.organization.id },
      data: { stripeAccountId: 'acct_incomplete', stripeChargesEnabled: false },
    });

    const res = await request(server())
      .post('/api/public/bookings')
      .send({
        serviceId: ctx.services[0].id,
        employeeId: ctx.employee.id,
        startsAt: '2026-08-20T10:00:00.000Z',
        customer: { email: 'customer@example.com', firstName: 'Jane', lastName: 'Doe', locale: 'de' },
        locale: 'de',
        successUrl: 'http://localhost:5173/success',
        cancelUrl: 'http://localhost:5173/cancel',
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ORGANIZATION_ONBOARDING_INCOMPLETE');
  });
```

(If the file's existing tests use different fixture variable names than `ctx.services[0].id`/`ctx.employee.id` — check the file's own `beforeEach` and match its actual names exactly.)

- [ ] **Step 9: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- public-bookings.int`
Expected: FAIL — the endpoint currently returns 201/502 (attempts to reserve/checkout) instead of 422.

- [ ] **Step 10: Add the booking-block check to `PublicBookingsController.create()`**

In `apps/api/src/public/public-bookings.controller.ts`, add the import:

```ts
import { AppError } from '../common/errors/app-error.js';
```

(already imported — confirm, do not duplicate) and change:

```ts
    const body = createBookingRequestSchema.parse(rawBody);

    this.assertAllowedRedirect(body.successUrl);
    this.assertAllowedRedirect(body.cancelUrl);
```

to:

```ts
    const body = createBookingRequestSchema.parse(rawBody);

    this.assertAllowedRedirect(body.successUrl);
    this.assertAllowedRedirect(body.cancelUrl);

    const organization = this.organizations.get();
    if (organization.stripeAccountId !== null && !organization.stripeChargesEnabled) {
      throw new AppError('ORGANIZATION_ONBOARDING_INCOMPLETE', {
        message: 'This organizer has not finished setting up payments yet.',
      });
    }
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- public-bookings.int`
Expected: PASS.

- [ ] **Step 12: Run the full API suite (unit + integration)**

Run: `pnpm --filter @shape-and-flow/booking-api test && pnpm --filter @shape-and-flow/booking-api test:integration`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/public/public-bookings.controller.ts apps/api/test/integration/public-bookings.int.spec.ts
git commit -m "fix(api): block new bookings while an organization's Stripe Connect onboarding is incomplete"
```

---

### Task 3: Critical 1 — login/password-reset unreachable for a non-default org

**Files:**
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/password-reset.service.ts`
- Modify: `apps/api/src/office/office-users.service.ts`
- Modify: `apps/api/src/organization/organization-registration.service.ts`
- Test: `apps/api/test/integration/auth.int.spec.ts` (existing file, new test case)

**Interfaces:**
- Consumes: `OfficeUser.email` global uniqueness (Task 1).
- Produces: `AuthController.login()` and `PasswordResetService.request()` resolve a user by email alone, independent of tenant context.

- [ ] **Step 1: Write the failing integration test for cross-org login**

Open `apps/api/test/integration/auth.int.spec.ts` and note its existing `beforeEach`/seed pattern (`seedOrganization(prisma)`, `createBookingTestApp`). Add a new test in the `describe('POST /api/auth/login', ...)` block:

```ts
  it('logs in an owner belonging to a different organization than the bootstrap default', async () => {
    const other = await prisma.organization.create({
      data: {
        slug: 'second-org',
        name: 'Second Org',
        legalName: 'Second Org GmbH',
        contactEmail: 'owner@second-org.example',
      },
    });
    await prisma.organizationSettings.create({ data: { organizationId: other.id, officeNotificationEmail: 'owner@second-org.example' } });
    await prisma.officeUser.create({
      data: {
        organizationId: other.id,
        email: 'owner@second-org.example',
        passwordHash: await new PasswordService().hash('Correct-Horse-Battery-9'),
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'OWNER',
        canIssueRefunds: true,
      },
    });

    const res = await request(server())
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email: 'owner@second-org.example', password: 'Correct-Horse-Battery-9' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('owner@second-org.example');
  });
```

(Match the file's own existing imports for `PasswordService`, `CSRF` header tuple, and `request`/`server` — these are already used by the file's other login tests; do not re-import if already present.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- auth.int`
Expected: FAIL — 401, because `login()` currently scopes its lookup to the bootstrap default organization, which is not `other.id`.

- [ ] **Step 3: Change `AuthController.login()`'s lookup to a global, case-insensitive-by-normalization lookup**

In `apps/api/src/auth/auth.controller.ts`, change:

```ts
    const { email, password } = loginRequestSchema.parse(rawBody);
    const now = this.clock.now();

    const user = await this.prisma.officeUser.findFirst({
      where: {
        organizationId: this.organizations.getOrganizationId(),
        email: { equals: email, mode: 'insensitive' },
      },
      select: USER_FOR_LOGIN,
    });
```

to:

```ts
    const { email, password } = loginRequestSchema.parse(rawBody);
    const now = this.clock.now();

    const user = await this.prisma.officeUser.findUnique({
      where: { email: email.toLowerCase() },
      select: USER_FOR_LOGIN,
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- auth.int`
Expected: PASS.

- [ ] **Step 5: Normalize email to lowercase at every write site**

In `apps/api/src/office/office-users.service.ts`, inside `create()`, change:

```ts
          data: {
            organizationId,
            email: input.email,
            passwordHash,
```

to:

```ts
          data: {
            organizationId,
            email: input.email.toLowerCase(),
            passwordHash,
```

In `apps/api/src/organization/organization-registration.service.ts`, inside `createOrganizationAndOwner()`, change:

```ts
              const owner = await tx.officeUser.create({
                data: {
                  organizationId: organization.id,
                  email: request.email,
                  passwordHash,
```

to:

```ts
              const owner = await tx.officeUser.create({
                data: {
                  organizationId: organization.id,
                  email: request.email.toLowerCase(),
                  passwordHash,
```

- [ ] **Step 6: Fix `PasswordResetService.request()`'s lookup and organization provenance**

In `apps/api/src/auth/password-reset.service.ts`, change:

```ts
  async request(email: string): Promise<void> {
    const organization = this.organizations.get();
    const user = await this.prisma.officeUser.findFirst({
      where: { organizationId: organization.id, email: { equals: email, mode: 'insensitive' }, archivedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    await this.passwords.verifyDummy(email);
    if (user === null) {
      this.logger.debug('password reset requested for an address with no active user');
      return;
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(this.clock.now().getTime() + RESET_TOKEN_TTL_MINUTES * 60_000);

    await this.prisma.$transaction(async (tx) => {
      const row = await tx.passwordResetToken.create({
        data: { organizationId: organization.id, officeUserId: user.id, tokenHash: hashResetToken(token), expiresAt },
        select: { id: true },
      });
      await this.notifications.queue(tx, {
        organizationId: organization.id,
        kind: 'OFFICE_PASSWORD_RESET',
        channel: 'EMAIL',
        locale: organization.defaultLocale,
        recipient: user.email,
        officeUserId: user.id,
        dedupeDiscriminator: row.id,
        data: { ...this.notificationData.commonData(), officeUserName: `${user.firstName} ${user.lastName}`, resetUrl: this.resetUrl(token), expiresAt },
      });
    });
  }
```

to:

```ts
  async request(email: string): Promise<void> {
    const user = await this.prisma.officeUser.findFirst({
      where: { email: email.toLowerCase(), archivedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true, organizationId: true },
    });
    await this.passwords.verifyDummy(email);
    if (user === null) {
      this.logger.debug('password reset requested for an address with no active user');
      return;
    }

    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: { id: true, defaultLocale: true },
    });

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(this.clock.now().getTime() + RESET_TOKEN_TTL_MINUTES * 60_000);

    await this.prisma.$transaction(async (tx) => {
      const row = await tx.passwordResetToken.create({
        data: { organizationId: organization.id, officeUserId: user.id, tokenHash: hashResetToken(token), expiresAt },
        select: { id: true },
      });
      await this.notifications.queue(tx, {
        organizationId: organization.id,
        kind: 'OFFICE_PASSWORD_RESET',
        channel: 'EMAIL',
        locale: organization.defaultLocale,
        recipient: user.email,
        officeUserId: user.id,
        dedupeDiscriminator: row.id,
        data: { ...this.notificationData.commonData(), officeUserName: `${user.firstName} ${user.lastName}`, resetUrl: this.resetUrl(token), expiresAt },
      });
    });
  }
```

(`confirm()` looks up by token hash and never used `organization`/`email` — unchanged, no edit needed.)

- [ ] **Step 7: Write the failing integration test for cross-org password reset**

In the same `auth.int.spec.ts` file, add to the `describe('POST /api/auth/password-reset', ...)` block (match its existing request-body shape and notification-queue assertion style from the neighboring reset test):

```ts
  it('queues the reset notification under the requesting user\'s own organization, not the bootstrap default', async () => {
    const other = await prisma.organization.create({
      data: { slug: 'third-org', name: 'Third Org', legalName: 'Third Org GmbH', contactEmail: 'owner@third-org.example', defaultLocale: 'en' },
    });
    await prisma.organizationSettings.create({ data: { organizationId: other.id, officeNotificationEmail: 'owner@third-org.example' } });
    const user = await prisma.officeUser.create({
      data: {
        organizationId: other.id,
        email: 'owner@third-org.example',
        passwordHash: await new PasswordService().hash('Correct-Horse-Battery-9'),
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'OWNER',
        canIssueRefunds: true,
      },
    });

    const res = await request(server())
      .post('/api/auth/password-reset')
      .set(...CSRF)
      .send({ email: 'owner@third-org.example' });

    expect(res.status).toBe(200);

    const token = await prisma.passwordResetToken.findFirstOrThrow({ where: { officeUserId: user.id } });
    expect(token.organizationId).toBe(other.id);
  });
```

- [ ] **Step 8: Run the test to verify it fails, then passes**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- auth.int`
Expected: FAIL first (against the un-patched service, `token.organizationId` would be the bootstrap default's id, not `other.id` — actually the pre-patch service also 500s because `organization.id` never matches `officeUserId`'s FK constraint in a two-org setup; either failure mode confirms the bug), then PASS after Step 6's change.

- [ ] **Step 9: Run the full API suite (unit + integration)**

Run: `pnpm --filter @shape-and-flow/booking-api test && pnpm --filter @shape-and-flow/booking-api test:integration`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/auth/auth.controller.ts apps/api/src/auth/password-reset.service.ts apps/api/src/office/office-users.service.ts apps/api/src/organization/organization-registration.service.ts apps/api/test/integration/auth.int.spec.ts
git commit -m "fix(api): resolve login/password-reset by global email, independent of tenant context"
```

---

### Task 4: Critical 3 — onboarding status page retry button while pending

**Files:**
- Modify: `apps/web/src/pages/office/OnboardingStatusPage.vue`
- Test: `apps/web/src/pages/office/OnboardingStatusPage.spec.ts` (new, or existing — check first)

**Interfaces:**
- Consumes: existing `api.office.organization.requestOnboardingLink()`, `officeMessage()`.
- Produces: no new interface — pure template change.

- [ ] **Step 1: Check whether a spec file already exists for this page**

Run: `find apps/web/src/pages/office -iname "OnboardingStatusPage*"`
If a `.spec.ts` exists, read it and add the new test to it in Step 2 using its existing mount/mock conventions. If none exists, create `apps/web/src/pages/office/OnboardingStatusPage.spec.ts` fresh, mirroring the mount style of a sibling office page spec (e.g. `apps/web/src/pages/office/*.spec.ts` — check one for the `vi.mock('../../api/client.js', ...)` pattern used elsewhere in this directory and match it exactly).

- [ ] **Step 2: Write the failing test**

```ts
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client.js';

import OnboardingStatusPage from './OnboardingStatusPage.vue';

vi.mock('../../api/client.js', () => ({
  api: {
    office: {
      organization: {
        current: vi.fn(),
        requestOnboardingLink: vi.fn(),
      },
    },
  },
}));

describe('OnboardingStatusPage', () => {
  it('shows a retry button while onboarding is pending, not only when it has failed', async () => {
    vi.mocked(api.office.organization.current).mockResolvedValue({ stripeChargesEnabled: false });

    const wrapper = mount(OnboardingStatusPage);
    await flushPromises();

    expect(wrapper.text()).toContain('Stripe is still processing');
    expect(wrapper.find('button').exists()).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-web test -- OnboardingStatusPage.spec`
Expected: FAIL — no `<button>` renders in the `'pending'` branch today.

- [ ] **Step 4: Add the retry button to the `'pending'` branch**

In `apps/web/src/pages/office/OnboardingStatusPage.vue`, change:

```vue
    <p v-else-if="state.status === 'pending'">
      Stripe is still processing your details. Reload this page in a minute.
    </p>
    <div v-else>
      <p>Something went wrong finishing your Stripe onboarding.</p>
      <button type="button" @click="retry">Retry onboarding</button>
      <p v-if="state.error">{{ state.error }}</p>
    </div>
```

to:

```vue
    <div v-else-if="state.status === 'pending'">
      <p>Stripe is still processing your details. Reload this page in a minute, or retry now.</p>
      <button type="button" @click="retry">Retry onboarding</button>
      <p v-if="state.error">{{ state.error }}</p>
    </div>
    <div v-else>
      <p>Something went wrong finishing your Stripe onboarding.</p>
      <button type="button" @click="retry">Retry onboarding</button>
      <p v-if="state.error">{{ state.error }}</p>
    </div>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-web test -- OnboardingStatusPage.spec`
Expected: PASS.

- [ ] **Step 6: Run the full web suite**

Run: `pnpm --filter @shape-and-flow/booking-web test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/office/OnboardingStatusPage.vue apps/web/src/pages/office/OnboardingStatusPage.spec.ts
git commit -m "fix(web): show a retry button on the onboarding status page while pending, not only on failure"
```

---

### Task 5: Important 1 — `/api/manage` reads the wrong org's settings/timezone

**Files:**
- Modify: `apps/api/src/organization/organization-context.service.ts`
- Modify: `apps/api/src/organization/organization-context.service.spec.ts`
- Modify: `apps/api/src/manage/manage.controller.ts`

**Interfaces:**
- Produces: `OrganizationContextService.getSettingsFor(organizationId: string): Promise<OrganizationSettings>` and `getTimezoneFor(organizationId: string): Promise<string>` — direct Prisma lookups, independent of ALS/bootstrap state.

- [ ] **Step 1: Write the failing unit tests**

In `apps/api/src/organization/organization-context.service.spec.ts`, add inside the existing `describe('OrganizationContextService', ...)` block, using the file's own `serviceReturning()` helper:

```ts
  it('loads settings for an explicit organization id, independent of ALS or bootstrap state', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(organization) // bootstrap load
      .mockResolvedValueOnce({ ...organization, id: 'org-2', settings: { ...organization.settings, id: 'settings-2', organizationId: 'org-2', schedulingIntervalMinutes: 30 } });
    const prisma = { organization: { findUnique } } as unknown as PrismaService;
    const service = new OrganizationContextService(config, prisma);
    await service.onApplicationBootstrap();

    const settings = await service.getSettingsFor('org-2');

    expect(settings.schedulingIntervalMinutes).toBe(30);
    expect(service.get().id).toBe('org-1');
  });

  it('loads the timezone for an explicit organization id', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(organization)
      .mockResolvedValueOnce({ ...organization, id: 'org-2', timezone: 'America/New_York' });
    const prisma = { organization: { findUnique } } as unknown as PrismaService;
    const service = new OrganizationContextService(config, prisma);
    await service.onApplicationBootstrap();

    const timezone = await service.getTimezoneFor('org-2');

    expect(timezone).toBe('America/New_York');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-context.service.spec`
Expected: FAIL — `getSettingsFor`/`getTimezoneFor` do not exist.

- [ ] **Step 3: Add the two methods to `OrganizationContextService`**

In `apps/api/src/organization/organization-context.service.ts`, add after the existing `getSettings()`/`getTimezone()` methods:

```ts
  /** Settings for an explicit organization id, bypassing ALS and the bootstrap snapshot. */
  async getSettingsFor(organizationId: string): Promise<OrganizationSettings> {
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      include: { settings: true },
    });
    if (!organization.settings) {
      throw new Error(`Organization "${organizationId}" has no settings row.`);
    }
    return organization.settings;
  }

  /** Timezone for an explicit organization id, bypassing ALS and the bootstrap snapshot. */
  async getTimezoneFor(organizationId: string): Promise<string> {
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return organization.timezone;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-context.service.spec`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test for a second organization's `/manage` booking**

Open `apps/api/test/integration/manage.int.spec.ts`, note its existing seed/token pattern, and add a test asserting the *second* org's own timezone/cancellation policy come back (not the seeded default org's). Match the file's existing fixture-building helpers exactly (management token creation, booking seeding) rather than reconstructing them:

```ts
  it("returns the booking's own organization's timezone and cancellation policy, not the default org's", async () => {
    const other = await prisma.organization.create({
      data: { slug: 'other-org', name: 'Other Org', legalName: 'Other Org GmbH', contactEmail: 'a@other.example', timezone: 'America/New_York' },
    });
    await prisma.organizationSettings.create({
      data: { organizationId: other.id, officeNotificationEmail: 'a@other.example', freeCancellationHours: 48 },
    });
    // Build the booking + management token for `other.id` using this file's existing
    // seedBookingForManagement-style helper (see the top of this file for its exact
    // signature), then:
    const res = await request(server()).get(`/api/manage/booking?token=${managementToken}`);

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('America/New_York');
    expect(res.body.cancellationPolicy.feePolicy).toBeDefined();
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- manage.int`
Expected: FAIL — `res.body.timezone` is the seeded default org's timezone (e.g. `Europe/Berlin`), not `America/New_York`.

- [ ] **Step 7: Use the new methods in `ManageController.booking()`**

In `apps/api/src/manage/manage.controller.ts`, change:

```ts
  @Get('booking')
  async booking(@ManagedBooking() managed: ResolvedToken): Promise<ManageBookingResponse> {
    const booking = await this.load(managed);
    const settings = this.organizations.getSettings();
    const now = this.clock.now();
```

to:

```ts
  @Get('booking')
  async booking(@ManagedBooking() managed: ResolvedToken): Promise<ManageBookingResponse> {
    const booking = await this.load(managed);
    const settings = await this.organizations.getSettingsFor(managed.organizationId);
    const now = this.clock.now();
```

and change:

```ts
      timezone: this.organizations.getTimezone(),
```

to:

```ts
      timezone: await this.organizations.getTimezoneFor(managed.organizationId),
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- manage.int`
Expected: PASS.

- [ ] **Step 9: Run the full API suite (unit + integration)**

Run: `pnpm --filter @shape-and-flow/booking-api test && pnpm --filter @shape-and-flow/booking-api test:integration`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/organization/organization-context.service.ts apps/api/src/organization/organization-context.service.spec.ts apps/api/src/manage/manage.controller.ts apps/api/test/integration/manage.int.spec.ts
git commit -m "fix(api): /manage reads the booking's own organization's settings/timezone, not the bootstrap default's"
```

---

### Task 6: Important 2 — worker/queue paths never open a tenant scope

**Files:**
- Modify: `apps/api/src/organization/tenant-context.store.ts`
- Modify: `apps/api/src/booking/processors/expiry.processor.ts`
- Modify: `apps/api/src/payment/processors/refund.processor.ts`
- Modify: `apps/api/src/notification/processors/reminder.processor.ts`
- Test: `apps/api/src/organization/tenant-context.store.spec.ts` (new)

**Interfaces:**
- Produces: `runWithOrganization<T>(organizationId: string, prisma: PrismaService, fn: () => T | Promise<T>): Promise<T>` — loads the organization row (with settings) via Prisma, then delegates to the existing `runWithTenant`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/organization/tenant-context.store.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { currentTenant, hasTenant, runWithOrganization } from './tenant-context.store.js';

import type { PrismaService } from '../prisma/prisma.service.js';

describe('runWithOrganization', () => {
  it('loads the organization by id and runs fn inside its tenant scope', async () => {
    const organization = {
      id: 'org-2',
      slug: 'acme',
      timezone: 'America/New_York',
      settings: { id: 'settings-2', organizationId: 'org-2', schedulingIntervalMinutes: 15 },
    };
    const findUniqueOrThrow = vi.fn().mockResolvedValue(organization);
    const prisma = { organization: { findUniqueOrThrow } } as unknown as PrismaService;

    expect(hasTenant()).toBe(false);

    const result = await runWithOrganization('org-2', prisma, () => {
      expect(currentTenant()?.id).toBe('org-2');
      return 'done';
    });

    expect(result).toBe('done');
    expect(hasTenant()).toBe(false);
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'org-2' },
      include: { settings: true },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- tenant-context.store.spec`
Expected: FAIL — `runWithOrganization` is not exported.

- [ ] **Step 3: Add `runWithOrganization` to `tenant-context.store.ts`**

In `apps/api/src/organization/tenant-context.store.ts`, add at the end of the file:

```ts
import type { PrismaService } from '../prisma/prisma.service.js';

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
  return runWithTenant({ ...organization, settings: organization.settings }, fn);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- tenant-context.store.spec`
Expected: PASS.

- [ ] **Step 5: Wrap `ExpiryProcessor.handle()` in the new scope**

In `apps/api/src/booking/processors/expiry.processor.ts`, add the import:

```ts
import { PrismaService } from '../../prisma/prisma.service.js';
import { runWithOrganization } from '../../organization/tenant-context.store.js';
```

add `private readonly prisma: PrismaService,` to the constructor, and change:

```ts
  async handle(payload: JobPayload<typeof JOB.BOOKING_EXPIRY_REQUESTED>): Promise<void> {
    const { bookingId } = payload;

    // The payload names the tenant, so it is checked rather than ignored. A worker has no
    // request to resolve an organization from, and the saga talks to Stripe — so a job
    // running against the wrong organization would expire a session on the wrong account.
    this.organizations.require(payload.organizationId);

    // Phase one first. Usually a no-op — the delayed job normally arrives when the
    // booking is already EXPIRING because phase one ran from the sweeper — but running it
    // means the delayed job alone is sufficient if the sweeper never fires.
    const began = await this.expiry.beginExpiry(bookingId);

    if (began === 'NOT_DUE') {
      // The job fired early. Nothing to do: the sweeper will pick the booking up once it
      // really is due, and the reservation is still blocking until then.
      this.logger.debug(`booking ${bookingId} is not due yet`);
      return;
    }

    const outcome = await this.expiry.completeExpiry(bookingId);
    this.logger.debug(`booking ${bookingId} expiry settled as ${outcome}`);
  }
```

to:

```ts
  async handle(payload: JobPayload<typeof JOB.BOOKING_EXPIRY_REQUESTED>): Promise<void> {
    const { bookingId } = payload;

    // Open the job's own tenant scope before touching anything org-scoped. A worker has
    // no request to resolve an organization from, and the saga talks to Stripe — so a job
    // running against the wrong organization would expire a session on the wrong account.
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      // Phase one first. Usually a no-op — the delayed job normally arrives when the
      // booking is already EXPIRING because phase one ran from the sweeper — but running
      // it means the delayed job alone is sufficient if the sweeper never fires.
      const began = await this.expiry.beginExpiry(bookingId);

      if (began === 'NOT_DUE') {
        // The job fired early. Nothing to do: the sweeper will pick the booking up once
        // it really is due, and the reservation is still blocking until then.
        this.logger.debug(`booking ${bookingId} is not due yet`);
        return;
      }

      const outcome = await this.expiry.completeExpiry(bookingId);
      this.logger.debug(`booking ${bookingId} expiry settled as ${outcome}`);
    });
  }
```

(Drop the now-redundant `this.organizations.require(...)` call and the unused `organizations` field if nothing else in the class uses it — check the class body first.)

- [ ] **Step 6: Wrap `RefundProcessor.handle()` in the new scope**

In `apps/api/src/payment/processors/refund.processor.ts`, add the same two imports (`PrismaService` from `../../prisma/prisma.service.js`, `runWithOrganization` from `../../organization/tenant-context.store.js`), add `private readonly prisma: PrismaService,` to the constructor, and change:

```ts
  async handle(payload: JobPayload<typeof JOB.REFUND_REQUESTED>): Promise<void> {
    // The payload names the tenant and `execute` reads the Stripe account from context, so
    // the two are checked against each other here. Refunding from the wrong account is not
    // a mistake that can be taken back.
    this.organizations.require(payload.organizationId);

    const outcome = await this.refunds.execute(payload.refundId);
    this.logger.debug(`refund ${payload.refundId} settled as ${outcome}`);
  }
```

to:

```ts
  async handle(payload: JobPayload<typeof JOB.REFUND_REQUESTED>): Promise<void> {
    // Open the job's own tenant scope before executing. `execute` reads the Stripe
    // account from context, and refunding from the wrong account is not a mistake that
    // can be taken back.
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      const outcome = await this.refunds.execute(payload.refundId);
      this.logger.debug(`refund ${payload.refundId} settled as ${outcome}`);
    });
  }
```

(Drop the now-redundant `this.organizations.require(...)` call and the unused `organizations` field if nothing else in the class uses it.)

- [ ] **Step 7: Wrap both `ReminderProcessor` methods in the new scope**

`ReminderService.fire()` calls `this.organizations.getSettings()` directly, and `ReminderService.offsets()` (called by both `schedule()` and `send()`, via `fire()`) also calls `this.organizations.getSettings()` — so both processor methods need the scope, not only `send()`.

In `apps/api/src/notification/processors/reminder.processor.ts`, add the imports:

```ts
import { PrismaService } from '../../prisma/prisma.service.js';
import { runWithOrganization } from '../../organization/tenant-context.store.js';
```

add `private readonly prisma: PrismaService,` to the constructor, and change:

```ts
  /** `reminder.schedule` — enqueue the delayed jobs for one booking. */
  async schedule(payload: JobPayload<(typeof JOB)['REMINDER_SCHEDULE']>): Promise<void> {
    const { scheduled, skipped } = await this.reminders.schedule(payload.bookingId);

    this.logger.debug(
      `scheduled ${String(scheduled)} reminders for ${payload.bookingId} (${String(skipped)} past due)`,
    );
  }

  /** `reminder.send` — send it, unless the appointment has moved or gone. */
  async send(payload: JobPayload<(typeof JOB)['REMINDER_SEND']>): Promise<void> {
    const outcome = await this.reminders.fire({
      bookingId: payload.bookingId,
      offsetMinutes: payload.offsetMinutes,
      expectedStartsAtEpochSeconds: payload.expectedStartsAtEpochSeconds,
    });

    if (outcome === 'SKIPPED') {
      this.logger.debug(`reminder for ${payload.bookingId} no longer applies`);
    }
  }
```

to:

```ts
  /** `reminder.schedule` — enqueue the delayed jobs for one booking. */
  async schedule(payload: JobPayload<(typeof JOB)['REMINDER_SCHEDULE']>): Promise<void> {
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      const { scheduled, skipped } = await this.reminders.schedule(payload.bookingId);

      this.logger.debug(
        `scheduled ${String(scheduled)} reminders for ${payload.bookingId} (${String(skipped)} past due)`,
      );
    });
  }

  /** `reminder.send` — send it, unless the appointment has moved or gone. */
  async send(payload: JobPayload<(typeof JOB)['REMINDER_SEND']>): Promise<void> {
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      const outcome = await this.reminders.fire({
        bookingId: payload.bookingId,
        offsetMinutes: payload.offsetMinutes,
        expectedStartsAtEpochSeconds: payload.expectedStartsAtEpochSeconds,
      });

      if (outcome === 'SKIPPED') {
        this.logger.debug(`reminder for ${payload.bookingId} no longer applies`);
      }
    });
  }
```

(Check `job-contracts.ts`'s `REMINDER_SCHEDULE`/`REMINDER_SEND` payload schemas — both are built with `tenantJob()`, so `payload.organizationId` already exists on both; no contract change needed.)

- [ ] **Step 8: Run the full API unit suite**

Run: `pnpm --filter @shape-and-flow/booking-api test`
Expected: PASS. Existing processor unit tests (if any construct `OrganizationContextService.require` mocks) may need their mock setup updated to a `prisma.organization.findUniqueOrThrow` mock instead — check each processor's `.spec.ts` file and update its test doubles to match the new constructor shape.

- [ ] **Step 9: Run the full integration suite**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration`
Expected: PASS — confirms the expiry/refund/reminder job flows still work end-to-end against the single seeded organization.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/organization/tenant-context.store.ts apps/api/src/organization/tenant-context.store.spec.ts apps/api/src/booking/processors/expiry.processor.ts apps/api/src/payment/processors/refund.processor.ts apps/api/src/notification/processors/reminder.processor.ts
git commit -m "fix(api): open a tenant scope in expiry/refund/reminder job processors instead of reading the bootstrap default"
```

---

### Task 7: Important 3 — fail-closed tenant-resolution middlewares

**Files:**
- Modify: `apps/api/src/organization/tenant-resolution.middleware.ts`
- Modify: `apps/api/src/organization/office-tenant.middleware.ts`

**Interfaces:**
- Consumes: `ORGANIZATION_NOT_FOUND` error code (Task 1).
- Produces: no interface change — behavior change only (reject instead of silently falling through when identity is offered but invalid).

- [ ] **Step 1: Write the failing unit test for `TenantResolutionMiddleware`**

Create `apps/api/src/organization/tenant-resolution.middleware.spec.ts`, following `apps/api/src/common/correlation/correlation.middleware.spec.ts`'s style (direct middleware invocation, fake `Request`/`Response`):

```ts
import { describe, expect, it, vi } from 'vitest';

import { hasTenant } from './tenant-context.store.js';
import { TenantResolutionMiddleware } from './tenant-resolution.middleware.js';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { NextFunction, Request, Response } from 'express';

function fakeRequest(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe('TenantResolutionMiddleware', () => {
  it('falls through to the default organization when no ?organizer= param is present', async () => {
    const findUnique = vi.fn();
    const middleware = new TenantResolutionMiddleware({ organization: { findUnique } } as unknown as PrismaService);
    const next = vi.fn();

    await middleware.middleware(fakeRequest({}), {} as Response, next as NextFunction);

    expect(findUnique).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(hasTenant()).toBe(false);
  });

  it('resolves the tenant scope when ?organizer= names a real organization', async () => {
    const organization = { id: 'org-1', slug: 'acme', settings: { id: 'settings-1' } };
    const findUnique = vi.fn().mockResolvedValue(organization);
    const middleware = new TenantResolutionMiddleware({ organization: { findUnique } } as unknown as PrismaService);
    const next = vi.fn(() => {
      expect(hasTenant()).toBe(true);
    });

    await middleware.middleware(fakeRequest({ organizer: 'acme' }), {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects instead of falling through when ?organizer= names no organization', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const middleware = new TenantResolutionMiddleware({ organization: { findUnique } } as unknown as PrismaService);
    const next = vi.fn();

    await expect(
      middleware.middleware(fakeRequest({ organizer: 'ghost' }), {} as Response, next as NextFunction),
    ).rejects.toThrow();

    expect(next).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify the third case fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- tenant-resolution.middleware.spec`
Expected: the first two PASS; the third FAILS (currently calls `next()` with no error instead of throwing).

- [ ] **Step 3: Make `TenantResolutionMiddleware` reject an unresolvable slug**

In `apps/api/src/organization/tenant-resolution.middleware.ts`, add the import:

```ts
import { AppError } from '../common/errors/app-error.js';
```

and change:

```ts
  middleware = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    const slug = request.query.organizer;
    if (typeof slug !== 'string' || slug.length === 0) {
      next();
      return;
    }

    const organization = await this.prisma.organization.findUnique({ where: { slug }, include: { settings: true } });
    if (!organization?.settings) {
      next();
      return;
    }

    runWithTenant({ ...organization, settings: organization.settings }, () => {
      next();
    });
  };
```

to:

```ts
  middleware = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    const slug = request.query.organizer;
    if (typeof slug !== 'string' || slug.length === 0) {
      // No identity offered at all — the intentional root-domain case. Fall through to
      // whatever resolves the bootstrap default.
      next();
      return;
    }

    const organization = await this.prisma.organization.findUnique({ where: { slug }, include: { settings: true } });
    if (!organization?.settings) {
      // An identity WAS offered and it does not resolve — never silently serve a
      // different organization's data for an explicit, wrong slug.
      throw new AppError('ORGANIZATION_NOT_FOUND', { message: 'No organizer matches that address.' });
    }

    runWithTenant({ ...organization, settings: organization.settings }, () => {
      next();
    });
  };
```

Also update the class docblock's description of the fall-through behavior to say it only applies when no `?organizer=` param is present, not unconditionally.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- tenant-resolution.middleware.spec`
Expected: PASS (3/3).

- [ ] **Step 5: Write the failing unit test for `OfficeTenantMiddleware`**

Create `apps/api/src/organization/office-tenant.middleware.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { hasTenant } from './tenant-context.store.js';
import { OfficeTenantMiddleware } from './office-tenant.middleware.js';

import type { AppConfig } from '../config/env.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SessionStore } from '../auth/session.store.js';
import type { NextFunction, Request, Response } from 'express';

const config = { SESSION_COOKIE_NAME: 'sid' } as AppConfig;

function fakeRequest(cookieHeader: string | undefined): Request {
  return { headers: { cookie: cookieHeader } } as unknown as Request;
}

describe('OfficeTenantMiddleware', () => {
  it('falls through to the default organization when there is no session cookie', async () => {
    const read = vi.fn();
    const findUnique = vi.fn();
    const middleware = new OfficeTenantMiddleware(
      { read } as unknown as SessionStore,
      { organization: { findUnique } } as unknown as PrismaService,
      config,
    );
    const next = vi.fn();

    await middleware.middleware(fakeRequest(undefined), {} as Response, next as NextFunction);

    expect(read).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(hasTenant()).toBe(false);
  });

  it('resolves the tenant scope for a valid session', async () => {
    const organization = { id: 'org-1', slug: 'acme', settings: { id: 'settings-1' } };
    const read = vi.fn().mockResolvedValue({ organizationId: 'org-1' });
    const findUnique = vi.fn().mockResolvedValue(organization);
    const middleware = new OfficeTenantMiddleware(
      { read } as unknown as SessionStore,
      { organization: { findUnique } } as unknown as PrismaService,
      config,
    );
    const next = vi.fn(() => {
      expect(hasTenant()).toBe(true);
    });

    await middleware.middleware(fakeRequest('sid=abc'), {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects instead of falling through when the session exists but the organization lookup fails', async () => {
    const read = vi.fn().mockResolvedValue({ organizationId: 'org-missing' });
    const findUnique = vi.fn().mockResolvedValue(null);
    const middleware = new OfficeTenantMiddleware(
      { read } as unknown as SessionStore,
      { organization: { findUnique } } as unknown as PrismaService,
      config,
    );
    const next = vi.fn();

    await expect(
      middleware.middleware(fakeRequest('sid=abc'), {} as Response, next as NextFunction),
    ).rejects.toThrow();

    expect(next).not.toHaveBeenCalled();
  });
});
```

(If `readCookie` needs a real `Cookie` header parse rather than the literal shape assumed here, check `apps/api/src/organization/office-tenant.middleware.ts`'s actual `readCookie` import and adjust `fakeRequest` to match its real signature — e.g. it may read `request.headers.cookie` as a raw string via a shared cookie-parsing helper, in which case the shape above is already correct.)

- [ ] **Step 6: Run the test to verify the third case fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- office-tenant.middleware.spec`
Expected: first two PASS, third FAILS.

- [ ] **Step 7: Make `OfficeTenantMiddleware` reject a session whose organization lookup fails**

In `apps/api/src/organization/office-tenant.middleware.ts`, add the import:

```ts
import { AppError } from '../common/errors/app-error.js';
```

and change:

```ts
    const organization = await this.prisma.organization.findUnique({ where: { id: session.organizationId }, include: { settings: true } });
    if (!organization?.settings) {
      next();
      return;
    }
```

to:

```ts
    const organization = await this.prisma.organization.findUnique({ where: { id: session.organizationId }, include: { settings: true } });
    if (!organization?.settings) {
      // A session exists but its organization no longer resolves — never silently serve
      // a different organization's data for an authenticated request.
      throw new AppError('ORGANIZATION_NOT_FOUND', { message: 'The organization for this session no longer exists.' });
    }
```

Keep the earlier `if (sid === null) { next(); return; }` and `if (session === null) { next(); return; }` branches unchanged — those are the "no identity offered" cases and must keep falling through. Update the class docblock to say the fall-through only applies when no session cookie is present.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- office-tenant.middleware.spec`
Expected: PASS (3/3).

- [ ] **Step 9: Run the full API suite (unit + integration)**

Run: `pnpm --filter @shape-and-flow/booking-api test && pnpm --filter @shape-and-flow/booking-api test:integration`
Expected: PASS. If an existing integration test relied on a stale/invalid session cookie silently resolving to the default org (rather than erroring), update that test's expectation — that fallthrough was exactly this finding's bug.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/organization/tenant-resolution.middleware.ts apps/api/src/organization/office-tenant.middleware.ts apps/api/src/organization/tenant-resolution.middleware.spec.ts apps/api/src/organization/office-tenant.middleware.spec.ts
git commit -m "fix(api): reject an offered-but-invalid tenant identity instead of falling through to the default organization"
```

---

### Task 8: Important 4 — boundary tests for tenant resolution

Both spec files (`tenant-resolution.middleware.spec.ts`, `office-tenant.middleware.spec.ts`) were written and committed as part of Task 7, since a fail-closed behavior change and its regression test are the same testable unit of work. This task is a verification pass confirming Important 4's coverage matrix is actually satisfied, with no further code changes expected.

**Files:**
- Verify: `apps/api/src/organization/tenant-resolution.middleware.spec.ts`
- Verify: `apps/api/src/organization/office-tenant.middleware.spec.ts`

**Interfaces:**
- Consumes: both middleware spec files from Task 7.

- [ ] **Step 1: Confirm the coverage matrix from Important 3 is fully present**

Read both spec files and confirm each has three cases: no identity → falls through; valid identity → correct org resolved (assert via `hasTenant()`/tenant id, not merely a 200 status); invalid identity → rejected. If any case is missing, add it now following the same pattern as Task 7 Steps 1 and 5.

- [ ] **Step 2: Run both spec files together**

Run: `pnpm --filter @shape-and-flow/booking-api test -- tenant-resolution.middleware.spec office-tenant.middleware.spec`
Expected: PASS, 6 tests total (3 per file).

- [ ] **Step 3: Commit only if Step 1 found and fixed a gap**

```bash
git add apps/api/src/organization/tenant-resolution.middleware.spec.ts apps/api/src/organization/office-tenant.middleware.spec.ts
git commit -m "test(api): complete the tenant-resolution boundary coverage matrix"
```

(If Step 1 found no gap, skip this commit — Task 7's commit already covers this task's deliverable.)

---

### Task 9: Important 5 — throttle + CSRF guard on registration

**Files:**
- Modify: `apps/api/src/organization/organization-registration.controller.ts`
- Test: `apps/api/test/integration/organization-registration.int.spec.ts` (existing file, new test cases)

**Interfaces:**
- Consumes: `CsrfHeaderGuard` (existing, from `apps/api/src/auth/csrf-header.guard.ts`), `@Throttle` (existing, `@nestjs/throttler`).
- Produces: no new interface — registration now requires the `X-Requested-With: XMLHttpRequest` header and is rate-limited to 5/hour per IP, matching every other public mutation.

- [ ] **Step 1: Write the failing integration tests**

In `apps/api/test/integration/organization-registration.int.spec.ts`, add two new tests to the `describe('POST /api/public/organizations', ...)` block:

```ts
  it('rejects registration without the CSRF header', async () => {
    const res = await request(server()).post('/api/public/organizations').send({
      entityType: 'INDIVIDUAL',
      displayName: 'No CSRF Studio',
      email: 'nocsrf@example.com',
      password: 'Correct-Horse-Battery-9',
      firstName: 'Jane',
      lastName: 'Doe',
      contactPhone: '+49 30 1234567',
      addressLine1: 'Musterstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    });

    expect(res.status).toBe(403);
  });

  it('rate-limits registration to 5 per hour per IP', async () => {
    const body = (n: number) => ({
      entityType: 'INDIVIDUAL',
      displayName: `Rate Studio ${n}`,
      email: `rate${n}@example.com`,
      password: 'Correct-Horse-Battery-9',
      firstName: 'Jane',
      lastName: 'Doe',
      contactPhone: '+49 30 1234567',
      addressLine1: 'Musterstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(server())
        .post('/api/public/organizations')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send(body(i));
      expect(res.status).toBe(201);
    }

    const sixth = await request(server())
      .post('/api/public/organizations')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send(body(5));

    expect(sixth.status).toBe(429);
  });
```

(Every existing test in this file that posts to `/api/public/organizations` must now also `.set('X-Requested-With', 'XMLHttpRequest')` — update them all in this same step, matching the header-setting style already used by `auth.int.spec.ts`'s login tests.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- organization-registration.int`
Expected: FAIL — the endpoint currently accepts requests with no CSRF header (no 403) and has no throttle (no 429 after 5 attempts); the pre-existing happy-path tests also fail once the CSRF header is required and not yet sent — sending it in step 1 pre-empts that, but confirm the two new tests specifically fail before Step 3's change.

- [ ] **Step 3: Add the guard and throttle to `OrganizationRegistrationController`**

In `apps/api/src/organization/organization-registration.controller.ts`, add the imports:

```ts
import { Throttle } from '@nestjs/throttler';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
```

add the constant near the top of the file (mirroring `auth.controller.ts`'s `LOGIN_LIMIT`):

```ts
const REGISTER_LIMIT = { default: { limit: 5, ttl: 3_600_000 } };
```

and change:

```ts
  @Public()
  @Post()
  @HttpCode(201)
  async register(@Body() rawBody: unknown, @Res({ passthrough: true }) response: Response): Promise<RegisterOrganizationResponse> {
```

to:

```ts
  @Public()
  @UseGuards(CsrfHeaderGuard)
  @Throttle(REGISTER_LIMIT)
  @Post()
  @HttpCode(201)
  async register(@Body() rawBody: unknown, @Res({ passthrough: true }) response: Response): Promise<RegisterOrganizationResponse> {
```

(Add `UseGuards` to the existing `@nestjs/common` import if not already present.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @shape-and-flow/booking-api test:integration -- organization-registration.int`
Expected: PASS.

- [ ] **Step 5: Update the frontend registration call to send the CSRF header**

Check `apps/web/src/api/client.ts`'s `api.public.registerOrganization` — every other state-changing office/public call already sends `X-Requested-With: XMLHttpRequest` via a shared fetch wrapper (confirm which wrapper `register`/`login` uses). If `registerOrganization` uses a different, header-less wrapper, switch it to the same one `login` uses. Run `pnpm --filter @shape-and-flow/booking-web test` afterward to confirm no web test broke.

- [ ] **Step 6: Run the full API suite (unit + integration) and the full web suite**

Run: `pnpm --filter @shape-and-flow/booking-api test && pnpm --filter @shape-and-flow/booking-api test:integration && pnpm --filter @shape-and-flow/booking-web test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/organization/organization-registration.controller.ts apps/api/test/integration/organization-registration.int.spec.ts apps/web/src/api/client.ts
git commit -m "fix(api): require CSRF header and rate-limit organization registration, matching every other public mutation"
```

---

### Task 10: Important 6 — validate `returnUrl` and activate `INVALID_RETURN_URL`

**Files:**
- Modify: `apps/api/src/organization/organization-registration.service.ts`
- Test: `apps/api/src/organization/organization-registration.service.spec.ts` (existing or new — check first)

**Interfaces:**
- Consumes: `INVALID_RETURN_URL` (already exists in `errorCodeSchema`, currently dead code — this task adds the first throw site).

- [ ] **Step 1: Check for an existing unit spec file**

Run: `find apps/api/src/organization -iname "organization-registration.service.spec.ts"`. If it exists, read its existing test/mock structure (how `StripeConnectService`, `PrismaService`, `SessionStore` are stubbed) and match it exactly in Step 2. If it doesn't exist, create it fresh using the same constructor-injection style as `organization-context.service.spec.ts` (plain `new OrganizationRegistrationService(...)` with hand-built fakes, not `Test.createTestingModule`).

- [ ] **Step 2: Write the failing test**

```ts
  it('rejects a returnUrl that does not match PUBLIC_WEB_ORIGIN', async () => {
    const service = /* construct per Step 1's chosen pattern, with config.PUBLIC_WEB_ORIGIN = 'https://app.example.com' */;

    await expect(
      service.register({
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
        returnUrl: 'https://evil.example.com/steal',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RETURN_URL' });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-registration.service.spec`
Expected: FAIL — `returnUrl` is currently passed straight to Stripe with no validation, so the call either succeeds against the mocked Stripe client or throws a different error, not `AppError` with code `INVALID_RETURN_URL`.

- [ ] **Step 4: Validate `returnUrl` before calling `createAccountLink`**

In `apps/api/src/organization/organization-registration.service.ts`, change:

```ts
      private async startStripeOnboarding(request, organizationId): Promise<string | null> {
        try {
          const { stripeAccountId } = await this.stripeConnect.createExpressAccount({ email: request.email, country: request.country, businessType: businessTypeFor(request.entityType) });
          await this.prisma.organization.update({ where: { id: organizationId }, data: { stripeAccountId } });
          const returnUrl = request.returnUrl ?? this.defaultReturnUrl();
          const { url } = await this.stripeConnect.createAccountLink(stripeAccountId, returnUrl);
          return url;
        } catch { return null; }
      }
```

to:

```ts
      private async startStripeOnboarding(request, organizationId): Promise<string | null> {
        if (request.returnUrl !== undefined && !request.returnUrl.startsWith(this.config.PUBLIC_WEB_ORIGIN)) {
          throw new AppError('INVALID_RETURN_URL', {
            message: `returnUrl must start with ${this.config.PUBLIC_WEB_ORIGIN}.`,
          });
        }

        try {
          const { stripeAccountId } = await this.stripeConnect.createExpressAccount({ email: request.email, country: request.country, businessType: businessTypeFor(request.entityType) });
          await this.prisma.organization.update({ where: { id: organizationId }, data: { stripeAccountId } });
          const returnUrl = request.returnUrl ?? this.defaultReturnUrl();
          const { url } = await this.stripeConnect.createAccountLink(stripeAccountId, returnUrl);
          return url;
        } catch (error) {
          if (error instanceof AppError && error.code === 'INVALID_RETURN_URL') throw error;
          return null;
        }
      }
```

(Add the `AppError` import if not already present in this file — check the top of the file first; `AppError` is already used elsewhere in this class for `ORGANIZATION_CREATE_ERROR`, so it is almost certainly already imported.)

Note: this deliberately throws (does not swallow into `null`) only for `INVALID_RETURN_URL` — every other Stripe-onboarding failure keeps its existing "organization creation still succeeds, `onboardingLink: null`" behavior. A bad `returnUrl` is a caller error, not a Stripe outage, so registration must fail outright rather than silently create the organization with no way back into onboarding via a link the caller can't trust anyway.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @shape-and-flow/booking-api test -- organization-registration.service.spec`
Expected: PASS.

- [ ] **Step 6: Run the full API suite (unit + integration)**

Run: `pnpm --filter @shape-and-flow/booking-api test && pnpm --filter @shape-and-flow/booking-api test:integration`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/organization/organization-registration.service.ts apps/api/src/organization/organization-registration.service.spec.ts
git commit -m "fix(api): validate returnUrl against PUBLIC_WEB_ORIGIN before Stripe onboarding, activating INVALID_RETURN_URL"
```

---

## Final Verification (after Task 10)

- [ ] Run the complete workspace gate: `pnpm --filter @shape-and-flow/booking-contracts test`, `pnpm --filter @shape-and-flow/booking-api test`, `pnpm --filter @shape-and-flow/booking-api test:integration`, `pnpm --filter @shape-and-flow/booking-web test`, `pnpm typecheck`, `pnpm lint` (workspace-wide; watch for lint OOM at default concurrency and remember `knip` needs a dummy `DATABASE_URL` — see the local CI gate runbook).
- [ ] Dispatch the final whole-branch review (same Opus-class agent/process as the original review) covering all 10 tasks' combined diff before merge.
- [ ] Manual/e2e sanity check: register a second organization end-to-end, let its Stripe Connect onboarding fail (mock), confirm the owner can (a) log back in by email after their auto-login session expires and (b) retry from the `'pending'` onboarding-status state.

## Self-Review

**Spec coverage:** All 3 Critical + 6 Important findings from the plan-mode document map to a task: Critical 1 → Task 3 (+ Task 1's migration), Critical 2 (+ its extra hardening) → Task 2, Critical 3 → Task 4, Important 1 → Task 5, Important 2 → Task 6, Important 3 → Task 7, Important 4 → Task 8, Important 5 → Task 9, Important 6 → Task 10 (+ Task 1's error codes). The plan's stated Sequencing order (schema/contracts → Critical 2 → Critical 1 → Critical 3 → Important 1 → Important 2 → Important 3 → Important 4 → Important 5) is followed exactly, with Important 6 appended last since the plan folded its mechanics into Task 1 and left the throw-site as the only remaining piece, independent of everything else.

**Placeholder scan:** No TBD/TODO markers. Two steps (Task 5 Step 5, Task 9 Step 1) point at "read this file's existing pattern and match it" rather than inline code, because the exact fixture helper names in `manage.int.spec.ts` and the exact spec-file existence for `organization-registration.service.spec.ts` were not confirmed during planning — both are explicit, bounded lookups ("run this command, use what it shows"), not open-ended "add appropriate tests" placeholders, and every other step in both tasks has complete, runnable code.

**Type/name consistency:** `connectAccountId` (Task 2) is used with an identical signature at all four call sites and defined once. `runWithOrganization` (Task 6) takes `(organizationId, prisma, fn)` consistently in its three call sites. `getSettingsFor`/`getTimezoneFor` (Task 5) are defined once and used once. `ORGANIZATION_NOT_FOUND`/`ORGANIZATION_ONBOARDING_INCOMPLETE` (Task 1) are spelled identically everywhere they appear across Tasks 2, 7, and the two locale files.
