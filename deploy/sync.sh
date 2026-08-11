#!/usr/bin/env bash
#
# Push the working tree from the PVE host into the portal container and
# rebuild. Used during development; a production install clones from GitHub
# instead (see deploy/install.md).
#
#   ./deploy/sync.sh            sync + npm install + build
#   ./deploy/sync.sh --no-build sync only
#
set -euo pipefail

CTID="${PORTAL_CTID:-131}"
DEST="/opt/proxmox-portal"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> syncing $SRC -> CT $CTID:$DEST"
tar -C "$SRC" \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=.git \
  --exclude='*.db*' \
  -cf - . \
| pct exec "$CTID" -- bash -c "mkdir -p $DEST && tar -C $DEST -xf -"

# The env file lives on the data volume, not in the repo; link it in so Next
# and the worker both find it without a copy that can drift.
pct exec "$CTID" -- ln -sf /var/lib/proxmox-portal/portal.env "$DEST/.env"

if [[ "${1:-}" == "--no-build" ]]; then
  echo "==> synced (build skipped)"
  exit 0
fi

echo "==> npm install"
pct exec "$CTID" -- bash -lc "cd $DEST && npm install --no-audit --no-fund"

echo "==> prisma db push"
pct exec "$CTID" -- bash -lc "cd $DEST && npx prisma db push --skip-generate"

echo "==> build"
pct exec "$CTID" -- bash -lc "cd $DEST && npm run build"

echo "==> restarting services"
pct exec "$CTID" -- bash -lc \
  "systemctl restart proxmox-portal-web proxmox-portal-worker 2>/dev/null || true"

echo "==> done"
