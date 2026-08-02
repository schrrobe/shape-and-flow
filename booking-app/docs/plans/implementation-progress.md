# Phase 1 — Implementation Progress

Companion to `phase-1-implementation-plan.md`. That document is the spec and does
not change; this one records what is built, what is next, and the decisions taken
while implementing that the plan could not have known.

|                   |                                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| Branch            | `feat/phase-1-booking-app` (nothing pushed)                                       |
| Tasks complete    | 48 of 49 — only Task 3.4 remains; the 11-task review remediation is done          |
| Unit tests        | 854 passing (489 api + 220 web + 37 contracts + 41 ui + 67 templates)             |
| Integration tests | 739 passing                                                                       |
| End-to-end tests  | 40 passing (20 scenarios × desktop and 360-pixel mobile)                           |
| Gates             | `pnpm lint`, `format`, `typecheck`, `test`, `test:integration`, `test:e2e`, `build` all green |

## Execution order — vertical slice

The user chose a vertical slice over the plan's stage order, to reach a working
booking flow sooner. The reorder cost is near zero, because the plan already
front-loads the booking path: the slice is **tasks 1.2 → 5.5**, deferring only
Task 3.4 (email and SMS adapters). Stage 6 onward (lifecycle, office API, web
apps, hardening) follows afterwards.

Slice target: real catalog → real slot maths → reserve under the exclusion
constraint → Stripe Checkout → webhook confirms.

## Done

| Task | What landed                                                                    |
| ---- | ------------------------------------------------------------------------------ |
| 0.1  | pnpm workspace at repo root, Node and pnpm pinned by the repository            |
| 0.2  | `booking-config`: shared tsconfig, ESLint factory, Prettier, Vitest base       |
| 0.3  | Dev and test Compose stacks, isolated (5433/6380 and 5434/6381)                |
| 0.4  | CI: lint, test, integration, e2e, build — degrades gracefully as packages land |
| 1.1  | NestJS app, validated env, Prisma 7 + pg driver adapter, `/api/health/live`    |
| 1.2  | 29 models, 18 enums, 107 indexes, initial migration                            |
| 1.3  | Exclusion constraints, CHECKs, partial unique indexes, integration harness     |
| 1.4  | Organization context, tenant Prisma guard, idempotent seed                     |
| 2.1  | `Money` value object, locale formatting, cent-arithmetic ban                   |
| 2.2  | DST-safe wall-clock conversion, interval algebra, injectable `Clock`           |
| 2.3  | Availability engine — pure slot generation, 48 tests                           |
| 2.4  | Pricing, cancellation-fee policy, deterministic employee selection             |
| 3.1  | Contracts package, error envelope, correlation, redacted logging               |
| 3.2  | Provider ports (payment, email, SMS) with in-memory fakes                      |
| 3.3  | Stripe Checkout adapter                                                        |
| 4.1  | Five BullMQ queues, 20 validated job payloads, `EnqueueService`                |
| 4.2  | Transactional outbox: recorder, dispatcher, reconciler                         |
| 4.3  | Webhook inbox: recorder, reconciler                                            |
| 4.4  | Idempotency: canonical request hash, service, global interceptor, sweeper      |
| 5.1  | Public catalog and availability, throttled, tenant read from context only     |
| 5.2  | Reservation transaction under the per-employee advisory lock                  |
| 5.3  | Booking endpoint, Checkout session, idempotent replay                        |
| 5.4  | Stripe webhook ingress with raw-body signature check, booking confirmation    |
| 5.5  | Two-phase expiry saga with persisted `EXPIRING` and a stuck-state sweep       |
| 6.1  | Management tokens: hash stored, plaintext once, token-as-selector `/manage`   |
| 6.2  | Cancellation: customer self-service inside the window, request outside it     |
| 6.3  | Refunds: idempotent Stripe refunds, webhook-driven settlement                 |
| 6.4  | Reschedule: availability evaluated against the as-sold snapshot              |
| 6.5  | Completion and no-show, with the audit trail                                  |
| 7.1  | `booking-notification-templates`: 13 kinds x 2 locales, 67 tests, snapshots   |
| 7.2  | Notification dispatch, dedupe, frozen payload, delivery-status webhooks       |
| 7.3  | Reminders: time-keyed job ids, fresh manage token, nightly reconciliation     |
| 7.4  | Worker process, exhaustive job router, 8 repeatables, api/worker Docker targets |
| 9.1  | `booking-ui`: tokens with computed WCAG contrast tests, 11 components, generated icons |
| 9.2  | de/en i18n with seven parity guards, typed API client, error-code mapping      |
| 9.3  | Booking wizard, draft store, slot picker, reservation countdown                |
| 9.4  | Confirmation polling, self-service manage and reschedule, WhatsApp contact     |
| 8.1  | Office sessions in Redis, argon2id passwords, CSRF header, reset flow          |
| 8.2  | §10.5 role matrix enforced, refund capability, employee scope, audit trail     |
| 8.3  | Office dashboard and calendar, derived display statuses                        |
| 10.1 | Office shell, login, forgot and reset password, session store and route guard  |
| 8.4  | Staff, working hours, availability exceptions, catalog, settings, office users |
| 8.5  | Office bookings, manual payments, refunds, requests, customers, CSV exports    |
| 11.2 | Health indicators, operations counters, request logging, graceful shutdown     |
| 10.2 | Office dashboard, calendar, booking list and detail                            |
| 10.3 | Office management screens, request queues and exports                          |
| 11.3 | Production compose, web image, edge nginx, verified backup and restore, runbooks |
| 11.1 | Playwright suite: customer, expiry, self-service, office and axe journeys      |

## The review remediation

All sixteen findings from the booking review are closed, as eleven commits from
`4ca3b45` to `be75ee0`. The plan is
`docs/superpowers/plans/2026-08-02-booking-review-remediation.md`; the design spec it
was written from is `docs/superpowers/specs/2026-08-02-booking-review-remediation-design.md`.

Each finding has a test that fails without its fix:

| Finding | Fix | Proof |
| --- | --- | --- |
| Employee price override ignored | `4ca3b45` | `reservation.int` override, `public-bookings.int` quote/snapshot/charge |
| Explicit employee not validated | `4ca3b45` | `reservation.int` unassigned, hidden, archived |
| Checkout failure strands the reservation | `d410a3c` | `public-bookings.int` resume, attachment gap, lost response |
| Request alerts point at no notification row | `2bfe51e` | `cancellation.int` and `reschedule.int` send-event resolution |
| Rejected requests tell the customer nothing | `2bfe51e` | both `*_REQUEST_DECIDED` rejection tests |
| Reschedule loses payment access | `f9d4978`, `7fdd7e0` | `booking-financials.int`, office detail, `/manage`, export |
| Cancellation over-refunds a partly refunded charge | `8367c3e` | `cancellation.int` cumulative-target tests |
| Pending refunds excluded from the balance | `8367c3e` | `refund.int` pending-balance and concurrency |
| Refund permission read full retention as a refund | `8367c3e` | `office-bookings.int` omitted-body authorization |
| Failed-login increments race | `6947ffd` | `auth.int` parallel failures |
| Worker settings stay stale | `41ca979` | `worker-bootstrap.int` refresh before scope |
| "Any employee" not persisted | `c4ef12a` | `booking-draft.spec` reload |
| Expired Checkout reuses a spent key | `c4ef12a` | `booking-draft.spec`, `RedirectToCheckout.spec` |
| Success page loses the confirmation email | `c4ef12a` | `BookingSuccess.spec` |
| Transactional routes duplicate audit rows | `f83cf30` | `office-bookings.int` exact-one counts |
| Audit rows use the wrong entity id | `f83cf30` | manual-booking and refund id assertions |

Four things are worth carrying forward.

- **`Booking.financialRootBookingId` is the answer to "which booking was paid".** Every
  financial read goes through `BookingFinancialsService`; nothing reads
  `booking.payments` any more. Customer lifetime value is summed **per root**, not per
  booking — every link in a chain reports the same payment, and summing per booking
  triples one appointment's money for a customer who moved twice.
