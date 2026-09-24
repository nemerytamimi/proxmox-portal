#!/usr/bin/env bash
#
# Create a Proxmox LXC running the portal, in one command, on a PVE node. No
# clone needed: every GitHub release attaches a copy of this script whose
# defaults point at that release's image.
#
#   # newest release, DHCP on vmbr0, Docker
#   bash -c "$(curl -fsSL https://github.com/nemerytamimi/proxmox-portal/releases/latest/download/create-lxc.sh)"
#
#   # a specific release, static address, options after `--`
#   bash -c "$(curl -fsSL https://github.com/nemerytamimi/proxmox-portal/releases/download/v1.2.3/create-lxc.sh)" -- \
#     --ip 10.98.3.131/24 --gw 10.98.3.1 --mtu 1420 --ssh-key /root/.ssh/terraform_pve
#
#   # from a checkout: tracks :latest / main unless told otherwise
#   bash deploy/create-lxc.sh --mode native --ref main
#
# What it does:
#   1. downloads the newest Debian template if it is not already on the host
#   2. creates an unprivileged container (nesting on, keyctl for Docker)
#   3. applies the in-guest MTU fix from deploy/install.md when --mtu is set
#   4. copies in the SSH key the Terraform provider uses to reach the nodes
#   5. writes /var/lib/proxmox-portal/portal.env with generated secrets
#      (or pushes the one you give it with --env-file)
#   6. installs the portal: the published image under Docker Compose, or a
#      git checkout with the systemd units
#
# Everything is a flag or an environment variable (flag wins). Run --help.
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
CTID="${CTID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-proxmox-portal}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
TEMPLATE="${TEMPLATE:-}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"
GW="${GW:-}"
MTU="${MTU:-}"
VLAN="${VLAN:-}"
NAMESERVER="${NAMESERVER:-}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-3072}"
SWAP="${SWAP:-512}"
DISK="${DISK:-20}"
CT_PASSWORD="${CT_PASSWORD:-}"
CT_SSH_PUBKEY="${CT_SSH_PUBKEY:-}"
ONBOOT="${ONBOOT:-1}"

MODE="${MODE:-docker}"
IMAGE="${IMAGE:-ghcr.io/nemerytamimi/proxmox-portal}"  # release-default
TAG="${TAG:-latest}"  # release-default
REGISTRY_USER="${REGISTRY_USER:-}"
REGISTRY_TOKEN="${REGISTRY_TOKEN:-}"
REPO="${REPO:-https://github.com/nemerytamimi/proxmox-portal.git}"  # release-default
REF="${REF:-main}"  # release-default
TERRAFORM_VERSION="${TERRAFORM_VERSION:-1.16.4}"

SSH_KEY="${SSH_KEY:-}"
ENV_FILE="${ENV_FILE:-}"
PVE_ENDPOINT="${PVE_ENDPOINT:-}"
PVE_API_TOKEN="${PVE_API_TOKEN:-}"
PVE_INSECURE="${PVE_INSECURE:-true}"
PVE_NODE_ADDRESSES="${PVE_NODE_ADDRESSES:-}"
PORTAL_URL="${PORTAL_URL:-}"
ASSUME_YES="${ASSUME_YES:-0}"

DATA_DIR=/var/lib/proxmox-portal
APP_DIR=/opt/proxmox-portal

