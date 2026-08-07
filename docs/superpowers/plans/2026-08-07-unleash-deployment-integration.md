# Unleash Deployment and Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Unleash OSS 8.0.2 at `unleash.shapeandflow.de`, provision six environment-specific SDK tokens, and add resilient server/browser feature-flag foundations to both Shape and Flow repositories.

**Architecture:** Host Nginx terminates TLS and proxies to a loopback-only Docker Compose stack containing Unleash and PostgreSQL. Unleash OSS uses project `default`; dev and stage have distinct tokens scoped to `development`, production tokens are scoped to `production`, and the `deployment` context differentiates dev from stage. NestJS/Nitro use `unleash-client`; Vue/Nuxt browser runtimes use `unleash-proxy-client` with intentionally public frontend tokens.

**Tech Stack:** Unleash OSS 8.0.2, PostgreSQL 17, Docker Compose, Nginx, Certbot, NestJS 11, Vue 3, Nuxt 4, TypeScript, Vitest, pnpm 10, npm, GitHub Actions.

## Global Constraints

- Work only on `agent/unleash-integration` in `/Users/robert/www/shape-and-flow.worktrees/unleash-integration` and `/Users/robert/www/shape-and-flow-landing-page.worktrees/unleash-integration`.
- Preserve dirty primary checkouts and the unrelated `docs/offpage-seo.md` and organizer-onboarding files.
- Commit and PR authorship is only `Robert <robsch@stagedates.com>`; add no co-author, assistant, or AI trailers.
- Every local shell command is prefixed with `rtk`; commands sent to the VPS use its native tools because RTK is not installed there.
- Use Node 24.18.0 through `env ASDF_NODEJS_VERSION=24.18.0 asdf exec`.
- Never print backend, administrator, database, SMTP, or existing application secrets in command output, diffs, CI logs, or PR text.
- Frontend tokens are public by design but remain scoped to project `default` and one Unleash environment.
- Unknown flags and initial synchronization failures default to `false`; Unleash outages must not make either application unavailable.

---

### Task 1: Version-Control the VPS Deployment

**Files:**
- Create: `infrastructure/unleash/compose.yml`
- Create: `infrastructure/unleash/.env.example`
- Create: `infrastructure/unleash/nginx.conf`
- Create: `infrastructure/unleash/backup.sh`
- Create: `infrastructure/unleash/README.md`

**Interfaces:**
- Consumes: Docker Compose 5.4, host Nginx, Certbot, generated `/opt/unleash/.env`.
- Produces: loopback service `http://127.0.0.1:4242`, persistent `unleash-postgres-data`, and a repeatable backup command.

- [ ] **Step 1: Write configuration assertions before the files exist**

Run:

```bash
rtk proxy sh -c 'test -f infrastructure/unleash/compose.yml && test -f infrastructure/unleash/nginx.conf && test -x infrastructure/unleash/backup.sh'
```

Expected: non-zero because the deployment files do not exist.

- [ ] **Step 2: Create the hardened Compose definition**

Define `postgres:17-alpine` and `unleashorg/unleash-server:8.0.2` with named volume persistence, health checks, `restart: unless-stopped`, bounded JSON logs, `no-new-privileges`, and only `127.0.0.1:4242:4242`. Pass these required values from `.env`: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `UNLEASH_DEFAULT_ADMIN_USERNAME`, `UNLEASH_DEFAULT_ADMIN_PASSWORD`, `INIT_ADMIN_API_TOKENS`, and `UNLEASH_FRONTEND_API_ORIGINS`. Set `DATABASE_SSL=false`, `UNLEASH_URL=https://unleash.shapeandflow.de`, and `LOG_LEVEL=warn`.

- [ ] **Step 3: Create the edge and backup assets**

The Nginx template must redirect HTTP, proxy HTTPS to `127.0.0.1:4242`, forward `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`, and reference `/etc/letsencrypt/live/unleash.shapeandflow.de/{fullchain,privkey}.pem`. `backup.sh` must use `umask 077`, run `pg_dump` through the Compose PostgreSQL service, gzip the dump into `/opt/unleash/backups`, and remove local dumps older than seven days.

