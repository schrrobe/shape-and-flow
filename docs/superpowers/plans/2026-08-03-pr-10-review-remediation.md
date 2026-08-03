# PR 10 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the thirteen accepted PR #10 findings, preserve three intentionally rejected contracts/history decisions, and close every review thread with evidence.

**Architecture:** Keep authorization and refund promises at the cancellation/refund transaction boundary, while tenant and worker resilience stay in their existing shared services. Add focused regression coverage before each behavioral change, then apply mechanical comments, migration, test-hygiene, and documentation corrections.

**Tech Stack:** Node.js 24.18, TypeScript 6, NestJS 11, Prisma 7/PostgreSQL 17, Vitest, Supertest, Playwright, pnpm 10.

## Global Constraints

- Prefix every shell command with `rtk`.
- Do not add dependencies.
- Use `Money` for refund arithmetic.
- Do not move provider calls into database transactions.
- Preserve the historical remediation plan; explain and resolve its two threads without editing it.
- Keep `customerNotificationAlreadyQueued` optional and non-nullable; explain and resolve that thread without editing the contract.
- Every behavioral fix starts with a focused test that fails for the reported reason.
- Do not reply to or resolve a GitHub thread until its code is pushed or its rejection evidence is final.

---

### Task 1: Fail refund authorization closed

**Files:**
- Modify: `booking-app/apps/api/src/booking/cancellation.service.ts`
- Modify: `booking-app/apps/api/src/office/office-bookings.controller.ts`
- Test: `booking-app/apps/api/test/integration/cancellation.int.spec.ts`

**Interfaces:**
- `DecideRequestInput.mayIssueRefunds: boolean` is required.
- `CancelByBusinessInput.mayIssueRefunds: boolean` is required.
- `reserveRefund(..., options)` consumes required `mayIssueRefunds` and optional `lenient`.

- [ ] **Step 1: Add a missing-capability regression**

Add a test that calls `decideRequest` through a test-only cast without `mayIssueRefunds`, approves a request that moves money, and expects `FORBIDDEN_ROLE` with the request and booking unchanged.

```ts
await expect(
  service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' } as DecideRequestInput),
).rejects.toMatchObject({ code: 'FORBIDDEN_ROLE' });
expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } })).decision).toBe('PENDING');
```

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm api test:integration -- cancellation.int.spec.ts`

Expected: the new test resolves instead of rejecting because omitted capability currently authorizes the refund.

- [ ] **Step 3: Require and propagate the capability**

Make both office-facing inputs require `mayIssueRefunds`. Pass the session decision from both controllers. Pass `true` from the automatic customer cancellation path. Make the reservation check:

```ts
if (reserved.additionalAmountCents > 0 && options.mayIssueRefunds !== true) {
  throw new AppError('FORBIDDEN_ROLE', { message: 'Your account may not perform this action.' });
}
```

Update direct service tests to pass `mayIssueRefunds: true` for authorized calls and `false` for explicit denial tests.

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm api test:integration -- cancellation.int.spec.ts`

Expected: PASS.

### Task 2: Make explicit business refunds atomic

**Files:**
- Modify: `booking-app/apps/api/src/booking/cancellation.service.ts`
- Test: `booking-app/apps/api/test/integration/cancellation.int.spec.ts`

- [ ] **Step 1: Add an unpaid explicit-refund regression**

Create a confirmed unpaid booking, call `cancelByBusiness` with `refundAmountCents: 100`, `mayIssueRefunds: true`, and assert `PAYMENT_NOT_REFUNDABLE`; then assert the booking remains `CONFIRMED`.

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm api test:integration -- cancellation.int.spec.ts`

Expected: the call succeeds with `refundId: null` and cancels the booking.

- [ ] **Step 3: Propagate strictness**

Extend refund options with `lenient?: boolean`. Send `lenient: options.lenient ?? true` to `reserveInTransaction`. For an explicit positive business amount pass `lenient: false`; keep absent and zero paths lenient.

- [ ] **Step 4: Verify GREEN**

Run: `rtk pnpm api test:integration -- cancellation.int.spec.ts`

Expected: PASS.

### Task 3: Harden date, tenant, and worker behavior

**Files:**
- Modify: `booking-app/apps/api/src/domain/time/local-time.ts`
- Test: `booking-app/apps/api/src/domain/time/local-time.spec.ts`
- Modify: `booking-app/apps/api/src/notification/booking-notification-data.service.ts`
- Test: `booking-app/apps/api/test/integration/notifications.int.spec.ts`
- Modify: `booking-app/apps/api/src/messaging/queues/worker-registrar.service.ts`
- Test: `booking-app/apps/api/test/integration/worker-bootstrap.int.spec.ts`

- [ ] **Step 1: Add RED tests**

Add `localDateToDateColumn('2026-02-30')` expecting `INVALID_LOCAL_TIME`. Add a foreign-organization notification load expecting `null`. Spy on `organizations.refresh`, reject once, run `runWithJobScope`, and assert the callback still returns the cached setting.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk pnpm api test -- local-time.spec.ts
rtk pnpm api test:integration -- notifications.int.spec.ts worker-bootstrap.int.spec.ts
```

Expected: impossible date is normalized, the foreign booking throws `NOT_FOUND`, and the callback is skipped on refresh failure.

- [ ] **Step 3: Implement the minimal fixes**

