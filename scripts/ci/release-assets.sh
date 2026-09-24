#!/usr/bin/env bash
#
# Build the files attached to a GitHub release: create-lxc.sh and compose.yml
# with their defaults pointed at this release, plus SHA256SUMS. A downloaded
# create-lxc.sh then installs exactly this release with no flags.
#
#   RELEASE_TAG=v1.2.3 IMAGE=ghcr.io/owner/repo REPO_URL=https://github.com/owner/repo.git \
#     scripts/ci/release-assets.sh dist/
#
# Fails if any default it is meant to rewrite was not found, so a renamed
# variable cannot silently ship a script that installs :latest.
set -euo pipefail

OUT="${1:?usage: $0 OUT_DIR}"
: "${RELEASE_TAG:?}" "${IMAGE:?}" "${REPO_URL:?}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$OUT"

# Values go through sed replacement text; none of these may contain '|' or '&'.
for v in "$RELEASE_TAG" "$IMAGE" "$REPO_URL"; do
  case "$v" in *'|'*|*'&'*) echo "refusing unsafe value: $v" >&2; exit 1 ;; esac
done

sed -E \
  -e "s|^IMAGE=\"\\$\\{IMAGE:-[^}]*\}\"  # release-default\$|IMAGE=\"\${IMAGE:-$IMAGE}\"|" \
  -e "s|^TAG=\"\\$\\{TAG:-[^}]*\}\"  # release-default\$|TAG=\"\${TAG:-$RELEASE_TAG}\"|" \
  -e "s|^REPO=\"\\$\\{REPO:-[^}]*\}\"  # release-default\$|REPO=\"\${REPO:-$REPO_URL}\"|" \
  -e "s|^REF=\"\\$\\{REF:-[^}]*\}\"  # release-default\$|REF=\"\${REF:-$RELEASE_TAG}\"|" \
  "$ROOT/deploy/create-lxc.sh" > "$OUT/create-lxc.sh"
chmod 0755 "$OUT/create-lxc.sh"

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
expect "$OUT/create-lxc.sh" "IMAGE=\"\${IMAGE:-$IMAGE}\""
expect "$OUT/create-lxc.sh" "TAG=\"\${TAG:-$RELEASE_TAG}\""
expect "$OUT/create-lxc.sh" "REPO=\"\${REPO:-$REPO_URL}\""
expect "$OUT/create-lxc.sh" "REF=\"\${REF:-$RELEASE_TAG}\""
expect "$OUT/compose.yml" "  image: \${PORTAL_IMAGE:-$IMAGE}:\${PORTAL_TAG:-$RELEASE_TAG}"
if grep -q 'release-default' "$OUT/create-lxc.sh"; then
  echo "::error::create-lxc.sh still has unrewritten release-default lines" >&2
  fail=1
fi
bash -n "$OUT/create-lxc.sh" || fail=1
[ "$fail" = 0 ] || exit 1

( cd "$OUT" && sha256sum create-lxc.sh compose.yml > SHA256SUMS )
echo "release assets for $RELEASE_TAG in $OUT:"
cat "$OUT/SHA256SUMS"