- [ ] **Step 4: Validate the assets**

Run with non-secret fixture values:

```bash
rtk proxy env POSTGRES_USER=unleash POSTGRES_PASSWORD=test-only POSTGRES_DB=unleash UNLEASH_DEFAULT_ADMIN_USERNAME=admin UNLEASH_DEFAULT_ADMIN_PASSWORD=test-only INIT_ADMIN_API_TOKENS='*:*.test-only' UNLEASH_FRONTEND_API_ORIGINS=https://shapeandflow.de docker compose -f infrastructure/unleash/compose.yml config --quiet
rtk proxy bash -n infrastructure/unleash/backup.sh
rtk proxy sh -c 'test "$(stat -f %Lp infrastructure/unleash/backup.sh)" = 755'
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the infrastructure**

```bash
rtk git add infrastructure/unleash
rtk git commit -m "feat(infra): add Unleash deployment"
```

### Task 2: Deploy Unleash and TLS on the VPS

**Files:**
- Create remotely: `/opt/unleash/compose.yml`
- Create remotely: `/opt/unleash/.env` (mode `0600`)
- Create remotely: `/opt/unleash/credentials.env` (mode `0600`)
- Create remotely: `/opt/unleash/backup.sh`
- Create remotely: `/etc/nginx/sites-available/unleash.shapeandflow.de`
- Create remotely: `/etc/nginx/sites-enabled/unleash.shapeandflow.de`

**Interfaces:**
- Consumes: Task 1 assets and temporary passwordless sudo.
- Produces: healthy HTTPS Unleash API/UI and a secure credential source for later tasks.

- [ ] **Step 1: Prove the pre-deployment state**

```bash
rtk proxy ssh robert@186.240.146.22 'test ! -e /opt/unleash/compose.yml; test ! -e /etc/nginx/sites-enabled/unleash.shapeandflow.de; curl -fsS http://127.0.0.1:4242/health >/dev/null'
```

Expected: non-zero because Unleash is not installed.

- [ ] **Step 2: Install assets and generate secrets without stdout**

Create `/opt/unleash` as `robert:docker` mode `0750`, upload the Compose/example/backup assets, and generate hexadecimal PostgreSQL password, administrator password, and bootstrap admin API token with `openssl rand`. Write `.env` and `credentials.env` under `umask 077`; store `INIT_ADMIN_API_TOKENS` in the valid `*:*.<random>` form. Do not use shell tracing.

- [ ] **Step 3: Start and inspect the stack**

```bash
rtk proxy ssh robert@186.240.146.22 'cd /opt/unleash && docker compose --env-file .env -f compose.yml pull && docker compose --env-file .env -f compose.yml up -d --wait && docker compose --env-file .env -f compose.yml ps'
```

Expected: PostgreSQL and Unleash are healthy; only `127.0.0.1:4242` is published.

- [ ] **Step 4: Obtain TLS and install final Nginx config**

Install an HTTP vhost, validate/reload Nginx, obtain the certificate with existing Certbot account state, replace it with the final tracked vhost, then run:

```bash
rtk proxy ssh robert@186.240.146.22 'sudo nginx -t && sudo systemctl reload nginx'
rtk proxy curl -fsS https://unleash.shapeandflow.de/health
```

Expected: Nginx validation succeeds and health returns HTTP 200 over a valid certificate.

- [ ] **Step 5: Verify isolation and backup**

```bash
rtk proxy ssh robert@186.240.146.22 'ss -lnt | grep -q "127.0.0.1:4242"; ! ss -lnt | grep -q "0.0.0.0:4242"; /opt/unleash/backup.sh; test -n "$(find /opt/unleash/backups -type f -name "*.sql.gz" -print -quit)"'
```

Expected: port 4242 is loopback-only and one non-empty compressed dump exists.

### Task 3: Provision OSS Tokens and the Smoke Flag

**Files:**
- Modify remotely: `/opt/unleash/credentials.env`
- Modify remotely: `/opt/booking/dev/.env.dev`
- Modify remotely: `/opt/booking/stage/.env.stage`
- Modify in GitHub: booking `ENV_FILE` secrets for `dev` and `stage`
- Modify in GitHub: landing secrets/variables for `dev`, `stage`, and `production`

**Interfaces:**
- Consumes: bootstrap admin API token from Task 2.
- Produces: three backend tokens and three frontend tokens with exact deployment ownership.

- [ ] **Step 1: Verify only OSS resources are visible**

Authenticate with the bootstrap admin token and assert `GET /api/admin/projects` contains only `default` and `GET /api/admin/environments` contains `development` and `production`.

- [ ] **Step 2: Create six tokens through `POST /api/admin/api-tokens`**

Use these exact request mappings and write each returned `secret` directly into `/opt/unleash/credentials.env` without printing it:

```text
shape-and-flow-backend-development  backend   default  development  deployment=dev
shape-and-flow-backend-staging      backend   default  development  deployment=stage
shape-and-flow-backend-production   backend   default  production   deployment=production
shape-and-flow-frontend-development frontend  default  development  deployment=dev
shape-and-flow-frontend-staging     frontend  default  development  deployment=stage
shape-and-flow-frontend-production  frontend  default  production   deployment=production
```

- [ ] **Step 3: Create the inert smoke flag**

Call `POST /api/admin/projects/default/features` with:

```json
{
  "name": "system.unleash-integration-smoke",
  "description": "Connectivity probe; intentionally disabled",
  "type": "operational",
  "impressionData": false
}
```

Leave it disabled in both built-in environments.

- [ ] **Step 4: Update deployment environments safely**

Append `UNLEASH_URL`, `UNLEASH_BACKEND_TOKEN`, `UNLEASH_FRONTEND_TOKEN`, `UNLEASH_ENVIRONMENT`, and `UNLEASH_DEPLOYMENT` to booking dev/stage env files while preserving owner `deploy:deploy` and mode `0600`. Stream the resulting files directly into `rtk gh secret set ENV_FILE --env <env> --body -`; never display their values. For landing, set `UNLEASH_BACKEND_TOKEN` as an Environment secret and set URL, frontend token, environment, and deployment as Environment variables for dev/stage/production.

- [ ] **Step 5: Verify token scopes without revealing secrets**

List token metadata through the Admin API and assert names/types/project/environment. Authenticate once with every backend token at `/api/client/features` and every frontend token at `/api/frontend`; assert HTTP 200 and that the smoke flag is absent or disabled.

### Task 4: Add Booking Configuration Contracts

**Files:**
- Modify: `booking-app/apps/api/src/config/env.schema.ts`
- Modify: `booking-app/apps/api/src/config/env.schema.spec.ts`
- Modify: `booking-app/apps/api/src/config/env-example.spec.ts`
- Modify: `booking-app/.env.example`
- Modify: `booking-app/.env.production.example`
- Create: `booking-app/packages/contracts/src/feature-flags.ts`
- Create: `booking-app/packages/contracts/src/feature-flags.spec.ts`
- Modify: `booking-app/packages/contracts/src/index.ts`

**Interfaces:**
- Produces: typed `UNLEASH_*` configuration and `featureFlagClientConfigSchema` shared by API and Vue.

- [ ] **Step 1: Write failing schema tests**

Cover all-or-none validation, mandatory values in `NODE_ENV=production`, allowed environments `development|production`, allowed deployments `dev|stage|production`, and the exact public response shape:

```ts
export const featureFlagClientConfigSchema = z.object({
  url: z.url(),
  clientKey: z.string().min(1),
  appName: z.literal('shape-and-flow-booking-web'),
  environment: z.enum(['development', 'production']),
  deployment: z.enum(['dev', 'stage', 'production']),
});
```

- [ ] **Step 2: Run tests and see them fail**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-api test -- env.schema.spec.ts env-example.spec.ts
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-contracts test -- feature-flags.spec.ts
```

