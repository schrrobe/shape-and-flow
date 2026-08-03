# Shared setup for backup.sh and restore.sh. Sourced, never executed.
#
# It exists so the two scripts cannot disagree about which database they are talking to.
# A backup that reads one database and a restore that writes another is a failure nobody
# discovers until the day it matters.

# Repository root: scripts → infrastructure → booking-app → root.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

COMPOSE_FILE="$REPO_ROOT/booking-app/docker-compose.prod.yml"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/booking-app/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
INVENTORY_SQL="$REPO_ROOT/booking-app/infrastructure/sql/constraint-inventory.sql"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*" >&2
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# Read one variable out of the env file.
#
# Parsed rather than sourced. Sourcing a file to read two values also executes anything
# else in it, and this one is edited by hand on a server under time pressure.
env_value() {
  sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

require_environment() {
  command -v docker >/dev/null 2>&1 || die 'docker is not on PATH.'
  [ -f "$ENV_FILE" ] || die "no environment file at $ENV_FILE (copy booking-app/.env.production.example)."
  [ -f "$COMPOSE_FILE" ] || die "no compose file at $COMPOSE_FILE."

  POSTGRES_USER="$(env_value POSTGRES_USER)"
  POSTGRES_DB="$(env_value POSTGRES_DB)"

  [ -n "$POSTGRES_USER" ] || die "POSTGRES_USER is not set in $ENV_FILE."
  [ -n "$POSTGRES_DB" ] || die "POSTGRES_DB is not set in $ENV_FILE."

  compose ps --status running --services 2>/dev/null | grep -qx postgres \
    || die "the postgres container is not running. Start the stack first."
}

# psql with errors that stop the script. Without ON_ERROR_STOP, psql reports a failed
# statement on stderr and still exits 0 — which would make a broken restore look clean.
psql_admin() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
}
