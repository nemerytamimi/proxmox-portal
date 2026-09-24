#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2086 # STD/colours/IP come from build.func; $STD is word-split on purpose
#
# Proxmox Portal LXC, in the style of community-scripts/ProxmoxVE: the same
# menus, defaults and update flow, driven by their shared engine
# (community-scripts/core build.func), with the install step taken from this
# repository.
#
#   bash -c "$(curl -fsSL https://github.com/nemerytamimi/proxmox-portal/releases/latest/download/proxmox-portal.sh)"
#
# Portal settings (environment variables; prompted for when interactive):
#   PORTAL_MODE       docker (default): the published image under Docker Compose
#                     native: git checkout + systemd units, as in deploy/install.md
#   PORTAL_TAG        image tag for docker mode
#   PORTAL_REF        git branch/tag for native mode
#   PORTAL_PVE_TOKEN  user@realm!tokenid=uuid (see deploy/install.md, step 1)
#   PORTAL_SSH_KEY    private key in root's authorized_keys on every node
#                     (default: /root/.ssh/terraform_pve when it exists)
#
# Run `update` inside the container to upgrade it later.

# Where this script's install/ counterpart lives. Release copies point at the
# release tag instead of main.
_CS_DEFAULT_URL="https://raw.githubusercontent.com/nemerytamimi/proxmox-portal/main/deploy/lxc"  # release-default
# The engine is third-party code running as root on the hypervisor: pinned to a
# reviewed commit rather than tracking main. Override to test a newer one.
COMMUNITY_SCRIPTS_CORE_URL="${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/ac65bcec34dbfbfbdf68eb9d9dc00f1a18efd852}"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-/nonexistent}/core/build.func"
# shellcheck source=/dev/null
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL}/core/build.func")
# Copyright (c) 2026 Nemer Tamimi
# License: MIT
# Source: https://github.com/nemerytamimi/proxmox-portal

APP="Proxmox-Portal"
var_tags="${var_tags:-proxmox;terraform}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-3072}"
var_disk="${var_disk:-20}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"

PORTAL_GH_REPO="nemerytamimi/proxmox-portal"  # release-default
PORTAL_MODE="${PORTAL_MODE:-docker}"
PORTAL_IMAGE="${PORTAL_IMAGE:-ghcr.io/nemerytamimi/proxmox-portal}"  # release-default
PORTAL_TAG="${PORTAL_TAG:-latest}"  # release-default
PORTAL_REPO="${PORTAL_REPO:-https://github.com/nemerytamimi/proxmox-portal.git}"  # release-default
PORTAL_REF="${PORTAL_REF:-main}"  # release-default
PORTAL_PVE_TOKEN="${PORTAL_PVE_TOKEN:-}"
PORTAL_SSH_KEY="${PORTAL_SSH_KEY:-}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -d /opt/proxmox-portal ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  local latest current target
  latest="$(curl -fsSL "https://api.github.com/repos/${PORTAL_GH_REPO}/releases/latest" 2>/dev/null |
    sed -nE 's/.*"tag_name": *"([^"]+)".*/\1/p' | head -n1)"

  if [[ -f /opt/proxmox-portal/compose.yml ]]; then
    cd /opt/proxmox-portal || exit
    current="$(sed -n 's/^PORTAL_TAG=//p' .env)"
    # A pinned release moves to the newest release; a moving tag (latest,
    # main, a branch) is simply re-pulled.
    target="$current"
    [[ "$current" == v* && -n "$latest" ]] && target="$latest"
    if [[ "$current" == v* && "$target" == "$current" ]]; then
      msg_ok "Already on the latest release (${current})"
      exit
    fi
    msg_info "Updating ${APP} to ${PORTAL_IMAGE##*/}:${target}"
    sed -i "s/^PORTAL_TAG=.*/PORTAL_TAG=${target}/" .env
    $STD docker compose pull
    $STD docker compose up -d --wait --wait-timeout 180
    $STD docker image prune -f
    msg_ok "Updated ${APP} to ${target}"
  else
    cd /opt/proxmox-portal || exit
    current="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --abbrev-ref HEAD)"
    if [[ "$current" == v* ]]; then
      if [[ -z "$latest" || "$latest" == "$current" ]]; then
        msg_ok "Already on the latest release (${current})"
        exit
      fi
      target="$latest"
    else
      target="$current"
    fi

    # Stopping the worker lets an in-flight terraform apply finish first.
    msg_info "Stopping services"
    systemctl stop proxmox-portal-worker proxmox-portal-web
    msg_ok "Stopped services"

    msg_info "Updating ${APP} to ${target} (Patience)"
    if [[ "$target" == v* ]]; then
      $STD git fetch --depth 1 origin tag "$target"
      $STD git checkout -q "$target"
    else
      $STD git pull --ff-only
    fi
    $STD npm ci --no-audit --no-fund
    $STD npx prisma db push --skip-generate
    $STD npm run build
    msg_ok "Updated ${APP} to ${target}"

    msg_info "Starting services"
    systemctl start proxmox-portal-web proxmox-portal-worker
    msg_ok "Started services"
  fi
  msg_ok "Updated successfully!"
  exit
}