Expected: missing schema/exports fail.

- [ ] **Step 3: Implement the schemas and examples**

Add optional fields plus one `superRefine` all-or-none rule; require all fields for production. Examples contain descriptive non-secret sentinel values only.

- [ ] **Step 4: Run focused tests and commit**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-api test -- env.schema.spec.ts env-example.spec.ts
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-contracts test -- feature-flags.spec.ts
rtk git add booking-app/apps/api/src/config booking-app/packages/contracts booking-app/.env.example booking-app/.env.production.example
rtk git commit -m "feat(config): define Unleash settings"
```

### Task 5: Add the Booking Server SDK and Public Config Endpoint

**Files:**
- Modify: `booking-app/apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `booking-app/apps/api/src/feature-flags/feature-flags.service.ts`
- Create: `booking-app/apps/api/src/feature-flags/feature-flags.service.spec.ts`
- Create: `booking-app/apps/api/src/feature-flags/feature-flags.controller.ts`
- Create: `booking-app/apps/api/src/feature-flags/feature-flags.controller.spec.ts`
- Create: `booking-app/apps/api/src/feature-flags/feature-flags.module.ts`
- Modify: `booking-app/apps/api/src/app.module.ts`
- Modify: `booking-app/apps/api/src/worker.module.ts`

**Interfaces:**
- Produces: `FeatureFlagsService.isEnabled(name, context?, fallback?)` and `GET /api/public/feature-flags/config`.

