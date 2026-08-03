# PR #3 Review Remediation Design

## Goal

Address every unresolved review thread on PR #3 according to the current code,
not according to the review bot's proposed patch: implement each valid finding,
explain each rejected finding in its inline thread, and resolve all processed
threads only after the corresponding code is available on the PR branch.

## Scope and approach

The 43 open threads form 37 actionable findings and 6 findings that should not
produce code changes. Overlapping findings share one implementation and one test
cycle. Changes remain local to the reviewed behavior; no unrelated refactoring,
new product behavior, or speculative worker implementation is included.

Each behavioral fix follows red-green-refactor. Documentation, CI configuration,
and mechanical test-harness corrections receive the smallest direct change and
are covered by the nearest available validation command.

## Actionable clusters

### CI and configuration

- Provide `DATABASE_URL` before the shared dependency-install action runs. This
  fixes the observed lint and unit-test failures at Prisma's postinstall step;
  integration and end-to-end jobs keep their job-specific database URLs.
- Require `REDIS_URL` in the integration Redis harness instead of duplicating the
  Vitest default.

### Request idempotency

- Separate handler failures from response-snapshot completion failures. Only a
  handler failure abandons its lease; a completion failure leaves the row in
  progress so a successful mutation is not immediately re-run.
- Treat expired completed rows as absent, normalize an undefined top-level body,
  use Prisma's explicit JSON-null value, fingerprint keys in logs, report a
  conditional completion no-op, and delete expired keys in indexed bounded
  batches.
- Keep response booking extraction aligned with the documented `bookingId`
  response field by removing the unused generic `id` member.

### Inbox, outbox, and queues

- Separate sampled rows from total poisoned/stalled/exhausted counts and use the
  same pending predicate for the oldest pending age.
- Correct tenant-scope fixtures and bound retained failed BullMQ jobs by count.
- Make outbox integration tests derive timestamps and totals from the injected
  clock and exported batch size, propagate early lock-holder failures, and move
  Redis teardown to file scope.

### Provider adapters

- Make the fake payment provider reject an idempotency key reused with different
  checkout or refund parameters while preserving identical-request replay.
- Runtime-narrow Stripe Checkout session status, clamp session expiry to Stripe's
  documented 30-minute-to-24-hour interval, trim configured secrets, and narrow
  the Stripe error helper's safety documentation to what it guarantees.
- Enforce the documented three-segment SMS limit for GSM-7 and UCS-2 input rather
  than treating 480 JavaScript code units as universally valid.

### Public availability and test isolation

- Enforce the public maximum range in the snapshot service as well as the
  controller contract, and validate the employee/service pairing inside
  `loadForSlot` using its transaction client.
- Scope the time-off update to the row created by its test and guarantee Nest app
  shutdown with `finally`.
- Make organization, clock, Prisma query counter, and extended Prisma client local
  to each public test-app instance so simultaneously live apps cannot interfere.

### Contracts and progress documentation

- Use Zod's native CUID v1 validator, not `cuid2`: Prisma currently generates
  CUID v1 with `@default(cuid())`. Reject malformed IDs without changing the ID
  format accepted by existing database rows.
- Restrict currencies to three uppercase ASCII letters.
- Synchronize completed-task counts and clarify future durable-delivery,
  Redis-prefix readiness, and webhook enqueue requirements.

## Findings resolved without code changes

1. Keep importing Nest's `HTTP_CODE_METADATA`. Copying the private string
   `__httpCode__` would stop tracking the pinned Nest package and is less robust
   than importing the package's own constant.
2. Do not add a `Promise.race` timeout around BullMQ enqueue. It cannot cancel the
   Redis command, so the command may succeed after the row has been marked failed.
   The existing transaction timeout already bounds the database lock; a cancellable
   producer would require a separate connection design outside this PR.
3. Do not add another transaction-client guard test. The existing real Prisma
   transaction rollback test proves the callback client is accepted, and the next
   test proves the root client is rejected.
4. The single-organization harness warning becomes obsolete when state is captured
   per application instance.
5. Do not rewrite the documented idempotency guarantee: the progress document
   already names the unfenced lease race and narrows safety to the booking exclusion
   constraint.
6. Do not add another `SKIP LOCKED` test. The existing test holds a row in a
   separate transaction, verifies a second drain skips it promptly, and then
   verifies it is claimed after release.

## Verification and GitHub handling

Run focused tests after each cluster, followed by workspace lint, formatting,
typecheck, unit tests, integration tests, and build. Re-run the PR checks after the
branch is pushed. For each code-backed thread, reply with the implemented behavior
and verification; for each rejected thread, reply with the technical reason above.
Resolve a thread only after its reply is posted and, for fixes, the commit is on the
PR branch.
