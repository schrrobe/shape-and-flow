# Unleash Deployment and Application Integration Design

**Date:** 2026-08-07

**Goal:** Run a production-suitable Unleash instance at `https://unleash.shapeandflow.de` and integrate environment-scoped feature flags into the server and browser runtimes of the Shape and Flow booking application and landing page.

## Scope

This work has three deliverables:

1. Deploy Unleash and its dedicated PostgreSQL database on the existing Hostinger VPS with Docker Compose, host Nginx, and Let's Encrypt.
2. Integrate server-side and browser-side Unleash SDKs into the booking monorepo at `/Users/robert/www/shape-and-flow`.
3. Integrate server-side and browser-side Unleash SDKs into the Nuxt landing-page repo at `/Users/robert/www/shape-and-flow-landing-page`.

The implementation provides reusable flag services and composables. It does not place an existing customer-facing feature behind a flag. A disabled, non-user-facing smoke-test flag verifies connectivity without changing application behavior.

## Confirmed Environment

- `unleash.shapeandflow.de` resolves to `186.240.146.22`.
- The VPS runs Ubuntu 24.04.4 LTS, Docker 29.7.1, and Docker Compose 5.4.0.
- Host Nginx owns ports 80 and 443 and already proxies the booking and landing stacks.
- Certbot 2.9.0 and its renewal timer are active.
- Application containers publish only to loopback addresses.
- Existing deployments store mode `0600` environment files under `/opt/booking/<env>` and `/opt/landing/<env>`.
- The checked-out Unleash source identifies the current release as 8.0.2. The deployment pins `unleashorg/unleash-server:8.0.2` instead of using `latest`.

## Environment Mapping

Repository deployment names map to Unleash environment names as follows:

| Repository name | Unleash environment | Public host examples |
|---|---|---|
| `dev` | `development` | `dev.buchung.shapeandflow.de`, `dev.shapeandflow.de` |
| `stage` | `staging` | `stage.buchung.shapeandflow.de`, `stage.shapeandflow.de` |
| `production` | `production` | `buchung.shapeandflow.de`, `shapeandflow.de` |

One Unleash project named `shape-and-flow` owns all flags and all six runtime tokens.

## Token and Credential Model

Each environment receives two tokens:

| Token class | Count | Consumers | Exposure |
|---|---:|---|---|
| Backend API token | 3 | NestJS API/worker and Nuxt Nitro | Secret; server environments only |
| Frontend API token | 3 | Vue booking UI and hydrated Nuxt UI | Public by design; read-only and scoped to one project/environment |

The token names are deterministic:

- `shape-and-flow-backend-development`
- `shape-and-flow-backend-staging`
- `shape-and-flow-backend-production`
- `shape-and-flow-frontend-development`
- `shape-and-flow-frontend-staging`
- `shape-and-flow-frontend-production`

An independently generated administrator username and password bootstrap the first Unleash login through `UNLEASH_DEFAULT_ADMIN_USERNAME` and `UNLEASH_DEFAULT_ADMIN_PASSWORD`. PostgreSQL and token values are generated from cryptographically secure random bytes. No real credential is committed, printed in command logs, embedded in examples, or placed in a browser bundle unless it is an explicitly scoped frontend token.

At handoff, the administrator login and the six tokens are shown to the user once and also stored in a mode `0600` credential file owned by `robert` on the VPS. The deployment `.env` and credential file remain outside Git.

## VPS Architecture

The deployment lives at `/opt/unleash` and is owned by `robert`. Docker Compose runs two services on a dedicated network:

- `unleash`: `unleashorg/unleash-server:8.0.2`, bound as `127.0.0.1:4242:4242`.
- `postgres`: `postgres:17-alpine`, exposed only inside the Compose network with a named data volume.

Both services have health checks, bounded Docker JSON logs, `restart: unless-stopped`, and `no-new-privileges`. PostgreSQL must be healthy before Unleash starts. The Compose file uses required-variable guards; secrets are loaded from a mode `0600` `.env` file.

The host Nginx site `unleash.shapeandflow.de` proxies to `http://127.0.0.1:4242`, forwards the standard host and client headers, redirects HTTP to HTTPS, and obtains a Let's Encrypt certificate through the existing Certbot installation. PostgreSQL and port 4242 are never publicly reachable.

The deployment includes a database backup command that writes compressed, mode `0600` dumps below `/opt/unleash/backups`. Scheduling or off-host retention is outside this initial installation; the command is documented and tested once so backups can be automated without redesigning the stack.

## Booking Repository Integration

### Server runtime

The booking API adds `unleash-client` and a focused `FeatureFlagsModule`. The module owns a single SDK instance per process, starts without making Unleash availability a prerequisite for the booking service, records SDK errors through the existing logger, and destroys the SDK cleanly during Nest shutdown.

`FeatureFlagsService.isEnabled(flagName, context, fallback = false)` is the application-facing interface. Both `AppModule` and `WorkerModule` import the module so API and background jobs can evaluate the same flags while registering distinct `appName` values.

The typed environment schema adds:

- `UNLEASH_URL=https://unleash.shapeandflow.de/api/`
- `UNLEASH_BACKEND_TOKEN`
- `UNLEASH_FRONTEND_TOKEN`
- `UNLEASH_ENVIRONMENT`

