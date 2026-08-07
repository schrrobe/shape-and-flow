# Unleash operations

The production stack runs from `/opt/unleash` on the Hostinger VPS. Docker publishes Unleash
only on `127.0.0.1:4242`; host Nginx is the sole public ingress at
`https://unleash.shapeandflow.de`.

## Start or update

```bash
cd /opt/unleash
docker compose --env-file .env -f compose.yml pull
docker compose --env-file .env -f compose.yml up -d --wait
docker compose --env-file .env -f compose.yml ps
```

The `.env` and `credentials.env` files are mode `0600`, owned by `robert`, and never belong in
Git. `credentials.env` is the recovery handoff for the administrator login and the six SDK
tokens.

## Backup and restore

Create a compressed SQL backup:

```bash
/opt/unleash/backup.sh
```

Restore into a stopped application container after verifying the target database and backup:

```bash
cd /opt/unleash
docker compose --env-file .env -f compose.yml stop unleash
gzip -dc backups/unleash-YYYYMMDDTHHMMSSZ.sql.gz \
  | docker compose --env-file .env -f compose.yml exec -T postgres \
      psql --username unleash --dbname unleash
docker compose --env-file .env -f compose.yml start unleash
```

Local backups older than seven days are removed after each successful run. Copy backups off the
VPS before relying on them for disaster recovery.

## Health and logs

```bash
curl -fsS https://unleash.shapeandflow.de/health
cd /opt/unleash
docker compose --env-file .env -f compose.yml ps
docker compose --env-file .env -f compose.yml logs --tail=200 unleash postgres
```

Unleash OSS uses project `default`. Dev and stage tokens are scoped to `development`; production
tokens are scoped to `production`. Applications additionally send `deployment=dev`,
`deployment=stage`, or `deployment=production` in the evaluation context.

