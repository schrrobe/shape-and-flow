# PR #3 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every technically valid unresolved review finding on PR #3, verify the branch, and reply to and resolve all 43 review threads.

**Architecture:** Preserve existing module boundaries and combine duplicate findings by root cause. Behavioral changes are driven by focused regression tests; CI, documentation, and test-harness corrections remain minimal and use existing project conventions.

**Tech Stack:** TypeScript 6, NestJS 11, Prisma 7/PostgreSQL 17, BullMQ 6/Redis 7, Zod 4, Stripe Node 22, Vitest 4, pnpm 10.

## Global Constraints

- Keep the existing `@nestjs/common/constants.js` metadata import.
- Do not add a non-cancelling Promise timeout around BullMQ enqueue.
- Keep Prisma-generated identifiers as CUID v1; do not change contracts to CUID2.
- Preserve the documented unfenced idempotency-lease limitation.
- Use focused red-green cycles for every production behavior change.
- Do not resolve a fixed GitHub thread until its commit is pushed to the PR branch.

---

### Task 1: Toolchain baseline and CI environment

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `booking-app/apps/api/test/redis.harness.ts`

**Interfaces:**
- Consumes: Prisma postinstall's `DATABASE_URL` requirement and Vitest's configured `REDIS_URL`.
- Produces: dependency installation in every CI job and a fail-fast Redis test harness.

- [ ] **Step 1: Install dependencies in the isolated worktree**

Run with a non-secret local Prisma URL:

```bash
DATABASE_URL=postgresql://booking:booking@localhost:5433/booking?schema=public pnpm install --frozen-lockfile
```

- [ ] **Step 2: Verify the baseline unit suite**

Run: `pnpm test`

Expected: all existing unit tests pass before implementation.

- [ ] **Step 3: Add the CI install environment**

Add a workflow-level `DATABASE_URL` using the development-shape local URL. The
integration and e2e job-level values continue to override it.

- [ ] **Step 4: Require the integration Redis URL**

Replace the fallback with an explicit guard:

```ts
const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || redisUrl === '') {
  throw new Error('REDIS_URL is required for integration tests.');
}
export const redis: Redis = createRedisConnection(redisUrl);
```

- [ ] **Step 5: Validate configuration changes**

Run: `pnpm format && pnpm typecheck`

Expected: both commands exit 0.

---

### Task 2: Request idempotency correctness

**Files:**
- Modify: `booking-app/apps/api/src/messaging/idempotency/idempotency.interceptor.ts`
- Modify: `booking-app/apps/api/src/messaging/idempotency/idempotency.service.ts`
- Modify: `booking-app/apps/api/src/messaging/idempotency/request-hash.ts`
- Modify: `booking-app/apps/api/src/messaging/idempotency/request-hash.spec.ts`
- Modify: `booking-app/apps/api/test/integration/idempotency.int.spec.ts`

**Interfaces:**
- Consumes: `IdempotencyService.begin`, `complete`, `abandon`, Prisma JSON-null values, and the injected clock.
- Produces: stable hashing for absent bodies, expiry-aware replay, bounded sweeping, redacted takeover logs, and failure handling that preserves successful mutations.

- [ ] **Step 1: Write failing hash and expiry tests**

Add assertions equivalent to:

```ts
expect(canonicalRequestJson(undefined)).toBe('null');
expect(canonicalRequestHash(undefined)).toMatch(/^[0-9a-f]{64}$/);

await service.complete(KEY, 201, { old: true });
clock.advanceMinutes(24 * 60 + 1);
expect(await service.begin(KEY, 'booking.create', 'h1')).toEqual({ outcome: 'NEW' });
```

