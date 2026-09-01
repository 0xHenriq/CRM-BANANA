#!/usr/bin/env bash
# Forwards VPS4's Postgres (bound to 127.0.0.1:5432 there) to localhost:55432.
# Postgres is deliberately not exposed on VPS4's public interface — this tunnel
# is how local development reaches it without widening that.
#
# Reconnects on drop. A bare `ssh -N -L` dies quietly on any network blip, and
# the first symptom is the API refusing to boot with ECONNREFUSED several
# minutes later — which reads like an application bug and is not one.
#
# Usage: npm run db:tunnel   (leave running in its own terminal)
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

LOCAL_PORT="${LOCAL_PORT:-55432}"

if lsof -iTCP:"$LOCAL_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "port $LOCAL_PORT is already in use — tunnel probably already running"
  exit 0
fi

echo "tunnelling localhost:$LOCAL_PORT -> $HOST:5432 (ctrl-c to stop)"
trap 'echo; echo "tunnel closed"; exit 0' INT TERM

while true; do
  ssh -N \
    -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -L "$LOCAL_PORT:127.0.0.1:5432" "$HOST"
  echo "tunnel dropped; reconnecting in 3s…" >&2
  sleep 3
done
