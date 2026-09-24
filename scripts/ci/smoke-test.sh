#!/usr/bin/env bash
#
# Smoke-test a built portal image: both roles start against a fresh data
# volume, the web server answers, the schema is pushed, files end up owned by
# the unprivileged user, and the worker shuts down cleanly on SIGTERM.
#
#   scripts/ci/smoke-test.sh ghcr.io/owner/proxmox-portal:sha-abc1234
#
# Nothing here talks to a real Proxmox; the credentials are placeholders.
set -euo pipefail

IMAGE="${1:?usage: $0 IMAGE}"
RUN_ID="portal-smoke-$$"
VOLUME="$RUN_ID-data"
WEB="$RUN_ID-web"
WORKER="$RUN_ID-worker"

log()  { printf '==> %s\n' "$*"; }
fail() {
  printf '::error::%s\n' "$*" >&2
  for c in "$WEB" "$WORKER"; do
    if docker container inspect "$c" >/dev/null 2>&1; then
      printf -- '--- logs: %s ---\n' "$c" >&2
      docker logs "$c" >&2 || true
    fi
  done
  exit 1
}

cleanup() {
  docker rm -f "$WEB" "$WORKER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ENV_ARGS=(
  -e "AUTH_SECRET=$(openssl rand -base64 32)"
  -e "APP_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  -e "AUTH_URL=http://localhost:3000"
  -e "AUTH_TRUST_HOST=true"
  -e "PVE_ENDPOINT=https://127.0.0.1:8006/"
  -e "PVE_API_TOKEN=smoke@pve!test=00000000-0000-0000-0000-000000000000"
)

log "toolchain inside $IMAGE"
docker run --rm "$IMAGE" terraform version | grep -q '^Terraform v' \
  || fail "terraform is missing from the image"
docker run --rm "$IMAGE" node --version | grep -q '^v24\.' \
  || fail "unexpected Node.js major version"
docker run --rm "$IMAGE" ssh -V 2>&1 | grep -q OpenSSH \
  || fail "openssh-client is missing from the image"
docker run --rm "$IMAGE" test -d /opt/proxmox-portal/terraform/modules/lxc \
  || fail "vendored terraform modules are missing from the image"

log "web: starting"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$WEB" "${ENV_ARGS[@]}" \
  -v "$VOLUME:/var/lib/proxmox-portal" -p 127.0.0.1::3000 \
  "$IMAGE" web >/dev/null

PORT="$(docker port "$WEB" 3000/tcp | head -n1 | sed 's/.*://')"
URL="http://127.0.0.1:$PORT"

log "web: waiting for $URL/login"
for _ in $(seq 1 60); do
  if curl -fsS "$URL/login" >/dev/null 2>&1; then
    ready=1
    break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "$WEB")" = "true" ] \
    || fail "web container exited during startup"
  sleep 2
done
[ "${ready:-}" = "1" ] || fail "web did not answer within 120s"

log "web: login and register pages render"
curl -fsS "$URL/login" | grep -qi '<html' || fail "/login did not return HTML"
curl -fsS "$URL/register" | grep -qi '<html' || fail "/register did not return HTML"

log "web: anonymous requests are sent to /login"
location="$(curl -s -D - "$URL/dashboard" | tr -d '\r' | sed -n 's/^[Ll]ocation: *//p')"
case "$location" in
  */login*) ;;
  *) fail "expected /dashboard to redirect to /login, got '$location'" ;;
esac

log "web: healthcheck passes"
docker exec "$WEB" portal-healthcheck || fail "healthcheck failed on a running web container"

log "web: schema pushed and data owned by the service user"
docker exec "$WEB" sqlite3 /var/lib/proxmox-portal/portal.db '.tables' | grep -q User \
  || fail "database schema was not pushed"
owner="$(docker exec "$WEB" stat -c %U /var/lib/proxmox-portal/portal.db)"
[ "$owner" = "node" ] || fail "portal.db is owned by '$owner', expected 'node'"
# Only tini (PID 1) should be root; the image has no ps, so read /proc.
root_node="$(docker exec "$WEB" sh -c '
  for s in /proc/[0-9]*/status; do
    name=$(sed -n "s/^Name:[[:space:]]*//p" "$s" 2>/dev/null)
    uid=$(sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "$s" 2>/dev/null)
    [ "$uid" = 0 ] && echo "$name"
  done' | grep -E 'node|next' || true)"
[ -z "$root_node" ] || fail "the web server is running as root ($root_node)"

log "worker: starting against the same volume"
docker run -d --name "$WORKER" "${ENV_ARGS[@]}" \
  -v "$VOLUME:/var/lib/proxmox-portal" \
  "$IMAGE" worker >/dev/null

for _ in $(seq 1 30); do
  docker logs "$WORKER" 2>&1 | grep -q '\[worker\] ready' && worker_ready=1 && break
  [ "$(docker inspect -f '{{.State.Running}}' "$WORKER")" = "true" ] \
    || fail "worker exited during startup"
  sleep 2
done
[ "${worker_ready:-}" = "1" ] || fail "worker did not report ready within 60s"

sleep 5
[ "$(docker inspect -f '{{.State.Running}}' "$WORKER")" = "true" ] \
  || fail "worker died after reporting ready"

log "worker: stops cleanly on SIGTERM"
docker stop -t 30 "$WORKER" >/dev/null
docker logs "$WORKER" 2>&1 | grep -q '\[worker\] stopped' \
  || fail "worker did not log a clean shutdown"

log "smoke test passed for $IMAGE"
