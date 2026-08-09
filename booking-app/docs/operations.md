# Operations

Everything needed to put this on a server, keep it there, and get it back after something
goes wrong. Each runbook is meant to be followed by one person at an awkward hour, so the
commands are complete and copy-pasteable rather than illustrative.

Every command is run **from the repository root**.

---

## What runs

Six containers, one of which exits before the others start.

| Container                        | What it is                       | Reachable from             |
| -------------------------------- | -------------------------------- | -------------------------- |
| `sf-booking-postgres-production` | PostgreSQL 17, one named volume  | the compose network only   |
| `sf-booking-redis-production`    | Redis 7, append-only             | the compose network only   |
| `sf-booking-migrate-production`  | one-shot `prisma migrate deploy` | nothing; it exits          |
| `sf-booking-api-production`      | the HTTP API                     | `127.0.0.1:3001`           |
| `sf-booking-worker-production`   | queues, sweeps and notifications | nothing; it serves no port |
| `sf-booking-web-production`      | nginx serving the built bundle   | `127.0.0.1:8080`           |

The `-production` suffix is `STACK_SUFFIX`, which defaults to `production`. It is what lets a
second environment run on the same host; see [More than one environment](#more-than-one-environment).
Every `docker exec` below assumes the default. For another environment, substitute its suffix.

In front of them, on the host, is nginx: `infrastructure/nginx/booking.conf`. It terminates
TLS, sends `/api` to the API container and everything else to the web container. It is the
only thing listening on a public interface.

`/api` goes to the API **directly**, never through the web container. The API trusts exactly
one proxy hop (`app.set('trust proxy', 1)`); a second one would make every rate limit and
every audit row record nginx's address instead of the caller's.

### Health

| Endpoint             | Who         | What it answers                                                       |
| -------------------- | ----------- | --------------------------------------------------------------------- |
| `/api/health/live`   | anyone      | the process is up. Touches nothing, so a database blip cannot restart it |
| `/api/health/ready`  | anyone      | database, Redis and applied migrations, each named if it is the one down |
| `/api/health/detail` | OWNER/ADMIN | queue depths, failed jobs, stuck outbox rows, unprocessed webhooks, pending notifications, oldest `EXPIRING` booking |

`/api/health/ready` is what the container healthcheck asks and what a load balancer should
ask. It reports 503 when a migration in the image has not been applied to the database —
which catches the deploy where the migrate step did not run, a failure no connection check
sees.

### What the worker does on a schedule

| Job                        | Cadence           | Why it exists                                              |
| -------------------------- | ----------------- | ---------------------------------------------------------- |
| `sweep.expired_reservations` | every minute    | releases slots whose payment window closed                 |
| `sweep.stuck_expiring`     | every minute      | resolves bookings left mid-expiry                          |
| `sweep.inbox`              | every 2 minutes   | re-drives webhooks that committed but never reached a queue |
| `sweep.outbox`             | every 5 minutes   | re-drives domain events that committed but never enqueued  |
| `sweep.notifications`      | every 5 minutes   | retries sends that failed                                  |
| `sweep.reminders`          | 03:00 Berlin      | reconciles tomorrow's reminders                            |
| `sweep.idempotency_keys`   | 03:15 Berlin      | prunes expired keys                                        |
| `sweep.retention`          | 03:30 Berlin      | applies the configured retention period                    |

These are why most incidents resolve themselves. Before intervening, check whether the sweep
that owns the problem has had a chance to run.

---

## Before the first deployment

You need:

- a host with Docker and the compose plugin, and nginx installed on the host
- a DNS `A`/`AAAA` record for the hostname pointing at it
- Stripe keys, and later a webhook endpoint pointing at
  `https://<hostname>/api/webhooks/stripe`

### A caveat that applies today

`NODE_ENV=production` refuses `fake` for the email and SMS providers, and the real Resend and
Twilio adapters are **Task 3.4 and are not written yet**. Selecting them throws a named error
at start-up rather than quietly sending nothing.

So a deployment made today can only run with `NODE_ENV=development` and the fake providers —
which is a staging environment, not a production one. Everything in this document works; what
does not yet exist is a configuration in which a customer receives an email. Finish 3.4 before
taking bookings from real people.

---

## Runbook: first deployment

**1. Fetch the code and write the configuration.**

```bash
git clone <repository> shape-and-flow && cd shape-and-flow
cp booking-app/.env.production.example booking-app/.env.production
chmod 600 booking-app/.env.production
$EDITOR booking-app/.env.production
```

Every value marked `replace_me` has to change. `POSTGRES_PASSWORD` and the password inside
`DATABASE_URL` are the same password written twice — the compose file configures Postgres from
one and the API connects with the other, and they must agree.

**2. Build the images.**

```bash
docker build -f booking-app/apps/api/Dockerfile --target api     -t sf-booking-api:local     .
docker build -f booking-app/apps/api/Dockerfile --target worker  -t sf-booking-worker:local  .
docker build -f booking-app/apps/api/Dockerfile --target migrate -t sf-booking-migrate:local .
docker build -f booking-app/apps/web/Dockerfile                  -t sf-booking-web:local     .
```

Note the trailing `.`: the build context is the repository root, because the lockfile and the
workspace manifest live there.

**3. Create the schema.**

```bash
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml up -d --wait postgres redis

docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml run --rm migrate
```

`--env-file` is not optional. Without it compose reads `booking-app/.env`, which is the
*development* configuration, and would deploy against a database that does not exist here.

The API and the worker are held back until step 6 on purpose. A first deployment has a
database that is migrated but **empty**, and the API resolves `DEFAULT_ORGANIZATION_SLUG` at
bootstrap and refuses to start when that organization does not exist — correctly, since an API
serving a business that is not there has nothing useful to do. Seed first, start second. On
every subsequent deployment this is a single `up -d --wait`, because the organization is
already there.

**4. The `CREATE EXTENSION` grant.**

The first migration runs `CREATE EXTENSION IF NOT EXISTS btree_gist`, which the two exclusion
constraints — the things that make a double booking impossible — depend on. On the compose
stack this just works: `POSTGRES_USER` owns the database, and `btree_gist` is a *trusted*
extension in PostgreSQL 13 and later, so ownership is enough.

On a managed Postgres it may not be. If the migrate container fails with
`permission denied to create extension "btree_gist"`, ask whoever holds superuser to run, once:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

and then re-run the deployment. Do not work around it by removing the constraint.

**5. Seed the business and its first login.**

```bash
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml \
               run --rm migrate pnpm prisma:seed
```

The seed runs from the migrate image, which is the only one carrying dev dependencies — the
API image has neither `tsx` nor the Prisma CLI, deliberately.

Through the package script rather than naming the seed file: where that file lives is the
API package's business, and a runbook that hard-codes the path goes stale the first time
somebody moves it — silently, because a runbook is not compiled.

It prints an owner and a staff password **once**. Write them down, log in, and change them.
The passwords are generated rather than fixed, so a seeded database is not a
known-credentials database.

The seed creates a demonstrable business: services, staff, opening hours. Edit all of it in
the office area; none of it is special.

**6. Start the application and check it.**

```bash
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml up -d --wait

docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml ps
curl -fsS http://127.0.0.1:3001/api/health/ready | jq
```

Five containers running, the sixth exited 0, and `ready` reporting `database`, `redis` and
`migrations` all up.

**7. Put nginx in front.**

```bash
sudo cp booking-app/infrastructure/nginx/booking.conf /etc/nginx/sites-available/
sudo sed -i 's/buchung.example.com/<your hostname>/g' /etc/nginx/sites-available/booking.conf
sudo mkdir -p /var/www/certbot

# The certificate first, and the site enabled only afterwards. The order is not a
# preference: the vhost's 443 block names `fullchain.pem`, so `nginx -t` fails while that
# file does not exist, and enabling the site before the certificate exists leaves a broken
# configuration that no reload will accept.
#
# `--standalone` rather than `--webroot` for this first issue, which is why nginx stops for
# the length of one challenge. Webroot mode hands the challenge to whichever server block
# currently owns `/.well-known/acme-challenge/`, and on a fresh machine that is the default
# site serving `/var/www/html` — the challenge 404s and the reason is not obvious.
sudo systemctl stop nginx
sudo certbot certonly --standalone -d <your hostname>
sudo systemctl start nginx

sudo ln -s /etc/nginx/sites-available/booking.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# The catch-all, so a hostname no vhost claims gets a closed connection rather than the
# booking app. Without it nginx serves an unmatched host from the first vhost it parsed,
# and anybody who points a domain at this IP gets a working booking front end under their
# own name. Ubuntu's packaged default already claims `default_server` on :80, and nginx
# refuses to start with two.
sudo rm -f /etc/nginx/sites-enabled/default
sudo cp booking-app/infrastructure/nginx/default-server.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/default-server.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Renewals go back through the webroot, which this vhost now serves on port 80, so nginx
# keeps running for every renewal after the first. Certbot rewrites the stored authenticator
# only when it actually issues, which is what `--force-renewal` is for here — leave it out
# and the renewal config keeps saying `standalone`, and the first unattended `certbot renew`
# fails on a port nginx is holding.
sudo certbot certonly --webroot -w /var/www/certbot -d <your hostname> \
                      --cert-name <your hostname> --force-renewal
sudo systemctl reload nginx
sudo systemctl list-timers 'certbot*'
```

TLS is not decoration here: the office session cookie is issued `Secure` whenever
`NODE_ENV=production`, so over plain HTTP the browser discards it and every login appears to
succeed and then fails.

**8. Point Stripe at it.** Two endpoints, because Stripe treats the platform's own events and
its connected accounts' events as separate destinations with separate signing secrets:

| Stripe destination | URL                                        | Events                                     | Secret goes into                |
| ------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------- |
| Account (platform) | `https://<hostname>/api/webhooks/stripe`         | checkout and refund events                 | `STRIPE_WEBHOOK_SECRET`         |
| Connect            | `https://<hostname>/api/webhooks/stripe/connect` | `account.updated`, connected-account charges | `STRIPE_CONNECT_WEBHOOK_SECRET` |

A secret is per endpoint, not per account, and one cannot verify the other's deliveries — that
is why there are two URLs rather than one endpoint with two secrets. Both must be configured
before this goes live: self-service organizer registration onboards every new organizer through
Stripe Connect, so `account.updated` for a connected account arrives from the first registration
onward, not once some later milestone is reached. `apps/api/src/config/env.schema.ts` refuses to
start with `PAYMENT_PROVIDER=stripe` and either secret unset, so a deployment missing the
Connect one fails at boot rather than silently 422ing every booking for the first organizer who
finishes onboarding.

**9. Take a backup before anyone uses it**, so the restore path has been walked once while
nothing is at stake:

```bash
booking-app/infrastructure/scripts/backup.sh
```

---

## Runbook: giving an organizer its own domain

An organizer can run the booking flow under its own address — `https://studio-muster.de/booking`
— instead of the central one with `?organizer=studio-muster`. The API decides the tenant from
the hostname the request arrived on, so this is three separate systems that have to agree: DNS,
nginx, and a row in `organization_domains`. Doing two of the three leaves a domain that looks
live and serves the wrong organizer.

**How the API resolves a tenant**, in order, for every `/api/public/*` request:

1. The hostname, looked up in `organization_domains`. A match wins outright — a
   `?organizer=` in the URL is not even read, so an old link from the central address
   cannot redirect a customer into a different organizer's calendar.
2. Otherwise `?organizer=<slug>`, but **only** on a central host: the hostnames of
   `PUBLIC_WEB_ORIGIN` and `PUBLIC_API_ORIGIN`, plus anything in `CENTRAL_HOSTNAMES`. A
   slug arriving on any other hostname is refused with 404 `ORGANIZATION_NOT_FOUND`,
   because otherwise every unclaimed domain pointed at this server would be a working
   front end for any tenant.
3. Otherwise nothing, and the request is served as `DEFAULT_ORGANIZATION_SLUG`. This is the
   single-organizer deployment and the central landing page.

**1. DNS.** An `A` record, and an `AAAA` if the machine has IPv6, for both the apex and `www`,
pointing at this server's address. Wait for it to resolve before going further — certbot's
first check is a real DNS lookup, and a failed issuance leaves rate-limit budget spent.

```bash
dig +short studio-muster.de A
dig +short www.studio-muster.de A
```

**2. The certificate.** Webroot mode works from the second domain onward because the catch-all
vhost serves `/.well-known/acme-challenge/` for hostnames no vhost claims yet — which is exactly
the state this domain is in right now. nginx keeps running.

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
                      -d studio-muster.de -d www.studio-muster.de \
                      --cert-name studio-muster.de
```

Both names go on one certificate, and `--cert-name` pins the lineage so a later `www`-only
renewal does not silently create a second one.

**3. The vhost.**

```bash
sed 's/studio-muster\.de/<their domain>/g' \
    booking-app/infrastructure/nginx/tenant-domain.conf.example > /tmp/<their domain>.conf
sudo cp /tmp/<their domain>.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/<their domain>.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The template repeats no `upstream` block and no `map` — both live in `booking.conf` at the same
`http` level, and duplicating either makes nginx refuse to start.

**4. Register the hostname.** As an `OWNER` of that organization, signed in to the office:

```
POST /api/office/domains   { "hostname": "studio-muster.de", "isPrimary": true }
POST /api/office/domains   { "hostname": "www.studio-muster.de" }
DELETE /api/office/domains/:id
GET  /api/office/domains
```

The API normalizes what it stores — lowercase, punycode, no scheme, no port, no trailing dot —
so `https://Studio-Muster.DE/` and `studio-muster.de.` both become `studio-muster.de`. A
hostname belongs to exactly one organization, enforced by a unique index; a second claim is
refused with 409 `ORGANIZATION_DOMAIN_TAKEN` whether the holder is the caller's own
organization or somebody else's. The central address cannot be claimed at all. Both the
addition and the removal are written to the audit log.

**5. Check it.** The first call must answer with that organizer's services and no query
parameter anywhere; the second must be refused.

```bash
curl -s https://studio-muster.de/api/public/organizations/current | jq .slug
curl -s -o /dev/null -w '%{http_code}\n' \
     'https://studio-muster.de/api/public/services?organizer=some-other-slug'   # 200, still theirs
curl -s -H 'Host: not-registered.example' \
     'https://<central hostname>/api/public/services?organizer=studio-muster'   # 404
```

**What still points at the central address.** Manage links in confirmation emails, password
reset links, and the URLs Stripe returns a customer to after checkout are all built from
`PUBLIC_WEB_ORIGIN`, which is one origin for the whole deployment. A customer who booked on
`studio-muster.de` therefore lands back on the central hostname with `?organizer=` appended.
That works, and it is deliberate — carrying per-organizer origins through the mail templates
and the Stripe return-URL allow-list is a separate change.

**Removing a domain.** Delete the row first (`DELETE /api/office/domains/:id`), then the vhost,
then let the certificate lapse. In that order: a vhost still serving a hostname whose row is
gone falls through to the default organizer, which is wrong but harmless, whereas a row still
present for a hostname somebody else has since taken is a domain we resolve to a tenant on
behalf of a stranger.

---

## Runbook: automatic deployment (stage and dev)

Stage and dev deploy themselves from a green pipeline. Production does not — see the manual
runbook below.

| Merge into | Deploys to | Hostname                        |
| ---------- | ---------- | ------------------------------- |
| `main`     | `stage`    | `stage.buchung.shapeandflow.de` |
| `fusion`   | `dev`      | `dev.buchung.shapeandflow.de`   |

`.github/workflows/ci.yml` calls `.github/workflows/deploy.yml` as its last job, with
`needs` naming every other job. A deployment cannot outrun the tests.

> **A branch only deploys once it carries these workflow files.** For a `push` event GitHub
> runs the workflow from the ref that was pushed, not from the default branch — so a `fusion`
> branched before this landed triggers nothing at all, not even CI, because its own `ci.yml`
> still lists only `main`. Merge `main` into it once and every later push deploys. The same
> applies to any new deploy branch: add it to the triggers *and* to the `if` on the `deploy`
> job, then get that commit onto the branch.

**Nothing is built on the server.** The runner builds all four images and pushes them to
`ghcr.io/<owner>/sf-booking-{api,worker,migrate,web}`, tagged with the commit sha.
`docker-compose.registry.yml` overlays `docker-compose.prod.yml` to replace every `build:`
with that image and `pull_policy: always`, so the server pulls or stops — it never falls back
to compiling on two shared cores while another environment is serving.

On the server the workflow copies both compose files into `/opt/booking/<env>/`, writes
`.env.<env>` there from the environment secret at mode 600, then pulls, starts the data
stores, runs `migrate` to completion, starts the rest, and finally checks
`/api/health/ready` and one SPA deep link. A failure prints `compose ps` and 200 log lines.

`IMAGE_TAG` and `GHCR_OWNER` are written into `.env.<env>` rather than exported, so the file
on the server always records which commit is running:

```bash
# sudo, not because of the directory but because the file is mode 600 and owned by `deploy`.
ssh -t robert@<host> 'sudo grep IMAGE_TAG /opt/booking/stage/.env.stage'
```

### What it needs configured

Repository variables `DEPLOY_HOST`, `DEPLOY_USER`, `SSH_KNOWN_HOSTS`; repository secret
`SSH_PRIVATE_KEY`; and an **environment** secret `ENV_FILE` in each of `stage` and `dev`
holding the whole env file. Same secret name in both environments, which is why the workflow
never branches to find it.

The two environments carry deliberately different branch policies. `stage` accepts only
`main`, so no stray trigger and no hand-dispatch can reach its secret from a feature branch.
`dev` accepts **all** branches, which is what makes the manual dispatch below useful — dev is
the environment meant to be thrown a branch. The asymmetry is enforced twice: by the
environment policy, and by a guard in the workflow's `prepare` job that refuses a stage
deploy from any ref other than `main` before four images are built.

`SSH_KNOWN_HOSTS` is a variable, not a secret, deliberately: the host key is public
information, and as a secret it would be masked to `***` in exactly the logs where an SSH
failure has to be read.

### First deployment of an environment

Two things the workflow will not do for you.

The placeholder services still hold the ports, and `up` fails with *port is already
allocated*. Retire the pair for that environment first:

```bash
sudo systemctl disable --now placeholder@booking-stage-web placeholder@booking-stage-api
```

And an empty database needs seeding once, because the API refuses to start until
`DEFAULT_ORGANIZATION_SLUG` resolves. Seeding is not automatic — on every push it would
quietly overwrite whatever staging data exists:

```bash
gh workflow run deploy.yml -f env_name=stage -f seed=true
```

### Redeploy, and rollback without a build

```bash
gh workflow run deploy.yml -f env_name=stage                      # same commit again
gh workflow run deploy.yml -f env_name=stage -f image_tag=<sha>   # an older image
```

Passing `image_tag` skips the build job entirely: the images for that sha are already in the
registry, and rebuilding them would defeat the point of naming a known-good one. The schema
caveats in [Runbook: rollback](#runbook-rollback) apply unchanged — rolling back images does
not roll back migrations.

---

## Runbook: routine deployment

This is the **production** path, and the one to use on any host that has no workflow pointed
at it. Stage and dev are deployed by the pipeline above.

```bash
git pull
export TAG=$(git rev-parse --short HEAD)

docker build -f booking-app/apps/api/Dockerfile --target api     -t sf-booking-api:$TAG     .
docker build -f booking-app/apps/api/Dockerfile --target worker  -t sf-booking-worker:$TAG  .
docker build -f booking-app/apps/api/Dockerfile --target migrate -t sf-booking-migrate:$TAG .
docker build -f booking-app/apps/web/Dockerfile                  -t sf-booking-web:$TAG     .

sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$TAG/" booking-app/.env.production

booking-app/infrastructure/scripts/backup.sh

docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml up -d --wait
```

Back up **before** deploying, not after. The backup you want during a bad deploy is the one
taken before it.

`up -d --wait` recreates only the containers whose image or configuration changed, runs the
migrate container to completion first, and returns when the API reports ready. If it returns
non-zero, nothing has been declared healthy — read the logs before doing anything else:

```bash
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml logs --tail=200 migrate api
```

---

## Runbook: rollback

**Migrations are forward-only.** There are no down migrations in this project and there will
not be. A down migration is written before anyone knows what the data will look like when it
runs, and the moment it is needed is the moment that guess is tested against production for
the first time.

So a rollback rolls back **images**, not the schema:

```bash
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<previous tag>/" booking-app/.env.production
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml up -d --wait
```

On stage and dev the same thing is one command, and it skips the build:

```bash
gh workflow run deploy.yml -f env_name=stage -f image_tag=<previous sha>
```

This works whenever the newer migration was **additive** — a new column, a new table —
because the older code simply does not use it. Design migrations that way and rollback stays
a one-line change. Expand first, contract in a later release, once no running image needs the
old shape.

**A new enum value is the exception.** It is additive in the schema and not additive in the
data: while the newer image ran it wrote rows carrying that value, and the older image has no
branch for it. Depending on how the value reaches the old code that is a Prisma validation
error on read, or worse, a `switch` falling through to a default that treats a cancelled
booking as a live one. So before treating an enum addition as rollback-safe, check what the
previous image does with a row holding the new value. If the answer is not "handles it
correctly", the rollback is the destructive case below: restore the pre-deploy backup, or
avoid the situation in the first place by adding the value in one release and only writing it
in the next.

### When a migration really must be reversed

Only when the schema change was destructive (a dropped column, a narrowed type, a rewritten
value) does the schema itself have to go back. There is no automated path, and there should
not be: the choice is always between losing the writes made since the migration and keeping
a schema that the previous image cannot read.

1. Stop the application: `docker compose ... stop api worker`. Do this first. Every second
   it runs adds writes that a restore will discard.
2. Decide, explicitly, what happens to the writes made since the migration. Export them if
   they matter — that export is usually the real work.
3. Restore the pre-deploy backup: `booking-app/infrastructure/scripts/restore.sh <dump> --force`
4. Set `IMAGE_TAG` back and bring the stack up.
5. Write the corrective forward migration. The reverted one stays in history; a migration
   that has run in production is never edited, because other databases have already applied it.

---

## Runbook: rotating Stripe keys with no downtime

The two secrets rotate differently. The API key can be swapped whenever; the webhook secret
cannot, because a webhook signed with a secret the API does not yet hold is rejected — and a
rejected `checkout.session.completed` is a customer who paid and has no booking.

### `STRIPE_SECRET_KEY`

1. Create a new restricted key in the Stripe dashboard, alongside the old one.
2. Put it in `booking-app/.env.production`.
3. `docker compose ... up -d --wait api worker` — this recreates both processes with the new
   value. In-flight requests drain first; the API waits up to 25 seconds for them.
4. Confirm a booking end to end.
5. Revoke the old key in Stripe, and not before step 4.

### `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`

Stripe allows several endpoints, each with its own secret. That is the whole trick — rotate by
moving to a new endpoint, not by re-keying the old one.

The two secrets rotate independently and by the same procedure. Substitute the Connect
destination and `/api/webhooks/stripe/connect` throughout when rotating that one; nothing else
differs.

**There is a gap, and the swap is planned around it rather than pretended away.** The API
verifies each route against exactly one secret, so whichever endpoint is not the one that
secret belongs to has its deliveries rejected with a 4xx. Gapless rotation would need
the verifier to accept either secret for the length of the window, and it does not. So do
this at a quiet minute, keep the two steps close together, and replay what fell in between.

1. In Stripe, add a **second** endpoint pointing at the same URL, subscribed to the same
   events. Note its signing secret. Stripe starts delivering to it immediately, and those
   deliveries are rejected until step 2 — expected, and replayed in step 5.
2. Set `STRIPE_WEBHOOK_SECRET` to the new one and recreate the API. From here it is the
   **old** endpoint's deliveries that are rejected instead.
3. Disable the old endpoint. Stripe stops sending to it.
4. Watch for rejected webhooks for a few minutes:

   ```bash
   curl -fsS -b <office session cookie> http://127.0.0.1:3001/api/health/detail | jq .unprocessedWebhooks
   ```

5. Replay everything rejected during the swap from the Stripe dashboard: **Developers →
   Events → Resend**. That means both directions — the new endpoint's deliveries from before
   step 2, and the old endpoint's from between steps 2 and 3. The API is idempotent per
   Stripe event id, so replaying an event that did land changes nothing.
6. Delete the old endpoint.

Rotating `RESEND_WEBHOOK_SECRET` and `TWILIO_AUTH_TOKEN` follows the same shape: add the new
credential, swap, verify, then remove the old. A delivery receipt lost in the gap costs a
`status` column that stays `SENT` — recoverable, unlike a payment.

---

## Backups

### Schedule

`backup.sh` takes a `pg_dump -Fc`, reads the archive back to verify it, and prunes. Run it
nightly from the host's crontab, before the 03:00 sweeps:

```cron
30 2 * * * cd /srv/shape-and-flow && ./booking-app/infrastructure/scripts/backup.sh >> /var/log/booking-backup.log 2>&1
```

It exits non-zero on any failure, so cron mail — or whatever watches that log — is the alert.
A silent backup script is indistinguishable from a working one.

Defaults, all overridable by environment variable:

| Variable         | Default          | Meaning                                        |
| ---------------- | ---------------- | ---------------------------------------------- |
| `BACKUP_DIR`     | `./backups`      | where dumps are written                        |
| `RETENTION_DAYS` | `14`             | dumps older than this are pruned…              |
| `KEEP_MINIMUM`   | `7`              | …but never below this many, whatever their age |

The minimum matters: if backups have been failing for three weeks, pruning by age alone would
delete the last good one on the day it is needed.

**Copy the dumps off this machine.** A backup on the same disk as the database survives a
mistake, not a disk. That copy is out of scope here and is not optional.

### What "verified" means

Each dump has its table of contents read back with `pg_restore --list` and is checked for a
plausible object count and for `bookings_no_overlap` by name. A dump that fails is deleted
rather than left on disk looking reassuring. Dumps are written to a `.partial` name and
renamed only on success, so the directory never holds a file a restore could pick up
mid-write.

### The restore drill

Do this quarterly, on a machine that is not the server. It takes ten minutes and it is the
only evidence that any of the above works.

```bash
# A throwaway stack, from the same compose file.
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml up -d --wait postgres

# Restore into it and confirm it still enforces what it should.
booking-app/infrastructure/scripts/restore.sh backups/<newest>.dump --force

# The constraints, from the outside.
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml exec -T postgres \
  psql -U booking -d booking -c \
  "SELECT conname FROM pg_constraint WHERE conname LIKE '%no_overlap';"
```

Two rows. `restore.sh` already runs the full inventory —
`infrastructure/sql/constraint-inventory.sql`, eighteen constraints and fourteen indexes — and
refuses to declare success if any is missing, including checking that
`bookings_no_overlap` still names all three blocking statuses.

`restore.sh` will not touch a database that already has tables unless given `--force`, and it
stops `api` and `worker` before restoring and does **not** start them again. Half a schema
behind a live application is worse than an outage.

---

## Incident: a customer paid but there is no booking

The one that matters. Work in this order.

**1. Is it actually missing, or is it just not confirmed yet?** Find the booking by the
customer's email in the office area. A booking in `PENDING_PAYMENT` or `EXPIRING` is one whose
webhook has not landed yet — which is normal for a few seconds and abnormal after a minute.

**2. Did Stripe try to tell us?** In the Stripe dashboard, find the payment, then its
`checkout.session.completed` event, and look at the delivery attempts.

- **Delivered, 2xx** — we received it. Go to step 3.
- **Failed, 4xx** — the signature was rejected. Almost always the endpoint's secret is wrong
  or was rotated without the swap above; check that the Connect destination points at
  `/api/webhooks/stripe/connect` with `STRIPE_CONNECT_WEBHOOK_SECRET` and the platform one at
  `/api/webhooks/stripe` with `STRIPE_WEBHOOK_SECRET`, since a destination aimed at the other
  route fails every delivery. Fix the secret, then **Resend** the event.
- **Failed, 5xx or timeout** — we were down. Stripe retries for days; the event will land on
  its own. **Resend** to make it now.

**3. It arrived — where did it stop?**

```bash
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml exec -T postgres \
  psql -U booking -d booking -c \
  "SELECT stripe_event_id, type, received_at, processed_at, attempts, last_error
     FROM stripe_webhook_events
    WHERE processed_at IS NULL
    ORDER BY received_at DESC LIMIT 20;"
```

An unprocessed row means the event committed to Postgres but its job never reached Redis — the
one gap no transaction can span. `sweep.inbox` re-drives it every two minutes; a row is
considered stalled after five and is retried up to ten times, after which it is reported and
left alone. So:

- **Row present, `attempts` climbing, `last_error` set** — the handler is failing. Read the
  error; that is the bug.
- **Row present, `attempts` 0, older than five minutes** — the worker is not running. Check
  `docker compose ... ps worker` and its logs.
- **No row at all** — we never received it, whatever the dashboard says. Resend.

**4. Nothing worked and the customer is waiting.** Create the booking manually in the office
area and record the payment as a manual payment with the Stripe reference in the note. The
booking is what the customer needs; the reconciliation is bookkeeping, and the audit trail
records who did it and why.

## Incident: bookings stuck in `EXPIRING`

`EXPIRING` is the state a reservation enters while its payment window closes — deliberately
distinct from `EXPIRED`, so a customer who pays a moment late keeps their appointment instead
of being refunded and re-booked.

Stuck means the sweep is not running.

```bash
curl -fsS -b <office session cookie> http://127.0.0.1:3001/api/health/detail | jq '{oldestExpiring, failedJobs, queues}'
```

If `oldestExpiring` is older than a few minutes:

1. Is the worker up? `docker compose ... ps worker`
2. Is Redis up? `/api/health/ready` names it if not.
3. Are jobs failing rather than not running? `failedJobs` above, and the worker's logs.
4. Do the API and the worker agree on `REDIS_QUEUE_PREFIX`? If they disagree the workers
   consume nothing, silently, and every queue depth grows while nothing errors. Both read the
   same env file, so this only happens if one was started with an override.

Restarting the worker re-installs every repeatable schedule on boot:

```bash
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml restart worker
```

## Incident: a subject-access or erasure request

**Access.** Everything held about one person is reachable from their customer record in the
office area: their details, every appointment, what they paid and what was refunded. Export
the range that covers them (Exports → Appointments and Money) and send the rows that are
theirs.

**Erasure.** Office → Customers → Erase. It pseudonymises the person — name, email and phone
are replaced and cannot be recovered — and **keeps their bookings**, because those are the
business's own record of what it sold and are subject to statutory retention. The confirmation
says so in those words for a reason: "delete customer" would suggest the appointments go too.

It is refused while a payment or refund is still unsettled. Settle it, then erase.

Beyond that, the `sweep.retention` job applies `dataRetentionDays` from the office settings
every night at 03:30 Berlin. Erasure is the answer to a request; retention is the answer to
not being asked.

---

## Where to look

```bash
# Everything, following.
docker compose --env-file booking-app/.env.production \
               -f booking-app/docker-compose.prod.yml logs -f

# One process, last 200 lines.
docker compose ... logs --tail=200 api

# One request, end to end. The id is in the response header and in every line the
# request produced, including the worker's if it enqueued something.
docker compose ... logs api | grep <request id>
```

Logs are JSON, one line per request, rotated at 10 MB × 10 files per container. `LOG_LEVEL`
and `LOG_SAMPLE_RATE` are in the env file; sampling applies only to
`GET /public/availability`, which is polled on every date change a browsing customer makes and
would otherwise dominate the volume.

The edge nginx logs separately, in `/var/log/nginx/booking.access.log`. A request that appears
there and not in the API log never reached the API.

---

## More than one environment

The stack is parameterized on a single variable, `STACK_SUFFIX`, which defaults to
`production` so every command in this document works unchanged. It is substituted into the
three things that are not otherwise unique per environment:

- the compose **project name**, which is what scopes the named volumes
- every **`container_name`**. These are global to the Docker daemon, so without the suffix a
  second stack fails with `container name is already in use`
- the **`env_file`** each container reads, so a stage deploy cannot be handed production's
  secrets

Ports are already variables (`API_PUBLISH_PORT`, `WEB_PUBLISH_PORT`), so an environment is one
more env file plus one variable in it. For a stage environment, `booking-app/.env.stage`:

```
STACK_SUFFIX=stage
API_PUBLISH_PORT=3011
WEB_PUBLISH_PORT=8081
```

then the usual command against that file:

```bash
docker compose --env-file booking-app/.env.stage \
               -f booking-app/docker-compose.prod.yml up -d --wait
```

`STACK_SUFFIX` has to be written **in the env file**, not only exported in the shell: compose
resolves `${...}` from `--env-file`.

The port map in use on the server:

| Environment | Suffix       | API    | Web    |
| ----------- | ------------ | ------ | ------ |
| production  | `production` | `3001` | `8080` |
| stage       | `stage`      | `3011` | `8081` |
| dev         | `dev`        | `3021` | `8082` |

Each environment gets its own Postgres and Redis inside its own project, and its own named
volumes. `docker compose ... down -v` in one environment cannot reach another's data.
