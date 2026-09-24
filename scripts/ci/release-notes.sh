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

Run on any Proxmox VE node, as root. No clone needed. It uses the same menus as
the [community-scripts](https://community-scripts.github.io/ProxmoxVE/) helper
scripts (choose *Default* or *Advanced* settings) and installs \`$RELEASE_TAG\`.
It asks for the Proxmox API token and the provider's SSH key at the end.

\`\`\`bash
bash -c "\$(curl -fsSL $DL/proxmox-portal.sh)"
\`\`\`

Portal settings can be passed as environment variables, e.g. unattended:

\`\`\`bash
PORTAL_PVE_TOKEN='terraform@pve!provider=<uuid>' PORTAL_SSH_KEY=/root/.ssh/terraform_pve \\
  bash -c "\$(curl -fsSL $DL/proxmox-portal.sh)"
\`\`\`

\`PORTAL_MODE=native\` installs from source with systemd instead of Docker; it
checks out \`$RELEASE_TAG\`.

## Upgrade an existing install

Inside the container (\`pct enter <CTID>\`), run:

\`\`\`bash
update
\`\`\`

A container pinned to a release moves to the newest release; one on a moving
tag (\`latest\`, a branch) re-pulls it.

Docker Compose anywhere else:

\`\`\`bash
curl -fsSLO $DL/compose.yml   # defaults to $RELEASE_TAG
docker compose pull && docker compose up -d
\`\`\`

## Verification

- Smoke-tested before promotion: both roles start, pages render, schema applies, runs unprivileged, worker stops cleanly.
- Every tag above was checked to resolve to \`$DIGEST\`.
- Assets: \`curl -fsSLO $DL/SHA256SUMS && sha256sum -c SHA256SUMS\`
- [Workflow run]($RUN_URL)
<!-- release-details:end -->
EOF
