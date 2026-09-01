#!/usr/bin/env bash
# Deploys the current working tree to VPS4.
#
# Not a git-based deploy on purpose: there is no remote yet, and rsync of the
# working tree is honest about what is actually being shipped.
#
#   ./scripts/deploy.sh
set -euo pipefail

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
NODE="$NODE_BIN"

echo "==> syncing source"
# .env is excluded: production secrets live only on the server, and the local
# file points at a tunnel that does not exist there.
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist \
  --exclude .uploads --exclude .env --exclude '*.log' \
  -e ssh ./ "$HOST:$APP_DIR/"

echo "==> installing and building on the host"
# Native modules (sharp) must be built here; a node_modules copied from macOS
# will not load on Linux.
ssh "$HOST" "export NVM_DIR=$NVM_DIR; . \$NVM_DIR/nvm.sh; nvm use $NODE_VERSION >/dev/null
  cd $APP_DIR
  npm ci --no-audit --no-fund --silent
  npm run build"

echo "==> publishing the built frontend"
# Caddy runs as its own user and cannot traverse the home directory (0750),
# so the
# static bundle is published outside her home rather than opening it up.
ssh "$HOST" "rsync -a --delete $APP_DIR/dist/ $WEB_DIR/"

echo "==> applying migrations"
ssh "$HOST" "cd $APP_DIR && set -a && . ./.env && set +a && $NODE node_modules/.bin/tsx scripts/migrate.ts"

echo "==> restarting"
ssh "$HOST" "systemctl --user restart bd-portal.service"

echo "==> waiting for health"
for i in $(seq 1 15); do
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' $HEALTH_URL || true)
  if [ "$code" = "200" ]; then
    echo "healthy after ${i}s"
    curl -s -m 10 "$HEALTH_URL"
    echo
    exit 0
  fi
  sleep 1
done

echo "did not become healthy — check: ssh $HOST journalctl --user -u bd-portal -n 40" >&2
exit 1