Production-like environments require all four values. Tests may omit them and receive an explicitly disabled feature-flag service.

### Browser runtime

The static Vue image remains environment-neutral. The booking API exposes an unauthenticated, non-secret runtime configuration endpoint under `/api/public/feature-flags/config`. It returns only the frontend URL, frontend token, environment, and browser application name. Returning a frontend token is intentional: the same value is necessarily visible to any browser using the SDK, and its permissions are restricted in Unleash.

The Vue application adds `unleash-proxy-client`, initializes it after loading runtime configuration, and exposes a reactive `useFeatureFlag(flagName, fallback = false)` composable. Components can therefore render directly from Unleash flags without creating environment-specific frontend images. Until the first successful synchronization, the composable returns its fallback. The client SDK may reuse its last locally cached state during a temporary outage.

The booking `.env.example` and `.env.production.example` document names and safe placeholders. The ignored local `booking-app/.env` receives development values. GitHub Environment `ENV_FILE` secrets and the mode `0600` VPS files under `/opt/booking/dev` and `/opt/booking/stage` receive their matching values. Production values are prepared in the production example/local ignored configuration even though no production booking stack currently exists on the VPS.

## Landing-Page Repository Integration

### Server runtime

Nuxt adds `unleash-client`. A Nitro server plugin owns the SDK lifecycle, and a server utility exposes `isFeatureEnabled(flagName, context, fallback = false)` to server routes and rendering code. SDK failure is logged without making the website or contact form unavailable.

Private runtime configuration uses:

- `NUXT_UNLEASH_URL`
- `NUXT_UNLEASH_BACKEND_TOKEN`
- `NUXT_UNLEASH_ENVIRONMENT`

### Browser runtime

Nuxt adds `unleash-proxy-client`. A client-only plugin creates one browser SDK instance and a reactive `useFeatureFlag(flagName, fallback = false)` composable. Public runtime configuration uses:

- `NUXT_PUBLIC_UNLEASH_URL`
- `NUXT_PUBLIC_UNLEASH_FRONTEND_TOKEN`
- `NUXT_PUBLIC_UNLEASH_ENVIRONMENT`

The Docker Compose file explicitly passes the six Unleash runtime variables. The deploy workflow reads backend tokens from GitHub Environment secrets and frontend tokens plus URL/environment from GitHub Environment variables, then writes them into the existing mode `0600` files at `/opt/landing/{dev,stage,production}/.env.<env>`. Backend tokens are never echoed by smoke tests or failure diagnostics.

## Unleash Configuration

The installation creates the `shape-and-flow` project, enables `development`, `staging`, and `production`, and provisions the six scoped tokens. A flag named `system.unleash-integration-smoke` exists in the project and is disabled in all environments. Automated and manual checks evaluate it as `false`; it is not referenced by visible UI markup.

Browser access uses `https://unleash.shapeandflow.de/api/frontend`. Nginx limits browser origins to `https://buchung.shapeandflow.de`, `https://stage.buchung.shapeandflow.de`, `https://dev.buchung.shapeandflow.de`, `https://shapeandflow.de`, `https://stage.shapeandflow.de`, `https://dev.shapeandflow.de`, `http://localhost:5173`, and `http://localhost:3000`. Server SDKs use `https://unleash.shapeandflow.de/api/` with backend tokens.

## Failure and Security Behavior

- A missing required production token fails configuration validation before serving traffic.
- Unleash becoming unavailable after startup does not take either application down.
- An unknown flag or absent initial state resolves to the call site's explicit fallback, which defaults to `false`.
- Frontend tokens cannot administer projects, environments, users, or API tokens.
- Backend and administrator credentials are redacted from structured logs and CI output.
- The Nginx proxy, not Docker, is the only public ingress path.
- Existing dirty changes in both primary checkouts are preserved; implementation uses isolated worktrees or narrowly scoped patches.
- The temporary `robert ALL=(ALL) NOPASSWD: ALL` sudo rule is removed after all root-owned Nginx, Certbot, and `/opt` work passes verification.

## Verification and Acceptance Criteria

The work is accepted when all of the following hold:

1. `https://unleash.shapeandflow.de` presents a valid certificate and the generated administrator can sign in.
2. Docker reports both Unleash services healthy; PostgreSQL and port 4242 are not externally reachable.
3. The `shape-and-flow` project, three environments, six correctly scoped tokens, and disabled smoke flag exist.
4. Each server SDK authenticates with its environment's backend token and evaluates the smoke flag as `false`.
5. Each browser SDK authenticates with its environment's frontend token and reactively evaluates the smoke flag as `false` without exposing any backend token.
6. Unit tests cover configuration validation, fallback behavior, singleton lifecycle, and reactive composables in both repositories.
7. Repository lint, typecheck, focused tests, and production builds pass.
8. Existing dev, stage, and production landing deployments and existing dev/stage booking deployments remain healthy.
9. Nginx configuration and Certbot renewal dry-run pass.
10. The temporary sudoers file `/etc/sudoers.d/codex-unleash` no longer exists, and non-interactive sudo for `robert` fails again.
