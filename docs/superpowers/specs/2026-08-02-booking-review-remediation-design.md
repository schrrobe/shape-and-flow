# Booking Review Remediation Design

**Date:** 2026-08-02

**Status:** Approved for implementation

**Scope:** All 16 production-impacting review findings covering reservations, checkout,
notifications, rescheduling, refunds, authorization, worker settings, web draft state,
and audit history.

## Context

The current branch implements the Phase 1 booking application, but several boundaries do
not preserve the invariants already implied by the public catalog, payment model, durable
notification system, or audit design. The defects are individually visible at different
surfaces, but they cluster around five shared causes:

1. reservation acceptance does not use the same employee-service assignment as public
   discovery;
2. a booking attempt and its idempotency lease are not durably linked before Checkout;
3. request workflows bypass the notification-row abstraction;
4. financial state is attached to the original booking while consumers read only the
   replacement booking; and
5. critical counters and balances are calculated from stale snapshots rather than updated
   under the row lock that protects them.

The remediation will fix those shared causes. It will not add isolated conditionals at each
reported line when a common invariant can make the invalid state unrepresentable.

Existing uncommitted office-availability work is outside this design. Implementation must
preserve it, especially the current `reservation.service.ts` office-snapshot extraction.

## Goals

- A customer is charged the effective price advertised for the resolved employee.
- A public booking can only target a current, online-bookable employee-service assignment.
- A transient Checkout failure can be retried immediately without losing or duplicating the
  selected hold.
- Every notification job refers to a committed `Notification` row, and each request decision
  produces exactly one customer outcome message.
- Financial state remains reachable after any number of reschedules without rewriting its
  historical origin.
- Settled and pending refunds together can never exceed the provider payment.
- Refund authorization is based on the amount the transaction will actually reserve.
- Concurrent failed logins cannot undercount attempts or race through a newly established
  lockout.
- Worker policy reads observe settings saved by the API process before the next job runs.
- The public web flow preserves deliberate draft choices and rotates attempt credentials at
  the correct lifecycle boundaries.
- Each consequential office action writes one audit row with the correct entity ID.

## Non-goals

- Replacing BullMQ or the transactional outbox.
- Introducing Redis pub/sub cache invalidation or a general distributed cache framework.
- Creating a separate Order or Invoice aggregate.
- Changing Stripe refund settlement or webhook semantics beyond balance reservation.
- Reworking unrelated office availability, catalog administration, or visual design.
- Backfilling notifications that should have been sent before this release.

## Core invariants

The implementation and regression tests must enforce these invariants:

1. **One assignment, one price.** The employee-service assignment accepted by the locked
   reservation transaction is the assignment used to compute the price snapshot.
2. **One attempt, one hold.** A booking idempotency key with the same request hash resumes its
   bound booking; it does not create a second hold.
3. **Rows before jobs.** `notification.send` is emitted only by code that has created or found
   the corresponding `Notification` row in the same transaction.
4. **One financial root.** Every booking in a reschedule chain resolves to the same original
   financial root.
5. **Reserved refunds count.** Refundable balance equals provider payment amount minus
   successful refunds minus pending refunds.
6. **Permission follows effect.** Refund capability is required if and only if the decision
   reserves a positive additional provider refund.
7. **One mutation, one audit row.** A route uses either its service's transactional audit or
   the interceptor, never both.

## Design

### 1. Reservation assignment and effective pricing

`ReservationService` will resolve a concrete employee as it does today, then perform the
authoritative assignment-and-price lookup inside the calendar-lock transaction. The projection
returns the assignment's override together with the service's current list price and currency,
so the calculation cannot combine an old service read with a new assignment read. The lookup
must match:

- the ambient organization;
- the requested service;
- the resolved employee;
- an employee whose `archivedAt` is null; and
- an employee whose `isBookableOnline` is true for customer reservations.

An absent assignment returns the same public-safe not-found response used by availability and
creates no customer, booking, payment, or outbox rows. Office reservations may retain their
existing policy distinction only where the office catalog explicitly permits it; the public
path must never bypass the online-bookable filters.

The transaction computes `effectivePrice` with the existing `resolveEffectivePrice()` domain
function using `priceOverrideCents ?? service.priceCents`. That one `Money` value supplies:

- `Booking.priceCentsSnapshot`;
- `ReserveResult.price`;
- the public create-booking response; and
- Checkout, which continues to charge the immutable booking snapshot.

