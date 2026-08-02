#!/usr/bin/env bash
#
# Take a verified backup of the production database.
#
#     booking-app/infrastructure/scripts/backup.sh
#
# Environment:
#   ENV_FILE        default booking-app/.env.production
#   BACKUP_DIR      default ./backups
#   RETENTION_DAYS  default 14 — older dumps are pruned
#   KEEP_MINIMUM    default 7  — never prune below this many, whatever their age
#
# ── What "verified" means ───────────────────────────────────────────────────
#
# An unverified backup is not a backup, it is a file. Every dump this script keeps has
# had its table of contents read back and checked for the objects that matter, and a
# dump that fails any of that is deleted rather than left on disk looking reassuring.
#
# It is written to a `.partial` name and renamed only once it has passed. A crash, a
# full disk or a killed container therefore leaves no file that a restore could pick
# up — the directory only ever contains dumps that were complete when they were named.
set -Eeuo pipefail

# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

RETENTION_DAYS="${RETENTION_DAYS:-14}"
KEEP_MINIMUM="${KEEP_MINIMUM:-7}"

require_environment

mkdir -p "$BACKUP_DIR"

# UTC, and sortable. A backup named in local time reorders itself twice a year, which is
# precisely the property a restore must not have.
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/booking-$stamp.dump"
partial="$target.partial"

cleanup() {
  rm -f "$partial"
}
trap cleanup EXIT

# Braces are not decoration: bash in a UTF-8 locale reads the bytes of the following
# ellipsis as part of the variable name, and `set -u` then aborts on a name nobody typed.
note "Dumping ${POSTGRES_DB} as ${POSTGRES_USER}…"

# Custom format, compressed. `-Fc` is what allows selective restore and, more to the
# point here, what allows the table of contents to be read back without restoring.
compose exec -T postgres \
  pg_dump --format=custom --compress=9 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >"$partial"

[ -s "$partial" ] || die 'pg_dump produced an empty file.'

note 'Verifying the archive…'

listing="$(compose exec -T postgres pg_restore --list <"$partial")" \
  || die 'pg_restore could not read the archive back. The dump is unusable and has been deleted.'

# A dump can be readable and still be wrong. Two independent checks on the contents:
# a plausible number of objects, and the presence by name of the constraint whose loss
# is the specific accident this project worries about.
entries="$(printf '%s\n' "$listing" | grep -c '^[0-9]' || true)"
[ "$entries" -ge 50 ] \
  || die "the archive lists only $entries objects, which is too few to be this schema."

printf '%s\n' "$listing" | grep -q 'bookings_no_overlap' \
  || die 'the archive does not contain bookings_no_overlap. A restore from it would allow double bookings.'

mv "$partial" "$target"
chmod 600 "$target"
trap - EXIT

size="$(du -h "$target" | cut -f1)"
note "Wrote $target ($size, $entries objects)."

# ── Retention ───────────────────────────────────────────────────────────────
#
# Age alone is not enough. If backups have been failing for three weeks, pruning by age
# would delete the last good one on the day it is needed — so the newest KEEP_MINIMUM
# survive regardless of age, and only what is both old and surplus is removed.
keep="$(ls -1t "$BACKUP_DIR"/booking-*.dump 2>/dev/null | head -n "$KEEP_MINIMUM" || true)"
pruned=0

while IFS= read -r old; do
  [ -n "$old" ] || continue
  if printf '%s\n' "$keep" | grep -qxF "$old"; then continue; fi
  rm -f "$old"
  pruned=$((pruned + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'booking-*.dump' -mtime +"$RETENTION_DAYS")

remaining="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'booking-*.dump' | wc -l | tr -d ' ')"
note "Pruned $pruned dump(s) older than $RETENTION_DAYS days; $remaining remain."