- [ ] **Step 1: Add `unleash-client@6.12.0`**

```bash
rtk proxy env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-api add unleash-client@6.12.0
```

- [ ] **Step 2: Write failing lifecycle, fallback, and controller tests**

Tests must prove one client per Nest process, `deployment` merged into `context.properties`, explicit fallback forwarding, no client when config is absent in tests, error logging without thrown startup failure, destroy on shutdown, `@Public()` endpoint access, and response validation through the shared contract.

- [ ] **Step 3: Run focused tests and see them fail**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-api test -- feature-flags
```

- [ ] **Step 4: Implement the Nest module**

Wrap the official SDK behind an injected factory so tests never call the network. Register `appName` as `shape-and-flow-booking-api` or `shape-and-flow-booking-worker` from `APP_ROLE`; call `initialize` without blocking Nest startup; add listeners for `error` and `warn`; call `destroy` during module teardown.

- [ ] **Step 5: Pass tests and commit**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-api test -- feature-flags
rtk git add booking-app/apps/api pnpm-lock.yaml
rtk git commit -m "feat(api): integrate Unleash SDK"
```

### Task 6: Add the Booking Browser SDK and Composable

**Files:**
- Modify: `booking-app/apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `booking-app/apps/web/src/feature-flags/client.ts`
- Create: `booking-app/apps/web/src/feature-flags/client.spec.ts`
- Create: `booking-app/apps/web/src/composables/useFeatureFlag.ts`
- Create: `booking-app/apps/web/src/composables/useFeatureFlag.spec.ts`
- Modify: `booking-app/apps/web/src/api/client.ts`
- Modify: `booking-app/apps/web/src/main.ts`

**Interfaces:**
- Consumes: Task 5 public runtime endpoint.
- Produces: reactive `useFeatureFlag(name, fallback = false)` for Vue components.

- [ ] **Step 1: Add `unleash-proxy-client@3.8.2`**

```bash
rtk proxy env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-web add unleash-proxy-client@3.8.2
```

- [ ] **Step 2: Write failing client/composable tests**

Mock the runtime config request and SDK. Assert the exact `/api/public/feature-flags/config` request, one SDK instance, context `{properties: {deployment}}`, start after config, reactive recomputation on SDK `update`, fallback before readiness, and cleanup of listeners.

- [ ] **Step 3: Implement without blocking the Vue mount**

Create/provide a singleton feature-flag client before `mount`; start it asynchronously after mounting. The composable returns a `ComputedRef<boolean>` and never throws for missing config or network failure.

- [ ] **Step 4: Verify and commit**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-web test -- feature-flags useFeatureFlag
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm --filter @shape-and-flow/booking-web typecheck
rtk git add booking-app/apps/web pnpm-lock.yaml
rtk git commit -m "feat(web): add reactive feature flags"
```