- **A refund is reserved against `amount - refunded - pending`.** `reserveInTransaction`
  is the only place a refund row is created, and it takes either an `ADDITIONAL`
  instruction or a `CUMULATIVE_TARGET` outcome. Cancellation means the second; an office
  user typing an amount means the first.
- **The refund capability is checked inside the decision transaction**, against the
  amount the reservation actually moves. Outside it, an omitted retained amount — which
  means "accept the frozen suggestion" — was read as zero and the most ordinary approval
  was refused.
- **A bound idempotency key survives `abandon`.** It is the only handle on a reservation
  a failed attempt already committed, and `ReservationService.resume()` reads it back.

## Next

**Stage 8 is complete and 10.2/10.3 are unblocked.** Tasks 8.1 to 8.3 were built in a
**parallel session** (`ab6b9f3`, `9c0a03c`, `c811428`), and 8.4 and 8.5 followed from the
same stream (`2636921`, `f57abbc`). The office API is now whole: staff, availability,
catalog, settings, users, bookings, manual payments, refunds, requests, customers and the
two CSV exports. Every stage-9 and stage-10 commit was staged by explicit path so the two
streams never mixed.

**Task 11.2 is complete.** `/api/health/live` answers with the database and Redis both
unreachable; `/api/health/ready` names whichever of database, Redis or migrations is
down; `/api/health/detail` reports queue depths and the stuck-row counts to an `OWNER`
or `ADMIN`. Every request writes one structured line at a level that matches its status,
the correlation id reaches the outbox row, and `SIGTERM` stops the listener and waits for
in-flight requests. Verified against a booted process, not only by tests — see the bugs
below, one of which was the development database being two migrations behind.

**Task 11.3 is complete.** The production stack was brought up for real, not described:
four images built, five containers healthy, the one-shot migrate container gating both
application processes, a backup taken and verified, the volume destroyed, the backup
restored, and the exclusion constraint then shown to still refuse an overlapping row.
Three things only that exercise could have found:

- The API image's healthcheck probed port 3001 while the schema's default made the process
  listen on 3000, so **every API container would have reported unhealthy**. Fixed by pinning
  `PORT` in the image so listener, `EXPOSE` and healthcheck agree.
- A first deployment cannot be a single `up --wait`: the API resolves
  `DEFAULT_ORGANIZATION_SLUG` at bootstrap and refuses to start against a migrated but
  unseeded database. The runbook migrates, seeds, then starts.
- `NODE_ENV=production` is not yet reachable. It refuses `fake` for email and SMS, and the
  real adapters are Task 3.4, so a deployment made today can only run as staging. Recorded
  at the top of `.env.production.example`, in `docs/operations.md`, and in the CI job.

**The office's own booking.** The two screen-level gaps recorded under "Plan errors" are
closed: `NewBooking.vue` calls `POST /office/bookings`, and the settings card sets
`cancellationFeePolicy`. Three things about the first one are worth keeping:

- **It needed a new endpoint, `GET /office/availability`.** The office may book inside the
  minimum-notice window, and with the default 24 hours `/public/availability` answers
  *nothing* for today — the day somebody is most likely to ring about. A screen built on
  the public route could not have offered this afternoon at all. The new route is the same
  engine, the same query and the same response, over a snapshot with the notice and the
  horizon lifted. That lift is now `asOfficeSnapshot` in
  `domain/availability/office-view.ts`, which the reservation transaction's own re-check
  also uses: what the office is offered and what it is allowed to book are one definition,
  so a slot cannot be shown and then refused.
- **The slot decides the person, not the other way round.** `employeeId` is required by the
  contract, and the office is asked *after* the time is picked, from that slot's
  `employeeIds` — "who is free at four" is the question actually being asked, and a single
  candidate is filled in rather than asked about.
- **Only a conflict re-reads the day.** A `SLOT_UNAVAILABLE` clears the picked slot,
  because continuing to offer it would be a lie. A 500 or a dropped connection leaves the
  form and its idempotency key alone — throwing those away would turn a retriable failure
  into a re-typed booking, and the key exists precisely so that a second attempt is safe.

**Task 11.1 is complete.** Sixteen scenarios run against a real browser, a real API
process, a real worker process, real Postgres and real Redis, with only the payment, mail
and SMS providers faked — and the built bundle behind `vite preview`, not a dev server. A
customer books in German and gets a reference and a management link; the slot they hold
vanishes for the next visitor; an English visitor gets English copy and an English email;
a double-clicked submit produces one booking; an abandoned checkout blocks the slot and
the expiry job gives it back; paying after the deadline keeps the appointment; cancelling
outside the window refunds at once and inside it opens a request for the amount quoted; a
wrong token gets a friendly page; the office signs in, finds a booking, takes cash, decides
a request with its own retained amount, blocks time and exports CSV; an `EMPLOYEE` can
neither see nor reach settings; ten routes have no serious or critical axe violation; and
the whole booking flow can be completed without a mouse.

Everything the suite does, it does through the interface — except four things a browser
cannot do, which is what `/api/test-support/*` exists for: reset and reseed, mark a fake
Checkout session paid, sign a synthetic Stripe event, and read the mailbox. The router is
absent from the container unless `ENABLE_TEST_SUPPORT` is true, the environment schema
refuses that in production, and the reset refuses any database not named `booking_test` or
`booking_e2e`.

One scenario from the plan is not in the suite: the intermediate `EXPIRING` state, which
is unobservable from outside (see deviation 58). The manual booking was the other one, and
it is covered now — see "The office's own booking" below.

| Task | What is left                                                   |
| ---- | -------------------------------------------------------------- |
| 3.4  | Real Resend and Twilio adapters, deferred out of the slice     |

**Stages 5, 6 and 7 are complete.** A customer books and pays; the booking confirms
by webhook or releases the slot; they can cancel, reschedule or be marked no-show
through a management link; every step notifies the right people in the right
language; and a separate worker process runs every job and sweep. Verified end to
end against booted processes, not only by tests — including the worker image
draining on SIGTERM.

Deferred out of the slice: 3.4 (Resend and Twilio adapters — the ports and fakes
exist, the real clients do not).

## Version drift from the plan, and why

The plan was written against a slightly older ecosystem. Each of these was a
decision, not a mechanical bump.

- **TypeScript 6.0.3, not 7.** TS 7 is latest, but `typescript-eslint` 8.65 caps
  at `<6.1.0`. Type-aware linting is load-bearing for several planned rules, so
  the newest version that keeps it working wins.
- **Prisma 7, with a driver adapter.** Prisma 7 removed `url` from the datasource
  block and requires an adapter, so `PrismaService` builds a `PrismaPg` pool from
  validated config. Its ESM-native `prisma-client` generator also removes the
  CJS-interop hazard "ESM everywhere" would otherwise hit.
  `importFileExtension = "js"` is **mandatory** — the default emits `./enums.ts`
  specifiers that survive into `dist` and fail to resolve at runtime.
- **pnpm 10.34.5, not 11.** The plan says 10 with `engines: ">=10"`; no upside in
  a package-manager major mid-plan.
- **Vitest 4** replaced esbuild with Oxc, so `oxc: false` is required for
  `unplugin-swc` to emit decorator metadata at all. `poolOptions` was removed in
  Vitest 4 — it was silently ignored, and only `typecheck` caught it.
- **`@node-rs/argon2`, not `argon2`.** Prebuilt binaries, so no native toolchain
  is needed and pnpm's build-script allowlist stays short.
- **`vitest.base.js` + `.d.ts`, not `.ts`.** Vite's config loader externalises
  linked workspace packages rather than transforming them.
- **ioredis 6, imported as `{ Redis }`.** ioredis 6 ships CJS types with no
  `exports` map, so under NodeNext a default import resolves to the module
  namespace: `Cannot use namespace 'Redis' as a type` and `This expression is not
constructable`. The named import gives both the class and the type.
- **BullMQ 6.** Queues are typed `Queue<AnyJobPayload>` rather than left at
  BullMQ's default of `any`; an untyped `job.data` would defeat type-aware
  checking exactly where a wrong field name costs the most.