usage() {
  cat <<EOF
Usage: create-lxc.sh [options]

Container
  --ctid N               Container ID (default: next free ID)
  --hostname NAME        Hostname (default: $CT_HOSTNAME)
  --storage NAME         Root disk storage (default: $STORAGE)
  --template-storage N   Storage holding CT templates (default: $TEMPLATE_STORAGE)
  --template FILE        Template file name (default: newest debian-13, else debian-12)
  --cores N              (default: $CORES)
  --memory MB            (default: $MEMORY)
  --swap MB              (default: $SWAP)
  --disk GB              (default: $DISK)
  --password PASS        Root password for the container (default: none, use pct enter)
  --ct-ssh-pubkey FILE   authorized_keys for the container's root
  --no-onboot            Do not start the container with the host

Network
  --bridge NAME          (default: $BRIDGE)
  --ip dhcp|CIDR         (default: $IP)
  --gw ADDR              Gateway, required with a static --ip
  --mtu N                Also fixes eth0 inside the guest (see deploy/install.md)
  --vlan N               VLAN tag
  --nameserver ADDR

Portal
  --mode docker|native   docker: run the published image (default)
                         native: git checkout + systemd, as in deploy/install.md
  --image NAME           (default: $IMAGE)
  --tag TAG              Image tag, e.g. latest, main, v1.2.3 (default: $TAG)
  --registry-user USER   Log in to the registry (needed if the package is private)
  --registry-token TOK
  --repo URL             native mode: git repository (default: $REPO)
  --ref REF              native mode: branch or tag (default: $REF)
  --env-file FILE        Push this portal.env as-is instead of generating one
  --ssh-key FILE         Private key in root's authorized_keys on every node
  --pve-endpoint URL     (default: https://<this host>:8006/)
  --pve-token TOKEN      user@realm!tokenid=uuid (prompted for if interactive)
  --pve-node-addresses   name=ip,name=ip (default: read from the cluster)
  --url URL              How users reach the portal (default: http://<ct ip>:3000)
  -y, --yes              Do not ask for confirmation or missing values

Every option can also be set as an environment variable, e.g. CTID=140 TAG=v1.2.3.
EOF
}

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_INFO=$'\e[1;34m'; C_OK=$'\e[1;32m'; C_WARN=$'\e[1;33m'; C_ERR=$'\e[1;31m'; C_OFF=$'\e[0m'
else
  C_INFO=; C_OK=; C_WARN=; C_ERR=; C_OFF=
fi
info() { printf '%s==>%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok()   { printf '%s ok%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

interactive() { [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; }

# Run a script inside the container.
ct() { pct exec "$CTID" -- bash -euo pipefail -c "$1"; }

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --ctid) CTID="$2"; shift 2 ;;
    --hostname) CT_HOSTNAME="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --template-storage) TEMPLATE_STORAGE="$2"; shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --swap) SWAP="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --password) CT_PASSWORD="$2"; shift 2 ;;
    --ct-ssh-pubkey) CT_SSH_PUBKEY="$2"; shift 2 ;;
    --no-onboot) ONBOOT=0; shift ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --ip) IP="$2"; shift 2 ;;
    --gw) GW="$2"; shift 2 ;;
    --mtu) MTU="$2"; shift 2 ;;
    --vlan) VLAN="$2"; shift 2 ;;
    --nameserver) NAMESERVER="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --registry-user) REGISTRY_USER="$2"; shift 2 ;;
    --registry-token) REGISTRY_TOKEN="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --pve-endpoint) PVE_ENDPOINT="$2"; shift 2 ;;
    --pve-token) PVE_API_TOKEN="$2"; shift 2 ;;
    --pve-node-addresses) PVE_NODE_ADDRESSES="$2"; shift 2 ;;
    --url) PORTAL_URL="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
[ "$(id -u)" = "0" ] || die "run as root on a Proxmox VE node"
for bin in pct pveam pvesh pvesm; do
  command -v "$bin" >/dev/null || die "$bin not found: this must run on a Proxmox VE node"
done

case "$MODE" in docker|native) ;; *) die "--mode must be docker or native" ;; esac

