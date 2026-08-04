# Continuous deployment to stage and dev

Merging into `main` deploys stage; merging into `fusion` deploys dev. Both run on the single
Hostinger VPS that already serves the placeholder sites, alongside a production environment
that stays manual.

## Why this shape

Four decisions settled the design. Each had a cheaper alternative that was rejected for a
concrete reason, so they are recorded with the reason rather than only the outcome.

**Images are built on the runner and pulled by the server.** The box has two shared cores and
7.8 GB of RAM. Building four images there means `pnpm install`, a Vite build and two Nest
builds competing with whatever is already serving traffic, for several minutes, with 4 GB of
swap standing by to make that slow rather than fatal. Building on the runner also means the
server needs no source tree, no git and no credentials to fetch one, and that a rollback is a
tag rather than a rebuild. The cost is a registry and one overlay file.

**One secret per environment holds the entire env file.** GitHub Environments `stage` and
`dev` each carry a secret named `ENV_FILE`. Identical names in both is the point: nothing in
the workflow branches on the environment to find its configuration. The alternative — one
secret per variable — is 40 secrets and a template that silently drifts from
`.env.production.example` every time a variable is added.

**The deploy hangs off the pipeline rather than triggering in parallel.** `deploy.yml` is a
reusable workflow called as `ci.yml`'s last job, with `needs` naming every other job. A
deployment that can outrun the end-to-end tests will eventually ship a commit those tests
would have caught, and the minutes saved are not worth learning that on stage.

**The runner logs in as a dedicated `deploy` user.** No sudo, member of the `docker` group.
Worth stating plainly: the docker socket is root-equivalent on this host, so this is not a
smaller privilege — it is a *separate, revocable* identity. A leaked Actions secret costs one
`userdel -r deploy` instead of the account a human uses interactively.

## Files

| File | Role |
| ---- | ---- |
| `.github/workflows/deploy.yml` | new — build, push, deploy; `workflow_call` + `workflow_dispatch` |
| `booking-app/docker-compose.registry.yml` | new — overlay: GHCR images, `pull_policy: always` |
| `.github/workflows/ci.yml` | `fusion` trigger, concurrency fix, `deploy` job |
| `booking-app/docs/operations.md` | new deployment runbook |

## Sequence on the server

1. Write key, host key and an `ssh_config` on the runner; prove the connection
2. `scp` both compose files into `/opt/booking/<env>/`
3. Write `.env.<env>` from `ENV_FILE` at mode 600, appending `IMAGE_TAG` and `GHCR_OWNER`
4. `docker login ghcr.io` with the run's own `GITHUB_TOKEN`
5. `compose pull`
6. `compose up -d --wait postgres redis`
7. `compose run --rm migrate` — separately, because `migrate` has `restart: 'no'` and exits,
   and `up --wait` treats a container that is gone as a failure
8. `compose up -d --wait`
9. Smoke: `/api/health/ready` must report `"status":"ok"`, and `/office/calendar` must be 200
10. `docker logout`, remove the runner's key

Step 3 writes the tag into the file rather than exporting it into the remote shell. That
settles the precedence question between a shell variable and `--env-file`, and it leaves the
answer to "which commit is running here" on the server instead of only in a log.

## Two things this changed that were not on the list

**`ci.yml` cancelled its own deployments.** The workflow had
`concurrency: cancel-in-progress: true` on `${{ github.workflow }}-${{ github.ref }}`. Once a
deploy is a job of that workflow, a second push to `main` cancels a running one — with a
realistic chance of landing between `prisma migrate deploy` and `up`, leaving a migrated
schema that nothing serves. Now `cancel-in-progress: ${{ github.event_name == 'pull_request'
}}`, which keeps the documented intent (superseding *pull request* runs) and queues branch
pushes instead.

**Token permissions cannot be escalated by a called workflow.** `ci.yml` sets
`permissions: contents: read` at workflow level, and a reusable workflow's token can only be
downgraded from its caller's. Without `packages: write` on the *calling job*, the GHCR push
fails with 403 and the cause is three files away from the error.

## Seeding is deliberately manual

An empty database needs `prisma:seed` once, because the API refuses to start until
`DEFAULT_ORGANIZATION_SLUG` resolves. It is exposed as a `workflow_dispatch` input rather than
run on every push: whether `prisma:seed` is idempotent has not been established, and blind
seeding is how staging data gets quietly overwritten.

## Verified before commit

- `actionlint` (containerised, with shellcheck): no findings in either workflow. The single
  remaining repository finding, `ci.yml:265` `SC2012`, predates this work and was left alone.
- `docker compose config` with the two files overlaid and a workflow-shaped env file: all four
  application images resolve to `ghcr.io/schrrobe/sf-booking-*:<sha>` with `pull_policy:
  always`; Postgres and Redis stay on their Docker Hub tags; project name
  `shape-and-flow-booking-stage`; ports 3011 and 8081 published on `host_ip: 127.0.0.1`.
- The same command with `IMAGE_TAG` and `GHCR_OWNER` removed exits 1 naming the missing
  variable, so the `:?` guards are not decorative.
- Login as `deploy` with the Actions key, `StrictHostKeyChecking=yes` against the
  `SSH_KNOWN_HOSTS` value: `uid=1001(deploy) groups=…,988(docker)`, docker reachable,
  `/opt/booking/{stage,dev}` writable, `sudo` refused.
- `env.schema.ts:144-159` confirms provider credentials are required only when the real
  provider is selected, so the `fake` providers in the stage and dev env files leave the
  Stripe, Resend and Twilio placeholders unvalidated.

## Known gaps

**No automatic rollback.** A failed deploy leaves the stack partially replaced; the way back
is `gh workflow run deploy.yml -f image_tag=<older sha>`, which skips the build. Automating
it is a separate design, not a side effect of this one.

**Production still cannot run.** `NODE_ENV=production` refuses the `fake` email and SMS
providers and the Resend and Twilio adapters are unwritten, so stage and dev run
`NODE_ENV=development`. The workflow does not enforce this — the compose `:?` guards report
what is *missing*, never what is *wrong*.

**Ports are held by placeholders.** The first deploy of an environment needs its two
placeholder units disabled by hand; the deploy user has no sudo and cannot do it.