### Task 7: Complete Booking Verification

**Files:**
- Modify ignored local: `/Users/robert/www/shape-and-flow/booking-app/.env`

**Interfaces:**
- Consumes: development tokens from Task 3.
- Produces: locally usable development integration and a verified booking PR branch.

- [ ] **Step 1: Add the five development variables to the ignored primary-checkout env**

Preserve all existing values and mode. Do not stage or print this file.

- [ ] **Step 2: Run the complete booking gates**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm test
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm typecheck
rtk lint env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm lint
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec pnpm build
rtk git status --short
```

Expected: all gates exit 0; status contains only intended tracked changes or is clean after commits.

### Task 8: Add Landing Runtime Configuration and Server SDK

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.ts`
- Modify: `nuxt.config.ts`
- Create: `.env.example`
- Modify: `.gitignore`
- Create: `server/utils/feature-flags.ts`
- Create: `server/utils/feature-flags.test.ts`
- Create: `server/plugins/unleash.ts`

**Interfaces:**
- Produces: Nitro `isFeatureEnabled(name, context?, fallback?)` and private/public typed runtime configuration.

- [ ] **Step 1: Add both official SDKs**

```bash
rtk proxy env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm install --save-exact unleash-client@6.12.0 unleash-proxy-client@3.8.2
rtk proxy env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm install --save-dev --save-exact vitest@4.1.10 @nuxt/test-utils@4.1.0
```

- [ ] **Step 2: Write failing server utility tests**

Add `"test": "vitest run"` and a Nuxt-aware `vitest.config.ts` built with `defineVitestConfig`. Prove deployment context injection, false fallback, non-blocking initialization, singleton behavior, error isolation, and teardown.

- [ ] **Step 3: Implement runtime config and server lifecycle**

Add private `runtimeConfig.unleash` and public `runtimeConfig.public.unleash` objects matching the eight `NUXT_*` variables in the design. The Nitro plugin initializes one wrapped SDK and closes it on the Nitro `close` hook.

- [ ] **Step 4: Verify and commit**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm test -- --run server/utils/feature-flags.test.ts
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm run typecheck
rtk git add package.json package-lock.json vitest.config.ts nuxt.config.ts .env.example .gitignore server
rtk git commit -m "feat(server): integrate Unleash SDK"
```

### Task 9: Add the Landing Browser SDK and Composable

**Files:**
- Create: `app/plugins/unleash.client.ts`
- Create: `app/composables/useFeatureFlag.ts`
- Create: `app/composables/useFeatureFlag.test.ts`
- Create: `app/types/unleash.d.ts`

**Interfaces:**
- Consumes: `runtimeConfig.public.unleash`.
- Produces: reactive Nuxt `useFeatureFlag(name, fallback = false)`.

- [ ] **Step 1: Write failing composable/plugin tests**

Assert one client-only SDK, URL/clientKey/appName/environment mapping, `deployment` context, start lifecycle, update-driven reactivity, false fallback, and no server-side browser SDK creation.

- [ ] **Step 2: Implement the client plugin and composable**

Provide a narrow typed adapter instead of the raw SDK. Subscribe once to `ready`, `update`, and `error`; expose a reactive version counter and `isEnabled`; stop the SDK and detach listeners on app teardown.

- [ ] **Step 3: Verify and commit**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm test -- --run app/composables/useFeatureFlag.test.ts
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm run typecheck
rtk git add app package.json package-lock.json
rtk git commit -m "feat(app): add reactive feature flags"
```

### Task 10: Wire Landing Deployment Environments

