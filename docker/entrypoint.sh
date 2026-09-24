#!/bin/sh
#
# Container entrypoint.
#
#   web              prisma db push, then the Next.js server (default)
#   worker           the Terraform job worker
#   migrate          prisma db push only
#   seed EMAIL PASS  create or reset an administrator
#   <anything else>  exec'd as-is, e.g. `sh` or `terraform version`
#
# Runs as root just long enough to create the data directories and hand them
# to the `node` user, then drops privileges for the actual process.
set -eu

APP_USER=node
DATA_DIR="${PORTAL_DATA_DIR:-/var/lib/proxmox-portal}"
BIN=/opt/proxmox-portal/node_modules/.bin

as_app() {
  if [ "$(id -u)" = "0" ]; then
    setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups -- "$@"
  else
    "$@"
  fi
}

prepare_data_dir() {
  if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_DIR/workspaces" "$DATA_DIR/logs" "$DATA_DIR/plugin-cache" "$DATA_DIR/ssh"
    # Only touch what is not already ours: the plugin cache and workspaces can
    # be large, and a recursive chown on every start adds up.
    find "$DATA_DIR" ! -user "$APP_USER" -exec chown -h "$APP_USER:$APP_USER" {} +
    chmod 700 "$DATA_DIR/ssh"
    # ssh refuses a key that others can read.
    find "$DATA_DIR/ssh" -type f -exec chmod 600 {} +
  else
    mkdir -p "$DATA_DIR/workspaces" "$DATA_DIR/logs" "$DATA_DIR/plugin-cache"
  fi
}

# The healthcheck runs in a separate process and needs to know which role this
# container is playing.
set_role() {
  echo "$1" > /tmp/portal-role
}

cmd="${1:-web}"
[ "$#" -gt 0 ] && shift

case "$cmd" in
  web)
    prepare_data_dir
    set_role web
    # Two containers share one SQLite file; only the web container migrates,
    # and the worker waits for it to be healthy (see compose.yml).
    if [ "${PORTAL_DB_PUSH:-true}" = "true" ]; then
      as_app "$BIN/prisma" db push --skip-generate
    fi
    # Not $HOSTNAME: Docker sets that to the container ID.
    set -- "$BIN/next" start -H "${PORTAL_LISTEN_HOST:-0.0.0.0}" -p "${PORT:-3000}"
    ;;
  worker)
    prepare_data_dir
    set_role worker
    set -- "$BIN/tsx" worker/index.ts
    ;;
  migrate)
    prepare_data_dir
    set_role task
    set -- "$BIN/prisma" db push --skip-generate "$@"
    ;;
  seed)
    prepare_data_dir
    set_role task
    set -- "$BIN/tsx" scripts/seed.ts "$@"
    ;;
  *)
    set_role task
    exec "$cmd" "$@"
    ;;
esac

if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups -- "$@"
fi
exec "$@"