This applies whether the customer named an employee or selected “any employee.” The Checkout
interstitial already shows the resolved employee and authoritative response price before the
browser leaves for Stripe.

### 2. Resumable Checkout attempts

The existing `IdempotencyKey.bookingId` and `Booking.idempotencyKeyId` fields will link an
attempt to its hold before the provider call.

The sequence becomes:

1. the interceptor claims the key and request hash;
2. the reservation transaction creates the booking, binds both sides of the idempotency
   association, and records the delayed expiry event;
3. the API calls Checkout outside any transaction; and
4. session attachment creates the pending payment and stores the session ID idempotently.

On retry with the same key and request hash, the controller loads the bound reservation and
reuses it instead of calling `reserve()` again. It sends the same provider idempotency key and
the same booking parameters. If Stripe created a session before a timeout or attachment
failure, Stripe returns that session and the API completes the attachment. Attachment must be
safe when the same session and payment are already present.

Failure handling changes as follows:

- an unbound failed attempt is abandoned and deleted as today;
- a bound failed attempt keeps its request hash and booking association but releases its
  in-progress lease for immediate same-request takeover;
- a different body or scope with the same key remains `IDEMPOTENCY_KEY_REUSED`;
- every committed hold has an expiry outbox event even if Checkout never answers; and
- an expired or otherwise terminal bound booking is not resumed.

This chooses reuse over immediate release because a provider timeout can mean Stripe created
the session but the response was lost. Reusing the booking and provider key resolves that
ambiguity without creating two payable sessions.

### 3. Transactional request notifications

Cancellation and reschedule services will use `NotificationService.queue()` inside the same
transaction that creates or decides the request. They will never write `notification.send`
directly.

On request creation:

- cancellation queues `CANCELLATION_REQUEST_RECEIVED` for the customer and
  `OFFICE_CANCELLATION_REQUEST` for the office;
- reschedule queues `RESCHEDULE_REQUEST_RECEIVED` for both customer and office, matching the
  Phase 1 notification matrix; and
- audience-specific dedupe discriminators include the request ID so customer and office rows
  cannot collide.

On either approval or rejection, the customer receives exactly one
`CANCELLATION_REQUEST_DECIDED` or `RESCHEDULE_REQUEST_DECIDED` message. Approved decisions will
set an optional `customerNotificationAlreadyQueued` field on the downstream booking event. The
worker defaults an absent field to false for rolling-deployment compatibility and skips only the
generic customer cancellation/reschedule message when it is true. The event still performs its
other responsibilities, such as office contact and reminder scheduling.

A rejected reschedule keeps the existing management token valid, but its plaintext cannot be
reconstructed from the stored hash. The decided template will therefore accept a nullable
management URL and omit the link on rejection. Approval uses the newly rotated plaintext token.

All template data is frozen on the notification row. Reprocessing a request event or decision
must hit the dedupe key rather than send another message.

### 4. Stable financial root across reschedules

`Booking` will gain a nullable self-reference named `financialRootBookingId`.

- A booking that originally receives money has a null value and is its own financial root.
- A replacement booking stores `booking.financialRootBookingId ?? booking.id`.
- Every later replacement copies the same root, so lookup cost does not grow with chain length.

A migration will add the nullable foreign key and index, then backfill existing replacement
chains with a recursive query that finds their earliest ancestor. Original/root bookings remain
null. The relation uses restrictive deletion semantics; payments already make these records
historical and non-deletable.

A shared `BookingFinancialsService` will resolve the root and provide the projections used by:

- manage booking reads;
- office list, detail, customer, request, and export reads;
- booking notification data;
- cancellation policy and refund calculation;
- manual payment recording; and
- provider refund lookup.

Provider `Payment` and `ManualPayment` rows are attached to the financial root. A `Refund` keeps
the booking on which the action was requested for operational history, while its `paymentId`
identifies the root provider payment. Aggregate refund reads therefore follow the payment's
refunds, not only `Booking.refunds`.

Rescheduling does not move existing financial rows. This preserves the original sale while the
constant-time root link makes it available from every replacement.

### 5. Central refund reservation

`RefundService` will expose one transaction-aware reservation path used by explicit office
refunds and all cancellation flows. It will:

1. resolve and lock the settled provider payment with `FOR UPDATE`;
2. read `refundedAmountCents`, which represents successful refunds;
3. sum `PENDING` refund rows for that payment;
4. calculate `available = amount - successful - pending`;
5. validate or derive the additional amount; and
6. create the pending refund and outbox event before releasing the lock.