## Deliberate deviations from the plan

From the remediation plan, four:

- `ReservationService.resume()` loads the whole booking row with the employee included,
  rather than a hand-listed `RESUMABLE_BOOKING` projection. `ReserveResult.booking` is a
  generated `Booking`, and a list of scalars is a thing to revisit every time the model
  gains a column.
- The office copy of a request notification goes to `settings.officeNotificationEmail`,
  which is where every other office message goes. The plan's per-user `officeRecipients`
  does not exist.
- `RefundService.reserveInTransaction` takes a `lenient` flag. Cancelling an unpaid
  booking is ordinary and must not raise; a refund route asked to refund one is a mistake
  worth reporting, and the two callers needed different answers to the same situation.
- The two remediation e2e journeys drive the reschedule through the manage and office
  APIs rather than their screens. Each screen has its own spec; what the journey is about
  is what happens to the money afterwards, and six clicks to get there are six ways to
  fail about something else.

1. Integration tests share one database with `fileParallelism: false`, rather than
   per-worker template clones. These tests provoke lock contention; one
   serialised database makes outcomes unambiguous. The harness interface allows
   clones later without touching a test.
2. `TenantPrismaClient` is typed as `PrismaClient`, not as the `$extends` return
   type. Accurate — a query extension adds no model, field or method — and
   propagating the real type made type-aware linting take **over ten minutes**;
   it is now 4 seconds.
3. `pnpm db:seed` invokes `tsx` directly instead of `prisma db seed`, which was
   observed hanging after the seed itself had exited successfully.
   `prisma.config.ts` keeps the seed command so `migrate reset` still works.
4. Money and Clock are enforced by ESLint, not convention. Note the cost of
   ESLint's model: `no-restricted-syntax` is one rule, so exempting a file
   exempts every selector in it — the cent ban therefore does not apply inside
   test files.
5. Correlation ids are UUID v4, not the plan's ULID: no dependency needed,
   `crypto.randomUUID` is native, and log ordering comes from timestamps anyway.
6. `ErrorCode` in contracts is only the **public** set. Internal invariant
   violations (`INVALID_MONEY`, `UNSCOPED_TENANT_QUERY`) use codes deliberately
   absent from it, so the exception filter turns them into a generic 500 while
   logging the real one. Making a code public is then an explicit act.
7. The contracts package builds on `pnpm install` via `prepare`. Its exports point
   at `dist`, and without this a clean checkout would fail lint/typecheck because
   CI runs those before the build job.
8. `tsconfig.build.json` in contracts sets `types: []`, so shipped code cannot
   reach for a Node or DOM global — it has to work in both places it is imported
   from. Tests keep Node types.
9. The correlation middleware is a plain Express handler registered with
   `app.use()`, not a Nest middleware: Express middleware runs before anything a
   module registers, including pino's request logger, which would otherwise log a
   placeholder id.
10. Provider ports take `Money`, not raw cents, so the cent-arithmetic ban applies
    inside the adapters too. The fake was written with raw cents first and the ban
    caught it.
11. ProvidersModule throws at start-up when a port names an adapter that does not
    exist yet, rather than falling back to a fake. A deployment that believes it
    is talking to Stripe while silently talking to an in-memory stub is the worst
    available outcome. Refusing `fake` in production stays in the env schema — one
    place, not two.

12. Job contracts live in the API (`src/messaging/queues/job-contracts.ts`), not in
    the shared contracts package. Nothing in the browser enqueues a job, and
    tenant payloads must carry `organizationId` — which is precisely what the
    contracts package's guard test forbids. Keeping them apart preserves that
    guard at full strength instead of weakening it to a name-pattern heuristic.
13. `organizationId` is required by **queue**, not by every job: booking, payment
    and notification payloads require it; webhook and maintenance do not. A Stripe
    event arrives before the tenant is known, and a sweep is global by design —
    requiring it there would force callers to invent one.
14. `REDIS_QUEUE_PREFIX` was added to the env schema, which the plan did not have.
    It lets one Redis serve two environments, and it makes the integration
    suite's queue reset (`obliterate`) structurally unable to reach an
    application's queues; `test/redis.harness.ts` refuses to run unless the
    prefix starts with `test-`.
15. The plaintext management token transiently lives in the `booking.confirmed`
    job payload — and therefore, from Task 4.2 on, in `outbox_events.payload` —
    even though `management_tokens` stores only a hash. The alternative is
    re-issuing a token when the email is rendered, which would mean the link in
    the email and the row in the database could disagree. The trade-off is
    accepted and bounded: the payload is deleted when the outbox row is swept,
    and `managementToken` is in the log redaction list.

16. The outbox dispatcher and reconciler take the injected `Clock`, not SQL
    `now()` as the plan specified. Prisma sends a **client-generated** value for
    `@default(now())` rather than letting Postgres fill the column, so
    `availableAt` and `createdAt` are application-written; comparing them against
    the database's clock compares two clocks. See the bug below.
17. The dispatcher's interval and the reconciler's `sweep.outbox` wiring are
    implemented but not running: neither has a process to run in until the worker
    lands in stage 7. `OutboxDispatcherScheduler` is registered in both roles and
    starts in neither unless `APP_ROLE=worker`, and its role guard, re-entrancy
    and shutdown behaviour are unit-tested in the meantime.
18. `/api/health/detail` does not exist yet, so `OutboxReconciler.health()` is
    the method that endpoint will call rather than a wired-up endpoint.

19. `InboxRecorder.markProcessed`/`markFailed` take a discriminated `InboxRef`
    rather than the plan's `(kind, providerEventId)` pair. A messaging event is
    keyed on `(provider, providerEventId)` — the same id can legitimately arrive
    from Resend and from Twilio — so the pair version cannot address one
    correctly. The plan's `note?` parameter is dropped: there is no column for it,
    and putting a "deliberately ignored" note in `lastError` would mislabel the
    column. An unhandled event type is simply marked processed; `type` already
    records what it was.
20. Inbox job ids are derived from the **row id** (`inbox-<cuid>`), not from the
    provider's event id. A provider id is not guaranteed to be key-safe, and
    BullMQ rejects a colon — see the Task 4.1 finding. Deterministic either way,
    which is what makes re-enqueueing an already-queued event a no-op.
21. `InboxReconciler.runOnce()` returns `{ reenqueued, poisoned, deleted }` rather
    than the plan's bare count, and there is a separate `health()`, mirroring
    `OutboxReconciler`.

22. An in-progress idempotency key is a **lease**, not a permanent claim. The plan
    has no in-progress expiry, which would leave a key blocked forever when a
    process is killed mid-request — `abandon` covers the ordinary failure but not a
    hard crash. An expired in-progress row can be taken over, conditionally, so
    exactly one of several waiting retries takes it.
23. The interceptor reads the success status from the route's `@HttpCode` metadata,
    falling back to Nest's rule (POST 201, otherwise 200), because
    `response.statusCode` has not been set when an interceptor runs.
24. `IdempotencyInterceptor` is bound globally via `APP_INTERCEPTOR` and is inert
    without `@Idempotent`. Per-controller binding would mean every new
    money-moving route needs two things remembered instead of one, and a forgotten
    binding fails silently — by accepting retries.
25. A replayed response carries an `Idempotent-Replay: true` header. Not in the
    plan; it costs one line and turns "did this re-run?" into something an operator
    can read off the response.

26. The availability snapshot costs **eight** queries, not the plan's five, and the
    test asserts _constancy_ rather than a ceiling. Prisma issues a round trip per
    `findMany`; the plan reached five by counting "exceptions plus time off" and
    "bookings plus blocked times" as one each, which would need SQL UNIONs over two
    differently-shaped tables. Constancy across range and employee count is the
    property an N+1 breaks — a fixed ceiling passes a per-day query as long as the
    ceiling is generous enough.
27. The booking-horizon check lives in the availability controller as well as in the
    engine. The engine clamps its output, so without the check a request for next
    year returns an empty list — indistinguishable from a fully booked week.
