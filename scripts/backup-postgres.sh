#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIRECTORY:?BACKUP_DIRECTORY is required}"

umask 077
mkdir -p "$BACKUP_DIRECTORY"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$BACKUP_DIRECTORY/niet-erp-$timestamp.dump"
temporary="$backup.partial"

if [ -e "$backup" ] || [ -e "$temporary" ]; then
  echo "A backup for timestamp $timestamp already exists" >&2
  exit 4
fi

cleanup() { rm -f "$temporary"; }
trap cleanup EXIT HUP INT TERM

pg_dump --dbname="$DATABASE_URL" --format=custom --compress=9 --no-owner --no-acl --file="$temporary"
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$backup"
openssl dgst -sha256 "$backup" >"$backup.sha256"
chmod 600 "$backup" "$backup.sha256"
trap - EXIT HUP INT TERM
printf '%s\n' "$backup"
