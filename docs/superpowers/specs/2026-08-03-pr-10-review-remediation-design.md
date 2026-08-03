# PR 10 Review Remediation Design

## Goal

Resolve every open review thread on PR #10 by implementing technically valid findings and
replying with evidence where a suggestion would weaken the code or its historical record.

## Scope

Thirteen findings are accepted:

- make refund authorization fail closed and make a requested non-zero business refund fail
  when no settled payment exists;
- report pending cancellation refunds as promised money instead of zero in cancellation
  notifications;
- scope notification booking reads to the active organization and treat a financial-row race
  as a missing booking;
- let jobs continue on the last-known-good organization settings when a refresh fails;
- reject impossible local dates;
- add the financial-root foreign key without validation, validate it separately, and build its
  index concurrently;
- correct the booking module dependency comment and remove the stale cancellation-request
  financial read;
- prove `loadMany` has constant query cost, cover reschedule-notification suppression and
  reminder work, and guarantee worker-test cleanup;
- reconcile the end-to-end documentation with the actual 22 scenarios and 40 project runs.

Three findings are rejected:

- `customerNotificationAlreadyQueued` remains optional but non-nullable. Old queued payloads
  omit the new field, which `.optional()` accepts; no current or historical producer writes
  `null`, so accepting it would widen the contract without a compatibility case.
- The two findings against the completed remediation plan are resolved without rewriting the
  plan. That file is the historical execution input; `implementation-progress.md` deliberately
  records the five invalid snippets and the corrected implementation, preserving both cause and
  outcome.

## Design

### Financial authorization and cancellation

Every refund-producing cancellation path supplies an explicit capability decision to the
reservation boundary. A missing or false decision denies a positive reservation. Customer-owned
automatic cancellations pass the trusted capability explicitly; office decisions propagate the
session capability. Business cancellations additionally choose strict refund lookup for a
positive explicit amount, so cancellation and refund remain one atomic result.

Cancellation notifications keep their current timing and templates. Their refund total includes
both settled and pending refund rows, because the template says money is being returned and the
cancellation transaction already committed that promise. Retained money is derived from the same
promised total. The existing refund-settled notification remains unchanged.

### Tenant and worker resilience

Notification booking reads use `findFirst` with the active organization ID. If the booking is
deleted between that read and the financial read, the expected `NOT_FOUND` becomes `null`, keeping
the processors' existing missing-booking behavior. Other errors still propagate.

Each worker job attempts to refresh organization settings inside its correlation scope. Refresh
failure is logged with error details, but the handler runs with the cache that `refresh()` leaves
unchanged until a complete replacement has loaded.

### Migration and documentation

The new foreign key is added `NOT VALID` and validated in a separate statement. The index uses
`CREATE INDEX CONCURRENTLY` in the same migration: Prisma 7's PostgreSQL migration execution does
not add an automatic transaction around custom SQL. A comment records that constraint so a future
explicit transaction is not added accidentally.

The progress summary describes the real Playwright matrix: 22 scenarios, 18 executed in desktop
and mobile plus four desktop-only accessibility scenarios, for 40 passing runs.

## Verification

Behavioral changes follow red-green TDD with focused unit or integration tests. Refactors and
documentation receive typecheck, lint/format, migration drift validation, and relevant focused
tests. Before publishing, run the complete repository verification appropriate to the changed API,
contracts, templates, and documentation. Push one review-remediation commit, reply in rejected
threads with the evidence above, and resolve every open thread only after the pushed code or reply
exists.
