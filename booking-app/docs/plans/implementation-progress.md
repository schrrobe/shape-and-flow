# Phase 1 — Implementation Progress

Companion to `phase-1-implementation-plan.md`. That document is the spec and does
not change; this one records what is built, what is next, and the decisions taken
while implementing that the plan could not have known.

|                   |                                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| Branch            | `feat/phase-1-booking-app` (nothing pushed)                                       |
| Tasks complete    | 20 of 49                                                                          |
| Unit tests        | 379 passing (364 api + 15 contracts)                                              |
| Integration tests | 175 passing                                                                       |
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
| 5.1  | Public catalog and availability endpoints                                      |

## Next

| Task | What it is                                            |
| ---- | ----------------------------------------------------- |
| 5.2  | Reservation transaction under the advisory lock       |
| 5.3  | Booking endpoint, Checkout session, idempotent replay |
| 5.4  | Stripe webhook ingress and booking confirmation       |
| 5.5  | Two-phase expiry saga                                 |

Deferred out of the slice: 3.4, and all of stages 6–11.

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

## Plan errors found while implementing

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

## Bugs caught by verifying rather than assuming

Each of these would have passed a casual "it works" check.

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

## Known Phase 1 limitations

- **The idempotency lease has a residual race.** If an attempt outlives its
  two-minute lease, a second attempt can take the key over and both run. What makes
  that safe is not the lease but `bookings_no_overlap`: the second reservation
  cannot overlap the first, so one attempt fails with `SLOT_UNAVAILABLE` rather than
  double-booking. Closing it properly needs an owner token on the row, which the
  schema has no column for.
- **BullMQ job-id deduplication only holds while the job exists in Redis.**
  Completed jobs are removed after a day, so a crash that leaves an outbox row
  unmarked for longer than that can enqueue a second time. Before side-effecting
  processors ship in stage 7, each must persist and conditionally claim a durable
  delivery key derived from the outbox event id (or enforce an equivalent
  domain-level applied marker) before sending. Inbox and HTTP request idempotency do
  not protect outgoing delivery after Redis retention expires.

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
  workers must agree on this variable. Worker readiness in stage 7 must expose the
  effective prefix and configured queue names, so a mismatch is visible and marks
  the deployment unhealthy instead of leaving a silently idle worker.
- `test/test-config.module.ts` provides `ENV` for integration tests that boot a
  real Nest container. It deliberately does not use the real `ConfigModule`, which
  calls `process.exit` on a missing variable — a poor diagnostic inside a test
  worker, and unrelated to what such a test is checking. Add variables to it as
  modules under test start reading them.
- Request handlers must never call `EnqueueService` directly. State-changing
  handlers write an `OutboxEvent` in the same transaction as the state change, and
  the post-commit dispatcher enqueues it. Webhook handlers first persist the inbox
  event, commit, and return; a non-request-handler dispatcher then enqueues it, with
  the reconciler recovering the persist/commit-to-enqueue crash window. Legitimate
  direct callers are therefore dispatchers, reconcilers, and the scheduler — not
  controllers.
- Lint is normally ~5 seconds for the whole workspace. One run took 6m37s at 2%
  CPU and another was killed as out-of-memory — machine memory pressure, not the
  code; the same command was clean and fast immediately afterwards. If lint
  suddenly crawls, check free memory before suspecting a type.