28. `AuthGuard` denies by default and only `@Public()` opens a route. Office sessions
    (6.2) and management tokens (6.4) add branches to it rather than second guards.
    Its "closed by default" behaviour is tested over HTTP against a real unmarked
    route, because Nest resolves the handler _before_ running guards — a path that
    matches nothing is a 404 and no guard is consulted.
29. Rate limiting counts in Redis on the connection BullMQ already holds, via
    `@nest-lab/throttler-storage-redis`. The root config sets one generous default
    and routes declare real limits with `@Throttle`; named throttlers were not used
    because every throttler in the root array applies to every route.
30. `test/public-app.harness.ts` builds a real Nest application over the test
    database, substituting only the organization context (the real one resolves its
    slug from the validated environment at bootstrap) and the clock. `ThrottlerGuard`
    is deliberately absent from it, so `@Throttle` is inert in tests.

31. `PublicBookingsController` lives under `src/public/` but is registered by
    `BookingModule`. Registering it in `PublicModule` made the two modules mutually
    dependent and dragged the payment provider into every test that only wanted to
    read a catalog — which is how the catalog and availability suites started failing
    to construct.
32. A bad webhook signature returns `VALIDATION_FAILED`, not a code of its own. The
    consumer is Stripe, which reads only the status; adding a public error code widens
    the contract every browser client sees for a machine that would not look at it.
    Note that an _internal_ code could not be used here — the exception filter turns
    those into a generic 500, and this needs a 400.
33. The raw webhook body comes from Nest's `rawBody: true`, not from a path-scoped raw
    parser. See the bug below.
34. Inbox job ids for the webhook use the inbox row id, matching Task 4.3, rather than
    the plan's `stripe:<eventId>`.
35. A replayed booking response is _semantically_ identical, not byte-identical as the
    plan says: `responseSnapshot` is JSONB and PostgreSQL does not preserve object key
    order. Nothing consumes key order, and `JSON.parse` yields the same object.

36. `ManagementTokenService` lives in its own `ManagementTokenModule`, not in
    `ManageModule`. Bookings need to _mint_ tokens — confirmation issues one, reschedule
    rotates one — while the `/manage` controllers need the booking services they drive.
    One module holding both makes BookingModule and ManageModule mutually dependent.
37. A bad webhook signature and a management-token failure both use existing public
    error codes rather than new ones. Widening the public error set is a deliberate act;
    neither consumer (Stripe, and an attacker guessing tokens) would read a distinct
    code.
38. `booking.rescheduled` carries an optional `managementToken`, like
    `booking.confirmed`. A reschedule revokes the old link, so the notification has to
    contain a new one that works.
39. Task 6.5's business-cancellation cases test `cancelByBusiness`, which Task 6.2
    already built — the plan splits the two, and building 6.2 completely made 6.5's
    scope smaller than written.
40. `AttendanceService.reportStaleCompletions` is a report, not a sweep that fixes
    anything. Auto-completing would manufacture the observation the service exists to
    record.
41. The office password-reset token is read from the URL **fragment**, not the query
    string task 10.1 specifies. The API sends `/office/reset-password#<token>` and is
    right to — a query string puts a live credential in the access log and in any
    `Referer` the page emits. The mechanics are shared with the customer management
    link through `useFragmentCredential`.
42. `/office` renders `OfficeStart.vue`, a landing page the plan does not list. Task
    10.1 has to have a route behind the session guard, and the dashboard belongs to
    10.2; guarding a route whose component does not exist yet is not an option. It is
    registered under the name `office-dashboard`, so 10.2 replaces the component and
    no path, link or sidebar entry moves.
43. Office copy is English literals in templates, not `t()` keys, because the plan
    makes the office area English-only. The customer literal-copy guard is narrowed to
    customer-facing templates and a second guard stops office templates calling `t()`
    — staff copy in the customer i18n bundle would be downloaded by every visitor to
    the booking flow. Office money and dates still format as `de-DE` in
    `Europe/Berlin`, which is what the plan's own 10.3 tests expect.
44. Task 10.1's capability helpers are backed by a table in
    `packages/contracts/src/auth/capabilities.ts` whose test reads §10.5 out of the
    plan document. The plan asks for "one shared capability table … so the API guard
    test and this test read the same data"; the API enforces the matrix through
    `@Roles` decorators per route instead, and adding a drift test that reads their
    metadata would mean touching files the parallel stream has open. Reading the
    specification is the stronger comparison anyway, and it is what caught §10.5's
    one ambiguous cell.

45. **The request log is pino-http's automatic log, configured, not the plan's
    `RequestLogInterceptor`.** A Nest interceptor cannot see the requests an incident
    starts from: guards run *before* interceptors, so every 401, 403 and 429 — and every
    404, which never reaches a handler at all — would be missing, and keeping both would
    mean two lines per request with the wrong one incomplete. pino-http logs on the
    response's `finish` event, which happens for all of them. The decisions that were to
    be the interceptor's — level by status, sampling, the fields on the line — live in
    `common/logging/request-log.ts` as pure functions with their own tests.
46. `/health/detail` is its own controller. `HealthController` is `@Public()` at class
    level, and handler metadata does not override a class-level `@Public()` — a third
    route there would be reachable by anyone, with only the session guard between the
    public and the business's queue depths.
47. Terminus signals a failed readiness check by throwing, and the global exception
    filter is caught in `HealthController.ready` rather than taught about it. The error
    envelope is the contract for API clients; a supervisor's probe is not one, and
    turning the indicator names into a generic 500 body would remove the only thing a
    readiness response is for.
48. `ShutdownService` closes the listener and drains in-flight requests, and stops there.
    The plan also has it closing BullMQ workers, Redis and Prisma; those already close
    through their own `onApplicationShutdown` hooks, which Nest runs after this one, and
    two owners for one socket is how a shutdown starts hanging. The API process has no
    BullMQ workers at all — `worker.main.ts` drains those.
49. The database indicator is Terminus's own `PrismaHealthIndicator`; the Redis one is
    ours (`queue.indicator.ts`) and pings the shared BullMQ connection rather than one of
    its own. What readiness has to answer is "can *this* process reach the Redis it
    enqueues to", and a second connection can be healthy while the shared one is wedged.
50. `/health/detail` counts what is **stuck** — each component's own staleness window,
    five minutes for outbox and inbox, fifteen for notifications — while the office
    dashboard's tiles count what is **outstanding**. Both read the same `health()`
    methods, so there is still one definition of each; the two endpoints ask different
    questions. `DashboardService.operations()` predates `OperationsService` and still has
    its own copy of the aggregation: now that 8.5 has landed it could delegate, which is
    the obvious follow-up when someone is next in that file.
51. The pino serializers are narrower than the defaults: `req` keeps id, method, url,
    remote address and user agent, `res` keeps the status. See the bug below — the
    default `res` serializer emits `Set-Cookie`.
52. `statusCode` is added by `customSuccessObject`/`customErrorObject`, not by
    `customProps`. Also a bug below: `customProps` decorates every line logged during a
    request, and while a handler is running the response still reports Node's default.
53. **The fake payment provider's state moved out of the provider and into a store.** It
    was one Stripe *per process*: the API created a Checkout session, and the expiry job
    — which runs in the worker — asked about a session its own instance had never heard
    of and raised `FAKE_PROVIDER_UNKNOWN_SESSION`, so the slot stayed blocked forever
    because the saga treats "no answer from the provider" as a reason not to release. The
    refund processor had the same hole. Nothing in a single-container test can see it.
    `FakePaymentStore` now has two implementations: in-memory for the suites, and
    Redis-backed for a real process, bound in `ProvidersModule`. The affordances
    (`markPaid`, `chargeIdFor`, `sessions`, `refundCalls`, `reset`) became asynchronous;
    `failNextWith` and `callOrder` stayed synchronous because they are genuinely
    per-process.
