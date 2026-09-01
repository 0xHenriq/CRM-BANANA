#!/usr/bin/env bash
# Nightly backup: a custom-format pg_dump plus a snapshot of the uploads.
#
# Retention is 30 days. Both parts matter — a database without its uploaded
# files restores to a portal full of broken images, and files without the
# database restore to nothing that references them.
#
# IMPORTANT: this writes to the SAME DISK as the data it protects, so it
# survives an application mistake but not a disk failure. Copying
# the backup directory somewhere else is the missing half; see
# the deploy notes in README.md.
set -uo pipefail

# Where production lives. Kept out of this repository — see
# deploy.config.example.sh. Sourced relative to this script so it works the
# same from a laptop, from cron on the server, and from a systemd timer.
CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy.config.sh"
if [ ! -f "$CONFIG" ]; then
  echo "Missing $CONFIG — copy deploy.config.example.sh and fill it in." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$CONFIG"

KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y-%m-%d-%H%M)"

mkdir -p "$BACKUP_DIR"

# shellcheck source=/dev/null
set -a; . "$APP_DIR/.env"; set +a

if [ -z "${DATABASE_URL_OWNER:-}" ]; then
  echo "DATABASE_URL_OWNER is not set; refusing to run" >&2
  exit 1
fi

db_out="$BACKUP_DIR/bd_portal-$STAMP.dump"
if pg_dump --format=custom --no-owner --dbname="$DATABASE_URL_OWNER" --file="$db_out"; then
  echo "database -> $db_out ($(du -h "$db_out" | cut -f1))"
else
  echo "pg_dump FAILED" >&2
  exit 1
fi

files_out="$BACKUP_DIR/uploads-$STAMP.tar.zst"
if tar -C "$(dirname "$UPLOAD_DIR")" -cf - "$(basename "$UPLOAD_DIR")" | zstd -q -o "$files_out"; then
  echo "uploads  -> $files_out ($(du -h "$files_out" | cut -f1))"
else
  echo "uploads snapshot FAILED" >&2
  exit 1
fi

find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.tar.zst' \) -mtime "+$KEEP_DAYS" -delete
echo "kept $(find "$BACKUP_DIR" -type f | wc -l) files, pruning older than ${KEEP_DAYS}d"
