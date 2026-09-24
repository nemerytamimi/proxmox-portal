#!/usr/bin/env bash
#
# Build the files attached to a GitHub release: the LXC script
# (proxmox-portal.sh) and compose.yml with their defaults pointed at this
# release, plus SHA256SUMS. The downloaded script then installs exactly this
# release with no options, and fetches its install/ counterpart from the same
# tag.
#
#   RELEASE_TAG=v1.2.3 IMAGE=ghcr.io/owner/repo REPO_SLUG=owner/repo \
#     scripts/ci/release-assets.sh dist/
#
# Fails if any default it is meant to rewrite was not found, so a renamed
# variable cannot silently ship a script that installs :latest.
set -euo pipefail

OUT="${1:?usage: $0 OUT_DIR}"
: "${RELEASE_TAG:?}" "${IMAGE:?}" "${REPO_SLUG:?}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_URL="https://github.com/${REPO_SLUG}.git"
SCRIPTS_URL="https://raw.githubusercontent.com/${REPO_SLUG}/${RELEASE_TAG}/deploy/lxc"
mkdir -p "$OUT"

# Values go through sed replacement text; none of these may contain '|' or '&'.
for v in "$RELEASE_TAG" "$IMAGE" "$REPO_SLUG"; do
  case "$v" in *'|'*|*'&'*) echo "refusing unsafe value: $v" >&2; exit 1 ;; esac
done

M='  # release-default$'
sed -E \
  -e "s|^_CS_DEFAULT_URL=\"[^\"]*\"${M}|_CS_DEFAULT_URL=\"${SCRIPTS_URL}\"|" \
  -e "s|^PORTAL_GH_REPO=\"[^\"]*\"${M}|PORTAL_GH_REPO=\"${REPO_SLUG}\"|" \
  -e "s|^PORTAL_IMAGE=\"\\$\\{PORTAL_IMAGE:-[^}]*\}\"${M}|PORTAL_IMAGE=\"\${PORTAL_IMAGE:-${IMAGE}}\"|" \
  -e "s|^PORTAL_TAG=\"\\$\\{PORTAL_TAG:-[^}]*\}\"${M}|PORTAL_TAG=\"\${PORTAL_TAG:-${RELEASE_TAG}}\"|" \
  -e "s|^PORTAL_REPO=\"\\$\\{PORTAL_REPO:-[^}]*\}\"${M}|PORTAL_REPO=\"\${PORTAL_REPO:-${REPO_URL}}\"|" \
  -e "s|^PORTAL_REF=\"\\$\\{PORTAL_REF:-[^}]*\}\"${M}|PORTAL_REF=\"\${PORTAL_REF:-${RELEASE_TAG}}\"|" \
  "$ROOT/deploy/lxc/ct/proxmox-portal.sh" > "$OUT/proxmox-portal.sh"
chmod 0755 "$OUT/proxmox-portal.sh"

sed -E \
  -e "s|\\$\\{PORTAL_IMAGE:-[^}]*\}|\${PORTAL_IMAGE:-$IMAGE}|" \
  -e "s|\\$\\{PORTAL_TAG:-[^}]*\}|\${PORTAL_TAG:-$RELEASE_TAG}|" \
  "$ROOT/compose.yml" > "$OUT/compose.yml"

fail=0
expect() {
  if ! grep -qxF -- "$2" "$1"; then
    echo "::error::$(basename "$1"): expected line not found: $2" >&2
    fail=1
  fi
}
S="$OUT/proxmox-portal.sh"
expect "$S" "_CS_DEFAULT_URL=\"${SCRIPTS_URL}\""
expect "$S" "PORTAL_GH_REPO=\"${REPO_SLUG}\""
expect "$S" "PORTAL_IMAGE=\"\${PORTAL_IMAGE:-${IMAGE}}\""
expect "$S" "PORTAL_TAG=\"\${PORTAL_TAG:-${RELEASE_TAG}}\""
expect "$S" "PORTAL_REPO=\"\${PORTAL_REPO:-${REPO_URL}}\""
expect "$S" "PORTAL_REF=\"\${PORTAL_REF:-${RELEASE_TAG}}\""
expect "$OUT/compose.yml" "  image: \${PORTAL_IMAGE:-$IMAGE}:\${PORTAL_TAG:-$RELEASE_TAG}"
if grep -q 'release-default' "$S"; then
  echo "::error::proxmox-portal.sh still has unrewritten release-default lines:" >&2
  grep -n 'release-default' "$S" >&2
  fail=1
fi
bash -n "$S" || fail=1
[ "$fail" = 0 ] || exit 1

( cd "$OUT" && sha256sum proxmox-portal.sh compose.yml > SHA256SUMS )
echo "release assets for $RELEASE_TAG in $OUT:"
cat "$OUT/SHA256SUMS"
