#!/usr/bin/env bash
#
# Restore the production database from a dump taken by backup.sh.
#
#     booking-app/infrastructure/scripts/restore.sh backups/booking-20260802T031500Z.dump
#     booking-app/infrastructure/scripts/restore.sh <dump> --force
#
# ── What it refuses to do ───────────────────────────────────────────────────
#
# Without `--force` it will not touch a database that already has tables in it. A
# restore is run under pressure, usually against the wrong terminal at least once, and
# "are you sure" is the only step between a rehearsal and losing today's bookings.
#
# It stops the api and the worker before restoring and does **not** start them again.
# Half a schema behind a live application is worse than an outage: the worker would
# start consuming jobs against tables that are being dropped and recreated underneath
# it. Bringing them back is a decision the operator takes once they have looked.
set -Eeuo pipefail

# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

DUMP=''
FORCE=0

for argument in "$@"; do
  case "$argument" in
    --force) FORCE=1 ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option: $argument" ;;
    *) DUMP="$argument" ;;
  esac
done

[ -n "$DUMP" ] || die 'usage: restore.sh <dump file> [--force]'
[ -f "$DUMP" ] || die "no such file: $DUMP"

require_environment

# ── Read the archive before believing it ────────────────────────────────────
#
# Checked here as well as in backup.sh, because the file may not have come from
# backup.sh: it may have been copied off another machine, pulled out of object storage,
# or written by a hand-run pg_dump. Finding out it is truncated after the existing
# database has been dropped is not a recoverable position.
# Braced for the same reason as in backup.sh: bash reads the ellipsis that follows as part
# of the variable name unless the name is delimited.
note "Reading ${DUMP}…"
listing="$(compose exec -T postgres pg_restore --list <"$DUMP")" \
  || die 'this file is not a readable pg_dump custom-format archive.'

printf '%s\n' "$listing" | grep -q 'bookings_no_overlap' \
  || die 'this archive has no bookings_no_overlap constraint. Restoring it would produce a database that permits double bookings.'

# ── Is the target empty? ────────────────────────────────────────────────────
tables="$(psql_admin -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" \
  | tr -d '[:space:]')"

if [ "$tables" != '0' ] && [ "$FORCE" -ne 1 ]; then
  die "$POSTGRES_DB already holds $tables tables. Re-run with --force to destroy them and restore over the top."
fi

if [ "$tables" != '0' ]; then
  note "--force given: dropping $tables existing table(s) in $POSTGRES_DB."
fi

# ── Stop the application ────────────────────────────────────────────────────
note 'Stopping api and worker…'
compose stop api worker >/dev/null

# ── Restore ─────────────────────────────────────────────────────────────────
#
# The schema is dropped and recreated rather than restored with `--clean`. `--clean`
# emits a DROP per object in dependency order, and any object the dump does not know
# about — something created by hand, something from a newer migration — survives and
# collides. Starting from an empty schema means what comes out is exactly what went in.
#
# btree_gist is installed into `public` and so goes with it; the dump recreates it.
note 'Recreating the public schema…'
psql_admin -q -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

note 'Restoring…'
# `--exit-on-error` because the default is to report errors, keep going and exit 0 —
# which would leave a partially restored database that every later check calls healthy.
# `--no-owner`/`--no-privileges` so a dump taken as one role restores as another.
compose exec -T postgres pg_restore \
  --exit-on-error --no-owner --no-privileges \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" <"$DUMP" \
  || die 'pg_restore failed. The database is in a partial state — do not start the application.'

# ── Prove it enforces what it should ────────────────────────────────────────
note 'Checking the constraint inventory…'
psql_admin -q <"$INVENTORY_SQL" \
  || die 'the restored database is missing constraints it must have. Do not start the application against it.'

note ''
note "Restored $POSTGRES_DB from $DUMP."
note 'Nothing has been started. When you are satisfied the data is right:'
note ''
note "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d --wait"
note ''
note 'That runs the migrate container first, so a dump older than the deployed images is'
note 'brought forward before either process starts.'