if [ "$IP" != "dhcp" ]; then
  [[ "$IP" == */* ]] || die "--ip must be 'dhcp' or an address in CIDR form, e.g. 10.0.0.5/24"
  [ -n "$GW" ] || die "--gw is required with a static --ip"
fi
[ -z "$SSH_KEY" ] || [ -r "$SSH_KEY" ] || die "--ssh-key $SSH_KEY is not readable"
[ -z "$ENV_FILE" ] || [ -r "$ENV_FILE" ] || die "--env-file $ENV_FILE is not readable"
[ -z "$CT_SSH_PUBKEY" ] || [ -r "$CT_SSH_PUBKEY" ] || die "--ct-ssh-pubkey $CT_SSH_PUBKEY is not readable"
pvesm status --storage "$STORAGE" >/dev/null 2>&1 || die "storage '$STORAGE' does not exist"
pvesm status --storage "$TEMPLATE_STORAGE" >/dev/null 2>&1 || die "storage '$TEMPLATE_STORAGE' does not exist"
ip link show "$BRIDGE" >/dev/null 2>&1 || die "bridge '$BRIDGE' does not exist on this node"

if [ -z "$CTID" ]; then
  CTID="$(pvesh get /cluster/nextid)"
fi
if pct status "$CTID" >/dev/null 2>&1 || qm status "$CTID" >/dev/null 2>&1; then
  die "ID $CTID is already in use"
fi

HOST_IP="$(hostname -I | awk '{print $1}')"
[ -n "$PVE_ENDPOINT" ] || PVE_ENDPOINT="https://${HOST_IP}:8006/"

# The API often advertises addresses the portal cannot reach (e.g. over
# WireGuard), but it is the best default available. Review it afterwards.
if [ -z "$PVE_NODE_ADDRESSES" ] && [ -z "$ENV_FILE" ]; then
  PVE_NODE_ADDRESSES="$(pvesh get /cluster/status --output-format json 2>/dev/null | perl -MJSON::PP -e '
    my $s = decode_json(join "", <STDIN>);
    print join ",", map { "$_->{name}=$_->{ip}" } grep { $_->{type} eq "node" && $_->{ip} } @$s;
  ' || true)"
fi

if [ -z "$ENV_FILE" ] && [ -z "$PVE_API_TOKEN" ] && interactive; then
  printf 'Proxmox API token for the portal (user@realm!tokenid=uuid, see deploy/install.md)\n'
  read -r -s -p 'token (empty to fill in later): ' PVE_API_TOKEN
  printf '\n'
fi

# ---------------------------------------------------------------------------
# Template
# ---------------------------------------------------------------------------
if [ -z "$TEMPLATE" ]; then
  info "looking up the newest Debian template"
  pveam update >/dev/null || warn "pveam update failed; using the cached template index"
  available="$(pveam available --section system | awk '{print $2}')"
  TEMPLATE="$(grep -E '^debian-13-standard_' <<<"$available" | sort -V | tail -n1 || true)"
  [ -n "$TEMPLATE" ] || TEMPLATE="$(grep -E '^debian-12-standard_' <<<"$available" | sort -V | tail -n1 || true)"
  [ -n "$TEMPLATE" ] || die "no Debian 12/13 standard template is available from pveam"
fi

if ! pveam list "$TEMPLATE_STORAGE" | awk '{print $1}' | grep -q "/${TEMPLATE}\$"; then
  info "downloading $TEMPLATE to $TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------
NET0="name=eth0,bridge=${BRIDGE},ip=${IP}"
[ -z "$GW" ] || NET0+=",gw=${GW}"
[ -z "$MTU" ] || NET0+=",mtu=${MTU}"
[ -z "$VLAN" ] || NET0+=",tag=${VLAN}"

if [ "$MODE" = "docker" ]; then
  WHAT="${IMAGE}:${TAG} (Docker Compose)"
else
  WHAT="${REPO}@${REF} (systemd)"
fi

cat <<EOF

  CT ${CTID}  ${CT_HOSTNAME}
  template   ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}
  resources  ${CORES} cores, ${MEMORY} MB RAM, ${SWAP} MB swap, ${DISK} GB on ${STORAGE}
  network    ${NET0}
  portal     ${WHAT}
  PVE API    ${PVE_ENDPOINT}
  nodes      ${PVE_NODE_ADDRESSES:-<from --env-file>}
  ssh key    ${SSH_KEY:-<none: copy one in later>}

EOF

if interactive; then
  read -r -p "Create it? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || die "aborted"
fi

# ---------------------------------------------------------------------------
# Create and start
# ---------------------------------------------------------------------------
info "creating CT $CTID"
create_args=(
  "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
  --hostname "$CT_HOSTNAME"
  --cores "$CORES"
  --memory "$MEMORY"
  --swap "$SWAP"
  --rootfs "${STORAGE}:${DISK}"
  --net0 "$NET0"
  --ostype debian
  --unprivileged 1
  # keyctl is what Docker needs in an unprivileged container; harmless otherwise.
  --features "nesting=1,keyctl=1"
  --onboot "$ONBOOT"
  --tags proxmox-portal
  --description "Proxmox self-service portal. Installed by deploy/create-lxc.sh (${MODE})."
)
[ -z "$NAMESERVER" ] || create_args+=(--nameserver "$NAMESERVER")
[ -z "$CT_PASSWORD" ] || create_args+=(--password "$CT_PASSWORD")
[ -z "$CT_SSH_PUBKEY" ] || create_args+=(--ssh-public-keys "$CT_SSH_PUBKEY")
pct create "${create_args[@]}"

info "starting CT $CTID"
pct start "$CTID"

# Proxmox applies mtu= only to the host side of the veth; the guest's eth0
# still comes up at 1500 and large TLS handshakes black-hole. This has to be an
# ifupdown hook: a systemd unit runs before ifupdown and the setting is lost.
if [ -n "$MTU" ]; then
  info "pinning eth0 MTU to $MTU inside the container"
  ct "cat > /etc/network/if-up.d/zz-mtu <<'EOF'
#!/bin/sh
[ \"\$IFACE\" = \"eth0\" ] || exit 0
ip link set dev eth0 mtu $MTU
EOF
chmod +x /etc/network/if-up.d/zz-mtu
ip link set dev eth0 mtu $MTU || true"
fi

info "waiting for the network"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then
    net_ok=1
    break
  fi
  sleep 2
done
[ "${net_ok:-}" = "1" ] || die "CT $CTID has no working DNS/network after 120s (check --ip/--gw/--bridge)"

CT_IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
[ -n "$CT_IP" ] || die "could not determine the container's address"
ok "CT $CTID is up at $CT_IP"
[ -n "$PORTAL_URL" ] || PORTAL_URL="http://${CT_IP}:3000"

# ---------------------------------------------------------------------------
# Data directory, SSH key, credentials
# ---------------------------------------------------------------------------
info "preparing $DATA_DIR"
ct "apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates openssl >/dev/null
mkdir -p $DATA_DIR/workspaces $DATA_DIR/logs $DATA_DIR/plugin-cache $DATA_DIR/ssh
chmod 700 $DATA_DIR/ssh"

if [ -n "$SSH_KEY" ]; then
  pct push "$CTID" "$SSH_KEY" "$DATA_DIR/ssh/terraform_pve" --perms 600
  ok "SSH key installed at $DATA_DIR/ssh/terraform_pve"
fi

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_env"' EXIT
chmod 600 "$tmp_env"
if [ -n "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$tmp_env"
else
  # Written on the host only long enough to push; mode 600 throughout.
  cat > "$tmp_env" <<EOF
# Generated by deploy/create-lxc.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). See .env.example.
DATABASE_URL="file:${DATA_DIR}/portal.db"
AUTH_SECRET="$(openssl rand -base64 32)"
AUTH_URL="${PORTAL_URL}"
AUTH_TRUST_HOST="true"
APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"

PVE_ENDPOINT="${PVE_ENDPOINT}"
PVE_API_TOKEN="${PVE_API_TOKEN}"
PVE_INSECURE="${PVE_INSECURE}"
PVE_SSH_USERNAME="root"
PVE_SSH_PRIVATE_KEY="${DATA_DIR}/ssh/terraform_pve"
PVE_NODE_ADDRESSES="${PVE_NODE_ADDRESSES}"

TERRAFORM_BIN="/usr/local/bin/terraform"
PORTAL_DATA_DIR="${DATA_DIR}"
TF_PLUGIN_CACHE_DIR="${DATA_DIR}/plugin-cache"
EOF
fi
pct push "$CTID" "$tmp_env" "$DATA_DIR/portal.env" --perms 600
rm -f "$tmp_env"
ok "wrote $DATA_DIR/portal.env"

# ---------------------------------------------------------------------------
# Install: Docker
# ---------------------------------------------------------------------------
install_docker() {
  info "installing Docker"
  ct "if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null"

  if [ -n "$REGISTRY_USER" ] && [ -n "$REGISTRY_TOKEN" ]; then
    info "logging in to ${IMAGE%%/*}"
    printf '%s' "$REGISTRY_TOKEN" | pct exec "$CTID" -- docker login "${IMAGE%%/*}" -u "$REGISTRY_USER" --password-stdin >/dev/null
  fi

  # Keep in sync with compose.yml at the repo root. The data directory is a
  # bind mount at the same path as a native install, so backups and the docs
  # apply unchanged.
  info "writing $APP_DIR/compose.yml"
  ct "mkdir -p $APP_DIR
cat > $APP_DIR/compose.yml <<'EOF'
x-portal: &portal
  image: \${PORTAL_IMAGE}:\${PORTAL_TAG}
  env_file: ${DATA_DIR}/portal.env
  restart: unless-stopped
  volumes:
    - ${DATA_DIR}:${DATA_DIR}

services:
  web:
    <<: *portal
    command: [\"web\"]
    ports:
      - \"3000:3000\"

  worker:
    <<: *portal
    command: [\"worker\"]
    depends_on:
      web:
        condition: service_healthy
    stop_grace_period: 15m
EOF
cat > $APP_DIR/.env <<EOF
PORTAL_IMAGE=${IMAGE}
PORTAL_TAG=${TAG}
EOF"

  info "pulling ${IMAGE}:${TAG} and starting"
  if ! ct "cd $APP_DIR && docker compose pull -q && docker compose up -d --wait --wait-timeout 180"; then
    pct exec "$CTID" -- bash -c "cd $APP_DIR && docker compose logs --tail 50" || true
    warn "Docker failed to start the portal. If the logs mention AppArmor or"
    warn "'permission denied' on sysctl/proc, Docker in this unprivileged LXC is"
    warn "being blocked; try --mode native, or see the Docker-in-LXC notes for your PVE version."
    die "installation failed"
  fi
}

# ---------------------------------------------------------------------------
# Install: native (deploy/install.md, steps 3 and 5)
# ---------------------------------------------------------------------------
install_native() {
  info "installing Node.js 24, Terraform ${TERRAFORM_VERSION} and tools"
  ct "export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq gnupg unzip sqlite3 openssh-client git >/dev/null
if ! node --version 2>/dev/null | grep -q '^v24\\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
arch=\$(dpkg --print-architecture)
base=https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}
zip=terraform_${TERRAFORM_VERSION}_linux_\${arch}.zip
cd /tmp
curl -fsSLO \$base/\$zip
curl -fsSLO \$base/terraform_${TERRAFORM_VERSION}_SHA256SUMS
grep \" \$zip\\\$\" terraform_${TERRAFORM_VERSION}_SHA256SUMS | sha256sum -c - >/dev/null
unzip -o -q \$zip -d /usr/local/bin/
rm -f \$zip terraform_${TERRAFORM_VERSION}_SHA256SUMS
terraform version | head -n1"

  info "installing the portal from ${REPO}@${REF}"
  ct "git clone --quiet --depth 1 --branch '${REF}' '${REPO}' ${APP_DIR}
cd ${APP_DIR}
ln -sf ${DATA_DIR}/portal.env .env
npm ci --no-audit --no-fund --loglevel=error
npx prisma db push --skip-generate
npm run build >/dev/null
install -m644 deploy/proxmox-portal-web.service /etc/systemd/system/
install -m644 deploy/proxmox-portal-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now proxmox-portal-web proxmox-portal-worker"
}

if [ "$MODE" = "docker" ]; then install_docker; else install_native; fi

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
info "waiting for the portal to answer"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- curl -fsS -o /dev/null http://127.0.0.1:3000/login 2>/dev/null; then
    up=1
    break
  fi
  sleep 3
done
[ "${up:-}" = "1" ] || die "the portal did not answer on :3000 within 3 minutes; check the logs inside CT $CTID"
ok "portal is answering"

if [ "$MODE" = "docker" ]; then
  UPGRADE="pct exec $CTID -- bash -c 'cd $APP_DIR && sed -i s/^PORTAL_TAG=.*/PORTAL_TAG=<tag>/ .env && docker compose pull && docker compose up -d'"
  LOGS="pct exec $CTID -- docker compose -f $APP_DIR/compose.yml logs -f worker"
else
  UPGRADE="see 'Upgrading' in deploy/install.md"
  LOGS="pct exec $CTID -- journalctl -u proxmox-portal-worker -f"
fi

cat <<EOF

${C_OK}Proxmox Portal is running in CT ${CTID}.${C_OFF}

  Open        ${PORTAL_URL}
              Register: the first account becomes the administrator.
  Credentials ${DATA_DIR}/portal.env inside the CT (mode 600)
  Logs        ${LOGS}
  Upgrade     ${UPGRADE}

EOF

[ -n "$PVE_API_TOKEN" ] || [ -n "$ENV_FILE" ] || warn "PVE_API_TOKEN is empty: set it in ${DATA_DIR}/portal.env and restart the portal."
[ -n "$SSH_KEY" ] || warn "no --ssh-key given: copy a key to ${DATA_DIR}/ssh/terraform_pve before provisioning VMs from cloud images."
warn "check PVE_NODE_ADDRESSES in portal.env: the addresses read from the cluster may not be reachable from the portal."
