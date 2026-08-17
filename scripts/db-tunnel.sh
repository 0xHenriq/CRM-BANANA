#!/usr/bin/env bash
# Forwards VPS4's Postgres (bound to 127.0.0.1:5432 there) to localhost:55432.
# Postgres is deliberately not exposed on VPS4's public interface — this tunnel
# is how local development reaches it without widening that.
#
# Usage: npm run db:tunnel   (leave running in its own terminal)
set -euo pipefail
LOCAL_PORT="${LOCAL_PORT:-55432}"

if lsof -iTCP:"$LOCAL_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "port $LOCAL_PORT is already in use — tunnel probably already running"
  exit 0
fi

echo "tunnelling localhost:$LOCAL_PORT -> vps4:5432 (ctrl-c to stop)"
exec ssh -N -L "$LOCAL_PORT:127.0.0.1:5432" vps4
