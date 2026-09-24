#!/usr/bin/env bash
#
# Print the generated section of a release's notes: image, digest, install and
# upgrade commands. release.yml puts it between the markers below, so re-running
# the release replaces the section and leaves hand-written notes alone.
#
# Inputs (environment):
#   RELEASE_TAG   v1.2.3
#   IMAGE         ghcr.io/owner/repo
#   DIGEST        sha256:... of the promoted image
#   SHA           full commit the release points at
#   SOURCE_TAG    the tag the image was promoted from (latest / sha-abc1234)
#   TAGS          newline-separated full image refs that now point at DIGEST
#   REPO          owner/repo
#   SERVER_URL    https://github.com
#   RUN_URL       link to this workflow run
#   TF_VERSION    terraform version inside the image
#   NODE_VERSION  node version inside the image
set -euo pipefail

: "${RELEASE_TAG:?}" "${IMAGE:?}" "${DIGEST:?}" "${SHA:?}" "${SOURCE_TAG:?}" \
  "${TAGS:?}" "${REPO:?}" "${SERVER_URL:?}" "${RUN_URL:?}"

DL="$SERVER_URL/$REPO/releases/download/$RELEASE_TAG"
# shellcheck disable=SC2016 # Markdown backticks, not command substitution
tag_list="$(while IFS= read -r t; do [ -n "$t" ] && printf '`%s` ' "${t##*:}"; done <<< "$TAGS")"

cat <<EOF
<!-- release-details:start -->
## Container image

| | |
| --- | --- |
| Image | \`$IMAGE:$RELEASE_TAG\` |
| Tags | ${tag_list% } |
| Digest | \`$DIGEST\` |
| Commit | [\`${SHA::7}\`]($SERVER_URL/$REPO/commit/$SHA) |
| Promoted from | \`$SOURCE_TAG\`, the image CI built and tested for this commit (not rebuilt) |
| Terraform | ${TF_VERSION:-unknown} |
| Node.js | ${NODE_VERSION:-unknown} |

\`\`\`bash
docker pull $IMAGE:$RELEASE_TAG
# or pinned to the exact image:
docker pull $IMAGE@$DIGEST
\`\`\`

## Install on Proxmox VE

Run on any Proxmox VE node, as root. No clone needed: the script attached to
this release installs \`$RELEASE_TAG\` by default.

\`\`\`bash
bash -c "\$(curl -fsSL $DL/create-lxc.sh)"
\`\`\`

With a static address, the MTU fix and the provider's SSH key (every option:
\`-- --help\`):

\`\`\`bash
bash -c "\$(curl -fsSL $DL/create-lxc.sh)" -- \\
  --ip 10.0.0.50/24 --gw 10.0.0.1 --mtu 1420 \\
  --ssh-key /root/.ssh/terraform_pve \\
  --pve-token 'terraform@pve!provider=<uuid>'
\`\`\`

Add \`--mode native\` to install from source with systemd instead of Docker; it
checks out \`$RELEASE_TAG\`.

## Upgrade an existing install

Docker install created by \`create-lxc.sh\` (replace \`<CTID>\`):

\`\`\`bash
pct exec <CTID> -- bash -c 'cd /opt/proxmox-portal && sed -i "s/^PORTAL_TAG=.*/PORTAL_TAG=$RELEASE_TAG/" .env && docker compose pull && docker compose up -d'
\`\`\`

Docker Compose anywhere else:

\`\`\`bash
curl -fsSLO $DL/compose.yml   # defaults to $RELEASE_TAG
docker compose pull && docker compose up -d
\`\`\`

Native install: see [Upgrading]($SERVER_URL/$REPO/blob/$RELEASE_TAG/deploy/install.md#upgrading), using \`git checkout $RELEASE_TAG\`.

## Verification

- Smoke-tested before promotion: both roles start, pages render, schema applies, runs unprivileged, worker stops cleanly.
- Every tag above was checked to resolve to \`$DIGEST\`.
- Assets: \`curl -fsSLO $DL/SHA256SUMS && sha256sum -c SHA256SUMS\`
- [Workflow run]($RUN_URL)
<!-- release-details:end -->
EOF