54. **The seed moved to `src/organization/demo-seed.ts` with `src/seed.main.ts` as its
    entrypoint.** Two callers need one definition of the demo business — `pnpm db:seed`
    and the test-support reset — and two definitions would drift until a green e2e run
    was proving something about a business no developer ever sees. Being under `src` also
    means `nest build` compiles it, which is what lets the e2e stack and a first
    deployment run `node dist/seed.main.js`.
55. **The demo organization has a fixed id.** The organization is resolved once at
    bootstrap and cached, independently in the API and in the worker. With a generated id
    every reset minted a new organization that both caches then pointed past: an empty
    catalog in the API and rows written against a deleted id in the worker.
56. **The seed creates an `EMPLOYEE` login as well as the owner.** "An employee sees only
    their own calendar and cannot reach settings" is a rule this product enforces, and a
    seed with no such user leaves it undemonstrable — and untestable through the interface
    a real one uses.
57. **`data-test` on `SfInput`, `SfTextarea` and `SfSelect` now lands on the control.**
    Vue puts a fallthrough attribute on the component's root, which for these is the
    `<div>` holding the label and the hint — so `getByTestId('email').fill()` resolved a
    div. Every office screen already wrote it the intended way; nothing had driven them
    through a browser yet. Only the test id is relocated: `class` stays on the block.
    `SfModal` gained `data-test="confirm"` and `modal-dismiss` on its own two buttons,
    because a dialog's buttons mean the same thing wherever it opens.
58. **The e2e expiry test does not assert the intermediate `EXPIRING` state.** It is real
    and `expiry-saga.int.spec.ts` pins it under a controlled clock, but it cannot be
    observed from outside: `SWEEP_EXPIRED_RESERVATIONS` runs every sixty seconds and
    drives the whole saga to its end unaided, so whether a browser catches the middle is
    luck. The e2e test asserts the two things that are deterministic — held before the
    deadline, released after the job.
59. **The test-support router has seven operations, not the plan's four.** The four are
    there as written. The other three are the ones the plan's own scenarios need and did
    not count: phase one of the expiry saga, phase two of it, and an *uncached* view of
    outstanding work so a helper can wait for the worker rather than sleep. That last one
    cannot be `/health/detail`: its snapshot is deliberately cached for ten seconds, which
    makes it useless for deciding whether the worker has caught up.
60. **The mailbox is read from the `notifications` table, re-rendered, not from the fake
    provider's array.** The notification worker is a different process, so its in-memory
    outbox is not reachable from the API at all. The row is also the better source: it is
    what the product considers sent, and the body is a pure render of the payload frozen
    at queue time, through the same `reviveDates` the send path uses (extracted to
    `notification/revive-dates.ts` so there is one revival, not two).
61. **`main.ts` imports `AppModule` dynamically.** Whether the test-support router is part
    of the container is a question about the container, so `AppModule` answers it at
    decorator-evaluation time — and a static import is hoisted above `loadEnvFile()`,
    which would read an environment the `.env` file had not been applied to yet.
62. **The e2e stack gets its own Postgres database and its own Redis logical database.**
    `booking_e2e` and `redis://…/1`, against the same servers the integration suite uses.
    Queues were already separated by prefix; sessions and rate-limit counters are not
    prefixed at all, and the reset deletes those by pattern.
63. **The checkout hand-off is intercepted with `204 No Content`.** The page redirects to
    the provider two seconds after it renders, and the fake's host does not resolve. A stub
    body replaces the document and an abort commits Chromium's network-error page; both
    destroy the countdown, the reference and the Checkout link two seconds after they
    appear, which is a race that passes on a quiet machine. A 204 leaves the document alone.

## Plan errors found while implementing

Five in the remediation plan, all corrected in the implementation rather than followed:

- **`IdempotencyKey` has no Prisma relation to `Booking`.** Both `Booking.idempotencyKeyId`
  and `IdempotencyKey.bookingId` are plain columns, so the plan's `resume()` — which
  filters and selects through a nested `booking` relation — does not compile. It is two
  queries: find the claim, then load the booking under the same tenant, status and expiry
  conditions `reserve()` would have established.
- **`Booking.idempotencyKeyId` is unique.** Rebinding a key to a second reservation after
  the first lapsed collides with the row that still holds it, so the claim clears any
  other booking holding the key before it binds.
- **The plan's rejection test counted every customer row.** `seedOrganization` already
  creates one, so `prisma.customer.count()` is never zero; the tests use a first-timer
  address instead, which is what makes the rollback observable.
- **Template fields are `suggestedRetainedCents`, not `suggestedRetainedAmountCents`**,
  and there is no `OFFICE_RESCHEDULE_REQUEST` kind — the office copy exists only for
  cancellations. Adding a kind means an enum value, a migration and two translations,
  which is a change of scope rather than a fix, and the office already sees reschedule
  requests in its queue.
- **`AppError('FORBIDDEN')` is not a declared code.** The capability refusal uses
  `FORBIDDEN_ROLE`, so a client cannot tell it from a guard-level refusal.

- **Task 11.1's office journey could not be written as specified: there was no
  manual-booking screen.** ~~The plan's office journey opens with `new-booking` on the
  calendar and fills a manual booking. `POST /office/bookings` exists, the API suite
  covers it and the typed client has `office.bookings.create` — but no page in the office
  area calls it.~~ **Closed.** `NewBooking.vue` is that screen, reached from a
  `new-booking` button on the calendar and on the booking list, and the plan's journey is
  in the suite. See "The office's own booking" below for what building it turned up.
- **The settings screen could not switch the cancellation fee on.** ~~It offers "fee
  inside that window (%)" but nothing that sets `cancellationFeePolicy`, which defaults to
  `NONE` — so a percentage typed into it has no effect at all, and the field reads as
  working.~~ **Closed.** The card now sets the policy itself, and offers the percentage or
  the fixed amount according to which one the chosen policy uses.
  `setCancellationFee()` in the e2e fixtures stays an API call, because in most specs the
  fee is a precondition rather than the subject; one journey now sets it through the form.
- **Task 11.1's `day-tab` and `checkout-session-id` selectors describe a different UI.**
  The slot picker shows a week of day *sections* with a week-forward control, not tabs, and
  the hand-off page shows a Checkout link rather than a bare session id. The suite reads
  `data-test="day"` with a `data-date`, and takes the session id out of the link's `href`.
- **Task 11.2's migration assertion cannot match.** It expects
  `details.migrations.pending` to contain `'calendar_constraints'`, but a migration is
  named by its directory — `20260731210500_calendar_constraints`. The test asserts the
  suffix instead.
- **Task 11.2's `withDatabaseDown` and `withRedisDown` have nothing to switch off.**
  Stopping a container mid-suite would take every other test with it. The readiness
  cases build the controller with a Prisma that rejects and a Redis pointed at a closed
  port, which is the same failure from the process's point of view and costs no
  infrastructure.
- **Task 7.4's Docker healthcheck asks for a 404.** It requests `/api/health`, and
  nothing is mounted on the bare prefix — every container would have reported unhealthy,
  which is also what `docker compose --wait` in 11.3 would have hit. It is
  `/api/health/ready` now, which is what the comment beside it always claimed.

- **Task 9.1's `tailwind-preset.ts` describes Tailwind 3.** Tailwind 4 has no JavaScript
  preset — the theme *is* CSS custom properties — so the token mapping lives in
  `theme.css` under `@theme inline`, checked in both directions by `tokens.spec.ts`.
- **Task 9.2's client test asserts `ErrorCode.options`.** The export is
  `errorCodeSchema.options`; `ErrorCode` is the inferred type.
- **The contracts package exports the `/manage` request schemas but not their types.**
  Importing a name a package does not export resolves to `any`, so the three shapes are
  declared in the web client until the exports exist.
- **The plan's Vite 6 is Vite 8, Pinia 3 is Pinia 4, vue-router 4 is 5.** Current versions
  used throughout; the only behavioural consequence was Rollup 5 dropping the object form
  of `manualChunks`.

- **The `Notification` entity has no payload column, and the design needs one.**
  The plan's own management-link design requires the plaintext token to reach the
  email, and that plaintext exists exactly once. Added `payload Json?` so a send is
  a pure render of what was true when the notification was queued.
