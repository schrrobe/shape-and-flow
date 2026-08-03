# syntax=docker/dockerfile:1
#
# Two runtime images from one build.
#
# The build context is the **repository root**, not `booking-app/`:
#
#     docker build -f booking-app/apps/api/Dockerfile --target api    -t sf-booking-api    .
#     docker build -f booking-app/apps/api/Dockerfile --target worker -t sf-booking-worker .
#
# The plan's command uses `booking-app` as the context, which cannot work — `pnpm-lock.yaml`
# and `pnpm-workspace.yaml` live at the repository root, and an install without them is not
# the install that was tested.
#
# The api and worker targets differ by one line, their `CMD`, and that is deliberate: two
# processes built from different images can drift apart in a way that is invisible until one
# of them fails on code the other is running fine.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack rather than a global install, so the pnpm version comes from
# `packageManager` in package.json and matches what the lockfile was written by.
RUN corepack enable
WORKDIR /repo

# ── Dependencies ─────────────────────────────────────────────────────────────
#
# Manifests and the lockfile only. A source change must not invalidate this layer:
# resolving and fetching is the slow part of every build.

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY booking-app/apps/api/package.json booking-app/apps/api/
COPY booking-app/packages/config/package.json booking-app/packages/config/
COPY booking-app/packages/contracts/package.json booking-app/packages/contracts/
COPY booking-app/packages/notification-templates/package.json booking-app/packages/notification-templates/
# `--ignore-scripts`: `prisma generate` and the workspace packages' `prepare` builds need
# source that is not in this stage. The build stage runs them explicitly.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts

# ── Build ────────────────────────────────────────────────────────────────────

FROM deps AS build
# `prisma generate` reads no database, but `prisma.config.ts` refuses to load without a URL —
# it is the same config `migrate deploy` uses, and making it lenient would let a real
# migration silently target a placeholder. So the build gets one that is obviously not a
# database. It exists only in this stage.
ENV DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused
COPY booking-app/packages booking-app/packages
COPY booking-app/apps/api booking-app/apps/api
# The Prisma client is generated TypeScript under src/generated, so it has to exist before
# tsc runs — not at container start, where a failure would be a crash loop instead of a
# failed build.
RUN pnpm --filter @shape-and-flow/booking-api exec prisma generate
RUN pnpm --filter @shape-and-flow/booking-api... build

# ── migrate ──────────────────────────────────────────────────────────────────
#
# A third image, whose only job is `prisma migrate deploy`.
#
# It exists because the runtime image deliberately has no Prisma CLI, and that is a
# property worth keeping: a container serving traffic must not be able to rewrite the
# schema it is reading. So the migrator is built from the *build* stage — dev
# dependencies, source and `prisma.config.ts` included — and is a separate, one-shot
# container that has exited before the API starts.
#
# It is larger than the runtime image and that is fine: it runs for a few seconds per
# deploy and is never exposed to a network.

FROM build AS migrate
ENV NODE_ENV=production
WORKDIR /repo/booking-app/apps/api
USER node
# The binary directly rather than `pnpm exec`: one fewer process, and nothing here needs
# a writable pnpm home. `migrate deploy` never generates, never opens a shadow database
# and never writes to the image, so an unwritable tree is not a problem.
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ── Production dependencies ──────────────────────────────────────────────────
#
# A separate install rather than pruning the built tree: `--prod` resolves the graph without
# devDependencies at all, so nothing depends on a prune having caught everything.

FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY booking-app/apps/api/package.json booking-app/apps/api/
COPY booking-app/packages/config/package.json booking-app/packages/config/
COPY booking-app/packages/contracts/package.json booking-app/packages/contracts/
COPY booking-app/packages/notification-templates/package.json booking-app/packages/notification-templates/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ── Shared runtime ───────────────────────────────────────────────────────────

FROM base AS runtime
ENV NODE_ENV=production
# Node's own signal handling is enough: both entrypoints install SIGTERM handlers and exit,
# so PID 1 does not need an init shim to avoid a stuck container.
ENV NODE_OPTIONS=--enable-source-maps

# The store path layout has to match the install, so the whole tree is copied rather than
# just `node_modules` — pnpm's links are relative to it.
COPY --from=prod-deps /repo /repo

COPY --from=build /repo/booking-app/packages/contracts/dist \
                  /repo/booking-app/packages/contracts/dist
COPY --from=build /repo/booking-app/packages/notification-templates/dist \
                  /repo/booking-app/packages/notification-templates/dist
COPY --from=build /repo/booking-app/apps/api/dist /repo/booking-app/apps/api/dist
# Migrations and the schema stay available for runtime diagnostics. The CLI itself is a
# devDependency and deliberately absent: deployment migrations use the separate `migrate`
# target above, while a container serving traffic cannot rewrite its own database.
COPY --from=build /repo/booking-app/apps/api/prisma /repo/booking-app/apps/api/prisma

WORKDIR /repo/booking-app/apps/api
# `node` exists in the base image with uid 1000. Nothing here is written at runtime, so the
# tree stays owned by root and unwritable by the process using it.
USER node

# ── api ──────────────────────────────────────────────────────────────────────

FROM runtime AS api
ENV APP_ROLE=api
# The schema's default is 3000, which does not match the port declared and probed below —
# so with PORT unset the process listened on 3000 while the healthcheck asked 3001 and every
# container reported unhealthy. Setting it here makes the listener, EXPOSE and HEALTHCHECK
# agree on one number; an operator who sets PORT still overrides all three at once.
ENV PORT=3001
EXPOSE 3001
# Checks the process's own view of readiness, including its database connection, rather than
# whether the port is open — a process that accepts connections and cannot reach Postgres is
# the failure worth restarting.
#
# `/api/health/ready`, not `/api/health`: nothing is mounted on the bare prefix, so the check
# as first written asked for a 404 and would have reported every container unhealthy.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3001)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ── worker ───────────────────────────────────────────────────────────────────

FROM runtime AS worker
ENV APP_ROLE=worker
# No port and no healthcheck: the worker serves nothing, and a liveness probe that cannot
# reach it is better than one that lies. Its health is visible in the queue depth and in the
# `/api/health/detail` counts the API reports.
CMD ["node", "dist/worker.main.js"]
