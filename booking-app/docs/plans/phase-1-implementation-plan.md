# Phase 1 Implementation Plan — Shape and Flow Booking Application

Single business, one Stripe account, public customers book and pay online, office
staff (`OWNER` / `ADMIN` / `EMPLOYEE`) manage everything. The architecture is
multi-tenant-**ready** — `organizationId` on every owned row, provider
abstractions already shaped for Stripe Connect — while shipping **zero** SaaS
features in Phase 1.

| Property | Value |
| --- | --- |
| Repository root | `.` |
| Product area | `booking-app` |
| Runtime | Node 24.18.0, pnpm workspaces |
| API | NestJS 11 + Prisma 7.9.1 + PostgreSQL 17 + Redis 7 (BullMQ) |
| Web | Vue 3 + Vite + TypeScript + Tailwind CSS 4 + Pinia + vue-i18n |
| Payments | Stripe Checkout (hosted), card and wallets only |
| Timezone | `Europe/Berlin` (storage `timestamptz`, all reasoning in local wall clock) |
| Currency | EUR, integer cents, never floats |
| Locales | `de` (default) and `en` for customer-facing surfaces; office copy is English-only |
| Task count | 49 tasks across 12 stages |

Every path in this document is repository-relative. Every step is a `- [ ]`
checkbox. Tasks are
ordered so that each one compiles, tests green, and is independently
committable.

---

## 1. Repository assessment

Verified state of the repository at the moment this plan was written:

- `git log --oneline` → a single commit, `457c211 chore: initialize repository`.
  Branch `main`, working tree clean.
- Tracked files: `README.md` (contents:
  `# Shape and Flow` / `Monorepo for Shape and Flow.`) and
  `.gitignore` (contents: `.DS_Store`,
  `.tokensave/`, `.claude/settings.local.json`).
- `booking-app/docs/plans/` exists and is
  otherwise empty; it holds this document. No other directory under
  `booking-app/` exists yet.
- **No** package manager manifest, **no** lockfile, **no** `.tool-versions`,
  **no** `.npmrc`, **no** ESLint/Prettier/TypeScript configuration, **no** CI
  workflow, **no** shared packages, **no** Docker assets.
- Local toolchain available: Node 24.18.0 installed through asdf (24.15.0 and
  24.16.0 also present; no version is pinned for this directory yet),
  Docker 29.6.1, Docker Compose v5.3.0. **pnpm is not installed** — Task 0.1
  activates it through Corepack rather than a global install, so the version is
  pinned by the repository instead of by the machine.

### What follows from a greenfield repository

Because nothing is established, there is no existing convention to defer to.
Every "use the repository's existing choice if it has one" decision therefore
resolves to the default named in this document, and those defaults are recorded
here so later tasks never have to re-decide:

| Concern | Decision | Rationale |
| --- | --- | --- |
| Package manager | pnpm 10 via Corepack, `packageManager` field in root `package.json` | Workspace protocol, strict `node_modules`, reproducible across machines without a global install |
| Module system | ESM everywhere (`"type": "module"`), `NodeNext` resolution | Node 24 native ESM; avoids the dual-package hazard in shared packages |
| Language | TypeScript 5.7, `strict: true`, `noUncheckedIndexedAccess: true` | Money and time bugs are the expensive class of bug in a booking system |
| Test runner | Vitest 3 (unit + integration), Playwright (end-to-end) | One runner for API and web; Vitest workspace projects separate unit from integration |
| Lint / format | ESLint 9 flat config + Prettier 3 | Flat config is the only supported form in ESLint 9 |
| ORM | Prisma 7.9.1 with the ESM-native `prisma-client` generator, pg driver adapter, and **hand-written** migrations for enum and constraint changes | Prisma's generated enum migrations can drop dependent constraints (see §8) |
| Validation | Zod 4.4.3 schemas in `@shape-and-flow/booking-contracts`, bridged into NestJS with `nestjs-zod` 5.x | One schema is request validation, response typing, and OpenAPI source through Zod 4's native JSON Schema support |
| Logging | pino with AsyncLocalStorage correlation ids and PII redaction | Structured logs, one correlation id per request and per job |

---

## 2. Selected architecture

### 2.1 Shape

A pnpm monorepo whose **workspace root is the repository root**, with all
booking-application code inside `booking-app/`. Two deployable processes, both
built from one NestJS codebase:

```
                         ┌──────────────────────────────┐
   public customers ────► │  booking-web (Vue SPA)       │
                         │  /  and  /manage#<token>     │
                         └───────────────┬──────────────┘
                                         │ same-origin /api
   office staff ─────────────────────────┤
                                         ▼
                         ┌──────────────────────────────┐
   Stripe webhooks ─────► │  booking-api (NestJS HTTP)   │ ──► PostgreSQL 17
   Resend / Twilio ─────► │  main.ts → AppModule         │ ──► Redis 7
                         └───────────────┬──────────────┘
                                         │ outbox rows (same tx)
                                         ▼
                         ┌──────────────────────────────┐
                         │  booking-worker (no HTTP)    │ ──► PostgreSQL 17
                         │  worker.main.ts →            │ ──► Redis 7 (BullMQ)
                         │  WorkerModule                │ ──► Stripe / Resend / Twilio
                         └──────────────────────────────┘
```

### 2.2 Decisions and why

**The worker is a second entrypoint, not a second app.**
`booking-app/apps/api/src/worker.main.ts`
bootstraps `WorkerModule` with `NestFactory.createApplicationContext` — no HTTP
listener. It hosts the BullMQ processors, the outbox dispatcher, and the
reconcilers, and it reuses the same domain services and the same Prisma client as
the HTTP process. A separate app would force premature extraction of every
domain service into a package for the sake of a boundary Phase 1 does not need;
splitting later is mechanical (move `worker.main.ts` plus `WorkerModule` into a
new app that imports the domain packages). The two processes are distinguished
only by `Dockerfile` target and by the `APP_ROLE` environment variable, which is
asserted at bootstrap so an HTTP process can never silently start consuming
queues.

**Contracts live in one package and are the single source of truth.**
`@shape-and-flow/booking-contracts` exports Zod schemas plus their inferred
types. `nestjs-zod` 5.x turns each Zod 4 schema into a DTO class for the global
`ZodValidationPipe` and uses Zod 4's native `z.toJSONSchema` support for the
Swagger document. The web app imports the inferred types through a thin typed
`fetch` client. One change to a schema propagates to validation, documentation,
and the front end in a single compile.

**Errors have one shape.** A global exception filter emits
`{ code, message, details?, correlationId }` with a stable machine-readable
`code` enum (`SLOT_UNAVAILABLE`, `IDEMPOTENCY_KEY_REUSED`,
`BOOKING_NOT_CANCELLABLE`, `VALIDATION_FAILED`, …). The web app switches on
`code`, never on `message`, so copy can change per locale without breaking
behaviour.

**Availability is pure.** Slot generation is a set of pure functions with no
database access; the caller loads a snapshot of working hours, breaks, time off,
exceptions, blocked time, closed days, and existing bookings, then asks the
engine for slots. Pure functions make DST correctness and buffer arithmetic
testable without a database, which is the only practical way to get this right.

**Money is integer cents in a value object.** `Money` wraps `{ amountCents:
number, currency: 'EUR' }`, rejects non-integers at construction, and offers
`plus`, `minus`, `multiplyPercent`, and `allocate`. No route, service, or
template touches a raw number. Percentage cancellation fees round **down** to
the customer's benefit and the remainder is documented.

**Tenancy is resolved on the server, never from the request.** See §10.1. This is
the single most important security invariant in the codebase and it is enforced
by a Prisma client extension plus a contract test, not by reviewer diligence.

**Reservation and booking are one row.** A `Booking` in `PENDING_PAYMENT` *is*
the reservation; `expiresAt`, `stripeCheckoutSessionId`, and `idempotencyKeyId`
live on it. One row means one exclusion constraint governs both reservations and
confirmed bookings, and there is no reservation↔booking synchronisation gap to
get wrong. Recorded as a deviation in §11.3.

**Durability is a transactional outbox, not a best-effort enqueue.** No request
handler enqueues a job. State change and outbox row commit together; a dispatcher
in the worker turns committed outbox rows into BullMQ jobs. Inbound webhooks use
the mirror-image inbox. See §9.

### 2.3 Technology inventory

| Layer | Choice | Version target |
| --- | --- | --- |
| API framework | NestJS | 11.x |
| ORM | Prisma Client + Prisma Migrate | 6.x |
| Database | PostgreSQL with `btree_gist` | 17.x |
| Queue | BullMQ on Redis | BullMQ 5.x / Redis 7.x |
| Payments | `stripe` Node SDK, hosted Checkout | 17.x, API version pinned in code |
| Email | Resend | 4.x |
| SMS | Twilio | 5.x |
| Dates | luxon | 3.x |
| Passwords | `argon2` (argon2id) | 0.41.x |
| Validation | zod + nestjs-zod | 4.4.3 / 5.x |
| Web framework | Vue | 3.5.x |
| Web build | Vite | 6.x |
| Web state | Pinia | 2.x |
| Web i18n | vue-i18n | 11.x |
| Styling | Tailwind CSS | 4.x |
| Icons | Font Awesome (free solid + brands, self-hosted) | 6.x |
| Unit / integration tests | Vitest | 3.x |
| End-to-end tests | Playwright | 1.5x |

Exact versions are resolved once by the lockfile created in Task 0.1 and are
never floated afterwards; the Stripe API version is pinned explicitly in the
adapter so an SDK upgrade cannot silently change webhook payload shapes.

---

## 3. Folder and file structure

### 3.1 Why the workspace root is the repository root

The `pnpm-workspace.yaml` lives at ``, not at
`booking-app/`. The repository is named
"Shape and Flow" and its README already calls it a monorepo, so `booking-app` is
one product area inside it rather than the repository's purpose. Consequences,
all deliberate:

- Adding a second product later means adding two globs to one
  `pnpm-workspace.yaml`, not creating a second, competing workspace root with a
  second lockfile.
- One lockfile at the root means one dependency resolution graph and one
  `pnpm install` for CI.
- **Product-scoped** tooling and infrastructure nevertheless stay inside
  `booking-app/`: `booking-app/packages/config` owns the shared
  `tsconfig.base.json`, ESLint flat config, Prettier config, and Vitest base
  config; `booking-app/docker-compose.yml` owns the container and port
  allocation. A future second product therefore cannot collide with
  `booking-app` on a container name, a port, or a lint rule.
- The root `package.json` keeps only workspace-level concerns
  (`packageManager`, `engines`, delegating scripts) so it does not accumulate
  product detail.

This is a documented deviation from the source specification's structure
diagram, which nested `pnpm-workspace.yaml` inside `booking-app/`. See §11.3.

### 3.2 Complete tree

```

├── .github/
│   └── workflows/
│       └── ci.yml                      # install → lint → typecheck → unit → integration → e2e → build
├── .gitignore                          # extended in Task 0.1
├── .npmrc                              # node-linker=isolated, strict-peer-dependencies=true
├── .tool-versions                      # nodejs 24.18.0
├── README.md                           # extended in Task 11.3
├── package.json                        # private root, packageManager, engines, delegating scripts
├── pnpm-lock.yaml                      # single lockfile for the whole monorepo
├── pnpm-workspace.yaml                 # packages: booking-app/apps/*, booking-app/packages/*
└── booking-app/
    ├── .env.example                    # every variable the config schema requires
    ├── docker-compose.yml              # name: shape-and-flow-booking   (postgres 5433, redis 6380)
    ├── docker-compose.test.yml         # name: shape-and-flow-booking-test (postgres 5434, redis 6381)
    ├── apps/
    │   ├── api/                        # @shape-and-flow/booking-api
    │   │   ├── Dockerfile              # targets: api, worker
    │   │   ├── package.json
    │   │   ├── tsconfig.json
    │   │   ├── vitest.config.ts        # unit projects, no database
    │   │   ├── vitest.integration.config.ts
    │   │   ├── prisma/
    │   │   │   ├── schema.prisma
    │   │   │   ├── seed.ts
    │   │   │   └── migrations/
    │   │   │       ├── 20260801000000_init/migration.sql
    │   │   │       └── 20260801000100_calendar_constraints/migration.sql
    │   │   ├── src/
    │   │   │   ├── main.ts             # HTTP entrypoint
    │   │   │   ├── worker.main.ts      # worker entrypoint, no HTTP listener
    │   │   │   ├── app.module.ts
    │   │   │   ├── worker.module.ts
    │   │   │   ├── config/
    │   │   │   │   ├── env.schema.ts
    │   │   │   │   └── config.module.ts
    │   │   │   ├── common/
    │   │   │   │   ├── correlation/    # AsyncLocalStorage store + middleware + job wrapper
    │   │   │   │   ├── logging/        # pino logger, redaction paths
    │   │   │   │   ├── errors/         # AppError, error codes, global filter
    │   │   │   │   ├── prisma-errors/  # isExclusionViolation, isSerializationFailure
    │   │   │   │   └── pagination/     # cursor + offset helpers
    │   │   │   ├── prisma/
    │   │   │   │   ├── prisma.service.ts
    │   │   │   │   ├── tenant.extension.ts
    │   │   │   │   └── prisma.module.ts
    │   │   │   ├── organization/
    │   │   │   │   ├── organization-context.service.ts
    │   │   │   │   └── organization.module.ts
    │   │   │   ├── domain/
    │   │   │   │   ├── money/
    │   │   │   │   ├── time/
    │   │   │   │   ├── availability/
    │   │   │   │   ├── pricing/
    │   │   │   │   └── employee-selection/
    │   │   │   ├── providers/
    │   │   │   │   ├── payment/        # interface, tokens, StripePaymentProvider, FakePaymentProvider
    │   │   │   │   ├── email/          # interface, ResendEmailProvider, FakeEmailProvider
    │   │   │   │   ├── sms/            # interface, TwilioSmsProvider, FakeSmsProvider
    │   │   │   │   └── providers.module.ts
    │   │   │   ├── messaging/
    │   │   │   │   ├── outbox/         # recorder, dispatcher, reconciler
    │   │   │   │   ├── inbox/          # webhook event recorder, reconciler
    │   │   │   │   ├── queues/         # queue names, job payload schemas, registration
    │   │   │   │   └── idempotency/    # service, interceptor, sweeper
    │   │   │   ├── booking/
    │   │   │   │   ├── booking.service.ts
    │   │   │   │   ├── reservation.service.ts
    │   │   │   │   ├── expiry.service.ts
    │   │   │   │   ├── cancellation.service.ts
    │   │   │   │   ├── reschedule.service.ts
    │   │   │   │   ├── attendance.service.ts
    │   │   │   │   ├── booking-status.machine.ts
    │   │   │   │   └── processors/
    │   │   │   ├── payment/
    │   │   │   │   ├── payment.service.ts
    │   │   │   │   ├── refund.service.ts
    │   │   │   │   └── manual-payment.service.ts
    │   │   │   ├── notification/
    │   │   │   │   ├── notification.service.ts
    │   │   │   │   ├── reminder.service.ts
    │   │   │   │   └── processors/
    │   │   │   ├── public/             # /public controllers
    │   │   │   ├── manage/             # /manage controllers (token-authenticated)
    │   │   │   ├── auth/               # /auth controllers, session store, guards
    │   │   │   ├── office/             # /office controllers
    │   │   │   ├── webhooks/           # /webhooks controllers
    │   │   │   └── health/
    │   │   └── test/
    │   │       ├── setup.unit.ts
    │   │       ├── setup.integration.ts
    │   │       ├── database.harness.ts # per-worker template database clone
    │   │       └── factories/
    │   └── web/                        # @shape-and-flow/booking-web
    │       ├── Dockerfile
    │       ├── index.html
    │       ├── package.json
    │       ├── tsconfig.json
    │       ├── vite.config.ts
    │       ├── playwright.config.ts
    │       ├── e2e/
    │       └── src/
    │           ├── main.ts
    │           ├── App.vue
    │           ├── router/
    │           ├── api/                # typed fetch client generated from contracts
    │           ├── i18n/               # de.json, en.json, index.ts
    │           ├── stores/             # Pinia: booking draft, session, locale
    │           ├── pages/
    │           │   ├── public/         # wizard steps, confirmation, manage, cancel
    │           │   └── office/         # login, dashboard, calendar, management screens
    │           └── components/
    ├── packages/
    │   ├── config/                     # @shape-and-flow/booking-config
    │   │   ├── package.json
    │   │   ├── tsconfig.base.json
    │   │   ├── eslint.config.js
    │   │   ├── prettier.config.js
    │   │   └── vitest.base.ts
    │   ├── contracts/                  # @shape-and-flow/booking-contracts
    │   │   ├── package.json
    │   │   ├── tsconfig.json
    │   │   └── src/
    │   │       ├── index.ts
    │   │       ├── enums.ts
    │   │       ├── errors.ts
    │   │       ├── pagination.ts
    │   │       ├── public/
    │   │       ├── manage/
    │   │       ├── auth/
    │   │       ├── office/
    │   │       └── queues/
    │   ├── ui/                         # @shape-and-flow/booking-ui
    │   │   ├── package.json
    │   │   └── src/
    │   │       ├── tokens.css          # beige / black / orange custom properties
    │   │       ├── tailwind-preset.ts  # semantic token → Tailwind mapping
    │   │       ├── icons.ts            # curated Font Awesome subset
    │   │       └── components/
    │   └── notification-templates/     # @shape-and-flow/booking-notification-templates
    │       ├── package.json
    │       └── src/
    │           ├── index.ts            # render(templateKey, locale, data)
    │           ├── de/
    │           └── en/
    ├── infrastructure/
    │   ├── nginx/booking.conf          # same-origin reverse proxy, /api → api, / → web
    │   └── scripts/
    │       ├── backup.sh
    │       └── restore.sh
    └── docs/
        ├── operations.md               # runbooks, backup/restore, incident playbooks
        └── plans/
            └── phase-1-implementation-plan.md   # this document
```

### 3.3 Package graph

```
booking-config ◄── booking-contracts ◄── booking-api
       ▲                   ▲                  │
       │                   │                  └──► booking-notification-templates
       └── booking-ui ◄── booking-web ─────────────┘
```

`booking-contracts` depends on nothing but `zod` — it must stay importable from
both the Node API and the browser bundle. `booking-notification-templates`
depends on `booking-contracts` for its data types and on nothing else, so
templates can be unit-tested and snapshot-rendered without a Nest container.

### 3.4 Root scripts (delegating only)

| Script | Delegates to |
| --- | --- |
| `pnpm db:up` | `docker compose -f booking-app/docker-compose.yml up -d` |
| `pnpm db:down` | `docker compose -f booking-app/docker-compose.yml down` |
| `pnpm test:infra:up` | `docker compose -f booking-app/docker-compose.test.yml up -d --wait` |
| `pnpm lint` | `pnpm -r lint` |
| `pnpm typecheck` | `pnpm -r typecheck` |
| `pnpm test` | `pnpm -r test` |
| `pnpm test:integration` | `pnpm --filter @shape-and-flow/booking-api test:integration` |
| `pnpm test:e2e` | `pnpm --filter @shape-and-flow/booking-web test:e2e` |
| `pnpm build` | `pnpm -r build` |
| `pnpm dev` | `pnpm --parallel --filter @shape-and-flow/booking-api --filter @shape-and-flow/booking-web dev` |

All filters use package names, never directory paths, so moving a directory does
not break a script.
---

## 4. Domain model

### 4.1 Conventions applied to every model

- **Primary key**: `id String @id @default(cuid())`. Opaque, collision-resistant,
  non-sequential, so an id in a URL leaks no volume information.
- **Timestamps**: `createdAt DateTime @default(now())` and
  `updatedAt DateTime @updatedAt` on every model except append-only tables
  (`BookingStatusHistory`, `AuditLog`, `OutboxEvent`), which carry only
  `createdAt`.
- **Naming**: Prisma models are `PascalCase`, tables and columns are mapped to
  `snake_case` with `@@map` / `@map`, because the raw SQL in migrations, the
  exclusion constraints, and the reconciler queries are written by hand against
  the physical names.
- **Time**: every instant is `DateTime @db.Timestamptz(3)`. There is no naive
  timestamp column anywhere. Local dates that are genuinely date-only (a closed
  day, a time-off day boundary) are `@db.Date`, and the code converts them to
  instants in `Europe/Berlin` at the edge.
- **Money**: integer minor units in an `Int` column named `…Cents`, always
  accompanied by a `currency` column where the value can be paid or refunded.
  Phase 1 writes `EUR` everywhere; the column exists so a second currency is a
  data change, not a migration of every money column.
- **Organization ownership**: every model below except `Organization` itself
  carries `organizationId String` plus
  `organization Organization @relation(fields: [organizationId], references: [id])`,
  and every model has a composite index that leads with `organizationId`. The
  three infrastructure tables that can legitimately arrive before an
  organization is known (`StripeWebhookEvent`, `MessagingWebhookEvent`,
  `IdempotencyKey`) carry `organizationId String?` and are documented as such.
- **Deletion policy** falls into exactly three buckets:
  - **Archive** (`archivedAt DateTime?`) for anything a historical booking
    references — `Employee`, `Service`, `ServiceCategory`, `OfficeUser`,
    `Customer`. Archived rows disappear from booking flows and from pickers but
    remain joinable, so a 2026 invoice still renders its service name in 2029.
  - **Cascade** for rows that are meaningless without their parent —
    `WorkingHours`, `Break`, `EmployeeService`, `BookingStatusHistory`,
    `ManagementToken`, `PasswordResetToken`.
  - **Restrict** for money — `Payment`, `ManualPayment`, and `Refund` can never
    be deleted by application code at all; there is no delete path in any
    service, and the relation is `onDelete: Restrict` so a stray cascade cannot
    reach them.
- **Referential integrity in Prisma** uses `relationMode = "foreignKeys"`
  (PostgreSQL default), so the database enforces it rather than the client.

### 4.2 Enums

```prisma
enum OfficeUserRole      { OWNER ADMIN EMPLOYEE }
enum Weekday             { MONDAY TUESDAY WEDNESDAY THURSDAY FRIDAY SATURDAY SUNDAY }
enum AvailabilityExceptionKind { EXTRA_HOURS CLOSED }
enum TimeOffStatus       { REQUESTED APPROVED REJECTED }
enum BookingOrigin       { ONLINE OFFICE }
enum BookingStatus {
  PENDING_PAYMENT
  EXPIRING
  EXPIRED
  CONFIRMED
  PAYMENT_FAILED
  CANCELED_BY_CUSTOMER
  CANCELED_BY_BUSINESS
  COMPLETED
  NO_SHOW
}
enum PaymentStatus       { PENDING SUCCEEDED FAILED REFUNDED PARTIALLY_REFUNDED }
enum ManualPaymentMethod { CASH CARD BANK_TRANSFER OTHER }
enum RefundStatus        { PENDING SUCCEEDED FAILED CANCELED }
enum RefundReason        { CUSTOMER_CANCELLATION BUSINESS_CANCELLATION GOODWILL DUPLICATE_PAYMENT }
enum CancellationFeePolicy { NONE FIXED_AMOUNT PERCENTAGE }
enum RequestDecision     { PENDING APPROVED REJECTED }
enum NotificationChannel { EMAIL SMS }
enum NotificationStatus  { PENDING SENT DELIVERED FAILED }
enum NotificationKind {
  BOOKING_CONFIRMATION
  BOOKING_CANCELED_BY_CUSTOMER
  BOOKING_CANCELED_BY_BUSINESS
  BOOKING_RESCHEDULED
  REMINDER_24H
  CANCELLATION_REQUEST_RECEIVED
  CANCELLATION_REQUEST_DECIDED
  RESCHEDULE_REQUEST_RECEIVED
  RESCHEDULE_REQUEST_DECIDED
  REFUND_ISSUED
  OFFICE_NEW_BOOKING
  OFFICE_CANCELLATION_REQUEST
  OFFICE_PASSWORD_RESET
}
enum Locale              { de en }
enum WebhookProvider     { RESEND TWILIO }
enum AuditAction {
  BOOKING_CREATED_MANUALLY
  BOOKING_CANCELED
  BOOKING_RESCHEDULED
  BOOKING_MARKED_NO_SHOW
  BOOKING_MARKED_COMPLETED
  CANCELLATION_REQUEST_DECIDED
  RESCHEDULE_REQUEST_DECIDED
  MANUAL_PAYMENT_RECORDED
  REFUND_ISSUED
  SETTINGS_UPDATED
  EMPLOYEE_CREATED
  EMPLOYEE_UPDATED
  EMPLOYEE_ARCHIVED
  SERVICE_CREATED
  SERVICE_UPDATED
  SERVICE_ARCHIVED
  OFFICE_USER_CREATED
  OFFICE_USER_UPDATED
  OFFICE_USER_ARCHIVED
}
```

`Locale` uses lowercase members deliberately: the value is written into URLs,
`Accept-Language` negotiation, and template directory names, and a case
conversion at three boundaries is three chances to get it wrong.

### 4.3 Entities

Twenty-nine models. Two things that look like entities but deliberately are
**not** tables:

- **Office sessions** live in Redis under `session:<sid>` with a TTL. A Postgres
  session table would add a write to every authenticated request for data whose
  natural lifetime is a TTL. Revocation is a Redis `DEL`, and
  `session:user:<officeUserId>` holds a set of that user's session ids so
  "log out everywhere" after a password change is one command.
- **Notification templates** are files in
  `booking-app/packages/notification-templates/src/<locale>/`. They are code:
  reviewed, diffed, type-checked against their data contract, and snapshot
  tested. A database template table would make copy changes un-reviewable and
  un-rollbackable.

---

#### 1. `Organization`

The tenant root. Exactly one row exists in Phase 1, created by the seed.

- **Fields**: `id`, `slug String @unique`, `name`, `legalName`,
  `contactEmail`, `contactPhone`, `whatsappNumber String?`,
  `addressLine1`, `addressLine2 String?`, `postalCode`, `city`, `country @default("DE")`,
  `timezone String @default("Europe/Berlin")`, `currency String @default("EUR")`,
  `defaultLocale Locale @default(de)`, `stripeAccountId String?`,
  `createdAt`, `updatedAt`.
- **Relations**: has one `OrganizationSettings`; has many of everything else.
- **Indexes**: unique `slug`.
- **Deletion**: never. There is no delete endpoint.
- **Notes**: `stripeAccountId` is `null` for the whole of Phase 1. It exists so
  the Connect migration is a backfill rather than a schema change, and the
  payment provider already reads it through `PaymentAccountContext` (§2.2, §12).

#### 2. `OrganizationSettings`

Every configurable policy, in one row, so the office UI edits one form and the
domain reads one object.

- **Fields**: `id`, `organizationId String @unique`,
  `schedulingIntervalMinutes Int @default(15)`,
  `bookingHorizonDays Int @default(180)`,
  `minimumNoticeHours Int @default(24)`,
  `reservationTtlMinutes Int @default(5)`,
  `freeCancellationHours Int @default(72)`,
  `cancellationFeePolicy CancellationFeePolicy @default(NONE)`,
  `cancellationFeeAmountCents Int @default(0)`,
  `cancellationFeePercent Int @default(0)`,
  `reminderOffsetsMinutes Int[] @default([1440])`,
  `smsRemindersEnabled Boolean @default(false)`,
  `customerNoteEnabled Boolean @default(true)`,
  `dataRetentionDays Int @default(1095)`,
  `officeNotificationEmail String`,
  `createdAt`, `updatedAt`.
- **Relations**: belongs to `Organization` (`onDelete: Cascade`).
- **Indexes**: unique `organizationId` (one settings row per organization).
- **Validation** (enforced in the Zod schema *and* by a database `CHECK` added in
  Task 1.3): `schedulingIntervalMinutes` ∈ {5, 10, 15, 20, 30, 60};
  `bookingHorizonDays` between 1 and 365; `minimumNoticeHours` between 0 and 720;
  `reservationTtlMinutes` between 3 and 30; `freeCancellationHours` between 0
  and 720; `cancellationFeePercent` between 0 and 100;
  `cancellationFeeAmountCents >= 0`; `dataRetentionDays` between 30 and 3650.
- **Deletion**: cascade with the organization only.

#### 3. `ClosedDay`

Organization-wide closures — public holidays, company holidays. Removes the day
for every employee at once, which is what an office actually wants.

- **Fields**: `id`, `organizationId`, `date DateTime @db.Date`,
  `reason String?`, `createdAt`, `updatedAt`.
- **Indexes**: `@@unique([organizationId, date])` (the backing unique index also
  serves lookups by organization and date).
- **Deletion**: hard delete. It is configuration, not history; a booking that
  already exists on a newly closed day is surfaced as a conflict in the office UI
  rather than being altered (Task 8.4).

#### 4. `OfficeUser`

A person who logs into the office area.

- **Fields**: `id`, `organizationId`, `email String`, `passwordHash String`,
  `firstName`, `lastName`, `role OfficeUserRole`,
  `canIssueRefunds Boolean @default(false)`,
  `employeeId String? @unique`, `lastLoginAt DateTime?`,
  `failedLoginAttempts Int @default(0)`, `lockedUntil DateTime?`,
  `archivedAt DateTime?`, `createdAt`, `updatedAt`.
- **Relations**: optional one-to-one with `Employee` (an `EMPLOYEE`-role user is
  linked to the employee whose calendar they may see); has many
  `PasswordResetToken`, `AuditLog`, `Refund` (as issuer),
  `ManualPayment` (as recorder), `CancellationRequest`/`RescheduleRequest` (as
  decider).
- **Indexes**: `@@unique([organizationId, email])`,
  `@@index([organizationId, role])`, `@@index([organizationId, archivedAt])`.
- **Deletion**: archive. Money rows and audit rows reference the user forever.
  Archiving revokes every Redis session for that user in the same operation.
- **Notes**: `passwordHash` is argon2id. `canIssueRefunds` is an independent
  capability rather than a role, because "an admin who may not move money" is a
  real requirement and encoding it as a fourth role would multiply the role
  matrix. `OWNER` implicitly has it; the guard checks
  `role === 'OWNER' || canIssueRefunds`.

#### 5. `PasswordResetToken`

- **Fields**: `id`, `organizationId`, `officeUserId`, `tokenHash String @unique`,
  `expiresAt`, `usedAt DateTime?`, `createdAt`.
- **Indexes**: unique `tokenHash`, `@@index([officeUserId, usedAt])`,
  `@@index([expiresAt])`.
- **Deletion**: cascade with the user; expired and used rows are swept nightly.
- **Notes**: only the SHA-256 hash of the token is stored, so a database dump
  cannot be used to reset passwords. Single use — `usedAt` is set inside the same
  transaction that writes the new password hash. 60-minute lifetime.

#### 6. `Employee`

A person who performs services. Separate from `OfficeUser` because most
employees never log in, and one login can exist without a calendar.

- **Fields**: `id`, `organizationId`, `firstName`, `lastName`,
  `displayName String`, `email String?`, `phone String?`, `bio String?`,
  `photoUrl String?`, `displayOrder Int @default(0)`,
  `isBookableOnline Boolean @default(true)`, `archivedAt DateTime?`,
  `createdAt`, `updatedAt`.
- **Relations**: optional one-to-one `OfficeUser`; has many `WorkingHours`,
  `AvailabilityException`, `TimeOff`, `BlockedTime`, `EmployeeService`,
  `Booking`.
- **Indexes**: `@@unique([organizationId, id])` (composite Booking FK target),
  `@@index([organizationId, archivedAt, displayOrder])`,
  `@@index([organizationId, isBookableOnline])`.
- **Deletion**: archive. Bookings reference the employee permanently; archiving
  is refused if the employee has any booking in a blocking status in the future,
  with a message naming the count, so the office reassigns first.
- **Notes**: `displayOrder` is the second tie-breaker in the "any available
  employee" strategy (§6.3), so it is not merely cosmetic.

#### 7. `WorkingHours`

Recurring weekly availability. One row per weekday segment, so split shifts are
two rows rather than a nullable "afternoon" pair of columns.

- **Fields**: `id`, `organizationId`, `employeeId`, `weekday Weekday`,
  `startMinute Int`, `endMinute Int`, `createdAt`, `updatedAt`.
- **Indexes**: `@@index([organizationId, employeeId, weekday])`.
- **Deletion**: cascade with the employee; replaced wholesale when the office
  saves an employee's schedule (delete-then-insert inside one transaction).
- **Notes**: minutes from local midnight, `0 <= startMinute < endMinute <= 1440`
  enforced by a `CHECK`. Minutes-from-midnight rather than a time column because
  every consumer is arithmetic on a local wall clock, and `1440` is the only
  honest way to express "until midnight". Overlapping segments for the same
  employee and weekday are rejected in the service layer (Task 8.4) since a
  weekday-relative range is not something a Postgres exclusion constraint can
  express.

#### 8. `Break`

An unavailable window inside working hours — lunch, cleaning.

- **Fields**: `id`, `organizationId`, `workingHoursId`, `startMinute Int`,
  `endMinute Int`, `label String?`, `createdAt`, `updatedAt`.
- **Relations**: belongs to `WorkingHours` (`onDelete: Cascade`).
- **Indexes**: `@@index([workingHoursId])`.
- **Deletion**: cascade with its working-hours segment.
- **Notes**: attached to the segment rather than to the employee so a break
  cannot outlive the shift that contains it. A `CHECK` enforces the same minute
  bounds; containment inside the parent segment is validated in the service.

#### 9. `AvailabilityException`

A one-off override for a specific date: extra hours on a normally closed day, or
a closure on a normally open one.

- **Fields**: `id`, `organizationId`, `employeeId`, `date DateTime @db.Date`,
  `kind AvailabilityExceptionKind`, `startMinute Int?`, `endMinute Int?`,
  `reason String?`, `createdAt`, `updatedAt`.
- **Indexes**: `@@index([organizationId, employeeId, date])`.
- **Deletion**: hard delete (configuration).
- **Notes**: `kind = CLOSED` requires both minute columns to be `null` and
  removes the whole day; `kind = EXTRA_HOURS` requires both to be set and
  **replaces** the day's recurring hours rather than adding to them. That is the
  less surprising semantics: an office setting special Saturday hours means
  "these hours", not "these plus the usual". A `CHECK` enforces the null pattern
  so the engine never sees a half-specified exception.

#### 10. `TimeOff`

A multi-day absence.

- **Fields**: `id`, `organizationId`, `employeeId`, `startDate DateTime @db.Date`,
  `endDate DateTime @db.Date`, `status TimeOffStatus @default(APPROVED)`,
  `reason String?`, `decidedByOfficeUserId String?`, `decidedAt DateTime?`,
  `createdAt`, `updatedAt`.
- **Indexes**: `@@index([organizationId, employeeId, startDate, endDate])`,
  `@@index([organizationId, status])`.
- **Deletion**: hard delete while `REQUESTED`; approved rows are archived by
  setting `status = REJECTED` with a decision trail rather than deleted, so the
  audit record survives.
- **Notes**: inclusive date range in local time — `endDate` is a day the employee
  is away. The engine converts to the instant range
  `[startDate 00:00 Europe/Berlin, endDate+1 00:00 Europe/Berlin)`. Only
  `APPROVED` rows block availability. Creating or approving time off takes the
  per-employee advisory lock and refuses if a blocking booking already exists in
  the range, naming the conflicting bookings (Task 8.4).

#### 11. `BlockedTime`

An ad-hoc block on one employee's calendar — a meeting, a training, an equipment
failure. The instant-range sibling of `Booking` and the reason a cross-table
exclusion constraint is impossible (§8.2).

- **Fields**: `id`, `organizationId`, `employeeId`, `startsAt DateTime @db.Timestamptz(3)`,
  `endsAt DateTime @db.Timestamptz(3)`, `reason String?`,
  `createdByOfficeUserId String`, `createdAt`, `updatedAt`.
- **Indexes**: `@@index([organizationId, employeeId, startsAt])`; plus the
  `blocked_times_no_overlap` exclusion constraint and the
  `blocked_times_range_check` `CHECK` added in Task 1.3.
- **Deletion**: hard delete. It is not history and it holds no money.
- **Notes**: all four of `organizationId`, `employeeId`, `startsAt`, `endsAt` are
  `NOT NULL`, for the same range-integrity reasons as `Booking` (§8.2).

#### 12. `ServiceCategory`

Grouping for the public service list.

- **Fields**: `id`, `organizationId`, `name`, `description String?`,
  `displayOrder Int @default(0)`, `archivedAt DateTime?`, `createdAt`,
  `updatedAt`.
- **Indexes**: `@@unique([organizationId, id])` (composite Booking FK target),
  `@@unique([organizationId, name])`,
  `@@index([organizationId, archivedAt, displayOrder])`.
- **Deletion**: archive; refused while a non-archived `Service` still points at
  it.

#### 13. `Service`

A bookable treatment. Its duration and price are **snapshotted onto the booking**
at reservation time, so editing a service never rewrites history.

- **Fields**: `id`, `organizationId`, `serviceCategoryId String?`, `name`,
  `description String?`, `durationMinutes Int`,
  `prepBufferMinutes Int @default(0)`, `cleanupBufferMinutes Int @default(0)`,
  `priceCents Int`, `currency String @default("EUR")`,
  `isBookableOnline Boolean @default(true)`, `displayOrder Int @default(0)`,
  `archivedAt DateTime?`, `createdAt`, `updatedAt`.
- **Relations**: optional `ServiceCategory` (`onDelete: SetNull`); has many
  `EmployeeService`, `Booking` (`onDelete: Restrict`).
- **Indexes**: `@@unique([organizationId, name])`,
  `@@index([organizationId, archivedAt, displayOrder])`,
  `@@index([organizationId, isBookableOnline])`.
- **Deletion**: archive, and only archive — `Booking.serviceId` is
  `onDelete: Restrict`.
- **Notes**: `CHECK` constraints enforce `durationMinutes` between 5 and 480,
  buffers between 0 and 120, and `priceCents >= 0`. Buffers are the employee's
  time but not the customer's: they extend `blockStartsAt`/`blockEndsAt` while
  `startsAt`/`endsAt` remain what the customer is told (§4.3 `Booking`, §6.1).
  Seed data: "Facial Massage 30 min" and "Regular Massage 60 min".

#### 14. `EmployeeService`

Which employee performs which service, with an optional per-employee price
override.

- **Fields**: `id`, `organizationId`, `employeeId`, `serviceId`,
  `priceOverrideCents Int?`, `createdAt`, `updatedAt`.
- **Indexes**: `@@unique([employeeId, serviceId])`,
  `@@index([organizationId, serviceId])`.
- **Deletion**: cascade from either side (the pairing has no independent
  meaning); removal is refused while a future blocking booking pairs that
  employee with that service.
- **Notes**: the join is explicit rather than an implicit many-to-many precisely
  so the override column has somewhere to live. Effective price is
  `priceOverrideCents ?? service.priceCents`, computed in one place
  (`resolveEffectivePrice`, Task 2.4) and used by both the public quote and the
  Checkout line item, so the displayed price and the charged price cannot drift.
  Both the application contract and a database `CHECK` require a non-null
  `priceOverrideCents` to be greater than or equal to zero.

#### 15. `Customer`

A person who books. Created on first booking, then matched by normalised email.

- **Fields**: `id`, `organizationId`, `email String`, `emailNormalized String`,
  `firstName`, `lastName`, `phone String?`, `locale Locale @default(de)`,
  `marketingConsentAt DateTime?`, `internalNote String?`,
  `archivedAt DateTime?`, `createdAt`, `updatedAt`.
- **Relations**: has many `Booking` (`onDelete: Restrict`).
- **Indexes**: `@@unique([organizationId, id])` (composite Booking FK target),
  `@@unique([organizationId, emailNormalized])`,
  `@@index([organizationId, lastName, firstName])`, `@@index([organizationId, phone])`.
- **Deletion**: archive plus pseudonymisation on an erasure request — email,
  names, and phone are overwritten with `deleted-<id>@invalid` and empty strings
  while bookings and money rows keep their ids. Hard deletion is impossible while
  a `Payment` exists, which is the correct outcome for tax-retention duties.
- **Notes**: `emailNormalized` is lowercased and trimmed and is the uniqueness
  key; `email` preserves what the customer typed for display. `internalNote` is
  office-authored and never shown to the customer. The customer-authored note
  lives on `Booking` because it is per-appointment. `locale` is captured in the
  booking flow and decides notification language.

#### 16. `Booking`

The centre of the system, and simultaneously the reservation. A row in
`PENDING_PAYMENT` or `EXPIRING` is an unpaid hold; a row in `CONFIRMED` is a real
appointment. One row, one exclusion constraint.

- **Fields**:
  - identity: `id`, `organizationId`, `reference String` (human-quotable, e.g.
    `SF-7K3QD2`), `origin BookingOrigin`
  - who and what: `customerId`, `employeeId`, `serviceId`
  - customer-visible time: `startsAt DateTime @db.Timestamptz(3)`,
    `endsAt DateTime @db.Timestamptz(3)`
  - resource-blocking time: `blockStartsAt DateTime @db.Timestamptz(3)`,
    `blockEndsAt DateTime @db.Timestamptz(3)`
  - snapshot: `serviceNameSnapshot String`, `durationMinutesSnapshot Int`,
    `prepBufferMinutesSnapshot Int`, `cleanupBufferMinutesSnapshot Int`,
    `priceCentsSnapshot Int`, `currency String`
  - state: `status BookingStatus`, `expiresAt DateTime?`,
    `confirmedAt DateTime?`, `canceledAt DateTime?`, `completedAt DateTime?`
  - payment link: `stripeCheckoutSessionId String? @unique`,
    `idempotencyKeyId String? @unique`
  - customer input: `customerNote String?`, `locale Locale`
  - reschedule lineage: `rescheduledFromBookingId String?`
  - audit: `createdByOfficeUserId String?`, `canceledByOfficeUserId String?`,
    `cancellationReason String?`, `createdAt`, `updatedAt`
- **Relations**: `Customer`, `Employee`, `Service`, and the reschedule
  self-relation all use composite `(organizationId, id)` foreign keys, so a
  booking cannot point at another tenant's row; all are `onDelete: Restrict`;
  has many `BookingStatusHistory`, `Payment`, `ManualPayment`, `Notification`,
  `ManagementToken`; has at most one open `CancellationRequest` and one open
  `RescheduleRequest`; self-relation for reschedule lineage.
- **Indexes**:
  - `@@unique([organizationId, id])` — composite self-FK target
  - `@@unique([organizationId, reference])`
  - `@@unique([organizationId, rescheduledFromBookingId])`
  - `@@index([organizationId, employeeId, blockStartsAt])` — calendar reads
  - `@@index([organizationId, status, startsAt])` — dashboard and day views
  - `@@index([organizationId, customerId, startsAt])` — customer history
  - `@@index([status, expiresAt])` — the expiry sweeper's only scan
  - `@@index([organizationId, status, blockStartsAt, blockEndsAt])` — availability snapshot loads
  - unique `stripeCheckoutSessionId`, unique `idempotencyKeyId`
  - plus `bookings_block_range_check` and `bookings_no_overlap` from Task 1.3
- **Deletion**: **never**. Not archived either — the status enum already carries
  every terminal outcome, and money rows are `Restrict`-attached. There is no
  delete endpoint and no delete call in any service.
- **Notes**:
  - `NOT NULL` on `organizationId`, `employeeId`, `blockStartsAt`, `blockEndsAt`
    is a hard requirement of the exclusion constraint (§8.2). "Any available
    employee" is resolved to a concrete employee **before** the insert, so no row
    ever exists without a resource.
  - `blockStartsAt = startsAt - prepBufferMinutesSnapshot` and
    `blockEndsAt = endsAt + cleanupBufferMinutesSnapshot`. Both are stored rather
    than computed so the exclusion constraint and every index can use them
    directly.
  - Snapshot columns exist so that changing a service's price or duration never
    alters an existing booking, an invoice, or a refund calculation.
  - `expiresAt` is required while `status` is `PENDING_PAYMENT` or `EXPIRING`,
    enforced by a `CHECK`, and retained after confirmation or expiration as an
    audit timestamp.
  - `reference` is generated from a Crockford base-32 alphabet with the ambiguous
    characters removed, six characters after the `SF-` prefix, retried on unique
    violation. It is for humans on the phone; it is **not** an authentication
    factor — `/manage` requires the `ManagementToken`.

#### 17. `BookingStatusHistory`

Append-only transition log. Every status change writes one row in the same
transaction as the change.

- **Fields**: `id`, `organizationId`, `bookingId`,
  `fromStatus BookingStatus?`, `toStatus BookingStatus`,
  `actorType String` (`CUSTOMER` | `OFFICE_USER` | `SYSTEM` | `WEBHOOK`),
  `actorOfficeUserId String?`, `reason String?`, `metadata Json?`,
  `createdAt`.
- **Indexes**: `@@index([bookingId, createdAt])`,
  `@@index([organizationId, createdAt])`.
- **Deletion**: cascade with the booking, which never happens. Effectively
  permanent.
- **Notes**: `fromStatus` is null only for the creating transition.
  `metadata` carries the Stripe event id, the job id, or the sweeper run id that
  caused the change, which is what makes a production incident reconstructable.

#### 18. `ManagementToken`

Grants a customer access to `/manage` for one booking without an account.

- **Fields**: `id`, `organizationId`, `bookingId`, `tokenHash String @unique`,
  `expiresAt`, `revokedAt DateTime?`, `lastUsedAt DateTime?`, `createdAt`,
  `updatedAt`.
- **Indexes**: unique `tokenHash`, `@@index([bookingId, revokedAt])`,
  `@@index([expiresAt])`.
- **Deletion**: cascade with the booking; revoked and expired rows are swept 30
  days after expiry.
- **Notes**: 256 bits of `randomBytes(32)`, base64url-encoded, delivered only in
  a URL **fragment** (`/manage#<token>`), and only the SHA-256 hash is stored.
  Rotated on reschedule so an old confirmation email cannot manage the new
  appointment. Expires 14 days after `endsAt`. Lookup is by hash with a
  constant-time comparison and is rate-limited per IP.

#### 19. `Payment`

A Stripe payment against a booking.

- **Fields**: `id`, `organizationId`, `bookingId`,
  `stripePaymentIntentId String? @unique`,
  `stripeCheckoutSessionId String? @unique`,
  `stripeChargeId String? @unique`, `amountCents Int`, `currency String`,
  `status PaymentStatus`, `paymentMethodType String?`,
  `refundedAmountCents Int @default(0)`,
  `failureCode String?`, `failureMessage String?`,
  `paidAt DateTime?`, `createdAt`, `updatedAt`.
- **Relations**: belongs to `Booking` (`onDelete: Restrict`); has many `Refund`.
- **Indexes**: the three unique Stripe ids, `@@index([organizationId, status])`,
  `@@index([bookingId])`, `@@index([organizationId, paidAt])`.
- **Deletion**: never, by any path.
- **Notes**: **no card data is stored** — no PAN, no expiry, no CVC, no
  cardholder name. `paymentMethodType` is Stripe's coarse label (`card`,
  `link`, `paypal`) and is display-only. `refundedAmountCents` is denormalised
  from the `Refund` rows so a partially refunded payment is one read; it is only
  ever written in the same transaction that writes or updates a `Refund`, and an
  integration test asserts it equals the sum of `SUCCEEDED` refunds.

#### 20. `ManualPayment`

Money taken outside Stripe, recorded by an office user. Never a synthetic Stripe
object.

- **Fields**: `id`, `organizationId`, `bookingId`, `amountCents Int`,
  `currency String`, `method ManualPaymentMethod`, `paidAt DateTime`,
  `recordedByOfficeUserId String`, `note String?`, `createdAt`, `updatedAt`.
- **Indexes**: `@@index([bookingId])`, `@@index([organizationId, paidAt])`.
- **Deletion**: never. A mistake is corrected by a compensating row with a
  negative `amountCents` and a mandatory `note`, which keeps the ledger
  append-only; `CHECK (amount_cents <> 0)` is the only amount constraint.
- **Notes**: guarded by the same idempotency mechanism as refunds so a
  double-clicked "record payment" button cannot double-count cash.

#### 21. `Refund`

- **Fields**: `id`, `organizationId`, `bookingId`, `paymentId`,
  `stripeRefundId String? @unique`, `amountCents Int`, `currency String`,
  `status RefundStatus`, `reason RefundReason`,
  `idempotencyKey String @unique`,
  `issuedByOfficeUserId String?`, `failureReason String?`,
  `requestedAt DateTime @default(now())`, `settledAt DateTime?`,
  `createdAt`, `updatedAt`.
- **Relations**: belongs to `Booking` and `Payment`, both `onDelete: Restrict`.
- **Indexes**: unique `stripeRefundId`, unique `idempotencyKey`,
  `@@index([organizationId, status])`, `@@index([paymentId])`.
- **Deletion**: never.
- **Notes**: the row is created `PENDING` **before** the Stripe API call, and
  `idempotencyKey` is passed to Stripe as its idempotency key. Because the column
  is unique, a BullMQ retry of the same refund job cannot create a second refund
  even if the first attempt's response was lost. `issuedByOfficeUserId` is null
  only for automatic refunds on a free cancellation. `CHECK (amount_cents > 0)`.

#### 22. `CancellationRequest`

A customer cancelling inside the free-cancellation window needs no request; one
inside it does. This is the row that makes `CANCELLATION_REQUESTED` a *derived*
display status rather than a persisted booking status (§5.1).

- **Fields**: `id`, `organizationId`, `bookingId`, `reason String?`,
  `requestedAt DateTime @default(now())`,
  `decision RequestDecision @default(PENDING)`,
  `decidedByOfficeUserId String?`, `decidedAt DateTime?`,
  `decisionNote String?`,
  `suggestedRetainedAmountCents Int`, `retainedAmountCents Int?`,
  `refundId String? @unique`, `createdAt`, `updatedAt`.
- **Indexes**: `@@unique([bookingId, decision])` **is deliberately not used**;
  instead a partial unique index created in Task 1.3 enforces at most one
  `PENDING` request per booking:
  `CREATE UNIQUE INDEX cancellation_requests_one_open ON cancellation_requests (booking_id) WHERE decision = 'PENDING';`
  plus `@@index([organizationId, decision, requestedAt])`.
- **Deletion**: never (it is a decision record).
- **Notes**: `suggestedRetainedAmountCents` is computed from
  `OrganizationSettings` at request time and frozen, so a later policy change
  cannot silently alter what the office was shown. It is a **suggestion**: the
  decider may enter any `retainedAmountCents` between 0 and the paid amount, and
  both numbers are kept so the deviation is auditable.

#### 23. `RescheduleRequest`

- **Fields**: `id`, `organizationId`, `bookingId`,
  `requestedStartsAt DateTime @db.Timestamptz(3)`,
  `requestedEmployeeId String?`, `reason String?`,
  `requestedAt DateTime @default(now())`,
  `decision RequestDecision @default(PENDING)`,
  `decidedByOfficeUserId String?`, `decidedAt DateTime?`,
  `decisionNote String?`, `resultingBookingId String? @unique`,
  `createdAt`, `updatedAt`.
- **Indexes**: partial unique index
  `reschedule_requests_one_open ON reschedule_requests (booking_id) WHERE decision = 'PENDING'`,
  plus `@@index([organizationId, decision, requestedAt])`.
- **Deletion**: never.
- **Notes**: approval creates a **new** `Booking` linked by
  `rescheduledFromBookingId` and moves the old one to `CANCELED_BY_BUSINESS`
  with reason `RESCHEDULED`, inside one transaction holding the advisory lock for
  both employees. A new booking rather than an in-place time change keeps the
  exclusion constraint honest during the move, preserves the original as history,
  and lets the payment stay attached to the original while the new booking
  inherits it through the lineage link. `requestedEmployeeId` is null when the
  customer is happy to keep the same employee.

#### 24. `Notification`

One row per delivery attempt target, created `PENDING` before anything is sent.

- **Fields**: `id`, `organizationId`, `bookingId String?`,
  `customerId String?`, `officeUserId String?`,
  `kind NotificationKind`, `channel NotificationChannel`, `locale Locale`,
  `recipient String`, `subject String?`,
  `status NotificationStatus @default(PENDING)`,
  `providerMessageId String? @unique`, `attempts Int @default(0)`,
  `lastError String?`, `sentAt DateTime?`, `deliveredAt DateTime?`,
  `failedAt DateTime?`, `dedupeKey String @unique`,
  `scheduledFor DateTime?`, `createdAt`, `updatedAt`.
- **Indexes**: unique `dedupeKey`, unique `providerMessageId`,
  `@@index([organizationId, status, createdAt])`, `@@index([bookingId])`,
  `@@index([status, scheduledFor])`.
- **Deletion**: swept after `dataRetentionDays`; `recipient` and `subject` are
  redacted in place at 90 days, keeping the delivery statistics.
- **Notes**: `dedupeKey` is the deterministic string
  `<kind>:<channel>:<bookingId>:<discriminator>` (the discriminator being the
  booking's `startsAt` epoch seconds for reminders, the request id for decisions,
  `-` otherwise). A unique violation on insert means "already queued" and is
  swallowed, which is how at-least-once outbox delivery becomes
  effectively-once notification.

#### 25. `OutboxEvent`

The transactional outbox. Written in the same transaction as the state change it
describes; drained by the worker.

- **Fields**: `id`, `organizationId`, `aggregateType String`,
  `aggregateId String`, `eventType String`, `payload Json`,
  `encryptedSensitivePayload Bytes?`,
  `availableAt DateTime @default(now())`, `dispatchedAt DateTime?`,
  `attempts Int @default(0)`, `lastError String?`, `createdAt`.
- **Indexes**: `@@index([dispatchedAt, availableAt])` — the dispatcher's claim
  query; `@@index([aggregateType, aggregateId])` — debugging a single booking.
- **Deletion**: dispatched rows older than 14 days are swept nightly. Retained
  that long on purpose: it is the audit trail for "was the confirmation email
  ever queued?".
- **Notes**: `availableAt` supports delayed events without a second mechanism.
  `payload` must never contain credentials or bearer tokens. Rare sensitive
  delivery data is encrypted with AES-256-GCM under a dedicated, rotated
  environment key; the byte envelope contains its version, nonce, auth tag, and
  ciphertext. Workers decrypt only immediately before provider delivery, never
  log the plaintext, and the 14-day outbox sweep removes the ciphertext.
  `payload` is validated against a Zod schema per `eventType` on the way out, so
  a malformed payload fails at the dispatcher with a named event type rather than
  deep inside a processor.

#### 26. `IdempotencyKey`

Client-supplied key that makes a booking attempt or a money movement safely
retryable.

- **Fields**: `id`, `key String @unique`, `organizationId String?`,
  `scope String`, `requestHash String`, `responseSnapshot Json?`,
  `statusCode Int?`, `bookingId String?`,
  `state String @default("IN_PROGRESS")` (`IN_PROGRESS` | `COMPLETED`),
  `createdAt`, `expiresAt`.
- **Indexes**: unique `key`, `@@index([expiresAt])`, `@@index([bookingId])`.
- **Deletion**: swept after `expiresAt` (24 hours).
- **Notes**: `organizationId` is nullable because the row is inserted before the
  request body has been fully resolved; it is backfilled on completion.
  `scope` (`booking.create`, `refund.create`, `manual-payment.create`) prevents a
  key minted for one operation from replaying another. `requestHash` is a SHA-256
  of the canonicalised request body. `state = IN_PROGRESS` with no snapshot means
  a concurrent duplicate is still running → `409 IDEMPOTENT_REQUEST_IN_PROGRESS`.

#### 27. `StripeWebhookEvent`

The inbox for Stripe. Inserted before any processing, which is what makes
duplicate deliveries free and a crash recoverable.

- **Fields**: `id`, `stripeEventId String @unique`, `organizationId String?`,
  `type String`, `apiVersion String?`, `payload Json`,
  `receivedAt DateTime @default(now())`, `processedAt DateTime?`,
  `attempts Int @default(0)`, `lastError String?`, `createdAt`, `updatedAt`.
- **Indexes**: unique `stripeEventId`, `@@index([processedAt, receivedAt])`,
  `@@index([type, receivedAt])`.
- **Deletion**: swept after 90 days.
- **Notes**: `organizationId` is nullable and backfilled once the event is
  correlated to a local `Payment` or `Booking`. Correlation is **always** through
  a locally-stored id (`stripeCheckoutSessionId`, `stripePaymentIntentId`,
  `stripeChargeId`); provider metadata is never trusted as the tenant source
  (§10.1).

#### 28. `MessagingWebhookEvent`

The same inbox pattern for Resend and Twilio delivery-status callbacks.

- **Fields**: `id`, `provider WebhookProvider`, `providerEventId String`,
  `organizationId String?`, `type String`, `payload Json`,
  `receivedAt DateTime @default(now())`, `processedAt DateTime?`,
  `attempts Int @default(0)`, `lastError String?`, `createdAt`, `updatedAt`.
- **Indexes**: `@@unique([provider, providerEventId])`,
  `@@index([processedAt, receivedAt])`.
- **Deletion**: swept after 30 days.
- **Notes**: a composite unique rather than a global one, because two providers
  can legitimately mint the same id string.

#### 29. `AuditLog`

Append-only record of consequential office actions that are not already captured
by `BookingStatusHistory`.

- **Fields**: `id`, `organizationId`, `officeUserId String?`,
  `action AuditAction`, `entityType String`, `entityId String`,
  `summary String`, `before Json?`, `after Json?`,
  `correlationId String?`, `ipAddress String?`, `createdAt`.
- **Indexes**: `@@index([organizationId, createdAt])`,
  `@@index([entityType, entityId])`, `@@index([organizationId, officeUserId, createdAt])`.
- **Deletion**: never inside the retention window; swept after
  `dataRetentionDays`.
- **Notes**: `before`/`after` store only changed fields and are passed through
  the same redaction list as the logger, so an audit row cannot become a
  side-channel for personal data. Written by an interceptor on mutating `/office`
  routes plus explicit calls from the money services.

### 4.4 Ownership and index summary

| Model | `organizationId` | Deletion | Leading composite index |
| --- | --- | --- | --- |
| `Organization` | n/a (is the root) | never | `slug` unique |
| `OrganizationSettings` | required, unique | cascade | `organizationId` unique |
| `ClosedDay` | required | hard | `(organizationId, date)` |
| `OfficeUser` | required | archive | `(organizationId, email)` unique |
| `PasswordResetToken` | required | cascade + sweep | `tokenHash` unique |
| `Employee` | required | archive | `(organizationId, archivedAt, displayOrder)` |
| `WorkingHours` | required | cascade | `(organizationId, employeeId, weekday)` |
| `Break` | required | cascade | `(workingHoursId)` |
| `AvailabilityException` | required | hard | `(organizationId, employeeId, date)` |
| `TimeOff` | required | hard while `REQUESTED` | `(organizationId, employeeId, startDate, endDate)` |
| `BlockedTime` | required | hard | `(organizationId, employeeId, startsAt)` + EXCLUDE |
| `ServiceCategory` | required | archive | `(organizationId, name)` unique |
| `Service` | required | archive | `(organizationId, name)` unique |
| `EmployeeService` | required | cascade | `(employeeId, serviceId)` unique |
| `Customer` | required | archive + pseudonymise | `(organizationId, emailNormalized)` unique |
| `Booking` | required | never | `(organizationId, employeeId, blockStartsAt)` + EXCLUDE |
| `BookingStatusHistory` | required | never | `(bookingId, createdAt)` |
| `ManagementToken` | required | cascade + sweep | `tokenHash` unique |
| `Payment` | required | never | `stripePaymentIntentId` unique |
| `ManualPayment` | required | never | `(bookingId)` |
| `Refund` | required | never | `idempotencyKey` unique |
| `CancellationRequest` | required | never | partial unique on open request |
| `RescheduleRequest` | required | never | partial unique on open request |
| `Notification` | required | sweep + redact | `dedupeKey` unique |
| `OutboxEvent` | required | sweep | `(dispatchedAt, availableAt)` |
| `IdempotencyKey` | optional | sweep | `key` unique |
| `StripeWebhookEvent` | optional | sweep | `stripeEventId` unique |
| `MessagingWebhookEvent` | optional | sweep | `(provider, providerEventId)` unique |
| `AuditLog` | required | sweep at retention | `(organizationId, createdAt)` |
---

## 5. State machines

### 5.1 `Booking`

```
                              ┌──────────────────┐
      reserve (online)  ──────►│ PENDING_PAYMENT  │
                              └───┬─────┬────┬───┘
             checkout.session.completed │     │    │ checkout.session.expired
             (payment_status=paid)      │     │    │  or async_payment_failed
                                        │     │    ▼
                     sweeper: expiresAt │     │  ┌────────────────┐
                             < now()    │     │  │ PAYMENT_FAILED │ (terminal)
                                        │     │  └────────────────┘
                                        │     ▼
                                        │  ┌───────────┐   Stripe: session expired
                                        │  │ EXPIRING  │──────────────────────────► ┌─────────┐
                                        │  └─────┬─────┘                            │ EXPIRED │
                                        │        │ Stripe: session already complete  └─────────┘
                                        ▼        ▼                                    (terminal)
                                   ┌─────────────────┐
      create (office, manual) ────►│    CONFIRMED    │
                                   └──┬───┬───┬───┬──┘
                                      │   │   │   │
        ┌─────────────────────────────┘   │   │   └──────────────────────────┐
        ▼                                 ▼   ▼                              ▼
┌────────────────────────┐  ┌────────────────────────┐  ┌───────────┐  ┌──────────┐
│ CANCELED_BY_CUSTOMER   │  │ CANCELED_BY_BUSINESS   │  │ COMPLETED │  │ NO_SHOW  │
└────────────────────────┘  └────────────────────────┘  └───────────┘  └──────────┘
         (terminal)                  (terminal)           (terminal)     (terminal)
```

**Blocking set** — the statuses that occupy an employee and are therefore listed
in the `bookings_no_overlap` exclusion-constraint predicate:
`PENDING_PAYMENT`, `EXPIRING`, `CONFIRMED`. This one list appears in exactly
three places (the constraint SQL, the `BLOCKING_BOOKING_STATUSES` constant in
`booking-app/apps/api/src/booking/booking-status.machine.ts`, and the
availability snapshot query), and Task 1.3 includes a test that asserts the
constant and the constraint predicate agree.

| From | To | Trigger | Guard | Same-transaction side effects |
| --- | --- | --- | --- | --- |
| — | `PENDING_PAYMENT` | `POST /public/bookings` | slot free under advisory lock; exclusion constraint holds | history row; `IdempotencyKey` linked; `expiresAt = now + reservationTtlMinutes` |
| — | `CONFIRMED` | `POST /office/bookings` | slot free under advisory lock | history row; `AuditLog`; outbox `booking.confirmed` |
| `PENDING_PAYMENT` | `CONFIRMED` | `checkout.session.completed` with `payment_status = 'paid'`, or `async_payment_succeeded` | booking row locked `FOR UPDATE`; not already terminal | `Payment` upsert `SUCCEEDED`; retain `expiresAt`; set `confirmedAt`; `ManagementToken`; history; outbox `booking.confirmed` |
| `PENDING_PAYMENT` | `PAYMENT_FAILED` | `checkout.session.expired` (customer abandoned before the sweeper ran) or `async_payment_failed` | booking row locked `FOR UPDATE` | `Payment` `FAILED` if one exists; retain `expiresAt`; history; outbox `booking.payment_failed` |
| `PENDING_PAYMENT` | `EXPIRING` | expiry sweeper or per-booking timer | `expiresAt < now()` re-checked inside the transaction | history; outbox `booking.expiry_requested` |
| `EXPIRING` | `EXPIRED` | expiry job, after Stripe confirms the session is expired | Stripe returned `status = 'expired'` | retain `expiresAt`; history; **slot released here and nowhere earlier** |
| `EXPIRING` | `CONFIRMED` | expiry job, when Stripe reports the session already completed | Stripe returned `status = 'complete'` and `payment_status = 'paid'` | identical effects to the webhook confirmation path, and idempotent with it |
| `CONFIRMED` | `CANCELED_BY_CUSTOMER` | `POST /manage/cancel` outside the fee window, or an approved `CancellationRequest` | `startsAt > now()` | `canceledAt`; history; `Refund` `PENDING` when a `Payment` exists; outbox `booking.canceled` |
| `CONFIRMED` | `CANCELED_BY_BUSINESS` | `POST /office/bookings/:id/cancel`, or reschedule approval | actor is `OWNER`/`ADMIN`; refund requires the refund capability | `canceledAt`; `canceledByOfficeUserId`; `cancellationReason`; history; `AuditLog`; optional `Refund`; outbox `booking.canceled` |
| `CONFIRMED` | `COMPLETED` | `POST /office/bookings/:id/complete` | `endsAt <= now()` | `completedAt`; history; `AuditLog` |
| `CONFIRMED` | `NO_SHOW` | `POST /office/bookings/:id/no-show` | `startsAt <= now()` | history; `AuditLog` |

**Terminal**: `EXPIRED`, `PAYMENT_FAILED`, `CANCELED_BY_CUSTOMER`,
`CANCELED_BY_BUSINESS`, `COMPLETED`, `NO_SHOW`. No transition leaves a terminal
status; `assertTransition(from, to)` throws `INVALID_STATUS_TRANSITION` and every
service calls it before writing.

**Derived display statuses.** `CANCELLATION_REQUESTED` and
`RESCHEDULE_REQUESTED` are **not** persisted enum members. They are computed for
display from the presence of a `PENDING` `CancellationRequest` or
`RescheduleRequest` while the booking itself remains `CONFIRMED`. Three reasons:

1. The original slot must keep blocking while a request is open. If the request
   moved the booking out of `CONFIRMED`, it would fall out of the blocking set and
   the slot would be offered to someone else while the office is still deciding.
2. The two conditions are orthogonal and can coexist — a customer can open a
   cancellation request while a reschedule request is pending — which a single
   status column cannot represent.
3. The exclusion-constraint predicate stays a list of genuine occupancy states
   instead of mixing in workflow states, so it never has to change when a
   workflow does.

The API therefore returns both `status` (the persisted enum) and
`displayStatus` (the enum widened with `CANCELLATION_REQUESTED` and
`RESCHEDULE_REQUESTED`), and the office UI renders `displayStatus`. Recorded as a
deviation in §11.3.

### 5.2 `Payment`

```
PENDING ──► SUCCEEDED ──► PARTIALLY_REFUNDED ──► REFUNDED
   │                              ▲                 ▲
   └──► FAILED                    └─────────────────┘
                            (refund settles; direction by amount)
```

| From | To | Trigger | Guard |
| --- | --- | --- | --- |
| — | `PENDING` | Checkout Session created | booking is `PENDING_PAYMENT` |
| `PENDING` | `SUCCEEDED` | `checkout.session.completed` (paid) or `async_payment_succeeded` | `paidAt` set from the event |
| `PENDING` | `FAILED` | `checkout.session.expired`, `async_payment_failed`, `payment_intent.payment_failed` | `failureCode` recorded |
| `SUCCEEDED` | `PARTIALLY_REFUNDED` | a `Refund` settles and `refundedAmountCents < amountCents` | sum of `SUCCEEDED` refunds |
| `SUCCEEDED` | `REFUNDED` | a `Refund` settles and `refundedAmountCents = amountCents` | sum of `SUCCEEDED` refunds |
| `PARTIALLY_REFUNDED` | `REFUNDED` | a further refund reaches the full amount | as above |

`FAILED` and `REFUNDED` are terminal for the payment; a `FAILED` payment is never
retried in place — the customer starts a new booking, which mints a new payment.

### 5.3 `Refund`

```
PENDING ──► SUCCEEDED
   │
   ├──► FAILED     (Stripe rejected it; office is alerted, row is kept)
   └──► CANCELED   (Stripe canceled a pending bank refund)
```

| From | To | Trigger |
| --- | --- | --- |
| — | `PENDING` | refund row written **before** the Stripe call, carrying its own `idempotencyKey` |
| `PENDING` | `SUCCEEDED` | Stripe API returned `succeeded`, or `charge.refunded` / `refund.updated` arrived |
| `PENDING` | `FAILED` | Stripe API returned `failed`, or `refund.failed` arrived |
| `PENDING` | `CANCELED` | `refund.updated` with `status = 'canceled'` |

Out-of-order safety: the webhook handler upserts by `stripeRefundId` **and** by
`idempotencyKey`, so `charge.refunded` arriving before the API response returns is
handled, and a later `refund.updated` cannot downgrade a settled refund — the
handler only applies a transition that `assertRefundTransition` permits and logs a
warning otherwise.

### 5.4 `CancellationRequest`

```
PENDING ──► APPROVED   (booking → CANCELED_BY_CUSTOMER, Refund created for paid − retained)
   └──────► REJECTED   (booking stays CONFIRMED, customer notified with the reason)
```

Guards: only `OWNER` or `ADMIN` may decide; approving with
`retainedAmountCents < paidAmountCents` additionally requires the refund
capability; `retainedAmountCents` must be between `0` and the paid amount; the
partial unique index makes a second `PENDING` request per booking impossible.
Both `suggestedRetainedAmountCents` (frozen at request time) and the chosen
`retainedAmountCents` are kept, with actor, timestamp, and note.

### 5.5 `RescheduleRequest`

```
PENDING ──► APPROVED   (new Booking CONFIRMED; old → CANCELED_BY_BUSINESS/RESCHEDULED;
   │                    ManagementToken rotated; reminders re-scheduled)
   └──────► REJECTED   (booking unchanged, customer notified)
```

Guards: `OWNER`, `ADMIN`, or the `EMPLOYEE` who owns the booking may decide;
approval takes the advisory lock for **both** the old and the new employee, in
ascending employee-id order to make deadlock impossible, and fails with
`SLOT_UNAVAILABLE` if the requested slot is no longer free.

### 5.6 `Notification`

```
PENDING ──► SENT ──► DELIVERED
   │          │
   │          └──► FAILED   (provider reported a bounce or an undelivered SMS)
   └──► FAILED             (provider rejected the send after all retries)
```

`PENDING` is written before dispatch, so a crash between "queue" and "send" leaves
a visible row rather than silence. `DELIVERED` and `FAILED` come from the
provider status webhook. Terminal states are `DELIVERED` and `FAILED`; `attempts`
and `lastError` accumulate across BullMQ retries, and a row still `PENDING` after
15 minutes is surfaced in the office operations panel.

### 5.7 `OutboxEvent`

```
undispatched (dispatchedAt = null, availableAt <= now)
      │  claimed by dispatcher (FOR UPDATE SKIP LOCKED)
      ▼
enqueued to BullMQ ──► dispatchedAt set
      │
      └── enqueue threw ──► attempts += 1, lastError set, availableAt pushed out
                            by exponential backoff (30 s × 2^attempts, capped 1 h)
```

A row whose `attempts` reaches 10 is left undispatched and reported as a stuck
outbox row in the health endpoint and the office operations panel. It is never
silently dropped, because an undispatched outbox row is by definition a
notification or a saga step that a customer is expecting.

### 5.8 `TimeOff`

```
REQUESTED ──► APPROVED   (blocks availability from this moment on)
     └──────► REJECTED
```

Office-created time off is written directly as `APPROVED`; the `REQUESTED` state
exists for employee-initiated requests, which Phase 1 exposes read-only in the
office list so the workflow is available without new UI. Only `APPROVED` rows are
loaded into the availability snapshot.
---

## 6. API overview

### 6.1 Conventions

**Base path and versioning.** Everything is mounted under `/api`. There is no
`/v1` prefix: the web app is deployed from the same repository and the same
release, so the API is versioned by deployment, and adding a version segment
later is a router change, not a migration. The Swagger document is served at
`/api/docs` and is disabled when `NODE_ENV=production` unless
`ENABLE_API_DOCS=true`.

**Four authentication schemes, one per surface.**

| Surface | Scheme | Enforced by |
| --- | --- | --- |
| `/api/public/*` | none | `@Public()` decorator; a global guard denies anything not explicitly marked |
| `/api/manage/*` | `Authorization: Bearer <management-token>` | `ManagementTokenGuard` — SHA-256 lookup, constant-time compare, checks `revokedAt`/`expiresAt`, attaches the single booking to the request |
| `/api/auth/*`, `/api/office/*` | `HttpOnly; Secure; SameSite=Lax` session cookie `sf_office_session` + `X-Requested-With: XMLHttpRequest` | `OfficeSessionGuard` + `CsrfHeaderGuard` + `RolesGuard` |
| `/api/webhooks/*` | provider signature | `StripeSignatureGuard`, `ResendSignatureGuard`, `TwilioSignatureGuard` — raw body preserved by a per-route body parser |

**`organizationId` is never accepted from a request.** Not in a body, not in a
query parameter, not in a header, not in a path segment. Public routes get it from
`OrganizationContextService`; office routes get it from the session; webhook
handlers derive it from a persisted `Payment`/`Booking`. See §10.1.

**Error envelope.** Every non-2xx response is exactly:

```json
{
  "code": "SLOT_UNAVAILABLE",
  "message": "That time is no longer available.",
  "details": { "employeeId": "clx…", "startsAt": "2026-08-14T09:00:00.000Z" },
  "correlationId": "01J2X8Q4R7ZK3P0M5F6H9T2VBC"
}
```

`details` is omitted when there is nothing structured to say. `message` is
English and is for developers and logs; the web app renders locale copy keyed by
`code` and never displays `message`.

**Error codes.**

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Zod rejected the request; `details.issues` carries the field paths |
| `UNAUTHENTICATED` | 401 | No or invalid session / management token |
| `CSRF_FAILED` | 403 | Missing `X-Requested-With` on a state-changing office route |
| `FORBIDDEN_ROLE` | 403 | Authenticated but the role or capability is insufficient |
| `NOT_FOUND` | 404 | Resource absent **or** owned by another organization |
| `SLOT_UNAVAILABLE` | 409 | Exclusion constraint or in-transaction re-check rejected the slot |
| `IDEMPOTENT_REQUEST_IN_PROGRESS` | 409 | Same key is mid-flight |
| `BOOKING_NOT_CANCELLABLE` | 409 | Booking is terminal or already started |
| `BOOKING_NOT_RESCHEDULABLE` | 409 | Booking is terminal, started, or already has an open request |
| `REQUEST_ALREADY_DECIDED` | 409 | Cancellation/reschedule request is not `PENDING` |
| `EMPLOYEE_HAS_FUTURE_BOOKINGS` | 409 | Archive or time-off refused; `details.bookingCount` |
| `PAYMENT_NOT_REFUNDABLE` | 409 | No settled payment, or the amount exceeds what remains |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different `requestHash` |
| `OUTSIDE_BOOKING_WINDOW` | 422 | Slot violates minimum notice or the booking horizon |
| `INVALID_STATUS_TRANSITION` | 422 | The state machine refused |
| `RATE_LIMITED` | 429 | Throttler; `Retry-After` set |
| `INTERNAL_ERROR` | 500 | Anything unhandled; the message is generic, the correlation id is not |

**Pagination.** Two styles, chosen per endpoint rather than globally:

- *Cursor* for endpoints a customer or a long list drives
  (`GET /office/bookings`, `GET /office/customers`, `GET /office/audit-log`):
  `?limit=50&cursor=<opaque>` → `{ items, nextCursor }`. `limit` ≤ 100,
  default 25. The cursor is base64url of `{ sort, value, id }`, where `value` is
  the active sort field (`startsAt` or `createdAt`) and `sort` includes its
  direction. Decoding verifies that the cursor sort matches the request, and the
  boundary comparison uses the same value plus `id` as the final tie-breaker.
- *Bounded window, no pagination* for calendar reads
  (`GET /office/calendar?from=&to=`): the range is capped at 62 days and returns
  everything in it. Paginating a calendar is a worse interface than refusing a
  too-wide range.

**Filtering and sorting.** Only whitelisted fields, expressed as enums in the
contract, so no user-controlled string reaches a Prisma `orderBy` key.
`GET /office/bookings` accepts `status` (repeatable), `employeeId`, `serviceId`,
`customerId`, `from`, `to`, `q` (matches reference, customer last name, or
customer email), and `sort` ∈ {`startsAt:asc`, `startsAt:desc`,
`createdAt:desc`} with `startsAt:asc` as the default.

**Idempotency.** `Idempotency-Key` is **required** on
`POST /public/bookings`, `POST /office/bookings`,
`POST /office/bookings/:id/manual-payments`, and
`POST /office/bookings/:id/refunds`. It is a UUID v4 generated by the client, and
a missing header is `400 VALIDATION_FAILED`. Behaviour is in §6.2 and §8.5.

**Rate limits** (`@nestjs/throttler` with a Redis store, so limits hold across
instances):

| Route group | Limit |
| --- | --- |
| `GET /public/availability` | 60 / minute / IP |
| `POST /public/bookings` | 10 / hour / IP, and 5 / hour / normalised email |
| `POST /manage/*` and `GET /manage/*` | 30 / minute / IP |
| `POST /auth/login` | 10 / 15 minutes / IP, and 5 / 15 minutes / email (then `lockedUntil`) |
| `POST /auth/password-reset/*` | 5 / hour / IP |
| `/office/*` | 300 / minute / session |
| `/webhooks/*` | not throttled; signature verification is the gate |

**Response conventions.** All timestamps are ISO-8601 UTC with milliseconds. Money
is always `{ amountCents, currency }` — never a formatted string, never a float.
Durations are integer minutes. Enum values are the schema's uppercase members
(except `Locale`).

---

### 6.2 `/api/public` — unauthenticated

| Method & path | Purpose | Response |
| --- | --- | --- |
| `GET /public/organizations/current` | Business identity for the booking page | `{ id, name, timezone, currency, defaultLocale, address, contactEmail, contactPhone, whatsappNumber, bookingHorizonDays, minimumNoticeHours, freeCancellationHours, customerNoteEnabled }` |
| `GET /public/service-categories` | Categories with their bookable services | `{ items: [{ id, name, description, displayOrder, services: [...] }] }` |
| `GET /public/services` | Flat list of online-bookable services | `{ items: [{ id, name, description, durationMinutes, price: {amountCents,currency}, categoryId }] }` |
| `GET /public/services/:serviceId/employees` | Employees who perform this service, with effective price | `{ items: [{ id, displayName, bio, photoUrl, displayOrder, price: {amountCents,currency} }] }` |
| `GET /public/availability` | Bookable slots | see below |
| `POST /public/bookings` | Reserve a slot and open Checkout | see below |
| `GET /public/bookings/by-session/:checkoutSessionId` | Post-Checkout landing poll | `{ reference, status, displayStatus, startsAt, endsAt, employeeDisplayName, serviceName, managementUrlIssued }` |

`GET /public/organizations/current` replaces the specification's
`/public/organizations`: no endpoint anywhere accepts an organization identifier,
so the collection form would be a lie and the id form would be an invitation.
Deviation recorded in §11.3.

**`GET /public/availability`**

Query (Zod-validated): `serviceId` (required), `employeeId` (optional — omitted
means "any available employee"), `from` (required, `YYYY-MM-DD` local date),
`to` (required, ≤ 31 days after `from`).

```json
{
  "serviceId": "clx…",
  "timezone": "Europe/Berlin",
  "days": [
    {
      "date": "2026-08-14",
      "slots": [
        { "startsAt": "2026-08-14T07:00:00.000Z", "endsAt": "2026-08-14T07:30:00.000Z",
          "employeeIds": ["clxemp1", "clxemp2"] }
      ]
    }
  ]
}
```

`employeeIds` lists every employee who could take that slot, so the front end can
show "any employee" without a second round trip; when `employeeId` was supplied
the array holds exactly that one. Errors: `422 OUTSIDE_BOOKING_WINDOW` when
`from` is beyond the horizon, `404 NOT_FOUND` for an unknown or archived service.

**`POST /public/bookings`**

Headers: `Idempotency-Key: <uuid v4>` (required).

```json
{
  "serviceId": "clx…",
  "employeeId": "clx…",
  "startsAt": "2026-08-14T07:00:00.000Z",
  "customer": {
    "email": "anna@example.com",
    "firstName": "Anna",
    "lastName": "Becker",
    "phone": "+4915112345678"
  },
  "locale": "de",
  "customerNote": "Erstbesuch",
  "successUrl": "https://booking.example.com/booking/success",
  "cancelUrl": "https://booking.example.com/booking/canceled"
}
```

`employeeId` is `null` for "any available employee"; the server resolves it before
insert. `successUrl` and `cancelUrl` must match an allow-list of origins from
configuration — an open redirect through Stripe is otherwise free.

`201`:

```json
{
  "bookingId": "clx…",
  "reference": "SF-7K3QD2",
  "status": "PENDING_PAYMENT",
  "employeeId": "clx…",
  "employeeDisplayName": "Mara Vogt",
  "startsAt": "2026-08-14T07:00:00.000Z",
  "endsAt": "2026-08-14T07:30:00.000Z",
  "price": { "amountCents": 4500, "currency": "EUR" },
  "expiresAt": "2026-08-14T06:12:31.000Z",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_…"
}
```

Errors: `409 SLOT_UNAVAILABLE`, `409 IDEMPOTENT_REQUEST_IN_PROGRESS`,
`422 IDEMPOTENCY_KEY_REUSED`, `422 OUTSIDE_BOOKING_WINDOW`,
`404 NOT_FOUND` (service, employee, or the pairing), `429 RATE_LIMITED`.

Replay semantics: same key + same `requestHash` returns the **stored 201 body**,
`checkoutUrl` included, so a customer who reloads mid-payment lands back on the
same Checkout Session. Same key + different body is `422`. The Checkout URL is
therefore only ever handed to whoever holds the random key.

---

### 6.3 `/api/manage` — management-token authenticated

Every route requires `Authorization: Bearer <token>` and operates on exactly the
one booking the token addresses; there is no id in any path, so a token cannot be
pointed at a different booking.

| Method & path | Purpose | Notes |
| --- | --- | --- |
| `GET /manage/booking` | Customer's own booking view | Returns `reference`, `status`, `displayStatus`, times, `serviceName`, `employeeDisplayName`, `price`, `paidAmount`, `refundedAmount`, `customerNote`, `cancellationPolicy: { freeUntil, feePolicy, suggestedRetainedAmount }`, `openCancellationRequest`, `openRescheduleRequest`. Contains **no** internal ids beyond the booking's own, no employee email, no organization internals, no other bookings |
| `GET /manage/availability` | Slots for rescheduling | Same shape as the public endpoint, service fixed to the booking's service |
| `POST /manage/cancel` | Cancel or request cancellation | Body `{ reason?: string }`. Outside the fee window → `200 { outcome: "CANCELED", refund: { amountCents, currency } \| null }`. Inside it → `202 { outcome: "REQUESTED", cancellationRequestId, suggestedRetainedAmount }`. Errors `409 BOOKING_NOT_CANCELLABLE` |
| `POST /manage/reschedule-requests` | Ask for a different time | Body `{ requestedStartsAt, requestedEmployeeId?, reason? }` → `202 { rescheduleRequestId }`. Errors `409 BOOKING_NOT_RESCHEDULABLE`, `409 SLOT_UNAVAILABLE` (checked optimistically at request time and again authoritatively on approval), `422 OUTSIDE_BOOKING_WINDOW` |

---

### 6.4 `/api/auth` — office authentication

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /auth/login` | none | Body `{ email, password }`. Sets `sf_office_session`, rotates the session id, returns `{ user: { id, email, firstName, lastName, role, canIssueRefunds, employeeId } }`. Always `401 UNAUTHENTICATED` with an identical message and a constant-time-comparable duration for unknown email, wrong password, archived user, or locked account |
| `POST /auth/logout` | session | Deletes the Redis session and clears the cookie. Idempotent `204` |
| `GET /auth/me` | session | Current user, for SPA rehydration on reload |
| `POST /auth/password-reset/request` | none | Body `{ email }`. Always `202`, regardless of whether the address exists |
| `POST /auth/password-reset/confirm` | none | Body `{ token, newPassword }`. Marks the token used, writes the argon2id hash, and revokes every session of that user in the same operation. `422 VALIDATION_FAILED` on a weak password (minimum 12 characters, checked against a small common-password deny list) |
| `POST /auth/password` | session | Body `{ currentPassword, newPassword }`. Revokes all other sessions of the user |

---

### 6.5 `/api/office` — session authenticated

Roles: `O` = OWNER, `A` = ADMIN, `E` = EMPLOYEE. `E` is additionally scoped to
its own `employeeId` — an employee sees and acts on its own calendar only, which
is enforced in the service layer, not by a query parameter. `$` marks routes that
additionally require the refund capability (`OWNER` or `canIssueRefunds`).

**Dashboard and calendar**

| Method & path | Roles | Purpose |
| --- | --- | --- |
| `GET /office/dashboard` | O A E | Today's appointments, next 7 days count, pending cancellation and reschedule requests, unpaid manual bookings, today's revenue, plus operations health (failed jobs, stuck outbox rows, notifications still `PENDING`) |
| `GET /office/calendar` | O A E | `?from=&to=&employeeId=` (range ≤ 62 days). Returns bookings with `displayStatus`, blocked times, approved time off, closed days, and working-hours envelopes, so the client draws a calendar without a second call |

**Bookings**

| Method & path | Roles | Purpose |
| --- | --- | --- |
| `GET /office/bookings` | O A E | Filter, sort, cursor-paginate (§6.1) |
| `GET /office/bookings/:id` | O A E | Full detail: snapshots, status history, payments, manual payments, refunds, notifications, open requests |
| `POST /office/bookings` | O A | Manual booking. `Idempotency-Key` required. Body `{ serviceId, employeeId, startsAt, customer: { … } \| { customerId }, customerNote?, note? }`. Created directly `CONFIRMED` with **no** payment and **no** Checkout Session. `409 SLOT_UNAVAILABLE` on collision |
| `POST /office/bookings/:id/cancel` | O A | Body `{ reason, refund?: { amountCents } }`. A non-zero refund additionally requires `$` |
| `POST /office/bookings/:id/complete` | O A E | Guard `endsAt <= now()` |
| `POST /office/bookings/:id/no-show` | O A E | Guard `startsAt <= now()` |
| `POST /office/bookings/:id/manual-payments` | O A | `Idempotency-Key` required. Body `{ amountCents, method, paidAt, note? }` |
| `GET /office/bookings/:id/refunds` | O A | Refund history for the booking |
| `POST /office/bookings/:id/refunds` | O A `$` | `Idempotency-Key` required. Body `{ amountCents, reason, note? }` |

**Requests**

| Method & path | Roles | Purpose |
| --- | --- | --- |
| `GET /office/cancellation-requests` | O A | `?decision=PENDING` default |
| `POST /office/cancellation-requests/:id/decide` | O A | Body `{ decision: "APPROVED" \| "REJECTED", retainedAmountCents?, note? }`. `retainedAmountCents` below the paid amount requires `$` |
| `GET /office/reschedule-requests` | O A E | Employee sees only its own bookings' requests |
| `POST /office/reschedule-requests/:id/decide` | O A E | Body `{ decision, note? }`. Approval creates the new booking under a dual advisory lock |

**Staff and availability**

| Method & path | Roles | Purpose |
| --- | --- | --- |
| `GET /office/employees` | O A E | `?includeArchived=false` |
| `POST /office/employees` | O A | Create |
| `PATCH /office/employees/:id` | O A | Update, including `displayOrder` and `isBookableOnline` |
| `POST /office/employees/:id/archive` | O A | `409 EMPLOYEE_HAS_FUTURE_BOOKINGS` with `details.bookingCount` |
| `PUT /office/employees/:id/working-hours` | O A | Whole-week replacement, segments with nested breaks, transactional |
| `GET /office/employees/:id/services` / `PUT …` | O A | Assignment set plus optional price overrides |
| `GET`/`POST`/`DELETE /office/employees/:id/availability-exceptions` | O A | One-off day overrides |
| `GET`/`POST`/`PATCH /office/time-off` | O A E (own, read-only) | Create as `APPROVED`; conflict-checked under the advisory lock |
| `GET`/`POST`/`DELETE /office/blocked-times` | O A E (own) | Conflict-checked under the advisory lock |
| `GET`/`POST`/`DELETE /office/closed-days` | O A | Organization-wide closures |

**Catalog, settings, users, exports**

| Method & path | Roles | Purpose |
| --- | --- | --- |
| `GET`/`POST`/`PATCH`/`POST :id/archive` `/office/service-categories` | O A | Category CRUD |
| `GET`/`POST`/`PATCH`/`POST :id/archive` `/office/services` | O A | Service CRUD; archiving is refused while future blocking bookings reference it |
| `GET`/`PATCH /office/settings` | O | Every field of `OrganizationSettings`, plus organization identity and the WhatsApp number |
| `GET`/`POST`/`PATCH`/`POST :id/archive` `/office/users` | O | Office user management; `canIssueRefunds` is settable only by `OWNER`; a user cannot archive or demote themselves |
| `GET /office/customers` | O A | Search and cursor-paginate |
| `GET /office/customers/:id` | O A | Profile plus booking history |
| `PATCH /office/customers/:id` | O A | Contact details and `internalNote` |
| `POST /office/customers/:id/erase` | O | Pseudonymise; refused while an unsettled payment exists |
| `GET /office/exports/bookings.csv` | O A | `?from=&to=&status=`; streams RFC 4180 CSV, semicolon-delimited with a UTF-8 BOM so German Excel opens it correctly |
| `GET /office/exports/payments.csv` | O A | Payments, manual payments, and refunds in one ledger view |
| `GET /office/audit-log` | O | Cursor-paginated, filterable by `action` and `officeUserId` |

---

### 6.6 `/api/webhooks` — provider-signature authenticated

| Method & path | Verification | Handled events |
| --- | --- | --- |
| `POST /webhooks/stripe` | `stripe-signature` against `STRIPE_WEBHOOK_SECRET`, on the **raw** body | `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.payment_failed`, `charge.refunded`, `refund.updated`, `refund.failed` |
| `POST /webhooks/resend` | Svix-style signature against `RESEND_WEBHOOK_SECRET` | `email.sent`, `email.delivered`, `email.bounced`, `email.complained` |
| `POST /webhooks/twilio` | `X-Twilio-Signature` against the auth token and the exact public URL | `MessageStatus` callbacks (`sent`, `delivered`, `undelivered`, `failed`) |

All three follow the identical five-step shape: verify signature → insert the
inbox row (unique provider event id; a duplicate returns `200` immediately and
does nothing) → enqueue a BullMQ job with `jobId` = the provider event id → return
`200` → process asynchronously. Any unrecognised event type is stored and marked
processed with a note, so an enabled-by-accident Stripe event never becomes a
retry storm. A signature failure is `400` with no body and is logged at `warn`
with the source IP.

---

### 6.7 `/api/health`

| Path | Purpose |
| --- | --- |
| `GET /api/health/live` | Process liveness only. No dependency checks, so a database blip cannot cause a restart loop |
| `GET /api/health/ready` | `@nestjs/terminus`: `SELECT 1`, Redis `PING`, Prisma migration table matches the shipped migration list |
| `GET /api/health/detail` | Session-authenticated (`OWNER`/`ADMIN`): queue depths per queue, failed-job counts, undispatched outbox rows older than 5 minutes, unprocessed inbox rows older than 5 minutes, `PENDING` notifications older than 15 minutes, oldest `EXPIRING` booking age |
---

## 7. Booking and payment sequence

### 7.1 Happy path — online booking

```
Customer      Web SPA            API                      Postgres          Stripe        Worker
   │            │                 │                          │                │             │
   │─pick svc──►│                 │                          │                │             │
   │            │─GET /public/availability──────────────────► │  (pure engine, snapshot read)│
   │            │◄──── days[] with slots ─────────────────────│                │             │
   │─details───►│                 │                          │                │             │
   │            │ mint uuid v4 → Pinia (survives reload)      │                │             │
   │            │─POST /public/bookings  Idempotency-Key ───► │                │             │
   │            │                 │─BEGIN READ COMMITTED────► │                │             │
   │            │                 │─INSERT IdempotencyKey (IN_PROGRESS)──────► │             │
   │            │                 │─pg_advisory_xact_lock(4711, hashtext(emp))►│             │
   │            │                 │─re-read snapshot, re-run engine──────────► │             │
   │            │                 │─INSERT Booking PENDING_PAYMENT ──────────► │ EXCLUDE ok  │
   │            │                 │─INSERT BookingStatusHistory ─────────────► │             │
   │            │                 │─COMMIT ─────────────────► │                │             │
   │            │                 │─ create Checkout Session (OUTSIDE any tx) ─────►│        │
   │            │                 │◄─ cs_… + url ──────────────────────────────────│        │
   │            │                 │─BEGIN; UPDATE booking.stripeCheckoutSessionId;             │
   │            │                 │  INSERT Payment PENDING; UPDATE IdempotencyKey COMPLETED;  │
   │            │                 │  outbox booking.expiry_scheduled; COMMIT ─────►│          │
   │            │◄─201 { checkoutUrl, expiresAt } ────────────│                │             │
   │◄─redirect──│  (SPA shows a 5-minute countdown before leaving)             │             │
   │────────────────────── pay on Stripe Checkout ───────────────────────────► │             │
   │            │                 │◄──── POST /webhooks/stripe checkout.session.completed ────│
   │            │                 │─verify sig; INSERT StripeWebhookEvent ────► │             │
   │            │                 │─200 (immediately) ──────────────────────────────►│        │
   │            │                 │─enqueue jobId = evt_… ──────────────────────────────────►│
   │            │                 │                          │                │  BEGIN       │
   │            │                 │                          │◄─SELECT booking FOR UPDATE ───│
   │            │                 │                          │◄─PENDING_PAYMENT|EXPIRING→CONFIRMED
   │            │                 │                          │◄─Payment SUCCEEDED, ManagementToken,
   │            │                 │                          │  history, outbox booking.confirmed
   │            │                 │                          │  COMMIT ─────────────────────►│
   │─lands on success page, polls GET /public/bookings/by-session/cs_… ───────► │             │
   │◄─ CONFIRMED + reference ────────────────────────────────│                │             │
   │            │                 │                          │  OutboxDispatcher → email/SMS jobs
   │◄──────────── confirmation email (de) with /manage#<token> ───────────────────────────────│
```

Three properties worth naming:

1. **No Stripe call happens inside a database transaction.** The reservation
   commits first; the Checkout Session is created afterwards; a second short
   transaction attaches it. Prisma's interactive transactions time out at 5
   seconds by default and roll back while the callback keeps running, so a slow
   Stripe response inside a transaction would produce a committed-looking session
   attached to a rolled-back booking.
2. If the process dies between the commit and the Stripe call, the booking is a
   `PENDING_PAYMENT` row with no session id. The expiry sweeper finds it by
   `expiresAt`, and the expiry job treats "no session id" as "nothing to expire at
   Stripe" and goes straight to `EXPIRED`.
3. If the process dies after the Checkout Session exists but before the second
   transaction, the customer never gets a URL and the reservation expires — but
   `checkout.session.expired` still arrives and is matched by
   `stripeCheckoutSessionId`, which is null, so the handler falls back to matching
   on the session's `client_reference_id` (set to the booking id) and reports the
   inconsistency. That is why `client_reference_id` is always populated.

### 7.2 Reservation expiry — the two-phase saga

The naive ordering (mark the booking expired, then expire the Stripe session)
leaves a window in which the slot has been released while the customer's pay
button still works. The corrected saga keeps the slot blocking until Stripe has
answered.

```
Scheduler / per-booking timer
   │
   ├─ Phase 1 (one short transaction)
   │    BEGIN READ COMMITTED
   │    SELECT … FROM bookings WHERE id = $1 FOR UPDATE
   │    guard: status = 'PENDING_PAYMENT' AND expires_at < now()
   │    UPDATE bookings SET status = 'EXPIRING'          ← still in the blocking set
   │    INSERT BookingStatusHistory
   │    INSERT OutboxEvent 'booking.expiry_requested'
   │    COMMIT
   │
   └─ Phase 2 (worker job, no transaction open, retryable)
        stripe.checkout.sessions.expire(sessionId)
          ├─ 200, status='expired'   → BEGIN; EXPIRING → EXPIRED; expires_at = NULL;
          │                             history; COMMIT      ← slot released HERE
          ├─ 400 "already completed" → retrieve session; payment_status='paid'
          │                             → BEGIN; FOR UPDATE; EXPIRING → CONFIRMED;
          │                               Payment SUCCEEDED; ManagementToken; history;
          │                               outbox booking.confirmed; COMMIT
          │                             (idempotent with the webhook path — whichever
          │                              runs second sees CONFIRMED and returns)
          ├─ session id is null      → BEGIN; EXPIRING → EXPIRED; COMMIT
          └─ network error / 5xx     → throw; BullMQ retries with backoff.
                                       Booking stays EXPIRING and keeps blocking.
                                       A reconciler re-drives anything EXPIRING
                                       for more than 2 minutes.
```

**Failure is always safe in one direction**: the system over-blocks a slot, it
never double-books one. That is the correct bias for an appointment business — a
slot briefly unavailable costs one refresh; a double booking costs a customer.

**Accepted consequence, documented deliberately**: a competing customer who
arrives during Phase 2 sees the slot as unavailable for a second or two after the
deadline, rather than instantly reusable. Strict correctness is preferred over
instant reuse. To keep the window small, expiry is driven two ways: a
**per-booking BullMQ delayed job** whose delay lands exactly on `expiresAt`
(normal path, sub-second), plus a **60-second sweeper** using
`FOR UPDATE SKIP LOCKED` as the backstop for lost jobs and restarts. The web UI
shows a live countdown on the redirect screen so the deadline is never a surprise.

**Payment-method restriction.** Checkout Sessions are created with
`payment_method_types: ['card']` and wallets enabled through card. Asynchronous
methods (SEPA direct debit, Klarna, Sofort) fire
`checkout.session.completed` with `payment_status: 'unpaid'` and settle days
later, which a 5-minute reservation model cannot honour. The completed handler
still branches on `payment_status` defensively rather than assuming paid, and
`checkout.session.async_payment_succeeded` is wired to the late-confirmation
path so that enabling an async method later is a configuration change plus a
policy decision, not a code rewrite.

### 7.3 Refund

```
Office user               API                    Postgres              Stripe        Worker
    │  POST /office/bookings/:id/refunds, Idempotency-Key
    │────────────────────►│                       │                     │             │
    │                     │ guard: role + capability + amount ≤ paid − refunded       │
    │                     │─BEGIN; INSERT Refund PENDING (unique idempotencyKey);
    │                     │        outbox 'refund.requested'; COMMIT ──► │             │
    │◄─202 { refundId, status: "PENDING" } ────────│                     │             │
    │                     │                       │  dispatcher → job   │             │
    │                     │                       │                     │◄─ refunds.create(
    │                     │                       │                     │     charge, amount,
    │                     │                       │                     │     idempotencyKey)
    │                     │                       │◄─ UPDATE Refund SUCCEEDED, stripeRefundId,
    │                     │                       │   Payment.refundedAmountCents += amount,
    │                     │                       │   Payment.status → PARTIALLY_REFUNDED|REFUNDED,
    │                     │                       │   outbox 'refund.succeeded'
    │◄──────────── customer email: refund issued ─────────────────────────────────────│
```

The local row exists **before** the API call and carries the key Stripe is given,
so a BullMQ retry after a lost response cannot produce a second refund: Stripe
replays its own result for that key, and the unique index makes a second local row
impossible. `charge.refunded` arriving before the API call returns is handled by
upserting on `stripeRefundId` and falling back to `idempotencyKey`.

### 7.4 Manual booking and manual payment

No payment link, no Checkout Session, no synthetic Stripe object. The office
creates the booking directly `CONFIRMED` under the same advisory lock and the same
exclusion constraint as an online booking; it is simply unpaid. Money arrives
later as a `ManualPayment` row with method, amount, timestamp, recording user, and
an optional note. The dashboard lists confirmed bookings whose paid total is below
the snapshot price so nothing is quietly given away.

---

## 8. Concurrency strategy

Five mechanisms, each with a clearly bounded job. Nothing relies on
application-level "check then insert" without a database guarantee behind it.

### 8.1 The blocking set

`PENDING_PAYMENT`, `EXPIRING`, `CONFIRMED` occupy an employee. This list is
defined once as `BLOCKING_BOOKING_STATUSES` and appears in the constraint
predicate, the availability snapshot query, and the conflict checks. Task 1.3
asserts by reading `pg_constraint` that the SQL predicate and the TypeScript
constant contain the same members.

### 8.2 Exclusion constraints — the authoritative guard

Raw SQL inside a hand-written Prisma migration
(`booking-app/apps/api/prisma/migrations/20260801000100_calendar_constraints/migration.sql`):

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_block_range_check
    CHECK (block_ends_at > block_starts_at),
  ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    organization_id WITH =,
    employee_id     WITH =,
    tstzrange(block_starts_at, block_ends_at, '[)') WITH &&
  ) WHERE (status IN ('PENDING_PAYMENT', 'EXPIRING', 'CONFIRMED'));

ALTER TABLE blocked_times
  ADD CONSTRAINT blocked_times_range_check
    CHECK (ends_at > starts_at),
  ADD CONSTRAINT blocked_times_no_overlap EXCLUDE USING gist (
    organization_id WITH =,
    employee_id     WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  );
```

Details that matter:

- `organization_id` in the key is redundant while an employee belongs to exactly
  one organization. It is kept as defence in depth and as the seam the
  multi-tenant future needs; the cost is one extra column in a GiST index.
- All four participating columns are `NOT NULL`. This closes two range-integrity
  holes that a nullable schema leaves open: a `NULL` bound produces an unbounded
  range that overlaps everything and would block an employee's entire calendar,
  and `tstzrange(x, x)` is the empty range, which overlaps nothing and would
  silently permit unlimited zero-length duplicates. The `CHECK` closes the second
  hole even for non-null equal bounds.
- `'[)'` bounds — start inclusive, end exclusive — make back-to-back appointments
  legal, which is the entire point of buffers being explicit.
- `blocked_times_no_overlap` has **no** status predicate: a blocked time either
  exists or it does not.

### 8.3 Per-employee advisory lock — for what a constraint cannot express

PostgreSQL cannot express a **cross-table** exclusion constraint, so
booking↔blocked-time, booking↔time-off, and booking↔closed-day consistency has to
be serialised in the application. Every calendar-mutating transaction takes, as
its **first statement**:

```sql
SELECT pg_advisory_xact_lock(4711, hashtext($1));   -- $1 = employeeId
```

`4711` is the reserved classid for this application's calendar domain (recorded
as a named constant, `CALENDAR_LOCK_CLASS_ID`). `pg_advisory_xact_lock` releases
at commit or rollback, so no leak is possible on failure. The four paths that take
it: create booking (online), create booking (office), create or delete blocked
time, create or approve time off. Reschedule approval takes it for both employees
**in ascending employee-id order**, which makes a deadlock between two concurrent
reschedules impossible.

With the lock held, the in-transaction availability re-check is race-free. The
exclusion constraint remains the backstop for any future path that forgets the
lock, surfacing as `23P01`.

### 8.4 Isolation level and error mapping

- Explicit `isolationLevel: 'ReadCommitted'` on every interactive transaction.
  The sweep-then-insert pattern is correct under READ COMMITTED because
  `SELECT … FOR UPDATE` re-evaluates its predicate against the updated row via
  EvalPlanQual. REPEATABLE READ would instead raise `40001` on exactly the
  contended path this system is designed around, converting a solvable lock wait
  into a retry storm.
- `timeout: 15_000` and `maxWait: 10_000` on transactions that acquire the
  advisory lock, raised from Prisma's 5-second default because waiting for the
  lock is expected behaviour, not a fault.
- `40001` and `40P01` are retried up to three times with jittered backoff by a
  `withSerializationRetry` helper; anything else propagates.
- **`23P01` has no Prisma error class.** Prisma surfaces exclusion violations as
  `PrismaClientUnknownRequestError` with the SQLSTATE embedded in the message,
  which is shape-unstable across Prisma versions. A single helper —
  `isExclusionViolation(err, constraintName?)` in
  `booking-app/apps/api/src/common/prisma-errors/` — matches on `23P01` **and**
  the constraint name, and is covered by an integration test against a real
  PostgreSQL that provokes a genuine violation. Every call site funnels through
  it and maps to `409 SLOT_UNAVAILABLE`. If a Prisma upgrade changes the message
  shape, exactly one test fails and exactly one function changes.

### 8.5 Idempotency

The specification's identity-based dedupe (email + service + employee + slot) is
**not** used. It has two defects: it merges genuinely distinct attempts — a
customer legitimately rebooking the same slot after an expiry gets someone else's
reservation handed back — and it lets anyone who can guess the tuple retrieve a
Checkout URL, which is a payment-session leak.

Instead the web app generates a random UUID v4 once per booking attempt, keeps it
in the Pinia booking-draft store (so a reload does not mint a new one), and
resends it on every retry.

```
IdempotencyKey(key unique, scope, requestHash, responseSnapshot, statusCode,
               bookingId, state, createdAt, expiresAt)
```

| Situation | Outcome |
| --- | --- |
| Unknown key | Insert `IN_PROGRESS`, run the operation, store the response, mark `COMPLETED` |
| Known key, `COMPLETED`, same `requestHash` | Replay the stored status and body byte-for-byte — including `checkoutUrl` |
| Known key, `COMPLETED`, different `requestHash` | `422 IDEMPOTENCY_KEY_REUSED` |
| Known key, `IN_PROGRESS` | `409 IDEMPOTENT_REQUEST_IN_PROGRESS` |
| Two customers, same slot, different keys | The second gets `409 SLOT_UNAVAILABLE` from the exclusion constraint |

`requestHash` is SHA-256 over the canonicalised body (sorted keys, normalised
email, no whitespace). Records expire after 24 hours and are swept nightly. The
same mechanism guards every office mutation that moves money — manual payment
recording and refund issuing — so a double-clicked button cannot double-charge or
double-refund.

### 8.6 Enum migrations are hand-written

Because `bookings_no_overlap` hard-codes the enum literals
`'PENDING_PAYMENT'`, `'EXPIRING'`, `'CONFIRMED'` in its predicate, Prisma's
default strategy for changing an enum — create a new type, swap the column, drop
the old type — silently drops the dependent constraint. Therefore:

- Every migration that touches `BookingStatus` is authored by hand with
  `prisma migrate dev --create-only` and edited to use `ALTER TYPE … ADD VALUE`,
  or to drop and recreate the constraint explicitly in the same transaction.
- A post-`migrate deploy` test (Task 1.3) queries `pg_constraint` and asserts that
  `bookings_no_overlap`, `bookings_block_range_check`,
  `blocked_times_no_overlap`, and `blocked_times_range_check` all still exist with
  the expected definition. This test runs in CI on a freshly migrated database, so
  a constraint can never be lost quietly.

### 8.7 Transaction rules, stated once

- No network call — Stripe, Resend, Twilio — inside `prisma.$transaction`. Ever.
- No BullMQ `add()` inside a transaction; write an `OutboxEvent` instead.
- Any transaction that mutates a calendar takes the advisory lock first.
- Every status change writes its `BookingStatusHistory` row in the same
  transaction as the change.
- Every side effect that must survive a crash is an `OutboxEvent` in the same
  transaction as the change.
- Reads that feed a decision inside a mutating transaction use `FOR UPDATE`
  on the aggregate root.

---

## 9. Notification strategy

### 9.1 Outbox — nothing is enqueued from a request handler

The gap between "database committed" and "job enqueued" is where confirmation
emails disappear. It is closed by writing the intent to the same transaction as
the state change:

```
handler transaction:  UPDATE booking … ; INSERT OutboxEvent 'booking.confirmed' ;  COMMIT
worker (every 500 ms): SELECT … FROM outbox_events
                        WHERE dispatched_at IS NULL AND available_at <= now()
                        ORDER BY available_at
                        FOR UPDATE SKIP LOCKED
                        LIMIT 50
                       → validate payload against the schema for its eventType
                       → queue.add(eventType, payload, { jobId: `outbox:${row.id}` })
                       → UPDATE outbox_events SET dispatched_at = now()
```

`jobId` derived from the outbox row id makes redelivery after a crash a no-op:
BullMQ refuses a duplicate job id. Delivery is at-least-once and **every consumer
is idempotent**. This one mechanism covers booking confirmations, expiry sagas,
reminder scheduling, every email and SMS, and refund follow-ups.

### 9.2 Inbox — inbound webhooks

The mirror image, described in §6.6: verify, insert, return `200`, then process
with `jobId` = the provider event id. `StripeWebhookEvent`/`MessagingWebhookEvent`
carry `receivedAt`, `processedAt`, `attempts`, `lastError`, and a reconciler
re-enqueues anything unprocessed for more than 5 minutes — so a crash between the
insert and the enqueue self-heals rather than losing a payment confirmation.

### 9.3 Notification rows are written before dispatch

Every send creates a `Notification` row `PENDING` first, carrying its
`dedupeKey`. A unique violation on `dedupeKey` means "already queued" and is
swallowed, which turns at-least-once outbox delivery into effectively-once
customer contact. The row then accumulates `providerMessageId`, `attempts`,
`sentAt`, and finally `DELIVERED` or `FAILED` from the provider status webhook.
A reconciler picks up rows still `PENDING` after 15 minutes; the office operations
panel shows the count so silence is visible.

### 9.4 Reminders and BullMQ's `jobId` trap

BullMQ silently ignores `add()` when the `jobId` already exists **in any state,
including completed**. A naive `reminder:<bookingId>` would therefore leave a
rescheduled booking with no reminder, because the original job id already existed.
Reminder job ids embed the appointment time:

```
reminder:<offsetMinutes>:<bookingId>:<startsAtEpochSeconds>
```

Three further defences, because a reminder that fires for a cancelled
appointment is worse than one that does not fire:

1. **Jobs are self-validating.** At execution the processor re-reads the booking's
   `status` and `startsAt`; on any mismatch it logs and returns without sending.
   Removal of a stale job is therefore best-effort — a failed removal is
   harmless.
2. **Past-due delays are skipped.** A negative computed delay (a booking created
   fewer than 24 hours ahead, or a reschedule into the near future) is not
   enqueued at all rather than fired immediately.
3. **A nightly reconciler** recomputes the expected reminder set for every
   `CONFIRMED` booking starting inside the next 48 hours and repairs gaps, so a
   Redis flush loses at most one night of scheduling.

Offsets come from `OrganizationSettings.reminderOffsetsMinutes`, default
`[1440]` (24 hours). SMS reminders are sent only when
`smsRemindersEnabled = true` and the customer supplied a phone number.

### 9.5 Templates

`booking-app/packages/notification-templates` exports one function:

```ts
render(kind: NotificationKind, channel: NotificationChannel, locale: Locale,
       data: TemplateData[NotificationKind]): { subject?: string; text: string; html?: string }
```

- One directory per locale (`de/`, `en/`), one file per `NotificationKind`, so a
  missing translation is a **compile error**, not a runtime fallback to English.
- Email templates render both `text` and `html`; SMS renders `text` only and is
  asserted at ≤ 480 characters (three segments) by a unit test per template.
- Data types come from `booking-contracts`, so a template cannot reference a field
  the sender does not pass.
- Every template is snapshot-tested per locale, and money and dates are formatted
  through shared helpers (`Intl.NumberFormat('de-DE', { currency: 'EUR' })`,
  `Europe/Berlin` date formatting) rather than string concatenation.
- Customer-facing copy is German by default and follows the booking's `locale`;
  office notifications are English.

### 9.6 Notification matrix

| Kind | Channel(s) | Recipient | Trigger |
| --- | --- | --- | --- |
| `BOOKING_CONFIRMATION` | EMAIL (+ SMS if enabled) | customer | `booking.confirmed` |
| `OFFICE_NEW_BOOKING` | EMAIL | `officeNotificationEmail` | `booking.confirmed` |
| `REMINDER_24H` | EMAIL (+ SMS if enabled) | customer | delayed job per offset |
| `BOOKING_CANCELED_BY_CUSTOMER` | EMAIL | customer + office | `booking.canceled` |
| `BOOKING_CANCELED_BY_BUSINESS` | EMAIL (+ SMS if enabled) | customer | `booking.canceled` |
| `BOOKING_RESCHEDULED` | EMAIL | customer | reschedule approved |
| `CANCELLATION_REQUEST_RECEIVED` | EMAIL | customer | request created |
| `OFFICE_CANCELLATION_REQUEST` | EMAIL | office | request created |
| `CANCELLATION_REQUEST_DECIDED` | EMAIL | customer | decision recorded |
| `RESCHEDULE_REQUEST_RECEIVED` | EMAIL | customer + office | request created |
| `RESCHEDULE_REQUEST_DECIDED` | EMAIL | customer | decision recorded |
| `REFUND_ISSUED` | EMAIL | customer | `refund.succeeded` |
| `OFFICE_PASSWORD_RESET` | EMAIL | office user | reset requested |

No notification is sent for `PENDING_PAYMENT`, `EXPIRING`, `EXPIRED`, or
`PAYMENT_FAILED`. An abandoned checkout is not an event a customer wants an email
about, and it would be indistinguishable from a payment problem they already saw
on the Stripe page.
---

## 10. Security strategy

### 10.1 Tenant resolution — server-side only, never from the request

This is the invariant that makes the multi-tenant-ready design safe rather than
dangerous. **`organizationId` is never read from a request body, query parameter,
header, or path segment.**

- **Public endpoints** resolve it server-side from configuration:
  `DEFAULT_ORGANIZATION_SLUG` is looked up once at bootstrap and exposed as
  `OrganizationContextService.getOrganizationId()`. A missing or unknown slug
  fails the bootstrap loudly rather than defaulting to "the first row". The future
  host-based or slug-based resolver replaces exactly this one provider and nothing
  else.
- **Office endpoints** take it from the authenticated session's
  `OfficeUser.organizationId`. Any resource whose `organizationId` does not match
  returns **`404 NOT_FOUND`**, not `403` — a `403` confirms that the id exists,
  which is an enumeration oracle.
- **Webhook handlers** derive it from the persisted `Payment` or `Booking` found by
  a locally-stored provider id. Provider metadata is never trusted as the tenant
  source, because metadata is attacker-influenceable in any Connect-shaped future
  and is simply unauthenticated data today.

Three enforcement layers, so this cannot rot:

1. **A contract test** walks every exported request schema in
   `booking-app/packages/contracts/src` and fails if any of them contains an
   `organizationId` key. A developer who adds one gets a red test with the schema
   name.
2. **A Prisma client extension** (`tenant.extension.ts`) wraps every model that has
   an `organizationId` column: it injects `organizationId` into `create` and
   `createMany`, and it **throws** on `findMany`, `findFirst`, `update`,
   `updateMany`, `delete`, `deleteMany`, and `count` whose `where` omits
   `organizationId`. An omitted filter therefore fails loudly in development and in
   tests instead of leaking in production. `findUnique` by primary key is allowed
   through and is followed by an ownership assertion in the service —
   `assertOwned(row)` — because a `findUnique` cannot carry the filter.
   The extension is bypassable only through an explicitly named
   `prisma.$unsafeGlobal` accessor used by exactly four call sites (the outbox
   dispatcher, the inbox reconciler, the expiry sweeper, and the nightly
   sweepers), each of which has a comment naming why it is global and a test
   asserting it filters by something else instead.
3. **Integration tests** create two organizations and assert that every `/office`
   list endpoint returns only the session organization's rows and that every
   `/office` detail endpoint returns `404` for the other organization's ids.

### 10.2 Public surface

- No authentication, therefore no data that is not intended for the world: the
  public endpoints expose service names, prices, durations, employee display names,
  bios, photos, and slot times. They never expose customer data, booking counts,
  employee email addresses, internal ids of other bookings, or settings that are
  not needed to render the flow.
- Availability responses are computed from a snapshot and reveal only *free*
  slots. They do not reveal who is booked, or that a slot is taken versus outside
  working hours, so the endpoint is not a staff-surveillance tool.
- `successUrl` and `cancelUrl` on `POST /public/bookings` are validated against
  `PUBLIC_WEB_ORIGIN`; an arbitrary URL would turn Stripe's redirect into an open
  redirect.
- Rate limits per §6.1, backed by Redis so they hold across instances.

### 10.3 The management token

- 256 bits from `crypto.randomBytes(32)`, base64url-encoded.
- Delivered **only in the URL fragment**: `https://…/manage#<token>`. A fragment is
  never sent to a server, never appears in access logs, and is not transmitted in
  the `Referer` header, so the token does not leak through the web server, a CDN,
  or an analytics beacon. The SPA reads `location.hash`, moves the token into
  memory, and immediately calls `history.replaceState` to strip it from the
  address bar.
- Sent to the API only as `Authorization: Bearer <token>`, never as a query
  parameter.
- Only `sha256(token)` is stored. Lookup is by hash, compared with
  `crypto.timingSafeEqual`.
- Revocable (`revokedAt`), expires 14 days after the appointment ends, and is
  **rotated on reschedule** so an old confirmation email cannot manage the new
  appointment.
- Scoped to exactly one booking: no `/manage` route takes an id, so a valid token
  cannot be aimed elsewhere.
- Rate-limited per IP, and a failed lookup is logged at `warn` with the truncated
  hash only.
- `GET /manage/booking` returns a hand-written projection, never a Prisma model
  spread, so a future column cannot leak by accident.

### 10.4 Office authentication

- **Passwords**: argon2id via the `argon2` package, `memoryCost 19456` (19 MiB),
  `timeCost 2`, `parallelism 1` — the OWASP-recommended baseline. Minimum 12
  characters, checked against a small embedded common-password deny list. Hash
  parameters live in one constant so a future uplift is one edit plus a rehash-on-
  login path.
- **Sessions**: opaque 256-bit ids in Redis under `session:<sid>` with a 12-hour
  idle TTL and a 7-day absolute cap, delivered in a cookie that is `HttpOnly`,
  `Secure`, `SameSite=Lax`, `Path=/api`. The session id is **rotated on login and
  on password change**, defeating session fixation.
  `session:user:<officeUserId>` is a Redis set of that user's sessions, so
  "revoke everywhere" on password change or archive is one `SMEMBERS` + `DEL`.
- **CSRF**: the deployment is same-origin behind the reverse proxy in
  `booking-app/infrastructure/nginx/booking.conf`, so `SameSite=Lax` already blocks
  cross-site form posts. On top of that, every state-changing `/office` and
  `/auth` route requires `X-Requested-With: XMLHttpRequest`, a header a
  cross-origin form cannot set without a preflight that CORS refuses. No CSRF
  token table is needed, and the reason is written down here so nobody adds one
  believing it was forgotten.
- **Login hardening**: identical `401 UNAUTHENTICATED` for unknown email, wrong
  password, archived user, and locked account; argon2 verification is executed
  against a dummy hash on unknown emails so response timing does not distinguish
  them. `failedLoginAttempts` increments and `lockedUntil` is set to 15 minutes
  after 10 failures, and both are cleared on success.
- **Password reset**: 256-bit token, only the SHA-256 hash stored, 60-minute
  expiry, single use marked inside the same transaction as the password write, all
  other sessions revoked. `POST /auth/password-reset/request` always answers
  `202` so it cannot enumerate accounts.

### 10.5 Authorization matrix

| Capability | OWNER | ADMIN | EMPLOYEE |
| --- | --- | --- | --- |
| View own calendar and bookings | yes | yes | yes |
| View all employees' calendars | yes | yes | no |
| Complete / no-show a booking | yes | yes | own only |
| Create a manual booking | yes | yes | no |
| Cancel a booking | yes | yes | no |
| Decide a cancellation request | yes | yes | no |
| Decide a reschedule request | yes | yes | own bookings only |
| Record a manual payment | yes | yes | no |
| Issue a refund | yes | with `canIssueRefunds` | no |
| Manage employees, working hours, services | yes | yes | no |
| Manage blocked times / time off | yes | yes | own only |
| Manage organization settings | yes | no | no |
| Manage office users | yes | no | no |
| View audit log | yes | no | no |
| Export CSV | yes | yes | no |

Enforced by `@Roles(...)` and `@RequiresRefundCapability()` decorators read by
guards, **plus** a service-layer scope check for the "own only" rows — a decorator
alone cannot express "this employee's bookings". A user can never archive or
demote themselves, so an organization cannot be locked out of its own owner
account.

### 10.6 Input validation and injection

- Every request body, query, and param is parsed by a Zod schema from
  `booking-contracts` through the global `ZodValidationPipe`; unknown keys are
  stripped, not ignored, so an attacker cannot smuggle a field a later refactor
  starts trusting.
- Every SQL statement is either Prisma-generated or a `Prisma.sql` tagged template
  with bound parameters. There is no string-concatenated SQL anywhere; a lint rule
  bans `$queryRawUnsafe` and `$executeRawUnsafe` outright.
- `orderBy`, `select`, and filter fields come from closed enums, so no
  user-controlled string reaches a Prisma key position.
- Request body size is capped at 128 KB except on `/webhooks/stripe`, which is
  capped at 1 MB and needs its raw body preserved.
- The CSV exporter prefixes any cell beginning with `=`, `+`, `-`, or `@` with a
  single quote, so a customer name cannot become a formula in the office's
  spreadsheet.

### 10.7 Payment security

- **No card data ever touches this system.** Payment collection happens entirely on
  Stripe's hosted Checkout page. No PAN, expiry, CVC, or cardholder name is
  received, logged, or stored; `Payment.paymentMethodType` is Stripe's coarse label
  only. This is what keeps the deployment in SAQ-A territory.
- Webhook signatures are verified on the **raw** body before any parsing, with a
  300-second tolerance. A route-scoped raw-body parser is registered for
  `/webhooks/*` only, so the rest of the API keeps normal JSON parsing.
- The Stripe API version is pinned in the adapter, so an SDK upgrade cannot
  silently change a payload shape the handlers depend on.
- Amounts are never taken from the client. The Checkout line item is built from the
  server-resolved effective price, and the confirmation handler asserts that
  `session.amount_total` equals `booking.priceCentsSnapshot`; a mismatch confirms
  the booking, records the payment as received, and raises a `payment.amount_mismatch`
  alert rather than silently accepting it — the customer has paid and must not be
  left in limbo, but the discrepancy must be visible.
- Refund amounts are validated server-side against `amountCents − refundedAmountCents`
  of the settled payment.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are required by the environment
  schema; the process refuses to start without them.

### 10.8 Personal data, logging, and retention

- **Logging**: pino with a fixed redaction path list — `req.headers.authorization`,
  `req.headers.cookie`, `req.headers.idempotency-key`, `req.body.password`, `req.body.newPassword`,
  `req.body.currentPassword`, `req.body.customer.email`, `req.body.customer.phone`,
  `req.body.customerNote`, `*.email`, `*.phone`, `*.tokenHash`, `*.token`. A unit
  test submits a request containing every one of these body/header values and
  asserts none appears in the serialised log line.
- **Correlation**: one `correlationId` per request (from `X-Request-Id` or newly
  minted) carried through AsyncLocalStorage into every log line, every outbox row,
  every job, and every error envelope, so an incident is traceable from a
  customer's screenshot to a worker log.
- **The customer note field** carries explicit copy in both locales telling
  customers not to enter health information — German: *"Bitte geben Sie hier keine
  Gesundheitsdaten oder andere sensiblen Informationen ein."* The field is capped at
  500 characters, redacted from logs, and excluded from CSV exports by default.
  This matters because a massage business invites exactly the kind of disclosure
  that would turn ordinary contact data into a special category of personal data.
- **Retention**: `OrganizationSettings.dataRetentionDays` (default 1095) drives a
  nightly sweeper that pseudonymises customers with no booking inside the window
  and no unsettled payment. `Notification.recipient`/`subject` are redacted at 90
  days. Money rows are never deleted, which is the correct outcome for tax
  retention duties.
- **Export and erasure foundations**: `GET /office/customers/:id` composes a
  complete per-customer view, and `POST /office/customers/:id/erase` pseudonymises
  in place. Both are the substrate a full subject-access-request flow needs later;
  Phase 1 ships the office-mediated version, not a self-service one.

### 10.9 Transport and headers

`helmet` with: HSTS (`max-age` 1 year, `includeSubDomains`), `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
and a CSP with `default-src 'self'`, `frame-src https://checkout.stripe.com`,
`img-src 'self' data:`, `connect-src 'self'`, and no `unsafe-inline` for scripts.
CORS is **disabled** — the SPA and the API are same-origin behind the reverse
proxy — and the reason is documented, so an "it works on my machine" CORS
wildcard does not get added later. `app.set('trust proxy', 1)` so rate limits and
audit rows record the real client IP rather than the proxy's.

### 10.10 Secrets and configuration

One Zod schema (`booking-app/apps/api/src/config/env.schema.ts`) validates the
entire environment at bootstrap and the process exits non-zero on any failure,
with every offending variable named at once. No `process.env` access exists outside
that module. `booking-app/.env.example` lists every variable with a safe
placeholder value and a comment; `.env` is git-ignored. A test asserts that the
schema's key set and `.env.example`'s key set are identical, so a new variable
cannot be added without documenting it.

---

## 11. Phase 1 non-goals, limitations, and deviations

### 11.1 Explicit non-goals

Not built, not stubbed, not partially wired:

- Multi-tenant SaaS: no signup, no organization provisioning UI, no per-tenant
  domains, no plan or billing model, no tenant switching. `organizationId` and
  `PaymentAccountContext` exist; nothing consumes them plurally.
- Stripe Connect: no account onboarding, no `stripeAccount` header usage, no
  application fees, no payout handling. `Organization.stripeAccountId` stays null.
- Customer accounts: no registration, no password, no login, no saved cards, no
  self-service booking history. Access to a booking is the management token.
- Packages, memberships, gift cards, vouchers, discount codes, tipping,
  deposits, partial payments, and multi-service or group bookings.
- Recurring appointments and waitlists.
- Resource booking beyond employees (no rooms, no equipment).
- Employee self-service portal (an `EMPLOYEE` sees their calendar in the office
  area; there is no separate app).
- Marketing email, campaigns, or review requests.
- Push notifications, native or PWA-installable apps, WhatsApp *messaging* (only
  a deep link to start a chat).
- Reporting beyond the dashboard tiles and the two CSV exports.
- Online rescheduling that completes without office approval.
- Asynchronous payment methods (SEPA, Klarna, Sofort) — see §7.2.

### 11.2 Known limitations, accepted with reasons

| Limitation | Why it is accepted |
| --- | --- |
| A slot stays blocked for a second or two after expiry while Stripe confirms the session is dead | Over-blocking is strictly safer than double-booking (§7.2) |
| Reschedule needs office approval | Approving a customer-driven time change automatically means either a second exclusion-constraint dance across two employees under customer control, or a refund/repricing policy Phase 1 has not defined |
| One-way availability push: changing working hours does not move existing bookings | Silently moving a customer's appointment is worse than surfacing the conflict; the office UI shows conflicts and the office decides |
| Weekly working-hours overlap is validated in the service layer, not by a constraint | A weekday-relative minute range is not something a Postgres exclusion constraint can express |
| Timezone is a single organization-wide `Europe/Berlin` | Nothing in Phase 1 is multi-region; the column exists so it is data, not code, later |
| Single-currency EUR | Same reasoning; the `currency` columns exist |
| No optimistic-concurrency version column on `Booking` | The advisory lock plus `FOR UPDATE` covers every mutating path; a version column would add a conflict class without removing one |
| Availability recomputes on every request, no cache | A six-month horizon for a handful of employees is a few hundred rows; a cache would add an invalidation bug for no measured gain |
| Email and SMS delivery depend on third parties | Delivery state is persisted and reconciled, and failures are visible in the office panel rather than silent |

### 11.3 Deviations from the source specification

Each is a deliberate correction, not an omission.

1. **`CANCELLATION_REQUESTED` and `RESCHEDULE_REQUESTED` are derived, not
   persisted.** The specification lists them as booking statuses. Persisting them
   would drop the booking out of the blocking set while the office decides,
   releasing a slot that is still promised; and the two conditions can coexist,
   which one column cannot express. They are computed as `displayStatus` from the
   open request rows (§5.1).
2. **`BookingReservation` is folded into `Booking`.** The specification has a
   separate reservation entity. One row means one exclusion constraint and no
   reservation↔booking synchronisation gap; the reservation columns
   (`expiresAt`, `stripeCheckoutSessionId`, `idempotencyKeyId`) and the
   `PENDING_PAYMENT`/`EXPIRING`/`EXPIRED` statuses carry the same information
   (§4.3).
3. **`GET /public/organizations/current` replaces `/public/organizations`.** No
   endpoint accepts an organization identifier anywhere, so a collection or an
   id-addressed form would contradict §10.1.
4. **The pnpm workspace root is the repository root, not `booking-app/`.** The
   specification's structure diagram nests it inside the product directory; the
   repository is a monorepo with room for a second product, and two workspace
   roots would mean two lockfiles (§3.1).
5. **Checkout is restricted to synchronous payment methods.** Card and wallets
   only. Asynchronous methods settle in days, which a five-minute reservation
   cannot honour (§7.2).
6. **Identity-based idempotency is replaced by a random client key.** The
   specification's email+service+employee+slot tuple merges distinct attempts and
   lets a guessed tuple retrieve a Checkout URL (§8.5).
7. **`EXPIRING` is a persisted status, not an in-memory phase.** It is what keeps
   the slot blocked during the Stripe round trip, so it must survive a restart
   (§5.1, §7.2).
8. **The worker is a second entrypoint, not a second app** (§2.2).
9. **`ui-theme-designer` is not used for the design tokens.** The plugin installed
   in this environment is SAP Fiori-specific — it authors SAP theme parameters such
   as `sapButton_Background` for UI5 and Fundamental Styles components, which have
   no relationship to a Tailwind token system for a Vue app. The beige/black/orange
   token set in `booking-app/packages/ui/src/tokens.css` is authored directly as CSS
   custom properties and mapped to Tailwind semantic names. The build stays
   plugin-independent, which the specification requires regardless.

---

## 12. Assumptions

1. **One organization, seeded, forever in Phase 1.** `DEFAULT_ORGANIZATION_SLUG`
   identifies it. Nothing enumerates organizations.
2. **One Stripe account**, in EUR, with Checkout enabled and webhooks pointed at
   `/api/webhooks/stripe`. Test keys in development, live keys in production, both
   supplied by the operator.
3. **Business hours are the employees' hours.** There is no separate organization
   opening-hours model; `ClosedDay` handles organization-wide closures. If an
   organization-level envelope is wanted later it is an additive model plus one
   more filter in the availability engine.
4. **Employees are the only bookable resource.** No rooms, chairs, or equipment.
5. **Every service is performed by one employee.** No two-therapist treatments.
6. **Prices are gross, VAT-inclusive**, and no invoice document is generated in
   Phase 1. The CSV export is the accounting hand-off.
7. **Deployment is same-origin** behind the reverse proxy in
   `booking-app/infrastructure/nginx/booking.conf`: `/api` to the API, everything
   else to the built SPA. This is what makes `SameSite=Lax` plus a custom header a
   sufficient CSRF defence and CORS unnecessary.
8. **Docker Compose is the deployment target** for Phase 1 — one Postgres, one
   Redis, one API container, one worker container, one static web container. No
   Kubernetes, no managed queue.
9. **PostgreSQL 17 with `btree_gist` available.** The extension is created by the
   migration; the database user therefore needs `CREATE EXTENSION` rights on first
   deploy, which is called out in the deployment checklist.
10. **Redis is not the source of truth for anything.** Sessions and queues live
    there; a full Redis loss logs everyone out and loses queued jobs, and the
    outbox plus the reconcilers rebuild the work.
11. **German is the default customer locale**, English is the alternative, and the
    office UI is English-only. Locale is captured in the booking flow and stored on
    both `Customer` and `Booking`, because a returning customer may switch and the
    notification must follow the booking.
12. **Seed data** creates the organization, an owner, two employees, one service
    category, and two services — "Facial Massage 30 min" and "Regular Massage
    60 min" — with working hours, so the flow is demonstrable immediately after
    `pnpm db:seed`.
13. **The operator supplies** a Resend API key and verified sending domain, and —
    only if SMS is enabled — Twilio credentials and a sender. Both providers have
    in-memory fakes, so local development and every test run without credentials.
---

# Implementation tasks

49 tasks in 12 stages. Every task is small enough to finish in one sitting, ends
with a green test suite, and is independently committable. Every task follows the
same template:

- **Objective** — one sentence.
- **Files** — exact absolute paths, marked `(new)` or `(edit)`.
- **Produces for later tasks** — the exported surface later tasks rely on.
- **Database / API / Frontend changes** — explicitly `none` when there are none.
- **Tests first** — real test code, authored and failing before the
  implementation.
- **Validation scenarios** — the concrete cases the tests must cover.
- **Steps** — `- [ ]` checkboxes.
- **Commands** — copy-pasteable, run from `.`.
- **Expected result** — what "done" looks like.
- **Commit** — the suggested message.

All commands are run from `.` unless stated
otherwise. `pnpm api` and `pnpm web` are shorthand written into the root
`package.json` in Task 0.1 for
`pnpm --filter @shape-and-flow/booking-api` and
`pnpm --filter @shape-and-flow/booking-web`.

---

## Stage 0 — Workspace foundation

### Task 0.1 — Root workspace shell

**Objective.** Turn the greenfield repository into a working pnpm monorepo whose
workspace root is the repository root, with Node and pnpm pinned by the
repository rather than by the machine.

**Files.**
- `pnpm-workspace.yaml` (new)
- `package.json` (new)
- `.npmrc` (new)
- `.tool-versions` (new)
- `.gitignore` (edit)
- `.editorconfig` (new)

**Produces for later tasks.** The workspace globs every later package registers
under, and the delegating script names every later task's commands use.

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.** A shell assertion rather than a unit test, because there is no
runtime yet — this is the one task whose verification is the command output.

**Validation scenarios.**
- [ ] `pnpm --version` reports a 10.x version resolved by Corepack, not a global install.
- [ ] `pnpm -r exec node -e "0"` exits 0 with no packages found (the globs are valid but empty).
- [ ] `node --version` inside the directory reports `v24.18.0`.
- [ ] `git status --porcelain` shows no `node_modules` entry.

**Steps.**
- [ ] Write `.tool-versions` containing `nodejs 24.18.0`.
- [ ] Enable Corepack and pin pnpm: `corepack enable` then `corepack use pnpm@10`.
- [ ] Write `pnpm-workspace.yaml`:
  ```yaml
  packages:
    - 'booking-app/apps/*'
    - 'booking-app/packages/*'
  ```
- [ ] Write the root `package.json`:
  ```json
  {
    "name": "shape-and-flow",
    "private": true,
    "type": "module",
    "packageManager": "pnpm@10.15.0",
    "engines": { "node": ">=24.18.0 <25", "pnpm": ">=10" },
    "scripts": {
      "api": "pnpm --filter @shape-and-flow/booking-api",
      "web": "pnpm --filter @shape-and-flow/booking-web",
      "db:up": "docker compose -f booking-app/docker-compose.yml up -d --wait",
      "db:down": "docker compose -f booking-app/docker-compose.yml down",
      "db:reset": "docker compose -f booking-app/docker-compose.yml down -v && pnpm db:up",
      "db:migrate": "pnpm api prisma:migrate:dev",
      "db:seed": "pnpm api prisma:seed",
      "test:infra:up": "docker compose -f booking-app/docker-compose.test.yml up -d --wait",
      "test:infra:down": "docker compose -f booking-app/docker-compose.test.yml down -v",
      "lint": "pnpm -r lint",
      "format": "pnpm -r format",
      "typecheck": "pnpm -r typecheck",
      "test": "pnpm -r test",
      "test:integration": "pnpm api test:integration",
      "test:e2e": "pnpm web test:e2e",
      "build": "pnpm -r build",
      "dev": "pnpm --parallel --filter @shape-and-flow/booking-api --filter @shape-and-flow/booking-web dev"
    }
  }
  ```
- [ ] Write `.npmrc`:
  ```
  node-linker=isolated
  strict-peer-dependencies=true
  auto-install-peers=true
  resolution-mode=highest
  save-exact=true
  ```
- [ ] Append to `.gitignore`, keeping the three existing lines:
  ```
  node_modules/
  dist/
  build/
  coverage/
  .env
  .env.local
  *.log
  playwright-report/
  test-results/
  .vite/
  .turbo/
  ```
- [ ] Write `.editorconfig` with `indent_style = space`, `indent_size = 2`,
  `end_of_line = lf`, `charset = utf-8`, `insert_final_newline = true`,
  `trim_trailing_whitespace = true`, and `indent_size = 4` for `*.md` overridden
  to 2.
- [ ] Run `pnpm install` to create `pnpm-lock.yaml`.

**Commands.**
```bash
corepack enable
corepack use pnpm@10
pnpm install
pnpm --version
node --version
pnpm -r exec node -e "0"
git status --porcelain
```

**Expected successful result.** `pnpm-lock.yaml` exists, `pnpm --version` prints
`10.15.0`, `node --version` prints `v24.18.0`, `pnpm -r exec` succeeds with no
matched packages, and `git status --porcelain` lists only the new tracked files.

**Commit.** `chore(workspace): pin toolchain and add pnpm workspace root`

---

### Task 0.2 — Shared config package

**Objective.** One place that owns TypeScript, ESLint, Prettier, and Vitest
defaults for every package in `booking-app`, so no package invents its own rules.

**Files.**
- `booking-app/packages/config/package.json` (new)
- `booking-app/packages/config/tsconfig.base.json` (new)
- `booking-app/packages/config/tsconfig.node.json` (new)
- `booking-app/packages/config/tsconfig.vue.json` (new)
- `booking-app/packages/config/eslint.config.js` (new)
- `booking-app/packages/config/prettier.config.js` (new)
- `booking-app/packages/config/vitest.base.ts` (new)

**Produces for later tasks.**

```ts
// consumed as:
//   tsconfig.json      → { "extends": "@shape-and-flow/booking-config/tsconfig.node.json" }
//   eslint.config.js   → export { default } from '@shape-and-flow/booking-config/eslint'
//   vitest.config.ts   → import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest'
export const baseVitestConfig: UserConfig
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.** The verification for a config package is that a deliberately bad
file is rejected. Create a scratch file that violates each rule, confirm the
tooling flags it, then delete it.

**Validation scenarios.**
- [ ] `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`,
  `moduleResolution: "NodeNext"`, `target: "ES2023"`, `isolatedModules`.
- [ ] ESLint reports an error for a floating promise, an `any`, an unused import,
  and a `$queryRawUnsafe` call.
- [ ] Prettier rewrites a 120-column line and single-quotes a double-quoted string.
- [ ] `baseVitestConfig` sets `globals: false`, `restoreMocks: true`,
  `coverage.provider: 'v8'`, and `coverage.thresholds.lines: 80`.

**Steps.**
- [ ] Create `package.json` named `@shape-and-flow/booking-config`, `private: true`,
  `type: module`, with an `exports` map for `./tsconfig.base.json`,
  `./tsconfig.node.json`, `./tsconfig.vue.json`, `./eslint`, `./prettier`,
  `./vitest`.
- [ ] Add dev dependencies: `typescript`, `eslint`, `@eslint/js`,
  `typescript-eslint`, `eslint-plugin-import-x`, `eslint-plugin-vue`,
  `eslint-config-prettier`, `prettier`, `vitest`, `@vitest/coverage-v8`.
- [ ] Write `tsconfig.base.json` with the compiler options above plus
  `skipLibCheck: true`, `declaration: true`, `declarationMap: true`,
  `sourceMap: true`, `noEmitOnError: true`.
- [ ] Write `tsconfig.node.json` extending the base with `module: "NodeNext"`,
  `lib: ["ES2023"]`, `types: ["node"]`, `experimentalDecorators: true`,
  `emitDecoratorMetadata: true` (NestJS requires both).
- [ ] Write `tsconfig.vue.json` extending the base with `lib: ["ES2023", "DOM",
  "DOM.Iterable"]`, `jsx: "preserve"`, `moduleResolution: "Bundler"`,
  `noEmit: true`.
- [ ] Write `eslint.config.js` as a flat config array: `js.configs.recommended`,
  `tseslint.configs.strictTypeChecked`, `tseslint.configs.stylisticTypeChecked`,
  `importX.flatConfigs.recommended`, `eslintConfigPrettier`, then a rules block
  enabling `@typescript-eslint/no-floating-promises`,
  `@typescript-eslint/no-misused-promises`,
  `@typescript-eslint/consistent-type-imports`,
  `import-x/order` with alphabetised groups, and a `no-restricted-syntax` rule:
  ```js
  {
    selector: "MemberExpression[property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]",
    message: 'Raw unsafe SQL is banned. Use Prisma.sql tagged templates.'
  }
  ```
  plus `no-restricted-properties` banning `process.env`. Apply file-glob
  overrides (the rule itself cannot express path exceptions) for the validated
  `**/src/config/env.schema.ts`, build/test `**/*.config.{ts,js,mjs}` files,
  `**/prisma/seed.ts`, `**/test/**`, and `**/e2e/**`. Application modules,
  including `config.module.ts`, consume the validated `ENV` provider instead.
- [ ] Write `prettier.config.js`: `printWidth: 100`, `singleQuote: true`,
  `semi: true`, `trailingComma: 'all'`, `arrowParens: 'always'`.
- [ ] Write `vitest.base.ts` exporting `baseVitestConfig`.
- [ ] Run `pnpm install` so the workspace links the package.

**Commands.**
```bash
pnpm install
pnpm --filter @shape-and-flow/booking-config exec tsc --showConfig -p booking-app/packages/config/tsconfig.node.json
```

**Expected successful result.** `pnpm install` links
`@shape-and-flow/booking-config`, and `tsc --showConfig` prints a resolved
configuration with `strict: true` and `noUncheckedIndexedAccess: true`.

**Commit.** `chore(config): add shared typescript, eslint, prettier and vitest config`

---

### Task 0.3 — Local and test infrastructure

**Objective.** Two isolated Compose stacks — development and test — on distinct
ports and distinct project names, so a test run can never touch the development
database and a future second product cannot collide with either.

**Files.**
- `booking-app/docker-compose.yml` (new)
- `booking-app/docker-compose.test.yml` (new)
- `booking-app/.env.example` (new)

**Produces for later tasks.** `DATABASE_URL` and `REDIS_URL` values every later
task's commands assume:

```
development: postgresql://booking:booking@localhost:5433/booking?schema=public
             redis://localhost:6380
test:        postgresql://booking:booking@localhost:5434/booking_test?schema=public
             redis://localhost:6381
```

**Database changes.** Creates the database servers, no schema yet.
**API changes.** None. **Frontend changes.** None.

**Tests first.** Health checks in the Compose files are the test — `--wait` fails
the command if a container is unhealthy.

**Validation scenarios.**
- [ ] `pnpm db:up` reports both containers healthy within 30 seconds.
- [ ] `pnpm test:infra:up` starts a second, independent pair on 5434 and 6381.
- [ ] Both stacks run simultaneously without a port or container-name conflict.
- [ ] `psql -c "SELECT 1"` succeeds against 5433 and 5434.
- [ ] The Postgres image includes `btree_gist` (`SELECT * FROM pg_available_extensions WHERE name='btree_gist'` returns a row).

**Steps.**
- [ ] Write `docker-compose.yml` with `name: shape-and-flow-booking` and two
  services:
  ```yaml
  name: shape-and-flow-booking

  services:
    postgres:
      image: postgres:17-alpine
      container_name: shape-and-flow-booking-postgres
      environment:
        POSTGRES_USER: booking
        POSTGRES_PASSWORD: booking
        POSTGRES_DB: booking
      ports: ['5433:5432']
      volumes: ['booking-postgres-data:/var/lib/postgresql/data']
      healthcheck:
        test: ['CMD-SHELL', 'pg_isready -U booking -d booking']
        interval: 3s
        timeout: 3s
        retries: 10
    redis:
      image: redis:7-alpine
      container_name: shape-and-flow-booking-redis
      command: ['redis-server', '--appendonly', 'yes']
      ports: ['6380:6379']
      volumes: ['booking-redis-data:/data']
      healthcheck:
        test: ['CMD', 'redis-cli', 'ping']
        interval: 3s
        timeout: 3s
        retries: 10

  volumes:
    booking-postgres-data:
    booking-redis-data:
  ```
- [ ] Write `docker-compose.test.yml` with `name: shape-and-flow-booking-test`,
  ports `5434:5432` and `6381:6379`, database `booking_test`, **`tmpfs` instead of
  a named volume** for Postgres data plus
  `command: ['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off']`,
  because a test database that survives a reboot is a liability and durability is
  worthless here.
- [ ] Write `.env.example` covering every variable the schema in Task 1.1 will
  require, each with a comment and a safe placeholder:
  ```
  # ── runtime ──────────────────────────────────────────────────────────────
  NODE_ENV=development
  APP_ROLE=api                     # api | worker  (asserted at bootstrap)
  PORT=3000
  LOG_LEVEL=debug

  # ── data stores ──────────────────────────────────────────────────────────
  DATABASE_URL=postgresql://booking:booking@localhost:5433/booking?schema=public
  REDIS_URL=redis://localhost:6380

  # ── tenancy ──────────────────────────────────────────────────────────────
  DEFAULT_ORGANIZATION_SLUG=shape-and-flow

  # ── public web ───────────────────────────────────────────────────────────
  PUBLIC_WEB_ORIGIN=http://localhost:5173
  PUBLIC_API_ORIGIN=http://localhost:3000

  # ── stripe ───────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY=sk_test_replace_me
  STRIPE_WEBHOOK_SECRET=whsec_replace_me

  # ── email ────────────────────────────────────────────────────────────────
  EMAIL_PROVIDER=fake              # fake | resend
  EMAIL_FROM_ADDRESS=buchung@example.com
  EMAIL_FROM_NAME=Shape and Flow
  RESEND_API_KEY=re_replace_me
  RESEND_WEBHOOK_SECRET=whsec_replace_me

  # ── sms ──────────────────────────────────────────────────────────────────
  SMS_PROVIDER=fake                # fake | twilio
  TWILIO_ACCOUNT_SID=AC_replace_me
  TWILIO_AUTH_TOKEN=replace_me
  TWILIO_FROM_NUMBER=+4915100000000
  TWILIO_STATUS_CALLBACK_URL=http://localhost:3000/api/webhooks/twilio

  # ── payments abstraction ─────────────────────────────────────────────────
  PAYMENT_PROVIDER=fake            # fake | stripe

  # ── security ─────────────────────────────────────────────────────────────
  SESSION_COOKIE_NAME=sf_office_session
  SESSION_IDLE_TTL_MINUTES=720
  SESSION_ABSOLUTE_TTL_MINUTES=10080
  OUTBOX_ENCRYPTION_KEY=base64_32_byte_key
  ENABLE_API_DOCS=true
  ```
- [ ] Add a comment block at the top of `.env.example` stating that `.env` is
  git-ignored and that `booking-app/.env` is the file the API reads.

**Commands.**
```bash
pnpm db:up
pnpm test:infra:up
docker compose -f booking-app/docker-compose.yml ps
docker compose -f booking-app/docker-compose.test.yml ps
docker exec shape-and-flow-booking-postgres psql -U booking -d booking \
  -c "SELECT name FROM pg_available_extensions WHERE name = 'btree_gist';"
```

**Expected successful result.** Four containers running and healthy on four
distinct ports; the extension query returns one row named `btree_gist`.

**Commit.** `chore(infra): add development and test compose stacks`

---

### Task 0.4 — Continuous integration

**Objective.** One workflow that runs the same commands a developer runs, in the
same order, against real Postgres and Redis services.

**Files.**
- `.github/workflows/ci.yml` (new)

**Produces for later tasks.** The job names later tasks extend
(`lint`, `test`, `integration`, `e2e`, `build`).

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.** The workflow is verified by pushing a branch with a deliberately
failing lint rule and confirming the job goes red, then removing it.

**Validation scenarios.**
- [ ] A formatting violation fails the `lint` job.
- [ ] A type error fails the `lint` job at the typecheck step.
- [ ] A failing unit test fails the `test` job.
- [ ] The `integration` job reaches Postgres over the service container.
- [ ] `pnpm install --frozen-lockfile` fails if `pnpm-lock.yaml` is stale.

**Steps.**
- [ ] Write the workflow triggered on `push` to `main` and on `pull_request`, with
  `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`.
- [ ] Add a reusable setup composite: `actions/checkout@v4`,
  `pnpm/action-setup@v4`, `actions/setup-node@v4` with `node-version-file:
  .tool-versions` and `cache: pnpm`, then `pnpm install --frozen-lockfile`.
- [ ] Job `lint`: `pnpm lint` then `pnpm typecheck`.
- [ ] Job `test`: `pnpm test -- --coverage`, uploading coverage as an artifact.
- [ ] Job `integration` with `services: postgres:17` (env user/password/db
  `booking`/`booking`/`booking_test`, `--health-cmd pg_isready`) and `redis:7`
  (`--health-cmd "redis-cli ping"`), env
  `DATABASE_URL=postgresql://booking:booking@localhost:5432/booking_test?schema=public`
  and `REDIS_URL=redis://localhost:6379`; steps `pnpm api prisma:migrate:deploy`
  then `pnpm test:integration`.
- [ ] Job `e2e` provisions its own Postgres and Redis services, applies
  migrations, starts the API and web app, installs Playwright browsers with
  `--with-deps chromium`, runs `pnpm test:e2e`, and uploads
  `playwright-report/` on failure. It does not depend on another job's service
  containers, which are job-local and cannot be shared.
- [ ] Job `build` `needs: [lint, test]`: `pnpm build`.
- [ ] Add `permissions: { contents: read }` at the workflow level.

**Commands.**
```bash
gh workflow list
gh run list --limit 1
```

**Expected successful result.** All five jobs green on `main`; total runtime under
ten minutes.

**Commit.** `ci: add lint, test, integration, e2e and build pipeline`
---

## Stage 1 — Persistence and tenancy

### Task 1.1 — API skeleton, validated configuration, Prisma bootstrap

**Objective.** A NestJS application that starts, refuses to start on a bad
environment, exposes `/api/health/live`, and has a Prisma client wired to the
development database — with Vitest configured for unit tests.

**Files.**
- `booking-app/apps/api/package.json` (new)
- `booking-app/apps/api/tsconfig.json` (new)
- `booking-app/apps/api/eslint.config.js` (new)
- `booking-app/apps/api/nest-cli.json` (new)
- `booking-app/apps/api/vitest.config.ts` (new)
- `booking-app/apps/api/test/setup.unit.ts` (new)
- `booking-app/apps/api/src/main.ts` (new)
- `booking-app/apps/api/src/app.module.ts` (new)
- `booking-app/apps/api/src/config/env.schema.ts` (new)
- `booking-app/apps/api/src/config/config.module.ts` (new)
- `booking-app/apps/api/src/prisma/prisma.service.ts` (new)
- `booking-app/apps/api/src/prisma/prisma.module.ts` (new)
- `booking-app/apps/api/src/health/health.controller.ts` (new)
- `booking-app/apps/api/src/health/health.module.ts` (new)
- `booking-app/apps/api/prisma/schema.prisma` (new, datasource and generator only)

**Produces for later tasks.**

```ts
export type AppConfig = z.infer<typeof envSchema>;
export const ENV = 'ENV_CONFIG';                    // injection token
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {}
```

**Database changes.** An empty schema with `datasource` and `generator` blocks; no
models yet. **API changes.** `GET /api/health/live`. **Frontend changes.** None.

**Tests first.**

```ts
// booking-app/apps/api/src/config/env.schema.spec.ts
import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

const valid = {
  NODE_ENV: 'test',
  APP_ROLE: 'api',
  PORT: '3000',
  LOG_LEVEL: 'error',
  DATABASE_URL: 'postgresql://booking:booking@localhost:5434/booking_test?schema=public',
  REDIS_URL: 'redis://localhost:6381',
  DEFAULT_ORGANIZATION_SLUG: 'shape-and-flow',
  PUBLIC_WEB_ORIGIN: 'http://localhost:5173',
  PUBLIC_API_ORIGIN: 'http://localhost:3000',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  EMAIL_PROVIDER: 'fake',
  EMAIL_FROM_ADDRESS: 'buchung@example.com',
  EMAIL_FROM_NAME: 'Shape and Flow',
  SMS_PROVIDER: 'fake',
  PAYMENT_PROVIDER: 'fake',
  SESSION_COOKIE_NAME: 'sf_office_session',
  SESSION_IDLE_TTL_MINUTES: '720',
  SESSION_ABSOLUTE_TTL_MINUTES: '10080',
  OUTBOX_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ENABLE_API_DOCS: 'false',
};

describe('envSchema', () => {
  it('coerces numeric strings to numbers', () => {
    const parsed = envSchema.parse(valid);
    expect(parsed.PORT).toBe(3000);
    expect(parsed.SESSION_IDLE_TTL_MINUTES).toBe(720);
  });

  it('rejects an unknown APP_ROLE and names the variable', () => {
    const result = envSchema.safeParse({ ...valid, APP_ROLE: 'both' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toContain('APP_ROLE');
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(envSchema.safeParse({ ...valid, DATABASE_URL: 'mysql://x' }).success).toBe(false);
  });

  it('requires RESEND_API_KEY when EMAIL_PROVIDER is resend', () => {
    const result = envSchema.safeParse({ ...valid, EMAIL_PROVIDER: 'resend' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes('RESEND_API_KEY'))).toBe(true);
  });

  it('requires Twilio credentials when SMS_PROVIDER is twilio', () => {
    const result = envSchema.safeParse({ ...valid, SMS_PROVIDER: 'twilio' });
    expect(result.success).toBe(false);
  });

  it('reports every missing variable at once rather than the first', () => {
    const result = envSchema.safeParse({ NODE_ENV: 'test' });
    expect((result.error?.issues.length ?? 0)).toBeGreaterThan(5);
  });
});
```

```ts
// booking-app/apps/api/src/config/env-example.spec.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

describe('.env.example', () => {
  it('documents exactly the variables the schema knows about', () => {
    const text = readFileSync(
      new URL('../../../../.env.example', import.meta.url),
      'utf8',
    );
    const documented = new Set(
      text
        .split('\n')
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => line.split('=')[0]),
    );
    const declared = new Set(Object.keys(envSchema.shape));
    expect([...declared].filter((k) => !documented.has(k))).toEqual([]);
    expect([...documented].filter((k) => !declared.has(k))).toEqual([]);
  });
});
```

**Validation scenarios.**
- [ ] Numeric strings are coerced; `PORT` is a `number` at the type level.
- [ ] An unknown `APP_ROLE` fails and the issue path names `APP_ROLE`.
- [ ] A non-`postgresql://` `DATABASE_URL` fails.
- [ ] `EMAIL_PROVIDER=resend` without `RESEND_API_KEY` fails with a message naming the key.
- [ ] `SMS_PROVIDER=twilio` without SID, token, and sender fails.
- [ ] Settings validation rejects `freeCancellationHours` outside `0..720` and
  `dataRetentionDays` outside `30..3650`, matching the database `CHECK`.
- [ ] An almost-empty environment reports more than five issues in one pass.
- [ ] `.env.example` and the schema declare exactly the same key set.
- [ ] `GET /api/health/live` returns `200 { "status": "ok" }` with no database access.

**Steps.**
- [ ] Create `package.json` for `@shape-and-flow/booking-api`: `type: module`,
  scripts `dev` (`nest start --watch`), `build` (`nest build`), `start`
  (`node dist/main.js`), `start:worker` (`node dist/worker.main.js`), `lint`,
  `format`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`),
  `test:integration` (`vitest run --config vitest.integration.config.ts`),
  `prisma:generate`, `prisma:migrate:dev`, `prisma:migrate:deploy`,
  `prisma:seed`.
- [ ] Add dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`,
  `@nestjs/config`, `@nestjs/terminus`, `@prisma/client`, `zod`, `nestjs-zod`,
  `pino`, `nestjs-pino`, `helmet`, `reflect-metadata`, `rxjs`; dev dependencies
  `@nestjs/cli`, `@nestjs/testing`, `prisma`, `supertest`, `@types/supertest`,
  `@types/node`, `@shape-and-flow/booking-config`.
- [ ] Write `tsconfig.json` extending
  `@shape-and-flow/booking-config/tsconfig.node.json`, `outDir: dist`,
  `rootDir: src`.
- [ ] Write `env.schema.ts` as a `z.object` with `z.coerce.number()` for numeric
  variables, `z.enum` for `NODE_ENV`, `APP_ROLE`, `LOG_LEVEL`, `EMAIL_PROVIDER`,
  `SMS_PROVIDER`, `PAYMENT_PROVIDER`, a `.startsWith('postgresql://')` refinement
  on `DATABASE_URL`, `.url()` on the origins, and three `superRefine` blocks that
  demand provider credentials when the matching provider is not `fake`. Export
  `type AppConfig`.
- [ ] Write `config.module.ts` as a global module that parses `process.env` once
  with `envSchema.safeParse`, and on failure logs every issue as
  `VARIABLE: message` and calls `process.exit(1)`. This is the **only** file
  permitted to read `process.env`, enforced by the ESLint rule from Task 0.2.
- [ ] Write `prisma/schema.prisma` with only:
  ```prisma
  generator client {
    provider            = "prisma-client"
    output              = "../src/generated/prisma"
    moduleFormat        = "esm"
    importFileExtension = "js"
  }

  datasource db {
    provider = "postgresql"
  }
  ```
  Prisma 7 reads the migration URL from `prisma.config.ts`; runtime clients use
  `@prisma/adapter-pg` with the validated `DATABASE_URL` rather than a datasource
  URL embedded in the schema.
- [ ] Write `prisma.service.ts` extending `PrismaClient`, calling `$connect()` in
  `onModuleInit` and `$disconnect()` in `onModuleDestroy`, with `log` levels driven
  by `LOG_LEVEL`.
- [ ] Write `main.ts`: create the Nest app with `bufferLogs: true`, set the global
  prefix `api`, apply `helmet()`, `app.enableShutdownHooks()`,
  `app.set('trust proxy', 1)`, assert `APP_ROLE === 'api'` and exit non-zero
  otherwise, then listen on `PORT`.
- [ ] Write `health.controller.ts` returning `{ status: 'ok' }` from
  `GET health/live` with no injected dependencies.
- [ ] Write `vitest.config.ts` importing `baseVitestConfig`, `include:
  ['src/**/*.spec.ts']`, `setupFiles: ['./test/setup.unit.ts']`.
- [ ] Write `test/setup.unit.ts` importing `reflect-metadata` and freezing a fixed
  clock helper export for later tasks.

**Commands.**
```bash
pnpm install
pnpm api prisma:generate
pnpm api typecheck
pnpm api test
pnpm db:up
pnpm api dev &
curl -fsS http://localhost:3000/api/health/live
kill %1
```

**Expected successful result.** All config tests pass, `typecheck` is clean, the
app boots, `/api/health/live` returns `{"status":"ok"}`, and deleting
`DATABASE_URL` from `booking-app/.env` makes the process exit 1 with
`DATABASE_URL: Required` on stderr.

**Commit.** `feat(api): bootstrap nest app with validated configuration and prisma client`

---

### Task 1.2 — Prisma schema: all twenty-nine models

**Objective.** Transcribe §4 into `schema.prisma` and produce the initial
migration, so every later task has real tables to work against.

**Files.**
- `booking-app/apps/api/prisma/schema.prisma` (edit)
- `booking-app/apps/api/prisma/migrations/20260801000000_init/migration.sql` (generated, then reviewed)

**Produces for later tasks.** The generated Prisma client types — every service,
contract, and test from here on imports model and enum types from
`@prisma/client`.

**Database changes.** All 29 tables, all 18 enums, every index and unique
constraint listed in §4.4. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// booking-app/apps/api/src/prisma/schema.contract.spec.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);

const EXPECTED = [
  'Organization', 'OrganizationSettings', 'ClosedDay', 'OfficeUser', 'PasswordResetToken',
  'Employee', 'WorkingHours', 'Break', 'AvailabilityException', 'TimeOff', 'BlockedTime',
  'ServiceCategory', 'Service', 'EmployeeService', 'Customer', 'Booking',
  'BookingStatusHistory', 'ManagementToken', 'Payment', 'ManualPayment', 'Refund',
  'CancellationRequest', 'RescheduleRequest', 'Notification', 'OutboxEvent',
  'IdempotencyKey', 'StripeWebhookEvent', 'MessagingWebhookEvent', 'AuditLog',
];

// Models that legitimately have no organizationId column.
const UNSCOPED = new Set(['Organization']);
// Models whose organizationId is nullable because the row can precede tenant resolution.
const OPTIONAL_SCOPE = new Set(['IdempotencyKey', 'StripeWebhookEvent', 'MessagingWebhookEvent']);

function blockOf(model: string): string {
  const match = schema.match(new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm'));
  if (!match) throw new Error(`model ${model} not found`);
  return match[1]!;
}

describe('schema.prisma', () => {
  it('declares exactly the twenty-nine planned models', () => {
    expect(models.sort()).toEqual([...EXPECTED].sort());
  });

  it('scopes every scoped model by organizationId', () => {
    for (const model of models) {
      if (UNSCOPED.has(model)) continue;
      const body = blockOf(model);
      expect(body, model).toMatch(/organizationId\s+String/);
      if (OPTIONAL_SCOPE.has(model)) expect(body, model).toMatch(/organizationId\s+String\?/);
      else expect(body, model).not.toMatch(/organizationId\s+String\?/);
    }
  });

  it('stores every instant as timestamptz', () => {
    const naive = [...schema.matchAll(/^\s*(\w+)\s+DateTime(\?)?\s*(?!.*(@db\.Timestamptz|@db\.Date))(.*)$/gm)];
    expect(naive.map((m) => m[1])).toEqual([]);
  });

  it('names every money column in cents and types it Int', () => {
    const moneyish = [...schema.matchAll(/^\s*(\w*(?:amount|price|Cents)\w*)\s+(\w+)/gim)];
    for (const [, name, type] of moneyish) {
      if (/Cents$/.test(name!)) expect(type, name).toBe('Int');
    }
  });

  it('never cascades a delete into a money table', () => {
    for (const model of ['Payment', 'ManualPayment', 'Refund']) {
      expect(blockOf(model), model).not.toMatch(/onDelete:\s*Cascade/);
    }
  });
});
```

**Validation scenarios.**
- [ ] Exactly the 29 named models exist — no extras, none missing.
- [ ] Every model except `Organization` has `organizationId`; exactly the three
  documented ones have it nullable.
- [ ] No `DateTime` column lacks `@db.Timestamptz(3)` or `@db.Date`.
- [ ] Every `…Cents` column is `Int`.
- [ ] `Payment`, `ManualPayment`, and `Refund` have no cascading relation.
- [ ] `prisma validate` passes and `prisma migrate dev` produces one migration.
- [ ] `prisma migrate diff --from-migrations --to-schema-datamodel` reports no drift.

**Steps.**
- [ ] Add all 18 enums exactly as listed in §4.2.
- [ ] Add each model with the fields, relations, indexes, and unique constraints
  from §4.3, using `@@map` to snake_case table names and `@map` on every camelCase
  column. Work through them in dependency order, one checkbox each:
  - [ ] `Organization`
  - [ ] `OrganizationSettings`
  - [ ] `ClosedDay`
  - [ ] `OfficeUser`
  - [ ] `PasswordResetToken`
  - [ ] `Employee`
  - [ ] `WorkingHours`
  - [ ] `Break`
  - [ ] `AvailabilityException`
  - [ ] `TimeOff`
  - [ ] `BlockedTime`
  - [ ] `ServiceCategory`
  - [ ] `Service`
  - [ ] `EmployeeService`
  - [ ] `Customer`
  - [ ] `Booking`
  - [ ] `BookingStatusHistory`
  - [ ] `ManagementToken`
  - [ ] `Payment`
  - [ ] `ManualPayment`
  - [ ] `Refund`
  - [ ] `CancellationRequest`
  - [ ] `RescheduleRequest`
  - [ ] `Notification`
  - [ ] `OutboxEvent`
  - [ ] `IdempotencyKey`
  - [ ] `StripeWebhookEvent`
  - [ ] `MessagingWebhookEvent`
  - [ ] `AuditLog`
- [ ] Use these two as the pattern for every other model:
  ```prisma
  model Organization {
    id              String   @id @default(cuid())
    slug            String   @unique
    name            String
    legalName       String   @map("legal_name")
    contactEmail    String   @map("contact_email")
    contactPhone    String   @map("contact_phone")
    whatsappNumber  String?  @map("whatsapp_number")
    addressLine1    String   @map("address_line1")
    addressLine2    String?  @map("address_line2")
    postalCode      String   @map("postal_code")
    city            String
    country         String   @default("DE")
    timezone        String   @default("Europe/Berlin")
    currency        String   @default("EUR")
    defaultLocale   Locale   @default(de) @map("default_locale")
    stripeAccountId String?  @map("stripe_account_id")
    createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
    updatedAt       DateTime @updatedAt      @map("updated_at") @db.Timestamptz(3)

    settings  OrganizationSettings?
    employees Employee[]
    services  Service[]
    customers Customer[]
    bookings  Booking[]

    @@map("organizations")
  }

  model Booking {
    id                          String        @id @default(cuid())
    organizationId              String        @map("organization_id")
    reference                   String
    origin                      BookingOrigin
    customerId                  String        @map("customer_id")
    employeeId                  String        @map("employee_id")
    serviceId                   String        @map("service_id")
    startsAt                    DateTime      @map("starts_at")        @db.Timestamptz(3)
    endsAt                      DateTime      @map("ends_at")          @db.Timestamptz(3)
    blockStartsAt               DateTime      @map("block_starts_at")  @db.Timestamptz(3)
    blockEndsAt                 DateTime      @map("block_ends_at")    @db.Timestamptz(3)
    serviceNameSnapshot         String        @map("service_name_snapshot")
    durationMinutesSnapshot     Int           @map("duration_minutes_snapshot")
    prepBufferMinutesSnapshot   Int           @map("prep_buffer_minutes_snapshot")
    cleanupBufferMinutesSnapshot Int          @map("cleanup_buffer_minutes_snapshot")
    priceCentsSnapshot          Int           @map("price_cents_snapshot")
    currency                    String
    status                      BookingStatus
    expiresAt                   DateTime?     @map("expires_at")   @db.Timestamptz(3)
    confirmedAt                 DateTime?     @map("confirmed_at") @db.Timestamptz(3)
    canceledAt                  DateTime?     @map("canceled_at")  @db.Timestamptz(3)
    completedAt                 DateTime?     @map("completed_at") @db.Timestamptz(3)
    stripeCheckoutSessionId     String?       @unique @map("stripe_checkout_session_id")
    idempotencyKeyId            String?       @unique @map("idempotency_key_id")
    customerNote                String?       @map("customer_note")
    locale                      Locale
    rescheduledFromBookingId    String?       @map("rescheduled_from_booking_id")
    createdByOfficeUserId       String?       @map("created_by_office_user_id")
    canceledByOfficeUserId      String?       @map("canceled_by_office_user_id")
    cancellationReason          String?       @map("cancellation_reason")
    createdAt                   DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
    updatedAt                   DateTime      @updatedAt      @map("updated_at") @db.Timestamptz(3)

    organization        Organization @relation(fields: [organizationId], references: [id])
    customer            Customer     @relation(fields: [organizationId, customerId], references: [organizationId, id], onDelete: Restrict)
    employee            Employee     @relation(fields: [organizationId, employeeId], references: [organizationId, id], onDelete: Restrict)
    service             Service      @relation(fields: [organizationId, serviceId], references: [organizationId, id], onDelete: Restrict)
    rescheduledFrom     Booking?     @relation("BookingReschedule", fields: [organizationId, rescheduledFromBookingId], references: [organizationId, id], onDelete: Restrict)
    rescheduledTo       Booking?     @relation("BookingReschedule")
    statusHistory       BookingStatusHistory[]
    payments            Payment[]
    manualPayments      ManualPayment[]
    refunds             Refund[]
    managementTokens    ManagementToken[]

    notifications       Notification[]
    cancellationRequests CancellationRequest[]
    rescheduleRequests  RescheduleRequest[]

    @@unique([organizationId, id])
    @@unique([organizationId, reference])
    @@unique([organizationId, rescheduledFromBookingId])
    @@index([organizationId, employeeId, blockStartsAt])
    @@index([organizationId, status, startsAt])
    @@index([organizationId, customerId, startsAt])
    @@index([organizationId, status, blockStartsAt, blockEndsAt])
    @@index([status, expiresAt])
    @@map("bookings")
  }
  ```
  `Customer`, `Employee`, and `Service` likewise declare
  `@@unique([organizationId, id])`, which is the referenced side of the three
  tenant-consistent composite foreign keys.
- [ ] Run `prisma format`, then `prisma validate`.
- [ ] Generate the migration with
  `prisma migrate dev --name init --create-only`, read the SQL, confirm every
  index in §4.4 is present, then apply it.
- [ ] Run the schema contract test until green.

**Commands.**
```bash
pnpm db:up
pnpm api exec prisma format
pnpm api exec prisma validate
pnpm api exec prisma migrate dev --name init --create-only
pnpm api exec prisma migrate dev
pnpm api prisma:generate
pnpm api test -- src/prisma/schema.contract.spec.ts
pnpm api exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://booking:booking@localhost:5433/booking_shadow?schema=public" \
  --exit-code
```

**Expected successful result.** 29 tables exist, the contract test is green, and
`migrate diff --exit-code` exits 0, proving the migration and the schema agree.

**Commit.** `feat(db): add complete phase 1 prisma schema and initial migration`

---

### Task 1.3 — Calendar constraints, CHECK constraints, and the integration harness

**Objective.** Add the exclusion constraints, range checks, partial unique
indexes, and value `CHECK`s that make double-booking impossible at the database
level — and build the integration-test harness that proves it against a real
PostgreSQL.

**Files.**
- `booking-app/apps/api/prisma/migrations/20260801000100_calendar_constraints/migration.sql` (new, hand-written)
- `booking-app/apps/api/vitest.integration.config.ts` (new)
- `booking-app/apps/api/test/setup.integration.ts` (new)
- `booking-app/apps/api/test/database.harness.ts` (new)
- `booking-app/apps/api/test/factories/index.ts` (new)
- `booking-app/apps/api/src/common/prisma-errors/prisma-errors.ts` (new)
- `booking-app/apps/api/src/booking/booking-status.machine.ts` (new)

**Produces for later tasks.**

```ts
export const BLOCKING_BOOKING_STATUSES = [
  BookingStatus.PENDING_PAYMENT, BookingStatus.EXPIRING, BookingStatus.CONFIRMED,
] as const;
export const CALENDAR_LOCK_CLASS_ID = 4711;
export function isExclusionViolation(err: unknown, constraintName?: string): boolean;
export function isSerializationFailure(err: unknown): boolean;
export function isUniqueViolation(err: unknown, target?: string): boolean;
export function assertTransition(from: BookingStatus | null, to: BookingStatus): void;
// test harness
export async function withTestDatabase(): Promise<{ prisma: PrismaService; reset(): Promise<void> }>;
```

**Database changes.** Two exclusion constraints, four range `CHECK`s, two partial
unique indexes, and the value `CHECK`s from §4.3.
**API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// booking-app/apps/api/test/integration/calendar-constraints.int.spec.ts
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isExclusionViolation } from '../../src/common/prisma-errors/prisma-errors.js';
import { BLOCKING_BOOKING_STATUSES } from '../../src/booking/booking-status.machine.js';
import { seedOrganization, makeBooking } from '../factories/index.js';

const prisma = new PrismaClient();
let ctx: Awaited<ReturnType<typeof seedOrganization>>;

beforeEach(async () => {
  ctx = await seedOrganization(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

const at = (iso: string) => new Date(iso);

describe('bookings_no_overlap', () => {
  it('rejects an overlapping booking for the same employee', async () => {
    await prisma.booking.create({
      data: makeBooking(ctx, { blockStartsAt: at('2026-08-14T07:00:00Z'), blockEndsAt: at('2026-08-14T07:30:00Z') }),
    });
    let caught: unknown;
    try {
      await prisma.booking.create({
        data: makeBooking(ctx, { blockStartsAt: at('2026-08-14T07:15:00Z'), blockEndsAt: at('2026-08-14T07:45:00Z') }),
      });
    } catch (err) {
      caught = err;
    }
    expect(isExclusionViolation(caught, 'bookings_no_overlap')).toBe(true);
  });

  it('allows back-to-back bookings because bounds are [)', async () => {
    await prisma.booking.create({
      data: makeBooking(ctx, { blockStartsAt: at('2026-08-14T07:00:00Z'), blockEndsAt: at('2026-08-14T07:30:00Z') }),
    });
    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, { blockStartsAt: at('2026-08-14T07:30:00Z'), blockEndsAt: at('2026-08-14T08:00:00Z') }),
      }),
    ).resolves.toBeDefined();
  });

  it('allows the same range for a different employee', async () => {
    await prisma.booking.create({
      data: makeBooking(ctx, { blockStartsAt: at('2026-08-14T07:00:00Z'), blockEndsAt: at('2026-08-14T07:30:00Z') }),
    });
    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          employeeId: ctx.secondEmployee.id,
          blockStartsAt: at('2026-08-14T07:00:00Z'),
          blockEndsAt: at('2026-08-14T07:30:00Z'),
        }),
      }),
    ).resolves.toBeDefined();
  });

  it('ignores non-blocking statuses', async () => {
    for (const status of ['EXPIRED', 'PAYMENT_FAILED', 'CANCELED_BY_CUSTOMER', 'CANCELED_BY_BUSINESS', 'COMPLETED', 'NO_SHOW'] as const) {
      await prisma.booking.create({
        data: makeBooking(ctx, { status, blockStartsAt: at('2026-08-15T07:00:00Z'), blockEndsAt: at('2026-08-15T07:30:00Z') }),
      });
    }
    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, { blockStartsAt: at('2026-08-15T07:00:00Z'), blockEndsAt: at('2026-08-15T07:30:00Z') }),
      }),
    ).resolves.toBeDefined();
  });

  it.each(BLOCKING_BOOKING_STATUSES)('blocks when the existing booking is %s', async (status) => {
    await prisma.booking.create({
      data: makeBooking(ctx, { status, blockStartsAt: at('2026-08-16T07:00:00Z'), blockEndsAt: at('2026-08-16T07:30:00Z') }),
    });
    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, { blockStartsAt: at('2026-08-16T07:10:00Z'), blockEndsAt: at('2026-08-16T07:40:00Z') }),
      }),
    ).rejects.toSatisfy((err: unknown) => isExclusionViolation(err, 'bookings_no_overlap'));
  });

  it('rejects a zero-length range via the CHECK, not silently allowing duplicates', async () => {
    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, { blockStartsAt: at('2026-08-17T07:00:00Z'), blockEndsAt: at('2026-08-17T07:00:00Z') }),
      }),
    ).rejects.toThrow(/bookings_block_range_check/);
  });
});

describe('constraint inventory', () => {
  it('keeps every calendar constraint present after migrate deploy', async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'bookings_no_overlap', 'bookings_block_range_check',
        'blocked_times_no_overlap', 'blocked_times_range_check'
      )`;
    expect(rows.map((r) => r.conname).sort()).toEqual([
      'blocked_times_no_overlap', 'blocked_times_range_check',
      'bookings_block_range_check', 'bookings_no_overlap',
    ]);
  });

  it('keeps the constraint predicate and the TypeScript constant in agreement', async () => {
    const [row] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bookings_no_overlap'`;
    for (const status of BLOCKING_BOOKING_STATUSES) {
      expect(row!.def).toContain(`'${status}'`);
    }
    const quoted = [...row!.def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(new Set(quoted)).toEqual(new Set(BLOCKING_BOOKING_STATUSES));
  });

  it('enforces at most one open cancellation request per booking', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(ctx) });
    const base = {
      organizationId: ctx.organization.id,
      bookingId: booking.id,
      suggestedRetainedAmountCents: 0,
    };
    await prisma.cancellationRequest.create({ data: base });
    await expect(prisma.cancellationRequest.create({ data: base })).rejects.toThrow(
      /cancellation_requests_one_open/,
    );
  });
});
```

**Validation scenarios.**
- [ ] An overlapping booking for the same employee is rejected as `23P01` on
  `bookings_no_overlap`.
- [ ] Back-to-back bookings (`07:00–07:30` then `07:30–08:00`) are accepted.
- [ ] The identical range for a different employee is accepted.
- [ ] Every non-blocking status is ignored by the predicate.
- [ ] Every blocking status triggers the constraint.
- [ ] `blockEndsAt = blockStartsAt` is rejected by `bookings_block_range_check`.
- [ ] All four constraints exist after `migrate deploy`.
- [ ] The predicate's quoted literals equal `BLOCKING_BOOKING_STATUSES` exactly.
- [ ] A second `PENDING` cancellation request per booking is rejected.
- [ ] `isExclusionViolation` returns `false` for a unique violation and for a
  plain `Error`.

**Steps.**
- [ ] Create the migration directory and write `migration.sql` by hand:
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;

  ALTER TABLE bookings
    ADD CONSTRAINT bookings_block_range_check
      CHECK (block_ends_at > block_starts_at),
    ADD CONSTRAINT bookings_customer_range_check
      CHECK (ends_at > starts_at),
    ADD CONSTRAINT bookings_expires_at_matches_status
      CHECK (
        status NOT IN ('PENDING_PAYMENT', 'EXPIRING') OR expires_at IS NOT NULL
      ),
    ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
      organization_id WITH =,
      employee_id     WITH =,
      tstzrange(block_starts_at, block_ends_at, '[)') WITH &&
    ) WHERE (status IN ('PENDING_PAYMENT', 'EXPIRING', 'CONFIRMED'));

  ALTER TABLE blocked_times
    ADD CONSTRAINT blocked_times_range_check CHECK (ends_at > starts_at),
    ADD CONSTRAINT blocked_times_no_overlap EXCLUDE USING gist (
      organization_id WITH =,
      employee_id     WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    );

  CREATE UNIQUE INDEX cancellation_requests_one_open
    ON cancellation_requests (booking_id) WHERE decision = 'PENDING';
  CREATE UNIQUE INDEX reschedule_requests_one_open
    ON reschedule_requests (booking_id) WHERE decision = 'PENDING';

  ALTER TABLE working_hours
    ADD CONSTRAINT working_hours_minutes_check
      CHECK (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute);
  ALTER TABLE breaks
    ADD CONSTRAINT breaks_minutes_check
      CHECK (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute);
  ALTER TABLE availability_exceptions
    ADD CONSTRAINT availability_exceptions_shape_check
      CHECK (
        (kind = 'CLOSED' AND start_minute IS NULL AND end_minute IS NULL)
        OR (kind = 'EXTRA_HOURS' AND start_minute IS NOT NULL AND end_minute IS NOT NULL
            AND start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute)
      );
  ALTER TABLE time_off
    ADD CONSTRAINT time_off_range_check CHECK (end_date >= start_date);

  ALTER TABLE services
    ADD CONSTRAINT services_duration_check CHECK (duration_minutes BETWEEN 5 AND 480),
    ADD CONSTRAINT services_buffers_check
      CHECK (prep_buffer_minutes BETWEEN 0 AND 120 AND cleanup_buffer_minutes BETWEEN 0 AND 120),
    ADD CONSTRAINT services_price_check CHECK (price_cents >= 0);

  ALTER TABLE payments
    ADD CONSTRAINT payments_amount_check CHECK (amount_cents > 0),
    ADD CONSTRAINT payments_refunded_check
      CHECK (refunded_amount_cents >= 0 AND refunded_amount_cents <= amount_cents);
  ALTER TABLE manual_payments
    ADD CONSTRAINT manual_payments_amount_check CHECK (amount_cents <> 0);
  ALTER TABLE refunds
    ADD CONSTRAINT refunds_amount_check CHECK (amount_cents > 0);

  ALTER TABLE organization_settings
    ADD CONSTRAINT organization_settings_ranges_check CHECK (
      scheduling_interval_minutes IN (5, 10, 15, 20, 30, 60)
      AND booking_horizon_days BETWEEN 1 AND 365
      AND minimum_notice_hours BETWEEN 0 AND 720
      AND reservation_ttl_minutes BETWEEN 3 AND 30
      AND free_cancellation_hours BETWEEN 0 AND 720
      AND cancellation_fee_percent BETWEEN 0 AND 100
      AND cancellation_fee_amount_cents >= 0
      AND data_retention_days BETWEEN 30 AND 3650
    );
  ```
- [ ] Add a `README.md` note **inside the migration directory** stating that this
  migration is hand-written, that `bookings_no_overlap` hard-codes
  `BookingStatus` literals, and that any future change to that enum must be
  authored with `migrate dev --create-only` and must drop and recreate the
  constraint explicitly.
- [ ] Write `prisma-errors.ts`:
  ```ts
  import { Prisma } from '@prisma/client';

  function sqlState(err: unknown): string | undefined {
    if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
    if (err instanceof Prisma.PrismaClientUnknownRequestError) {
      return /\b(\d{2}[0-9A-Z]{3})\b/.exec(err.message)?.[1];
    }
    return undefined;
  }

  export function isExclusionViolation(err: unknown, constraintName?: string): boolean {
    if (sqlState(err) !== '23P01') return false;
    if (!constraintName) return true;
    return err instanceof Error && err.message.includes(constraintName);
  }

  export function isSerializationFailure(err: unknown): boolean {
    const state = sqlState(err);
    return state === '40001' || state === '40P01';
  }

  export function isUniqueViolation(err: unknown, target?: string): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
    if (!target) return true;
    const meta = err.meta as { target?: string | string[] } | undefined;
    const value = Array.isArray(meta?.target) ? meta.target.join(',') : (meta?.target ?? '');
    return value.includes(target);
  }
  ```
- [ ] Write `booking-status.machine.ts` with `BLOCKING_BOOKING_STATUSES`,
  `CALENDAR_LOCK_CLASS_ID`, `TERMINAL_BOOKING_STATUSES`, the transition map from
  §5.1, and `assertTransition` throwing `AppError('INVALID_STATUS_TRANSITION')`.
- [ ] Write `database.harness.ts`: on first use, run
  `prisma migrate deploy` against `booking_test`, then create a template database
  and, per Vitest worker, `CREATE DATABASE booking_test_<workerId> TEMPLATE
  booking_test_template`. Expose `reset()` that truncates every table except
  `_prisma_migrations` with a single
  `TRUNCATE … RESTART IDENTITY CASCADE`, ordered by reading `pg_tables`. Per-worker
  databases mean integration tests run in parallel without cross-talk.
- [ ] Write `vitest.integration.config.ts` with
  `include: ['test/integration/**/*.int.spec.ts']`,
  `setupFiles: ['./test/setup.integration.ts']`,
  `poolOptions: { threads: { singleThread: false } }`,
  `testTimeout: 30_000`, and `globalSetup` that fails fast with a clear message if
  the test Postgres on 5434 is unreachable.
- [ ] Write `test/factories/index.ts` with `seedOrganization(prisma)` returning
  organization, settings, two employees, one category, two services, employee
  service links, and a customer; and `makeBooking(ctx, overrides)` producing a
  valid `Prisma.BookingCreateInput` with sane defaults, so a test only states what
  it cares about.
- [ ] Apply the migration and iterate until every integration test is green.

**Commands.**
```bash
pnpm test:infra:up
DATABASE_URL="postgresql://booking:booking@localhost:5434/booking_test?schema=public" \
  pnpm api exec prisma migrate deploy
pnpm api test:integration -- test/integration/calendar-constraints.int.spec.ts
pnpm api test
```

**Expected successful result.** Every constraint test passes against real
PostgreSQL, including the predicate-versus-constant agreement test, and the
`23P01` mapper is proven against a genuine violation rather than a mock.

**Commit.** `feat(db): add calendar exclusion constraints, checks and integration harness`

---

### Task 1.4 — Organization context, tenant enforcement, and seed data

**Objective.** Resolve the organization once at bootstrap, make an unscoped query
a loud failure instead of a leak, and seed a demonstrable business.

**Files.**
- `booking-app/apps/api/src/organization/organization-context.service.ts` (new)
- `booking-app/apps/api/src/organization/organization.module.ts` (new)
- `booking-app/apps/api/src/prisma/tenant.extension.ts` (new)
- `booking-app/apps/api/src/prisma/prisma.service.ts` (edit)
- `booking-app/apps/api/prisma/seed.ts` (new)
- `booking-app/apps/api/package.json` (edit — `prisma.seed`)

**Produces for later tasks.**

```ts
export class OrganizationContextService {
  getOrganizationId(): string;
  getOrganization(): Organization & { settings: OrganizationSettings };
  refresh(): Promise<void>;                 // called after PATCH /office/settings
}
export function withTenantGuard(client: PrismaClient): PrismaClient;
```

**Database changes.** None (seed data only).
**API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// booking-app/apps/api/test/integration/tenant-extension.int.spec.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { withTestDatabase } from '../database.harness.js';
import { seedOrganization, makeBooking } from '../factories/index.js';

const { prisma, reset } = await withTestDatabase();
let a: Awaited<ReturnType<typeof seedOrganization>>;
let b: Awaited<ReturnType<typeof seedOrganization>>;

beforeEach(async () => {
  await reset();
  a = await seedOrganization(prisma, { slug: 'org-a' });
  b = await seedOrganization(prisma, { slug: 'org-b' });
});

describe('tenant extension', () => {
  it('throws when findMany omits organizationId', async () => {
    await expect(prisma.booking.findMany({ where: { status: 'CONFIRMED' } })).rejects.toThrow(
      /Booking\.findMany requires organizationId/,
    );
  });

  it('throws when updateMany omits organizationId', async () => {
    await expect(
      prisma.booking.updateMany({ where: { status: 'CONFIRMED' }, data: { status: 'COMPLETED' } }),
    ).rejects.toThrow(/requires organizationId/);
  });

  it('allows a scoped findMany and returns only that organization', async () => {
    await prisma.booking.create({ data: makeBooking(a) });
    await prisma.booking.create({ data: makeBooking(b) });
    const rows = await prisma.booking.findMany({ where: { organizationId: a.organization.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organizationId).toBe(a.organization.id);
  });

  it('allows findUnique by id but the caller must assert ownership', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(b) });
    const found = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(found?.organizationId).toBe(b.organization.id);
  });

  it('does not guard models without an organizationId column', async () => {
    await expect(prisma.organization.findMany({})).resolves.toHaveLength(2);
  });
});
```

```ts
// booking-app/packages/contracts/src/no-organization-id.spec.ts
// (this file is created with the contracts package in Task 3.1; the assertion is
//  stated here because it
//  is the third enforcement layer for the same invariant and must not be forgotten)
import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import { ZodObject } from 'zod';

describe('request contracts', () => {
  it('never accept organizationId from a client', () => {
    const offenders: string[] = [];
    for (const [name, value] of Object.entries(contracts)) {
      if (!(value instanceof ZodObject)) continue;
      if (!/Request$|Body$|Query$|Params$/.test(name)) continue;
      if ('organizationId' in value.shape) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
```

**Validation scenarios.**
- [ ] `findMany` / `findFirst` / `count` / `update` / `updateMany` / `delete` /
  `deleteMany` without `organizationId` throw, and the message names the model and
  the operation.
- [ ] A scoped `findMany` returns only the scoping organization's rows.
- [ ] `create` without an explicit `organizationId` receives the context value.
- [ ] `findUnique` by primary key is permitted.
- [ ] `Organization` itself is not guarded.
- [ ] Bootstrap fails with a named error when `DEFAULT_ORGANIZATION_SLUG` matches
  no row.
- [ ] `pnpm db:seed` twice in a row leaves the same row counts (it is idempotent).
- [ ] No exported request contract has an `organizationId` key.

**Steps.**
- [ ] Write `tenant.extension.ts` using `Prisma.defineExtension` with a
  `$allModels` query hook and a schema-contract test that keeps the guarded model
  list synchronized with required `organizationId` fields. Skip models without
  a required tenant field; allow `findUnique`/`findUniqueOrThrow` only with a
  subsequent `assertOwned`; require every other filter to equal the current
  tenant (directly or in a top-level `AND`). Reject foreign explicit tenant ids
  in `create`, `createMany`, and update payloads. An `upsert` must use a
  tenant-bearing compound unique key, must match the current tenant, and receives
  that tenant in its create payload. Deliberately global operations use the raw
  `PrismaService` at explicitly reviewed call sites.
- [ ] Wire the extension in `PrismaService` behind a factory so tests can build a
  client with an explicit context.
- [ ] Write `organization-context.service.ts`: `onApplicationBootstrap` loads the
  organization by `DEFAULT_ORGANIZATION_SLUG` with its settings, throws a named
  error if absent, caches it, and exposes `refresh()`.
- [ ] Write `seed.ts` as an idempotent upsert script creating:
  - [ ] organization `shape-and-flow`, "Shape and Flow", Europe/Berlin, EUR, `de`
  - [ ] `OrganizationSettings` with the documented defaults
  - [ ] an `OWNER` office user (`owner@shape-and-flow.example`, password from
    `SEED_OWNER_PASSWORD` or a printed random value, argon2id-hashed)
  - [ ] two employees, "Mara Vogt" (`displayOrder 0`) and "Jonas Reit"
    (`displayOrder 1`)
  - [ ] service category "Massage"
  - [ ] service "Facial Massage 30 min" — 30 minutes, 5 minutes cleanup, 4500 cents
  - [ ] service "Regular Massage 60 min" — 60 minutes, 10 minutes cleanup, 7900 cents
  - [ ] `EmployeeService` links for both employees to both services
  - [ ] working hours Monday–Friday 09:00–18:00 with a 12:00–12:30 break, and
    Saturday 10:00–14:00 for Mara only
  - [ ] two `ClosedDay` rows for the next two public holidays in the configured year
- [ ] Add `"prisma": { "seed": "node --experimental-strip-types prisma/seed.ts" }`
  to the API `package.json`.
- [ ] Print a short summary (owner email, employee names, service names) at the end
  of the seed so the developer knows what to log in with.

**Commands.**
```bash
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm db:seed
pnpm api test:integration -- test/integration/tenant-extension.int.spec.ts
docker exec shape-and-flow-booking-postgres psql -U booking -d booking \
  -c "SELECT (SELECT count(*) FROM employees) AS employees, (SELECT count(*) FROM services) AS services;"
```

**Expected successful result.** The tenant tests pass; a second seed run changes
no counts; the summary prints two employees and two services; starting the API
with an unknown `DEFAULT_ORGANIZATION_SLUG` exits non-zero with
`Organization with slug "…" not found`.

**Commit.** `feat(api): resolve organization server-side and enforce tenant scoping in prisma`
---

## Stage 2 — Domain primitives

Everything in this stage is a pure function or a value object: no Nest container,
no database, no clock except one that is injected. That is what makes money,
timezone, and buffer arithmetic testable at the volume it needs.

### Task 2.1 — `Money` value object

**Objective.** Make it impossible for a float, a rounding surprise, or a mixed
currency to reach a Stripe line item or an invoice.

**Files.**
- `booking-app/apps/api/src/domain/money/money.ts` (new)
- `booking-app/apps/api/src/domain/money/money.spec.ts` (new)
- `booking-app/apps/api/src/domain/money/format.ts` (new)

**Produces for later tasks.**

```ts
export class Money {
  static fromCents(amountCents: number, currency?: string): Money;
  static zero(currency?: string): Money;
  readonly amountCents: number;
  readonly currency: string;
  plus(other: Money): Money;
  minus(other: Money): Money;
  /** Rounds DOWN, in the customer's favour. */
  percent(percent: number): Money;
  isZero(): boolean;
  isNegative(): boolean;
  lessThan(other: Money): boolean;
  toJSON(): { amountCents: number; currency: string };
}
export function formatMoney(money: Money, locale: 'de' | 'en'): string;
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// money.spec.ts
import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import { formatMoney } from './format.js';

describe('Money', () => {
  it('rejects non-integer cents', () => {
    expect(() => Money.fromCents(10.5)).toThrow(/integer/i);
  });
  it('rejects a non-finite amount', () => {
    expect(() => Money.fromCents(Number.NaN)).toThrow();
    expect(() => Money.fromCents(Number.POSITIVE_INFINITY)).toThrow();
  });
  it('rejects amounts outside the safe integer range', () => {
    expect(Money.fromCents(Number.MAX_SAFE_INTEGER).amountCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => Money.fromCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/i);
    expect(() => Money.fromCents(Number.MIN_SAFE_INTEGER - 2)).toThrow(/safe integer/i);
  });
  it('refuses to mix currencies', () => {
    expect(() => Money.fromCents(100, 'EUR').plus(Money.fromCents(100, 'CHF'))).toThrow(/currency/i);
  });
  it('adds and subtracts exactly', () => {
    expect(Money.fromCents(4500).plus(Money.fromCents(7900)).amountCents).toBe(12400);
    expect(Money.fromCents(4500).minus(Money.fromCents(7900)).amountCents).toBe(-3400);
  });
  it('rounds a percentage down, in the customer favour', () => {
    // 30 % of 4500 = 1350 exactly
    expect(Money.fromCents(4500).percent(30).amountCents).toBe(1350);
    // 33 % of 100 = 33.0 → 33; 33 % of 101 = 33.33 → 33
    expect(Money.fromCents(101).percent(33).amountCents).toBe(33);
    // 50 % of 1 = 0.5 → 0, never 1
    expect(Money.fromCents(1).percent(50).amountCents).toBe(0);
  });
  it('rejects a percentage outside 0..100', () => {
    expect(() => Money.fromCents(100).percent(101)).toThrow();
    expect(() => Money.fromCents(100).percent(-1)).toThrow();
  });
  it('serialises to the API money shape', () => {
    expect(Money.fromCents(4500).toJSON()).toEqual({ amountCents: 4500, currency: 'EUR' });
  });
  it('formats per locale', () => {
    expect(formatMoney(Money.fromCents(4500), 'de').replace(/ /g, ' ')).toBe('45,00 €');
    expect(formatMoney(Money.fromCents(4500), 'en')).toBe('€45.00');
  });
});
```

**Validation scenarios.**
- [ ] Non-integer, `NaN`, `Infinity`, and values outside JavaScript's safe
  integer range throw at construction; both safe boundaries are accepted.
- [ ] Mixed-currency arithmetic throws.
- [ ] Addition and subtraction are exact, negatives allowed (a compensating manual
  payment needs them).
- [ ] `percent` truncates toward zero — `50 %` of `1` cent is `0`, never `1`.
- [ ] A percentage outside `0..100` throws.
- [ ] `toJSON` matches the API money shape from §6.1.
- [ ] German formatting is `45,00 €`, English is `€45.00`.

**Steps.**
- [ ] Implement `Money` as a frozen class with a private constructor and
  `Object.freeze(this)`, validating cents with `Number.isSafeInteger`, so no
  caller can mutate an amount in place or introduce imprecise cent arithmetic.
- [ ] `percent` computes `Math.trunc((amountCents * percent) / 100)` and documents
  that the remainder stays with the customer.
- [ ] Implement `formatMoney` with `Intl.NumberFormat` (`de-DE` / `en-IE`,
  `style: 'currency'`), memoising the two formatters at module scope.
- [ ] Add an ESLint override forbidding arithmetic on any identifier ending in
  `Cents` outside `src/domain/money/`, so the value object cannot be bypassed:
  ```js
  { selector: "BinaryExpression[operator=/^[*/+-]$/] > Identifier[name=/Cents$/]",
    message: 'Use Money for cent arithmetic.' }
  ```

**Commands.**
```bash
pnpm api test -- src/domain/money
pnpm api lint
```

**Expected successful result.** All money tests green; the lint rule flags a
deliberate `priceCents * 2` written outside the money module and then removed.

**Commit.** `feat(domain): add Money value object with locale formatting`

---

### Task 2.2 — Timezone and range primitives

**Objective.** One place that converts between `Europe/Berlin` wall-clock times
and instants, and refuses to produce a wrong answer across a DST transition.

**Files.**
- `booking-app/apps/api/src/domain/time/local-time.ts` (new)
- `booking-app/apps/api/src/domain/time/local-time.spec.ts` (new)
- `booking-app/apps/api/src/domain/time/interval.ts` (new)
- `booking-app/apps/api/src/domain/time/interval.spec.ts` (new)
- `booking-app/apps/api/src/domain/time/clock.ts` (new)

**Produces for later tasks.**

```ts
export type LocalDate = string;                       // 'YYYY-MM-DD'
export type MinuteOfDay = number;                     // 0..1440
export type WallClockResult =
  | { ok: true; instant: Date }
  | { ok: false; reason: 'NONEXISTENT' | 'AMBIGUOUS' };

export function wallClockToInstant(date: LocalDate, minute: MinuteOfDay, zone: string): WallClockResult;
export function instantToLocalDate(instant: Date, zone: string): LocalDate;
export function instantToMinuteOfDay(instant: Date, zone: string): MinuteOfDay;
export function eachLocalDate(from: LocalDate, to: LocalDate): LocalDate[];
export function weekdayOf(date: LocalDate, zone: string): Weekday;

export interface Interval { readonly start: Date; readonly end: Date }
export function overlaps(a: Interval, b: Interval): boolean;      // half-open [)
export function contains(outer: Interval, inner: Interval): boolean;
export function subtract(from: Interval, holes: Interval[]): Interval[];
export function mergeAdjacent(intervals: Interval[]): Interval[];

export const CLOCK = 'CLOCK';
export interface Clock { now(): Date }
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// local-time.spec.ts
import { describe, expect, it } from 'vitest';
import { wallClockToInstant, instantToMinuteOfDay, eachLocalDate, weekdayOf } from './local-time.js';

const BERLIN = 'Europe/Berlin';

describe('wallClockToInstant', () => {
  it('converts winter time at UTC+1', () => {
    const r = wallClockToInstant('2026-01-15', 9 * 60, BERLIN);
    expect(r.ok && r.instant.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });
  it('converts summer time at UTC+2', () => {
    const r = wallClockToInstant('2026-07-15', 9 * 60, BERLIN);
    expect(r.ok && r.instant.toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });
  it('reports the spring-forward gap as NONEXISTENT', () => {
    // 2026-03-29: 02:00 → 03:00 local; 02:30 does not exist
    expect(wallClockToInstant('2026-03-29', 2 * 60 + 30, BERLIN)).toEqual({
      ok: false, reason: 'NONEXISTENT',
    });
  });
  it('reports the fall-back repeated hour as AMBIGUOUS', () => {
    // 2026-10-25: 03:00 → 02:00 local; 02:30 happens twice
    expect(wallClockToInstant('2026-10-25', 2 * 60 + 30, BERLIN)).toEqual({
      ok: false, reason: 'AMBIGUOUS',
    });
  });
  it('accepts 01:30 and 03:30 on both transition days', () => {
    for (const date of ['2026-03-29', '2026-10-25']) {
      expect(wallClockToInstant(date, 90, BERLIN).ok).toBe(true);
      expect(wallClockToInstant(date, 210, BERLIN).ok).toBe(true);
    }
  });
  it('accepts minute 1440 as the next local midnight', () => {
    const r = wallClockToInstant('2026-07-15', 1440, BERLIN);
    expect(r.ok && r.instant.toISOString()).toBe('2026-07-15T22:00:00.000Z');
  });
  it('round-trips through instantToMinuteOfDay', () => {
    const r = wallClockToInstant('2026-07-15', 14 * 60 + 45, BERLIN);
    expect(r.ok && instantToMinuteOfDay(r.instant, BERLIN)).toBe(885);
  });
});

describe('date helpers', () => {
  it('enumerates an inclusive local date range across a DST boundary', () => {
    expect(eachLocalDate('2026-03-28', '2026-03-30')).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
  });
  it('maps weekdays', () => {
    expect(weekdayOf('2026-08-14', BERLIN)).toBe('FRIDAY');
  });
});
```

```ts
// interval.spec.ts
import { describe, expect, it } from 'vitest';
import { overlaps, contains, subtract } from './interval.js';

const iv = (a: string, b: string) => ({ start: new Date(a), end: new Date(b) });

describe('interval algebra', () => {
  it('treats ranges as half-open, so touching ranges do not overlap', () => {
    expect(overlaps(iv('2026-08-14T07:00Z', '2026-08-14T07:30Z'), iv('2026-08-14T07:30Z', '2026-08-14T08:00Z'))).toBe(false);
  });
  it('detects a genuine overlap', () => {
    expect(overlaps(iv('2026-08-14T07:00Z', '2026-08-14T07:30Z'), iv('2026-08-14T07:15Z', '2026-08-14T07:45Z'))).toBe(true);
  });
  it('detects containment', () => {
    expect(contains(iv('2026-08-14T07:00Z', '2026-08-14T08:00Z'), iv('2026-08-14T07:10Z', '2026-08-14T07:20Z'))).toBe(true);
  });
  it('subtracts a hole in the middle and yields two intervals', () => {
    const parts = subtract(iv('2026-08-14T07:00Z', '2026-08-14T11:00Z'), [iv('2026-08-14T09:00Z', '2026-08-14T09:30Z')]);
    expect(parts.map((p) => [p.start.toISOString(), p.end.toISOString()])).toEqual([
      ['2026-08-14T07:00:00.000Z', '2026-08-14T09:00:00.000Z'],
      ['2026-08-14T09:30:00.000Z', '2026-08-14T11:00:00.000Z'],
    ]);
  });
  it('returns nothing when a hole covers the whole interval', () => {
    expect(subtract(iv('2026-08-14T07:00Z', '2026-08-14T08:00Z'), [iv('2026-08-14T06:00Z', '2026-08-14T09:00Z')])).toEqual([]);
  });
  it('handles overlapping and unsorted holes', () => {
    const parts = subtract(iv('2026-08-14T07:00Z', '2026-08-14T12:00Z'), [
      iv('2026-08-14T10:00Z', '2026-08-14T11:00Z'),
      iv('2026-08-14T08:00Z', '2026-08-14T08:30Z'),
      iv('2026-08-14T08:15Z', '2026-08-14T09:00Z'),
    ]);
    expect(parts).toHaveLength(3);
  });
});
```

**Validation scenarios.**
- [ ] Winter and summer offsets both correct (`+01:00` / `+02:00`).
- [ ] `2026-03-29 02:30` → `NONEXISTENT`.
- [ ] `2026-10-25 02:30` → `AMBIGUOUS`.
- [ ] `01:30` and `03:30` on both transition days are valid.
- [ ] Minute `1440` maps to the next local midnight.
- [ ] Wall-clock → instant → minute-of-day round-trips.
- [ ] Half-open semantics: touching intervals do not overlap.
- [ ] `subtract` handles a middle hole, a covering hole, and unsorted overlapping
  holes.

**Steps.**
- [ ] Add `luxon` and `@types/luxon` to the API package.
- [ ] Implement `wallClockToInstant`:
  ```ts
  import { DateTime } from 'luxon';

  export function wallClockToInstant(date: LocalDate, minute: MinuteOfDay, zone: string): WallClockResult {
    const dayStart = DateTime.fromISO(date, { zone }).startOf('day');
    if (!dayStart.isValid) throw new Error(`invalid local date: ${date}`);
    const dt = dayStart.plus({ minutes: minute });
    if (!dt.isValid) throw new Error(`invalid wall clock: ${date} +${minute}`);

    // Minute 1440 is deliberately the next local midnight, so the wall-clock
    // equality check below does not apply to it.
    if (minute < 1440) {
      const requestedHour = Math.floor(minute / 60);
      const requestedMinute = minute % 60;
      // Spring forward: luxon pushes a non-existent local time across the gap.
      if (dt.hour !== requestedHour || dt.minute !== requestedMinute) {
        return { ok: false, reason: 'NONEXISTENT' };
      }
      // Fall back: the same wall clock exists one real hour earlier at a different offset.
      const oneHourEarlier = DateTime.fromMillis(dt.toMillis() - 3_600_000, { zone });
      if (
        oneHourEarlier.hour === requestedHour &&
        oneHourEarlier.minute === requestedMinute &&
        oneHourEarlier.offset !== dt.offset
      ) {
        return { ok: false, reason: 'AMBIGUOUS' };
      }
    }
    return { ok: true, instant: dt.toJSDate() };
  }
  ```
- [ ] Implement the remaining helpers with luxon, never with `Date` arithmetic.
- [ ] Implement `subtract` by sorting holes, merging overlaps, then walking a
  cursor from `from.start` to `from.end`.
- [ ] Define the `Clock` interface and a `SystemClock` provider; register `CLOCK`
  in a module so every service takes a clock instead of calling `new Date()`.
  Add an ESLint rule banning `new Date()` and `Date.now()` outside
  `src/domain/time/` and `test/`.

**Commands.**
```bash
pnpm api test -- src/domain/time
```

**Expected successful result.** Every DST case passes, including both 2026
transition dates, and the lint rule flags a deliberate `Date.now()` added to a
service and then removed.

**Commit.** `feat(domain): add timezone-safe wall-clock conversion and interval algebra`

---

### Task 2.3 — Availability engine

**Objective.** A pure function that turns a calendar snapshot into bookable slots,
correct across DST, buffers, breaks, exceptions, time off, closed days, minimum
notice, and the booking horizon.

**Files.**
- `booking-app/apps/api/src/domain/availability/types.ts` (new)
- `booking-app/apps/api/src/domain/availability/engine.ts` (new)
- `booking-app/apps/api/src/domain/availability/engine.spec.ts` (new)

**Produces for later tasks.**

```ts
export interface AvailabilitySnapshot {
  zone: string;
  now: Date;
  settings: { schedulingIntervalMinutes: number; minimumNoticeHours: number; bookingHorizonDays: number };
  service: { id: string; durationMinutes: number; prepBufferMinutes: number; cleanupBufferMinutes: number };
  closedDates: LocalDate[];
  employees: EmployeeSnapshot[];      // only employees who perform the service
}
export interface EmployeeSnapshot {
  employeeId: string;
  workingHours: { weekday: Weekday; startMinute: number; endMinute: number; breaks: { startMinute: number; endMinute: number }[] }[];
  exceptions: { date: LocalDate; kind: 'EXTRA_HOURS' | 'CLOSED'; startMinute: number | null; endMinute: number | null }[];
  timeOffDates: LocalDate[];          // expanded APPROVED ranges
  busy: Interval[];                   // blocking bookings + blocked times, block-time bounds
}
export interface DaySlots { date: LocalDate; slots: { startsAt: Date; endsAt: Date; employeeIds: string[] }[] }

export function generateAvailability(snapshot: AvailabilitySnapshot, from: LocalDate, to: LocalDate): DaySlots[];
export function isSlotBookable(snapshot: AvailabilitySnapshot, employeeId: string, startsAt: Date): boolean;
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.** The suite is organised one `describe` per rule so a failure names
the rule that broke.

```ts
// engine.spec.ts (excerpt — the full suite covers every scenario listed below)
import { describe, expect, it } from 'vitest';
import { generateAvailability, isSlotBookable } from './engine.js';
import type { AvailabilitySnapshot } from './types.js';

const BERLIN = 'Europe/Berlin';
const base = (over: Partial<AvailabilitySnapshot> = {}): AvailabilitySnapshot => ({
  zone: BERLIN,
  now: new Date('2026-08-01T06:00:00Z'),
  settings: { schedulingIntervalMinutes: 15, minimumNoticeHours: 24, bookingHorizonDays: 180 },
  service: { id: 'svc', durationMinutes: 30, prepBufferMinutes: 0, cleanupBufferMinutes: 0 },
  closedDates: [],
  employees: [
    {
      employeeId: 'emp-1',
      workingHours: [{ weekday: 'FRIDAY', startMinute: 9 * 60, endMinute: 11 * 60, breaks: [] }],
      exceptions: [],
      timeOffDates: [],
      busy: [],
    },
  ],
  ...over,
});

const times = (days: ReturnType<typeof generateAvailability>) =>
  days.flatMap((d) => d.slots.map((s) => s.startsAt.toISOString()));

describe('slot grid', () => {
  it('steps by the scheduling interval and never runs past the segment end', () => {
    const days = generateAvailability(base(), '2026-08-14', '2026-08-14');
    expect(times(days)).toEqual([
      '2026-08-14T07:00:00.000Z', '2026-08-14T07:15:00.000Z', '2026-08-14T07:30:00.000Z',
      '2026-08-14T07:45:00.000Z', '2026-08-14T08:00:00.000Z', '2026-08-14T08:15:00.000Z',
      '2026-08-14T08:30:00.000Z',
    ]);
  });
  it('honours a 30-minute interval', () => {
    const snap = base();
    snap.settings.schedulingIntervalMinutes = 30;
    expect(times(generateAvailability(snap, '2026-08-14', '2026-08-14'))).toHaveLength(4);
  });
});

describe('buffers', () => {
  it('extends the blocked window without moving the customer-visible time', () => {
    const snap = base({
      service: { id: 'svc', durationMinutes: 30, prepBufferMinutes: 10, cleanupBufferMinutes: 15 },
    });
    const days = generateAvailability(snap, '2026-08-14', '2026-08-14');
    // 09:00 needs 08:50 prep, which is before the shift, so the first slot is 09:15.
    expect(days[0]!.slots[0]!.startsAt.toISOString()).toBe('2026-08-14T07:15:00.000Z');
    // The last slot must finish its cleanup by 11:00 → starts 10:15.
    expect(days[0]!.slots.at(-1)!.startsAt.toISOString()).toBe('2026-08-14T08:15:00.000Z');
  });
  it('lets two appointments sit back-to-back when buffers exactly meet', () => {
    const snap = base({
      service: { id: 'svc', durationMinutes: 30, prepBufferMinutes: 0, cleanupBufferMinutes: 15 },
      employees: [{ ...base().employees[0]!, busy: [{ start: new Date('2026-08-14T07:00:00Z'), end: new Date('2026-08-14T07:45:00Z') }] }],
    });
    expect(times(generateAvailability(snap, '2026-08-14', '2026-08-14'))).toContain('2026-08-14T07:45:00.000Z');
  });
});

describe('breaks, exceptions, time off, closed days', () => {
  it('removes slots that overlap a break', () => {
    const snap = base();
    snap.employees[0]!.workingHours[0]!.breaks = [{ startMinute: 9 * 60 + 30, endMinute: 10 * 60 }];
    const t = times(generateAvailability(snap, '2026-08-14', '2026-08-14'));
    expect(t).toContain('2026-08-14T07:00:00.000Z');
    expect(t).not.toContain('2026-08-14T07:15:00.000Z');
    expect(t).not.toContain('2026-08-14T07:30:00.000Z');
    expect(t).toContain('2026-08-14T08:00:00.000Z');
  });
  it('EXTRA_HOURS replaces the recurring hours rather than adding to them', () => {
    const snap = base();
    snap.employees[0]!.exceptions = [
      { date: '2026-08-14', kind: 'EXTRA_HOURS', startMinute: 14 * 60, endMinute: 15 * 60 },
    ];
    expect(times(generateAvailability(snap, '2026-08-14', '2026-08-14'))).toEqual([
      '2026-08-14T12:00:00.000Z', '2026-08-14T12:15:00.000Z', '2026-08-14T12:30:00.000Z',
    ]);
  });
  it('CLOSED removes the whole day', () => {
    const snap = base();
    snap.employees[0]!.exceptions = [{ date: '2026-08-14', kind: 'CLOSED', startMinute: null, endMinute: null }];
    expect(generateAvailability(snap, '2026-08-14', '2026-08-14')[0]!.slots).toEqual([]);
  });
  it('approved time off removes the day', () => {
    const snap = base();
    snap.employees[0]!.timeOffDates = ['2026-08-14'];
    expect(generateAvailability(snap, '2026-08-14', '2026-08-14')[0]!.slots).toEqual([]);
  });
  it('a closed day removes it for every employee', () => {
    const snap = base({ closedDates: ['2026-08-14'] });
    expect(generateAvailability(snap, '2026-08-14', '2026-08-14')[0]!.slots).toEqual([]);
  });
});

describe('policy windows', () => {
  it('drops slots inside the minimum-notice window', () => {
    const snap = base({ now: new Date('2026-08-13T07:30:00Z') }); // 24 h notice → first bookable 09:30 local
    const t = times(generateAvailability(snap, '2026-08-14', '2026-08-14'));
    expect(t[0]).toBe('2026-08-14T07:30:00.000Z');
  });
  it('drops dates beyond the booking horizon', () => {
    const snap = base();
    snap.settings.bookingHorizonDays = 1;
    expect(generateAvailability(snap, '2026-08-14', '2026-08-14')[0]!.slots).toEqual([]);
  });
});

describe('DST', () => {
  it('omits the non-existent spring-forward hour instead of shifting it', () => {
    const snap = base({ now: new Date('2026-03-01T00:00:00Z') });
    snap.employees[0]!.workingHours = [{ weekday: 'SUNDAY', startMinute: 60, endMinute: 5 * 60, breaks: [] }];
    const t = times(generateAvailability(snap, '2026-03-29', '2026-03-29'));
    const localHours = t.map((iso) => new Date(iso).toLocaleTimeString('de-DE', { timeZone: BERLIN, hour: '2-digit', minute: '2-digit' }));
    expect(localHours).toContain('01:00');
    expect(localHours).toContain('03:00');
    expect(localHours.filter((h) => h.startsWith('02:'))).toEqual([]);
  });
  it('omits the ambiguous fall-back hour rather than emitting it twice', () => {
    const snap = base({ now: new Date('2026-10-01T00:00:00Z') });
    snap.employees[0]!.workingHours = [{ weekday: 'SUNDAY', startMinute: 60, endMinute: 5 * 60, breaks: [] }];
    const t = times(generateAvailability(snap, '2026-10-25', '2026-10-25'));
    expect(new Set(t).size).toBe(t.length);
    const localHours = t.map((iso) => new Date(iso).toLocaleTimeString('de-DE', { timeZone: BERLIN, hour: '2-digit', minute: '2-digit' }));
    expect(localHours.filter((h) => h.startsWith('02:'))).toEqual([]);
  });
  it('keeps a 09:00 local start on both sides of a transition', () => {
    const snap = base({ now: new Date('2026-03-01T00:00:00Z') });
    snap.employees[0]!.workingHours = [{ weekday: 'MONDAY', startMinute: 9 * 60, endMinute: 10 * 60, breaks: [] }];
    const before = generateAvailability(snap, '2026-03-23', '2026-03-23')[0]!.slots[0]!.startsAt.toISOString();
    const after = generateAvailability(snap, '2026-03-30', '2026-03-30')[0]!.slots[0]!.startsAt.toISOString();
    expect(before).toBe('2026-03-23T08:00:00.000Z'); // CET
    expect(after).toBe('2026-03-30T07:00:00.000Z');  // CEST
  });
});

describe('multi-employee merge', () => {
  it('lists every employee who can take a slot, deduplicated by time', () => {
    const snap = base();
    snap.employees.push({ ...snap.employees[0]!, employeeId: 'emp-2' });
    snap.employees[1]!.busy = [{ start: new Date('2026-08-14T07:00:00Z'), end: new Date('2026-08-14T07:30:00Z') }];
    const day = generateAvailability(snap, '2026-08-14', '2026-08-14')[0]!;
    expect(day.slots[0]!.employeeIds).toEqual(['emp-1']);
    expect(day.slots.find((s) => s.startsAt.toISOString() === '2026-08-14T07:30:00.000Z')!.employeeIds)
      .toEqual(['emp-1', 'emp-2']);
  });
});

describe('isSlotBookable', () => {
  it('agrees with generateAvailability for every generated slot', () => {
    const snap = base();
    for (const slot of generateAvailability(snap, '2026-08-14', '2026-08-14')[0]!.slots) {
      expect(isSlotBookable(snap, 'emp-1', slot.startsAt)).toBe(true);
    }
  });
  it('rejects an off-grid start time', () => {
    expect(isSlotBookable(base(), 'emp-1', new Date('2026-08-14T07:07:00Z'))).toBe(false);
  });
  it('rejects a slot that was free a moment ago but is now busy', () => {
    const snap = base();
    snap.employees[0]!.busy = [{ start: new Date('2026-08-14T07:00:00Z'), end: new Date('2026-08-14T07:30:00Z') }];
    expect(isSlotBookable(snap, 'emp-1', new Date('2026-08-14T07:00:00Z'))).toBe(false);
  });
});
```

**Validation scenarios.**
- [ ] Grid steps by `schedulingIntervalMinutes` and the last slot fits inside the
  segment.
- [ ] Prep buffer pushes the first slot later; cleanup buffer pulls the last slot
  earlier; the customer-visible `startsAt`/`endsAt` exclude buffers.
- [ ] Two appointments are legal when buffers exactly meet (half-open bounds).
- [ ] Breaks remove only the overlapping slots.
- [ ] `EXTRA_HOURS` replaces the day's recurring hours; `CLOSED` empties the day.
- [ ] Approved time off empties the day; a `REQUESTED` row does not.
- [ ] A closed day empties the day for every employee.
- [ ] Minimum notice and booking horizon are both enforced.
- [ ] Spring-forward hour is omitted, not shifted; fall-back hour is omitted, not
  duplicated; a 09:00 local slot keeps its local time on both sides.
- [ ] Multi-employee results merge by start time with a sorted `employeeIds`.
- [ ] `isSlotBookable` agrees with `generateAvailability` on every generated slot,
  rejects off-grid times, and rejects a now-busy slot. This is the function the
  reservation transaction re-runs under the advisory lock, so agreement between
  the two is the property that makes the double-check meaningful.

**Steps.**
- [ ] Define the snapshot types exactly as above; the snapshot is deliberately a
  plain data structure with no Prisma types, so the engine cannot reach the
  database.
- [ ] Implement `generateAvailability`:
  - [ ] Clamp the requested range to
    `[max(from, today), min(to, today + bookingHorizonDays)]`.
  - [ ] `earliestStart = now + minimumNoticeHours`.
  - [ ] For each local date: skip if in `closedDates`.
  - [ ] For each employee: skip if the date is in `timeOffDates`; resolve the day's
    segments (exception `CLOSED` → none, `EXTRA_HOURS` → that one segment,
    otherwise the weekday's `workingHours`); subtract each segment's breaks with
    `subtract`.
  - [ ] For each resulting segment, convert `startMinute` to an instant with
    `wallClockToInstant`; step candidate start minutes by the interval; for each
    candidate call `wallClockToInstant` and **skip** `NONEXISTENT` and `AMBIGUOUS`
    results, counting them in a returned `skipped` diagnostic that the caller logs
    at `debug`.
  - [ ] Build `appointment = [start, start + duration)` and
    `block = [start − prep, start + duration + cleanup)`; require
    `contains(segmentInterval, appointment)` and no `overlaps(block, busy)`;
    require `start >= earliestStart`.
  - [ ] Accumulate into a `Map<startMillis, Set<employeeId>>` per date, then emit
    slots sorted by time with `employeeIds` sorted for determinism.
- [ ] Implement `isSlotBookable` by reusing the same predicate chain for one
  employee and one candidate, so there is exactly one definition of "bookable".
- [ ] Keep the module free of imports other than the time primitives — asserted by
  an import-check test.

**Commands.**
```bash
pnpm api test -- src/domain/availability
```

**Expected successful result.** Every scenario green, including all three DST
cases and the `isSlotBookable` agreement property.

**Commit.** `feat(domain): add pure availability engine with dst-safe slot generation`

---

### Task 2.4 — Pricing and employee selection

**Objective.** One definition of the price a customer is quoted and charged, and
one deterministic rule for "any available employee".

**Files.**
- `booking-app/apps/api/src/domain/pricing/pricing.ts` (new)
- `booking-app/apps/api/src/domain/pricing/pricing.spec.ts` (new)
- `booking-app/apps/api/src/domain/pricing/cancellation-fee.ts` (new)
- `booking-app/apps/api/src/domain/employee-selection/select-employee.ts` (new)
- `booking-app/apps/api/src/domain/employee-selection/select-employee.spec.ts` (new)

**Produces for later tasks.**

```ts
export function resolveEffectivePrice(
  service: { priceCents: number; currency: string },
  link: { priceOverrideCents: number | null } | null,
): Money;

export function computeSuggestedRetainedAmount(input: {
  paid: Money; startsAt: Date; now: Date;
  settings: { freeCancellationHours: number; cancellationFeePolicy: CancellationFeePolicy;
              cancellationFeeAmountCents: number; cancellationFeePercent: number };
}): { feeApplies: boolean; suggestedRetained: Money; suggestedRefund: Money };

export function selectEmployee(candidates: EmployeeCandidate[]): string;
export interface EmployeeCandidate { employeeId: string; bookingsThatDay: number; displayOrder: number }
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// pricing.spec.ts
import { describe, expect, it } from 'vitest';
import { Money } from '../money/money.js';
import { resolveEffectivePrice } from './pricing.js';
import { computeSuggestedRetainedAmount } from './cancellation-fee.js';

const service = { priceCents: 4500, currency: 'EUR' };
const settings = (over = {}) => ({
  freeCancellationHours: 72, cancellationFeePolicy: 'NONE' as const,
  cancellationFeeAmountCents: 0, cancellationFeePercent: 0, ...over,
});

describe('resolveEffectivePrice', () => {
  it('uses the service price when there is no override', () => {
    expect(resolveEffectivePrice(service, null).amountCents).toBe(4500);
    expect(resolveEffectivePrice(service, { priceOverrideCents: null }).amountCents).toBe(4500);
  });
  it('uses the override when present, including zero', () => {
    expect(resolveEffectivePrice(service, { priceOverrideCents: 5200 }).amountCents).toBe(5200);
    expect(resolveEffectivePrice(service, { priceOverrideCents: 0 }).amountCents).toBe(0);
  });
});

describe('computeSuggestedRetainedAmount', () => {
  const paid = Money.fromCents(4500);
  const startsAt = new Date('2026-08-14T07:00:00Z');

  it('retains nothing outside the free-cancellation window', () => {
    const r = computeSuggestedRetainedAmount({ paid, startsAt, now: new Date('2026-08-10T07:00:00Z'), settings: settings() });
    expect(r.feeApplies).toBe(false);
    expect(r.suggestedRetained.amountCents).toBe(0);
    expect(r.suggestedRefund.amountCents).toBe(4500);
  });
  it('retains nothing inside the window when the policy is NONE', () => {
    const r = computeSuggestedRetainedAmount({ paid, startsAt, now: new Date('2026-08-13T07:00:00Z'), settings: settings() });
    expect(r.feeApplies).toBe(true);
    expect(r.suggestedRetained.amountCents).toBe(0);
  });
  it('retains a fixed amount, capped at what was paid', () => {
    const r = computeSuggestedRetainedAmount({
      paid, startsAt, now: new Date('2026-08-13T07:00:00Z'),
      settings: settings({ cancellationFeePolicy: 'FIXED_AMOUNT', cancellationFeeAmountCents: 2000 }),
    });
    expect(r.suggestedRetained.amountCents).toBe(2000);
    expect(r.suggestedRefund.amountCents).toBe(2500);

    const capped = computeSuggestedRetainedAmount({
      paid: Money.fromCents(1000), startsAt, now: new Date('2026-08-13T07:00:00Z'),
      settings: settings({ cancellationFeePolicy: 'FIXED_AMOUNT', cancellationFeeAmountCents: 2000 }),
    });
    expect(capped.suggestedRetained.amountCents).toBe(1000);
    expect(capped.suggestedRefund.amountCents).toBe(0);
  });
  it('retains a percentage, rounded down', () => {
    const r = computeSuggestedRetainedAmount({
      paid: Money.fromCents(4501), startsAt, now: new Date('2026-08-13T07:00:00Z'),
      settings: settings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 33 }),
    });
    expect(r.suggestedRetained.amountCents).toBe(1485); // 1485.33 → 1485
  });
  it('treats the boundary exactly at freeCancellationHours as free', () => {
    const r = computeSuggestedRetainedAmount({
      paid, startsAt, now: new Date('2026-08-11T07:00:00Z'), // exactly 72 h
      settings: settings({ cancellationFeePolicy: 'FIXED_AMOUNT', cancellationFeeAmountCents: 2000 }),
    });
    expect(r.feeApplies).toBe(false);
    expect(r.suggestedRetained.amountCents).toBe(0);
  });
  it('retains nothing when nothing was paid', () => {
    const r = computeSuggestedRetainedAmount({
      paid: Money.zero(), startsAt, now: new Date('2026-08-13T07:00:00Z'),
      settings: settings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 }),
    });
    expect(r.suggestedRetained.amountCents).toBe(0);
  });
});
```

```ts
// select-employee.spec.ts
import { describe, expect, it } from 'vitest';
import { selectEmployee } from './select-employee.js';

describe('selectEmployee', () => {
  it('prefers the fewest bookings that day', () => {
    expect(selectEmployee([
      { employeeId: 'b', bookingsThatDay: 3, displayOrder: 0 },
      { employeeId: 'a', bookingsThatDay: 1, displayOrder: 9 },
    ])).toBe('a');
  });
  it('breaks a tie on display order', () => {
    expect(selectEmployee([
      { employeeId: 'b', bookingsThatDay: 2, displayOrder: 1 },
      { employeeId: 'a', bookingsThatDay: 2, displayOrder: 0 },
    ])).toBe('a');
  });
  it('breaks a further tie on employee id, so the result is deterministic', () => {
    expect(selectEmployee([
      { employeeId: 'b', bookingsThatDay: 2, displayOrder: 0 },
      { employeeId: 'a', bookingsThatDay: 2, displayOrder: 0 },
    ])).toBe('a');
  });
  it('is stable regardless of input order', () => {
    const input = [
      { employeeId: 'c', bookingsThatDay: 2, displayOrder: 0 },
      { employeeId: 'a', bookingsThatDay: 2, displayOrder: 0 },
      { employeeId: 'b', bookingsThatDay: 2, displayOrder: 0 },
    ];
    expect(selectEmployee(input)).toBe(selectEmployee([...input].reverse()));
  });
  it('throws on an empty candidate list rather than returning undefined', () => {
    expect(() => selectEmployee([])).toThrow(/no candidate/i);
  });
});
```

**Validation scenarios.**
- [ ] Effective price falls back to the service price; `0` is a valid override and
  is not treated as absent.
- [ ] Outside the free window nothing is retained.
- [ ] Inside the window: `NONE` retains nothing, `FIXED_AMOUNT` retains the amount
  capped at what was paid, `PERCENTAGE` retains a down-rounded share.
- [ ] Exactly `freeCancellationHours` before the start counts as *outside* the fee
  window — the boundary favours the customer.
- [ ] Nothing paid means nothing retained, whatever the policy.
- [ ] Employee selection: fewest bookings, then display order, then id; stable
  under input reordering; throws on an empty list.

**Steps.**
- [ ] Implement `resolveEffectivePrice` with `link?.priceOverrideCents ?? service.priceCents`,
  taking care that `0` survives the `??`.
- [ ] Implement `computeSuggestedRetainedAmount` returning both the retained and
  the refund amount so no caller subtracts by hand, and documenting that the value
  is a **suggestion** the decider may override (§5.4).
- [ ] Implement `selectEmployee` as a single comparator sort, throwing
  `AppError('NO_EMPLOYEE_AVAILABLE')` on an empty list.
- [ ] Add a short comment in `select-employee.ts` recording that "fewest bookings
  that day" is counted over blocking statuses only, so an expired reservation does
  not permanently penalise an employee.

**Commands.**
```bash
pnpm api test -- src/domain/pricing src/domain/employee-selection
pnpm api typecheck
```

**Expected successful result.** Every pricing and selection test green; the fee
boundary and the down-rounding behaviour are both proven.

**Commit.** `feat(domain): add pricing, cancellation-fee and employee-selection rules`
---

## Stage 3 — Contracts, cross-cutting concerns, and provider abstractions

### Task 3.1 — Contracts package, error envelope, correlation and logging

**Objective.** One package that every layer validates against, one error shape,
and a correlation id that reaches every log line and every job.

**Files.**
- `booking-app/packages/contracts/package.json` (new)
- `booking-app/packages/contracts/tsconfig.json` (new)
- `booking-app/packages/contracts/src/index.ts` (new)
- `booking-app/packages/contracts/src/enums.ts` (new)
- `booking-app/packages/contracts/src/errors.ts` (new)
- `booking-app/packages/contracts/src/primitives.ts` (new)
- `booking-app/packages/contracts/src/pagination.ts` (new)
- `booking-app/packages/contracts/src/no-organization-id.spec.ts` (new)
- `booking-app/apps/api/src/common/errors/app-error.ts` (new)
- `booking-app/apps/api/src/common/errors/global-exception.filter.ts` (new)
- `booking-app/apps/api/src/common/errors/global-exception.filter.spec.ts` (new)
- `booking-app/apps/api/src/common/correlation/correlation.store.ts` (new)
- `booking-app/apps/api/src/common/correlation/correlation.middleware.ts` (new)
- `booking-app/apps/api/src/common/logging/logger.module.ts` (new)
- `booking-app/apps/api/src/common/logging/redaction.spec.ts` (new)
- `booking-app/apps/api/src/app.module.ts` (edit)

**Produces for later tasks.**

```ts
// contracts
export const ErrorCode: z.ZodEnum<[...]>;               // every code in §6.1
export const moneySchema: z.ZodObject<{ amountCents: z.ZodNumber; currency: z.ZodString }>;
export const localeSchema, isoInstantSchema, localDateSchema, cuidSchema, idempotencyKeySchema;
export const errorEnvelopeSchema, cursorPageSchema, cursorQuerySchema;
// api
export class AppError extends Error { constructor(code: ErrorCode, opts?: { status?: number; message?: string; details?: unknown }) }
export function correlationId(): string;
export function runWithCorrelation<T>(id: string, fn: () => T): T;
```

**Database changes.** None.
**API changes.** Every error response now uses the envelope from §6.1.
**Frontend changes.** None.

**Tests first.**

```ts
// global-exception.filter.spec.ts
import { ArgumentsHost, HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GlobalExceptionFilter } from './global-exception.filter.js';
import { AppError } from './app-error.js';
import { ZodError, z } from 'zod';

function hostFor() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ url: '/api/x', method: 'POST' }) }) };
  return { host: host as unknown as ArgumentsHost, status, json };
}

describe('GlobalExceptionFilter', () => {
  const filter = new GlobalExceptionFilter();

  it('maps an AppError to its code and status', () => {
    const { host, status, json } = hostFor();
    filter.catch(new AppError('SLOT_UNAVAILABLE', { details: { employeeId: 'e1' } }), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0]).toMatchObject({ code: 'SLOT_UNAVAILABLE', details: { employeeId: 'e1' } });
    expect(json.mock.calls[0][0].correlationId).toBeTypeOf('string');
  });

  it('maps a ZodError to VALIDATION_FAILED with field paths', () => {
    const { host, status, json } = hostFor();
    const err = new ZodError(z.object({ a: z.string() }).safeParse({}).error!.issues);
    filter.catch(err, host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].code).toBe('VALIDATION_FAILED');
    expect(json.mock.calls[0][0].details.issues[0].path).toEqual(['a']);
  });

  it('maps a plain HttpException by status', () => {
    const { host, json } = hostFor();
    filter.catch(new HttpException('nope', 404), host);
    expect(json.mock.calls[0][0].code).toBe('NOT_FOUND');
  });

  it('never leaks an internal message', () => {
    const { host, status, json } = hostFor();
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.5:5432'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0]).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('ECONNREFUSED');
  });

  it('always emits exactly the envelope keys', () => {
    const { host, json } = hostFor();
    filter.catch(new AppError('NOT_FOUND'), host);
    expect(Object.keys(json.mock.calls[0][0]).sort()).toEqual(['code', 'correlationId', 'message']);
  });
});
```

```ts
// redaction.spec.ts
import { describe, expect, it } from 'vitest';
import { buildLogger } from './logger.module.js';

describe('log redaction', () => {
  it('redacts every personal and secret field', () => {
    const lines: string[] = [];
    const logger = buildLogger({ level: 'info', destination: { write: (s: string) => void lines.push(s) } });
    logger.info({
      req: { headers: { authorization: 'Bearer secret-token', cookie: 'sf_office_session=abc' } },
      body: {
        password: 'hunter2', newPassword: 'hunter3', currentPassword: 'hunter1',
        customer: { email: 'anna@example.com', phone: '+4915112345678' },
        customerNote: 'sensitive note',
      },
      tokenHash: 'deadbeef',
    }, 'request');
    const out = lines.join('');
    for (const secret of ['secret-token', 'sf_office_session=abc', 'hunter1', 'hunter2', 'hunter3',
                          'anna@example.com', '+4915112345678', 'sensitive note', 'deadbeef']) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('[Redacted]');
  });
});
```

**Validation scenarios.**
- [ ] `AppError` maps to the documented status per code.
- [ ] `ZodError` becomes `400 VALIDATION_FAILED` with `details.issues[].path`.
- [ ] A plain `HttpException` maps by status to the nearest code.
- [ ] An unexpected `Error` becomes `500 INTERNAL_ERROR` and its message never
  reaches the response.
- [ ] The envelope has exactly `code`, `message`, `correlationId`, and optionally
  `details` — no extra keys.
- [ ] Every field in the redaction list is absent from the serialised log line.
- [ ] `correlationId()` returns the incoming `X-Request-Id` when present, otherwise
  a fresh ULID, and the same value appears in the response header.
- [ ] No exported request contract has an `organizationId` key (the test from
  Task 1.4 now lives in this package and runs in CI).

**Steps.**
- [ ] Create the contracts package: `@shape-and-flow/booking-contracts`,
  `type: module`, dependency `zod` only, `exports` map with `"." → "./src/index.ts"`
  in development and `dist` in build.
- [ ] Define `ErrorCode` as a Zod enum containing exactly the codes in §6.1, plus
  `ERROR_STATUS: Record<ErrorCode, number>` mapping each to its HTTP status. A test
  asserts the two are exhaustive over each other.
- [ ] Define shared primitives: `moneySchema`, `isoInstantSchema`
  (`z.string().datetime({ offset: false })`), `localDateSchema`
  (`/^\d{4}-\d{2}-\d{2}$/` plus a real-date refinement), `cuidSchema`,
  `idempotencyKeySchema` (`z.string().uuid()`), `localeSchema`.
- [ ] Define `cursorQuerySchema` (`limit` 1–100 default 25, `cursor` optional) and
  a generic `cursorPageSchema(item)`.
- [ ] Implement `AppError` carrying `code`, `status` (from `ERROR_STATUS` unless
  overridden), and `details`.
- [ ] Implement `GlobalExceptionFilter` handling `AppError`, `ZodError`,
  `HttpException`, and everything else, logging at `warn` for 4xx and `error` for
  5xx, and always attaching the correlation id.
- [ ] Implement the correlation store with `AsyncLocalStorage`, a middleware that
  seeds it and sets `X-Request-Id` on the response, and a
  `runWithCorrelation` helper the worker uses per job.
- [ ] Configure `nestjs-pino` with the redaction path list from §10.8, a
  `genReqId` reading the correlation store, `customProps` adding
  `correlationId`, and `transport: pino-pretty` only when `NODE_ENV=development`.
- [ ] Register the filter globally and the middleware in `AppModule`.

**Commands.**
```bash
pnpm install
pnpm --filter @shape-and-flow/booking-contracts test
pnpm api test -- src/common
pnpm api typecheck
```

**Expected successful result.** Filter and redaction suites green; a deliberate
`throw new Error('boom')` in a controller returns
`{"code":"INTERNAL_ERROR","message":"An unexpected error occurred.","correlationId":"…"}`
and the log line for it contains the same correlation id.

**Commit.** `feat(api): add contracts package, error envelope, correlation and redacted logging`

---

### Task 3.2 — Provider interfaces, tokens, and in-memory fakes

**Objective.** Define the three provider ports with a `PaymentAccountContext`
already in every payment signature, and ship fakes good enough that every test and
local development run needs no third-party credentials.

**Files.**
- `booking-app/apps/api/src/providers/payment/payment-provider.ts` (new)
- `booking-app/apps/api/src/providers/payment/fake-payment.provider.ts` (new)
- `booking-app/apps/api/src/providers/email/email-provider.ts` (new)
- `booking-app/apps/api/src/providers/email/fake-email.provider.ts` (new)
- `booking-app/apps/api/src/providers/sms/sms-provider.ts` (new)
- `booking-app/apps/api/src/providers/sms/fake-sms.provider.ts` (new)
- `booking-app/apps/api/src/providers/providers.module.ts` (new)
- `booking-app/apps/api/src/providers/payment/fake-payment.provider.spec.ts` (new)

**Produces for later tasks.**

```ts
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';
export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
export const SMS_PROVIDER = 'SMS_PROVIDER';

/** Always `{ organizationId, stripeAccountId: undefined }` in Phase 1. */
export interface PaymentAccountContext { organizationId: string; stripeAccountId?: string | undefined }

export interface PaymentProvider {
  createCheckoutSession(ctx: PaymentAccountContext, input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult>;
  expireCheckoutSession(ctx: PaymentAccountContext, sessionId: string): Promise<ExpireResult>;
  retrieveCheckoutSession(ctx: PaymentAccountContext, sessionId: string): Promise<RetrievedSession>;
  createRefund(ctx: PaymentAccountContext, input: CreateRefundInput): Promise<RefundResult>;
  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent;
}
export type ExpireResult =
  | { outcome: 'EXPIRED' }
  | { outcome: 'ALREADY_COMPLETE'; paymentStatus: 'paid' | 'unpaid' | 'no_payment_required' };

export interface EmailProvider { send(msg: EmailMessage): Promise<{ providerMessageId: string }> }
export interface SmsProvider   { send(msg: SmsMessage):   Promise<{ providerMessageId: string }> }
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// fake-payment.provider.spec.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { FakePaymentProvider } from './fake-payment.provider.js';

const ctx = { organizationId: 'org-1', stripeAccountId: undefined };
let provider: FakePaymentProvider;
beforeEach(() => { provider = new FakePaymentProvider(); });

const input = {
  bookingId: 'bk-1', clientReferenceId: 'bk-1', amountCents: 4500, currency: 'EUR',
  description: 'Facial Massage 30 min', customerEmail: 'anna@example.com',
  successUrl: 'http://localhost:5173/booking/success', cancelUrl: 'http://localhost:5173/booking/canceled',
  locale: 'de' as const, expiresAt: new Date('2026-08-14T06:05:00Z'),
};

describe('FakePaymentProvider', () => {
  it('creates a session with a deterministic prefix and a usable url', async () => {
    const s = await provider.createCheckoutSession(ctx, input);
    expect(s.sessionId).toMatch(/^cs_fake_/);
    expect(s.url).toContain(s.sessionId);
  });

  it('expires an open session', async () => {
    const s = await provider.createCheckoutSession(ctx, input);
    await expect(provider.expireCheckoutSession(ctx, s.sessionId)).resolves.toEqual({ outcome: 'EXPIRED' });
  });

  it('reports ALREADY_COMPLETE for a session the test marked paid', async () => {
    const s = await provider.createCheckoutSession(ctx, input);
    provider.markPaid(s.sessionId);
    await expect(provider.expireCheckoutSession(ctx, s.sessionId)).resolves.toEqual({
      outcome: 'ALREADY_COMPLETE', paymentStatus: 'paid',
    });
  });

  it('surfaces an injected network failure so the retry path is testable', async () => {
    provider.failNextWith(new Error('ECONNRESET'));
    await expect(provider.createCheckoutSession(ctx, input)).rejects.toThrow('ECONNRESET');
    await expect(provider.createCheckoutSession(ctx, input)).resolves.toBeDefined();
  });

  it('refunds at most the charged amount and is idempotent by key', async () => {
    const s = await provider.createCheckoutSession(ctx, input);
    provider.markPaid(s.sessionId);
    const first = await provider.createRefund(ctx, { chargeId: provider.chargeIdFor(s.sessionId), amountCents: 2000, idempotencyKey: 'k1' });
    const again = await provider.createRefund(ctx, { chargeId: provider.chargeIdFor(s.sessionId), amountCents: 2000, idempotencyKey: 'k1' });
    expect(again.refundId).toBe(first.refundId);
    await expect(provider.createRefund(ctx, { chargeId: provider.chargeIdFor(s.sessionId), amountCents: 4000, idempotencyKey: 'k2' }))
      .rejects.toThrow(/exceeds/i);
  });

  it('builds a signed synthetic webhook event the handler can verify', () => {
    const raw = Buffer.from(JSON.stringify({ id: 'evt_fake_1', type: 'checkout.session.completed', data: { object: {} } }));
    const event = provider.verifyWebhook(raw, provider.signatureFor(raw));
    expect(event.id).toBe('evt_fake_1');
    expect(() => provider.verifyWebhook(raw, 'wrong')).toThrow(/signature/i);
  });
});
```

**Validation scenarios.**
- [ ] Session ids are prefixed `cs_fake_` so a real id can never be confused with a
  fake one in a log.
- [ ] `expireCheckoutSession` returns `EXPIRED` for an open session and
  `ALREADY_COMPLETE` with `paymentStatus` for a paid one — the two branches the
  expiry saga depends on.
- [ ] `failNextWith` makes exactly the next call fail, so retry paths are testable.
- [ ] Refunds are capped at the charge and replay by idempotency key.
- [ ] `verifyWebhook` accepts a correct synthetic signature and rejects a wrong one.
- [ ] The fake email provider records every message in an inspectable outbox with
  subject, body, recipient, and locale.
- [ ] The fake SMS provider rejects a body over 480 characters, matching the real
  segment limit.

**Steps.**
- [ ] Define the three interfaces and their input/output types; every payment
  method takes `PaymentAccountContext` as its first argument, with a comment
  stating that `stripeAccountId` stays `undefined` for all of Phase 1 and is the
  seam Connect will fill (§12).
- [ ] Implement `FakePaymentProvider` over an in-memory `Map`, with test affordances
  `markPaid`, `markExpired`, `chargeIdFor`, `failNextWith`, `signatureFor`, and
  `sessions()` for assertions. Signature verification is HMAC-SHA256 over the raw
  body with a fixed test secret, so the shape matches Stripe's.
- [ ] Implement `FakeEmailProvider` and `FakeSmsProvider` with a `sent` array, a
  `failNextWith`, and — for SMS — the 480-character assertion.
- [ ] Write `providers.module.ts` selecting the implementation from
  `PAYMENT_PROVIDER`/`EMAIL_PROVIDER`/`SMS_PROVIDER` configuration values, and
  **refusing to start** if `NODE_ENV=production` while any provider is `fake`.
- [ ] Log one line at bootstrap naming which implementation each port resolved to,
  so a misconfigured production deployment is obvious in the first log lines.

**Commands.**
```bash
pnpm api test -- src/providers
```

**Expected successful result.** Fake-provider suites green; starting with
`NODE_ENV=production PAYMENT_PROVIDER=fake` exits non-zero with
`Fake providers are not allowed in production: PAYMENT_PROVIDER`.

**Commit.** `feat(providers): add payment, email and sms ports with in-memory fakes`

---

### Task 3.3 — Stripe payment adapter

**Objective.** Implement `PaymentProvider` against Stripe Checkout, with the API
version pinned, card-only payment methods, and the two expiry outcomes the saga
depends on distinguished correctly.

**Files.**
- `booking-app/apps/api/src/providers/payment/stripe-payment.provider.ts` (new)
- `booking-app/apps/api/src/providers/payment/stripe-payment.provider.spec.ts` (new)
- `booking-app/apps/api/src/providers/payment/stripe.errors.ts` (new)
- `booking-app/apps/api/src/providers/providers.module.ts` (edit)

**Produces for later tasks.** The production `PaymentProvider` binding; the
`ExpireResult` discrimination the expiry saga branches on.

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.** The Stripe SDK is stubbed at the client boundary — the adapter's
job is translation, and translation is what is worth testing.

```ts
// stripe-payment.provider.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { StripePaymentProvider } from './stripe-payment.provider.js';

const ctx = { organizationId: 'org-1', stripeAccountId: undefined };
const input = {
  bookingId: 'bk-1', clientReferenceId: 'bk-1', amountCents: 4500, currency: 'EUR',
  description: 'Facial Massage 30 min', customerEmail: 'anna@example.com',
  successUrl: 'https://booking.example.com/booking/success',
  cancelUrl: 'https://booking.example.com/booking/canceled',
  locale: 'de' as const, expiresAt: new Date('2026-08-14T06:05:00Z'),
};

function providerWith(stripe: unknown) {
  return new StripePaymentProvider(stripe as never, { webhookSecret: 'whsec_x' });
}

describe('StripePaymentProvider', () => {
  it('sends card-only methods, integer cents, the booking id and an expiry', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout/x' });
    await providerWith({ checkout: { sessions: { create } } }).createCheckoutSession(ctx, input);
    const args = create.mock.calls[0][0];
    expect(args.payment_method_types).toEqual(['card']);
    expect(args.mode).toBe('payment');
    expect(args.line_items[0].price_data.unit_amount).toBe(4500);
    expect(args.line_items[0].price_data.currency).toBe('eur');
    expect(args.client_reference_id).toBe('bk-1');
    expect(args.metadata).toMatchObject({ bookingId: 'bk-1', organizationId: 'org-1' });
    expect(args.locale).toBe('de');
    expect(args.expires_at).toBe(Math.floor(input.expiresAt.getTime() / 1000));
  });

  it('passes an idempotency key on session creation', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout/x' });
    await providerWith({ checkout: { sessions: { create } } })
      .createCheckoutSession(ctx, { ...input, idempotencyKey: 'req-1' });
    expect(create.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'req-1' });
  });

  it('maps a successful expire call to EXPIRED', async () => {
    const expire = vi.fn().mockResolvedValue({ id: 'cs_1', status: 'expired' });
    await expect(providerWith({ checkout: { sessions: { expire } } }).expireCheckoutSession(ctx, 'cs_1'))
      .resolves.toEqual({ outcome: 'EXPIRED' });
  });

  it('maps the "already completed" rejection to ALREADY_COMPLETE with the payment status', async () => {
    const err = Object.assign(new Error('You cannot expire a Session that is already complete.'), {
      type: 'StripeInvalidRequestError', code: undefined, statusCode: 400,
    });
    const expire = vi.fn().mockRejectedValue(err);
    const retrieve = vi.fn().mockResolvedValue({ id: 'cs_1', status: 'complete', payment_status: 'paid' });
    await expect(providerWith({ checkout: { sessions: { expire, retrieve } } }).expireCheckoutSession(ctx, 'cs_1'))
      .resolves.toEqual({ outcome: 'ALREADY_COMPLETE', paymentStatus: 'paid' });
  });

  it('rethrows a network error so BullMQ retries instead of releasing the slot', async () => {
    const err = Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });
    const expire = vi.fn().mockRejectedValue(err);
    await expect(providerWith({ checkout: { sessions: { expire } } }).expireCheckoutSession(ctx, 'cs_1'))
      .rejects.toThrow('socket hang up');
  });

  it('passes the refund idempotency key through to Stripe', async () => {
    const create = vi.fn().mockResolvedValue({ id: 're_1', status: 'succeeded', amount: 2000 });
    await providerWith({ refunds: { create } })
      .createRefund(ctx, { chargeId: 'ch_1', amountCents: 2000, idempotencyKey: 'rf-1' });
    expect(create.mock.calls[0][0]).toMatchObject({ charge: 'ch_1', amount: 2000 });
    expect(create.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'rf-1' });
  });

  it('does not send a stripeAccount header while stripeAccountId is undefined', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout/x' });
    await providerWith({ checkout: { sessions: { create } } }).createCheckoutSession(ctx, input);
    expect(create.mock.calls[0][1] ?? {}).not.toHaveProperty('stripeAccount');
  });
});
```

**Validation scenarios.**
- [ ] `payment_method_types: ['card']`, `mode: 'payment'`, integer `unit_amount`,
  lowercase currency.
- [ ] `client_reference_id` and `metadata.bookingId` are both set, so an event can
  be correlated even if the session id was never persisted (§7.1).
- [ ] Stripe's `expires_at` is at least 30 minutes after session creation; the
  application's five-minute reservation deadline remains on `Booking.expiresAt`.
- [ ] An idempotency key is forwarded on session creation and on refund creation.
- [ ] `expire` success → `{ outcome: 'EXPIRED' }`.
- [ ] `expire` "already complete" → a `retrieve` follow-up and
  `{ outcome: 'ALREADY_COMPLETE', paymentStatus }`.
- [ ] A connection error propagates unchanged so the job retries.
- [ ] No `stripeAccount` request option is sent while `stripeAccountId` is
  undefined — the Connect seam is inert, not merely unused.
- [ ] `verifyWebhook` uses `constructEvent` on the raw `Buffer` with a 300-second
  tolerance and throws on a bad signature.

**Steps.**
- [ ] Add `stripe` to the API package.
- [ ] Construct the client once with
  `new Stripe(secretKey, { apiVersion: '2025-06-30.basil', maxNetworkRetries: 2, timeout: 15_000 })`,
  the API version written as a literal constant with a comment that changing it
  requires re-reading the webhook payload assumptions.
- [ ] Build `requestOptions` from the context: `stripeAccountId` present →
  `{ stripeAccount }`, absent → `{}`. One helper, so the Connect switch is one
  line.
- [ ] Implement `createCheckoutSession` with `line_items` built from the
  server-resolved price, `customer_email`, `locale`, an `expires_at` at least 30
  minutes in the future (never the shorter `reservationTtlMinutes` deadline),
  `client_reference_id`, `metadata`, and `payment_intent_data.metadata` so the
  charge carries the booking id too. The internal expiry saga calls
  `expireCheckoutSession` when the five-minute application hold expires.
- [ ] Implement `expireCheckoutSession` catching `StripeInvalidRequestError` whose
  message matches `/already complete/i`, then `retrieve`-ing the session and
  returning `ALREADY_COMPLETE` with `payment_status`. Every other error rethrows.
- [ ] Implement `retrieveCheckoutSession` and `createRefund`, passing the
  idempotency key as a request option.
- [ ] Implement `verifyWebhook` with `stripe.webhooks.constructEvent(raw, sig,
  secret, 300)`, wrapping a failure in `AppError('UNAUTHENTICATED', { status: 400 })`.
- [ ] Register the adapter in `providers.module.ts` when `PAYMENT_PROVIDER=stripe`.

**Commands.**
```bash
pnpm api test -- src/providers/payment
pnpm api typecheck
```

**Expected successful result.** Every translation case green, including both expiry
branches and the inert Connect seam.

**Commit.** `feat(providers): add stripe checkout adapter with pinned api version`

---

### Task 3.4 — Resend email and Twilio SMS adapters

**Objective.** Real delivery for both channels, with signature verification for
their status webhooks and one uniform failure classification.

**Files.**
- `booking-app/apps/api/src/providers/email/resend-email.provider.ts` (new)
- `booking-app/apps/api/src/providers/email/resend-email.provider.spec.ts` (new)
- `booking-app/apps/api/src/providers/email/resend-signature.ts` (new)
- `booking-app/apps/api/src/providers/sms/twilio-sms.provider.ts` (new)
- `booking-app/apps/api/src/providers/sms/twilio-sms.provider.spec.ts` (new)
- `booking-app/apps/api/src/providers/sms/twilio-signature.ts` (new)
- `booking-app/apps/api/src/providers/providers.module.ts` (edit)

**Produces for later tasks.**

```ts
export function verifyResendSignature(raw: Buffer, headers: Record<string, string | undefined>, secret: string): void;
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string): void;
export type DeliveryFailureClass = 'RETRYABLE' | 'PERMANENT';
export function classifyProviderError(err: unknown): DeliveryFailureClass;
```

**Database changes.** None.
**API changes.** None yet — the webhook routes arrive in Task 7.2.
**Frontend changes.** None.

**Tests first.**

```ts
// twilio-sms.provider.spec.ts (excerpt)
import { describe, expect, it, vi } from 'vitest';
import { TwilioSmsProvider } from './twilio-sms.provider.js';
import { verifyTwilioSignature } from './twilio-signature.js';
import { createHmac } from 'node:crypto';

describe('TwilioSmsProvider', () => {
  it('sends from the configured number with a status callback', async () => {
    const create = vi.fn().mockResolvedValue({ sid: 'SM1' });
    const provider = new TwilioSmsProvider({ messages: { create } } as never, {
      from: '+4915100000000', statusCallbackUrl: 'https://api.example.com/api/webhooks/twilio',
    });
    const result = await provider.send({ to: '+4915112345678', body: 'Ihre Buchung ist bestätigt.' });
    expect(create.mock.calls[0][0]).toMatchObject({
      to: '+4915112345678', from: '+4915100000000',
      statusCallback: 'https://api.example.com/api/webhooks/twilio',
    });
    expect(result.providerMessageId).toBe('SM1');
  });

  it('rejects a body longer than three segments before spending money', async () => {
    const create = vi.fn();
    const provider = new TwilioSmsProvider({ messages: { create } } as never, { from: '+49151', statusCallbackUrl: 'x' });
    await expect(provider.send({ to: '+49151', body: 'x'.repeat(481) })).rejects.toThrow(/480/);
    expect(create).not.toHaveBeenCalled();
  });

  it('classifies an invalid number as PERMANENT and a 5xx as RETRYABLE', async () => {
    const { classifyProviderError } = await import('./twilio-sms.provider.js');
    expect(classifyProviderError({ status: 400, code: 21211 })).toBe('PERMANENT');
    expect(classifyProviderError({ status: 503 })).toBe('RETRYABLE');
  });
});

describe('verifyTwilioSignature', () => {
  const authToken = 'token';
  const url = 'https://api.example.com/api/webhooks/twilio';
  const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };

  it('accepts a correctly computed signature', () => {
    const data = url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join('');
    const sig = createHmac('sha1', authToken).update(data).digest('base64');
    expect(() => verifyTwilioSignature(url, params, sig, authToken)).not.toThrow();
  });

  it('rejects a tampered parameter', () => {
    const data = url + 'MessageSidSM1MessageStatusdelivered';
    const sig = createHmac('sha1', authToken).update(data).digest('base64');
    expect(() => verifyTwilioSignature(url, { ...params, MessageStatus: 'failed' }, sig, authToken)).toThrow(/signature/i);
  });
});
```

**Validation scenarios.**
- [ ] Resend send passes `from` as `"Name <address>"`, both `text` and `html`, and
  returns the provider message id.
- [ ] Resend signature verification accepts a valid Svix-style triple
  (`svix-id`, `svix-timestamp`, `svix-signature`), rejects a wrong signature, and
  rejects a timestamp older than 5 minutes.
- [ ] Twilio send passes `to`, `from`, and `statusCallback`.
- [ ] A body over 480 characters is rejected **before** the API call.
- [ ] Twilio signature verification sorts parameters, concatenates them onto the
  exact public URL, and rejects tampering.
- [ ] `classifyProviderError` returns `PERMANENT` for an invalid recipient and
  `RETRYABLE` for a 5xx or a connection error — the distinction the notification
  processor uses to decide between retrying and marking `FAILED`.

**Steps.**
- [ ] Add `resend` and `twilio` to the API package.
- [ ] Implement `ResendEmailProvider.send` mapping `EmailMessage` to the Resend
  payload, with `tags: [{ name: 'kind', value: msg.kind }]` so provider-side
  analytics stay useful without inspecting bodies.
- [ ] Implement `verifyResendSignature` as HMAC-SHA256 over
  `${svixId}.${svixTimestamp}.${rawBody}`, base64-compared with
  `timingSafeEqual`, plus the timestamp-window check.
- [ ] Implement `TwilioSmsProvider.send` with the length pre-check and the status
  callback, and `verifyTwilioSignature` per Twilio's documented algorithm using
  `timingSafeEqual`.
- [ ] Implement `classifyProviderError` with an explicit permanent-code list
  (Twilio `21211`, `21610`, `21614`; Resend `422`, `403`) and everything 5xx,
  `ECONNRESET`, `ETIMEDOUT`, or rate-limited as retryable.
- [ ] Register both adapters in `providers.module.ts` behind their configuration
  values.

**Commands.**
```bash
pnpm api test -- src/providers/email src/providers/sms
```

**Expected successful result.** Both adapter suites green, both signature
verifiers proven against a hand-computed HMAC rather than a mock.

**Commit.** `feat(providers): add resend email and twilio sms adapters with signature verification`
---

## Stage 4 — Durable messaging: queues, outbox, inbox, idempotency

### Task 4.1 — Queues, job contracts, and Redis wiring

**Objective.** Declare every queue and every job payload once, validated, so a
processor can never receive a shape it does not expect.

**Files.**
- `booking-app/packages/contracts/src/queues/index.ts` (new)
- `booking-app/packages/contracts/src/queues/queues.spec.ts` (new)
- `booking-app/apps/api/src/messaging/queues/queues.module.ts` (new)
- `booking-app/apps/api/src/messaging/queues/redis.provider.ts` (new)
- `booking-app/apps/api/src/messaging/queues/enqueue.service.ts` (new)

**Produces for later tasks.**

```ts
export const QUEUE = {
  BOOKING: 'booking',
  PAYMENT: 'payment',
  NOTIFICATION: 'notification',
  WEBHOOK: 'webhook',
  MAINTENANCE: 'maintenance',
} as const;

export const JOB = {
  BOOKING_EXPIRY_REQUESTED: 'booking.expiry_requested',
  BOOKING_CONFIRMED: 'booking.confirmed',
  BOOKING_CANCELED: 'booking.canceled',
  BOOKING_PAYMENT_FAILED: 'booking.payment_failed',
  BOOKING_RESCHEDULED: 'booking.rescheduled',
  REMINDER_SEND: 'reminder.send',
  REMINDER_SCHEDULE: 'reminder.schedule',
  REFUND_REQUESTED: 'refund.requested',
  REFUND_SUCCEEDED: 'refund.succeeded',
  NOTIFICATION_SEND: 'notification.send',
  STRIPE_EVENT: 'stripe.event',
  MESSAGING_EVENT: 'messaging.event',
  SWEEP_EXPIRED_RESERVATIONS: 'sweep.expired_reservations',
  SWEEP_STUCK_EXPIRING: 'sweep.stuck_expiring',
  SWEEP_OUTBOX: 'sweep.outbox',
  SWEEP_INBOX: 'sweep.inbox',
  SWEEP_NOTIFICATIONS: 'sweep.notifications',
  SWEEP_IDEMPOTENCY_KEYS: 'sweep.idempotency_keys',
  SWEEP_REMINDERS: 'sweep.reminders',
  SWEEP_RETENTION: 'sweep.retention',
} as const;

export const jobPayloadSchemas: { [K in JobName]: z.ZodType };
export function parseJobPayload<K extends JobName>(name: K, payload: unknown): JobPayload<K>;
export const JOB_QUEUE: Record<JobName, QueueName>;
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// queues.spec.ts
import { describe, expect, it } from 'vitest';
import { JOB, JOB_QUEUE, QUEUE, jobPayloadSchemas, parseJobPayload } from './index.js';

describe('job registry', () => {
  it('assigns every job to a declared queue', () => {
    for (const name of Object.values(JOB)) {
      expect(JOB_QUEUE[name], name).toBeDefined();
      expect(Object.values(QUEUE)).toContain(JOB_QUEUE[name]);
    }
  });
  it('declares a payload schema for every job', () => {
    for (const name of Object.values(JOB)) expect(jobPayloadSchemas[name], name).toBeDefined();
  });
  it('rejects a payload missing organizationId', () => {
    expect(() => parseJobPayload(JOB.BOOKING_CONFIRMED, { bookingId: 'bk-1' })).toThrow();
  });
  it('accepts a well-formed payload and returns it typed', () => {
    const payload = parseJobPayload(JOB.BOOKING_CONFIRMED, { organizationId: 'org-1', bookingId: 'bk-1' });
    expect(payload.bookingId).toBe('bk-1');
  });
  it('rejects an unknown job name', () => {
    // @ts-expect-error deliberate: the runtime guard must hold even if a cast bypasses the types
    expect(() => parseJobPayload('nope', {})).toThrow(/unknown job/i);
  });
});
```

**Validation scenarios.**
- [ ] Every job name maps to exactly one declared queue.
- [ ] Every job name has a payload schema — a new job without one fails the test.
- [ ] Every payload schema requires `organizationId`, so a processor always knows
  its tenant without reading it from anywhere else.
- [ ] An unknown job name throws rather than passing through unvalidated.
- [ ] The Redis connection uses `maxRetriesPerRequest: null` (BullMQ requires it)
  and a lazy connect.

**Steps.**
- [ ] Add `bullmq` and `ioredis` to the API package; add nothing to contracts but
  `zod`.
- [ ] Define `QUEUE`, `JOB`, `JOB_QUEUE`, and `jobPayloadSchemas`, every payload
  extending `z.object({ organizationId: cuidSchema })`.
- [ ] Implement `parseJobPayload` throwing on an unknown name and delegating to the
  schema otherwise.
- [ ] Implement `redis.provider.ts` creating one shared `IORedis` connection from
  `REDIS_URL` with `maxRetriesPerRequest: null`, `enableReadyCheck: true`, and a
  `lazyConnect` that is awaited at bootstrap so a bad URL fails at start-up.
- [ ] Implement `queues.module.ts` registering one BullMQ `Queue` per `QUEUE` value
  with default job options: `attempts: 8`,
  `backoff: { type: 'exponential', delay: 5_000 }`,
  `removeOnComplete: { age: 86_400, count: 5_000 }`,
  `removeOnFail: { age: 604_800 }`.
- [ ] Implement `EnqueueService.enqueue(name, payload, opts)` which validates the
  payload, resolves the queue from `JOB_QUEUE`, and attaches the current
  correlation id to the job data. Mark it `@Injectable()` and document that only
  the outbox dispatcher, the inbox controller, and the schedulers may call it.

**Commands.**
```bash
pnpm --filter @shape-and-flow/booking-contracts test
pnpm db:up
pnpm api test -- src/messaging/queues
```

**Expected successful result.** Registry tests green; the API boots with all five
queues registered and logs one line listing them.

**Commit.** `feat(messaging): declare queues and validated job payload contracts`

---

### Task 4.2 — Transactional outbox: recorder, dispatcher, reconciler

**Objective.** Make "state changed" and "job will run" the same commit, so no
confirmation email can be lost to a crash.

**Files.**
- `booking-app/apps/api/src/messaging/outbox/outbox.recorder.ts` (new)
- `booking-app/apps/api/src/messaging/outbox/outbox.dispatcher.ts` (new)
- `booking-app/apps/api/src/messaging/outbox/outbox.reconciler.ts` (new)
- `booking-app/apps/api/src/messaging/outbox/outbox.module.ts` (new)
- `booking-app/apps/api/test/integration/outbox.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class OutboxRecorder {
  /** MUST be called with the transaction client, never the root client. */
  record(tx: Prisma.TransactionClient, event: {
    organizationId: string; aggregateType: string; aggregateId: string;
    eventType: JobName; payload: unknown; availableAt?: Date;
  }): Promise<void>;
}
export class OutboxDispatcher { drainOnce(): Promise<number>; }
```

**Database changes.** None (the table exists from Task 1.2).
**API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// outbox.int.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestDatabase } from '../database.harness.js';
import { seedOrganization, makeBooking } from '../factories/index.js';
import { OutboxRecorder } from '../../src/messaging/outbox/outbox.recorder.js';
import { OutboxDispatcher } from '../../src/messaging/outbox/outbox.dispatcher.js';
import { JOB } from '@shape-and-flow/booking-contracts';

const { prisma, reset } = await withTestDatabase();
const recorder = new OutboxRecorder();
let ctx: Awaited<ReturnType<typeof seedOrganization>>;
let enqueue: { enqueue: ReturnType<typeof vi.fn> };
let dispatcher: OutboxDispatcher;

beforeEach(async () => {
  await reset();
  ctx = await seedOrganization(prisma);
  enqueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  dispatcher = new OutboxDispatcher(prisma, enqueue as never);
});

describe('outbox', () => {
  it('rolls the event back with the state change', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({ data: makeBooking(ctx) });
        await recorder.record(tx, {
          organizationId: ctx.organization.id, aggregateType: 'Booking',
          aggregateId: booking.id, eventType: JOB.BOOKING_CONFIRMED,
          payload: { organizationId: ctx.organization.id, bookingId: booking.id },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await prisma.outboxEvent.count({ where: { organizationId: ctx.organization.id } })).toBe(0);
    expect(await prisma.booking.count({ where: { organizationId: ctx.organization.id } })).toBe(0);
  });

  it('dispatches an undispatched row exactly once and marks it', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(ctx) });
    await prisma.$transaction((tx) => recorder.record(tx, {
      organizationId: ctx.organization.id, aggregateType: 'Booking', aggregateId: booking.id,
      eventType: JOB.BOOKING_CONFIRMED,
      payload: { organizationId: ctx.organization.id, bookingId: booking.id },
    }));
    expect(await dispatcher.drainOnce()).toBe(1);
    expect(await dispatcher.drainOnce()).toBe(0);
    expect(enqueue.enqueue).toHaveBeenCalledTimes(1);
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: booking.id } });
    expect(row.dispatchedAt).not.toBeNull();
  });

  it('derives the BullMQ job id from the outbox row id', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(ctx) });
    await prisma.$transaction((tx) => recorder.record(tx, {
      organizationId: ctx.organization.id, aggregateType: 'Booking', aggregateId: booking.id,
      eventType: JOB.BOOKING_CONFIRMED,
      payload: { organizationId: ctx.organization.id, bookingId: booking.id },
    }));
    await dispatcher.drainOnce();
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: booking.id } });
    expect(enqueue.enqueue.mock.calls[0][2]).toMatchObject({ jobId: `outbox:${row.id}` });
  });

  it('leaves availableAt in the future alone', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(ctx) });
    await prisma.$transaction((tx) => recorder.record(tx, {
      organizationId: ctx.organization.id, aggregateType: 'Booking', aggregateId: booking.id,
      eventType: JOB.BOOKING_CONFIRMED,
      payload: { organizationId: ctx.organization.id, bookingId: booking.id },
      availableAt: new Date(Date.now() + 60_000),
    }));
    expect(await dispatcher.drainOnce()).toBe(0);
  });

  it('backs off and records the error when enqueue throws, without dispatching', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(ctx) });
    await prisma.$transaction((tx) => recorder.record(tx, {
      organizationId: ctx.organization.id, aggregateType: 'Booking', aggregateId: booking.id,
      eventType: JOB.BOOKING_CONFIRMED,
      payload: { organizationId: ctx.organization.id, bookingId: booking.id },
    }));
    enqueue.enqueue.mockRejectedValueOnce(new Error('redis down'));
    await dispatcher.drainOnce();
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: booking.id } });
    expect(row.dispatchedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('redis down');
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses an event whose payload does not match its schema', async () => {
    await expect(
      prisma.$transaction((tx) => recorder.record(tx, {
        organizationId: ctx.organization.id, aggregateType: 'Booking', aggregateId: 'x',
        eventType: JOB.BOOKING_CONFIRMED, payload: { nope: true },
      })),
    ).rejects.toThrow();
  });

  it('does not double-dispatch under two concurrent dispatchers', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(ctx) });
    for (let i = 0; i < 20; i += 1) {
      await prisma.$transaction((tx) => recorder.record(tx, {
        organizationId: ctx.organization.id, aggregateType: 'Booking', aggregateId: booking.id,
        eventType: JOB.BOOKING_CONFIRMED,
        payload: { organizationId: ctx.organization.id, bookingId: booking.id },
      }));
    }
    const second = new OutboxDispatcher(prisma, enqueue as never);
    const [a, b] = await Promise.all([dispatcher.drainOnce(), second.drainOnce()]);
    expect(a + b).toBe(20);
    expect(enqueue.enqueue).toHaveBeenCalledTimes(20);
  });
});
```

**Validation scenarios.**
- [ ] A rolled-back transaction leaves no outbox row and no state change.
- [ ] A committed row dispatches exactly once; a second drain does nothing.
- [ ] `jobId` is `outbox:<rowId>`, so redelivery after a crash is a BullMQ no-op.
- [ ] `availableAt` in the future is not claimed.
- [ ] A failed enqueue increments `attempts`, records `lastError`, pushes
  `availableAt` out exponentially, and leaves `dispatchedAt` null.
- [ ] A payload that fails its schema is rejected at `record` time, before commit.
- [ ] Two concurrent dispatchers over 20 rows enqueue exactly 20 jobs — the
  `SKIP LOCKED` claim is proven, not assumed.
- [ ] A row with `attempts >= 10` is skipped by the dispatcher and counted by the
  reconciler as stuck.

**Steps.**
- [ ] Implement `OutboxRecorder.record` validating the payload with
  `parseJobPayload(eventType, payload)` **before** the insert, and inserting through
  the passed `tx`. Add a runtime guard that throws if the client passed is the root
  `PrismaService`, so "forgot the transaction" is a loud failure.
- [ ] Implement `OutboxDispatcher.drainOnce` as a single transaction:
  ```ts
  const rows = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
    SELECT id, organization_id, event_type, payload, attempts
    FROM outbox_events
    WHERE dispatched_at IS NULL AND available_at <= now() AND attempts < 10
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 50`);
  ```
  then, per row, enqueue with `jobId: \`outbox:${row.id}\`` and mark
  `dispatched_at = now()`; on an enqueue failure update `attempts`, `last_error`,
  and `available_at = now() + least(30s * 2^attempts, 1 hour)`.
- [ ] Run the dispatcher on a 500 ms interval in the worker only, guarded by a
  re-entrancy flag so a slow drain cannot overlap itself.
- [ ] Implement `OutboxReconciler` as a `MAINTENANCE` job (`SWEEP_OUTBOX`, every 5
  minutes) that counts undispatched rows older than 5 minutes and rows with
  `attempts >= 10`, logs them at `error` with the aggregate ids, and exposes the
  counts for `/api/health/detail`.
- [ ] Delete dispatched rows older than 14 days in the same maintenance job.

**Commands.**
```bash
pnpm test:infra:up
pnpm api test:integration -- test/integration/outbox.int.spec.ts
```

**Expected successful result.** Every outbox test green, including the concurrency
test that proves the claim query does not double-dispatch.

**Commit.** `feat(messaging): add transactional outbox recorder, dispatcher and reconciler`

---

### Task 4.3 — Inbox: webhook event recorder and reconciler

**Objective.** Make an inbound webhook safe to deliver twice, safe to crash
mid-processing, and impossible to lose.

**Files.**
- `booking-app/apps/api/src/messaging/inbox/inbox.recorder.ts` (new)
- `booking-app/apps/api/src/messaging/inbox/inbox.reconciler.ts` (new)
- `booking-app/apps/api/src/messaging/inbox/inbox.module.ts` (new)
- `booking-app/apps/api/test/integration/inbox.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class InboxRecorder {
  /** Returns DUPLICATE when the provider event id is already stored. */
  recordStripe(event: { id: string; type: string; apiVersion?: string; payload: unknown }):
    Promise<{ outcome: 'RECORDED'; rowId: string } | { outcome: 'DUPLICATE' }>;
  recordMessaging(provider: WebhookProvider, event: { id: string; type: string; payload: unknown }):
    Promise<{ outcome: 'RECORDED'; rowId: string } | { outcome: 'DUPLICATE' }>;
  markProcessed(kind: 'stripe' | 'messaging', providerEventId: string, note?: string): Promise<void>;
  markFailed(kind: 'stripe' | 'messaging', providerEventId: string, error: unknown): Promise<void>;
}
```

**Database changes.** None. **API changes.** None (routes arrive in 5.4 and 7.2).
**Frontend changes.** None.

**Tests first.**

```ts
// inbox.int.spec.ts (excerpt)
describe('inbox', () => {
  it('records a new event and reports RECORDED', async () => {
    const r = await recorder.recordStripe({ id: 'evt_1', type: 'checkout.session.completed', payload: { a: 1 } });
    expect(r.outcome).toBe('RECORDED');
  });

  it('reports DUPLICATE for the same provider event id without a second row', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'checkout.session.completed', payload: {} });
    const again = await recorder.recordStripe({ id: 'evt_1', type: 'checkout.session.completed', payload: {} });
    expect(again.outcome).toBe('DUPLICATE');
    expect(await prisma.stripeWebhookEvent.count({ where: { stripeEventId: 'evt_1' } })).toBe(1);
  });

  it('lets the same provider event id exist once per messaging provider', async () => {
    await recorder.recordMessaging('RESEND', { id: 'shared-1', type: 'email.delivered', payload: {} });
    const twilio = await recorder.recordMessaging('TWILIO', { id: 'shared-1', type: 'delivered', payload: {} });
    expect(twilio.outcome).toBe('RECORDED');
  });

  it('marks processed idempotently', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });
    await recorder.markProcessed('stripe', 'evt_1');
    const first = await prisma.stripeWebhookEvent.findFirstOrThrow({ where: { stripeEventId: 'evt_1' } });
    await recorder.markProcessed('stripe', 'evt_1');
    const second = await prisma.stripeWebhookEvent.findFirstOrThrow({ where: { stripeEventId: 'evt_1' } });
    expect(second.processedAt?.toISOString()).toBe(first.processedAt?.toISOString());
  });

  it('records attempts and the last error on failure', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });
    await recorder.markFailed('stripe', 'evt_1', new Error('boom'));
    const row = await prisma.stripeWebhookEvent.findFirstOrThrow({ where: { stripeEventId: 'evt_1' } });
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('boom');
    expect(row.processedAt).toBeNull();
  });

  it('re-enqueues an event unprocessed for more than five minutes', async () => {
    await recorder.recordStripe({ id: 'evt_old', type: 'x', payload: {} });
    await prisma.stripeWebhookEvent.updateMany({
      where: { stripeEventId: 'evt_old' },
      data: { receivedAt: new Date(Date.now() - 6 * 60_000) },
    });
    expect(await reconciler.runOnce()).toBe(1);
    expect(enqueue.enqueue).toHaveBeenCalledWith(
      'stripe.event', expect.objectContaining({ stripeEventId: 'evt_old' }), expect.objectContaining({ jobId: 'stripe:evt_old' }),
    );
  });

  it('does not re-enqueue a fresh unprocessed event', async () => {
    await recorder.recordStripe({ id: 'evt_new', type: 'x', payload: {} });
    expect(await reconciler.runOnce()).toBe(0);
  });
});
```

**Validation scenarios.**
- [ ] A new event records and reports `RECORDED`.
- [ ] A repeat provider event id reports `DUPLICATE` and creates no second row.
- [ ] The same id from Resend and from Twilio both record — the unique key is
  composite.
- [ ] `markProcessed` is idempotent and does not move `processedAt`.
- [ ] `markFailed` increments `attempts`, records `lastError`, and leaves
  `processedAt` null.
- [ ] An event unprocessed for over 5 minutes is re-enqueued with the deterministic
  job id; a fresh one is not.
- [ ] An event whose `attempts >= 10` is reported as poisoned rather than
  re-enqueued forever.

**Steps.**
- [ ] Implement `recordStripe` / `recordMessaging` with a plain `create` inside a
  `try`, catching `isUniqueViolation(err, 'stripeEventId')` (and the composite for
  messaging) and returning `DUPLICATE`. Insert-then-catch rather than
  check-then-insert, because the check-then-insert version races.
- [ ] Use the `$unsafeGlobal` client here with the documented comment: an inbound
  event has no organization yet, and the filter is the provider event id.
- [ ] Implement `markProcessed` with `updateMany` and
  `where: { processedAt: null }`, so a second call is a no-op.
- [ ] Implement `InboxReconciler.runOnce` selecting unprocessed rows with
  `receivedAt < now() - 5 minutes AND attempts < 10`, re-enqueueing each with the
  deterministic job id, and logging any row at `attempts >= 10` at `error` as
  poisoned.
- [ ] Schedule the reconciler as `SWEEP_INBOX` every 2 minutes in the worker.
- [ ] Delete processed Stripe rows older than 90 days and messaging rows older than
  30 days in the same job.

**Commands.**
```bash
pnpm api test:integration -- test/integration/inbox.int.spec.ts
```

**Expected successful result.** Every inbox test green, including the composite
uniqueness case and the reconciler window.

**Commit.** `feat(messaging): add webhook inbox recorder and reconciler`

---

### Task 4.4 — Idempotency service, interceptor, and sweeper

**Objective.** Make `POST /public/bookings` and every money-moving office mutation
safely retryable, with the Checkout URL reachable only by the key holder.

**Files.**
- `booking-app/apps/api/src/messaging/idempotency/idempotency.service.ts` (new)
- `booking-app/apps/api/src/messaging/idempotency/idempotency.interceptor.ts` (new)
- `booking-app/apps/api/src/messaging/idempotency/idempotent.decorator.ts` (new)
- `booking-app/apps/api/src/messaging/idempotency/request-hash.ts` (new)
- `booking-app/apps/api/src/messaging/idempotency/request-hash.spec.ts` (new)
- `booking-app/apps/api/test/integration/idempotency.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export function Idempotent(scope: 'booking.create' | 'refund.create' | 'manual-payment.create'): MethodDecorator;
export function canonicalRequestHash(body: unknown): string;      // sha256 of canonical JSON
export class IdempotencyService {
  begin(key: string, scope: string, requestHash: string):
    Promise<{ outcome: 'NEW' } | { outcome: 'REPLAY'; statusCode: number; body: unknown } |
             { outcome: 'IN_PROGRESS' } | { outcome: 'MISMATCH' }>;
  complete(key: string, statusCode: number, body: unknown, meta?: { organizationId?: string; bookingId?: string }): Promise<void>;
  abandon(key: string): Promise<void>;
}
```

**Database changes.** None. **API changes.** The `Idempotency-Key` behaviour from
§6.1 and §8.5. **Frontend changes.** None.

**Tests first.**

```ts
// request-hash.spec.ts
import { describe, expect, it } from 'vitest';
import { canonicalRequestHash } from './request-hash.js';

describe('canonicalRequestHash', () => {
  it('is stable under key order', () => {
    expect(canonicalRequestHash({ a: 1, b: 2 })).toBe(canonicalRequestHash({ b: 2, a: 1 }));
  });
  it('is stable under nested key order and whitespace', () => {
    expect(canonicalRequestHash({ c: { x: 1, y: 2 } })).toBe(canonicalRequestHash({ c: { y: 2, x: 1 } }));
  });
  it('normalises the customer email case and surrounding whitespace', () => {
    expect(canonicalRequestHash({ customer: { email: ' Anna@Example.COM ' } }))
      .toBe(canonicalRequestHash({ customer: { email: 'anna@example.com' } }));
  });
  it('distinguishes a different slot', () => {
    expect(canonicalRequestHash({ startsAt: '2026-08-14T07:00:00.000Z' }))
      .not.toBe(canonicalRequestHash({ startsAt: '2026-08-14T07:15:00.000Z' }));
  });
  it('distinguishes null from absent', () => {
    expect(canonicalRequestHash({ employeeId: null })).not.toBe(canonicalRequestHash({}));
  });
  it('preserves array order', () => {
    expect(canonicalRequestHash({ a: [1, 2] })).not.toBe(canonicalRequestHash({ a: [2, 1] }));
  });
});
```

```ts
// idempotency.int.spec.ts (excerpt)
describe('IdempotencyService', () => {
  it('reports NEW for an unknown key', async () => {
    expect(await service.begin('k1', 'booking.create', 'h1')).toEqual({ outcome: 'NEW' });
  });

  it('replays the stored response for the same key and hash', async () => {
    await service.begin('k1', 'booking.create', 'h1');
    await service.complete('k1', 201, { checkoutUrl: 'https://checkout/x' });
    expect(await service.begin('k1', 'booking.create', 'h1')).toEqual({
      outcome: 'REPLAY', statusCode: 201, body: { checkoutUrl: 'https://checkout/x' },
    });
  });

  it('reports MISMATCH for the same key with a different hash', async () => {
    await service.begin('k1', 'booking.create', 'h1');
    await service.complete('k1', 201, {});
    expect(await service.begin('k1', 'booking.create', 'h2')).toEqual({ outcome: 'MISMATCH' });
  });

  it('reports MISMATCH for the same key in a different scope', async () => {
    await service.begin('k1', 'booking.create', 'h1');
    await service.complete('k1', 201, {});
    expect(await service.begin('k1', 'refund.create', 'h1')).toEqual({ outcome: 'MISMATCH' });
  });

  it('reports IN_PROGRESS while the first attempt has not completed', async () => {
    await service.begin('k1', 'booking.create', 'h1');
    expect(await service.begin('k1', 'booking.create', 'h1')).toEqual({ outcome: 'IN_PROGRESS' });
  });

  it('lets a key be reused after abandon, so a failed attempt is retryable', async () => {
    await service.begin('k1', 'booking.create', 'h1');
    await service.abandon('k1');
    expect(await service.begin('k1', 'booking.create', 'h1')).toEqual({ outcome: 'NEW' });
  });

  it('serialises two simultaneous begins on the same key', async () => {
    const [a, b] = await Promise.all([
      service.begin('k1', 'booking.create', 'h1'),
      service.begin('k1', 'booking.create', 'h1'),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['IN_PROGRESS', 'NEW']);
  });

  it('sweeps expired keys', async () => {
    await service.begin('k-old', 'booking.create', 'h1');
    await prisma.idempotencyKey.updateMany({ where: { key: 'k-old' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await service.sweep()).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { key: 'k-old' } })).toBe(0);
  });
});
```

**Validation scenarios.**
- [ ] The hash is stable under key order at every nesting level, normalises email
  case and whitespace, distinguishes different slots, distinguishes `null` from
  absent, and preserves array order.
- [ ] Unknown key → `NEW`; completed key with the same hash → `REPLAY` with the
  exact stored status and body; different hash → `MISMATCH`; different scope →
  `MISMATCH`; still running → `IN_PROGRESS`.
- [ ] `abandon` frees the key so a genuinely failed attempt can be retried.
- [ ] Two simultaneous `begin` calls yield exactly one `NEW`.
- [ ] Expired keys are swept.
- [ ] The interceptor returns `422 IDEMPOTENCY_KEY_REUSED` on `MISMATCH` and
  `409 IDEMPOTENT_REQUEST_IN_PROGRESS` on `IN_PROGRESS`.
- [ ] A missing or non-UUID `Idempotency-Key` on a decorated route is
  `400 VALIDATION_FAILED`.
- [ ] A 5xx response does **not** store a snapshot — it calls `abandon`, so the
  client's retry actually retries.

**Steps.**
- [ ] Implement `canonicalRequestHash`: recursively sort object keys, lowercase and
  trim any `email` field, `JSON.stringify` with no spacing, SHA-256, hex.
- [ ] Implement `begin` as an insert-then-catch on the unique `key`: on unique
  violation, read the row and branch on `scope`/`requestHash`/`state`.
- [ ] Implement `complete` storing `statusCode`, `responseSnapshot`, `state =
  'COMPLETED'`, `organizationId`, `bookingId`, and `expiresAt = now + 24 h`.
- [ ] Implement `abandon` deleting the row.
- [ ] Implement the interceptor: read the header, validate it as a UUID, compute the
  hash from the parsed body, call `begin`, and either short-circuit with the replay,
  throw the mapped error, or proceed and then `complete` (2xx) / `abandon`
  (anything else) in a `tap`/`catchError` pair.
- [ ] Add `SWEEP_IDEMPOTENCY_KEYS` to the nightly maintenance schedule.
- [ ] Document in the decorator's doc comment that the key is the **only** thing
  that returns a Checkout URL, so it must never be logged (it is already in the
  redaction list).

**Commands.**
```bash
pnpm api test -- src/messaging/idempotency
pnpm api test:integration -- test/integration/idempotency.int.spec.ts
```

**Expected successful result.** Every idempotency case green, including the
concurrent-`begin` race and the abandon-on-failure path.

**Commit.** `feat(messaging): add idempotency service, interceptor and sweeper`
---

## Stage 5 — Public booking, reservation, payment, expiry

### Task 5.1 — Public catalog and availability endpoints

**Objective.** Serve the organization, the catalog, and real slots, with the
availability snapshot loaded in a bounded number of queries.

**Files.**
- `booking-app/packages/contracts/src/public/index.ts` (new)
- `booking-app/apps/api/src/public/public-catalog.controller.ts` (new)
- `booking-app/apps/api/src/public/public-availability.controller.ts` (new)
- `booking-app/apps/api/src/public/availability-snapshot.service.ts` (new)
- `booking-app/apps/api/src/public/public.module.ts` (new)
- `booking-app/apps/api/src/common/guards/public.decorator.ts` (new)
- `booking-app/apps/api/test/integration/public-availability.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class AvailabilitySnapshotService {
  /** Loads everything the pure engine needs in five queries, for one service. */
  load(input: { serviceId: string; employeeId?: string; from: LocalDate; to: LocalDate }): Promise<AvailabilitySnapshot>;
  /** Narrow snapshot for one employee and one instant, used inside the reservation transaction. */
  loadForSlot(tx: Prisma.TransactionClient, input: { serviceId: string; employeeId: string; startsAt: Date }): Promise<AvailabilitySnapshot>;
}
```

**Database changes.** None.
**API changes.** `GET /public/organizations/current`, `/public/service-categories`,
`/public/services`, `/public/services/:serviceId/employees`,
`/public/availability` — exactly as specified in §6.2.
**Frontend changes.** None.

**Tests first.**

```ts
// public-availability.int.spec.ts (excerpt)
describe('GET /api/public/availability', () => {
  it('returns slots for the seeded Friday and never exposes who is booked', async () => {
    const res = await request(app).get('/api/public/availability')
      .query({ serviceId: ctx.service30.id, from: '2026-08-14', to: '2026-08-14' }).expect(200);
    expect(res.body.timezone).toBe('Europe/Berlin');
    expect(res.body.days[0].date).toBe('2026-08-14');
    expect(res.body.days[0].slots.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('customer');
    expect(JSON.stringify(res.body)).not.toContain('booking');
  });

  it('removes a slot once a blocking booking exists', async () => {
    const before = await slotTimes({ from: '2026-08-14', to: '2026-08-14' });
    await prisma.booking.create({ data: makeBooking(ctx, {
      employeeId: ctx.employee1.id, status: 'PENDING_PAYMENT', expiresAt: new Date(Date.now() + 300_000),
      blockStartsAt: new Date(before[0]!), blockEndsAt: new Date(new Date(before[0]!).getTime() + 30 * 60_000),
    }) });
    const after = await slotTimes({ from: '2026-08-14', to: '2026-08-14' });
    expect(after).not.toContain(before[0]);
  });

  it('rejects a range wider than 31 days', async () => {
    await request(app).get('/api/public/availability')
      .query({ serviceId: ctx.service30.id, from: '2026-08-01', to: '2026-09-15' })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('VALIDATION_FAILED'));
  });

  it('rejects a date beyond the booking horizon', async () => {
    await request(app).get('/api/public/availability')
      .query({ serviceId: ctx.service30.id, from: '2028-01-01', to: '2028-01-02' })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('OUTSIDE_BOOKING_WINDOW'));
  });

  it('404s an archived service without saying it exists', async () => {
    await prisma.service.update({ where: { id: ctx.service30.id }, data: { archivedAt: new Date() } });
    await request(app).get('/api/public/availability')
      .query({ serviceId: ctx.service30.id, from: '2026-08-14', to: '2026-08-14' })
      .expect(404).expect((r) => expect(r.body.code).toBe('NOT_FOUND'));
  });

  it('ignores an organizationId supplied by the client', async () => {
    const res = await request(app).get('/api/public/availability')
      .query({ serviceId: ctx.service30.id, from: '2026-08-14', to: '2026-08-14', organizationId: 'other-org' })
      .expect(200);
    expect(res.body.days).toBeDefined();
  });

  it('loads the snapshot in a bounded number of queries', async () => {
    const counter = countQueries(prisma);
    await request(app).get('/api/public/availability')
      .query({ serviceId: ctx.service30.id, from: '2026-08-01', to: '2026-08-31' }).expect(200);
    expect(counter.total()).toBeLessThanOrEqual(6);
  });
});
```

**Validation scenarios.**
- [ ] Slots are returned for the seeded schedule with the correct timezone label.
- [ ] A blocking booking removes exactly the overlapping slots.
- [ ] A range wider than 31 days is `400 VALIDATION_FAILED`.
- [ ] A date beyond the horizon is `422 OUTSIDE_BOOKING_WINDOW`.
- [ ] An archived or unknown service is `404 NOT_FOUND`.
- [ ] An `organizationId` query parameter is stripped by the schema and changes
  nothing.
- [ ] A 31-day query issues at most six database queries — no N+1 per day or per
  employee.
- [ ] `employeeId` narrows the result and `employeeIds` then contains exactly that
  one id.
- [ ] `GET /public/services` omits archived services and services with
  `isBookableOnline = false`.
- [ ] `GET /public/services/:id/employees` returns the effective price per employee,
  including overrides.
- [ ] No public response contains a customer field, an employee email, or an
  internal booking id.

**Steps.**
- [ ] Write the public contracts: `availabilityQuerySchema` (with the ≤ 31-day
  refinement), `availabilityResponseSchema`, `serviceListResponseSchema`,
  `organizationCurrentResponseSchema`, `serviceEmployeesResponseSchema`.
- [ ] Implement a global `AuthGuard` that denies any route not marked `@Public()`,
  not carrying a session, and not carrying a management token — so a new controller
  is closed by default. Mark the public controllers `@Public()`.
- [ ] Implement `AvailabilitySnapshotService.load` with exactly five queries:
  service with its category, employee-service links with employees, working hours
  with breaks for those employees, exceptions plus approved time off in range,
  and blocking bookings plus blocked times in range. Expand time-off ranges to
  dates in memory.
- [ ] Implement `loadForSlot` as the same shape narrowed to one employee and a
  one-day window, taking the transaction client so the reservation re-check reads
  inside the lock.
- [ ] Implement the controllers, mapping engine output to the response contract and
  hand-writing every projection (no model spreads).
- [ ] Apply the `@Throttle` limits from §6.1.

**Commands.**
```bash
pnpm api test:integration -- test/integration/public-availability.int.spec.ts
curl -fsS "http://localhost:3000/api/public/availability?serviceId=<id>&from=2026-08-14&to=2026-08-14" | head -c 400
```

**Expected successful result.** Real slots for the seeded business, correct
Berlin-local times, and the query-count assertion holding for a full month.

**Commit.** `feat(public): add catalog and availability endpoints with bounded snapshot loading`

---

### Task 5.2 — Reservation transaction

**Objective.** Turn a slot request into a `PENDING_PAYMENT` booking that is
provably free of double-booking, with "any available employee" resolved
server-side before the insert.

**Files.**
- `booking-app/apps/api/src/booking/reservation.service.ts` (new)
- `booking-app/apps/api/src/booking/booking-reference.ts` (new)
- `booking-app/apps/api/src/booking/calendar-lock.ts` (new)
- `booking-app/apps/api/src/booking/customer-upsert.service.ts` (new)
- `booking-app/apps/api/test/integration/reservation.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export async function withCalendarLock<T>(tx: Prisma.TransactionClient, employeeIds: string[], fn: () => Promise<T>): Promise<T>;
export class ReservationService {
  reserve(input: ReserveInput): Promise<{ booking: Booking; employee: Employee; price: Money }>;
}
export function generateBookingReference(): string;   // 'SF-' + 6 Crockford base32 chars
```

**Database changes.** None.
**API changes.** None yet — the controller arrives in 5.3.
**Frontend changes.** None.

**Tests first.**

```ts
// reservation.int.spec.ts (excerpt)
describe('ReservationService', () => {
  const slot = new Date('2026-08-14T07:00:00Z');

  it('creates a PENDING_PAYMENT booking with snapshots and an expiry', async () => {
    const { booking } = await service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot }));
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.priceCentsSnapshot).toBe(4500);
    expect(booking.durationMinutesSnapshot).toBe(30);
    expect(booking.serviceNameSnapshot).toBe('Facial Massage 30 min');
    expect(booking.expiresAt).not.toBeNull();
    expect(booking.blockEndsAt.getTime() - booking.endsAt.getTime()).toBe(5 * 60_000);
    expect(booking.reference).toMatch(/^SF-[0-9A-HJKMNP-TV-Z]{6}$/);
  });

  it('writes a status-history row in the same transaction', async () => {
    const { booking } = await service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot }));
    const history = await prisma.bookingStatusHistory.findMany({ where: { bookingId: booking.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: null, toStatus: 'PENDING_PAYMENT', actorType: 'CUSTOMER' });
  });

  it('resolves "any available employee" deterministically and never leaves a null resource', async () => {
    const { booking, employee } = await service.reserve(input({ employeeId: null, startsAt: slot }));
    expect(booking.employeeId).toBe(employee.id);
    expect([ctx.employee1.id, ctx.employee2.id]).toContain(booking.employeeId);
    const again = await service.reserve(input({ employeeId: null, startsAt: new Date('2026-08-14T07:30:00Z') }));
    expect(again.booking.employeeId).not.toBe(booking.employeeId); // load balanced
  });

  it('rejects a second reservation for the same employee and slot with SLOT_UNAVAILABLE', async () => {
    await service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot }));
    await expect(service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot })))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('serialises twenty concurrent attempts on one slot into one winner', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot }))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    }
    expect(await prisma.booking.count({ where: { employeeId: ctx.employee1.id, blockStartsAt: slot } })).toBe(1);
  });

  it('lets two employees be reserved for the same instant concurrently', async () => {
    const results = await Promise.all([
      service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot })),
      service.reserve(input({ employeeId: ctx.employee2.id, startsAt: slot })),
    ]);
    expect(new Set(results.map((r) => r.booking.employeeId)).size).toBe(2);
  });

  it('rejects a slot that conflicts with a blocked time, which no constraint can see', async () => {
    await prisma.blockedTime.create({ data: {
      organizationId: ctx.organization.id, employeeId: ctx.employee1.id,
      startsAt: slot, endsAt: new Date(slot.getTime() + 30 * 60_000),
      createdByOfficeUserId: ctx.owner.id,
    } });
    await expect(service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot })))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('rejects an off-grid start time and a slot inside the notice window', async () => {
    await expect(service.reserve(input({ employeeId: ctx.employee1.id, startsAt: new Date('2026-08-14T07:07:00Z') })))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    await expect(service.reserve(input({ employeeId: ctx.employee1.id, startsAt: new Date('2026-08-01T07:00:00Z') })))
      .rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });

  it('reuses an existing customer by normalised email without overwriting the stored name', async () => {
    await service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot, email: 'Anna@Example.com' }));
    await service.reserve(input({ employeeId: ctx.employee2.id, startsAt: slot, email: 'anna@example.com ' }));
    expect(await prisma.customer.count({ where: { organizationId: ctx.organization.id, emailNormalized: 'anna@example.com' } })).toBe(1);
  });

  it('takes the advisory lock before reading, so the re-check cannot race', async () => {
    const statements = captureSql(prisma);
    await service.reserve(input({ employeeId: ctx.employee1.id, startsAt: slot }));
    const first = statements.find((s) => s.includes('pg_advisory_xact_lock'));
    expect(statements.indexOf(first!)).toBeLessThan(statements.findIndex((s) => /FROM "?bookings"?/i.test(s)));
  });
});
```

**Validation scenarios.**
- [ ] A reservation stores every snapshot column, `expiresAt`, and buffer-extended
  block bounds.
- [ ] A `BookingStatusHistory` row is written in the same transaction.
- [ ] "Any available employee" resolves to a concrete employee, deterministically,
  and load-balances across employees.
- [ ] A duplicate reservation is `409 SLOT_UNAVAILABLE`.
- [ ] Twenty concurrent attempts on one slot produce exactly one booking.
- [ ] Two different employees at the same instant both succeed.
- [ ] A conflicting `BlockedTime` is rejected — proving the advisory lock covers
  what the exclusion constraint cannot.
- [ ] An off-grid start is rejected; a slot inside the notice window is
  `422 OUTSIDE_BOOKING_WINDOW`.
- [ ] Customers are matched by normalised email; a second booking does not create a
  duplicate customer.
- [ ] The advisory lock statement precedes every read in the transaction.
- [ ] A `23P01` from the constraint is translated to `SLOT_UNAVAILABLE`, not a 500.

**Steps.**
- [ ] Implement `withCalendarLock` issuing
  `SELECT pg_advisory_xact_lock(${CALENDAR_LOCK_CLASS_ID}, hashtext(${id}))` for
  each employee id **sorted ascending**, as the first statements of the
  transaction.
- [ ] Implement `generateBookingReference` over the Crockford alphabet
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ` minus `I`, `L`, `O`, `U`, retrying on a unique
  violation up to five times.
- [ ] Implement `CustomerUpsertService` doing an `upsert` on
  `(organizationId, emailNormalized)` that sets names and phone only when the row is
  created, and updates `locale` always.
- [ ] Implement `ReservationService.reserve`:
  - [ ] Load the service and validate it is bookable online and not archived.
  - [ ] Validate the booking window against settings before touching a lock.
  - [ ] Resolve the candidate employee set (explicit id, or every employee linked to
    the service).
  - [ ] For "any": load a snapshot, filter to employees for whom
    `isSlotBookable` is true, count each one's blocking bookings that local day,
    and pick with `selectEmployee`. Throw `SLOT_UNAVAILABLE` when the set is empty.
  - [ ] Open a transaction with `isolationLevel: 'ReadCommitted'`, `timeout: 15_000`,
    `maxWait: 10_000`; take the lock; `loadForSlot`; assert `isSlotBookable`; upsert
    the customer; insert the booking; insert the history row.
  - [ ] Catch `isExclusionViolation(err, 'bookings_no_overlap')` and rethrow as
    `AppError('SLOT_UNAVAILABLE')`; wrap the whole call in
    `withSerializationRetry`.
- [ ] Compute `blockStartsAt`/`blockEndsAt` from the snapshot buffers, never from
  the live service row.

**Commands.**
```bash
pnpm api test:integration -- test/integration/reservation.int.spec.ts
```

**Expected successful result.** All reservation tests green, including the
twenty-way concurrency test and the blocked-time case that only the advisory lock
can catch.

**Commit.** `feat(booking): add reservation transaction with advisory lock and employee resolution`

---

### Task 5.3 — Booking endpoint, Checkout Session, idempotent replay

**Objective.** Expose `POST /public/bookings`, create the Checkout Session outside
any transaction, and make the Checkout URL replayable only by the key holder.

**Files.**
- `booking-app/packages/contracts/src/public/bookings.ts` (new)
- `booking-app/apps/api/src/public/public-bookings.controller.ts` (new)
- `booking-app/apps/api/src/booking/booking-checkout.service.ts` (new)
- `booking-app/apps/api/src/booking/booking.module.ts` (new)
- `booking-app/apps/api/test/integration/public-bookings.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class BookingCheckoutService {
  createSessionForReservation(bookingId: string, urls: { successUrl: string; cancelUrl: string }):
    Promise<{ checkoutUrl: string; sessionId: string }>;
}
```

**Database changes.** None.
**API changes.** `POST /public/bookings`,
`GET /public/bookings/by-session/:checkoutSessionId`.
**Frontend changes.** None.

**Tests first.**

```ts
// public-bookings.int.spec.ts (excerpt)
const body = () => ({
  serviceId: ctx.service30.id, employeeId: ctx.employee1.id,
  startsAt: '2026-08-14T07:00:00.000Z',
  customer: { email: 'anna@example.com', firstName: 'Anna', lastName: 'Becker', phone: '+4915112345678' },
  locale: 'de', customerNote: 'Erstbesuch',
  successUrl: 'http://localhost:5173/booking/success', cancelUrl: 'http://localhost:5173/booking/canceled',
});

describe('POST /api/public/bookings', () => {
  it('reserves, creates a session, and returns the checkout url', async () => {
    const res = await request(app).post('/api/public/bookings')
      .set('Idempotency-Key', randomUUID()).send(body()).expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING_PAYMENT', price: { amountCents: 4500, currency: 'EUR' } });
    expect(res.body.checkoutUrl).toContain('cs_fake_');
    expect(res.body.expiresAt).toBeTypeOf('string');
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.bookingId } });
    expect(booking.stripeCheckoutSessionId).toBe(res.body.checkoutUrl.split('/').pop());
    expect(await prisma.payment.count({ where: { bookingId: booking.id, status: 'PENDING' } })).toBe(1);
  });

  it('replays the identical response, checkout url included, for the same key and body', async () => {
    const key = randomUUID();
    const first = await request(app).post('/api/public/bookings').set('Idempotency-Key', key).send(body()).expect(201);
    const second = await request(app).post('/api/public/bookings').set('Idempotency-Key', key).send(body()).expect(201);
    expect(second.body).toEqual(first.body);
    expect(await prisma.booking.count()).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const key = randomUUID();
    await request(app).post('/api/public/bookings').set('Idempotency-Key', key).send(body()).expect(201);
    await request(app).post('/api/public/bookings').set('Idempotency-Key', key)
      .send({ ...body(), startsAt: '2026-08-14T07:30:00.000Z' })
      .expect(422).expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED'));
  });

  it('gives the second customer on the same slot 409 SLOT_UNAVAILABLE', async () => {
    await request(app).post('/api/public/bookings').set('Idempotency-Key', randomUUID()).send(body()).expect(201);
    await request(app).post('/api/public/bookings').set('Idempotency-Key', randomUUID())
      .send({ ...body(), customer: { ...body().customer, email: 'bea@example.com' } })
      .expect(409).expect((r) => expect(r.body.code).toBe('SLOT_UNAVAILABLE'));
  });

  it('requires an Idempotency-Key and rejects a non-uuid one', async () => {
    await request(app).post('/api/public/bookings').send(body()).expect(400);
    await request(app).post('/api/public/bookings').set('Idempotency-Key', 'abc').send(body()).expect(400);
  });

  it('rejects a successUrl outside the configured origin', async () => {
    await request(app).post('/api/public/bookings').set('Idempotency-Key', randomUUID())
      .send({ ...body(), successUrl: 'https://evil.example.com/x' })
      .expect(400).expect((r) => expect(r.body.code).toBe('VALIDATION_FAILED'));
  });

  it('strips an organizationId from the body', async () => {
    const res = await request(app).post('/api/public/bookings').set('Idempotency-Key', randomUUID())
      .send({ ...body(), organizationId: 'other' }).expect(201);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.bookingId } });
    expect(booking.organizationId).toBe(ctx.organization.id);
  });

  it('leaves a reservation without a session id when Stripe fails, and does not 500 into an orphan', async () => {
    fakePayment.failNextWith(new Error('ECONNRESET'));
    await request(app).post('/api/public/bookings').set('Idempotency-Key', randomUUID()).send(body()).expect(502);
    const booking = await prisma.booking.findFirstOrThrow();
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.stripeCheckoutSessionId).toBeNull();
    expect(await prisma.idempotencyKey.count({ where: { state: 'COMPLETED' } })).toBe(0);
  });

  it('never opens a transaction around the Stripe call', async () => {
    const statements = captureSql(prisma);
    await request(app).post('/api/public/bookings').set('Idempotency-Key', randomUUID()).send(body()).expect(201);
    const opens = statements.filter((s) => s === 'BEGIN').length;
    expect(opens).toBe(2); // reservation, then session attachment
  });
});
```

**Validation scenarios.**
- [ ] A successful call returns `bookingId`, `reference`, resolved employee, price,
  `expiresAt`, and `checkoutUrl`; the booking carries the session id and a `PENDING`
  payment exists.
- [ ] The same key and body replays byte-identically and creates no second booking.
- [ ] The same key with a different body is `422 IDEMPOTENCY_KEY_REUSED`.
- [ ] A different customer on the same slot is `409 SLOT_UNAVAILABLE`.
- [ ] A missing or malformed `Idempotency-Key` is `400`.
- [ ] A `successUrl` outside `PUBLIC_WEB_ORIGIN` is rejected.
- [ ] An `organizationId` in the body is ignored.
- [ ] A Stripe failure leaves a `PENDING_PAYMENT` booking with a null session id, no
  completed idempotency record, and returns `502` — the reservation then expires
  normally.
- [ ] Exactly two transactions are opened and the Stripe call is inside neither.
- [ ] `GET /public/bookings/by-session/:id` returns the booking's public projection
  and `404`s an unknown session id.
- [ ] The rate limits from §6.1 apply, including the per-email limit.

**Steps.**
- [ ] Write `createBookingRequestSchema` with `successUrl`/`cancelUrl` refined
  against `PUBLIC_WEB_ORIGIN`, `customerNote` capped at 500 characters, and
  `employeeId` nullable.
- [ ] Implement the controller with `@Public()`, `@Idempotent('booking.create')`,
  and the two throttles.
- [ ] Call `ReservationService.reserve`, then — **outside** the transaction —
  `BookingCheckoutService.createSessionForReservation`, then a second short
  transaction attaching `stripeCheckoutSessionId`, inserting the `PENDING`
  `Payment`, and recording the `SWEEP_EXPIRED_RESERVATIONS` timer via an outbox
  row `booking.expiry_scheduled`.
- [ ] On a provider failure, map to `AppError('INTERNAL_ERROR', { status: 502 })`,
  let the interceptor `abandon` the key, and log at `error` with the booking id so
  the orphan reservation is traceable.
- [ ] Implement `GET /public/bookings/by-session/:checkoutSessionId` as a
  hand-written projection with no customer fields beyond the first name.

**Commands.**
```bash
pnpm api test:integration -- test/integration/public-bookings.int.spec.ts
```

**Expected successful result.** Every case green; the transaction-count assertion
proves no network call is inside a transaction.

**Commit.** `feat(public): add booking endpoint with checkout session and idempotent replay`

---

### Task 5.4 — Stripe webhook ingress and confirmation

**Objective.** Accept Stripe events safely, confirm bookings idempotently, and make
a duplicate or out-of-order delivery a no-op.

**Files.**
- `booking-app/apps/api/src/webhooks/stripe-webhook.controller.ts` (new)
- `booking-app/apps/api/src/webhooks/raw-body.middleware.ts` (new)
- `booking-app/apps/api/src/webhooks/webhooks.module.ts` (new)
- `booking-app/apps/api/src/booking/booking-confirmation.service.ts` (new)
- `booking-app/apps/api/src/booking/processors/stripe-event.processor.ts` (new)
- `booking-app/apps/api/test/integration/stripe-webhook.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class BookingConfirmationService {
  /** Idempotent: safe from the webhook path and from the expiry saga. */
  confirmPaid(input: { bookingId: string; sessionId: string; paymentIntentId?: string; chargeId?: string;
                       amountTotalCents: number; paymentMethodType?: string; paidAt: Date;
                       cause: { kind: 'WEBHOOK' | 'EXPIRY_SAGA'; reference: string } }): Promise<'CONFIRMED' | 'ALREADY_CONFIRMED'>;
  markPaymentFailed(input: { bookingId: string; failureCode?: string; failureMessage?: string; cause: … }): Promise<void>;
}
```

**Database changes.** None.
**API changes.** `POST /webhooks/stripe`. **Frontend changes.** None.

**Tests first.**

```ts
// stripe-webhook.int.spec.ts (excerpt)
describe('POST /api/webhooks/stripe', () => {
  it('rejects a bad signature with 400 and stores nothing', async () => {
    await request(app).post('/api/webhooks/stripe')
      .set('stripe-signature', 'nope').send(rawEvent('checkout.session.completed')).expect(400);
    expect(await prisma.stripeWebhookEvent.count()).toBe(0);
  });

  it('stores the event and returns 200 before processing', async () => {
    const raw = rawEvent('checkout.session.completed', { id: session.id, payment_status: 'paid' });
    await request(app).post('/api/webhooks/stripe').set('stripe-signature', sign(raw)).send(raw).expect(200);
    expect(await prisma.stripeWebhookEvent.count({ where: { processedAt: null } })).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith('stripe.event', expect.anything(), expect.objectContaining({ jobId: 'stripe:evt_1' }));
  });

  it('returns 200 and does nothing for a duplicate delivery', async () => {
    const raw = rawEvent('checkout.session.completed', { id: session.id, payment_status: 'paid' });
    await request(app).post('/api/webhooks/stripe').set('stripe-signature', sign(raw)).send(raw).expect(200);
    enqueueSpy.mockClear();
    await request(app).post('/api/webhooks/stripe').set('stripe-signature', sign(raw)).send(raw).expect(200);
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(await prisma.stripeWebhookEvent.count()).toBe(1);
  });

  it('confirms the booking, records the payment, issues a management token and queues notifications', async () => {
    await processor.handle({ stripeEventId: 'evt_1' });
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.expiresAt).toBeNull();
    expect(booking.confirmedAt).not.toBeNull();
    expect(await prisma.payment.findFirstOrThrow({ where: { bookingId } })).toMatchObject({ status: 'SUCCEEDED', amountCents: 4500 });
    expect(await prisma.managementToken.count({ where: { bookingId } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: bookingId, eventType: 'booking.confirmed' } })).toBe(1);
  });

  it('is idempotent: processing twice confirms once and queues one notification set', async () => {
    await processor.handle({ stripeEventId: 'evt_1' });
    await processor.handle({ stripeEventId: 'evt_1' });
    expect(await prisma.payment.count({ where: { bookingId } })).toBe(1);
    expect(await prisma.managementToken.count({ where: { bookingId } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: bookingId, eventType: 'booking.confirmed' } })).toBe(1);
    expect(await prisma.bookingStatusHistory.count({ where: { bookingId, toStatus: 'CONFIRMED' } })).toBe(1);
  });

  it('confirms a booking that has already moved to EXPIRING', async () => {
    await prisma.booking.update({ where: { id: bookingId }, data: { status: 'EXPIRING' } });
    await processor.handle({ stripeEventId: 'evt_1' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('CONFIRMED');
  });

  it('does not confirm when payment_status is unpaid', async () => {
    await seedEvent('checkout.session.completed', { id: session.id, payment_status: 'unpaid' });
    await processor.handle({ stripeEventId: 'evt_unpaid' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('PENDING_PAYMENT');
  });

  it('records a mismatch alert but still confirms when amount_total differs', async () => {
    await seedEvent('checkout.session.completed', { id: session.id, payment_status: 'paid', amount_total: 4400 });
    await processor.handle({ stripeEventId: 'evt_mismatch' });
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('CONFIRMED');
    expect(await prisma.auditLog.count({ where: { entityId: bookingId, action: 'BOOKING_CREATED_MANUALLY' } })).toBe(0);
    expect(logs.find((l) => l.includes('payment.amount_mismatch'))).toBeDefined();
  });

  it('marks PAYMENT_FAILED on checkout.session.expired for a still-pending booking', async () => {
    await seedEvent('checkout.session.expired', { id: session.id });
    await processor.handle({ stripeEventId: 'evt_expired' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('PAYMENT_FAILED');
  });

  it('stores and marks processed an event type it does not handle', async () => {
    await seedEvent('customer.created', {});
    await processor.handle({ stripeEventId: 'evt_unknown' });
    const row = await prisma.stripeWebhookEvent.findFirstOrThrow({ where: { stripeEventId: 'evt_unknown' } });
    expect(row.processedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
  });

  it('derives the organization from the persisted booking, not from event metadata', async () => {
    await seedEvent('checkout.session.completed', {
      id: session.id, payment_status: 'paid', metadata: { organizationId: 'attacker-org' },
    });
    await processor.handle({ stripeEventId: 'evt_meta' });
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(payment.organizationId).toBe(ctx.organization.id);
  });
});
```

**Validation scenarios.**
- [ ] A bad signature is `400` and stores nothing.
- [ ] A valid event stores an inbox row, enqueues with `jobId = stripe:<eventId>`,
  and returns `200` before processing.
- [ ] A duplicate delivery returns `200`, stores nothing, enqueues nothing.
- [ ] Confirmation sets `CONFIRMED`, retains `expiresAt`, sets `confirmedAt`, upserts
  the `Payment` to `SUCCEEDED`, issues one `ManagementToken`, writes one history row,
  and writes one `booking.confirmed` outbox row.
- [ ] Processing twice changes nothing the second time — every count stays at one.
- [ ] A booking already in `EXPIRING` still confirms (the saga race).
- [ ] `payment_status: 'unpaid'` does **not** confirm.
- [ ] An `amount_total` mismatch confirms anyway and logs
  `payment.amount_mismatch`, because the customer has paid.
- [ ] `checkout.session.expired` on a pending booking yields `PAYMENT_FAILED`.
- [ ] An unhandled event type is stored, marked processed, and never retried.
- [ ] The organization comes from the persisted booking, never from event metadata.

**Steps.**
- [ ] Register a raw-body parser for `/api/webhooks/*` only, keeping JSON parsing
  everywhere else, and cap the webhook body at 1 MB.
- [ ] Implement the controller: verify → `InboxRecorder.recordStripe` →
  `DUPLICATE` short-circuits to `200` → enqueue `stripe.event` with
  `jobId = stripe:<id>` → `200`. Wrap the enqueue in a `try` that logs but still
  returns `200`, because the reconciler will pick it up.
- [ ] Implement `BookingConfirmationService.confirmPaid` in one transaction: lock
  the booking `FOR UPDATE`; return `ALREADY_CONFIRMED` when the status is already
  `CONFIRMED` or terminal; assert the transition; update the booking; upsert the
  payment by `stripeCheckoutSessionId`; create the `ManagementToken` from a fresh
  256-bit secret whose hash only is stored in `ManagementToken`; encrypt the
  plaintext token into `OutboxEvent.encryptedSensitivePayload` with AES-256-GCM;
  keep the ordinary JSON payload token-free; write history; write the
  `booking.confirmed` outbox row.
- [ ] Implement the processor: read the inbox row, `parseJobPayload`, resolve the
  booking by `stripeCheckoutSessionId` and fall back to `client_reference_id`,
  branch by event type, then `markProcessed`; on a thrown error call `markFailed`
  and rethrow so BullMQ retries.
- [ ] Handle `async_payment_succeeded` through the same `confirmPaid`, and
  `async_payment_failed` / `payment_intent.payment_failed` through
  `markPaymentFailed`.
- [ ] In the notification worker, decrypt the sensitive outbox envelope only in
  memory immediately before rendering the confirmation link, zero/drop the
  plaintext reference after the provider call, and redact it from all errors and
  logs. Never persist the raw token in JSON, a job payload, or a notification row.

**Commands.**
```bash
pnpm api test:integration -- test/integration/stripe-webhook.int.spec.ts
```

**Expected successful result.** Every webhook case green, with the
double-processing test proving idempotency across all five side effects.

**Commit.** `feat(payments): add stripe webhook ingress and idempotent booking confirmation`

---

### Task 5.5 — Two-phase expiry saga

**Objective.** Release an unpaid slot only after Stripe confirms the session is
dead, and confirm the booking instead if the customer paid in the meantime.

**Files.**
- `booking-app/apps/api/src/booking/expiry.service.ts` (new)
- `booking-app/apps/api/src/booking/processors/expiry.processor.ts` (new)
- `booking-app/apps/api/src/booking/expiry.sweeper.ts` (new)
- `booking-app/apps/api/test/integration/expiry-saga.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class ExpiryService {
  /** Phase 1: PENDING_PAYMENT → EXPIRING, guarded by expiresAt < now(). */
  beginExpiry(bookingId: string): Promise<'BEGAN' | 'NOT_DUE' | 'NOT_APPLICABLE'>;
  /** Phase 2: talk to Stripe, then EXPIRING → EXPIRED or → CONFIRMED. */
  completeExpiry(bookingId: string): Promise<'EXPIRED' | 'CONFIRMED' | 'RETRY'>;
}
```

**Database changes.** None.
**API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// expiry-saga.int.spec.ts (excerpt)
describe('expiry saga', () => {
  it('phase 1 moves to EXPIRING and keeps the slot blocked', async () => {
    const booking = await overdueReservation();
    expect(await expiry.beginExpiry(booking.id)).toBe('BEGAN');
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('EXPIRING');
    expect(BLOCKING_BOOKING_STATUSES).toContain(after.status);
    await expect(reservation.reserve(sameSlotInput(booking))).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: booking.id, eventType: 'booking.expiry_requested' } })).toBe(1);
  });

  it('refuses phase 1 while the reservation is not yet due', async () => {
    const booking = await freshReservation();
    expect(await expiry.beginExpiry(booking.id)).toBe('NOT_DUE');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('phase 2 releases the slot only after Stripe reports the session expired', async () => {
    const booking = await overdueReservation();
    await expiry.beginExpiry(booking.id);
    expect(await expiry.completeExpiry(booking.id)).toBe('EXPIRED');
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('EXPIRED');
    expect(after.expiresAt).toBeNull();
    await expect(reservation.reserve(sameSlotInput(booking))).resolves.toBeDefined();
  });

  it('phase 2 confirms instead when the customer paid inside the window', async () => {
    const booking = await overdueReservation();
    fakePayment.markPaid(booking.stripeCheckoutSessionId!);
    await expiry.beginExpiry(booking.id);
    expect(await expiry.completeExpiry(booking.id)).toBe('CONFIRMED');
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('CONFIRMED');
    expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(0);
    expect(await prisma.managementToken.count({ where: { bookingId: booking.id } })).toBe(1);
  });

  it('keeps the slot blocked and returns RETRY when Stripe is unreachable', async () => {
    const booking = await overdueReservation();
    await expiry.beginExpiry(booking.id);
    fakePayment.failNextWith(new Error('ETIMEDOUT'));
    await expect(expiry.completeExpiry(booking.id)).rejects.toThrow('ETIMEDOUT');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('EXPIRING');
    await expect(reservation.reserve(sameSlotInput(booking))).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('goes straight to EXPIRED when no session id was ever attached', async () => {
    const booking = await overdueReservation({ stripeCheckoutSessionId: null });
    await expiry.beginExpiry(booking.id);
    expect(await expiry.completeExpiry(booking.id)).toBe('EXPIRED');
  });

  it('is idempotent under a repeated job for both phases', async () => {
    const booking = await overdueReservation();
    await expiry.beginExpiry(booking.id);
    expect(await expiry.beginExpiry(booking.id)).toBe('NOT_APPLICABLE');
    await expiry.completeExpiry(booking.id);
    expect(await expiry.completeExpiry(booking.id)).toBe('EXPIRED');
    expect(await prisma.bookingStatusHistory.count({ where: { bookingId: booking.id, toStatus: 'EXPIRED' } })).toBe(1);
  });

  it('does not race the webhook: whichever confirms second is a no-op', async () => {
    const booking = await overdueReservation();
    fakePayment.markPaid(booking.stripeCheckoutSessionId!);
    await expiry.beginExpiry(booking.id);
    await Promise.all([expiry.completeExpiry(booking.id), confirmation.confirmPaid(webhookInput(booking))]);
    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(await prisma.managementToken.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(await prisma.bookingStatusHistory.count({ where: { bookingId: booking.id, toStatus: 'CONFIRMED' } })).toBe(1);
  });

  it('never opens a transaction around the Stripe call', async () => {
    const booking = await overdueReservation();
    await expiry.beginExpiry(booking.id);
    const statements = captureSql(prisma);
    await expiry.completeExpiry(booking.id);
    const beginIndex = statements.indexOf('BEGIN');
    expect(fakePayment.callOrder()[0]).toBe('expireCheckoutSession');
    expect(beginIndex).toBeGreaterThan(-1);
  });

  it('sweeps overdue reservations and re-drives stuck EXPIRING bookings', async () => {
    await overdueReservation();
    expect(await sweeper.sweepOverdue()).toBe(1);
    const stuck = await overdueReservation();
    await prisma.booking.update({ where: { id: stuck.id }, data: { status: 'EXPIRING', updatedAt: new Date(Date.now() - 3 * 60_000) } });
    expect(await sweeper.sweepStuckExpiring()).toBe(1);
  });
});
```

**Validation scenarios.**
- [ ] Phase 1 moves `PENDING_PAYMENT → EXPIRING`, writes the outbox row, and the
  slot **stays** blocked — proven by a competing reservation still failing.
- [ ] Phase 1 refuses a reservation that is not yet due.
- [ ] Phase 2 releases the slot only after Stripe reports `expired`.
- [ ] Phase 2 confirms instead when Stripe reports the session complete and paid,
  with no refund and exactly one management token.
- [ ] Stripe unreachable → the job throws, the booking stays `EXPIRING`, and the
  slot stays blocked.
- [ ] A reservation with no session id goes straight to `EXPIRED`.
- [ ] Both phases are idempotent; one history row per terminal transition.
- [ ] The expiry saga and the webhook confirming concurrently produce exactly one
  payment, one token, and one history row.
- [ ] No Stripe call happens inside a transaction.
- [ ] The sweeper finds overdue `PENDING_PAYMENT` rows and re-drives `EXPIRING` rows
  older than 2 minutes.
- [ ] The per-booking delayed job is scheduled with
  `jobId = expiry:<bookingId>:<expiresAtEpochSeconds>` and a delay landing on
  `expiresAt`.

**Steps.**
- [ ] Implement `beginExpiry` in one transaction: `SELECT … FOR UPDATE`; return
  `NOT_APPLICABLE` unless `PENDING_PAYMENT`; return `NOT_DUE` unless
  `expiresAt < now()`; update to `EXPIRING`; history; outbox
  `booking.expiry_requested`.
- [ ] Implement `completeExpiry`: read the booking (no transaction); if not
  `EXPIRING` return the settled outcome; if no session id, transactionally
  `EXPIRING → EXPIRED`; otherwise call `expireCheckoutSession` **outside** any
  transaction and branch:
  - [ ] `EXPIRED` → transactional `EXPIRING → EXPIRED`, retaining `expiresAt`, history.
  - [ ] `ALREADY_COMPLETE` with `paymentStatus: 'paid'` → `retrieveCheckoutSession`
    for the payment intent and charge, then delegate to
    `BookingConfirmationService.confirmPaid` with
    `cause: { kind: 'EXPIRY_SAGA' }`.
  - [ ] `ALREADY_COMPLETE` with `unpaid` → transactional `EXPIRING → EXPIRED`, and
    log at `warn`, since an async method slipped through the card-only restriction.
  - [ ] Any thrown error → rethrow so BullMQ retries.
- [ ] Implement the processor for `booking.expiry_requested` calling
  `completeExpiry`.
- [ ] Schedule the per-booking delayed job when the reservation is created, with the
  deterministic job id and `delay = max(0, expiresAt − now)`.
- [ ] Implement `ExpirySweeper.sweepOverdue` (`SWEEP_EXPIRED_RESERVATIONS`, every 60
  seconds) selecting `PENDING_PAYMENT` with `expires_at < now()`
  `FOR UPDATE SKIP LOCKED LIMIT 200`, calling `beginExpiry` per row; and
  `sweepStuckExpiring` (`SWEEP_STUCK_EXPIRING`, every 60 seconds) selecting
  `EXPIRING` rows with `updated_at < now() - interval '2 minutes'` and re-enqueueing
  `booking.expiry_requested`.
- [ ] Wrap every transaction in `withSerializationRetry`.

**Commands.**
```bash
pnpm api test:integration -- test/integration/expiry-saga.int.spec.ts
```

**Expected successful result.** Every saga branch green, including the
slot-stays-blocked assertions and the concurrent-confirmation race.

**Commit.** `feat(booking): add two-phase expiry saga with stripe-confirmed slot release`
---

## Stage 6 — Booking lifecycle

### Task 6.1 — Management token authentication and the `/manage` surface

**Objective.** Give a customer access to exactly one booking with no account, and
make the token unable to leak through a log, a referrer, or a different booking.

**Files.**
- `booking-app/packages/contracts/src/manage/index.ts` (new)
- `booking-app/apps/api/src/manage/management-token.service.ts` (new)
- `booking-app/apps/api/src/manage/management-token.guard.ts` (new)
- `booking-app/apps/api/src/manage/manage.controller.ts` (new)
- `booking-app/apps/api/src/manage/manage.module.ts` (new)
- `booking-app/apps/api/test/integration/manage-auth.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class ManagementTokenService {
  issue(tx: Prisma.TransactionClient, bookingId: string, organizationId: string, endsAt: Date):
    Promise<{ token: string }>;                       // plaintext returned once, only the hash stored
  rotate(tx: Prisma.TransactionClient, oldBookingId: string, newBookingId: string, endsAt: Date): Promise<{ token: string }>;
  resolve(token: string): Promise<{ bookingId: string; organizationId: string }>;
}
export const MANAGED_BOOKING = 'MANAGED_BOOKING';    // request-scoped booking attached by the guard
```

**Database changes.** None.
**API changes.** `GET /manage/booking`, `GET /manage/availability`.
**Frontend changes.** None.

**Tests first.**

```ts
// manage-auth.int.spec.ts (excerpt)
describe('management token', () => {
  it('stores only a hash, never the token', async () => {
    const { token } = await issueFor(bookingId);
    const rows = await prisma.managementToken.findMany({ where: { bookingId } });
    expect(rows[0]!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('authenticates and returns only that booking', async () => {
    const { token } = await issueFor(bookingId);
    const res = await request(app).get('/api/manage/booking').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.reference).toBe(reference);
    const body = JSON.stringify(res.body);
    for (const forbidden of ['organizationId', 'customerId', 'employeeId', 'internalNote', 'stripe']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it.each([['missing', undefined], ['garbage', 'Bearer abc'], ['revoked', 'revoked'], ['expired', 'expired']])(
    'rejects a %s token with 401', async (_label, variant) => {
      const header = await headerFor(variant);
      await request(app).get('/api/manage/booking').set('Authorization', header ?? '')
        .expect(401).expect((r) => expect(r.body.code).toBe('UNAUTHENTICATED'));
    });

  it('cannot be aimed at another booking, because no route takes an id', async () => {
    const { token } = await issueFor(bookingId);
    await request(app).get(`/api/manage/booking/${otherBookingId}`).set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('rate-limits repeated failures', async () => {
    for (let i = 0; i < 30; i += 1) {
      await request(app).get('/api/manage/booking').set('Authorization', 'Bearer wrong');
    }
    await request(app).get('/api/manage/booking').set('Authorization', 'Bearer wrong')
      .expect(429).expect((r) => expect(r.body.code).toBe('RATE_LIMITED'));
  });

  it('records lastUsedAt without changing the hash', async () => {
    const { token } = await issueFor(bookingId);
    await request(app).get('/api/manage/booking').set('Authorization', `Bearer ${token}`).expect(200);
    expect((await prisma.managementToken.findFirstOrThrow({ where: { bookingId } })).lastUsedAt).not.toBeNull();
  });

  it('exposes the cancellation policy so the UI can show the consequence before acting', async () => {
    const { token } = await issueFor(bookingId);
    const res = await request(app).get('/api/manage/booking').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.cancellationPolicy).toMatchObject({ feePolicy: 'NONE' });
    expect(res.body.cancellationPolicy.freeUntil).toBeTypeOf('string');
  });
});
```

**Validation scenarios.**
- [ ] Only a SHA-256 hash is stored; the plaintext appears nowhere in the database.
- [ ] A valid token returns that booking's projection and no internal ids.
- [ ] Missing, malformed, revoked, and expired tokens are all `401 UNAUTHENTICATED`
  with the same message.
- [ ] No `/manage` route accepts a booking id, so a valid token cannot be redirected.
- [ ] Repeated failures are rate-limited to `429`.
- [ ] `lastUsedAt` is updated on success.
- [ ] The response exposes `cancellationPolicy` with `freeUntil` and the suggested
  retained amount, so the UI can state the consequence before the customer acts.
- [ ] Comparison uses `timingSafeEqual`, asserted by a unit test on the comparator.
- [ ] `issue` inside a transaction rolls back with it.

**Steps.**
- [ ] Implement `issue` generating `randomBytes(32).toString('base64url')`, storing
  `sha256`, `expiresAt = endsAt + 14 days`, and returning the plaintext exactly once.
- [ ] Implement `resolve` looking up by hash, comparing with `timingSafeEqual`,
  rejecting revoked and expired rows, and updating `lastUsedAt` in a fire-and-forget
  update that cannot fail the request.
- [ ] Implement the guard attaching `{ bookingId, organizationId }` to the request
  under `MANAGED_BOOKING`, and throwing `UNAUTHENTICATED` for every failure mode
  with one shared message.
- [ ] Implement `GET /manage/booking` as a hand-written projection including
  `displayStatus` derived from open requests, paid and refunded totals, and the
  cancellation policy computed with `computeSuggestedRetainedAmount`.
- [ ] Implement `GET /manage/availability` delegating to the snapshot service with
  the booking's own service and a caller-supplied date range.
- [ ] Add the `@Throttle` limit from §6.1 keyed by IP.

**Commands.**
```bash
pnpm api test:integration -- test/integration/manage-auth.int.spec.ts
```

**Expected successful result.** Every token case green, including the
no-internal-ids assertion over the serialised response.

**Commit.** `feat(manage): add management-token auth and customer booking view`

---

### Task 6.2 — Customer cancellation and the fee window

**Objective.** Let a customer cancel freely outside the window, and open an audited
request inside it — with the slot still blocked while the office decides.

**Files.**
- `booking-app/apps/api/src/booking/cancellation.service.ts` (new)
- `booking-app/apps/api/src/manage/manage-cancel.controller.ts` (new)
- `booking-app/apps/api/test/integration/cancellation.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class CancellationService {
  cancelByCustomer(bookingId: string, reason?: string):
    Promise<{ outcome: 'CANCELED'; refundId: string | null } | { outcome: 'REQUESTED'; requestId: string; suggestedRetained: Money }>;
  cancelByBusiness(input: { bookingId: string; officeUserId: string; reason: string; refundAmountCents?: number }):
    Promise<{ refundId: string | null }>;
  decideRequest(input: { requestId: string; officeUserId: string; decision: 'APPROVED' | 'REJECTED';
                         retainedAmountCents?: number; note?: string }): Promise<void>;
}
```

**Database changes.** None.
**API changes.** `POST /manage/cancel`. **Frontend changes.** None.

**Tests first.**

```ts
// cancellation.int.spec.ts (excerpt)
describe('cancelByCustomer', () => {
  it('cancels immediately outside the free window and refunds in full', async () => {
    const booking = await confirmedPaidBooking({ startsAt: daysFromNow(5) });
    const result = await service.cancelByCustomer(booking.id, 'Termin passt nicht');
    expect(result).toMatchObject({ outcome: 'CANCELED' });
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('CANCELED_BY_CUSTOMER');
    expect(after.canceledAt).not.toBeNull();
    const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(refund).toMatchObject({ status: 'PENDING', amountCents: 4500, reason: 'CUSTOMER_CANCELLATION', issuedByOfficeUserId: null });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: booking.id, eventType: 'booking.canceled' } })).toBe(1);
  });

  it('releases the slot on immediate cancellation', async () => {
    const booking = await confirmedPaidBooking({ startsAt: daysFromNow(5) });
    await service.cancelByCustomer(booking.id);
    await expect(reservation.reserve(sameSlotInput(booking))).resolves.toBeDefined();
  });

  it('opens a request inside the window and keeps the slot blocked', async () => {
    await setSettings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 });
    const booking = await confirmedPaidBooking({ startsAt: hoursFromNow(48) });
    const result = await service.cancelByCustomer(booking.id, 'krank');
    expect(result.outcome).toBe('REQUESTED');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
    await expect(reservation.reserve(sameSlotInput(booking))).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    const req = await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(req).toMatchObject({ decision: 'PENDING', suggestedRetainedAmountCents: 2250 });
  });

  it('freezes the suggestion against a later policy change', async () => {
    await setSettings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 });
    const booking = await confirmedPaidBooking({ startsAt: hoursFromNow(48) });
    await service.cancelByCustomer(booking.id);
    await setSettings({ cancellationFeePercent: 100 });
    expect((await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId: booking.id } })).suggestedRetainedAmountCents).toBe(2250);
  });

  it('refuses a second open request', async () => {
    const booking = await confirmedPaidBooking({ startsAt: hoursFromNow(48) });
    await service.cancelByCustomer(booking.id);
    await expect(service.cancelByCustomer(booking.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_CANCELLABLE' });
  });

  it.each(['EXPIRED', 'CANCELED_BY_CUSTOMER', 'COMPLETED', 'NO_SHOW'] as const)(
    'refuses to cancel a %s booking', async (status) => {
      const booking = await bookingWithStatus(status);
      await expect(service.cancelByCustomer(booking.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_CANCELLABLE' });
    });

  it('refuses to cancel an appointment that has already started', async () => {
    const booking = await confirmedPaidBooking({ startsAt: hoursFromNow(-1) });
    await expect(service.cancelByCustomer(booking.id)).rejects.toMatchObject({ code: 'BOOKING_NOT_CANCELLABLE' });
  });

  it('cancels an unpaid manual booking with no refund', async () => {
    const booking = await confirmedUnpaidBooking({ startsAt: daysFromNow(5) });
    expect(await service.cancelByCustomer(booking.id)).toMatchObject({ outcome: 'CANCELED', refundId: null });
  });
});

describe('decideRequest', () => {
  it('approving cancels, refunds paid minus retained, and audits the decision', async () => {
    const { booking, requestId } = await openRequest({ paidCents: 4500, suggested: 2250 });
    await service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED', retainedAmountCents: 1000, note: 'Kulanz' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CANCELED_BY_CUSTOMER');
    const req = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(req).toMatchObject({ decision: 'APPROVED', retainedAmountCents: 1000, suggestedRetainedAmountCents: 2250, decidedByOfficeUserId: ctx.owner.id });
    expect((await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } })).amountCents).toBe(3500);
    expect(await prisma.auditLog.count({ where: { action: 'CANCELLATION_REQUEST_DECIDED', entityId: requestId } })).toBe(1);
  });

  it('rejecting leaves the booking confirmed and closes the request', async () => {
    const { booking, requestId } = await openRequest({});
    await service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'REJECTED', note: 'zu kurzfristig' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
    expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } })).decision).toBe('REJECTED');
  });

  it('refuses a retained amount above what was paid, and a second decision', async () => {
    const { requestId } = await openRequest({ paidCents: 4500 });
    await expect(service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED', retainedAmountCents: 5000 }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'REJECTED' });
    await expect(service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' }))
      .rejects.toMatchObject({ code: 'REQUEST_ALREADY_DECIDED' });
  });
});
```

**Validation scenarios.**
- [ ] Outside the window: immediate `CANCELED_BY_CUSTOMER`, full `PENDING` refund
  with `issuedByOfficeUserId: null`, one `booking.canceled` outbox row, slot
  released.
- [ ] Inside the window: a `PENDING` request, booking stays `CONFIRMED`, slot stays
  blocked.
- [ ] The suggested retained amount is frozen at request time.
- [ ] A second open request is refused.
- [ ] Every terminal status refuses cancellation; a started appointment refuses too.
- [ ] An unpaid booking cancels with no refund.
- [ ] Approving cancels, refunds `paid − retained`, stores both amounts, and writes
  one audit row.
- [ ] Rejecting leaves the booking confirmed and closes the request.
- [ ] A retained amount above the paid amount is rejected; a second decision is
  `REQUEST_ALREADY_DECIDED`.
- [ ] Approving with a partial retention requires the refund capability (asserted in
  Task 8.2's guard test).

**Steps.**
- [ ] Implement `cancelByCustomer`: load the booking with its payments; assert the
  status is `CONFIRMED` and `startsAt > now()`; compute the window with
  `computeSuggestedRetainedAmount`; branch.
- [ ] Immediate branch, one transaction: lock the booking; `assertTransition`;
  update to `CANCELED_BY_CUSTOMER` with `canceledAt`; history; create a `PENDING`
  `Refund` when a `SUCCEEDED` payment exists, with a fresh `idempotencyKey`; outbox
  `booking.canceled` and `refund.requested`.
- [ ] Request branch, one transaction: create the `CancellationRequest` with the
  frozen suggestion, catching the partial-unique violation as
  `BOOKING_NOT_CANCELLABLE`; outbox
  `notification` events for customer and office.
- [ ] Implement `decideRequest` in one transaction: lock the request row; assert
  `PENDING`; validate `retainedAmountCents` in `[0, paid]`; on approve, cancel the
  booking and create the refund for the difference; write the decision fields, the
  audit row, and the outbox notification.
- [ ] Implement `POST /manage/cancel` returning `200` for the immediate outcome and
  `202` for the request outcome, per §6.3.

**Commands.**
```bash
pnpm api test:integration -- test/integration/cancellation.int.spec.ts
```

**Expected successful result.** Every branch green, including the frozen-suggestion
test and the slot-stays-blocked assertion for an open request.

**Commit.** `feat(booking): add customer cancellation with fee window and audited decisions`

---

### Task 6.3 — Refund service

**Objective.** Move money out exactly once, even under a retry, a duplicate
webhook, or an out-of-order event.

**Files.**
- `booking-app/apps/api/src/payment/refund.service.ts` (new)
- `booking-app/apps/api/src/payment/processors/refund.processor.ts` (new)
- `booking-app/apps/api/src/payment/refund-webhook.handler.ts` (new)
- `booking-app/apps/api/test/integration/refund.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class RefundService {
  request(input: { bookingId: string; amountCents: number; reason: RefundReason;
                   officeUserId?: string; idempotencyKey?: string }): Promise<{ refundId: string }>;
  execute(refundId: string): Promise<'SUCCEEDED' | 'FAILED'>;
  applyProviderUpdate(input: { stripeRefundId: string; idempotencyKey?: string;
                               status: 'succeeded' | 'failed' | 'canceled'; amountCents: number }): Promise<void>;
}
```

**Database changes.** None.
**API changes.** None yet — the office route arrives in Task 8.5.
**Frontend changes.** None.

**Tests first.**

```ts
// refund.int.spec.ts (excerpt)
describe('RefundService', () => {
  it('creates the row PENDING before any provider call', async () => {
    const { refundId } = await service.request({ bookingId, amountCents: 2000, reason: 'GOODWILL', officeUserId: ctx.owner.id });
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).toMatchObject({ status: 'PENDING', amountCents: 2000 });
    expect(fakePayment.refundCalls()).toHaveLength(0);
  });

  it('passes the stored idempotency key to the provider', async () => {
    const { refundId } = await service.request({ bookingId, amountCents: 2000, reason: 'GOODWILL' });
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    await service.execute(refundId);
    expect(fakePayment.refundCalls()[0]!.idempotencyKey).toBe(row.idempotencyKey);
  });

  it('is safe under a repeated job: one provider call, one settled row', async () => {
    const { refundId } = await service.request({ bookingId, amountCents: 2000, reason: 'GOODWILL' });
    await Promise.all([service.execute(refundId), service.execute(refundId)]);
    expect(fakePayment.refundCalls().filter((c) => c.idempotencyKey)).toHaveLength(1);
    expect(await prisma.refund.count({ where: { bookingId } })).toBe(1);
  });

  it('updates the payment totals and status on settlement', async () => {
    const { refundId } = await service.request({ bookingId, amountCents: 2000, reason: 'GOODWILL' });
    await service.execute(refundId);
    expect(await prisma.payment.findFirstOrThrow({ where: { bookingId } }))
      .toMatchObject({ refundedAmountCents: 2000, status: 'PARTIALLY_REFUNDED' });
    const rest = await service.request({ bookingId, amountCents: 2500, reason: 'GOODWILL' });
    await service.execute(rest.refundId);
    expect(await prisma.payment.findFirstOrThrow({ where: { bookingId } }))
      .toMatchObject({ refundedAmountCents: 4500, status: 'REFUNDED' });
  });

  it('refuses more than the remaining refundable amount', async () => {
    await service.execute((await service.request({ bookingId, amountCents: 4000, reason: 'GOODWILL' })).refundId);
    await expect(service.request({ bookingId, amountCents: 1000, reason: 'GOODWILL' }))
      .rejects.toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' });
  });

  it('refuses a refund when no payment settled', async () => {
    await expect(service.request({ bookingId: unpaidBookingId, amountCents: 100, reason: 'GOODWILL' }))
      .rejects.toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' });
  });

  it('records FAILED and keeps the row when the provider rejects', async () => {
    const { refundId } = await service.request({ bookingId, amountCents: 2000, reason: 'GOODWILL' });
    fakePayment.failNextWith(Object.assign(new Error('charge_already_refunded'), { type: 'StripeInvalidRequestError' }));
    expect(await service.execute(refundId)).toBe('FAILED');
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(row).toMatchObject({ status: 'FAILED' });
    expect(row.failureReason).toContain('charge_already_refunded');
  });

  it('handles charge.refunded arriving before the api response', async () => {
    const { refundId } = await service.request({ bookingId, amountCents: 2000, reason: 'GOODWILL' });
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    await service.applyProviderUpdate({ stripeRefundId: 're_early', idempotencyKey: row.idempotencyKey, status: 'succeeded', amountCents: 2000 });
    await service.execute(refundId);
    expect(await prisma.refund.count({ where: { bookingId } })).toBe(1);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe('SUCCEEDED');
  });

  it('never downgrades a settled refund on a late refund.updated', async () => {
    const { refundId } = await service.request({ bookingId, amountCents: 2000, reason: 'GOODWILL' });
    await service.execute(refundId);
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    await service.applyProviderUpdate({ stripeRefundId: row.stripeRefundId!, status: 'failed', amountCents: 2000 });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe('SUCCEEDED');
  });

  it('keeps refundedAmountCents equal to the sum of succeeded refunds', async () => {
    for (const amount of [1000, 1500]) {
      await service.execute((await service.request({ bookingId, amountCents: amount, reason: 'GOODWILL' })).refundId);
    }
    const failed = await service.request({ bookingId, amountCents: 500, reason: 'GOODWILL' });
    fakePayment.failNextWith(new Error('nope'));
    await service.execute(failed.refundId);
    const sum = await prisma.refund.aggregate({ where: { bookingId, status: 'SUCCEEDED' }, _sum: { amountCents: true } });
    expect((await prisma.payment.findFirstOrThrow({ where: { bookingId } })).refundedAmountCents).toBe(sum._sum.amountCents);
  });
});
```

**Validation scenarios.**
- [ ] The row is `PENDING` before any provider call.
- [ ] The stored `idempotencyKey` is the one given to the provider.
- [ ] Two concurrent executions cause one provider call and one settled row.
- [ ] Settlement updates `refundedAmountCents` and moves the payment to
  `PARTIALLY_REFUNDED` then `REFUNDED`.
- [ ] Over-refunding is `409 PAYMENT_NOT_REFUNDABLE`; so is refunding an unpaid
  booking.
- [ ] A provider rejection records `FAILED` with the reason and keeps the row.
- [ ] `charge.refunded` arriving before the API response does not create a second
  row.
- [ ] A late `refund.updated` cannot downgrade a settled refund.
- [ ] `Payment.refundedAmountCents` always equals the sum of `SUCCEEDED` refunds,
  with failed refunds excluded.

**Steps.**
- [ ] Implement `request` in one transaction: load the payment with
  `FOR UPDATE`; assert `SUCCEEDED` or `PARTIALLY_REFUNDED`; assert
  `amountCents <= amountCents − refundedAmountCents`; insert the `Refund` `PENDING`
  with `idempotencyKey = randomUUID()`; outbox `refund.requested`.
- [ ] Implement `execute`: read the row; return early unless `PENDING`; call
  `createRefund` **outside** any transaction with the row's key; then transactionally
  apply the outcome via one shared `applySettlement` used by both this path and the
  webhook path, so there is exactly one place that writes refund settlement.
- [ ] Classify provider errors: a permanent rejection sets `FAILED`; a retryable one
  rethrows so BullMQ retries with the same key.
- [ ] Implement `applyProviderUpdate` upserting by `stripeRefundId` and falling back
  to `idempotencyKey`, and refusing any transition `assertRefundTransition` does not
  permit, logging a `warn` instead.
- [ ] Recompute `refundedAmountCents` from the `SUCCEEDED` sum inside the same
  transaction rather than incrementing, so a retry cannot drift it.
- [ ] Wire `charge.refunded`, `refund.updated`, and `refund.failed` in the Stripe
  processor to `applyProviderUpdate`, and outbox `refund.succeeded` for the customer
  notification.

**Commands.**
```bash
pnpm api test:integration -- test/integration/refund.int.spec.ts
```

**Expected successful result.** Every refund case green, including the
out-of-order webhook and the sum invariant.

**Commit.** `feat(payments): add refund service with provider idempotency and settlement reconciliation`

---

### Task 6.4 — Reschedule request and approval

**Objective.** Move an appointment to a new slot without ever letting both the old
and the new slot be unbooked or double-booked in between.

**Files.**
- `booking-app/apps/api/src/booking/reschedule.service.ts` (new)
- `booking-app/apps/api/src/manage/manage-reschedule.controller.ts` (new)
- `booking-app/apps/api/test/integration/reschedule.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class RescheduleService {
  requestByCustomer(input: { bookingId: string; requestedStartsAt: Date; requestedEmployeeId?: string; reason?: string }):
    Promise<{ requestId: string }>;
  decide(input: { requestId: string; officeUserId: string; decision: 'APPROVED' | 'REJECTED'; note?: string }):
    Promise<{ newBookingId: string | null }>;
}
```

**Database changes.** None.
**API changes.** `POST /manage/reschedule-requests`. **Frontend changes.** None.

**Tests first.**

```ts
// reschedule.int.spec.ts (excerpt)
describe('reschedule', () => {
  it('creates a request without touching the booking or the slot', async () => {
    const { requestId } = await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('CONFIRMED');
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).decision).toBe('PENDING');
    await expect(reservation.reserve(sameSlotInput(original))).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('refuses a second open request and refuses a terminal booking', async () => {
    await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot });
    await expect(service.requestByCustomer({ bookingId, requestedStartsAt: newSlot }))
      .rejects.toMatchObject({ code: 'BOOKING_NOT_RESCHEDULABLE' });
  });

  it('approving creates a new CONFIRMED booking, cancels the old one and links the lineage', async () => {
    const { requestId } = await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot });
    const { newBookingId } = await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });
    const old = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const created = await prisma.booking.findUniqueOrThrow({ where: { id: newBookingId! } });
    expect(old).toMatchObject({ status: 'CANCELED_BY_BUSINESS', cancellationReason: 'RESCHEDULED' });
    expect(created).toMatchObject({ status: 'CONFIRMED', rescheduledFromBookingId: bookingId });
    expect(created.priceCentsSnapshot).toBe(old.priceCentsSnapshot);
    expect(created.startsAt.toISOString()).toBe(newSlot.toISOString());
  });

  it('rotates the management token so the old link stops working', async () => {
    const { token: oldToken } = await issueFor(bookingId);
    const { requestId } = await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot });
    await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });
    await request(app).get('/api/manage/booking').set('Authorization', `Bearer ${oldToken}`).expect(401);
    expect(await prisma.managementToken.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('releases the old slot and blocks the new one', async () => {
    const { requestId } = await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot });
    await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });
    await expect(reservation.reserve(sameSlotInput(original))).resolves.toBeDefined();
    await expect(reservation.reserve(atSlot(newSlot))).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('fails with SLOT_UNAVAILABLE when the requested slot was taken meanwhile, leaving everything unchanged', async () => {
    const { requestId } = await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot });
    await reservation.reserve(atSlot(newSlot));
    await expect(service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' }))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('CONFIRMED');
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).decision).toBe('PENDING');
  });

  it('takes both employee locks in ascending id order', async () => {
    const { requestId } = await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot, requestedEmployeeId: ctx.employee2.id });
    const statements = captureSql(prisma);
    await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });
    const locks = statements.filter((s) => s.includes('pg_advisory_xact_lock'));
    expect(locks).toHaveLength(2);
    expect(hashArgsOf(locks)).toEqual([...hashArgsOf(locks)].sort());
  });

  it('rejecting leaves the booking and the slot untouched', async () => {
    const { requestId } = await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot });
    expect(await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'REJECTED' })).toEqual({ newBookingId: null });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('CONFIRMED');
  });

  it('re-schedules reminders for the new time and queues a notification', async () => {
    const { requestId } = await service.requestByCustomer({ bookingId, requestedStartsAt: newSlot });
    const { newBookingId } = await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: newBookingId!, eventType: 'reminder.schedule' } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: newBookingId!, eventType: 'booking.rescheduled' } })).toBe(1);
  });
});
```

**Validation scenarios.**
- [ ] A request leaves the booking `CONFIRMED` and the original slot blocked.
- [ ] A second open request is refused; a terminal or started booking is refused.
- [ ] Approval creates a new `CONFIRMED` booking carrying the original price and
  duration snapshots, links `rescheduledFromBookingId`, and cancels the old one with
  reason `RESCHEDULED`.
- [ ] The management token is rotated; the old token is `401`.
- [ ] The old slot is released and the new one is blocked, in the same transaction.
- [ ] If the requested slot was taken meanwhile, approval fails
  `SLOT_UNAVAILABLE` and nothing changes — the request stays `PENDING`.
- [ ] Both employee locks are taken, in ascending id order.
- [ ] Rejection changes nothing.
- [ ] Reminders are re-scheduled for the new time and a `booking.rescheduled`
  notification is queued.
- [ ] The payment stays attached to the original booking and is reachable from the
  new one through the lineage link.

**Steps.**
- [ ] Implement `requestByCustomer`: assert `CONFIRMED` and `startsAt > now()`;
  validate the requested slot against the booking window; do an **optimistic**
  availability check for a fast rejection; insert the request, catching the partial
  unique violation as `BOOKING_NOT_RESCHEDULABLE`; outbox notifications for
  customer and office.
- [ ] Implement `decide` in one transaction: take `withCalendarLock` for the sorted
  set of `{ oldEmployeeId, newEmployeeId }`; lock the request `FOR UPDATE` and assert
  `PENDING`; on reject, write the decision and return.
- [ ] On approve, inside the same transaction: `loadForSlot` and assert
  `isSlotBookable`; insert the new booking with the **old snapshots** and the new
  times; transition the old booking to `CANCELED_BY_BUSINESS` with reason
  `RESCHEDULED`; write two history rows; revoke the old management token and issue a
  new one; write `resultingBookingId` on the request; outbox `booking.rescheduled`
  and `reminder.schedule`; write the audit row.
- [ ] Catch `isExclusionViolation` and map to `SLOT_UNAVAILABLE`, so the whole
  transaction rolls back and the request stays open for another attempt.

**Commands.**
```bash
pnpm api test:integration -- test/integration/reschedule.int.spec.ts
```

**Expected successful result.** Every reschedule case green, including the
lock-ordering assertion and the atomic slot swap.

**Commit.** `feat(booking): add reschedule request and dual-lock approval`

---

### Task 6.5 — Completion, no-show, and business cancellation

**Objective.** Close out an appointment's life with guards that match reality, and
let the business cancel with an optional refund.

**Files.**
- `booking-app/apps/api/src/booking/attendance.service.ts` (new)
- `booking-app/apps/api/src/booking/audit.service.ts` (new)
- `booking-app/apps/api/test/integration/attendance.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class AttendanceService {
  complete(bookingId: string, officeUserId: string): Promise<void>;
  markNoShow(bookingId: string, officeUserId: string): Promise<void>;
}
export class AuditService {
  record(tx: Prisma.TransactionClient, entry: { organizationId: string; officeUserId?: string; action: AuditAction;
          entityType: string; entityId: string; summary: string; before?: unknown; after?: unknown }): Promise<void>;
}
```

**Database changes.** None.
**API changes.** None yet — routes arrive in Task 8.5. **Frontend changes.** None.

**Tests first.**

```ts
// attendance.int.spec.ts (excerpt)
describe('completion and no-show', () => {
  it('completes a finished appointment and audits it', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(-2), durationMinutes: 30 });
    await service.complete(booking.id, ctx.owner.id);
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after).toMatchObject({ status: 'COMPLETED' });
    expect(after.completedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'BOOKING_MARKED_COMPLETED', entityId: booking.id } })).toBe(1);
  });

  it('refuses to complete an appointment that has not ended', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(2) });
    await expect(service.complete(booking.id, ctx.owner.id)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('marks a no-show once the appointment has started', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(-1) });
    await service.markNoShow(booking.id, ctx.owner.id);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('NO_SHOW');
  });

  it('refuses a no-show before the appointment starts', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(1) });
    await expect(service.markNoShow(booking.id, ctx.owner.id)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it.each(['COMPLETED', 'NO_SHOW', 'CANCELED_BY_CUSTOMER'] as const)('refuses to change a %s booking', async (status) => {
    const booking = await bookingWithStatus(status, { startsAt: hoursFromNow(-2) });
    await expect(service.complete(booking.id, ctx.owner.id)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('does not release the slot when marking NO_SHOW, because the time was consumed', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(-1) });
    await service.markNoShow(booking.id, ctx.owner.id);
    await expect(reservation.reserve(sameSlotInput(booking))).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });
});

describe('cancelByBusiness', () => {
  it('cancels with a reason, refunds the requested amount and audits it', async () => {
    const booking = await confirmedPaidBooking({ startsAt: daysFromNow(3) });
    await cancellation.cancelByBusiness({ bookingId: booking.id, officeUserId: ctx.owner.id, reason: 'Krankheit', refundAmountCents: 4500 });
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after).toMatchObject({ status: 'CANCELED_BY_BUSINESS', cancellationReason: 'Krankheit', canceledByOfficeUserId: ctx.owner.id });
    expect((await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } })).issuedByOfficeUserId).toBe(ctx.owner.id);
    expect(await prisma.auditLog.count({ where: { action: 'BOOKING_CANCELED', entityId: booking.id } })).toBe(1);
  });

  it('cancels without a refund when none is requested', async () => {
    const booking = await confirmedPaidBooking({ startsAt: daysFromNow(3) });
    await cancellation.cancelByBusiness({ bookingId: booking.id, officeUserId: ctx.owner.id, reason: 'Umbau' });
    expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it('cancels a past appointment, unlike the customer path', async () => {
    const booking = await confirmedPaidBooking({ startsAt: hoursFromNow(-1) });
    await expect(cancellation.cancelByBusiness({ bookingId: booking.id, officeUserId: ctx.owner.id, reason: 'Fehleintrag' }))
      .resolves.toBeDefined();
  });

  it('closes an open cancellation request when the business cancels first', async () => {
    const booking = await confirmedPaidBooking({ startsAt: hoursFromNow(48) });
    await cancellationService.cancelByCustomer(booking.id);
    await cancellation.cancelByBusiness({ bookingId: booking.id, officeUserId: ctx.owner.id, reason: 'Kulanz', refundAmountCents: 4500 });
    expect((await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId: booking.id } })).decision).toBe('APPROVED');
  });
});
```

**Validation scenarios.**
- [ ] `complete` requires `endsAt <= now()`; `markNoShow` requires
  `startsAt <= now()`.
- [ ] Both refuse every terminal status with `INVALID_STATUS_TRANSITION`.
- [ ] Both write an audit row naming the actor.
- [ ] `NO_SHOW` does not free the slot — the time was consumed and the past is not
  bookable anyway.
- [ ] Business cancellation records the reason and the actor, optionally refunds, and
  audits.
- [ ] Business cancellation works on a past appointment, unlike the customer path.
- [ ] An open cancellation request is closed as `APPROVED` when the business cancels
  first, so no request is orphaned.
- [ ] A refund from the business path requires the refund capability (asserted in
  Task 8.2).

**Steps.**
- [ ] Implement `AuditService.record` taking the transaction client, redacting
  `before`/`after` through the same path list as the logger, and stamping the
  correlation id and IP from the request context.
- [ ] Implement `complete` and `markNoShow` in one transaction each: lock the
  booking; `assertTransition`; check the time guard and throw
  `INVALID_STATUS_TRANSITION` with a `details.reason` naming which guard failed;
  update; history; audit.
- [ ] Extend `cancelByBusiness` to accept `refundAmountCents`, close any open
  `CancellationRequest` as `APPROVED` with `decisionNote: 'closed by business
  cancellation'`, and close any open `RescheduleRequest` as `REJECTED`.
- [ ] Add a nightly `MAINTENANCE` job that lists `CONFIRMED` bookings whose `endsAt`
  passed more than 48 hours ago and surfaces the count on the dashboard, so
  completion does not silently rot. It does **not** auto-complete them — attendance
  is a human observation.

**Commands.**
```bash
pnpm api test:integration -- test/integration/attendance.int.spec.ts
```

**Expected successful result.** Every guard and audit case green, including the
orphaned-request closure.

**Commit.** `feat(booking): add completion, no-show and business cancellation with audit trail`
---

## Stage 7 — Notifications, reminders, and the worker process

### Task 7.1 — Notification templates package

**Objective.** Locale-complete, type-safe, snapshot-tested templates where a
missing German translation is a compile error rather than an English email.

**Files.**
- `booking-app/packages/notification-templates/package.json` (new)
- `booking-app/packages/notification-templates/tsconfig.json` (new)
- `booking-app/packages/notification-templates/src/index.ts` (new)
- `booking-app/packages/notification-templates/src/data.ts` (new)
- `booking-app/packages/notification-templates/src/format.ts` (new)
- `booking-app/packages/notification-templates/src/layout.ts` (new)
- `booking-app/packages/notification-templates/src/de/*.ts` (new, one per kind)
- `booking-app/packages/notification-templates/src/en/*.ts` (new, one per kind)
- `booking-app/packages/notification-templates/src/templates.spec.ts` (new)
- `booking-app/packages/notification-templates/src/__snapshots__/` (generated)

**Produces for later tasks.**

```ts
export type TemplateData = {
  BOOKING_CONFIRMATION: { reference: string; serviceName: string; employeeName: string;
                          startsAt: Date; endsAt: Date; priceCents: number; currency: string;
                          manageUrl: string; businessName: string; businessPhone: string;
                          addressLine: string; freeCancellationUntil: Date | null };
  /* … one entry per NotificationKind … */
};
export function render<K extends NotificationKind>(
  kind: K, channel: NotificationChannel, locale: Locale, data: TemplateData[K],
): { subject?: string; text: string; html?: string };
export const SMS_MAX_LENGTH = 480;
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// templates.spec.ts
import { describe, expect, it } from 'vitest';
import { NotificationKind } from '@shape-and-flow/booking-contracts';
import { render, SMS_MAX_LENGTH } from './index.js';
import { sampleDataFor } from './data.js';

const KINDS = Object.values(NotificationKind);
const LOCALES = ['de', 'en'] as const;

describe('templates', () => {
  it.each(KINDS)('renders %s as email in both locales', (kind) => {
    for (const locale of LOCALES) {
      const out = render(kind, 'EMAIL', locale, sampleDataFor(kind));
      expect(out.subject, `${kind}/${locale} subject`).toBeTruthy();
      expect(out.text.length, `${kind}/${locale} text`).toBeGreaterThan(20);
      expect(out.html, `${kind}/${locale} html`).toContain('<');
      expect(out.text).not.toMatch(/undefined|null|\[object/);
      expect(out.subject).not.toMatch(/undefined|null/);
    }
  });

  it.each(['BOOKING_CONFIRMATION', 'REMINDER_24H', 'BOOKING_CANCELED_BY_BUSINESS'] as const)(
    'renders %s as sms within the segment budget', (kind) => {
      for (const locale of LOCALES) {
        const out = render(kind, 'SMS', locale, sampleDataFor(kind));
        expect(out.html).toBeUndefined();
        expect(out.text.length, `${kind}/${locale}`).toBeLessThanOrEqual(SMS_MAX_LENGTH);
      }
    });

  it('formats money and dates for the locale, not with string concatenation', () => {
    const de = render('BOOKING_CONFIRMATION', 'EMAIL', 'de', sampleDataFor('BOOKING_CONFIRMATION'));
    expect(de.text).toContain('45,00');
    expect(de.text).toMatch(/14\.08\.2026/);
    expect(de.text).toContain('09:00');
    const en = render('BOOKING_CONFIRMATION', 'EMAIL', 'en', sampleDataFor('BOOKING_CONFIRMATION'));
    expect(en.text).toContain('45.00');
  });

  it('includes the manage link in the confirmation and never leaks it into the subject', () => {
    const out = render('BOOKING_CONFIRMATION', 'EMAIL', 'de', sampleDataFor('BOOKING_CONFIRMATION'));
    expect(out.text).toContain('/manage#');
    expect(out.subject).not.toContain('/manage#');
  });

  it('escapes html in customer-supplied values', () => {
    const data = { ...sampleDataFor('BOOKING_CONFIRMATION'), employeeName: '<script>alert(1)</script>' };
    const out = render('BOOKING_CONFIRMATION', 'EMAIL', 'de', data);
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it.each(KINDS)('matches the stored snapshot for %s', (kind) => {
    for (const locale of LOCALES) {
      expect(render(kind, 'EMAIL', locale, sampleDataFor(kind))).toMatchSnapshot(`${kind}-${locale}`);
    }
  });
});
```

**Validation scenarios.**
- [ ] Every `NotificationKind` renders in both locales with a non-empty subject and
  body.
- [ ] No rendered output contains `undefined`, `null`, or `[object Object]`.
- [ ] SMS renders stay within 480 characters in both locales — German is the longer
  language, so this is the binding constraint.
- [ ] Money and dates are locale-formatted (`45,00 €` / `14.08.2026` / `09:00` in
  German).
- [ ] The manage link appears in the body and never in the subject (subjects leak
  into notification previews).
- [ ] HTML in any interpolated value is escaped.
- [ ] Snapshots exist for every kind and locale, so a copy change is a visible diff.
- [ ] Adding a `NotificationKind` without both locale files fails `typecheck`, proven
  by adding one temporarily.

**Steps.**
- [ ] Create the package depending only on `@shape-and-flow/booking-contracts`.
- [ ] Define `TemplateData` as a mapped type keyed by `NotificationKind`, and the
  registry as `Record<Locale, { [K in NotificationKind]: TemplateFn<K> }>` — the
  exhaustive mapped type is what turns a missing translation into a compile error.
- [ ] Implement `format.ts` with `formatMoneyCents`, `formatDate`, `formatTime`,
  `formatDateTime`, and `escapeHtml`, all locale- and `Europe/Berlin`-aware.
- [ ] Implement `layout.ts` wrapping body content in one inline-styled HTML shell
  using the beige/black/orange palette, table-based for email-client compatibility,
  with a plain-text sibling generated from the same data (not stripped from HTML).
- [ ] Write all 13 German templates, then all 13 English ones. German is authored
  first so the shorter English text is never the implicit reference for length.
- [ ] Implement `sampleDataFor` in `data.ts` with realistic fixtures for every kind,
  used by both the tests and Storybook-free manual review.
- [ ] Generate snapshots and review each one by eye once.

**Commands.**
```bash
pnpm --filter @shape-and-flow/booking-notification-templates test
pnpm --filter @shape-and-flow/booking-notification-templates typecheck
```

**Expected successful result.** 26 email renders and 6 SMS renders green,
snapshots committed, and deleting one German file breaks `typecheck` rather than
falling back to English.

**Commit.** `feat(notifications): add locale-complete templates with snapshots`

---

### Task 7.2 — Notification dispatch and delivery-status webhooks

**Objective.** Turn outbox events into exactly one message per recipient, and track
delivery all the way to the provider's verdict.

**Files.**
- `booking-app/apps/api/src/notification/notification.service.ts` (new)
- `booking-app/apps/api/src/notification/dedupe-key.ts` (new)
- `booking-app/apps/api/src/notification/processors/notification-send.processor.ts` (new)
- `booking-app/apps/api/src/notification/processors/booking-event.processor.ts` (new)
- `booking-app/apps/api/src/notification/notification.reconciler.ts` (new)
- `booking-app/apps/api/src/webhooks/messaging-webhook.controller.ts` (new)
- `booking-app/apps/api/test/integration/notifications.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class NotificationService {
  queue(tx: Prisma.TransactionClient, input: {
    organizationId: string; kind: NotificationKind; channel: NotificationChannel;
    locale: Locale; recipient: string; bookingId?: string; customerId?: string; officeUserId?: string;
    data: unknown; dedupeDiscriminator?: string; scheduledFor?: Date;
  }): Promise<{ notificationId: string | null }>;      // null when deduped
  send(notificationId: string): Promise<'SENT' | 'FAILED'>;
}
export function dedupeKey(kind: NotificationKind, channel: NotificationChannel, bookingId: string | null, discriminator?: string): string;
```

**Database changes.** None.
**API changes.** `POST /webhooks/resend`, `POST /webhooks/twilio`.
**Frontend changes.** None.

**Tests first.**

```ts
// notifications.int.spec.ts (excerpt)
describe('notification dispatch', () => {
  it('creates a PENDING row before sending', async () => {
    const { notificationId } = await queueConfirmation();
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notificationId! } }))
      .toMatchObject({ status: 'PENDING', channel: 'EMAIL', locale: 'de' });
    expect(fakeEmail.sent).toHaveLength(0);
  });

  it('sends, stores the provider id and moves to SENT', async () => {
    const { notificationId } = await queueConfirmation();
    expect(await service.send(notificationId!)).toBe('SENT');
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId! } });
    expect(row).toMatchObject({ status: 'SENT' });
    expect(row.providerMessageId).toBeTruthy();
    expect(row.sentAt).not.toBeNull();
    expect(fakeEmail.sent[0]).toMatchObject({ to: 'anna@example.com' });
    expect(fakeEmail.sent[0]!.subject).toMatch(/Buchung/);
  });

  it('dedupes a repeated queue for the same booking and kind', async () => {
    await queueConfirmation();
    expect((await queueConfirmation()).notificationId).toBeNull();
    expect(await prisma.notification.count({ where: { bookingId, kind: 'BOOKING_CONFIRMATION' } })).toBe(1);
  });

  it('sends one email and one office email from a single booking.confirmed event', async () => {
    await bookingEventProcessor.handle({ organizationId: ctx.organization.id, bookingId, manageToken: 'tok' });
    const kinds = (await prisma.notification.findMany({ where: { bookingId } })).map((n) => n.kind).sort();
    expect(kinds).toEqual(['BOOKING_CONFIRMATION', 'OFFICE_NEW_BOOKING']);
  });

  it('processing booking.confirmed twice still yields two notifications total', async () => {
    const payload = { organizationId: ctx.organization.id, bookingId, manageToken: 'tok' };
    await bookingEventProcessor.handle(payload);
    await bookingEventProcessor.handle(payload);
    expect(await prisma.notification.count({ where: { bookingId } })).toBe(2);
    expect(fakeEmail.sent).toHaveLength(2);
  });

  it('adds an SMS only when enabled and a phone number exists', async () => {
    await setSettings({ smsRemindersEnabled: false });
    await bookingEventProcessor.handle({ organizationId: ctx.organization.id, bookingId, manageToken: 'tok' });
    expect(await prisma.notification.count({ where: { bookingId, channel: 'SMS' } })).toBe(0);
    await prisma.notification.deleteMany({ where: { bookingId } });
    await setSettings({ smsRemindersEnabled: true });
    await bookingEventProcessor.handle({ organizationId: ctx.organization.id, bookingId, manageToken: 'tok' });
    expect(await prisma.notification.count({ where: { bookingId, channel: 'SMS' } })).toBe(1);
  });

  it('marks FAILED on a permanent provider error and retries a transient one', async () => {
    const permanent = await queueConfirmation();
    fakeEmail.failNextWith(Object.assign(new Error('invalid recipient'), { status: 422 }));
    expect(await service.send(permanent.notificationId!)).toBe('FAILED');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: permanent.notificationId! } })).failedAt).not.toBeNull();

    await prisma.notification.deleteMany({});
    const transient = await queueConfirmation();
    fakeEmail.failNextWith(Object.assign(new Error('gateway'), { status: 503 }));
    await expect(service.send(transient.notificationId!)).rejects.toThrow('gateway');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: transient.notificationId! } })).status).toBe('PENDING');
  });

  it('applies a Resend delivered webhook to the row', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId!);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId! } });
    await postResend('email.delivered', { email_id: row.providerMessageId });
    await messagingProcessor.drain();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notificationId! } })).status).toBe('DELIVERED');
  });

  it('applies a Twilio undelivered webhook as FAILED with the reason', async () => {
    const id = await sentSms();
    await postTwilio({ MessageSid: id, MessageStatus: 'undelivered', ErrorCode: '30003' });
    await messagingProcessor.drain();
    const row = await prisma.notification.findFirstOrThrow({ where: { providerMessageId: id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toContain('30003');
  });

  it('rejects an unsigned messaging webhook', async () => {
    await request(app).post('/api/webhooks/resend').send({ type: 'email.delivered' }).expect(400);
    await request(app).post('/api/webhooks/twilio').send({ MessageSid: 'x' }).expect(400);
  });

  it('reports notifications still PENDING after fifteen minutes', async () => {
    const { notificationId } = await queueConfirmation();
    await prisma.notification.update({ where: { id: notificationId! }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    expect(await reconciler.runOnce()).toBe(1);
  });
});
```

**Validation scenarios.**
- [ ] A `PENDING` row exists before any provider call.
- [ ] A successful send stores `providerMessageId` and `sentAt` and moves to `SENT`.
- [ ] A repeated queue for the same `dedupeKey` returns `null` and creates no second
  row.
- [ ] One `booking.confirmed` event produces exactly a customer email and an office
  email.
- [ ] Processing that event twice still produces two notifications and two sends —
  at-least-once delivery becomes effectively-once contact.
- [ ] SMS appears only when enabled and the customer has a phone number.
- [ ] A permanent provider error sets `FAILED`; a transient one rethrows and leaves
  the row `PENDING` for the retry.
- [ ] A Resend `email.delivered` webhook moves the row to `DELIVERED`.
- [ ] A Twilio `undelivered` webhook sets `FAILED` and records the error code.
- [ ] Unsigned messaging webhooks are `400`.
- [ ] Rows `PENDING` for over 15 minutes are reported by the reconciler.

**Steps.**
- [ ] Implement `dedupeKey` exactly as specified in §4.3, with the discriminator
  defaulting to `-`.
- [ ] Implement `queue` inserting the `Notification` row inside the caller's
  transaction, catching a `dedupeKey` unique violation and returning
  `{ notificationId: null }`, and writing an outbox `notification.send` row.
- [ ] Implement `send`: read the row; return early unless `PENDING`; render the
  template; call the provider; on success update `SENT` with the provider id; on a
  `PERMANENT` classification update `FAILED` with `failedAt` and `lastError`; on
  `RETRYABLE` increment `attempts`, store `lastError`, and rethrow.
- [ ] Implement `booking-event.processor.ts` fanning `booking.confirmed`,
  `booking.canceled`, `booking.payment_failed`, `booking.rescheduled`, and
  `refund.succeeded` into the right `queue` calls with the right recipients, in one
  transaction per event.
- [ ] Implement the two messaging webhook routes: verify the signature, record to the
  inbox, enqueue `messaging.event`, return `200`.
- [ ] Implement the messaging processor mapping provider statuses to
  `DELIVERED`/`FAILED` by `providerMessageId`, ignoring a status for an unknown id
  with a `warn` rather than throwing.
- [ ] Implement `NotificationReconciler` (`SWEEP_NOTIFICATIONS`, every 5 minutes)
  counting rows `PENDING` for over 15 minutes, re-enqueueing their send jobs, and
  exposing the count for `/api/health/detail`.
- [ ] Add the retention behaviour: redact `recipient` and `subject` at 90 days,
  delete at `dataRetentionDays`.

**Commands.**
```bash
pnpm api test:integration -- test/integration/notifications.int.spec.ts
```

**Expected successful result.** Every dispatch and delivery case green, including
both webhook providers and the dedupe assertion.

**Commit.** `feat(notifications): add dispatch, dedupe and delivery-status tracking`

---

### Task 7.3 — Reminders

**Objective.** Send a 24-hour reminder for every confirmed appointment and for none
that has moved, been cancelled, or already happened.

**Files.**
- `booking-app/apps/api/src/notification/reminder.service.ts` (new)
- `booking-app/apps/api/src/notification/processors/reminder.processor.ts` (new)
- `booking-app/apps/api/src/notification/reminder.reconciler.ts` (new)
- `booking-app/apps/api/test/integration/reminders.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export class ReminderService {
  schedule(bookingId: string): Promise<{ scheduled: number; skipped: number }>;
  cancelFor(bookingId: string): Promise<void>;         // best-effort removal
  fire(input: { bookingId: string; offsetMinutes: number; expectedStartsAtEpochSeconds: number }): Promise<'SENT' | 'SKIPPED'>;
}
export function reminderJobId(offsetMinutes: number, bookingId: string, startsAt: Date): string;
```

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// reminders.int.spec.ts (excerpt)
describe('reminders', () => {
  it('embeds the appointment time in the job id', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.schedule(booking.id);
    const jobs = await queues.notification.getDelayed();
    expect(jobs[0]!.id).toBe(`reminder:1440:${booking.id}:${Math.floor(booking.startsAt.getTime() / 1000)}`);
  });

  it('schedules a distinct job after a reschedule, which a booking-id-only key would have swallowed', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.schedule(booking.id);
    const moved = await prisma.booking.update({ where: { id: booking.id }, data: { startsAt: daysFromNow(4), endsAt: daysFromNow(4) } });
    await service.schedule(moved.id);
    const ids = (await queues.notification.getDelayed()).map((j) => j.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('skips a past-due offset instead of firing immediately', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(6) });
    expect(await service.schedule(booking.id)).toEqual({ scheduled: 0, skipped: 1 });
    expect(await queues.notification.getDelayed()).toHaveLength(0);
  });

  it('honours multiple configured offsets', async () => {
    await setSettings({ reminderOffsetsMinutes: [1440, 120] });
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    expect(await service.schedule(booking.id)).toEqual({ scheduled: 2, skipped: 0 });
  });

  it('fires and sends when the booking still matches', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    expect(await service.fire(fireArgs(booking))).toBe('SENT');
    expect(await prisma.notification.count({ where: { bookingId: booking.id, kind: 'REMINDER_24H' } })).toBe(1);
  });

  it.each(['CANCELED_BY_CUSTOMER', 'CANCELED_BY_BUSINESS', 'NO_SHOW', 'COMPLETED', 'EXPIRED'] as const)(
    'skips a %s booking at fire time', async (status) => {
      const booking = await bookingWithStatus(status, { startsAt: daysFromNow(3) });
      expect(await service.fire(fireArgs(booking))).toBe('SKIPPED');
      expect(await prisma.notification.count({ where: { bookingId: booking.id } })).toBe(0);
    });

  it('skips when the appointment time no longer matches the job', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    const args = fireArgs(booking);
    await prisma.booking.update({ where: { id: booking.id }, data: { startsAt: daysFromNow(4) } });
    expect(await service.fire(args)).toBe('SKIPPED');
  });

  it('is idempotent when the same reminder job runs twice', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.fire(fireArgs(booking));
    await service.fire(fireArgs(booking));
    expect(await prisma.notification.count({ where: { bookingId: booking.id, kind: 'REMINDER_24H' } })).toBe(1);
  });

  it('survives a lost queue: the reconciler rebuilds the next 48 hours', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(30) });
    await service.schedule(booking.id);
    await queues.notification.obliterate({ force: true });
    expect(await reconciler.runOnce()).toBe(1);
    expect(await queues.notification.getDelayed()).toHaveLength(1);
  });

  it('does not rebuild a reminder that already sent', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(30) });
    await service.fire(fireArgs(booking));
    await queues.notification.obliterate({ force: true });
    expect(await reconciler.runOnce()).toBe(0);
  });

  it('tolerates a failed removal, because fire re-validates anyway', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.schedule(booking.id);
    await queues.notification.obliterate({ force: true });
    await expect(service.cancelFor(booking.id)).resolves.toBeUndefined();
  });
});
```

**Validation scenarios.**
- [ ] The job id embeds `startsAt` epoch seconds, so a rescheduled booking gets a new
  job instead of BullMQ silently ignoring a duplicate id.
- [ ] A past-due offset is skipped, never fired immediately.
- [ ] Multiple configured offsets each schedule a job.
- [ ] Firing sends when status and time still match.
- [ ] Firing skips for every non-`CONFIRMED` status.
- [ ] Firing skips when `startsAt` has changed since the job was created.
- [ ] Firing twice sends once (`dedupeKey` carries `startsAt`).
- [ ] The nightly reconciler rebuilds missing reminders for the next 48 hours after a
  Redis loss, and does not rebuild ones already sent.
- [ ] `cancelFor` never throws when the job is already gone.

**Steps.**
- [ ] Implement `reminderJobId` as
  `reminder:<offsetMinutes>:<bookingId>:<startsAtEpochSeconds>`.
- [ ] Implement `schedule` reading offsets from settings, computing
  `delay = startsAt − offset − now`, skipping non-positive delays, and enqueueing
  `reminder.send` with the deterministic id. Return the counts so the caller can log
  them.
- [ ] Implement `fire` re-reading the booking: skip unless `CONFIRMED`; skip unless
  `Math.floor(startsAt/1000) === expectedStartsAtEpochSeconds`; otherwise `queue`
  the `REMINDER_24H` notification with
  `dedupeDiscriminator = String(expectedStartsAtEpochSeconds)` on both channels as
  configured.
- [ ] Implement `cancelFor` calling `Job.remove()` for each configured offset inside
  a `try` that logs at `debug` and swallows, with a comment stating that removal is
  best-effort because `fire` re-validates.
- [ ] Call `schedule` from the `booking.confirmed` and `booking.rescheduled`
  processors, and `cancelFor` from the cancellation paths.
- [ ] Implement `ReminderReconciler` (`SWEEP_REMINDERS`, nightly at 03:00 Berlin):
  for every `CONFIRMED` booking starting inside 48 hours, compute the expected job
  ids, check which are missing **and** have no `SENT` notification with the matching
  `dedupeKey`, and re-enqueue those.

**Commands.**
```bash
pnpm api test:integration -- test/integration/reminders.int.spec.ts
```

**Expected successful result.** Every reminder case green, including the
reschedule-job-id case and the Redis-loss recovery.

**Commit.** `feat(notifications): add reminders with time-keyed job ids and nightly reconciliation`

---

### Task 7.4 — Worker process

**Objective.** A second entrypoint that owns every processor, dispatcher,
reconciler, and schedule — and an HTTP process that owns none of them.

**Files.**
- `booking-app/apps/api/src/worker.main.ts` (new)
- `booking-app/apps/api/src/worker.module.ts` (new)
- `booking-app/apps/api/src/messaging/queues/scheduler.service.ts` (new)
- `booking-app/apps/api/src/messaging/queues/worker-registrar.service.ts` (new)
- `booking-app/apps/api/Dockerfile` (new)
- `booking-app/apps/api/test/integration/worker-bootstrap.int.spec.ts` (new)

**Produces for later tasks.** The `worker` Docker target and the repeatable job
schedule the deployment relies on.

**Database changes.** None. **API changes.** None. **Frontend changes.** None.

**Tests first.**

```ts
// worker-bootstrap.int.spec.ts (excerpt)
describe('worker bootstrap', () => {
  it('registers a processor for every declared job name', async () => {
    const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    const registrar = ctx.get(WorkerRegistrarService);
    const handled = registrar.handledJobNames();
    for (const name of Object.values(JOB)) expect(handled, name).toContain(name);
    await ctx.close();
  });

  it('registers exactly the expected repeatable schedule', async () => {
    const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    await ctx.get(SchedulerService).install();
    const repeatables = await ctx.get(getQueueToken(QUEUE.MAINTENANCE)).getRepeatableJobs();
    expect(repeatables.map((r) => r.name).sort()).toEqual([
      'sweep.expired_reservations', 'sweep.idempotency_keys', 'sweep.inbox', 'sweep.notifications',
      'sweep.outbox', 'sweep.reminders', 'sweep.retention', 'sweep.stuck_expiring',
    ]);
    await ctx.close();
  });

  it('installing the schedule twice does not duplicate repeatables', async () => {
    const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    await ctx.get(SchedulerService).install();
    await ctx.get(SchedulerService).install();
    expect(await ctx.get(getQueueToken(QUEUE.MAINTENANCE)).getRepeatableJobs()).toHaveLength(8);
    await ctx.close();
  });

  it('exposes no http listener', async () => {
    const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    expect((ctx as unknown as { httpAdapter?: unknown }).httpAdapter).toBeUndefined();
    await ctx.close();
  });

  it('refuses to start when APP_ROLE is not worker', async () => {
    const result = await runWorkerEntrypoint({ APP_ROLE: 'api' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('APP_ROLE');
  });

  it('the api process registers no bullmq workers', async () => {
    const ctx = await Test.createTestingModule({ imports: [AppModule] }).compile().then((m) => m.createNestApplication().init());
    expect(() => ctx.get(WorkerRegistrarService, { strict: false })).toThrow();
    await ctx.close();
  });

  it('runs each job inside its own correlation scope', async () => {
    const seen: string[] = [];
    await registrar.runJobForTest(JOB.BOOKING_CONFIRMED, { organizationId: 'o', bookingId: 'b' }, () => seen.push(correlationId()));
    expect(seen[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('drains in-flight jobs on SIGTERM before exiting', async () => {
    const { finished, exited } = await simulateSigtermDuringJob();
    expect(finished).toBe(true);
    expect(exited).toBe(true);
  });
});
```

**Validation scenarios.**
- [ ] Every declared job name has a registered processor — a new job without one
  fails the test.
- [ ] The repeatable schedule contains exactly the eight maintenance jobs.
- [ ] Installing the schedule twice does not duplicate repeatables.
- [ ] The worker context has no HTTP adapter.
- [ ] `APP_ROLE=api` makes `worker.main.ts` exit 1, and vice versa.
- [ ] The API process registers no BullMQ workers — proven by the token not being
  resolvable.
- [ ] Each job runs inside a fresh correlation scope carrying the id from the job
  data when present.
- [ ] `SIGTERM` lets an in-flight job finish before the process exits.

**Steps.**
- [ ] Write `worker.module.ts` importing config, logging, Prisma, organization
  context, providers, messaging, booking, payment, and notification modules, plus
  `WorkerRegistrarService` and `SchedulerService`. It must **not** import any
  controller module.
- [ ] Write `worker.main.ts`: assert `APP_ROLE === 'worker'`;
  `NestFactory.createApplicationContext(WorkerModule)`; `enableShutdownHooks`;
  install the schedule; log a start line naming every registered queue and every
  repeatable.
- [ ] Implement `WorkerRegistrarService` creating one BullMQ `Worker` per queue with
  `concurrency` from configuration (default 5), a job router keyed by job name that
  calls `parseJobPayload` then the processor, and a wrapper that runs the handler
  inside `runWithCorrelation`. Expose `handledJobNames()` for the test.
- [ ] Implement `SchedulerService.install` using `upsertJobScheduler` per maintenance
  job with these cadences: expired reservations 60 s, stuck expiring 60 s, outbox
  5 min, inbox 2 min, notifications 5 min, reminders nightly 03:00 Berlin,
  idempotency keys nightly 03:15, retention nightly 03:30.
- [ ] Add graceful shutdown: on `SIGTERM`/`SIGINT`, `worker.close()` for each worker
  (which waits for in-flight jobs), then `app.close()`, with a 30-second hard
  timeout.
- [ ] Write the multi-stage `Dockerfile` with a shared `deps` and `build` stage and
  two runtime targets, `api` (`CMD ["node","dist/main.js"]`) and `worker`
  (`CMD ["node","dist/worker.main.js"]`), both running as a non-root user with
  `NODE_ENV=production` and only production dependencies installed.
- [ ] Add a global error handler logging `unhandledRejection` and
  `uncaughtException` at `fatal` and exiting, so a supervisor restarts rather than a
  half-dead worker silently stopping.

**Commands.**
```bash
pnpm api test:integration -- test/integration/worker-bootstrap.int.spec.ts
pnpm api build
APP_ROLE=worker node booking-app/apps/api/dist/worker.main.js &
sleep 3 && kill -TERM %1
docker build -f booking-app/apps/api/Dockerfile --target worker -t shape-and-flow-booking-worker .
```

**Expected successful result.** All bootstrap tests green; the worker starts, logs
its queues and eight repeatables, and exits cleanly on `SIGTERM`; both Docker
targets build.

**Commit.** `feat(worker): add worker entrypoint, job registrar and maintenance schedule`
---

## Stage 8 — Office API

### Task 8.1 — Office authentication and sessions

**Objective.** Log office staff in safely, keep the session in Redis, and make
enumeration, fixation, brute force, and CSRF all fail.

**Files.**
- `booking-app/packages/contracts/src/auth/index.ts` (new)
- `booking-app/apps/api/src/auth/password.service.ts` (new)
- `booking-app/apps/api/src/auth/session.store.ts` (new)
- `booking-app/apps/api/src/auth/office-session.guard.ts` (new)
- `booking-app/apps/api/src/auth/csrf-header.guard.ts` (new)
- `booking-app/apps/api/src/auth/auth.controller.ts` (new)
- `booking-app/apps/api/src/auth/password-reset.service.ts` (new)
- `booking-app/apps/api/src/auth/auth.module.ts` (new)
- `booking-app/apps/api/test/integration/auth.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export interface OfficeSession { sid: string; officeUserId: string; organizationId: string;
                                 role: OfficeUserRole; canIssueRefunds: boolean; employeeId: string | null;
                                 createdAt: number; lastSeenAt: number }
export class SessionStore {
  create(user: OfficeUser): Promise<string>;
  read(sid: string): Promise<OfficeSession | null>;      // slides the idle TTL
  destroy(sid: string): Promise<void>;
  destroyAllForUser(officeUserId: string): Promise<number>;
}
export const CURRENT_USER = 'CURRENT_USER';
```

**Database changes.** None.
**API changes.** All six `/auth` routes from §6.4. **Frontend changes.** None.

**Tests first.**

```ts
// auth.int.spec.ts (excerpt)
describe('POST /api/auth/login', () => {
  it('sets an HttpOnly, Secure, SameSite=Lax cookie scoped to /api', async () => {
    const res = await request(app).post('/api/auth/login')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ email: 'owner@shape-and-flow.example', password: OWNER_PASSWORD }).expect(200);
    const cookie = res.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/^sf_office_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api');
    expect(res.body.user).toMatchObject({ role: 'OWNER', canIssueRefunds: true });
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it.each([
    ['unknown email', { email: 'nobody@example.com', password: 'whatever-long-enough' }],
    ['wrong password', { email: 'owner@shape-and-flow.example', password: 'wrong-but-long' }],
    ['archived user', { email: 'archived@shape-and-flow.example', password: OWNER_PASSWORD }],
  ])('answers %s with an identical 401', async (_label, body) => {
    const res = await request(app).post('/api/auth/login').set('X-Requested-With', 'XMLHttpRequest').send(body).expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Invalid credentials.' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does not distinguish an unknown email by timing', async () => {
    const unknown = await timeIt(() => login({ email: 'nobody@example.com', password: 'x'.repeat(20) }));
    const known = await timeIt(() => login({ email: 'owner@shape-and-flow.example', password: 'x'.repeat(20) }));
    expect(Math.abs(unknown - known)).toBeLessThan(Math.max(unknown, known) * 0.5);
  });

  it('locks the account after ten failures and still answers identically', async () => {
    for (let i = 0; i < 10; i += 1) await login({ email: OWNER_EMAIL, password: 'wrong-but-long' });
    const user = await prisma.officeUser.findFirstOrThrow({ where: { email: OWNER_EMAIL } });
    expect(user.lockedUntil).not.toBeNull();
    const res = await login({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials.');
  });

  it('rotates the session id on login, defeating fixation', async () => {
    const first = await loginOk();
    const second = await loginOk();
    expect(sidOf(first)).not.toBe(sidOf(second));
  });

  it('resets the failure counter on success', async () => {
    await login({ email: OWNER_EMAIL, password: 'wrong-but-long' });
    await loginOk();
    expect((await prisma.officeUser.findFirstOrThrow({ where: { email: OWNER_EMAIL } })).failedLoginAttempts).toBe(0);
  });
});

describe('session and csrf', () => {
  it('rejects an office request without a session', async () => {
    await request(app).get('/api/office/dashboard').expect(401);
  });

  it('rejects a state-changing request without X-Requested-With', async () => {
    const agent = await loggedInAgent();
    await agent.post('/api/office/blocked-times').send(blockedTimeBody())
      .expect(403).expect((r) => expect(r.body.code).toBe('CSRF_FAILED'));
  });

  it('allows a GET without the header', async () => {
    const agent = await loggedInAgent();
    await agent.get('/api/office/dashboard').expect(200);
  });

  it('expires the session after the absolute cap even while active', async () => {
    const agent = await loggedInAgent();
    await ageSession(agent, { createdAt: Date.now() - 8 * 24 * 3600_000 });
    await agent.get('/api/office/dashboard').expect(401);
  });

  it('logout is idempotent and clears the cookie', async () => {
    const agent = await loggedInAgent();
    await agent.post('/api/auth/logout').set('X-Requested-With', 'XMLHttpRequest').expect(204);
    await agent.post('/api/auth/logout').set('X-Requested-With', 'XMLHttpRequest').expect(204);
    await agent.get('/api/office/dashboard').expect(401);
  });
});

describe('password reset', () => {
  it('answers 202 for an unknown address without sending anything', async () => {
    await request(app).post('/api/auth/password-reset/request').send({ email: 'nobody@example.com' }).expect(202);
    expect(fakeEmail.sent).toHaveLength(0);
  });

  it('stores only a hash and consumes the token once', async () => {
    await request(app).post('/api/auth/password-reset/request').send({ email: OWNER_EMAIL }).expect(202);
    const token = extractResetToken(fakeEmail.sent[0]!);
    const row = await prisma.passwordResetToken.findFirstOrThrow({});
    expect(row.tokenHash).toBe(sha256(token));
    await request(app).post('/api/auth/password-reset/confirm').send({ token, newPassword: 'a-new-long-password' }).expect(204);
    await request(app).post('/api/auth/password-reset/confirm').send({ token, newPassword: 'another-long-password' }).expect(401);
  });

  it('revokes every existing session on reset', async () => {
    const agent = await loggedInAgent();
    await request(app).post('/api/auth/password-reset/request').send({ email: OWNER_EMAIL }).expect(202);
    const token = extractResetToken(fakeEmail.sent[0]!);
    await request(app).post('/api/auth/password-reset/confirm').send({ token, newPassword: 'a-new-long-password' }).expect(204);
    await agent.get('/api/office/dashboard').expect(401);
  });

  it('rejects an expired token and a weak password', async () => {
    await request(app).post('/api/auth/password-reset/request').send({ email: OWNER_EMAIL }).expect(202);
    const token = extractResetToken(fakeEmail.sent[0]!);
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).post('/api/auth/password-reset/confirm').send({ token, newPassword: 'a-new-long-password' }).expect(401);
    await request(app).post('/api/auth/password-reset/confirm').send({ token, newPassword: 'short' }).expect(400);
  });
});
```

**Validation scenarios.**
- [ ] The cookie is `HttpOnly`, `Secure` (in production), `SameSite=Lax`,
  `Path=/api`.
- [ ] Unknown email, wrong password, and archived user all answer an identical
  `401 UNAUTHENTICATED` with the same message and no cookie.
- [ ] Response timing does not distinguish an unknown email (a dummy argon2 verify
  runs).
- [ ] Ten failures set `lockedUntil`; a subsequent correct password still answers
  `401` with the same message.
- [ ] The session id rotates on every login.
- [ ] A successful login resets `failedLoginAttempts`.
- [ ] An office request without a session is `401`; a state-changing one without
  `X-Requested-With` is `403 CSRF_FAILED`; a `GET` does not need the header.
- [ ] The absolute 7-day cap expires an actively used session.
- [ ] Logout is idempotent and the session is gone from Redis.
- [ ] Password reset answers `202` for unknown addresses and sends nothing.
- [ ] Only the token hash is stored; the token is single-use; every session is
  revoked on reset.
- [ ] An expired token is `401`; a password under 12 characters or on the deny list
  is `400`.
- [ ] `POST /auth/password` revokes all *other* sessions but keeps the current one.

**Steps.**
- [ ] Add `argon2` and `cookie-parser`; add `@nestjs/throttler` with the Redis
  storage adapter.
- [ ] Implement `PasswordService` with argon2id parameters
  `{ type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }` as one exported
  constant, `hash`, `verify`, a `verifyDummy` used on unknown emails, and
  `assertStrong` (≥ 12 characters, not in the embedded deny list).
- [ ] Implement `SessionStore` over Redis: `session:<sid>` holding the JSON session
  with `EX` = idle TTL; `read` refreshing the TTL and enforcing the absolute cap from
  `createdAt`; `session:user:<id>` as a set maintained on create and destroy.
- [ ] Implement `OfficeSessionGuard` reading the cookie, loading the session,
  attaching it under `CURRENT_USER`, and throwing `UNAUTHENTICATED` otherwise.
- [ ] Implement `CsrfHeaderGuard` applying only to `POST`/`PATCH`/`PUT`/`DELETE` and
  requiring `X-Requested-With: XMLHttpRequest`.
- [ ] Implement the controller with the throttles from §6.1 and a `login` that
  branches only after both the user lookup and a verify (real or dummy) have run.
- [ ] Implement `PasswordResetService`: 256-bit token, SHA-256 stored, 60-minute
  expiry, `usedAt` set in the same transaction as the password write, all sessions
  revoked, and the reset email queued through the notification service.

**Commands.**
```bash
pnpm api test:integration -- test/integration/auth.int.spec.ts
```

**Expected successful result.** Every authentication case green, including the
timing-equality assertion and the absolute session cap.

**Commit.** `feat(auth): add office sessions, argon2id passwords, csrf and reset flow`

---

### Task 8.2 — Roles, capabilities, tenant isolation, and the audit interceptor

**Objective.** Make the authorization matrix from §10.5 enforced by code and proven
by tests, and make every consequential office action leave a trace.

**Files.**
- `booking-app/apps/api/src/auth/roles.decorator.ts` (new)
- `booking-app/apps/api/src/auth/roles.guard.ts` (new)
- `booking-app/apps/api/src/auth/refund-capability.guard.ts` (new)
- `booking-app/apps/api/src/auth/employee-scope.service.ts` (new)
- `booking-app/apps/api/src/common/audit/audit.interceptor.ts` (new)
- `booking-app/apps/api/test/integration/authorization.int.spec.ts` (new)
- `booking-app/apps/api/test/integration/tenant-isolation.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export const Roles: (...roles: OfficeUserRole[]) => MethodDecorator;
export const RequiresRefundCapability: () => MethodDecorator;
export class EmployeeScopeService {
  /** Throws NOT_FOUND when an EMPLOYEE-role user reaches another employee's data. */
  assertMayAccessEmployee(session: OfficeSession, employeeId: string): void;
  visibleEmployeeIds(session: OfficeSession): Promise<string[] | 'ALL'>;
}
```

**Database changes.** None.
**API changes.** Guards applied to every `/office` route.
**Frontend changes.** None.

**Tests first.**

```ts
// authorization.int.spec.ts — one table-driven test covering the whole §10.5 matrix
const MATRIX: { method: 'get'|'post'|'patch'|'put'|'delete'; path: string; allow: Role[]; needsRefund?: boolean }[] = [
  { method: 'get',  path: '/api/office/dashboard',                  allow: ['OWNER','ADMIN','EMPLOYEE'] },
  { method: 'post', path: '/api/office/bookings',                   allow: ['OWNER','ADMIN'] },
  { method: 'post', path: '/api/office/bookings/:id/cancel',        allow: ['OWNER','ADMIN'] },
  { method: 'post', path: '/api/office/bookings/:id/complete',      allow: ['OWNER','ADMIN','EMPLOYEE'] },
  { method: 'post', path: '/api/office/bookings/:id/manual-payments', allow: ['OWNER','ADMIN'] },
  { method: 'post', path: '/api/office/bookings/:id/refunds',       allow: ['OWNER','ADMIN'], needsRefund: true },
  { method: 'post', path: '/api/office/cancellation-requests/:id/decide', allow: ['OWNER','ADMIN'] },
  { method: 'post', path: '/api/office/employees',                  allow: ['OWNER','ADMIN'] },
  { method: 'put',  path: '/api/office/employees/:id/working-hours', allow: ['OWNER','ADMIN'] },
  { method: 'post', path: '/api/office/services',                   allow: ['OWNER','ADMIN'] },
  { method: 'patch',path: '/api/office/settings',                   allow: ['OWNER'] },
  { method: 'post', path: '/api/office/users',                      allow: ['OWNER'] },
  { method: 'get',  path: '/api/office/audit-log',                  allow: ['OWNER'] },
  { method: 'get',  path: '/api/office/exports/bookings.csv',       allow: ['OWNER','ADMIN'] },
];

describe('authorization matrix', () => {
  it.each(MATRIX)('$method $path is restricted to $allow', async (row) => {
    for (const role of ['OWNER', 'ADMIN', 'EMPLOYEE'] as const) {
      const agent = await agentFor(role);
      const res = await call(agent, row);
      if (row.allow.includes(role)) expect(res.status, `${role} allowed`).not.toBe(403);
      else expect(res.status, `${role} denied`).toBe(403);
    }
  });

  it('requires the refund capability independently of the role', async () => {
    const admin = await agentFor('ADMIN', { canIssueRefunds: false });
    await call(admin, { method: 'post', path: '/api/office/bookings/:id/refunds' })
      .then((r) => { expect(r.status).toBe(403); expect(r.body.code).toBe('FORBIDDEN_ROLE'); });
    const capable = await agentFor('ADMIN', { canIssueRefunds: true });
    await call(capable, { method: 'post', path: '/api/office/bookings/:id/refunds' })
      .then((r) => expect(r.status).not.toBe(403));
  });

  it('OWNER has the refund capability implicitly', async () => {
    const owner = await agentFor('OWNER', { canIssueRefunds: false });
    await call(owner, { method: 'post', path: '/api/office/bookings/:id/refunds' }).then((r) => expect(r.status).not.toBe(403));
  });

  it('scopes an EMPLOYEE to their own bookings with 404, not 403', async () => {
    const agent = await agentFor('EMPLOYEE', { employeeId: ctx.employee1.id });
    const other = await confirmedBooking({ employeeId: ctx.employee2.id, startsAt: hoursFromNow(-2) });
    await agent.post(`/api/office/bookings/${other.id}/complete`).set('X-Requested-With', 'XMLHttpRequest')
      .expect(404).expect((r) => expect(r.body.code).toBe('NOT_FOUND'));
  });

  it('an EMPLOYEE calendar shows only their own rows', async () => {
    const agent = await agentFor('EMPLOYEE', { employeeId: ctx.employee1.id });
    const res = await agent.get('/api/office/calendar').query({ from: '2026-08-10', to: '2026-08-20' }).expect(200);
    expect(new Set(res.body.bookings.map((b: { employeeId: string }) => b.employeeId))).toEqual(new Set([ctx.employee1.id]));
  });

  it('refuses self-archive and self-demotion', async () => {
    const owner = await agentFor('OWNER');
    await owner.post(`/api/office/users/${ctx.owner.id}/archive`).set('X-Requested-With', 'XMLHttpRequest').expect(409);
    await owner.patch(`/api/office/users/${ctx.owner.id}`).set('X-Requested-With', 'XMLHttpRequest')
      .send({ role: 'ADMIN' }).expect(409);
  });
});

// tenant-isolation.int.spec.ts
describe('tenant isolation', () => {
  it('every office list endpoint returns only the session organization', async () => {
    const agent = await agentForOrg(orgA);
    await seedNoise(orgB);
    for (const path of ['/api/office/bookings', '/api/office/employees', '/api/office/services', '/api/office/customers']) {
      const res = await agent.get(path).expect(200);
      for (const item of res.body.items) expect(item.organizationId ?? orgA.id).toBe(orgA.id);
      expect(res.body.items.length).toBeGreaterThan(0);
    }
  });

  it('every office detail endpoint 404s another organization id', async () => {
    const agent = await agentForOrg(orgA);
    for (const [path, id] of await foreignIds(orgB)) {
      await agent.get(path.replace(':id', id)).expect(404).expect((r) => expect(r.body.code).toBe('NOT_FOUND'));
    }
  });

  it('a mutation targeting a foreign id 404s and changes nothing', async () => {
    const agent = await agentForOrg(orgA);
    const foreign = await confirmedBooking({ organizationId: orgB.id, startsAt: hoursFromNow(-2) });
    await agent.post(`/api/office/bookings/${foreign.id}/complete`).set('X-Requested-With', 'XMLHttpRequest').expect(404);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe('CONFIRMED');
  });
});
```

**Validation scenarios.**
- [ ] Every row of the §10.5 matrix is enforced for all three roles.
- [ ] The refund capability is required independently of the role, and `OWNER` has it
  implicitly.
- [ ] An `EMPLOYEE` reaching another employee's booking gets `404`, not `403`.
- [ ] An `EMPLOYEE` calendar contains only their own rows.
- [ ] Self-archive and self-demotion are `409`.
- [ ] Every list endpoint is organization-scoped and non-empty for its own tenant.
- [ ] Every detail endpoint `404`s a foreign id; a foreign mutation changes nothing.
- [ ] Every mutating `/office` route writes exactly one `AuditLog` row with the actor,
  the correlation id, and redacted `before`/`after`.
- [ ] A route missing a `@Roles` decorator fails a metadata test that walks the
  router.

**Steps.**
- [ ] Implement `Roles` / `RolesGuard` reading metadata and throwing
  `FORBIDDEN_ROLE`.
- [ ] Implement `RefundCapabilityGuard` allowing `OWNER` or `canIssueRefunds`.
- [ ] Implement `EmployeeScopeService`: `visibleEmployeeIds` returns `'ALL'` for
  `OWNER`/`ADMIN` and `[session.employeeId]` for `EMPLOYEE` (throwing if the user has
  no linked employee); `assertMayAccessEmployee` throws `NOT_FOUND`.
- [ ] Implement `AuditInterceptor` applying to mutating `/office` routes: capture the
  route's declared `AuditAction` from metadata, run the handler, and on success write
  the audit row with the resolved entity id from the response or the path.
- [ ] Add a metadata test that enumerates every `/office` route from the Nest router
  and asserts each has both `@Roles` and, for mutations, an audit action — so a new
  endpoint cannot be added unguarded.

**Commands.**
```bash
pnpm api test:integration -- test/integration/authorization.int.spec.ts test/integration/tenant-isolation.int.spec.ts
```

**Expected successful result.** The full matrix green, tenant isolation proven for
both list and detail endpoints, and the router metadata test passing.

**Commit.** `feat(auth): enforce role matrix, refund capability, employee scope and audit trail`

---

### Task 8.3 — Dashboard and calendar

**Objective.** The two screens the office actually lives in, each served by one
bounded query set.

**Files.**
- `booking-app/packages/contracts/src/office/dashboard.ts` (new)
- `booking-app/packages/contracts/src/office/calendar.ts` (new)
- `booking-app/apps/api/src/office/dashboard.controller.ts` (new)
- `booking-app/apps/api/src/office/dashboard.service.ts` (new)
- `booking-app/apps/api/src/office/calendar.controller.ts` (new)
- `booking-app/apps/api/src/office/calendar.service.ts` (new)
- `booking-app/apps/api/src/office/display-status.ts` (new)
- `booking-app/apps/api/test/integration/office-calendar.int.spec.ts` (new)

**Produces for later tasks.**

```ts
export type DisplayStatus = BookingStatus | 'CANCELLATION_REQUESTED' | 'RESCHEDULE_REQUESTED';
export function deriveDisplayStatus(booking: { status: BookingStatus },
  open: { cancellation: boolean; reschedule: boolean }): DisplayStatus;
```

**Database changes.** None.
**API changes.** `GET /office/dashboard`, `GET /office/calendar`.
**Frontend changes.** None.

**Tests first.**

```ts
// office-calendar.int.spec.ts (excerpt)
describe('GET /api/office/calendar', () => {
  it('returns bookings, blocked times, time off, closed days and working-hours envelopes', async () => {
    const res = await owner.get('/api/office/calendar').query({ from: '2026-08-10', to: '2026-08-20' }).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['blockedTimes','bookings','closedDays','timeOff','workingHours']);
  });

  it('caps the range at 62 days', async () => {
    await owner.get('/api/office/calendar').query({ from: '2026-01-01', to: '2026-06-01' })
      .expect(400).expect((r) => expect(r.body.code).toBe('VALIDATION_FAILED'));
  });

  it('shows CANCELLATION_REQUESTED as a display status while the booking stays CONFIRMED', async () => {
    const booking = await confirmedPaidBooking({ startsAt: hoursFromNow(48) });
    await cancellation.cancelByCustomer(booking.id);
    const res = await owner.get('/api/office/calendar').query(rangeAround(booking)).expect(200);
    const row = res.body.bookings.find((b: { id: string }) => b.id === booking.id);
    expect(row.status).toBe('CONFIRMED');
    expect(row.displayStatus).toBe('CANCELLATION_REQUESTED');
  });

  it('shows RESCHEDULE_REQUESTED, and prefers cancellation when both are open', async () => {
    const booking = await confirmedPaidBooking({ startsAt: hoursFromNow(48) });
    await reschedule.requestByCustomer({ bookingId: booking.id, requestedStartsAt: hoursFromNow(72) });
    let row = await calendarRowFor(booking);
    expect(row.displayStatus).toBe('RESCHEDULE_REQUESTED');
    await cancellation.cancelByCustomer(booking.id);
    row = await calendarRowFor(booking);
    expect(row.displayStatus).toBe('CANCELLATION_REQUESTED');
  });

  it('omits non-blocking bookings by default and includes them on request', async () => {
    const expired = await bookingWithStatus('EXPIRED', { startsAt: hoursFromNow(48) });
    let res = await owner.get('/api/office/calendar').query(rangeAround(expired)).expect(200);
    expect(res.body.bookings.map((b: { id: string }) => b.id)).not.toContain(expired.id);
    res = await owner.get('/api/office/calendar').query({ ...rangeAround(expired), includeInactive: true }).expect(200);
    expect(res.body.bookings.map((b: { id: string }) => b.id)).toContain(expired.id);
  });

  it('uses a bounded number of queries regardless of range width', async () => {
    const counter = countQueries(prisma);
    await owner.get('/api/office/calendar').query({ from: '2026-08-01', to: '2026-09-30' }).expect(200);
    expect(counter.total()).toBeLessThanOrEqual(6);
  });
});

describe('GET /api/office/dashboard', () => {
  it('counts today, the next seven days, open requests, unpaid bookings and today revenue', async () => {
    const res = await owner.get('/api/office/dashboard').expect(200);
    expect(res.body).toMatchObject({
      today: expect.any(Array),
      next7DaysCount: expect.any(Number),
      pendingCancellationRequests: expect.any(Number),
      pendingRescheduleRequests: expect.any(Number),
      unpaidConfirmedBookings: expect.any(Number),
      todayRevenue: { amountCents: expect.any(Number), currency: 'EUR' },
      operations: {
        failedJobs: expect.any(Number), stuckOutboxRows: expect.any(Number),
        pendingNotifications: expect.any(Number), unprocessedWebhooks: expect.any(Number),
        overdueCompletions: expect.any(Number),
      },
    });
  });

  it('counts a booking with a manual payment below the snapshot price as unpaid', async () => {
    const booking = await confirmedUnpaidBooking({ startsAt: hoursFromNow(2) });
    await manualPayments.record({ bookingId: booking.id, amountCents: 2000, method: 'CASH', paidAt: new Date(), officeUserId: ctx.owner.id });
    expect((await owner.get('/api/office/dashboard').expect(200)).body.unpaidConfirmedBookings).toBe(1);
    await manualPayments.record({ bookingId: booking.id, amountCents: 2500, method: 'CASH', paidAt: new Date(), officeUserId: ctx.owner.id });
    expect((await owner.get('/api/office/dashboard').expect(200)).body.unpaidConfirmedBookings).toBe(0);
  });

  it('scopes today to Europe/Berlin, not to UTC', async () => {
    const booking = await confirmedBooking({ startsAt: berlinLocal('23:30') });
    expect((await owner.get('/api/office/dashboard').expect(200)).body.today.map((b: { id: string }) => b.id)).toContain(booking.id);
  });

  it('shows an EMPLOYEE only their own appointments', async () => {
    const agent = await agentFor('EMPLOYEE', { employeeId: ctx.employee1.id });
    await confirmedBooking({ employeeId: ctx.employee2.id, startsAt: hoursFromNow(2) });
    const res = await agent.get('/api/office/dashboard').expect(200);
    for (const b of res.body.today) expect(b.employeeId).toBe(ctx.employee1.id);
  });
});
```

**Validation scenarios.**
- [ ] The calendar returns exactly five collections and nothing else.
- [ ] A range over 62 days is `400`.
- [ ] `CANCELLATION_REQUESTED` and `RESCHEDULE_REQUESTED` appear as `displayStatus`
  while `status` stays `CONFIRMED`; cancellation wins when both are open.
- [ ] Non-blocking bookings are omitted unless `includeInactive=true`.
- [ ] A two-month range uses at most six queries.
- [ ] The dashboard returns every documented tile plus the operations block.
- [ ] A partially paid booking counts as unpaid until the paid total reaches the
  snapshot price.
- [ ] "Today" is a Berlin-local day, so a 23:30 appointment is included.
- [ ] An `EMPLOYEE` sees only their own appointments.

**Steps.**
- [ ] Implement `deriveDisplayStatus` as a pure function with cancellation taking
  precedence, and unit-test it exhaustively over the status enum.
- [ ] Implement `CalendarService.load` with five queries scoped by
  `visibleEmployeeIds`, plus one query for the open-request ids used by
  `deriveDisplayStatus`.
- [ ] Implement `DashboardService` with grouped aggregate queries — one
  `groupBy` for booking counts by status, one aggregate for today's revenue across
  `Payment` and `ManualPayment`, one for open requests, one for the unpaid
  comparison, and the operations counts from the reconcilers' exposed counters.
- [ ] Convert "today" and "next 7 days" through the time primitives, never with UTC
  day boundaries.
- [ ] Hand-write both response projections.

**Commands.**
```bash
pnpm api test:integration -- test/integration/office-calendar.int.spec.ts
```

**Expected successful result.** Both screens green, including the Berlin-local day
boundary and the query-count ceiling.

**Commit.** `feat(office): add dashboard and calendar with derived display statuses`

---

### Task 8.4 — Staff, availability, catalog, and settings

**Objective.** Every configuration surface, with conflict detection that runs under
the same advisory lock as booking creation.

**Files.**
- `booking-app/packages/contracts/src/office/staff.ts` (new)
- `booking-app/packages/contracts/src/office/catalog.ts` (new)
- `booking-app/packages/contracts/src/office/settings.ts` (new)
- `booking-app/apps/api/src/office/employees.controller.ts` (new)
- `booking-app/apps/api/src/office/employees.service.ts` (new)
- `booking-app/apps/api/src/office/availability-admin.controller.ts` (new)
- `booking-app/apps/api/src/office/availability-admin.service.ts` (new)
- `booking-app/apps/api/src/office/catalog.controller.ts` (new)
- `booking-app/apps/api/src/office/catalog.service.ts` (new)
- `booking-app/apps/api/src/office/settings.controller.ts` (new)
- `booking-app/apps/api/src/office/office-users.controller.ts` (new)
- `booking-app/apps/api/test/integration/office-admin.int.spec.ts` (new)

**Produces for later tasks.** Everything the office web area in Stage 10 renders.

**Database changes.** None.
**API changes.** The staff, availability, catalog, settings, and users routes from
§6.5. **Frontend changes.** None.

**Tests first.**

```ts
// office-admin.int.spec.ts (excerpt)
describe('working hours', () => {
  it('replaces the whole week transactionally with nested breaks', async () => {
    await owner.put(`/api/office/employees/${ctx.employee1.id}/working-hours`).set(csrf)
      .send({ segments: [
        { weekday: 'MONDAY', startMinute: 540, endMinute: 1080, breaks: [{ startMinute: 720, endMinute: 750 }] },
        { weekday: 'MONDAY', startMinute: 1140, endMinute: 1260, breaks: [] },
      ] }).expect(200);
    const rows = await prisma.workingHours.findMany({ where: { employeeId: ctx.employee1.id }, include: { breaks: true } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.breaks).toHaveLength(1);
  });

  it('rejects overlapping segments on the same weekday', async () => {
    await owner.put(`/api/office/employees/${ctx.employee1.id}/working-hours`).set(csrf)
      .send({ segments: [
        { weekday: 'MONDAY', startMinute: 540, endMinute: 720, breaks: [] },
        { weekday: 'MONDAY', startMinute: 660, endMinute: 840, breaks: [] },
      ] })
      .expect(400).expect((r) => expect(r.body.details.reason).toContain('overlap'));
  });

  it('rejects a break outside its segment and a segment past midnight', async () => {
    await owner.put(`/api/office/employees/${ctx.employee1.id}/working-hours`).set(csrf)
      .send({ segments: [{ weekday: 'MONDAY', startMinute: 540, endMinute: 720, breaks: [{ startMinute: 800, endMinute: 820 }] }] })
      .expect(400);
    await owner.put(`/api/office/employees/${ctx.employee1.id}/working-hours`).set(csrf)
      .send({ segments: [{ weekday: 'MONDAY', startMinute: 1400, endMinute: 1500, breaks: [] }] })
      .expect(400);
  });

  it('leaves existing bookings untouched but reports the conflicts', async () => {
    const booking = await confirmedBooking({ employeeId: ctx.employee1.id, startsAt: nextMondayAt('09:00') });
    const res = await owner.put(`/api/office/employees/${ctx.employee1.id}/working-hours`).set(csrf)
      .send({ segments: [{ weekday: 'MONDAY', startMinute: 840, endMinute: 1080, breaks: [] }] }).expect(200);
    expect(res.body.conflictingBookings.map((b: { id: string }) => b.id)).toContain(booking.id);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
  });
});

describe('blocked time and time off', () => {
  it('rejects a blocked time overlapping a confirmed booking', async () => {
    const booking = await confirmedBooking({ employeeId: ctx.employee1.id, startsAt: hoursFromNow(48) });
    await owner.post('/api/office/blocked-times').set(csrf)
      .send({ employeeId: ctx.employee1.id, startsAt: booking.startsAt, endsAt: booking.endsAt, reason: 'Meeting' })
      .expect(409).expect((r) => expect(r.body.code).toBe('SLOT_UNAVAILABLE'));
  });

  it('rejects two overlapping blocked times via the exclusion constraint', async () => {
    const body = { employeeId: ctx.employee1.id, startsAt: hoursFromNow(72), endsAt: hoursFromNow(73) };
    await owner.post('/api/office/blocked-times').set(csrf).send(body).expect(201);
    await owner.post('/api/office/blocked-times').set(csrf).send(body).expect(409);
  });

  it('refuses time off that covers a confirmed booking, naming the count', async () => {
    await confirmedBooking({ employeeId: ctx.employee1.id, startsAt: daysFromNow(10) });
    await owner.post('/api/office/time-off').set(csrf)
      .send({ employeeId: ctx.employee1.id, startDate: localDate(daysFromNow(9)), endDate: localDate(daysFromNow(11)), status: 'APPROVED' })
      .expect(409).expect((r) => { expect(r.body.code).toBe('EMPLOYEE_HAS_FUTURE_BOOKINGS'); expect(r.body.details.bookingCount).toBe(1); });
  });

  it('removes availability once approved time off exists', async () => {
    const before = await publicSlotCount(daysFromNow(20));
    await owner.post('/api/office/time-off').set(csrf)
      .send({ employeeId: ctx.employee1.id, startDate: localDate(daysFromNow(20)), endDate: localDate(daysFromNow(20)), status: 'APPROVED' })
      .expect(201);
    expect(await publicSlotCount(daysFromNow(20))).toBeLessThan(before);
  });
});

describe('catalog and archiving', () => {
  it('archives a service and removes it from the public list without touching history', async () => {
    const booking = await confirmedBooking({ serviceId: ctx.service30.id, startsAt: hoursFromNow(-48) });
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'COMPLETED' } });
    await owner.post(`/api/office/services/${ctx.service30.id}/archive`).set(csrf).expect(200);
    expect((await request(app).get('/api/public/services').expect(200)).body.items.map((s: { id: string }) => s.id))
      .not.toContain(ctx.service30.id);
    expect((await owner.get(`/api/office/bookings/${booking.id}`).expect(200)).body.serviceName).toBe('Facial Massage 30 min');
  });

  it('refuses to archive a service or employee with future blocking bookings', async () => {
    await confirmedBooking({ serviceId: ctx.service60.id, employeeId: ctx.employee2.id, startsAt: daysFromNow(4) });
    await owner.post(`/api/office/services/${ctx.service60.id}/archive`).set(csrf).expect(409);
    await owner.post(`/api/office/employees/${ctx.employee2.id}/archive`).set(csrf).expect(409);
  });

  it('refuses to archive a category that still has an active service', async () => {
    await owner.post(`/api/office/service-categories/${ctx.category.id}/archive`).set(csrf).expect(409);
  });

  it('revokes sessions when an office user is archived', async () => {
    const admin = await agentFor('ADMIN');
    await owner.post(`/api/office/users/${ctx.admin.id}/archive`).set(csrf).expect(200);
    await admin.get('/api/office/dashboard').expect(401);
  });
});

describe('settings', () => {
  it('validates every bound and rejects an unsupported interval', async () => {
    await owner.patch('/api/office/settings').set(csrf).send({ schedulingIntervalMinutes: 7 }).expect(400);
    await owner.patch('/api/office/settings').set(csrf).send({ cancellationFeePercent: 101 }).expect(400);
    await owner.patch('/api/office/settings').set(csrf).send({ bookingHorizonDays: 0 }).expect(400);
  });

  it('applies immediately to public availability and refreshes the cached context', async () => {
    const before = await publicSlotCount(daysFromNow(30));
    await owner.patch('/api/office/settings').set(csrf).send({ schedulingIntervalMinutes: 60 }).expect(200);
    expect(await publicSlotCount(daysFromNow(30))).toBeLessThan(before);
  });

  it('audits the change with before and after', async () => {
    await owner.patch('/api/office/settings').set(csrf).send({ minimumNoticeHours: 48 }).expect(200);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'SETTINGS_UPDATED' }, orderBy: { createdAt: 'desc' } });
    expect(row.before).toMatchObject({ minimumNoticeHours: 24 });
    expect(row.after).toMatchObject({ minimumNoticeHours: 48 });
  });
});
```

**Validation scenarios.**
- [ ] Working hours replace transactionally, with nested breaks.
- [ ] Overlapping segments, out-of-segment breaks, and past-midnight segments are all
  `400` with a reason.
- [ ] Saving narrower hours does not move existing bookings but reports the
  conflicts.
- [ ] A blocked time overlapping a confirmed booking is `409 SLOT_UNAVAILABLE`.
- [ ] Two overlapping blocked times are rejected by the exclusion constraint.
- [ ] Time off covering a confirmed booking is `409 EMPLOYEE_HAS_FUTURE_BOOKINGS`
  with `details.bookingCount`.
- [ ] Approved time off removes public availability.
- [ ] Archiving a service removes it from the public list and leaves history readable.
- [ ] Archiving a service or employee with future blocking bookings is `409`.
- [ ] Archiving a category with an active service is `409`.
- [ ] Archiving an office user revokes their sessions.
- [ ] Every settings bound is validated, changes apply immediately to availability,
  and the change is audited with `before`/`after`.

**Steps.**
- [ ] Write the office contracts with every bound from §4.3 expressed in Zod, so the
  database `CHECK` and the schema agree; add a test asserting the Zod bounds match
  the SQL `CHECK` text.
- [ ] Implement `EmployeesService` with create, patch, archive (guarded by a future
  blocking-booking count), and the working-hours replacement inside one transaction
  that validates overlap and break containment first, then reports conflicts.
- [ ] Implement `AvailabilityAdminService`: every calendar-mutating operation runs
  inside a transaction that takes `withCalendarLock` and re-checks conflicts, and maps
  `23P01` on `blocked_times_no_overlap` to `SLOT_UNAVAILABLE`.
- [ ] Implement `CatalogService` with archive guards for services and categories, and
  employee-service assignment replacement guarded against future bookings.
- [ ] Implement `SettingsController` calling `OrganizationContextService.refresh()`
  after a successful update, so the cached settings cannot go stale.
- [ ] Implement `OfficeUsersController` with `OWNER`-only access, the self-protection
  rules, session revocation on archive and on role change, and `canIssueRefunds`
  settable only by `OWNER`.

**Commands.**
```bash
pnpm api test:integration -- test/integration/office-admin.int.spec.ts
```

**Expected successful result.** Every administration case green, including all three
conflict paths that depend on the advisory lock.

**Commit.** `feat(office): add staff, availability, catalog and settings management`

---

### Task 8.5 — Bookings management, manual payments, refunds, exports

**Objective.** The office's write surface over bookings and money, plus the two CSV
exports that are the accounting hand-off.

**Files.**
- `booking-app/packages/contracts/src/office/bookings.ts` (new)
- `booking-app/apps/api/src/office/office-bookings.controller.ts` (new)
- `booking-app/apps/api/src/office/office-bookings.service.ts` (new)
- `booking-app/apps/api/src/office/requests.controller.ts` (new)
- `booking-app/apps/api/src/payment/manual-payment.service.ts` (new)
- `booking-app/apps/api/src/office/customers.controller.ts` (new)
- `booking-app/apps/api/src/office/exports.controller.ts` (new)
- `booking-app/apps/api/src/office/csv.ts` (new)
- `booking-app/apps/api/test/integration/office-bookings.int.spec.ts` (new)

**Produces for later tasks.** The complete office API the web area consumes.

**Database changes.** None.
**API changes.** The remaining `/office` routes from §6.5.
**Frontend changes.** None.

**Tests first.**

```ts
// office-bookings.int.spec.ts (excerpt)
describe('POST /api/office/bookings', () => {
  it('creates a CONFIRMED booking with no payment and no checkout session', async () => {
    const res = await owner.post('/api/office/bookings').set(csrf).set('Idempotency-Key', randomUUID())
      .send(manualBookingBody()).expect(201);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.bookingId } });
    expect(booking).toMatchObject({ status: 'CONFIRMED', origin: 'OFFICE', stripeCheckoutSessionId: null, expiresAt: null });
    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
    expect(fakePayment.sessions()).toHaveLength(0);
    expect(booking.createdByOfficeUserId).toBe(ctx.owner.id);
  });

  it('obeys the same collision rules as an online booking', async () => {
    await owner.post('/api/office/bookings').set(csrf).set('Idempotency-Key', randomUUID()).send(manualBookingBody()).expect(201);
    await owner.post('/api/office/bookings').set(csrf).set('Idempotency-Key', randomUUID()).send(manualBookingBody())
      .expect(409).expect((r) => expect(r.body.code).toBe('SLOT_UNAVAILABLE'));
  });

  it('may ignore the minimum-notice window, which the public route may not', async () => {
    await owner.post('/api/office/bookings').set(csrf).set('Idempotency-Key', randomUUID())
      .send({ ...manualBookingBody(), startsAt: nextGridSlot(2).toISOString() }).expect(201);
  });

  it('replays under the same idempotency key', async () => {
    const key = randomUUID();
    const first = await owner.post('/api/office/bookings').set(csrf).set('Idempotency-Key', key).send(manualBookingBody()).expect(201);
    const second = await owner.post('/api/office/bookings').set(csrf).set('Idempotency-Key', key).send(manualBookingBody()).expect(201);
    expect(second.body).toEqual(first.body);
    expect(await prisma.booking.count()).toBe(1);
  });

  it('queues a confirmation to the customer', async () => {
    const res = await owner.post('/api/office/bookings').set(csrf).set('Idempotency-Key', randomUUID()).send(manualBookingBody()).expect(201);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: res.body.bookingId, eventType: 'booking.confirmed' } })).toBe(1);
  });
});

describe('manual payments', () => {
  it('records a payment with method, actor and timestamp', async () => {
    const booking = await confirmedUnpaidBooking({ startsAt: hoursFromNow(4) });
    await owner.post(`/api/office/bookings/${booking.id}/manual-payments`).set(csrf).set('Idempotency-Key', randomUUID())
      .send({ amountCents: 4500, method: 'CASH', paidAt: new Date().toISOString(), note: 'bar bezahlt' }).expect(201);
    expect(await prisma.manualPayment.findFirstOrThrow({ where: { bookingId: booking.id } }))
      .toMatchObject({ amountCents: 4500, method: 'CASH', recordedByOfficeUserId: ctx.owner.id });
  });

  it('does not double-count under a replayed key', async () => {
    const booking = await confirmedUnpaidBooking({ startsAt: hoursFromNow(4) });
    const key = randomUUID();
    const body = { amountCents: 4500, method: 'CASH' as const, paidAt: new Date().toISOString() };
    await owner.post(`/api/office/bookings/${booking.id}/manual-payments`).set(csrf).set('Idempotency-Key', key).send(body).expect(201);
    await owner.post(`/api/office/bookings/${booking.id}/manual-payments`).set(csrf).set('Idempotency-Key', key).send(body).expect(201);
    expect(await prisma.manualPayment.count({ where: { bookingId: booking.id } })).toBe(1);
  });

  it('accepts a negative correction only with a note', async () => {
    const booking = await confirmedUnpaidBooking({ startsAt: hoursFromNow(4) });
    await owner.post(`/api/office/bookings/${booking.id}/manual-payments`).set(csrf).set('Idempotency-Key', randomUUID())
      .send({ amountCents: -4500, method: 'CASH', paidAt: new Date().toISOString() }).expect(400);
    await owner.post(`/api/office/bookings/${booking.id}/manual-payments`).set(csrf).set('Idempotency-Key', randomUUID())
      .send({ amountCents: -4500, method: 'CASH', paidAt: new Date().toISOString(), note: 'Fehlbuchung korrigiert' }).expect(201);
  });
});

describe('listing, filtering, pagination', () => {
  it('filters by status, employee and date range and sorts deterministically', async () => {
    const res = await owner.get('/api/office/bookings')
      .query({ status: ['CONFIRMED'], employeeId: ctx.employee1.id, from: '2026-08-01', to: '2026-08-31', sort: 'startsAt:asc' })
      .expect(200);
    const times = res.body.items.map((b: { startsAt: string }) => b.startsAt);
    expect(times).toEqual([...times].sort());
    for (const b of res.body.items) expect(b.employeeId).toBe(ctx.employee1.id);
  });

  it('paginates by a stable cursor with no duplicates or gaps', async () => {
    await seedBookings(55);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await owner.get('/api/office/bookings').query({ limit: 10, cursor }).expect(200);
      seen.push(...res.body.items.map((b: { id: string }) => b.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(await prisma.booking.count({ where: { organizationId: ctx.organization.id } }));
  });

  it('rejects a limit above 100 and an unknown sort key', async () => {
    await owner.get('/api/office/bookings').query({ limit: 500 }).expect(400);
    await owner.get('/api/office/bookings').query({ sort: 'priceCentsSnapshot:desc' }).expect(400);
  });

  it('searches by reference, customer last name and email', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(4) });
    for (const q of [booking.reference, 'Becker', 'anna@example.com']) {
      const res = await owner.get('/api/office/bookings').query({ q }).expect(200);
      expect(res.body.items.map((b: { id: string }) => b.id)).toContain(booking.id);
    }
  });
});

describe('CSV export', () => {
  it('streams semicolon-delimited utf-8 with a BOM', async () => {
    const res = await owner.get('/api/office/exports/bookings.csv').query({ from: '2026-08-01', to: '2026-08-31' }).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text.split('\n')[0]).toContain(';');
  });

  it('neutralises a formula-injection attempt in a customer name', async () => {
    await createCustomer({ lastName: '=cmd|calc' });
    const res = await owner.get('/api/office/exports/bookings.csv').query({ from: '2026-08-01', to: '2026-08-31' }).expect(200);
    expect(res.text).toContain("'=cmd|calc");
    expect(res.text).not.toMatch(/;=cmd/);
  });

  it('quotes and escapes embedded delimiters, quotes and newlines', () => {
    expect(toCsvRow(['a;b', 'c"d', 'e\nf'])).toBe('"a;b";"c""d";"e\nf"');
  });

  it('excludes the customer note unless explicitly requested', async () => {
    const res = await owner.get('/api/office/exports/bookings.csv').query({ from: '2026-08-01', to: '2026-08-31' }).expect(200);
    expect(res.text).not.toContain('Erstbesuch');
    const withNotes = await owner.get('/api/office/exports/bookings.csv')
      .query({ from: '2026-08-01', to: '2026-08-31', includeCustomerNote: true }).expect(200);
    expect(withNotes.text).toContain('Erstbesuch');
  });

  it('exports payments, manual payments and refunds as one ledger', async () => {
    const res = await owner.get('/api/office/exports/payments.csv').query({ from: '2026-08-01', to: '2026-08-31' }).expect(200);
    expect(res.text.split('\n')[0]).toContain('kind');
    expect(res.text).toMatch(/STRIPE|MANUAL|REFUND/);
  });
});
```

**Validation scenarios.**
- [ ] A manual booking is `CONFIRMED`, `origin: OFFICE`, with no payment, no session,
  no `expiresAt`, and the creating user recorded.
- [ ] It obeys the same collision rules; it may ignore minimum notice.
- [ ] It replays under a repeated idempotency key and queues one confirmation.
- [ ] A manual payment records amount, method, actor, and timestamp, and does not
  double-count under a replayed key.
- [ ] A negative correction requires a note.
- [ ] Listing filters by status, employee, and range; sorting is deterministic;
  cursor pagination has no duplicates or gaps over 55 rows.
- [ ] `limit > 100` and an unknown sort key are `400`.
- [ ] Search matches reference, customer last name, and email.
- [ ] CSV is `text/csv`, an attachment, semicolon-delimited, UTF-8 with a BOM.
- [ ] A leading `=` in a cell is prefixed with `'`.
- [ ] Delimiters, quotes, and newlines inside cells are quoted and escaped.
- [ ] The customer note is excluded unless explicitly requested.
- [ ] The payments export contains Stripe payments, manual payments, and refunds in
  one ledger with a `kind` column.
- [ ] Refund and cancellation routes reuse the Stage 6 services rather than
  re-implementing any rule.

**Steps.**
- [ ] Implement `office-bookings.service.ts` reusing `ReservationService`'s locking
  helper through a shared `createConfirmedBooking` path so online and office creation
  cannot diverge on collision rules, with a flag that skips the notice check for
  office origin.
- [ ] Implement `ManualPaymentService` guarded by `@Idempotent('manual-payment.create')`,
  requiring a note for a negative amount, and writing an audit row.
- [ ] Wire `POST /office/bookings/:id/refunds` to `RefundService.request` behind
  `@RequiresRefundCapability()`, and the cancellation, completion, no-show, and
  decision routes to the Stage 6 services.
- [ ] Implement cursor pagination as a shared helper: encode
  `{ sort, value, id }`, reject a cursor whose sort/direction differs from the
  request, compare `value` using that direction, and always add `id` as the
  final sort key so the order is total.
- [ ] Implement `csv.ts` with `toCsvRow` (quote when the cell contains `;`, `"`, or a
  newline; double embedded quotes) and `neutralise` (prefix `'` for `=`, `+`, `-`,
  `@`), and stream the export with a `Readable` so a large range does not buffer.
- [ ] Implement `customers.controller.ts` including the pseudonymising erase endpoint
  that refuses while an unsettled payment exists.

**Commands.**
```bash
pnpm api test:integration -- test/integration/office-bookings.int.spec.ts
pnpm api test -- src/office/csv.spec.ts
```

**Expected successful result.** Every office booking and money case green, and the
CSV injection and escaping tests passing.

**Commit.** `feat(office): add booking management, manual payments, refunds and csv exports`
---

## Stage 9 — Public web application

### Task 9.1 — Web skeleton, UI package, and design tokens

**Objective.** A Vue application shell plus a shared UI package whose beige, black,
and orange palette is defined once as CSS custom properties and consumed through
semantic Tailwind names.

**Files.**
- `booking-app/apps/web/package.json` (new)
- `booking-app/apps/web/index.html` (new)
- `booking-app/apps/web/vite.config.ts` (new)
- `booking-app/apps/web/tsconfig.json` (new)
- `booking-app/apps/web/src/main.ts` (new)
- `booking-app/apps/web/src/App.vue` (new)
- `booking-app/apps/web/src/router/index.ts` (new)
- `booking-app/apps/web/src/styles/main.css` (new)
- `booking-app/packages/ui/package.json` (new)
- `booking-app/packages/ui/src/tokens.css` (new)
- `booking-app/packages/ui/src/tailwind-preset.ts` (new)
- `booking-app/packages/ui/src/icons.ts` (new)
- `booking-app/packages/ui/src/components/*.vue` (new)
- `booking-app/packages/ui/src/tokens.spec.ts` (new)

**Produces for later tasks.** `SfButton`, `SfInput`, `SfSelect`, `SfCard`,
`SfBadge`, `SfSpinner`, `SfAlert`, `SfModal`, `SfIcon`, `SfSkeleton`, plus the
token set every later screen styles against.

**Database changes.** None. **API changes.** None.
**Frontend changes.** The application shell and the component library.

**Note on tooling.** The `ui-theme-designer` plugin available in this environment
authors **SAP Fiori** theme parameters (`sapButton_Background` and similar) for UI5
and Fundamental Styles components. It has no relationship to a Tailwind token
system for a Vue application, so it is not used here; the tokens below are authored
directly. Recorded as a deviation in §11.3.

**Tests first.**

```ts
// tokens.spec.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sfPreset } from './tailwind-preset.js';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const declared = new Set([...css.matchAll(/--sf-([a-z0-9-]+):/g)].map((m) => m[1]!));

const SEMANTIC = ['background', 'surface', 'surface-muted', 'text-primary', 'text-secondary',
                  'border', 'primary', 'primary-hover', 'primary-contrast',
                  'success', 'warning', 'danger', 'focus-ring'];

function contrast(a: string, b: string): number { /* WCAG relative luminance ratio */ }

describe('design tokens', () => {
  it('declares every semantic token', () => {
    for (const name of SEMANTIC) expect(declared, name).toContain(name);
  });

  it('maps every semantic token into the tailwind preset', () => {
    const colors = sfPreset.theme!.extend!.colors as Record<string, unknown>;
    for (const name of SEMANTIC) {
      expect(JSON.stringify(colors), name).toContain(`--sf-${name}`);
    }
  });

  it('meets WCAG AA for body text and for buttons', () => {
    expect(contrast(tokenValue('text-primary'), tokenValue('background'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokenValue('text-secondary'), tokenValue('background'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokenValue('primary-contrast'), tokenValue('primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokenValue('text-primary'), tokenValue('surface'))).toBeGreaterThanOrEqual(4.5);
  });

  it('meets WCAG AA large-text contrast for the danger and success surfaces', () => {
    for (const name of ['success', 'warning', 'danger']) {
      expect(contrast(tokenValue('text-primary'), tokenValue(name)), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('uses no raw hex colour outside tokens.css', () => {
    const offenders = grepRepo(/#[0-9a-fA-F]{3,8}\b/, {
      include: ['booking-app/apps/web/src/**/*.{vue,ts,css}', 'booking-app/packages/ui/src/**/*.{vue,ts}'],
    });
    expect(offenders).toEqual([]);
  });
});
```

```ts
// SfButton.spec.ts
describe('SfButton', () => {
  it('renders a visible focus ring class', () => {
    const wrapper = mount(SfButton, { slots: { default: 'Buchen' } });
    expect(wrapper.classes().join(' ')).toMatch(/focus-visible:ring/);
  });
  it('disables and shows a spinner while loading, and sets aria-busy', () => {
    const wrapper = mount(SfButton, { props: { loading: true } });
    expect(wrapper.attributes('disabled')).toBeDefined();
    expect(wrapper.attributes('aria-busy')).toBe('true');
    expect(wrapper.findComponent(SfSpinner).exists()).toBe(true);
  });
  it('does not emit click while loading or disabled', async () => {
    const wrapper = mount(SfButton, { props: { loading: true } });
    await wrapper.trigger('click');
    expect(wrapper.emitted('click')).toBeUndefined();
  });
});
```

**Validation scenarios.**
- [ ] All 13 semantic tokens are declared and mapped into the Tailwind preset.
- [ ] Body text, secondary text, and button label all meet 4.5:1; status surfaces meet
  3:1.
- [ ] No raw hex colour exists outside `tokens.css`.
- [ ] Every interactive component renders a visible `focus-visible` ring.
- [ ] `SfButton` disables, sets `aria-busy`, and swallows clicks while loading.
- [ ] `SfModal` traps focus, closes on `Escape`, and restores focus to the trigger.
- [ ] `SfInput` links its label, its description, and its error through `aria-describedby`
  and sets `aria-invalid`.
- [ ] The Vite build produces a bundle with no external font or script request (Font
  Awesome is self-hosted).

**Steps.**
- [ ] Create the web app with Vue 3, Vite 6, TypeScript, Tailwind 4, Pinia, and
  `vue-router`, extending `@shape-and-flow/booking-config/tsconfig.vue.json`.
- [ ] Write `tokens.css` on `:root`:
  ```css
  :root {
    --sf-background: #F5EFE6;        /* warm beige page */
    --sf-surface: #FFFFFF;
    --sf-surface-muted: #EDE4D6;
    --sf-text-primary: #16130F;      /* near-black */
    --sf-text-secondary: #4A423A;
    --sf-border: #D9CDBA;
    --sf-primary: #C2540A;           /* orange, AA against white text */
    --sf-primary-hover: #A34608;
    --sf-primary-contrast: #FFFFFF;
    --sf-success: #C8E6C9;
    --sf-warning: #FFE0B2;
    --sf-danger: #F5C6C6;
    --sf-focus-ring: #16130F;
    --sf-radius: 0.5rem;
    --sf-shadow-card: 0 1px 2px rgb(22 19 15 / 8%), 0 4px 12px rgb(22 19 15 / 6%);
  }
  ```
- [ ] Write `tailwind-preset.ts` mapping each token to a semantic colour name
  (`colors: { background: 'var(--sf-background)', … }`), so a component never names a
  hue.
- [ ] Self-host the Font Awesome free solid and brands subsets, and expose the curated
  set in `icons.ts` — `calendar`, `clock`, `user`, `scissors`, `check`, `xmark`,
  `spinner`, `triangle-exclamation`, `credit-card`, `whatsapp` — so an arbitrary icon
  cannot be imported and bloat the bundle.
- [ ] Build the ten components, each with an accessibility test as above.
- [ ] Configure Vite: `server.proxy` mapping `/api` to `http://localhost:3000` so
  development is same-origin like production; `build.target: 'es2022'`; manual chunks
  splitting the office area from the public flow.
- [ ] Add the router with `/`, `/booking/*`, `/booking/success`, `/booking/canceled`,
  `/manage`, and a lazily-loaded `/office/*` group.

**Commands.**
```bash
pnpm install
pnpm --filter @shape-and-flow/booking-ui test
pnpm web test
pnpm web build
pnpm web dev
```

**Expected successful result.** Contrast and no-raw-hex tests green, all component
accessibility tests green, and a production build with no external network request.

**Commit.** `feat(web): add application shell and ui package with accessible design tokens`

---

### Task 9.2 — Internationalisation and the typed API client

**Objective.** German and English customer copy with no missing keys, and a fetch
client whose types come from the contracts package.

**Files.**
- `booking-app/apps/web/src/i18n/index.ts` (new)
- `booking-app/apps/web/src/i18n/de.json` (new)
- `booking-app/apps/web/src/i18n/en.json` (new)
- `booking-app/apps/web/src/i18n/i18n.spec.ts` (new)
- `booking-app/apps/web/src/api/client.ts` (new)
- `booking-app/apps/web/src/api/errors.ts` (new)
- `booking-app/apps/web/src/api/client.spec.ts` (new)
- `booking-app/apps/web/src/stores/locale.ts` (new)

**Produces for later tasks.**

```ts
export const api: {
  public: { organization(): Promise<…>; services(): Promise<…>; employeesFor(serviceId): Promise<…>;
            availability(q): Promise<…>; createBooking(body, idempotencyKey): Promise<…>;
            bookingBySession(id): Promise<…> };
  manage: { booking(token): Promise<…>; availability(token, q): Promise<…>;
            cancel(token, body): Promise<…>; requestReschedule(token, body): Promise<…> };
  auth: { login(body); logout(); me(); … };
  office: { … };
};
export class ApiError extends Error { readonly code: ErrorCode; readonly details?: unknown; readonly correlationId?: string }
export function messageForError(code: ErrorCode, t: TranslateFn): string;
```

**Database changes.** None. **API changes.** None.
**Frontend changes.** Locale switching and every network call.

**Tests first.**

```ts
// i18n.spec.ts
import de from './de.json';
import en from './en.json';
import { ErrorCode } from '@shape-and-flow/booking-contracts';

const flatten = (o: object, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? flatten(v as object, `${p}${k}.`) : [`${p}${k}`]);

describe('translations', () => {
  it('have identical key sets', () => {
    expect(flatten(de).sort()).toEqual(flatten(en).sort());
  });
  it('have no empty value', () => {
    for (const [file, name] of [[de, 'de'], [en, 'en']] as const) {
      for (const key of flatten(file)) expect(valueAt(file, key), `${name}:${key}`).not.toBe('');
    }
  });
  it('cover every error code', () => {
    for (const code of ErrorCode.options) {
      expect(flatten(de), code).toContain(`errors.${code}`);
      expect(flatten(en), code).toContain(`errors.${code}`);
    }
  });
  it('include the health-data warning for the customer note in both locales', () => {
    expect(valueAt(de, 'booking.notePrivacyHint')).toMatch(/Gesundheitsdaten/);
    expect(valueAt(en, 'booking.notePrivacyHint')).toMatch(/health/i);
  });
  it('use the same interpolation placeholders in both locales', () => {
    for (const key of flatten(de)) {
      expect(placeholders(valueAt(en, key)), key).toEqual(placeholders(valueAt(de, key)));
    }
  });
  it('is used by every component — no literal German or English sentence in a template', () => {
    expect(grepRepo(/>[A-ZÄÖÜ][a-zäöüß]+ [a-zäöüß]{3,}/, { include: ['booking-app/apps/web/src/pages/public/**/*.vue'] })).toEqual([]);
  });
});
```

```ts
// client.spec.ts
describe('api client', () => {
  it('parses the error envelope into an ApiError with the code', async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ code: 'SLOT_UNAVAILABLE', message: 'x', correlationId: 'c1' }), { status: 409 });
    await expect(api.public.availability({ serviceId: 's', from: 'a', to: 'b' })).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE', correlationId: 'c1',
    });
  });
  it('falls back to INTERNAL_ERROR for a non-json body', async () => {
    fetchMock.mockResponseOnce('<html>502</html>', { status: 502 });
    await expect(api.public.services()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
  it('sends the idempotency key header on createBooking', async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ bookingId: 'b' }), { status: 201 });
    await api.public.createBooking(bookingBody(), 'key-1');
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'Idempotency-Key': 'key-1' });
  });
  it('sends X-Requested-With on every mutating office call and credentials: include', async () => {
    fetchMock.mockResponseOnce('{}', { status: 200 });
    await api.auth.login({ email: 'a@b.c', password: 'x'.repeat(12) });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'X-Requested-With': 'XMLHttpRequest' });
  });
  it('sends the management token as a bearer header, never as a query parameter', async () => {
    fetchMock.mockResponseOnce('{}', { status: 200 });
    await api.manage.booking('tok-1');
    expect(fetchMock.mock.calls[0]![0]).not.toContain('tok-1');
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: 'Bearer tok-1' });
  });
  it('aborts on an AbortSignal and does not surface a network error as ApiError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(api.public.services({ signal: controller.signal })).rejects.toThrow(/abort/i);
  });
  it('maps every error code to a non-empty localised message', () => {
    for (const code of ErrorCode.options) expect(messageForError(code, t)).not.toBe('');
  });
});
```

**Validation scenarios.**
- [ ] German and English have identical key sets and no empty values.
- [ ] Every `ErrorCode` has a translation in both locales.
- [ ] The health-data hint for the customer note exists in both locales.
- [ ] Interpolation placeholders match between locales.
- [ ] No public page template contains a hard-coded sentence.
- [ ] The client turns the error envelope into a typed `ApiError` carrying `code` and
  `correlationId`.
- [ ] A non-JSON error body degrades to `INTERNAL_ERROR`.
- [ ] `Idempotency-Key` is sent on booking creation.
- [ ] Mutating office calls send `X-Requested-With` and `credentials: 'include'`.
- [ ] The management token travels only in the `Authorization` header.
- [ ] Aborts propagate as aborts, not as API errors.

**Steps.**
- [ ] Configure `vue-i18n` in legacy-free composition mode with `de` as the fallback,
  `datetimeFormats` and `numberFormats` for both locales pinned to `Europe/Berlin`
  and EUR.
- [ ] Detect the initial locale from `?lang=`, then `localStorage`, then
  `navigator.languages`, defaulting to `de`; persist the choice; write it into the
  booking payload so notifications follow it.
- [ ] Write both translation files with a nested namespace per surface
  (`common`, `booking`, `manage`, `errors`, `office`), German authored first.
- [ ] Implement the client as one `request()` helper with typed wrappers: JSON
  encode/decode, `credentials: 'include'`, `X-Requested-With` on mutations, envelope
  parsing into `ApiError`, `AbortSignal` support, and a single retry with jittered
  backoff **only** for idempotent `GET`s.
- [ ] Implement `messageForError` keyed by `code`, never by `message`.

**Commands.**
```bash
pnpm web test -- src/i18n src/api
pnpm web typecheck
```

**Expected successful result.** Both suites green; deleting one German key fails the
key-parity test.

**Commit.** `feat(web): add de/en i18n and typed api client with error-code mapping`

---

### Task 9.3 — Booking wizard

**Objective.** The four-step flow customers actually use, with the reservation
countdown visible before they leave for Stripe.

**Files.**
- `booking-app/apps/web/src/stores/booking-draft.ts` (new)
- `booking-app/apps/web/src/pages/public/BookingLayout.vue` (new)
- `booking-app/apps/web/src/pages/public/StepService.vue` (new)
- `booking-app/apps/web/src/pages/public/StepEmployee.vue` (new)
- `booking-app/apps/web/src/pages/public/StepSlot.vue` (new)
- `booking-app/apps/web/src/pages/public/StepDetails.vue` (new)
- `booking-app/apps/web/src/pages/public/RedirectToCheckout.vue` (new)
- `booking-app/apps/web/src/components/SlotPicker.vue` (new)
- `booking-app/apps/web/src/components/ReservationCountdown.vue` (new)
- `booking-app/apps/web/src/stores/booking-draft.spec.ts` (new)
- `booking-app/apps/web/src/components/ReservationCountdown.spec.ts` (new)

**Produces for later tasks.** The flow the end-to-end tests in Task 11.1 drive.

**Database changes.** None. **API changes.** None.
**Frontend changes.** The whole public booking flow.

**Tests first.**

```ts
// booking-draft.spec.ts
describe('booking draft store', () => {
  it('mints one idempotency key per attempt and keeps it across a reload', () => {
    const store = useBookingDraft();
    store.begin();
    const key = store.idempotencyKey;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    store.begin();                        // re-entering the flow must not re-mint
    expect(store.idempotencyKey).toBe(key);
    expect(JSON.parse(sessionStorage.getItem('sf.booking.draft')!).idempotencyKey).toBe(key);
  });
  it('mints a new key only after a completed or reset attempt', () => {
    const store = useBookingDraft();
    store.begin();
    const first = store.idempotencyKey;
    store.reset();
    store.begin();
    expect(store.idempotencyKey).not.toBe(first);
  });
  it('clears the selected slot when the service or employee changes', () => {
    const store = useBookingDraft();
    store.setService('s1'); store.setEmployee('e1'); store.setSlot(new Date());
    store.setService('s2');
    expect(store.slot).toBeNull();
  });
  it('reports which step is reachable', () => {
    const store = useBookingDraft();
    expect(store.canReach('slot')).toBe(false);
    store.setService('s1');
    expect(store.canReach('employee')).toBe(true);
    expect(store.canReach('details')).toBe(false);
  });
  it('never persists the checkout url', () => {
    const store = useBookingDraft();
    store.begin(); store.setCheckoutUrl('https://checkout/x');
    expect(sessionStorage.getItem('sf.booking.draft')).not.toContain('checkout');
  });
});

// ReservationCountdown.spec.ts
describe('ReservationCountdown', () => {
  it('counts down in mm:ss and warns under sixty seconds', async () => {
    vi.setSystemTime(new Date('2026-08-14T06:00:00Z'));
    const wrapper = mount(ReservationCountdown, { props: { expiresAt: new Date('2026-08-14T06:05:00Z') } });
    expect(wrapper.text()).toContain('05:00');
    vi.advanceTimersByTime(4 * 60_000 + 30_000);
    await nextTick();
    expect(wrapper.text()).toContain('00:30');
    expect(wrapper.classes().join(' ')).toMatch(/danger/);
  });
  it('emits expired exactly once at zero and stops the timer', async () => {
    const wrapper = mount(ReservationCountdown, { props: { expiresAt: new Date(Date.now() + 1000) } });
    vi.advanceTimersByTime(5000);
    await nextTick();
    expect(wrapper.emitted('expired')).toHaveLength(1);
  });
  it('is announced to assistive technology politely, not on every tick', () => {
    const wrapper = mount(ReservationCountdown, { props: { expiresAt: new Date(Date.now() + 300_000) } });
    expect(wrapper.attributes('aria-live')).toBe('polite');
    expect(wrapper.find('[aria-live] [aria-hidden="true"]').exists()).toBe(true);
  });
});
```

**Validation scenarios.**
- [ ] One idempotency key per attempt, stable across a reload, re-minted only after
  reset or completion.
- [ ] Changing the service or employee clears the selected slot, so a stale slot
  cannot be submitted.
- [ ] Step reachability is computed, so a deep link to step 3 without a service
  redirects to step 1.
- [ ] The Checkout URL is never written to storage.
- [ ] The countdown renders `mm:ss`, styles the last minute as danger, emits
  `expired` exactly once, and announces politely.
- [ ] "Any available employee" is offered whenever more than one employee performs the
  service, and the resolved employee plus the final price are shown before payment.
- [ ] The slot picker groups by day, shows local Berlin times, and handles an empty
  day with a "next available" link rather than a blank panel.
- [ ] `SLOT_UNAVAILABLE` on submit returns the customer to the slot step with a
  localised message and a refreshed slot list.
- [ ] The customer-note field shows the health-data hint and enforces 500 characters.
- [ ] Every step is keyboard-navigable and each step change moves focus to the step
  heading.
- [ ] A slow submit disables the button and shows a spinner, so a double click cannot
  fire twice.

**Steps.**
- [ ] Implement the Pinia draft store persisted to `sessionStorage` (not
  `localStorage` — a booking draft should not outlive the browser session), with the
  Checkout URL held in memory only.
- [ ] Implement `StepService` with categories, prices, and durations, and a
  `SfSkeleton` loading state.
- [ ] Implement `StepEmployee` offering "Any available employee" first, then each
  employee with photo, bio, and effective price.
- [ ] Implement `StepSlot` with `SlotPicker`: a week strip, per-day slot buttons, a
  Berlin-local heading per day, and a "next available day" affordance.
- [ ] Implement `StepDetails` with first name, last name, email, phone, locale
  confirmation, the note field with its hint, and a summary panel restating service,
  employee, time, and price.
- [ ] On submit, call `createBooking` with the stored key, then render
  `RedirectToCheckout` showing the summary and the countdown for two seconds before
  `window.location.assign(checkoutUrl)`, so the deadline is seen rather than
  discovered.
- [ ] Map every documented error code to a step and a message: `SLOT_UNAVAILABLE` →
  slot step, `OUTSIDE_BOOKING_WINDOW` → slot step,
  `IDEMPOTENCY_KEY_REUSED` → reset the attempt and re-mint a key,
  `RATE_LIMITED` → a retry hint with the `Retry-After` value.
- [ ] Add `useFocusStep` moving focus to the step heading on navigation and setting
  `document.title` per step.

**Commands.**
```bash
pnpm web test -- src/stores src/components
pnpm web dev
```

**Expected successful result.** Store and countdown suites green; the flow completes
against the fake payment provider and lands on Checkout.

**Commit.** `feat(web): add booking wizard with reservation countdown`

---

### Task 9.4 — Confirmation, manage, cancel, and the WhatsApp link

**Objective.** Close the customer loop: a landing page that resolves the payment, a
self-service page for the booking, and one tap to reach the business.

**Files.**
- `booking-app/apps/web/src/pages/public/BookingSuccess.vue` (new)
- `booking-app/apps/web/src/pages/public/BookingCanceled.vue` (new)
- `booking-app/apps/web/src/pages/public/ManageBooking.vue` (new)
- `booking-app/apps/web/src/pages/public/ManageReschedule.vue` (new)
- `booking-app/apps/web/src/components/WhatsAppButton.vue` (new)
- `booking-app/apps/web/src/composables/useManagementToken.ts` (new)
- `booking-app/apps/web/src/composables/useManagementToken.spec.ts` (new)
- `booking-app/apps/web/src/components/WhatsAppButton.spec.ts` (new)

**Produces for later tasks.** The pages the end-to-end suite asserts on.

**Database changes.** None. **API changes.** None.
**Frontend changes.** The post-payment and self-service surfaces.

**Tests first.**

```ts
// useManagementToken.spec.ts
describe('useManagementToken', () => {
  it('reads the token from the fragment and strips it from the address bar', () => {
    window.location.hash = '#abc123';
    const { token } = useManagementToken();
    expect(token.value).toBe('abc123');
    expect(window.location.hash).toBe('');
    expect(replaceStateSpy).toHaveBeenCalled();
  });
  it('keeps the token in memory only', () => {
    window.location.hash = '#abc123';
    useManagementToken();
    expect(localStorage.getItem('sf.manage.token')).toBeNull();
    expect(sessionStorage.getItem('sf.manage.token')).toBeNull();
    expect(document.cookie).not.toContain('abc123');
  });
  it('reports a missing token instead of calling the api', () => {
    window.location.hash = '';
    const { token, missing } = useManagementToken();
    expect(token.value).toBeNull();
    expect(missing.value).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// WhatsAppButton.spec.ts
describe('WhatsAppButton', () => {
  it('builds a wa.me link with a digits-only number and an encoded prefilled text', () => {
    const wrapper = mount(WhatsAppButton, { props: { number: '+49 151 123 456 78', reference: 'SF-7K3QD2' } });
    const href = wrapper.get('a').attributes('href')!;
    expect(href).toBe('https://wa.me/4915112345678?text=' + encodeURIComponent('Buchung SF-7K3QD2: '));
  });
  it('renders nothing when the business configured no number', () => {
    expect(mount(WhatsAppButton, { props: { number: null } }).find('a').exists()).toBe(false);
  });
  it('opens in a new tab with rel=noopener and an accessible label', () => {
    const wrapper = mount(WhatsAppButton, { props: { number: '+4915112345678' } });
    const a = wrapper.get('a');
    expect(a.attributes('target')).toBe('_blank');
    expect(a.attributes('rel')).toContain('noopener');
    expect(a.attributes('aria-label')).toBeTruthy();
  });
});
```

**Validation scenarios.**
- [ ] The management token is read from `location.hash`, moved into memory, and
  stripped from the address bar.
- [ ] The token is never written to `localStorage`, `sessionStorage`, or a cookie.
- [ ] A missing fragment shows a "link expired or incomplete" page and makes no API
  call.
- [ ] The WhatsApp link is `https://wa.me/<digits>?text=<encoded>`, renders nothing
  without a configured number, and opens safely in a new tab.
- [ ] `BookingSuccess` polls `by-session` with backoff for up to 30 seconds, shows a
  "payment is being confirmed" state while `PENDING_PAYMENT`, and shows the reference
  once `CONFIRMED`.
- [ ] If polling times out, the page states that the confirmation email will arrive
  and offers the WhatsApp link — it never claims failure.
- [ ] `BookingCanceled` explains that no charge was made and offers a restart that
  re-mints an idempotency key.
- [ ] `ManageBooking` shows the appointment, the cancellation policy, and the
  consequence of cancelling **before** the confirm button; a fee window shows the
  suggested retained amount.
- [ ] Cancelling outside the window shows the refund amount; inside it shows "request
  submitted".
- [ ] `ManageReschedule` uses the same slot picker and states that the office must
  approve.
- [ ] A `401` from any `/manage` call renders the expired-link page rather than a raw
  error.
- [ ] Both pages are fully usable at a 360-pixel viewport width.

**Steps.**
- [ ] Implement `useManagementToken` reading the fragment, calling
  `history.replaceState`, and exposing `token`, `missing`, and an `authorizedFetch`
  wrapper.
- [ ] Implement `BookingSuccess` with exponential-backoff polling (1 s, 2 s, 3 s, 5 s,
  8 s, capped at 30 s total), three explicit states, and no false failure claim.
- [ ] Implement `ManageBooking` with a confirmation modal that restates the
  consequence, and distinct success states for the immediate and requested outcomes.
- [ ] Implement `ManageReschedule` reusing `SlotPicker` against
  `GET /manage/availability`.
- [ ] Implement `WhatsAppButton` normalising the number to digits and prefilling
  `Buchung <reference>: ` in German or `Booking <reference>: ` in English.
- [ ] Place the WhatsApp button on the landing page, both manage pages, and the
  booking-canceled page.

**Commands.**
```bash
pnpm web test -- src/composables src/components src/pages
pnpm web build
```

**Expected successful result.** Every suite green; the token never appears in
storage, and the success page resolves against the fake provider.

**Commit.** `feat(web): add confirmation, self-service management and whatsapp contact`

---

## Stage 10 — Office web area

### Task 10.1 — Office shell, login, and session handling

**Objective.** A separate, lazily-loaded area with a login that survives a reload
and a session expiry that never loses a form.

**Files.**
- `booking-app/apps/web/src/pages/office/OfficeLayout.vue` (new)
- `booking-app/apps/web/src/pages/office/OfficeLogin.vue` (new)
- `booking-app/apps/web/src/pages/office/OfficeForgotPassword.vue` (new)
- `booking-app/apps/web/src/pages/office/OfficeResetPassword.vue` (new)
- `booking-app/apps/web/src/stores/session.ts` (new)
- `booking-app/apps/web/src/router/office-guard.ts` (new)
- `booking-app/apps/web/src/stores/session.spec.ts` (new)

**Produces for later tasks.** `useSession()` with `role`, `canIssueRefunds`, and
`employeeId`, used by every office screen to hide what the API would refuse.

**Database changes.** None. **API changes.** None.
**Frontend changes.** The office shell and authentication screens.

**Tests first.**

```ts
// session.spec.ts
describe('session store', () => {
  it('rehydrates from /auth/me on first load', async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ id: 'u1', role: 'ADMIN', canIssueRefunds: false }));
    const store = useSession();
    await store.hydrate();
    expect(store.user?.role).toBe('ADMIN');
    expect(store.isAuthenticated).toBe(true);
  });
  it('treats a 401 from /auth/me as anonymous without throwing', async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 });
    const store = useSession();
    await store.hydrate();
    expect(store.isAuthenticated).toBe(false);
  });
  it('exposes capability helpers that match the server matrix', async () => {
    await hydrateAs({ role: 'ADMIN', canIssueRefunds: false });
    const store = useSession();
    expect(store.can('booking.cancel')).toBe(true);
    expect(store.can('refund.issue')).toBe(false);
    expect(store.can('settings.edit')).toBe(false);
    await hydrateAs({ role: 'OWNER', canIssueRefunds: false });
    expect(useSession().can('refund.issue')).toBe(true);
  });
  it('records the attempted route on expiry and returns to it after login', async () => {
    const store = useSession();
    store.markExpired('/office/calendar?date=2026-08-14');
    expect(store.returnTo).toBe('/office/calendar?date=2026-08-14');
  });
  it('clears everything on logout', async () => {
    await hydrateAs({ role: 'OWNER' });
    fetchMock.mockResponseOnce('', { status: 204 });
    await useSession().logout();
    expect(useSession().user).toBeNull();
  });
});
```

**Validation scenarios.**
- [ ] `/auth/me` rehydrates the session on reload; a `401` yields anonymous without an
  error.
- [ ] Capability helpers mirror §10.5 exactly — a unit test enumerates the same matrix
  the API test uses, from one shared fixture, so the two cannot drift.
- [ ] An expired session records the attempted route and returns to it after login.
- [ ] Logout clears the store and redirects to the login page.
- [ ] The router guard redirects an unauthenticated visit to `/office/*` to the login
  page and never flashes the protected screen.
- [ ] Any `401` from any office call triggers one expiry handler, not one per
  in-flight request.
- [ ] The login form shows a single generic error for every failure mode, matching the
  API.
- [ ] The office bundle is a separate chunk not loaded by the public flow.
- [ ] The reset-password screen reads its token from the query string, states the
  12-character minimum, and confirms before submitting.

**Steps.**
- [ ] Implement the session store with `hydrate`, `login`, `logout`, `markExpired`,
  `returnTo`, and `can(capability)` built from one shared capability table exported
  from the contracts package, so the API guard test and this test read the same data.
- [ ] Implement the router guard: `beforeEach` on the `/office` group awaiting a
  single in-flight `hydrate` promise.
- [ ] Add a response interceptor in the API client that, on `401` for an office route,
  calls `markExpired(currentRoute)` once per navigation and redirects.
- [ ] Implement the layout with a sidebar filtered by `can(...)`, the current user, a
  locale-independent English copy set, and a skip-to-content link.
- [ ] Implement the three authentication screens.

**Commands.**
```bash
pnpm web test -- src/stores/session.spec.ts
pnpm web build
```

**Expected successful result.** Session tests green; the office chunk is separate in
the build output; an expired session returns to the attempted route.

**Commit.** `feat(web): add office shell, login and session handling`

---

### Task 10.2 — Office calendar and booking detail

**Objective.** The screen the office works from all day, and the detail view where
every action happens.

**Files.**
- `booking-app/apps/web/src/pages/office/OfficeDashboard.vue` (new)
- `booking-app/apps/web/src/pages/office/OfficeCalendar.vue` (new)
- `booking-app/apps/web/src/pages/office/BookingDetail.vue` (new)
- `booking-app/apps/web/src/pages/office/BookingList.vue` (new)
- `booking-app/apps/web/src/components/office/CalendarGrid.vue` (new)
- `booking-app/apps/web/src/components/office/StatusBadge.vue` (new)
- `booking-app/apps/web/src/components/office/CalendarGrid.spec.ts` (new)
- `booking-app/apps/web/src/components/office/StatusBadge.spec.ts` (new)

**Produces for later tasks.** The screens the end-to-end office journey drives.

**Database changes.** None. **API changes.** None.
**Frontend changes.** Dashboard, calendar, list, and detail.

**Tests first.**

```ts
// StatusBadge.spec.ts
describe('StatusBadge', () => {
  it('renders a label and a colour for every display status', () => {
    for (const status of ALL_DISPLAY_STATUSES) {
      const wrapper = mount(StatusBadge, { props: { status } });
      expect(wrapper.text(), status).not.toBe('');
      expect(wrapper.classes().join(' '), status).toMatch(/bg-(surface-muted|success|warning|danger)/);
    }
  });
  it('does not rely on colour alone', () => {
    for (const status of ALL_DISPLAY_STATUSES) {
      expect(mount(StatusBadge, { props: { status } }).text().trim().length).toBeGreaterThan(1);
    }
  });
});

// CalendarGrid.spec.ts
describe('CalendarGrid', () => {
  it('positions an appointment by its Berlin-local time, not by UTC', () => {
    const wrapper = mount(CalendarGrid, { props: { ...gridProps, bookings: [booking('2026-08-14T07:00:00Z')] } });
    expect(wrapper.get('[data-test=slot]').attributes('data-local-start')).toBe('09:00');
  });
  it('renders buffers distinctly from the appointment itself', () => {
    const wrapper = mount(CalendarGrid, { props: { ...gridProps, bookings: [bookingWithBuffers()] } });
    expect(wrapper.findAll('[data-test=buffer]')).toHaveLength(2);
  });
  it('renders blocked time, time off and closed days as non-clickable', () => {
    const wrapper = mount(CalendarGrid, { props: { ...gridProps, blockedTimes: [block()], timeOff: [off()], closedDays: ['2026-08-15'] } });
    for (const sel of ['[data-test=blocked]', '[data-test=timeoff]', '[data-test=closed]']) {
      expect(wrapper.get(sel).attributes('aria-disabled')).toBe('true');
    }
  });
  it('keeps a column per visible employee and one for a single employee', () => {
    expect(mount(CalendarGrid, { props: { ...gridProps, employees: two() } }).findAll('[data-test=column]')).toHaveLength(2);
  });
  it('is navigable by keyboard between days', async () => {
    const wrapper = mount(CalendarGrid, { props: gridProps });
    await wrapper.get('[data-test=grid]').trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('changeDate')).toBeTruthy();
  });
});
```

**Validation scenarios.**
- [ ] Every `displayStatus` has a label and a colour, and never relies on colour alone.
- [ ] Appointments are positioned by Berlin-local time.
- [ ] Buffers render distinctly from the appointment.
- [ ] Blocked time, time off, and closed days render as non-clickable with
  `aria-disabled`.
- [ ] One column per visible employee.
- [ ] Arrow keys move between days.
- [ ] The dashboard renders every tile from §8.3 including the operations block, and
  each count links to a filtered list.
- [ ] The detail view shows snapshots, status history, payments, manual payments,
  refunds, notification delivery states, and open requests.
- [ ] Every action button is hidden when `can(...)` is false, and each one confirms
  before acting, restating the consequence — refund amount, cancellation reason.
- [ ] A `409` from any action shows a localised message and refreshes the view rather
  than leaving stale data.
- [ ] The list view offers the filters and the cursor pagination from §6.1, and keeps
  filter state in the URL so a view is shareable.
- [ ] The calendar reloads after every mutation, so a rejected conflict is immediately
  visible.

**Steps.**
- [ ] Implement `CalendarGrid` as a CSS-grid day or week view, positioning by
  minutes-from-local-midnight computed once per render, with employees as columns.
- [ ] Implement `StatusBadge` from one exported map of display status to label plus
  token class, and iterate the enum in the test so a new status cannot be forgotten.
- [ ] Implement `OfficeDashboard` with tiles, each linking to a pre-filtered list, and
  an operations panel that is visually quiet when every count is zero.
- [ ] Implement `BookingDetail` with an action bar gated by `can(...)`, a confirmation
  modal per action, and a history timeline.
- [ ] Implement `BookingList` with URL-synchronised filters and a "load more" cursor
  button.
- [ ] Add an optimistic-free mutation pattern: disable, call, refetch — no optimistic
  updates anywhere in the office area, because a `409` is a normal outcome here and a
  rolled-back optimistic update is more confusing than a brief spinner.

**Commands.**
```bash
pnpm web test -- src/components/office
pnpm web dev
```

**Expected successful result.** Component suites green; the calendar renders the
seeded week correctly and every action round-trips.

**Commit.** `feat(web): add office dashboard, calendar, booking list and detail`

---

### Task 10.3 — Office management screens

**Objective.** The remaining configuration surfaces, plus the request queues and the
export buttons.

**Files.**
- `booking-app/apps/web/src/pages/office/EmployeesPage.vue` (new)
- `booking-app/apps/web/src/pages/office/WorkingHoursEditor.vue` (new)
- `booking-app/apps/web/src/pages/office/ServicesPage.vue` (new)
- `booking-app/apps/web/src/pages/office/AvailabilityPage.vue` (new)
- `booking-app/apps/web/src/pages/office/RequestsPage.vue` (new)
- `booking-app/apps/web/src/pages/office/CustomersPage.vue` (new)
- `booking-app/apps/web/src/pages/office/SettingsPage.vue` (new)
- `booking-app/apps/web/src/pages/office/UsersPage.vue` (new)
- `booking-app/apps/web/src/pages/office/ExportsPage.vue` (new)
- `booking-app/apps/web/src/pages/office/WorkingHoursEditor.spec.ts` (new)
- `booking-app/apps/web/src/pages/office/RequestsPage.spec.ts` (new)

**Produces for later tasks.** A complete office area, so Task 11.1 can drive a full
journey.

**Database changes.** None. **API changes.** None.
**Frontend changes.** All remaining office screens.

**Tests first.**

```ts
// WorkingHoursEditor.spec.ts
describe('WorkingHoursEditor', () => {
  it('edits in local time and submits minutes from midnight', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [] } });
    await addSegment(wrapper, { weekday: 'MONDAY', start: '09:00', end: '18:00' });
    await wrapper.get('[data-test=save]').trigger('click');
    expect(wrapper.emitted('save')![0]![0]).toMatchObject({
      segments: [{ weekday: 'MONDAY', startMinute: 540, endMinute: 1080, breaks: [] }],
    });
  });
  it('flags an overlap before submitting, so the server round trip is not the first feedback', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [seg('MONDAY', 540, 720)] } });
    await addSegment(wrapper, { weekday: 'MONDAY', start: '11:00', end: '14:00' });
    expect(wrapper.text()).toMatch(/overlap/i);
    expect(wrapper.get('[data-test=save]').attributes('disabled')).toBeDefined();
  });
  it('flags a break outside its segment and an end before its start', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [seg('MONDAY', 540, 720)] } });
    await addBreak(wrapper, 0, { start: '13:00', end: '13:30' });
    expect(wrapper.text()).toMatch(/within/i);
  });
  it('renders the conflicting bookings the server reports after a save', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [], conflicts: [conflict()] } });
    expect(wrapper.get('[data-test=conflicts]').text()).toContain('SF-');
  });
  it('supports 24:00 as the end of a segment', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [] } });
    await addSegment(wrapper, { weekday: 'FRIDAY', start: '20:00', end: '24:00' });
    expect(wrapper.emittedSegments()[0]!.endMinute).toBe(1440);
  });
});

// RequestsPage.spec.ts
describe('RequestsPage', () => {
  it('shows the suggested retained amount and lets the decider override it', async () => {
    const wrapper = await mountWithRequest({ paidCents: 4500, suggestedRetainedAmountCents: 2250 });
    expect(wrapper.text()).toContain('22,50');
    await wrapper.get('[data-test=retained]').setValue('10.00');
    await wrapper.get('[data-test=approve]').trigger('click');
    expect(lastCall().body).toMatchObject({ decision: 'APPROVED', retainedAmountCents: 1000 });
  });
  it('states the resulting refund amount before the decider confirms', async () => {
    const wrapper = await mountWithRequest({ paidCents: 4500, suggestedRetainedAmountCents: 2250 });
    expect(wrapper.get('[data-test=refund-preview]').text()).toContain('22,50');
  });
  it('hides the retained-amount field when the user lacks the refund capability', async () => {
    const wrapper = await mountWithRequest({}, { role: 'ADMIN', canIssueRefunds: false });
    expect(wrapper.find('[data-test=retained]').exists()).toBe(false);
  });
  it('rejects a retained amount above the paid amount client-side', async () => {
    const wrapper = await mountWithRequest({ paidCents: 4500 });
    await wrapper.get('[data-test=retained]').setValue('50.00');
    expect(wrapper.get('[data-test=approve]').attributes('disabled')).toBeDefined();
  });
  it('shows an approved reschedule as the new appointment time', async () => {
    const wrapper = await mountWithRescheduleRequest();
    await wrapper.get('[data-test=approve]').trigger('click');
    expect(wrapper.text()).toMatch(/14\.08\.2026/);
  });
});
```

**Validation scenarios.**
- [ ] The working-hours editor edits in local time, submits minutes from midnight, and
  supports `24:00` as `1440`.
- [ ] Overlaps, out-of-segment breaks, and inverted ranges are flagged client-side and
  disable saving.
- [ ] Server-reported booking conflicts are rendered after a save.
- [ ] Requests pages show the frozen suggestion, allow an override, and preview the
  resulting refund before confirmation.
- [ ] The retained-amount field is hidden without the refund capability.
- [ ] A retained amount above what was paid disables approval client-side, matching
  the server rule.
- [ ] Services, employees, categories, exceptions, time off, blocked times, closed
  days, customers, users, and settings each have full create, edit, and archive
  screens.
- [ ] Archive refusals (`409 EMPLOYEE_HAS_FUTURE_BOOKINGS`) are shown with the count
  and a link to the affected bookings.
- [ ] Settings validation mirrors the server bounds so an invalid value is caught
  before submitting.
- [ ] Exports trigger a real download with the correct filename and a date-range
  picker.
- [ ] Every screen is usable at 1024 pixels wide and every form is keyboard-complete.

**Steps.**
- [ ] Implement each screen against the Stage 8 contracts, using the shared
  `SfInput`/`SfSelect`/`SfModal` components.
- [ ] Reuse one `useCrudResource` composable for list, create, patch, and archive so
  the eight management screens do not each invent their own state machine.
- [ ] Mirror every server-side bound in the client form schema by importing the same
  Zod schema from the contracts package — not by re-typing the numbers.
- [ ] Implement `ExportsPage` with a range picker, triggering the download through a
  hidden anchor so the browser handles the streamed response.
- [ ] Show the operations panel counts on the settings page as well, with links to the
  affected records, so an operator does not need the dashboard to notice a stuck
  outbox.

**Commands.**
```bash
pnpm web test -- src/pages/office
pnpm web typecheck
pnpm web build
```

**Expected successful result.** Every office screen suite green, the bundle builds,
and the full journey — log in, create a manual booking, record a payment, decide a
request, export CSV — works against the seeded database.

**Commit.** `feat(web): add office management screens, request queues and exports`
---

## Stage 11 — Hardening and delivery

### Task 11.1 — End-to-end suite

**Objective.** Prove the journeys a real customer and a real office user take, in a
real browser, against a real database and real queues, with the payment provider
faked.

**Files.**
- `booking-app/apps/web/playwright.config.ts` (new)
- `booking-app/apps/web/e2e/fixtures/stack.ts` (new)
- `booking-app/apps/web/e2e/customer-booking.spec.ts` (new)
- `booking-app/apps/web/e2e/customer-expiry.spec.ts` (new)
- `booking-app/apps/web/e2e/customer-manage.spec.ts` (new)
- `booking-app/apps/web/e2e/office-journey.spec.ts` (new)
- `booking-app/apps/web/e2e/accessibility.spec.ts` (new)
- `booking-app/apps/api/src/test-support/test-support.controller.ts` (new)

**Produces for later tasks.** The regression net every later change runs against.

**Database changes.** None.
**API changes.** A `/api/test-support/*` router mounted **only** when
`ENABLE_TEST_SUPPORT=true`, which the environment schema forbids while
`NODE_ENV=production`. It exposes exactly four operations: reset and reseed the
database, mark a fake Checkout Session paid, deliver a synthetic Stripe webhook,
and read the fake email and SMS outboxes.
**Frontend changes.** `data-test` attributes on the elements the suite drives.

**Tests first.** These *are* the tests.

```ts
// customer-booking.spec.ts
import { expect, test } from '@playwright/test';
import { resetStack, markSessionPaid, deliverWebhook, emails } from './fixtures/stack.js';

test.beforeEach(resetStack);

test('a customer books, pays and is confirmed in German', async ({ page }) => {
  await page.goto('/?lang=de');
  await page.getByTestId('service-card').filter({ hasText: 'Facial Massage 30 min' }).click();
  await page.getByTestId('employee-any').click();
  await page.getByTestId('day-tab').first().click();
  const slot = page.getByTestId('slot').first();
  const slotLabel = (await slot.textContent())!.trim();
  await slot.click();

  await page.getByTestId('first-name').fill('Anna');
  await page.getByTestId('last-name').fill('Becker');
  await page.getByTestId('email').fill('anna@example.com');
  await page.getByTestId('phone').fill('+4915112345678');
  await expect(page.getByTestId('note-privacy-hint')).toContainText('Gesundheitsdaten');
  await expect(page.getByTestId('summary-price')).toContainText('45,00');
  await expect(page.getByTestId('summary-employee')).not.toBeEmpty();   // "any" is resolved before payment
  await page.getByTestId('submit').click();

  await expect(page.getByTestId('countdown')).toContainText(/0[45]:\d\d/);
  const sessionId = await page.getByTestId('checkout-session-id').textContent();

  await markSessionPaid(sessionId!);
  await deliverWebhook('checkout.session.completed', sessionId!);
  await page.goto(`/booking/success?session_id=${sessionId}`);

  await expect(page.getByTestId('reference')).toHaveText(/^SF-[0-9A-HJKMNP-TV-Z]{6}$/);
  await expect(page.getByTestId('confirmed-slot')).toContainText(slotLabel);
  await expect(page.getByTestId('whatsapp-link')).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+/);

  const sent = await emails();
  expect(sent.map((e) => e.to)).toContain('anna@example.com');
  expect(sent.find((e) => e.to === 'anna@example.com')!.text).toContain('/manage#');
});

test('the slot disappears for a second customer while the first is paying', async ({ page, browser }) => {
  const slotLabel = await reserveFirstSlot(page);
  const second = await browser.newPage();
  await second.goto('/?lang=de');
  await selectServiceAndDay(second);
  await expect(second.getByTestId('slot').filter({ hasText: slotLabel })).toHaveCount(0);
});

test('an English visitor sees English copy and receives an English email', async ({ page }) => {
  await completeBooking(page, { lang: 'en' });
  expect((await emails())[0]!.subject).toMatch(/booking/i);
});
```

```ts
// customer-expiry.spec.ts
test('an abandoned checkout releases the slot only after the session is expired', async ({ page }) => {
  const { slotLabel, sessionId } = await reserveAndAbandon(page);
  await expireReservationNow(sessionId);                 // phase 1 only
  await selectServiceAndDay(page);
  await expect(page.getByTestId('slot').filter({ hasText: slotLabel })).toHaveCount(0);   // still blocked
  await runExpiryJob(sessionId);                         // phase 2
  await page.reload();
  await selectServiceAndDay(page);
  await expect(page.getByTestId('slot').filter({ hasText: slotLabel })).toHaveCount(1);   // released
});

test('paying just after the deadline keeps the appointment instead of losing it', async ({ page }) => {
  const { sessionId } = await reserveAndAbandon(page);
  await expireReservationNow(sessionId);
  await markSessionPaid(sessionId);
  await runExpiryJob(sessionId);
  await page.goto(`/booking/success?session_id=${sessionId}`);
  await expect(page.getByTestId('reference')).toBeVisible();
});
```

```ts
// customer-manage.spec.ts
test('a customer cancels outside the fee window and is told the refund amount', async ({ page }) => {
  const { manageUrl } = await confirmedBookingInDays(5);
  await page.goto(manageUrl);
  await expect(page).toHaveURL(/\/manage$/);                     // the fragment is stripped
  await expect(page.getByTestId('policy-free-until')).toBeVisible();
  await page.getByTestId('cancel').click();
  await expect(page.getByTestId('confirm-consequence')).toContainText('45,00');
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('cancel-outcome')).toContainText('45,00');
});

test('a customer inside the window gets a request, not a cancellation', async ({ page }) => {
  await setFeePolicy({ policy: 'PERCENTAGE', percent: 50 });
  const { manageUrl } = await confirmedBookingInHours(48);
  await page.goto(manageUrl);
  await page.getByTestId('cancel').click();
  await expect(page.getByTestId('confirm-consequence')).toContainText('22,50');
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('request-submitted')).toBeVisible();
});

test('an expired management link shows a friendly page, not an error', async ({ page }) => {
  await page.goto('/manage#definitely-not-a-token');
  await expect(page.getByTestId('link-expired')).toBeVisible();
});
```

```ts
// office-journey.spec.ts
test('the office runs a full day', async ({ page }) => {
  await login(page, 'owner');
  await expect(page.getByTestId('tile-today')).toBeVisible();

  await page.getByTestId('nav-calendar').click();
  await page.getByTestId('new-booking').click();
  await fillManualBooking(page);
  await expect(page.getByTestId('booking-status')).toHaveText('CONFIRMED');

  await page.getByTestId('record-payment').click();
  await page.getByTestId('amount').fill('45,00');
  await page.getByTestId('method').selectOption('CASH');
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('paid-total')).toContainText('45,00');

  await page.getByTestId('nav-requests').click();
  await page.getByTestId('approve').first().click();
  await page.getByTestId('retained').fill('10,00');
  await expect(page.getByTestId('refund-preview')).toContainText('35,00');
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('request-decided')).toBeVisible();

  await page.getByTestId('nav-availability').click();
  await addBlockedTime(page);
  await expect(page.getByTestId('blocked-time-row')).toHaveCount(1);

  await page.getByTestId('nav-exports').click();
  const download = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-bookings').click()]);
  expect((await download[0].suggestedFilename())).toMatch(/bookings.*\.csv$/);
});

test('an employee sees only their own calendar and cannot reach settings', async ({ page }) => {
  await login(page, 'employee');
  await expect(page.getByTestId('nav-settings')).toHaveCount(0);
  await page.goto('/office/settings');
  await expect(page.getByTestId('forbidden')).toBeVisible();
});

test('a double-clicked submit creates one booking', async ({ page }) => {
  await login(page, 'owner');
  await startManualBooking(page);
  await page.getByTestId('confirm').dblclick();
  await expect(page.getByTestId('booking-row')).toHaveCount(1);
});
```

```ts
// accessibility.spec.ts — axe-core over every route
const ROUTES = ['/', '/booking/service', '/booking/slot', '/booking/details', '/booking/success',
                '/manage', '/office/login', '/office/dashboard', '/office/calendar', '/office/settings'];

for (const route of ROUTES) {
  test(`${route} has no serious or critical accessibility violation`, async ({ page }) => {
    await prepareRoute(page, route);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
    expect(serious.map((v) => `${v.id} @ ${v.nodes[0]?.target}`)).toEqual([]);
  });
}

test('the booking flow is completable with the keyboard alone', async ({ page }) => {
  await page.goto('/?lang=de');
  await completeBookingByKeyboard(page);
  await expect(page.getByTestId('countdown')).toBeVisible();
});
```

**Validation scenarios.**
- [ ] A German customer books, pays, and sees a reference; the confirmation email
  contains a `/manage#` link.
- [ ] The reserved slot vanishes for a second visitor while the first is paying.
- [ ] An English visitor gets English copy and an English email.
- [ ] An abandoned checkout keeps the slot blocked after phase 1 and releases it only
  after phase 2.
- [ ] Paying just after the deadline keeps the appointment.
- [ ] Cancelling outside the window states the refund; inside it, a request is
  submitted and the amount shown matches the suggestion.
- [ ] An invalid management token shows a friendly page.
- [ ] The office completes a full day: manual booking, manual payment, request
  decision with an overridden retained amount, blocked time, CSV export.
- [ ] An `EMPLOYEE` cannot see or reach settings.
- [ ] A double-clicked submit creates one booking.
- [ ] Ten routes have no serious or critical axe violation.
- [ ] The booking flow is completable by keyboard alone.
- [ ] `ENABLE_TEST_SUPPORT=true` with `NODE_ENV=production` refuses to start.

**Steps.**
- [ ] Write `test-support.controller.ts` behind an explicit module that
  `AppModule` imports only when `ENABLE_TEST_SUPPORT` is true, with a schema
  `superRefine` making that combination invalid in production, plus a bootstrap log
  line at `warn` naming that the test router is mounted.
- [ ] Configure Playwright: `webServer` entries starting the API, the worker, and the
  Vite preview server; `baseURL` pointing at the preview server so the proxy makes it
  same-origin; `trace: 'retain-on-failure'`; `projects` for desktop Chromium and a
  360-pixel mobile viewport.
- [ ] Write `fixtures/stack.ts` wrapping the test-support endpoints, plus helpers that
  wait for the worker to drain rather than sleeping.
- [ ] Add `data-test` attributes to exactly the elements the suite drives — no
  selector in the suite depends on a class name or on copy that i18n can change,
  except where the assertion is about the copy.
- [ ] Add `@axe-core/playwright` and the accessibility suite.
- [ ] Wire the `e2e` CI job to upload traces and the report on failure.

**Commands.**
```bash
pnpm test:infra:up
pnpm api prisma:migrate:deploy
pnpm build
pnpm web exec playwright install --with-deps chromium
pnpm test:e2e
```

**Expected successful result.** Every end-to-end and accessibility test green in
both viewports; the whole suite under five minutes.

**Commit.** `test(e2e): add customer and office journeys with accessibility checks`

---

### Task 11.2 — Observability, health, and graceful shutdown

**Objective.** Make a production incident diagnosable from the logs and visible in
the office before a customer reports it.

**Files.**
- `booking-app/apps/api/src/health/health.module.ts` (edit)
- `booking-app/apps/api/src/health/queue.indicator.ts` (new)
- `booking-app/apps/api/src/health/migration.indicator.ts` (new)
- `booking-app/apps/api/src/health/operations.service.ts` (new)
- `booking-app/apps/api/src/common/logging/request-log.interceptor.ts` (new)
- `booking-app/apps/api/src/common/shutdown/shutdown.service.ts` (new)
- `booking-app/apps/api/test/integration/health.int.spec.ts` (new)

**Produces for later tasks.** `GET /api/health/live|ready|detail` and the operations
counters the dashboard reads.

**Database changes.** None.
**API changes.** The three health routes from §6.7.
**Frontend changes.** None (the panel already consumes the counters).

**Tests first.**

```ts
// health.int.spec.ts (excerpt)
describe('health', () => {
  it('live is dependency-free and stays 200 when the database is unreachable', async () => {
    await withDatabaseDown(async () => {
      await request(app).get('/api/health/live').expect(200);
    });
  });

  it('ready reports 503 with the failing indicator named when redis is down', async () => {
    await withRedisDown(async () => {
      const res = await request(app).get('/api/health/ready').expect(503);
      expect(res.body.details.redis.status).toBe('down');
      expect(res.body.details.database.status).toBe('up');
    });
  });

  it('ready fails when a shipped migration is not applied', async () => {
    const migrationName = '%calendar_constraints';
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM _prisma_migrations WHERE migration_name LIKE ${migrationName}`,
    );
    const res = await request(app).get('/api/health/ready').expect(503);
    expect(res.body.details.migrations.status).toBe('down');
    expect(res.body.details.migrations.pending).toContain('calendar_constraints');
  });

  it('detail requires an authenticated owner or admin', async () => {
    await request(app).get('/api/health/detail').expect(401);
    const employee = await agentFor('EMPLOYEE');
    await employee.get('/api/health/detail').expect(403);
    const owner = await agentFor('OWNER');
    await owner.get('/api/health/detail').expect(200);
  });

  it('detail reports every operational counter', async () => {
    const owner = await agentFor('OWNER');
    const res = await owner.get('/api/health/detail').expect(200);
    expect(res.body).toMatchObject({
      queues: expect.any(Object), failedJobs: expect.any(Number),
      stuckOutboxRows: expect.any(Number), unprocessedWebhooks: expect.any(Number),
      pendingNotifications: expect.any(Number), oldestExpiringBookingAgeSeconds: expect.any(Number),
    });
  });

  it('surfaces a genuinely stuck outbox row', async () => {
    await makeStuckOutboxRow();
    const owner = await agentFor('OWNER');
    expect((await owner.get('/api/health/detail').expect(200)).body.stuckOutboxRows).toBe(1);
  });

  it('logs one line per request with method, path, status, duration and correlation id, and no PII', async () => {
    const lines = await captureLogs(() =>
      request(app).post('/api/public/bookings').set('Idempotency-Key', randomUUID()).send(bookingBody()));
    const entry = JSON.parse(lines.find((l) => l.includes('"req"'))!);
    expect(entry).toMatchObject({ method: 'POST', url: '/api/public/bookings', statusCode: 201 });
    expect(entry.responseTimeMs).toBeTypeOf('number');
    expect(entry.correlationId).toBeTypeOf('string');
    expect(JSON.stringify(entry)).not.toContain('anna@example.com');
  });

  it('propagates one correlation id from request to job to log', async () => {
    const res = await request(app).post('/api/public/bookings').set('X-Request-Id', 'test-corr-1')
      .set('Idempotency-Key', randomUUID()).send(bookingBody()).expect(201);
    expect(res.headers['x-request-id']).toBe('test-corr-1');
    const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: res.body.bookingId } });
    expect((outbox.payload as { correlationId?: string }).correlationId).toBe('test-corr-1');
  });

  it('stops accepting connections but finishes in-flight requests on SIGTERM', async () => {
    const { completed, refusedAfter } = await sigtermDuringRequest();
    expect(completed).toBe(true);
    expect(refusedAfter).toBe(true);
  });
});
```

**Validation scenarios.**
- [ ] `live` has no dependency checks and stays `200` with the database down.
- [ ] `ready` is `503` and names the failing indicator for the database, Redis, and
  unapplied migrations independently.
- [ ] `detail` is `401` anonymous, `403` for `EMPLOYEE`, `200` for `OWNER`/`ADMIN`.
- [ ] `detail` reports queue depths, failed jobs, stuck outbox rows, unprocessed
  webhooks, pending notifications, and the oldest `EXPIRING` age.
- [ ] A genuinely stuck outbox row appears in the count.
- [ ] One structured log line per request with method, path, status, duration, and
  correlation id, and no personal data.
- [ ] One correlation id flows request → outbox payload → job → worker log, and is
  echoed in `X-Request-Id`.
- [ ] `SIGTERM` finishes in-flight requests and refuses new connections.

**Steps.**
- [ ] Add the three Terminus indicators: `PrismaHealthIndicator` (`SELECT 1` with a
  2-second timeout), `RedisHealthIndicator` (`PING`), and `MigrationIndicator`
  comparing the shipped migration directory names against `_prisma_migrations`.
- [ ] Implement `OperationsService` collecting every counter with a 10-second
  in-process cache, so a dashboard poll cannot become a load source.
- [ ] Implement `RequestLogInterceptor` emitting one line per request at `info`
  (`warn` for 4xx, `error` for 5xx) with the duration measured with `performance.now`.
- [ ] Propagate the correlation id into every outbox payload, and restore it in the
  worker with `runWithCorrelation`.
- [ ] Implement `ShutdownService` on `beforeApplicationShutdown`: stop the HTTP
  listener, wait for in-flight requests up to 25 seconds, close BullMQ workers, close
  Redis, then Prisma — logging each stage so a hung shutdown is diagnosable.
- [ ] Add `LOG_LEVEL` and a `LOG_SAMPLE_RATE` for `GET /public/availability`, the one
  endpoint that can dominate log volume.

**Commands.**
```bash
pnpm api test:integration -- test/integration/health.int.spec.ts
curl -fsS http://localhost:3000/api/health/ready | jq
```

**Expected successful result.** Every health case green, including the
missing-migration detection and the end-to-end correlation-id propagation.

**Commit.** `feat(ops): add health indicators, request logging, correlation and graceful shutdown`

---

### Task 11.3 — Deployment, backup, and documentation

**Objective.** A deployment a single operator can run, restore, and understand.

**Files.**
- `booking-app/apps/web/Dockerfile` (new)
- `booking-app/docker-compose.prod.yml` (new)
- `booking-app/infrastructure/nginx/booking.conf` (new)
- `booking-app/infrastructure/scripts/backup.sh` (new)
- `booking-app/infrastructure/scripts/restore.sh` (new)
- `booking-app/docs/operations.md` (new)
- `README.md` (edit)
- `.github/workflows/ci.yml` (edit)

**Produces for later tasks.** Nothing — this is the last task.

**Database changes.** None (migrations run as a deployment step).
**API changes.** None. **Frontend changes.** None.

**Tests first.** The verification here is executable rather than unit-testable: a
full stack brought up from the compose file, migrated, seeded, and exercised, then a
backup taken, the volume destroyed, and the backup restored.

**Validation scenarios.**
- [ ] `docker compose -f booking-app/docker-compose.prod.yml up -d --wait` brings up
  five healthy containers: postgres, redis, api, worker, web.
- [ ] The `migrate` step runs as a one-shot container that must exit 0 before `api`
  and `worker` start, so no process ever runs against an unmigrated database.
- [ ] The migration container's database user has `CREATE EXTENSION` rights (needed for
  `btree_gist` on first deploy); a documented pre-step grants it.
- [ ] All four calendar constraints exist after `migrate deploy` — the Task 1.3
  constraint-inventory test is run against the deployed database as a post-deploy gate.
- [ ] `GET /api/health/ready` is `200` from the host through nginx.
- [ ] The SPA is served at `/`, the API at `/api`, same origin, so `SameSite=Lax`
  holds.
- [ ] `POST /api/webhooks/stripe` reaches the API with the raw body intact through
  nginx (`proxy_request_buffering off` is **not** used; the body must arrive whole).
- [ ] `backup.sh` produces a compressed, timestamped `pg_dump` and verifies it with
  `pg_restore --list`.
- [ ] `restore.sh` restores into an empty database and the constraint-inventory check
  passes afterwards.
- [ ] Both API images run as a non-root user and contain no development dependencies.
- [ ] `NODE_ENV=production` with any `fake` provider, or with `ENABLE_TEST_SUPPORT=true`,
  refuses to start.
- [ ] The web image serves pre-compressed assets with long cache headers for hashed
  files and `no-store` for `index.html`.
- [ ] `docs/operations.md` covers every runbook listed below.

**Steps.**
- [ ] Write the web `Dockerfile`: a build stage running `pnpm build`, then an nginx
  stage copying `dist` with a config that falls back to `index.html` for SPA routes,
  sets long `Cache-Control` for hashed assets and `no-store` for `index.html`, and
  gzips.
- [ ] Write `docker-compose.prod.yml` with `postgres`, `redis`, a one-shot `migrate`
  service, `api`, `worker`, and `web`; `depends_on` with
  `condition: service_completed_successfully` on `migrate`; healthchecks hitting
  `/api/health/ready` for `api`; `restart: unless-stopped`; every secret from an env
  file, never inline.
- [ ] Write `infrastructure/nginx/booking.conf`: `/api` to the API container, `/` to
  the web container, `X-Request-Id` passthrough, `X-Forwarded-For`/`-Proto` set,
  `client_max_body_size 1m`, and a comment stating that request buffering must stay on
  so Stripe's raw body arrives intact.
- [ ] Write `backup.sh`: `pg_dump -Fc` to a timestamped file, `pg_restore --list` as a
  verification step, retention pruning, and a non-zero exit on any failure.
- [ ] Write `restore.sh`: refuse to run against a non-empty database without an
  explicit `--force`, restore, then run the constraint-inventory query and fail loudly
  if any constraint is missing.
- [ ] Write `docs/operations.md` with these runbooks:
  - [ ] first deployment, including the `CREATE EXTENSION` grant
  - [ ] routine deployment and rollback (image tag plus `migrate deploy` forward-only
    policy, and what to do when a migration must be reverted)
  - [ ] rotating `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` with no downtime
  - [ ] backup schedule, verification, and a restore drill
  - [ ] "a customer paid but has no booking" — how to find the Stripe event, the inbox
    row, and re-drive it
  - [ ] "bookings are stuck in EXPIRING" — how to read the reconciler counters and
    re-drive the saga
  - [ ] "the outbox is growing" — how to identify the poisoned event and replay it
  - [ ] "confirmation emails are not arriving" — how to read notification delivery
    states and the provider webhooks
  - [ ] "Redis was lost" — expected consequences and the reconcilers that repair them
  - [ ] adding an employee, a service, and a closed day
  - [ ] a subject-access or erasure request, end to end
- [ ] Update the root `README.md` with a five-command local start, the architecture
  diagram from §2.1, the workspace layout, and a link to
  `booking-app/docs/plans/phase-1-implementation-plan.md` and
  `booking-app/docs/operations.md`.
- [ ] Extend CI with a `deploy-check` job that builds all three images, brings up the
  production compose file against ephemeral volumes, runs `migrate deploy`, runs the
  constraint-inventory test, and curls `/api/health/ready`.

**Commands.**
```bash
docker build -f booking-app/apps/api/Dockerfile --target api    -t sf-booking-api    .
docker build -f booking-app/apps/api/Dockerfile --target worker -t sf-booking-worker .
docker build -f booking-app/apps/web/Dockerfile                 -t sf-booking-web    .
docker compose -f booking-app/docker-compose.prod.yml up -d --wait
curl -fsS http://localhost/api/health/ready | jq
booking-app/infrastructure/scripts/backup.sh
docker compose -f booking-app/docker-compose.prod.yml down -v
docker compose -f booking-app/docker-compose.prod.yml up -d --wait
booking-app/infrastructure/scripts/restore.sh ./backups/<timestamp>.dump --force
docker exec sf-booking-postgres psql -U booking -d booking \
  -c "SELECT conname FROM pg_constraint WHERE conname LIKE '%no_overlap';"
```

**Expected successful result.** Five healthy containers, `ready` returning `200`
through nginx, a verified backup, a successful restore, and both exclusion
constraints present afterwards.

**Commit.** `chore(deploy): add production compose, nginx, backup/restore and operations runbooks`
---

# Requirement-to-task traceability

Every requirement maps to at least one task; every task appears at least once.

## Public booking and payment

| # | Requirement | Tasks |
| --- | --- | --- |
| R1 | Public visitors see the business, its services, prices, and durations | 5.1, 9.1, 9.3 |
| R2 | Public visitors see which employees perform a service, with the effective price | 5.1, 9.3 |
| R3 | Real bookable slots from working hours, breaks, time off, exceptions, blocked time, closed days | 2.3, 5.1 |
| R4 | Service prep and cleanup buffers occupy the employee but are invisible to the customer | 2.3, 5.2, 10.2 |
| R5 | Configurable scheduling interval, booking horizon, and minimum notice | 2.3, 5.1, 8.4 |
| R6 | "Any available employee" resolved server-side, deterministically, before insert | 2.4, 5.2 |
| R7 | Selected employee and final price shown before payment | 5.3, 9.3 |
| R8 | Slot held for a configurable window while the customer pays | 5.2, 5.3, 8.4 |
| R9 | Payment through Stripe hosted Checkout, card and wallets only | 3.3, 5.3 |
| R10 | Booking confirmed only on a verified payment webhook | 5.4 |
| R11 | Unpaid reservations expire and the slot returns — never before Stripe confirms | 5.5 |
| R12 | Paying just after the deadline keeps the appointment, with no refund churn | 5.5, 11.1 |
| R13 | Double-booking impossible under concurrency | 1.3, 5.2 |
| R14 | Retrying a submit never creates a second booking or a second Checkout URL | 4.4, 5.3 |
| R15 | Reservation deadline visible to the customer before leaving for Stripe | 9.3 |
| R16 | Post-payment landing page resolves the booking and shows the reference | 5.3, 9.4 |

## Customer self-service

| # | Requirement | Tasks |
| --- | --- | --- |
| R17 | Customer manages one booking with no account, via an emailed link | 6.1, 9.4 |
| R18 | The access token cannot leak through logs, referrers, or analytics | 6.1, 9.4 |
| R19 | Free cancellation outside a configurable window, with an automatic full refund | 6.2, 6.3 |
| R20 | Inside the window, an office decision with a configurable suggested fee | 2.4, 6.2, 10.3 |
| R21 | Customer may request a reschedule; the office approves | 6.4, 9.4, 10.3 |
| R22 | The customer is told the consequence before confirming any action | 9.4, 11.1 |
| R23 | One-tap WhatsApp contact with the business | 9.4 |

## Office operations

| # | Requirement | Tasks |
| --- | --- | --- |
| R24 | `OWNER`, `ADMIN`, `EMPLOYEE` roles with distinct capabilities | 8.1, 8.2 |
| R25 | A refund capability independent of the role | 8.2, 8.5 |
| R26 | Dashboard: today, next seven days, open requests, unpaid bookings, revenue, operations health | 8.3, 10.2, 11.2 |
| R27 | Calendar across employees with bookings, blocked time, time off, closed days | 8.3, 10.2 |
| R28 | Manual bookings with no payment link and no synthetic Stripe object | 8.5 |
| R29 | Manual payment recording with method, amount, timestamp, actor, note | 8.5 |
| R30 | Business cancellation with a reason and an optional refund | 6.5, 8.5 |
| R31 | Completion and no-show marking with realistic time guards | 6.5, 8.5 |
| R32 | Employee, working-hours, break, exception, time-off, blocked-time, closed-day management | 8.4, 10.3 |
| R33 | Service and category management with per-employee price overrides | 8.4, 10.3 |
| R34 | Organization settings for every policy | 8.4, 10.3 |
| R35 | Office user management, `OWNER`-only, with self-protection | 8.4, 10.3 |
| R36 | Customer records with history, search, and an erasure path | 8.5, 10.3 |
| R37 | CSV export of bookings and of the money ledger | 8.5, 10.3 |
| R38 | Audit trail for every consequential office action | 6.5, 8.2 |
| R39 | Refunds issued from the office, capped at the refundable amount | 6.3, 8.5 |

## Notifications

| # | Requirement | Tasks |
| --- | --- | --- |
| R40 | Confirmation email to the customer and to the office | 7.1, 7.2 |
| R41 | 24-hour reminders, configurable, optionally by SMS | 7.1, 7.3, 8.4 |
| R42 | Cancellation, reschedule, decision, and refund notifications | 7.1, 7.2 |
| R43 | Delivery state tracked to the provider's verdict, failures visible | 7.2, 11.2 |
| R44 | No notification lost to a crash between commit and enqueue | 4.2, 7.2 |
| R45 | No duplicate notification from an at-least-once queue | 7.2, 7.3 |
| R46 | German and English templates, locale following the booking | 7.1, 9.2 |

## Correctness, security, privacy

| # | Requirement | Tasks |
| --- | --- | --- |
| R47 | `organizationId` never accepted from a request | 1.4, 3.1, 5.1, 8.2 |
| R48 | Cross-organization access returns `404`, not `403` | 1.4, 8.2 |
| R49 | Office sessions: argon2id, Redis, rotation, revocation, lockout | 8.1 |
| R50 | CSRF defence without a token table, documented | 8.1 |
| R51 | Rate limiting on every abusable route | 5.1, 5.3, 6.1, 8.1 |
| R52 | No card data received, logged, or stored | 3.3, 10.2 |
| R53 | Webhook signatures verified on the raw body for all three providers | 3.3, 3.4, 5.4, 7.2 |
| R54 | Amounts never taken from the client; a mismatch is alerted, not silently accepted | 3.3, 5.4 |
| R55 | Money as integer cents in a value object, percentages rounded in the customer's favour | 2.1, 2.4 |
| R56 | Timezone-correct scheduling, including both DST transitions | 2.2, 2.3 |
| R57 | Structured logs with PII redaction and one correlation id end to end | 3.1, 11.2 |
| R58 | Explicit health-data warning on the customer note field | 7.1, 9.2, 9.3 |
| R59 | Configurable retention, redaction, and an erasure path | 7.2, 8.5, 11.3 |
| R60 | No SQL injection surface; raw unsafe SQL banned by lint | 0.2, 8.5 |
| R61 | CSV formula injection neutralised | 8.5 |
| R62 | Accessible UI: contrast, focus, keyboard, screen-reader labels | 9.1, 11.1 |

## Multi-tenant readiness

| # | Requirement | Tasks |
| --- | --- | --- |
| R63 | `organizationId` on every owned row, indexed leading | 1.2 |
| R64 | Tenant resolution behind one replaceable provider | 1.4 |
| R65 | Payment provider already shaped for Stripe Connect and inert today | 3.2, 3.3 |
| R66 | No SaaS feature shipped | §11.1, verified by the checklist below |

## Operations

| # | Requirement | Tasks |
| --- | --- | --- |
| R67 | Reproducible workspace, pinned toolchain, single lockfile | 0.1 |
| R68 | Local infrastructure isolated from test infrastructure | 0.3 |
| R69 | CI running the same commands as a developer, with real Postgres and Redis | 0.4, 11.3 |
| R70 | Integration tests against real PostgreSQL for constraints, locks, and error mapping | 1.3, 4.2, 5.2 |
| R71 | End-to-end tests for the customer and office journeys | 11.1 |
| R72 | Health endpoints, queue and job visibility, graceful shutdown | 11.2 |
| R73 | Migrations applied before any process starts, constraints verified after | 1.3, 11.3 |
| R74 | Backup and verified restore | 11.3 |
| R75 | Runbooks for every foreseeable incident | 11.3 |
| R76 | Seed data that demonstrates the flow immediately | 1.4 |

---

# Verification checklist

Run in this order. Every box must be checked before Phase 1 is called done.

## Static and unit

- [ ] `pnpm install --frozen-lockfile` succeeds — the lockfile is current.
- [ ] `pnpm lint` reports zero errors, including the bans on `$queryRawUnsafe`,
  `process.env` outside the config module, `new Date()` outside the time module, and
  cent arithmetic outside `Money`.
- [ ] `pnpm typecheck` is clean across all six packages.
- [ ] `pnpm test` is green with line coverage at or above 80 % for
  `src/domain`, `src/booking`, `src/payment`, and `src/messaging`.
- [ ] `.env.example` and the environment schema declare identical key sets.
- [ ] No exported request contract contains an `organizationId` key.
- [ ] German and English translations have identical key sets, no empty values, and a
  key for every `ErrorCode`.
- [ ] Every `NotificationKind` has a template in both locales; deleting one breaks
  `typecheck`.
- [ ] Design tokens meet WCAG AA; no raw hex colour outside `tokens.css`.
- [ ] `schema.prisma` declares exactly 29 models, every instant is `timestamptz`, every
  `…Cents` column is `Int`, and no money table cascades.

## Integration (real PostgreSQL and Redis)

- [ ] `pnpm test:infra:up && pnpm api prisma:migrate:deploy && pnpm test:integration`
  is green.
- [ ] All four calendar constraints exist after `migrate deploy`, and the
  `bookings_no_overlap` predicate matches `BLOCKING_BOOKING_STATUSES` exactly.
- [ ] An overlapping booking raises `23P01` and maps to `409 SLOT_UNAVAILABLE`.
- [ ] Back-to-back appointments are legal; zero-length ranges are rejected.
- [ ] Twenty concurrent reservations on one slot produce exactly one booking.
- [ ] A blocked-time conflict is rejected — the advisory lock covers what no constraint
  can.
- [ ] The tenant extension throws on every unscoped read and write; two organizations
  never see each other's rows through any endpoint.
- [ ] The outbox rolls back with its transaction, dispatches exactly once, and two
  concurrent dispatchers over 20 rows enqueue 20 jobs.
- [ ] A duplicate webhook delivery is a no-op; an unprocessed inbox row older than five
  minutes is re-driven.
- [ ] Idempotent replay returns the stored body including `checkoutUrl`; a different
  body is `422`; a concurrent duplicate is `409`.
- [ ] The expiry saga keeps the slot blocked through phase 2 and confirms instead of
  expiring when the customer paid.
- [ ] The expiry saga and the webhook confirming concurrently produce one payment, one
  management token, and one history row.
- [ ] A refund is created `PENDING` before the provider call, is idempotent under
  retry, survives an out-of-order webhook, and `refundedAmountCents` always equals the
  sum of succeeded refunds.
- [ ] Reschedule approval swaps both slots atomically, rotates the token, and takes both
  locks in ascending id order.
- [ ] The full §10.5 authorization matrix holds for all three roles.
- [ ] Notifications dedupe; a reminder for a moved or cancelled booking is skipped;
  the reconciler rebuilds reminders after a Redis loss.
- [ ] No Stripe, Resend, or Twilio call happens inside a database transaction —
  asserted by the transaction-count tests in 5.3 and 5.5.
- [ ] The worker registers a processor for every declared job and exactly eight
  repeatables, and installing twice does not duplicate them.
- [ ] `health/ready` detects an unapplied migration.

## End-to-end

- [ ] `pnpm test:e2e` is green in both the desktop and the 360-pixel viewport.
- [ ] A German customer books, pays, and receives a German email containing a
  `/manage#` link.
- [ ] The reserved slot is unavailable to a second visitor while the first is paying.
- [ ] An abandoned checkout keeps the slot blocked after phase 1 and releases it after
  phase 2.
- [ ] Cancelling outside the window states the refund; inside it, a request is created
  with the shown suggestion.
- [ ] An invalid management link shows a friendly page.
- [ ] The office completes a manual booking, a manual payment, a request decision with
  an overridden retained amount, a blocked time, and a CSV export.
- [ ] An `EMPLOYEE` cannot see or reach owner-only screens.
- [ ] A double-clicked submit creates one booking.
- [ ] Ten routes have no serious or critical axe violation; the booking flow completes
  by keyboard alone.

## Manual verification

- [ ] Book across the spring-forward boundary (2026-03-29) and confirm no slot is
  offered in the missing hour and the times either side are correct locally.
- [ ] Book across the fall-back boundary (2026-10-25) and confirm no duplicated slot.
- [ ] Change `schedulingIntervalMinutes` to 60 and confirm public availability changes
  immediately.
- [ ] Archive a service and confirm it disappears publicly while a past booking still
  renders its name.
- [ ] Read a confirmation email in a real client and confirm the layout, the German
  copy, the money format, and the working manage link.
- [ ] Read a reminder SMS and confirm it is one to three segments.
- [ ] Trigger a Stripe webhook with a bad signature and confirm `400` and a `warn` log.
- [ ] Stop Redis and confirm the API still serves public availability, `ready` reports
  Redis down, and no request 500s with a stack trace.
- [ ] Stop the worker for five minutes, book, restart it, and confirm the confirmation
  email still arrives.
- [ ] Search the logs for a customer email address and a token and find neither.

---

# Deployment-readiness checklist

- [ ] `NODE_ENV=production`; no provider is `fake`; `ENABLE_TEST_SUPPORT` is unset;
  `ENABLE_API_DOCS` is unset or `false` — each verified by the process refusing to
  start otherwise.
- [ ] Every environment variable in `.env.example` has a real production value.
- [ ] `DEFAULT_ORGANIZATION_SLUG` matches the seeded organization.
- [ ] The database user has `CREATE EXTENSION` rights for the first `migrate deploy`,
  and `btree_gist` exists afterwards.
- [ ] `migrate deploy` runs as a one-shot container that must exit 0 before `api` and
  `worker` start.
- [ ] The constraint-inventory query returns all four constraints after deployment.
- [ ] Live Stripe keys installed; the webhook endpoint registered at
  `https://<host>/api/webhooks/stripe` with the eight event types from §6.6; the
  signing secret installed; a test event delivered and processed.
- [ ] Resend domain verified, `EMAIL_FROM_ADDRESS` on that domain, webhook registered,
  and one real email delivered.
- [ ] Twilio configured with a status callback URL, or SMS left disabled.
- [ ] TLS terminated; HSTS on; the CSP from §10.9 active; `/api` and `/` same origin.
- [ ] `trust proxy` set and audit rows record real client IPs.
- [ ] `backup.sh` scheduled, and a restore drill completed once against a real dump.
- [ ] `GET /api/health/live` and `/ready` wired to the process supervisor — `live` for
  restarts, `ready` for traffic.
- [ ] Log shipping in place with `LOG_LEVEL=info`, and a spot check confirming no PII.
- [ ] Alerts on: `ready` failing, failed jobs above zero, stuck outbox rows above zero,
  `EXPIRING` bookings older than five minutes, notifications `PENDING` over 15 minutes.
- [ ] The owner account's seeded password changed, and `canIssueRefunds` reviewed for
  every office user.
- [ ] Settings reviewed with the business: interval, horizon, notice, reservation TTL,
  free-cancellation window, fee policy, reminder offsets, retention days, office
  notification address, WhatsApp number.
- [ ] Real employees, working hours, services, prices, buffers, and closed days entered.
- [ ] One real end-to-end booking placed with a live card and refunded, to prove the
  money path before launch.
- [ ] `docs/operations.md` reviewed by whoever will be on call.

---

# Stripe Connect migration notes

Phase 1 is deliberately shaped so that multi-tenant payments are an additive change.
What is already in place:

- `Organization.stripeAccountId` exists and is `null`.
- Every `PaymentProvider` method takes `PaymentAccountContext { organizationId,
  stripeAccountId? }` as its first argument, and the Stripe adapter already builds its
  `requestOptions` from it — the `{ stripeAccount }` branch exists and is tested as
  inert (Task 3.3).
- Tenant resolution is one provider, `OrganizationContextService` (Task 1.4).
- Every owned row carries `organizationId` with a leading composite index, and the
  Prisma extension already forbids unscoped access.
- The exclusion constraints already key on `organization_id`.
- Webhook handlers already derive the organization from a persisted record rather than
  from provider metadata.

What a Connect migration would then need — none of it in Phase 1:

1. **Onboarding**: an Express or Standard account-onboarding flow, storing the returned
   account id in `Organization.stripeAccountId`, plus `account.updated` webhook
   handling for capability changes.
2. **Account-scoped events**: Connect webhooks arrive with an `account` field on the
   event. The inbox row would gain a `stripeAccountId` column and the processor would
   resolve the organization from it — still cross-checked against the persisted
   `Payment`, never trusted alone.
3. **Charge model**: choose direct charges (money to the connected account, fee via
   `application_fee_amount`) or destination charges. Direct charges keep the current
   `Payment` shape; destination charges add a transfer to model.
4. **Refunds**: refunds must be issued on the same account as the charge, so the
   context must be threaded from the `Payment` row rather than from the current
   organization — the signatures already allow it.
5. **Tenant resolution**: replace the configuration-driven provider with a host- or
   slug-based resolver. Because `/public/organizations/current` takes no identifier,
   nothing else changes.
6. **Settings and catalog scoping**: already per-organization; the office UI would gain
   organization switching for staff who belong to more than one, which needs a
   membership table `OfficeUser` does not have today.
7. **Rate limits and quotas**: currently per IP and per email; per-tenant limits would
   be added.
8. **What must not be reintroduced**: reading `organizationId` from a request. The
   contract test and the Prisma extension from Task 1.4 must keep passing through the
   migration.

---

# Recommended execution order

Stages are strictly sequential; tasks inside a stage are sequential unless noted.

```
Stage 0  0.1 → 0.2 → 0.3 → 0.4                    workspace, config, infra, CI
Stage 1  1.1 → 1.2 → 1.3 → 1.4                    schema, constraints, tenancy, seed
Stage 2  2.1 → 2.2 → 2.3 → 2.4                    money, time, availability, pricing
Stage 3  3.1 → 3.2 → {3.3 ‖ 3.4}                  contracts/errors, ports+fakes, adapters
Stage 4  4.1 → {4.2 ‖ 4.3} → 4.4                  queues, outbox, inbox, idempotency
Stage 5  5.1 → 5.2 → 5.3 → 5.4 → 5.5              catalog, reservation, checkout, webhook, expiry
Stage 6  6.1 → 6.2 → 6.3 → 6.4 → 6.5              manage, cancel, refund, reschedule, attendance
Stage 7  7.1 → 7.2 → 7.3 → 7.4                    templates, dispatch, reminders, worker
Stage 8  8.1 → 8.2 → {8.3 ‖ 8.4 ‖ 8.5}            auth, guards, then the three surfaces
Stage 9  9.1 → 9.2 → 9.3 → 9.4                    shell, i18n+client, wizard, manage
Stage 10 10.1 → {10.2 ‖ 10.3}                     office shell, then the screens
Stage 11 11.1 → 11.2 → 11.3                       e2e, observability, deployment
```

`‖` marks tasks that may run in parallel if two people are working; everything else
depends on what precedes it.

**Why this order.** The database constraints come before any code that relies on
them, so no service is ever written against a guarantee that does not yet exist. The
pure domain comes before anything that calls it, so the hard arithmetic is settled
while it is cheap to test. The provider ports and fakes come before the first feature
that needs payment, so no feature is ever written against the real Stripe. The outbox
comes before the first thing that must not be lost. The public flow comes before the
office area because it is the flow with the concurrency and money risk, and because
the office area is largely reads and forms over rules the public flow already
established. The web application comes after the API it consumes. End-to-end tests
come last because they are the only tests that need everything.

**Natural review points**, where the work is worth pausing to look at as a whole:
after 1.4 (the data model and its guarantees), after 5.5 (the money and concurrency
core), after 7.4 (everything asynchronous), after 8.5 (the complete API), and after
11.1 (the complete product).