- **Task 7.3's dedupe discriminator collapses two offsets into one.** The plan uses
  `String(expectedStartsAtEpochSeconds)` alone, so a 2-hour reminder dedupes into
  the 24-hour one already sent for the same appointment. Its own "honours multiple
  configured offsets" test only counts scheduled jobs, so it would not have caught
  it. The discriminator carries the offset too.
- **Task 7.3's job id uses colons.** BullMQ reserves `:` as its key separator and
  rejects a custom id containing one, so `reminderJobId` joins with `-`.
- **Task 7.4 reads the schedule with `getRepeatableJobs()`.** Removed in BullMQ 6;
  `getJobSchedulers()` replaces it. A scheduler must also set the job name in its
  template: it defaults to the scheduler id, and the router dispatches on the job
  name.
- **Task 7.4's Docker context is `booking-app`.** `pnpm-lock.yaml` and
  `pnpm-workspace.yaml` are at the repository root, so that context cannot produce
  the install that was tested. Both targets build from the root context.
- **Task 7.4 asserts a ULID correlation id.** `newCorrelationId` returns a UUID.
- **The plan's schema-drift command is Prisma 6 era.** `--to-schema-datamodel` was
  renamed to `--to-schema` and `--shadow-database-url` was removed; the shadow URL
  now has to be in `prisma.config.ts`. It is derived from `DATABASE_URL` there, and
  the database is created on first volume init, so the gate runs from a fresh clone.

- **§8.4 error handling was wrong, in our favour.** It assumed `23P01` arrives as
  an opaque `PrismaClientUnknownRequestError` needing a message regex. Prisma 7's
  pg adapter reports `PrismaClientKnownRequestError` code `P2039` with the
  SQLSTATE as structured data at `meta.driverAdapterError.cause.originalCode`.
- **Task 2.2's ambiguity check looked one hour early.** That never fires: Luxon
  already resolves an ambiguous local time to the earlier offset, so the check
  must look one hour _later_.
- **Task 2.4's `insideFreeWindow` flag was named backwards.** The plan's own
  examples set it true when the appointment is _close_ — which is when
  cancellation is not free. Implemented as `feeApplies`.
- **"20 enums" should read 18.** Corrected in the plan.
- **Task 3.3 assumed Stripe's `expires_at` could equal the 5-minute reservation
  deadline.** Stripe accepts 30 minutes to 24 hours, so the adapter clamps to the
  minimum and our own expiry saga enforces the real deadline by calling
  `sessions.expire`. Stripe's value is only a backstop.
- **Task 3.3 assumed a hard-coded API version string.** Since stripe-node 22,
  `apiVersion` is a _literal_ type accepting only the SDK's pinned version, so it
  cannot drift by configuration. A test pins the value instead, so an SDK upgrade
  fails and forces a review.
- **The plan's Connect option was `stripeAccount`.** stripe-node documents that as
  on its way out in favour of `stripeContext`; the adapter sends the latter.
- **Task 4.1's `RedisLifecycle` could not have booted.** The plan has the lifecycle
  hook call `connect()` on the shared client. BullMQ connects that client itself as
  soon as a `Queue` is constructed, and ioredis throws `Redis is already
connecting/connected` on a second `connect()`. The hook does a `PING` instead,
  which connects a lazy client, waits out an in-flight connection, and proves the
  server actually answers.
- **BullMQ rejects the job-id scheme the outbox was heading for.** A custom `jobId`
  may not contain `:` (it accepts a three-part id only for legacy repeatable jobs,
  and its own source says that is going away) and may not parse as an integer. The
  natural `outbox:<id>` is therefore invalid. `assertValidJobId` fails at the
  enqueue boundary and `jobIdFor()` builds ids that pass — without it the symptom
  would have been silently lost deduplication, i.e. duplicate confirmation emails.

- **Task 4.2's claim query mixed two clocks.** It compares `available_at` against
  "now", and the plan used SQL `now()` — but Prisma writes `@default(now())` from
  the client, so the column holds an application timestamp. The two clocks differ
  by a few milliseconds and the difference changes sign as the Docker VM's clock
  drifts, so a row recorded moments earlier was intermittently in the database's
  future and no drain claimed it. The symptom was a test suite that failed
  differently on each run.
- **Task 4.2's concurrency test could not fail for the right reason.** Two
  dispatchers over twenty rows total twenty dispatches whether the claim uses
  `SKIP LOCKED` or plain `FOR UPDATE` — a blocking claim finds the rows already
  marked when it unblocks. It does rule out claiming with no lock at all, which
  would dispatch forty. Proving `SKIP LOCKED` needs a second transaction that holds
  one row while the drain runs; with `SKIP LOCKED` removed that test is the only
  one that fails, after stalling for the transaction timeout.

- **`isUniqueViolation` could not match a Prisma field name.** Prisma 7's pg
  adapter reports `constraint.fields` as database **columns** (`stripe_event_id`)
  and its own message repeats them, so nothing in the error mentions the field name
  a caller naturally reaches for. Passing `stripeEventId` matched nothing and the
  violation was rethrown as a 500 — in exactly the case the caller wrote the check
  to handle. The helper now normalises both spellings. Every pre-existing call site
  passed snake_case constraint names and was unaffected; only Task 4.3's new ones
  hit it.

- **A path-scoped raw-body parser cannot work.** The plan mounts one on
  `/api/webhooks/*` to preserve the bytes a signature covers. Nest's global JSON parser
  runs before module middleware and has already consumed the stream, so the raw parser
  sees a parsed body and skips — silently. Nest's `rawBody: true` keeps the buffer
  aside while still parsing JSON everywhere, which is what actually works.
- **The fake payment provider's ids collided across process restarts.** Its counter
  restarted at 1, and `stripe_checkout_session_id` is unique, so a restarted dev server
  re-issued `cs_fake_1` and every booking failed with a 502 until the counter passed
  what was already stored. Invisible to the test suite, which truncates per run —
  found by driving the flow against a booted server. Fixed with a per-process suffix.
- **Making a reservation overdue by advancing the fixed clock broke the stuck-EXPIRING
  sweep.** `updatedAt` is written at real time, so a clock moved six minutes ahead made
  every EXPIRING row look stale and the sweep claimed one that was in flight. The
  reservation is now made overdue by backdating `expiresAt` — moving the row, not the
  clock. Third time this class of bug has appeared; the rule is now explicit: when a
  comparison is against a database-written column, control time by writing the column.

- **Reschedule evaluated availability against the current service, not the booking.** A
  rescheduled appointment keeps the duration and buffers it was sold with, but both the
  optimistic and the in-lock check loaded the live service. A service whose duration had
  changed since would make its existing bookings either unmovable or movable into slots
  they do not fit. Caught by a test that repriced _and_ re-timed the service;
  `asSoldSnapshot` now re-shapes the snapshot to the booking's own dimensions. The price
  snapshot was already carried across — this is the same principle applied to geometry.
- **The cent-arithmetic ESLint rule caught a real violation in the refund service.** The
  remaining refundable amount was computed by subtracting two columns. It goes through
  `Money` now. Worth recording as evidence the rule earns its keep rather than as a
  style nit.

## Bugs caught by verifying rather than assuming

Each of these would have passed a casual "it works" check.

- **The fake payment provider was one Stripe per process, so a slot could never be
  released.** The API created the Checkout session; the expiry job runs in the worker and
  asked about a session its own instance had never heard of. `FAKE_PROVIDER_UNKNOWN_SESSION`
  propagates, the saga treats an unanswered provider as a reason *not* to release, and the
  slot stays blocked forever. The refund processor had the same hole. Every unit and
  integration test passed throughout, because each builds one container; the first thing
  that ran two processes found it in a minute. Fixed by giving the fake a shared store —
  deviation 53.
- **Two concurrent refunds with the same idempotency key both refunded.** Introduced while
  making that store asynchronous: `find` then `push` had no interleaving point while both
  were synchronous, and gained one the moment the read was awaited. The refund integration
  suite caught it on the next full run. Real Stripe is atomic on an idempotency key, so the
  stand-in is now too — `claimRefund`, `HSETNX` across processes and a synchronous
  check-and-set within one.
