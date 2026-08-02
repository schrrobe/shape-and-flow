# Phase 1 — Implementation Progress

Companion to `phase-1-implementation-plan.md`. That document is the spec and does
not change; this one records what is built, what is next, and the decisions taken
while implementing that the plan could not have known.

|                   |                                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| Branch            | `feat/phase-1-booking-app` (nothing pushed)                                       |
| Tasks complete    | 44 of 49                                                                          |
| Unit tests        | 720 passing (480 api + 166 web + 37 contracts + 37 ui)                            |
| Integration tests | 676 passing                                                                       |
| Gates             | `pnpm lint`, `format`, `typecheck`, `test`, `test:integration`, `build` all green |

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

| Task | What is left                                                   |
| ---- | -------------------------------------------------------------- |
| 11.1 | End-to-end suite; in progress in a parallel stream at the time of writing |
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

## Plan errors found while implementing

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
- The seeded owner password is generated and printed once. Re-running the seed
  does not reset it.
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
- Six gates before every commit: `pnpm typecheck`, `pnpm lint`, `pnpm format`,
  `pnpm test`, `pnpm test:integration`, and `prisma migrate diff --from-migrations
  --to-schema --exit-code`. The last one needs the `booking_shadow` database, which
  `docker/postgres-init.sql` creates on first volume init.
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