# Values the host knows and the container does not. Exported so the install
# script, run through lxc-attach by build_container, can read them.
portal_host_facts() {
  local host_ip
  host_ip="$(hostname -I | awk '{print $1}')"
  export PORTAL_PVE_ENDPOINT="${PORTAL_PVE_ENDPOINT:-https://${host_ip}:8006/}"
  # The API can advertise addresses the portal cannot reach (e.g. over
  # WireGuard); this is only the best available default.
  if [[ -z "${PORTAL_PVE_NODE_ADDRESSES:-}" ]]; then
    PORTAL_PVE_NODE_ADDRESSES="$(pvesh get /cluster/status --output-format json 2>/dev/null | perl -MJSON::PP -e '
      my $s = decode_json(join "", <STDIN>);
      print join ",", map { "$_->{name}=$_->{ip}" } grep { $_->{type} eq "node" && $_->{ip} } @$s;
    ' 2>/dev/null || true)"
  fi
  export PORTAL_PVE_NODE_ADDRESSES
  # build.func's MTU is either "1420" or ",mtu=1420"; the install script needs
  # the number to fix eth0 inside the guest.
  local mtu="${MTU:-}"
  export PORTAL_MTU="${mtu#,mtu=}"
  export PORTAL_MODE PORTAL_IMAGE PORTAL_TAG PORTAL_REPO PORTAL_REF
}

portal_can_prompt() {
  [[ -t 0 ]] && command -v whiptail >/dev/null 2>&1
}

# Credentials go in from the host after the build, never through the install
# environment or its log.
portal_host_credentials() {
  local env_file=/var/lib/proxmox-portal/portal.env

  if [[ -z "$PORTAL_PVE_TOKEN" ]] && portal_can_prompt; then
    PORTAL_PVE_TOKEN="$(whiptail --backtitle "Proxmox VE Helper Scripts" --title "PROXMOX API TOKEN" \
      --passwordbox "Token the portal uses (user@realm!tokenid=uuid).\nLeave empty to set it later in ${env_file}." \
      11 72 3>&1 1>&2 2>&3)" || PORTAL_PVE_TOKEN=""
  fi

  if [[ -z "$PORTAL_SSH_KEY" ]] && portal_can_prompt; then
    local default_key=""
    [[ -r /root/.ssh/terraform_pve ]] && default_key=/root/.ssh/terraform_pve
    PORTAL_SSH_KEY="$(whiptail --backtitle "Proxmox VE Helper Scripts" --title "PROVIDER SSH KEY" \
      --inputbox "Private key in root's authorized_keys on every node (disk imports, snippets).\nLeave empty to copy one in later." \
      11 72 "$default_key" 3>&1 1>&2 2>&3)" || PORTAL_SSH_KEY=""
  fi

  local changed=0
  if [[ -n "$PORTAL_SSH_KEY" ]]; then
    if [[ -r "$PORTAL_SSH_KEY" ]]; then
      msg_info "Copying SSH key into CT ${CTID}"
      pct push "$CTID" "$PORTAL_SSH_KEY" /var/lib/proxmox-portal/ssh/terraform_pve --perms 600
      msg_ok "Copied SSH key"
      changed=1
    else
      msg_error "SSH key ${PORTAL_SSH_KEY} is not readable; skipped"
    fi
  fi

  if [[ -n "$PORTAL_PVE_TOKEN" ]]; then
    msg_info "Writing Proxmox API token"
    # stdin, so the token never appears in a process list.
    # shellcheck disable=SC2016 # expanded inside the container, not here
    printf '%s\n' "$PORTAL_PVE_TOKEN" | pct exec "$CTID" -- bash -c '
      set -e
      IFS= read -r token
      f="$1"
      grep -v "^PVE_API_TOKEN=" "$f" > "$f.new"
      printf "PVE_API_TOKEN=\"%s\"\n" "$token" >> "$f.new"
      chmod 600 "$f.new"
      chown --reference="$f" "$f.new"
      mv "$f.new" "$f"' _ "$env_file"
    msg_ok "Wrote Proxmox API token"
    changed=1
  fi

  if [[ "$changed" == 1 ]]; then
    msg_info "Restarting ${APP}"
    if [[ "$PORTAL_MODE" == docker ]]; then
      # recreate, not restart: env_file is only read when a container is created.
      pct exec "$CTID" -- bash -c 'cd /opt/proxmox-portal && docker compose up -d --force-recreate --wait --wait-timeout 180' >/dev/null
    else
      pct exec "$CTID" -- systemctl restart proxmox-portal-web proxmox-portal-worker
    fi
    msg_ok "Restarted ${APP}"
  fi
}

start
portal_host_facts
build_container
description
portal_host_credentials

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:3000${CL}"
echo -e "${INFO}${YW}Register there: the first account becomes the administrator.${CL}"
if [[ -z "$PORTAL_PVE_TOKEN" ]]; then
  echo -e "${INFO}${YW}Set PVE_API_TOKEN in /var/lib/proxmox-portal/portal.env inside CT ${CTID}, then restart the portal.${CL}"
fi
echo -e "${INFO}${YW}Check PVE_NODE_ADDRESSES in portal.env: addresses read from the cluster may not be reachable from the portal.${CL}"