- **`data-test` on a form field resolved to a `<div>`.** Two hundred of them across the
  office screens, every one on an `SfInput`, `SfTextarea` or `SfSelect` — and Vue puts a
  fallthrough attribute on the component's root, which is the wrapper holding the label and
  the hint. `fill()` on a div fails, so the whole convention was unusable for exactly the
  fields a test needs to type into. Nothing had driven those screens through a browser yet.
- **The e2e run rate-limited itself and reported it as a broken booking form.** The reset
  truncated the database and obliterated the queues but left Redis's rate-limit counters,
  which are per IP and per hour and do not care that the database was emptied. The suite
  spent its allowance on the first few bookings; every later one came back 429 and appeared
  as "the countdown never rendered". Sessions had the same problem more quietly. The reset
  now deletes both families by pattern — by pattern rather than `FLUSHDB`, because a
  `FLUSHDB` inside the API would obey a `REDIS_URL` pointing somewhere it should not.
- **A reseed left both processes pointing at an organization that no longer existed.** The
  organization is resolved once at bootstrap and cached, in the API and in the worker
  independently. A truncate-and-reseed minted a new id, so the API answered an empty
  catalog and the worker wrote rows against a deleted one. The demo organization now has a
  fixed id, and the reset refreshes the API's cached settings as well.
- **The drain never finished, because a confirmed booking is never "done".** Waiting for
  "no unprocessed outbox rows" waits forever: confirming a booking immediately schedules a
  reminder for the day before the appointment, as an outbox row with a future `availableAt`.
  The wait now counts only work that is *due*, which is the relay's own definition.
- **The API cannot start against an empty database, and the router that seeds it lives
  inside the API.** Circular, and only visible when something tries to start the stack from
  nothing. The e2e stack now runs `prisma migrate deploy && node dist/seed.main.js` before
  the API — which also means a developer cannot run the suite against a schema two
  migrations behind, the mistake Task 11.2's readiness probe caught the hard way.
- **`expect(page).toHaveURL(/\/office(\/|$)/)` is satisfied by `/office/login`.** So a
  failed sign-in passed the login helper and surfaced as an unexplained 401 several steps
  later, in a test about settings. The helper now waits for the signed-in chrome.
- **The first attempt at the expiry test was a race, and it passed twice before failing.**
  It asserted the intermediate `EXPIRING` state from the browser;
  `SWEEP_EXPIRED_RESERVATIONS` runs every sixty seconds and had already finished the saga.
  Rewritten to assert only what is deterministic — see deviation 58. Worth remembering that
  two green runs proved nothing here.
- **A slot label is not unique.** "09:00" is on every working day in the week the picker
  shows, so `filter({ hasText: '09:00' })` matched five buttons and the assertion that a
  reserved slot had disappeared could not fail. Scoped to the day by `data-date`.

- **`Set-Cookie` was going into the log.** pino's automatic request log has been on since
  the logger module landed, and its default response serializer emits every response
  header. The redaction list covers `req.headers.cookie` but nothing on the response, so
  `POST /api/auth/login` wrote a live session id into the log file. Found by reading an
  actual line from a booted process rather than the configuration that produces it. The
  serializers now keep the status and nothing else, which is a fix that cannot be
  forgotten the next time a route sets a header.
- **Every log line inside a request claimed `statusCode: 200`.** `customProps` decorates
  each line pino writes during a request, and it read `res.statusCode` — which is Node's
  default until the response is written. So the exception filter's own line about a 401
  said 200. The status now comes from `customSuccessObject`/`customErrorObject`, which
  run only on the line that completes the request.
- **The development database was two migrations behind, and nothing had said so.**
  `/api/health/ready` answered 503 on its first real request, naming
  `20260801190000_audit_actions_for_configuration` and
  `20260802080000_audit_actions_for_customers`. Exactly the failure the indicator exists
  for, found by curling it rather than by trusting the integration test that had just
  passed against a migrated test database.
- **`import pinoHttp from 'pino-http'` is not callable.** Same shape as the ioredis
  import: CJS types with no `exports` map, so under NodeNext the default import resolves
  to the module namespace. Only `typecheck` catches it — the suite passes, because SWC's
  interop hands back something callable at runtime.

- **`vue-tsc --noEmit | grep "error TS"` matches nothing.** Its default formatter does not
  print that string, so the web app's typecheck was reported clean while eleven errors
  stood — two wrong response fields among them. Every gate is now read from the exit code.
- **`vue: true` had never been exercised in the shared ESLint factory.**
  `strictTypeChecked` was overriding the Vue parser, so every `.vue` file failed to parse
  with "'>' expected" — which looked like a syntax error in the components.
- **The checkout page went blank on expiry.** Handling the countdown's `expired` event
  cleared the draft the template was bound to, at the moment the page needed to explain
  itself. It now renders from a local copy — and the redirect guard moved into the timer
  callback, because the countdown reports expiry during *its* mount, before the parent has
  a timer to cancel.
- **"We keep 0,00 €."** The cancellation wording was keyed on `feeApplies` rather than on
  the retained amount, so a business inside its fee window that keeps nothing produced a
  sentence a customer has to read three times. Found by looking at the real page.

- **A caught unique violation poisons a Prisma interactive transaction.** Prisma
  does not wrap statements in savepoints, so after a failed statement every later
  one fails with "current transaction is aborted", surfaced as `P2039`. Probed
  directly, which also exposed that the reservation service's reference-collision
  retry — which documented the opposite as fact — could never have worked. The
  retry now wraps the whole transaction, and has the tests it never had.

- Decorator metadata was not emitted at all under Vitest 4, so NestJS DI would
  have failed in every future test with errors pointing nowhere near the cause.
  `di-metadata.spec.ts` now asserts `design:paramtypes` directly.
- A wrong `APP_ROLE` exited 1 with **zero output**, because `bufferLogs` discards
  the buffered Nest logger at `process.exit`.
- Two connection pools were opened: `$extends` proxies unknown properties to the
  base client, so `PrismaService.onModuleInit` was visible on the guarded client
  too and Nest called it once per provider. Hooks moved to `PrismaLifecycle`;
  `prisma.service.spec.ts` fails if one is ever added back.
- The shared Vitest type was silently `any` — its `.d.ts` imported from
  `vitest/config` and `skipLibCheck` suppressed the failed resolution.
- `src/prisma/client.ts` re-exported too little, leaving every enum **undefined at
  runtime** while still type-checking.
- `**/src/generated/` needed the leading `**/`: a pattern with a middle separator
  is anchored to the `.gitignore`'s directory, so generated code was being staged.
- `prisma/seed.ts` was in no tsconfig and had never been typechecked.
- The queue lifecycle looked broken and was not: `ioredis` flips `status` to `end`
  on the socket close event, which lands _after_ `quit()` resolves, so reading the
  property straight after `app.close()` races the transition. A canary provider
  proved Nest's hook was firing all along. The test now awaits the `end` event.
  Worth remembering the general shape: a shutdown assertion that reads state
  synchronously can report a clean teardown as a leak, and vice versa.
- Prisma 7's interactive transaction client **does** expose `$transaction`, so it
  cannot be used to tell a transaction client from a root one. `$connect` can: it is
  absent on a transaction client and present on both the root client and the
  tenant-guarded wrapper, whose proxy forwards it. That is what
  `assertTransactionClient` checks, and it is what makes "you forgot the
  transaction" a loud failure in the outbox recorder.
- A booted process logged nothing on shutdown, which is not evidence either way —
  pino may not flush before the process dies. Shutdown behaviour is asserted
  through a real Nest container in the integration suite instead of by reading a
  log.
- **A credential in the URL fragment was read only at setup.** Opening the emailed
  reset link while already on `/office/reset-password` is a hash-only navigation:
  the browser and the router both treat it as the same document, nothing remounts,
  and the token sat in the address bar under a page saying the link was incomplete.
  The customer management link had the same hole. `useFragmentCredential` now also
  listens for `hashchange`, and never clears a token it already holds — its own
  `replaceState` empties the fragment, so re-reading naively would discard the
  credential the page is using.
