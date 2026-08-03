# Phase 1 — Implementation Progress

Companion to `phase-1-implementation-plan.md`. That document is the working spec
and is revised when implementation or review proves a statement wrong; this one
records what is built, what is next, and why the implementation diverged.

| | |
| --- | --- |
| Branch | `feat/p1-01-foundation` (PR #2) |
| Tasks complete | 12 of 49 |
| Unit tests | 241 passing |
| Integration tests | 68 passing |
| Gates | Unit/integration/lint/format/typecheck/build are re-verified before each update; e2e is not available until the web workspace lands in its later stacked PR |

## Execution order — vertical slice

The user chose a vertical slice over the plan's stage order, to reach a working
booking flow sooner. The reorder cost is near zero, because the plan already
front-loads the booking path: the slice is **tasks 1.2 → 5.5**, deferring only
Task 3.4 (email and SMS adapters). Stage 6 onward (lifecycle, office API, web
apps, hardening) follows afterwards.

Slice target: real catalog → real slot maths → reserve under the exclusion
constraint → Stripe Checkout → webhook confirms.

## Done

| Task | What landed |
| --- | --- |
| 0.1 | pnpm workspace at repo root, Node and pnpm pinned by the repository |
| 0.2 | `booking-config`: shared tsconfig, ESLint factory, Prettier, Vitest base |
| 0.3 | Dev and test Compose stacks, isolated (5433/6380 and 5434/6381) |
| 0.4 | CI: lint, test, integration, e2e, build — degrades gracefully as packages land |
| 1.1 | NestJS app, validated env, Prisma 7 + pg driver adapter, `/api/health/live` |
| 1.2 | 29 models, 18 enums, 107 indexes, initial migration |
| 1.3 | Exclusion constraints, CHECKs, partial unique indexes, integration harness |
| 1.4 | Organization context, tenant Prisma guard, idempotent seed |
| 2.1 | `Money` value object, locale formatting, cent-arithmetic ban |
| 2.2 | DST-safe wall-clock conversion, interval algebra, injectable `Clock` |
| 2.3 | Availability engine — pure slot generation, 48 tests |
| 2.4 | Pricing, cancellation-fee policy, deterministic employee selection |

## Next

| Task | What it is |
| --- | --- |
| **3.1** | **Contracts package, error envelope, correlation, redacted logging. Next.** |
| 3.2 | Provider ports (payment, email, SMS) plus in-memory fakes |
| 3.3 | Stripe Checkout adapter |
| 4.1 | Queue and job-payload contracts |
| 4.2 | Transactional outbox: recorder, dispatcher, reconciler |
| 4.3 | Webhook inbox: recorder, reconciler |
| 4.4 | Idempotency service and interceptor |
| 5.1 | Public catalog and availability endpoints |
| 5.2 | Reservation transaction under the advisory lock |
| 5.3 | Booking endpoint, Checkout session, idempotent replay |
| 5.4 | Stripe webhook ingress and booking confirmation |
| 5.5 | Two-phase expiry saga |

Deferred out of the slice: 3.4, and all of stages 6–11.

## Version drift from the plan, and why

Snapshot as of 2026-08-02. Re-check these constraints when any pinned tool is
updated: TypeScript support is documented in
[`typescript-eslint`'s dependency versions](https://typescript-eslint.io/users/dependency-versions/),
and Vitest's transformer change is covered by its
[`experimentalOxc` migration note](https://vitest.dev/guide/migration.html#experimental-oxc).

The plan was written against a slightly older ecosystem. Each of these was a
decision, not a mechanical bump.

- **TypeScript 6.0.3, not 7.** As of the snapshot date,
  `typescript-eslint` 8.65 caps support at `<6.1.0`. Type-aware linting is
  load-bearing for several planned rules, so the newest compatible version wins.
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

## Plan errors found while implementing

- **§8.4 error handling was wrong, in our favour.** It assumed `23P01` arrives as
  an opaque `PrismaClientUnknownRequestError` needing a message regex. Prisma 7's
  pg adapter reports `PrismaClientKnownRequestError` code `P2039` with the
  SQLSTATE as structured data at `meta.driverAdapterError.cause.originalCode`.
- **Task 2.2's ambiguity check looked one hour early.** That never fires: Luxon
  already resolves an ambiguous local time to the earlier offset, so the check
  must look one hour *later*.
- **Task 2.4's `insideFreeWindow` flag was named backwards.** The plan's own
  examples set it true when the appointment is *close* — which is when
  cancellation is not free. Implemented as `feeApplies`.
- **"20 enums" should read 18.** Corrected in the plan.

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

## Operational notes

- `resetDatabase()` truncates under a 5-second `lock_timeout`. `TRUNCATE` needs
  ACCESS EXCLUSIVE on every table, so a stray connection blocks it; without the
  timeout the only symptom is "Hook timed out" 30 seconds later. If integration
  tests hang, look for an orphaned vitest process holding a transaction on
  `booking_test`.
- The seeded owner password is generated and printed once. Re-running the seed
  does not reset it.
- `vitest.integration.config.ts` parses the PostgreSQL URL and refuses to run
  unless its decoded database pathname is exactly `booking_test`; near-misses
  such as `production_booking_test` are rejected before any truncation.