Also test that a stored null response replays as null and that sweeping more than
one batch returns the accumulated count.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm api test -- src/messaging/idempotency/request-hash.spec.ts
pnpm api test:integration -- test/integration/idempotency.int.spec.ts
```

Expected: new assertions fail for undefined hashing, expired replay, and batching.

- [ ] **Step 3: Implement canonical hashing and service fixes**

Normalize `undefined` before serialization. Use `Prisma.JsonNull` for a null body.
For an expired completed row, conditionally delete the expired row and retry
`begin`. Add `IDEMPOTENCY_SWEEP_BATCH_SIZE`, select expired IDs with `take`, delete
those IDs, and loop until fewer than a batch were selected. Hash the key before
logging takeover and inspect `updateMany().count` in `complete`.

- [ ] **Step 4: Write a failing interceptor completion test**

Inject a one-shot `complete` failure and assert that the HTTP request fails while
the `IN_PROGRESS` row remains. Existing handler-failure coverage must continue to
assert that the row is deleted.

- [ ] **Step 5: Verify interceptor RED**

Run: `pnpm api test:integration -- test/integration/idempotency.int.spec.ts`

Expected: the completion-failure row is currently deleted.

- [ ] **Step 6: Separate the RxJS failure stages**

Place handler `catchError` before `concatMap` so `abandon(key)` handles only
handler failures. Keep completion errors outside that catch. Remove the unused
`id` property from `bookingIdOf`'s cast.

- [ ] **Step 7: Verify idempotency GREEN**

Run the two focused commands from Step 2 again.

Expected: all focused unit and integration tests pass.

---

### Task 3: Inbox, outbox, queues, and integration-test reliability

**Files:**
- Modify: `booking-app/apps/api/src/messaging/inbox/inbox.reconciler.ts`
- Modify: `booking-app/apps/api/src/messaging/outbox/outbox.reconciler.ts`
- Modify: `booking-app/apps/api/src/messaging/queues/job-contracts.spec.ts`
- Modify: `booking-app/apps/api/src/messaging/queues/queues.module.ts`
- Modify: `booking-app/apps/api/test/integration/inbox.int.spec.ts`
- Modify: `booking-app/apps/api/test/integration/outbox.int.spec.ts`
- Modify: `booking-app/apps/api/test/integration/queues.int.spec.ts`

**Interfaces:**
- Consumes: health counts, `SAMPLE_LIMIT`, `OUTBOX_BATCH_SIZE`, fixed clocks, and BullMQ default job options.
- Produces: accurate totals, bounded failed-job retention, and deterministic teardown/concurrency tests.

- [ ] **Step 1: Add failing count regressions**

Create more than `SAMPLE_LIMIT` poisoned/stalled rows and assert returned/logged
totals exceed the sample size. Add a future unavailable row and assert it does not
define `oldestPendingAgeSeconds`.

- [ ] **Step 2: Verify count RED**

Run:

```bash
pnpm api test:integration -- test/integration/inbox.int.spec.ts
pnpm api test:integration -- test/integration/outbox.int.spec.ts
```

Expected: totals saturate at the sample size and the oldest predicate differs.

- [ ] **Step 3: Implement reconciler count fixes**

Add table count queries beside inbox samples. Pass `health.stalled` and
`health.exhausted` into outbox `report(label, total, where)`. Use `pendingWhere`
for the oldest-row query.

- [ ] **Step 4: Correct queue and test fixtures**

Add `count: 20_000` to `removeOnFail`. Build a valid fixture for every tenant job,
remove only `organizationId`, and assert the issue path names that field. Derive
outbox dates from `clock.now()` and concurrent totals from
`2 * OUTBOX_BATCH_SIZE`.

- [ ] **Step 5: Harden teardown and lock tests**

Move `disconnectRedis` hooks to file scope, race the lock-ready signal against the
holder promise so early holder rejection propagates, scope app shutdown with
`try/finally`, and keep terminal connection assertions after shutdown.

- [ ] **Step 6: Verify queue and messaging GREEN**

Run:

```bash
pnpm api test -- src/messaging/queues/job-contracts.spec.ts
pnpm api test:integration -- test/integration/inbox.int.spec.ts test/integration/outbox.int.spec.ts test/integration/queues.int.spec.ts
```

Expected: all focused suites pass.

---

### Task 4: Payment, Stripe, configuration, and SMS adapters

**Files:**
- Modify: `booking-app/apps/api/src/providers/payment/fake-payment.provider.ts`
- Modify: `booking-app/apps/api/src/providers/payment/fake-payment.provider.spec.ts`
- Modify: `booking-app/apps/api/src/providers/payment/stripe-payment.provider.ts`
- Modify: `booking-app/apps/api/src/providers/payment/stripe-payment.provider.spec.ts`
- Modify: `booking-app/apps/api/src/providers/payment/stripe.errors.ts`
- Modify: `booking-app/apps/api/src/providers/providers.module.ts`
- Modify: `booking-app/apps/api/src/providers/fake-messaging.spec.ts`
- Modify: `booking-app/apps/api/src/providers/sms/sms-provider.ts`
- Modify: `booking-app/apps/api/src/providers/sms/fake-sms.provider.ts`

**Interfaces:**
- Consumes: provider input types, `Money.equals`, Stripe's status/expiry contract, and fake messaging tests.
- Produces: Stripe-compatible fake idempotency, closed status mapping, valid expiry bounds, trimmed secrets, and encoding-aware three-segment SMS validation.

- [ ] **Step 1: Add failing fake-provider mismatch tests**

Reuse a checkout/refund idempotency key with a changed amount and with another
changed request field. Assert rejection with `IDEMPOTENCY_KEY_REUSED`; retain the
identical-input replay assertions.

- [ ] **Step 2: Add failing Stripe and SMS boundary tests**

Assert unknown/null session status maps to `open`, requested expiry beyond 24
hours clamps to exactly 24 hours, configured secrets are trimmed, 459 GSM-7
septets pass, 460 fail, 201 UCS-2 code units pass, and 202 fail.

- [ ] **Step 3: Verify provider RED**

Run:

```bash
pnpm api test -- src/providers/payment/fake-payment.provider.spec.ts src/providers/payment/stripe-payment.provider.spec.ts src/providers/fake-messaging.spec.ts
```

Expected: every new boundary assertion fails before implementation.

- [ ] **Step 4: Implement fake-provider request comparison**

Store the original checkout input on each fake session and compare all scalar
fields, dates, and `Money.equals`. Compare refund charge, amount, and reason before
replay. Throw `AppError('IDEMPOTENCY_KEY_REUSED')` on a mismatch.

- [ ] **Step 5: Implement Stripe and configuration fixes**

Add `toSessionStatus(value: string | null)`, export
`STRIPE_MAX_SESSION_TTL_MINUTES = 24 * 60`, clamp between min and max using one
clock reading, return trimmed required values, and narrow `describeStripeError`'s
docblock to excluding serialization of the raw request object.

- [ ] **Step 6: Implement encoding-aware SMS bounds**

Count GSM-7 basic characters as one septet and extension-table characters as two;
otherwise count UTF-16 code units as UCS-2. Reject messages requiring more than
three concatenated segments (459 GSM-7 septets or 201 UCS-2 units).

- [ ] **Step 7: Verify provider GREEN**

Run the focused provider command from Step 3 again.

Expected: all focused provider tests pass.

---

### Task 5: Public availability and per-app test state

**Files:**
- Modify: `booking-app/apps/api/src/public/availability-snapshot.service.ts`
- Modify: `booking-app/apps/api/test/integration/public-availability.int.spec.ts`
- Modify: `booking-app/apps/api/test/integration/public-catalog.int.spec.ts`
- Modify: `booking-app/apps/api/test/public-app.harness.ts`

**Interfaces:**
- Consumes: `AVAILABILITY_MAX_RANGE_DAYS`, `Prisma.TransactionClient`, organization context, fixed clock, and query counting.
- Produces: service-layer range/pair validation and isolated public test applications.

- [ ] **Step 1: Add failing service-boundary tests**

Call `AvailabilitySnapshotService.load` with a range beyond 31 days and
`loadForSlot` with an employee not linked to the service. Assert rejection before
availability data queries proceed.

- [ ] **Step 2: Add a failing two-app isolation test**

Open two apps with distinct organization/clock values, query both while live, and
assert each retains its own organization and query counter.

- [ ] **Step 3: Verify availability RED**

Run:

```bash
pnpm api test:integration -- test/integration/public-availability.int.spec.ts test/integration/public-catalog.int.spec.ts
```

Expected: direct service range/pair checks and simultaneous app isolation fail.

- [ ] **Step 4: Implement snapshot guards**

Import `AVAILABILITY_MAX_RANGE_DAYS`, compare inclusive local-date distance before
database reads, and extend `loadEmployeeIds` with an optional transaction client so
`loadForSlot` validates the employee/service link in the caller's transaction.

- [ ] **Step 5: Make harness state per app**

Build a global dynamic testing module per `createPublicTestApp` invocation. Capture
organization and clock in provider values, construct the extended Prisma client and
query counter per invocation, and return that counter in `TestApp`.

- [ ] **Step 6: Apply mechanical test corrections**

Capture the created time-off row ID and scope `updateMany` to it. Update existing
query-count callers to use the counter returned by their app.

- [ ] **Step 7: Verify availability GREEN**

Run the focused integration command from Step 3 again.

Expected: all public integration tests pass.

---

### Task 6: Contracts and progress documentation

**Files:**
- Modify: `booking-app/packages/contracts/src/primitives.ts`
- Modify: `booking-app/packages/contracts/src/contracts.spec.ts`
- Modify: `booking-app/docs/plans/implementation-progress.md`

**Interfaces:**
- Consumes: Prisma CUID v1 output, wire money schemas, and the completed task table.
- Produces: exact CUID/currency validation and synchronized operational guidance.

- [ ] **Step 1: Add failing primitive tests**

Assert a seeded CUID v1 passes, a numeric-leading alphanumeric string fails, and
`eur`, `EU1`, and `€UR` fail money validation while `EUR` passes.

- [ ] **Step 2: Verify contracts RED**

Run: `pnpm --filter @shape-and-flow/booking-contracts test`

Expected: malformed CUID and three-character invalid currencies are accepted.

- [ ] **Step 3: Implement native CUID v1 and currency schemas**

Use `z.cuid()` and `z.string().regex(/^[A-Z]{3}$/)`.

- [ ] **Step 4: Synchronize progress documentation**

Set completed tasks to 21, add 5.1 to Done, remove 4.3/4.4/5.1 from Next, and
clarify durable delivery keys, visible Redis-prefix readiness failure, and the
persist-commit-enqueue-reconcile webhook sequence.

- [ ] **Step 5: Verify contracts GREEN and docs format**

Run:

```bash
pnpm --filter @shape-and-flow/booking-contracts test
pnpm format
```

Expected: contracts pass and formatting is clean.

---

### Task 7: Full verification and branch publication

**Files:**
- Inspect: all files changed by Tasks 1-6

**Interfaces:**
- Consumes: the complete implementation diff.
- Produces: fresh evidence that the branch meets every repository gate.

- [ ] **Step 1: Inspect the diff and whitespace**

Run:

```bash
git diff --check
git diff --stat
```

- [ ] **Step 2: Run all repository gates**

Run in order:

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Expected: every command exits 0 with no failures.

- [ ] **Step 3: Commit the remediation**

Stage only the reviewed files and commit with a concise Conventional Commit
message that records the correctness and integrity fixes.

- [ ] **Step 4: Push the PR branch**

Run: `git push origin feat/p1-02-contracts-messaging`

Expected: the remote branch contains both the design and implementation commits.

---

### Task 8: Reply to and resolve all review threads

**Files:**
- No repository files.

**Interfaces:**
- Consumes: GitHub thread IDs, pushed commits, and verification results.
- Produces: inline technical replies and resolved state for all 43 processed threads.

- [ ] **Step 1: Re-fetch unresolved thread state**

Run the bundled `fetch_comments.py` workflow and confirm the expected 43 thread
IDs are still unresolved and current.

- [ ] **Step 2: Reply to fixed threads**

Use the inline review-comment reply endpoint. State the concrete behavior changed
and the focused/full test evidence; combine duplicate-root-cause wording without
posting top-level PR comments.

- [ ] **Step 3: Reply to rejected threads**

Post the six technical explanations from the approved design: Nest metadata,
non-cancellable Redis timeout, existing transaction-client coverage, obsolete
harness warning, already-narrow idempotency limitation, and existing
`SKIP LOCKED` coverage.

- [ ] **Step 4: Resolve every replied thread**

Resolve by GraphQL thread ID only after its reply succeeds.

- [ ] **Step 5: Re-fetch and verify zero unresolved current threads**

Expected: no unresolved non-outdated review threads remain on PR #3.

- [ ] **Step 6: Recheck PR checks**

Run: `gh pr checks 3`

Report pending checks as pending; do not claim remote success until GitHub reports
it.
