# Where production lives. Copy to `deploy.config.sh` and fill in.
#
# NOT COMMITTED. The real file is gitignored, because this repository is public
# and a server's address, its account name and its directory layout are a map
# of the box for anyone who reads them. None of it is a credential — SSH is
# key-only and Postgres is firewalled — but there is no reason to publish the
# floor plan.
#
# It is rsynced to the server by deploy.sh (which excludes .env, not this), so
# the scripts that run THERE — backup.sh, restore-check.sh — find it too.

# SSH alias from your ~/.ssh/config. An alias rather than a host, so the
# address, port and user live in your SSH config and not in this project.
# The SSH alias or user@host. Set it UNCONDITIONALLY.
#
# Do not write `HOST="${HOST:-your-alias}"` to make it overridable: zsh — the
# default shell on macOS — sets HOST to the local machine name, so the fallback
# never fires and every script quietly tries to deploy to your laptop. That
# cost a confused "could not resolve hostname" halfway through an rsync. If you
# want an override, use a namespaced variable no shell owns.
HOST="your-ssh-alias"

# Where the application and the built frontend live on the server.
APP_DIR="/srv/example/app"
WEB_DIR="/srv/example/web"

# Node on the server. nvm installs outside PATH for non-interactive ssh, so
# the absolute path is needed.
NVM_DIR="/home/example/.nvm"
NODE_VERSION="20.20.2"
NODE_BIN="$NVM_DIR/versions/node/v$NODE_VERSION/bin/node"

# Data that must outlive a deploy: uploaded bytes, and the nightly dumps.
DATA_DIR="/srv/example/data"
BACKUP_DIR="$DATA_DIR/backups"
UPLOAD_DIR="$DATA_DIR/uploads"

# What deploy.sh polls to decide the release is healthy.
HEALTH_URL="http://example.invalid:8100/healthz"
