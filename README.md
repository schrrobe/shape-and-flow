# Shape and Flow

A pnpm monorepo. Everything in it today belongs to **booking-app**: online appointment
booking with payment for a single studio, plus the office area its staff run the day from.

## Running it locally

Five steps from a fresh clone. You need Node (the version in `.tool-versions`), pnpm and
Docker.

```bash
pnpm install                                   # 1. dependencies
cp booking-app/.env.example booking-app/.env   # 2. configuration; the defaults work as-is
pnpm db:up                                     # 3. Postgres and Redis in Docker
pnpm db:migrate && pnpm db:seed                # 4. schema, then a demonstrable business
pnpm dev                                       # 5. API on :3000, web on :5173
```

`pnpm db:seed` prints an owner and a staff password once — that is the office login.

The web dev server proxies `/api` to the API, so development is same-origin exactly like
production. Without that, the session cookie and CSRF behaviour would differ from what ships,
which is the class of bug that only appears after a deploy.

| Command                | What it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `pnpm lint`            | ESLint across every package                                     |
| `pnpm format`          | Prettier, check only                                            |
| `pnpm typecheck`       | `tsc --noEmit` / `vue-tsc` per package                          |
| `pnpm test`            | unit tests                                                      |
| `pnpm test:integration`| API tests against a real PostgreSQL (`pnpm test:infra:up` first) |
| `pnpm test:e2e`        | Playwright, browser through to database                         |
| `pnpm build`           | every package                                                   |
| `pnpm db:reset`        | destroys the development database and starts over               |

## Shape

Two deployable processes, both built from one NestJS codebase, plus a Vue bundle served as
static files.

```
                          ┌──────────────────────────────┐
   public customers ────► │  booking-web (Vue SPA)       │
                          │  /  and  /manage#<token>     │
                          └───────────────┬──────────────┘
                                          │ same-origin /api
   office staff ──────────────────────────┤
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

The worker is a second **entrypoint**, not a second application: same modules, same domain
services, same Prisma client, no HTTP listener. The two are distinguished by a Dockerfile
target and by `APP_ROLE`, which is asserted at bootstrap so an HTTP process can never
silently start consuming queues.

Nothing crosses the gap between "committed to Postgres" and "enqueued in Redis" on trust. A
domain event is written to an outbox table in the same transaction as the change that caused
it, and a reconciler re-drives anything the enqueue lost.

## Layout

```
booking-app/
  apps/
    api/                  NestJS: HTTP process, worker process, Prisma schema and migrations
    web/                  Vue 3 SPA: the public booking flow and the office area
  packages/
    contracts/            Zod schemas and inferred types — one source of truth for both apps
    ui/                   design tokens and the shared accessible components
    notification-templates/  German and English email and SMS bodies
    config/               shared ESLint, Prettier and TypeScript configuration
  infrastructure/
    nginx/                the edge vhost, and the web container's own server
    scripts/              backup and restore
    sql/                  the constraint inventory both of those run
  docs/
    operations.md         deployment, backups and the incident runbooks
    plans/                the phase 1 implementation plan and its progress log
  docker-compose.yml      Postgres and Redis for development
  docker-compose.test.yml the same, isolated, for the integration suite
  docker-compose.prod.yml the five-container production stack
```

The workspace root is the repository root, so `pnpm-lock.yaml` and `pnpm-workspace.yaml` live
here rather than in `booking-app/`. That is why every Docker build context is `.`.

## Reading further

- [booking-app/docs/operations.md](booking-app/docs/operations.md) — deploying it, backing it
  up, and what to do when a customer has paid and there is no booking
- [booking-app/docs/plans/phase-1-implementation-plan.md](booking-app/docs/plans/phase-1-implementation-plan.md)
  — the full specification and task-by-task plan
- [booking-app/docs/plans/implementation-progress.md](booking-app/docs/plans/implementation-progress.md)
  — what is built, what is not, and why
