#!/usr/bin/env bash
# Restores the newest dump into a scratch database and asserts it has rows.
#
# An untested backup is a belief, not a backup. Run this monthly; it never
# touches bd_portal.
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/yota/data/bd-portal/backups}"
SCRATCH="bd_portal_restorecheck"

newest="$(find "$BACKUP_DIR" -name '*.dump' -type f | sort | tail -1)"
[ -n "$newest" ] || { echo "no dump found in $BACKUP_DIR" >&2; exit 1; }
echo "restoring $newest"

# The postgres user cannot read anything under /home/yota, which is 0750 — the
# same reason Caddy could not serve dist from there. Stage the dump somewhere
# it can actually open. This failure previously surfaced as "the dump restored
# but is empty", because pg_restore's stderr was being discarded.
staged="$(mktemp /tmp/bd-restore-check-XXXXXX.dump)"
cp "$newest" "$staged"
chmod 0644 "$staged"
trap 'rm -f "$staged"' EXIT

sudo -u postgres dropdb --if-exists "$SCRATCH"
sudo -u postgres createdb "$SCRATCH"

# Errors are shown, never swallowed. A restore check that hides why it failed
# is worse than no check at all.
if ! sudo -u postgres pg_restore --no-owner --dbname="$SCRATCH" "$staged"; then
  echo "pg_restore reported errors (see above)" >&2
fi

count() {
  sudo -u postgres psql -tAd "$SCRATCH" -c "$1" 2>/dev/null | tr -d '[:space:]' || echo 0
}
clients=$(count 'select count(*) from clients')
content=$(count 'select count(*) from content_items')
users=$(count 'select count(*) from "user"')

sudo -u postgres dropdb --if-exists "$SCRATCH"

echo "restored: clients=${clients:-0} content_items=${content:-0} users=${users:-0}"
if [ "${clients:-0}" -gt 0 ] && [ "${users:-0}" -gt 0 ]; then
  echo "RESTORE CHECK PASSED"
else
  echo "RESTORE CHECK FAILED — the dump restored but is empty" >&2
  exit 1
fi