`FAILED` and `CANCELED` refunds do not reserve balance. Settlement continues to recompute the
denormalized successful total from `SUCCEEDED` rows.

Explicit office refunds are additional amounts and fail with `PAYMENT_NOT_REFUNDABLE` when they
exceed `available`. Policy-driven cancellation uses a cumulative target:

`target refund = gross paid - effective retained amount`

`additional refund = max(0, target refund - successful refunds - pending refunds)`

Thus a free cancellation after a partial refund reserves only the remaining delta. If the
target is already satisfied, cancellation proceeds without a new refund row.

The office request decision passes the session's refund capability into the transactional
service. The service applies the frozen suggested retention when the request omitted an
explicit value, computes the actual additional refund under the payment lock, and rejects the
decision only when that additional amount is positive and the actor lacks capability. The
controller may keep a fast precheck, but the transaction is authoritative.

### 6. Atomic login lockout

A failed password verification will enter a short transaction that atomically increments
`failedLoginAttempts`. The returned post-increment value determines whether `lockedUntil` is
set. Concurrent updates serialize on the office-user row, so two failures starting from eight
produce nine and ten rather than two writes of nine.

A successful password verification will reset the counter and create a session only after a
conditional database update confirms the row is still active and not locked at the transaction's
effective time. A concurrent threshold-setting failure that commits first therefore prevents
the login from clearing the new lock. Sequential behavior, dummy password verification, and the
generic invalid-credentials response remain unchanged.

### 7. Worker settings freshness

`WorkerRegistrarService` will inject `OrganizationContextService` and call `refresh()` before
dispatching each validated job. Each worker process and replica therefore reads current settings
from PostgreSQL immediately before policy-sensitive work.

The API process keeps its existing post-update refresh. The one database read per worker job is
accepted for Phase 1 because it is simple, fleet-safe, and covers every current and future job;
a single BullMQ invalidation job would refresh only one replica, while Redis pub/sub would add a
new failure boundary and reconnect protocol.

### 8. Public web attempt state

The persisted draft will store `employeeChosen` separately from nullable `employeeId`. For old
stored drafts, a non-null employee ID implies chosen; an old null value remains unchosen because
the old shape cannot distinguish “any” from absence safely. New drafts persist the distinction.

The store will add an explicit expired-reservation transition that:

- clears the slot and in-memory reservation;
- mints and persists a new idempotency key; and
- preserves service, employee choice, and customer details.

`RedirectToCheckout` uses that transition on expiry. Generic `clearSlot()` keeps its current
meaning for pre-reservation validation failures.

`BookingSuccess` copies the confirmation email to component-local state before calling
`draft.reset()`. The page renders the local copy while the key and persisted personally
identifying data are still cleared immediately.

### 9. Audit correctness

The following handlers will lose their `@Audited` decorators because their services already
write transactional audit rows:

- business cancellation;
- complete booking;
- mark no-show;
- decide cancellation request; and
- decide reschedule request.

They will be registered in the authorization test's established service-audited allowlist so a
future metadata check does not reintroduce duplicate interceptor writes.

For interceptor-owned routes, `AuditSpec` will support an explicit response ID field. Manual
booking creation declares `bookingId`; refund creation declares `refundId`. The interceptor uses
that configured field before falling back to top-level `id` or the path parameter. This avoids a
generic priority list that could select `bookingId` from a response whose audited entity is the
refund.

## Error handling and transaction boundaries

- No provider call occurs inside a database transaction.
- Reservation, idempotency binding, and expiry scheduling commit together.
- Request state, notification rows, and their send outbox events commit together.
- Refund balance validation, pending-refund creation, and its outbox event commit under the same
  payment lock.
- Audit rows for transactional service mutations commit with those mutations.
- A notification provider failure changes only notification state; it never rolls back the
  booking/request decision.
- A Checkout provider failure returns the existing 502-style public error while leaving a
  resumable, expiring hold.
- Public assignment failures do not reveal whether an employee, service, or pairing exists.

## Migration and rollout

The only required schema migration adds `financialRootBookingId`, its self-foreign key, index,
and backfill. The column is nullable, so the migration is compatible with the old application
during a rolling deployment. New code treats null as self/root.