**Files:**
- Modify: `docker-compose.prod.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `docs/deploy.md`

**Interfaces:**
- Consumes: GitHub Environment secret/variables from Task 3.
- Produces: eight runtime variables in all three landing containers.

- [ ] **Step 1: Write a failing workflow/config assertion**

Add a CI-readable check that parses the Compose config and asserts all private/public Unleash names are passed, and inspect the workflow for secret-safe writes.

- [ ] **Step 2: Add workflow inputs and env-file writes**

Map GitHub values to `NUXT_UNLEASH_*` and `NUXT_PUBLIC_UNLEASH_*`. Keep backend tokens out of the key-name diagnostic and failure logs; displaying frontend token values is unnecessary even though they are public.

- [ ] **Step 3: Document the OSS mapping**

Document `dev → development/deployment=dev`, `stage → development/deployment=stage`, and `production → production/deployment=production`, plus token rotation steps.

- [ ] **Step 4: Verify and commit**

```bash
rtk proxy env STACK_SUFFIX=stage IMAGE_TAG=test GHCR_OWNER=schrrobe WEB_PUBLISH_PORT=8091 NUXT_UNLEASH_URL=https://unleash.shapeandflow.de/api/ NUXT_UNLEASH_BACKEND_TOKEN=test-only NUXT_UNLEASH_ENVIRONMENT=development NUXT_UNLEASH_DEPLOYMENT=stage NUXT_PUBLIC_UNLEASH_URL=https://unleash.shapeandflow.de/api/frontend NUXT_PUBLIC_UNLEASH_FRONTEND_TOKEN=test-only NUXT_PUBLIC_UNLEASH_ENVIRONMENT=development NUXT_PUBLIC_UNLEASH_DEPLOYMENT=stage docker compose --env-file .env.example -f docker-compose.prod.yml config --quiet
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm run lint
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm run typecheck
rtk git add docker-compose.prod.yml .github/workflows/deploy.yml docs/deploy.md
rtk git commit -m "ci: inject Unleash runtime config"
```

### Task 11: End-to-End Verification, Publish Two PRs, and Remove Sudo

**Files:**
- Create ignored local: `/Users/robert/www/shape-and-flow-landing-page.worktrees/unleash-integration/.env`
- Delete remotely after verification: `/etc/sudoers.d/codex-unleash`

**Interfaces:**
- Produces: two draft PRs authored only by Robert and a locked-down VPS.

- [ ] **Step 1: Add ignored landing development env values and run full gates**

```bash
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm test -- --run
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm run lint
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm run typecheck
rtk test env ASDF_NODEJS_VERSION=24.18.0 asdf exec npm run build
```

- [ ] **Step 2: Verify existing application stacks after the env updates**

Do not deploy unmerged PR code to the five existing application stacks. Confirm their public smoke URLs remain healthy after the ignored new variables are added to the server env files. Independently authenticate browser SDK test clients against `/api/frontend` with the correct frontend tokens.

- [ ] **Step 3: Run security and TLS checks**

```bash
rtk proxy curl -fsS https://unleash.shapeandflow.de/health
rtk proxy ssh robert@186.240.146.22 'sudo nginx -t && sudo certbot renew --dry-run && cd /opt/unleash && docker compose --env-file .env -f compose.yml ps'
```

Expected: certificate dry-run, Nginx, health, and both containers succeed.

- [ ] **Step 4: Confirm author and diff scope in both repositories**

```bash
rtk git status -sb
rtk git diff origin/main...HEAD --stat
rtk git log origin/main..HEAD --format='%an <%ae> %s'
```

Expected: only intended Unleash files and `Robert <robsch@stagedates.com>` commits.

- [ ] **Step 5: Push and open two draft PRs**

Push `agent/unleash-integration` in each repository and open draft PRs against `main` titled `feat: integrate self-hosted Unleash`. PR bodies list changes, OSS environment mapping, security model, and exact verification evidence; include no credential values.

- [ ] **Step 6: Remove temporary sudo and verify revocation**

After every root-owned action passes:

```bash
rtk proxy ssh robert@186.240.146.22 'sudo rm /etc/sudoers.d/codex-unleash'
rtk proxy ssh robert@186.240.146.22 'sudo -n true'
```

Expected: removal succeeds and the final `sudo -n true` fails.

- [ ] **Step 7: Handoff credentials once**

Read `/opt/unleash/credentials.env` only for the final private handoff. Provide the administrator URL/username/password, six named runtime tokens with their OSS scopes, both PR URLs, and rotation guidance. Do not repeat secrets in PRs or later summaries.
