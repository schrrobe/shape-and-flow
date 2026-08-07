#!/usr/bin/env bash
set -euo pipefail

umask 077

unleash_root=${UNLEASH_ROOT:-/opt/unleash}
backup_dir=${UNLEASH_BACKUP_DIR:-$unleash_root/backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary_file=$backup_dir/.unleash-$timestamp.sql.gz.tmp
final_file=$backup_dir/unleash-$timestamp.sql.gz

mkdir -p "$backup_dir"
trap 'rm -f "$temporary_file"' EXIT

cd "$unleash_root"
docker compose --env-file .env -f compose.yml exec -T postgres \
  sh -ceu 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=plain' \
  | gzip -9 > "$temporary_file"

test -s "$temporary_file"
mv "$temporary_file" "$final_file"
find "$backup_dir" -type f -name 'unleash-*.sql.gz' -mtime +7 -delete

printf 'Backup written: %s\n' "$final_file"
