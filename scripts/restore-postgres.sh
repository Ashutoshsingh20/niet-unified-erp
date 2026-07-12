#!/bin/sh
set -eu

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"

case "$TARGET_DATABASE_URL" in
  *"_restore_test"*) ;;
  *)
    if [ "${ALLOW_PRODUCTION_RESTORE:-}" != "RESTORE_APPROVED_CHANGE" ]; then
      echo "Refusing non-test restore without ALLOW_PRODUCTION_RESTORE=RESTORE_APPROVED_CHANGE" >&2
      exit 2
    fi
    ;;
esac

test -r "$BACKUP_FILE"
test -r "$BACKUP_FILE.sha256"
expected="$(sed -n 's/^SHA2-256([^)]*)= //p' "$BACKUP_FILE.sha256")"
actual="$(openssl dgst -sha256 "$BACKUP_FILE" | sed -n 's/^SHA2-256([^)]*)= //p')"
test -n "$expected"
if [ "$expected" != "$actual" ]; then
  echo "Backup checksum mismatch" >&2
  exit 3
fi

pg_restore --dbname="$TARGET_DATABASE_URL" --clean --if-exists --no-owner --no-acl --exit-on-error "$BACKUP_FILE"