Job payload additions used to suppress duplicate customer messages must be optional and default
to the existing behavior so API and worker versions can overlap safely. API and worker should
still be deployed as one release because template/data changes are compiled into both.

No existing payment, refund, booking, idempotency, notification, or audit row is deleted by the
rollout.

## Testing strategy

Implementation follows regression-first development. Each test must fail against the current
behavior before the production change is applied.

### Review-finding traceability

| Review finding                        | Design owner                   | Required regression evidence                                      |
| ------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| Employee-specific price ignored       | Reservation assignment/pricing | Response, snapshot, payment, and provider amount use the override |
| Explicit employee trusted             | Reservation assignment/pricing | Unassigned, hidden, and archived employees are rejected           |
| Request alert has no notification row | Transactional notifications    | Every send event resolves to a committed row                      |
| Reschedule loses payment access       | Stable financial root          | Money remains visible/refundable after two reschedules            |
| Login failures undercount             | Atomic login lockout           | Parallel failures reach the threshold exactly                     |
| Checkout failure strands hold         | Resumable Checkout             | Same-key retry reuses one booking/session                         |
| Worker settings stay stale            | Worker settings freshness      | Independent worker uses the saved setting on its next job         |
| Cancellation over-refunds             | Central refund reservation     | Cancellation reserves only the remaining delta                    |
| Rejection is silent                   | Transactional notifications    | Both rejected request types queue decided messages                |
| Pending refund is ignored             | Central refund reservation     | A pending row reduces available balance immediately               |
| Permission uses zero fallback         | Central refund reservation     | Omitted full-retention suggestion needs no capability             |
| “Any employee” is not persisted       | Public web state               | Reload preserves explicit-any reachability                        |
| Expired Checkout reuses key           | Public web state               | Expiry rotates the key while retaining details                    |
| Success email is cleared              | Public web state               | Confirmed copy survives draft reset                               |
| Transactional routes audit twice      | Audit correctness              | Five real routes each create exactly one row                      |
| Audit uses the wrong entity ID        | Audit correctness              | Manual booking/refund rows use response entity IDs                |

### Reservation and Checkout

- explicit employee higher, lower, and zero-price overrides match response, snapshot, pending
  payment, and provider amount;
- “any employee” uses the resolved employee's override;
- unassigned, hidden, and archived employees cannot be booked;
- a provider failure followed by a same-key retry succeeds with one booking and one session;
- a session-attachment failure resumes the same provider session;
- a changed body with the bound key remains rejected; and
- every committed reservation has an expiry event before Checkout succeeds.

### Notifications and requests

- every request-created send job resolves to a real notification row;
- required customer and office rows are created with distinct dedupe keys;
- rejection queues the appropriate decided template with `approved: false`;
- approval produces exactly one customer outcome message; and
- repeated processing does not create or send duplicates.

### Financial lineage and refunds

- manage and office views show payment/refund state after one and two reschedules;
- cancellation and explicit refund locate the provider charge after repeated reschedules;
- manual payment and export totals follow the same financial root;
- a pending refund reduces the next request's available balance;
- concurrent refund requests cannot reserve more than the payment total;
- failed/canceled refunds release their reserved balance;
- cancellation after successful and pending partial refunds creates only the remaining delta;
  and
- an actor without refund capability may approve an omitted full-retention suggestion but may
  not reserve a positive refund.

### Authentication, settings, web state, and audit

- parallel failed logins cross the threshold without lost increments;
- a valid login cannot clear a lock established first by a concurrent failure;
- an independently bootstrapped worker uses settings changed by the API before its next job;
- “any employee” survives a Pinia/store reconstruction from session storage;
- Checkout expiry rotates only the attempt key and clears only reservation/slot state;
- success copy retains the email after the draft and storage are reset;
- each of the five service-audited HTTP routes writes exactly one audit row; and
- manual booking/refund audits use the response's booking/refund ID.

## Verification

After focused regression suites pass, run the complete repository checks:

```bash
rtk pnpm lint
rtk pnpm format
rtk pnpm typecheck
rtk pnpm test
rtk pnpm test:integration
rtk pnpm build
```

End-to-end tests are required for the public retry/expiry journey and the office reschedule/refund
journey when the local test infrastructure is available.

## Acceptance criteria

The remediation is complete only when every review finding has a named regression test, all
financial consumers use the stable root or the shared financial service, no direct request path
emits `notification.send`, and the full verification commands pass without modifying or dropping
the user's existing office-availability work.