Validate date values through `parseLocalDate(date, 'UTC')` before constructing the UTC-midnight `Date`. Change notification lookup to `findFirst({ where: { id, organizationId } })`; catch only `isAppError(error, 'NOT_FOUND')` from `financials.load` and return null. Wrap worker refresh in `try/catch`, log the error stack/details, and always execute `fn()`.

- [ ] **Step 4: Verify GREEN**

Run the commands from Step 2 and expect PASS.

### Task 4: Include pending cancellation refunds in the promise

**Files:**
- Modify: `booking-app/apps/api/src/notification/processors/booking-event.processor.ts`
- Test: `booking-app/apps/api/test/integration/notifications.int.spec.ts`

- [ ] **Step 1: Add a pending-refund notification regression**

Create a `PENDING` cancellation refund, process `booking.canceled`, and inspect the queued payload. Assert `refundedCents` equals the pending amount and `retainedCents` equals paid minus pending.

- [ ] **Step 2: Verify RED**

Run: `rtk pnpm api test:integration -- notifications.int.spec.ts`

Expected: payload reports zero refunded and the full paid amount retained.

- [ ] **Step 3: Compute promised refunds**

Keep `refundedFrom` unchanged for settled-money consumers. Add a processor-local helper that sums refund rows with status `PENDING` or `SUCCEEDED` through `Money`, and use it only for cancellation template data.

- [ ] **Step 4: Verify GREEN**

Run the focused notification integration test and expect PASS.

### Task 5: Correct migration and stale source documentation

**Files:**
- Modify: `booking-app/apps/api/prisma/migrations/20260802120000_financial_booking_root/migration.sql`
- Modify: `booking-app/apps/api/src/booking/booking.module.ts`
- Modify: `booking-app/apps/api/src/office/requests.service.ts`

- [ ] **Step 1: Update the migration**

Add the FK with `NOT VALID`, validate it in a separate `ALTER TABLE`, and replace the index statement with:

```sql
-- Prisma 7 does not wrap PostgreSQL custom migrations in a transaction.
CREATE INDEX CONCURRENTLY "bookings_financial_root_booking_id_idx"
  ON "bookings"("financial_root_booking_id");
```

- [ ] **Step 2: Correct module and reachability comments**

State that `PaymentModule` imports neither `NotificationModule` nor `BookingModule`. Change `assertCancellationReachable` to `Promise<void>`, select only employee ID, and remove its `financials.load`, `receivedFrom`, and now-unused dependencies/imports.

- [ ] **Step 3: Validate compile and migration drift**

Run:

```bash
rtk pnpm api typecheck
rtk pnpm api exec prisma validate
```

Expected: PASS.

### Task 6: Strengthen regression coverage and progress documentation

**Files:**
- Modify: `booking-app/apps/api/test/integration/booking-financials.int.spec.ts`
- Modify: `booking-app/apps/api/test/integration/notifications.int.spec.ts`
- Modify: `booking-app/apps/api/test/integration/worker-bootstrap.int.spec.ts`
- Modify: `booking-app/docs/plans/implementation-progress.md`

- [ ] **Step 1: Prove constant query cost**

Import `queryCounter` from `public-app.harness`, reset it around `loadMany([rootId])` and the three-booking page, and assert equal totals while retaining map/payment assertions.

- [ ] **Step 2: Cover reschedule suppression and reminder work**

Create a replacement booking and call `rescheduled` with `customerNotificationAlreadyQueued: true`. Assert no `BOOKING_RESCHEDULED` notification exists, the old reminder job is removed, and the replacement reminder is scheduled.

- [ ] **Step 3: Guarantee cleanup**

Wrap the worker settings mutation/assertion in `try/finally`; restore `smsRemindersEnabled` in `finally`.

- [ ] **Step 4: Reconcile Playwright counts**

Document 22 scenario declarations: 18 run in desktop and mobile, four accessibility scenarios run desktop-only, totaling 40 passing project runs. Preserve the separate missing-`EXPIRING` note.

- [ ] **Step 5: Verify focused suites**

Run:

```bash
rtk pnpm api test:integration -- booking-financials.int.spec.ts notifications.int.spec.ts worker-bootstrap.int.spec.ts
rtk pnpm prettier --check booking-app/docs/plans/implementation-progress.md
```

Expected: PASS.

### Task 7: Verify, publish, and close review threads

**Files:**
- Do not modify: `booking-app/apps/api/src/messaging/queues/job-contracts.ts`
- Do not modify: `docs/superpowers/plans/2026-08-02-booking-review-remediation.md`

- [ ] **Step 1: Run complete relevant verification**

Run:

```bash
rtk pnpm lint
rtk pnpm format
rtk pnpm typecheck
rtk pnpm test
rtk pnpm test:integration
rtk pnpm build
```

- [ ] **Step 2: Review the final diff**

Run `rtk git diff --check`, `rtk git status --short`, and `rtk git diff --stat`. Confirm only PR-remediation files changed.

- [ ] **Step 3: Commit and push**

Stage only the remediation files and commit with a concise security/data-integrity body. Push `feat/p1-09-financial-root`.

- [ ] **Step 4: Reply and resolve rejected threads**

Reply in the nullable-contract thread that omitted legacy fields are accepted by `.optional()`, no producer emits null, and widening is unsupported. Reply in both historical-plan threads that `implementation-progress.md` intentionally preserves and enumerates the corrected deviations. Resolve all three.

- [ ] **Step 5: Resolve accepted threads**

After confirming the pushed SHA, reply briefly where context helps and resolve all accepted inline threads. Add one top-level reply for the outside-diff `assertCancellationReachable` finding.