- **`scrollBehavior` handed the fragment to `document.querySelector`.** A token
  starting with a digit is not a valid selector, so it throws rather than missing.
  The two routes that receive a credential that way are now excluded by path.
- **A named `office` manual chunk made things worse, not better.** Adding one to
  `manualChunks` made Rollup fold `vendor` into it: one 316 kB file that the entry
  chunk depends on, so every customer would have downloaded the whole staff
  interface to get Vue. Route-level dynamic imports already split the area; the
  invariant is pinned by a test rather than by a chunk name.
- **A guard reached for a Pinia store on every navigation.** The office session
  guard is global, and it called `useSession()` before checking whether the route
  was an office one — which made the customer booking flow depend on a store
  existing. A public-route test failed on it, in the harness rather than in
  production, which is the cheap place to find it.
- **Test isolation, twice, in the same file.** Passing a fresh `createPinia()` to
  `mount` while the test held another meant the store the form wrote to was not the
  store the assertions read. And mounted apps stay installed in the
  module-singleton router, so a `beforeEach` guard resolved its store through a
  *previous* test's app and found it still signed in. Fixed by passing the instance
  to `useSession(pinia)` explicitly and by `enableAutoUnmount(afterEach)` — both
  worth knowing before writing the next office spec.

## Known Phase 1 limitations

- **The idempotency lease has a residual race.** If an attempt outlives its
  two-minute lease, a second attempt can take the key over and both run. What makes
  that safe is not the lease but `bookings_no_overlap`: the second reservation
  cannot overlap the first, so one attempt fails with `SLOT_UNAVAILABLE` rather than
  double-booking. Closing it properly needs an owner token on the row, which the
  schema has no column for.
- **BullMQ job-id deduplication only holds while the job exists in Redis.**
  Completed jobs are removed after a day, so a crash that leaves an outbox row
  unmarked for longer than that can enqueue a second time. Every processor has to be
  idempotent regardless, which is what the inbox and the idempotency key are for.

## Operational notes

- `resetDatabase()` truncates under a 5-second `lock_timeout`. `TRUNCATE` needs
  ACCESS EXCLUSIVE on every table, so a stray connection blocks it; without the
  timeout the only symptom is "Hook timed out" 30 seconds later. If integration
  tests hang, look for an orphaned vitest process holding a transaction on
  `booking_test`.
- The seeded owner and staff passwords are generated and printed once. Re-running the seed
  does not reset an existing user's password — set `SEED_OWNER_PASSWORD` and
  `SEED_STAFF_PASSWORD` to choose them on a fresh database, which is what the e2e stack
  does. The seed's entrypoint is `src/seed.main.ts`, so `node dist/seed.main.js` works in a
  built image; `pnpm db:seed` runs the same code through tsx.
- `vitest.integration.config.ts` refuses to run unless `DATABASE_URL` names a
  database containing `booking_test`.
- `test/redis.harness.ts` refuses to run unless `REDIS_QUEUE_PREFIX` starts with
  `test-`, because its reset calls `obliterate` on every queue. The API and its
  workers must agree on this variable; if they disagree the workers consume
  nothing and say nothing.
- `test/test-config.module.ts` provides `ENV` for integration tests that boot a
  real Nest container. It deliberately does not use the real `ConfigModule`, which
  calls `process.exit` on a missing variable — a poor diagnostic inside a test
  worker, and unrelated to what such a test is checking. Add variables to it as
  modules under test start reading them.
- Request handlers must never call `EnqueueService` directly. They write an
  `OutboxEvent` in the same transaction as the state change, and the dispatcher
  enqueues from there. Legitimate callers: the outbox dispatcher, webhook
  controllers (which have already recorded the event durably), the reconcilers,
  and the scheduler.
- Lint is normally ~5 seconds for the whole workspace. One run took 6m37s at 2%
  CPU and another was killed as out-of-memory — machine memory pressure, not the
  code; the same command was clean and fast immediately afterwards. If lint
  suddenly crawls, check free memory before suspecting a type.
- Seven gates before every commit: `pnpm typecheck`, `pnpm lint`, `pnpm format`,
  `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, and `prisma migrate diff
  --from-migrations --to-schema --exit-code`. The last one needs the `booking_shadow`
  database, which `docker/postgres-init.sql` creates on first volume init.
- **The end-to-end suite.** `pnpm test:e2e` builds the workspace and then runs Playwright
  against the built bundle; there is no separate setup step. It needs the *test* Compose
  stack up (`pnpm test:infra:up`) and, once, `pnpm web exec playwright install chromium`.
  It provisions its own `booking_e2e` database — Prisma creates it — and uses Redis logical
  database 1, so it cannot reach the integration suite's data. A run takes about a minute
  for 32 tests across two viewports.
- **An e2e test that only failed after lunch.** `a reserved slot disappears for the next
  visitor` reserved the first free slot on the first free day and then asserted that day
  still had others. The earliest bookable day is the one the 24-hour notice window is
  eating into, so from mid-afternoon it is down to its last few slots and one reservation
  clears it. Both visitors now step a week along. Worth remembering as a shape: any e2e
  assertion about "the first free day" is an assertion about the time of day it runs at.
- **Two sessions must not run the e2e suite at once either**, and not for the integration
  suite's reason: the API listens on 3100 and the preview server on 4173, and
  `reuseExistingServer` means the second run would silently drive the first run's
  processes.
- `ENABLE_TEST_SUPPORT=true` mounts `/api/test-support/*`, which can truncate the database
  and mark payments received. The environment schema refuses it when `NODE_ENV=production`,
  the module is absent from the container when the flag is off, and the reset refuses any
  database not named `booking_test` or `booking_e2e`. The API logs a `warn` line at
  bootstrap whenever it is mounted — if that line appears anywhere unexpected, treat it as
  an incident.
- The e2e stack runs the worker at `LOG_LEVEL=info` while everything else is at `warn`.
  Its "Worker running" line is what global setup waits for, and when a journey fails the
  question is almost always which job ran.
- **Two sessions must not run the integration suite at once.** One run of
  `health.int.spec.ts` failed with a foreign-key violation and a `40P01 deadlock
  detected` inside `seedOrganization`, and passed unchanged immediately afterwards. The
  cause was the other stream running its own suite against `booking_test` at the same
  moment: `resetDatabase()` truncates every table, so one suite's TRUNCATE lands in the
  middle of the other's seed. Worth reading the "unexplained" entry below in that light —
  a 409 that became a 404 is what a row deleted mid-test looks like.
- **One intermittent integration failure, unexplained.** Two full-suite runs failed
  with a single assertion each — `idempotency.int.spec.ts` "stores nothing when the
  handler fails", then `public-bookings.int.spec.ts` expecting 409 and getting 404 —
  both while `docker build` was saturating the machine. Five subsequent full runs
  and five loops of those two files in isolation were green, so it is not
  reproducible on an idle machine. Ruled out: the outbox dispatcher (it only starts
  when `APP_ROLE=worker`, which the test env does not set), unclosed containers in
  the worker-bootstrap suite, and any Prisma error mapping to 404 (raw Prisma errors
  become a generic 500; a 404 needs a deliberate `AppError`). If it recurs, capture
  the response body — the 404 can only come from a service or booking lookup, which
  would mean the row genuinely was not there.
- `LOG_SAMPLE_RATE` is the share of `GET /public/availability` lines that are written,
  and it applies to that endpoint alone. Everything else is logged in full, because a
  sampled-out booking or webhook is a hole in the story exactly where an investigation
  needs it. Health probes are never logged at all.
- `/api/health/detail` caches its counters for ten seconds. A dashboard polling it cannot
  turn a diagnostic into a load source, and none of these numbers means anything at a
  finer resolution than that.
- Reminders are the one place a *fresh* management token is minted outside
  confirmation and reschedule. It happens inside the transaction that queues the
  message, so a rollback cannot leave a live credential for a message never sent.
