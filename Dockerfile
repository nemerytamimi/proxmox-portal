# syntax=docker/dockerfile:1.7
#
# One image, two roles. The same image runs the web server (`web`, the default)
# and the Terraform job worker (`worker`); see docker/entrypoint.sh. Both need
# the same code, Prisma client and SQLite file, so splitting them into two
# images would only let their versions drift apart.

ARG NODE_VERSION=24
# Match the Terraform version used elsewhere (deploy/install.md).
ARG TERRAFORM_VERSION=1.16.4

# ---------------------------------------------------------------------------
# base: the runtime OS layer shared by the build and the final image. OpenSSL
# is installed before `npm ci` so Prisma detects the right engine target.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/proxmox-portal
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
# deps: full install. The worker runs from TypeScript source through tsx and
# the entrypoint runs `prisma db push`, so dev dependencies are needed at
# runtime too.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
# Then drop what the runtime never loads: the build cache, the standalone
# bundle (the image runs `next start` from the full tree, which the worker
# needs anyway), and musl binaries that cannot run on this glibc base.
RUN npm run build \
 && rm -rf .next/cache .next/standalone \
 && find node_modules -mindepth 1 -maxdepth 2 -type d -name "*musl*" -prune -exec rm -rf {} +

# ---------------------------------------------------------------------------
# terraform: fetched and checked against HashiCorp's published SHA256SUMS.
# ---------------------------------------------------------------------------
FROM debian:trixie-slim AS terraform
ARG TERRAFORM_VERSION
ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/tf
RUN set -eux; \
    base="https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}"; \
    zip="terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH:-amd64}.zip"; \
    curl -fsSLO "${base}/${zip}"; \
    curl -fsSLO "${base}/terraform_${TERRAFORM_VERSION}_SHA256SUMS"; \
    grep " ${zip}\$" "terraform_${TERRAFORM_VERSION}_SHA256SUMS" | sha256sum -c -; \
    unzip -o "${zip}" -d /usr/local/bin; \
    /usr/local/bin/terraform version

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime

# openssh-client: the bpg/proxmox provider falls back to SSH for disk imports
# and snippet uploads. tini reaps the provider processes terraform leaves
# behind. sqlite3 is for operators poking at the database.
#
# upgrade: pick up Debian security fixes published after the base image was.
# npm, npx and corepack are removed: nothing runs them at runtime (the
# entrypoint calls the binaries in node_modules/.bin directly), and their
# bundled dependencies are the bulk of the base image's CVEs.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends openssh-client sqlite3 tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --from=terraform /usr/local/bin/terraform /usr/local/bin/terraform
COPY --from=build /opt/proxmox-portal /opt/proxmox-portal
COPY docker/entrypoint.sh /usr/local/bin/portal-entrypoint
COPY docker/healthcheck.sh /usr/local/bin/portal-healthcheck

# Next writes its runtime cache under .next/cache; the rest of the app stays
# root-owned and read-only to the service user.
RUN chmod 0755 /usr/local/bin/portal-entrypoint /usr/local/bin/portal-healthcheck \
 && mkdir -p .next/cache /var/lib/proxmox-portal/plugin-cache \
 && chown -R node:node .next/cache /var/lib/proxmox-portal

# PVE_SSH_PRIVATE_KEY is the path of the key on the data volume, not a secret.
# hadolint ignore=DL3064
ENV NODE_ENV=production \
    PORT=3000 \
    PORTAL_DATA_DIR=/var/lib/proxmox-portal \
    DATABASE_URL=file:/var/lib/proxmox-portal/portal.db \
    TERRAFORM_BIN=/usr/local/bin/terraform \
    TF_PLUGIN_CACHE_DIR=/var/lib/proxmox-portal/plugin-cache \
    PVE_SSH_PRIVATE_KEY=/var/lib/proxmox-portal/ssh/terraform_pve

# /var/lib/proxmox-portal is the whole of the portal's state: database,
# Terraform workspaces and their state files, job logs. Back it up as one.
VOLUME ["/var/lib/proxmox-portal"]
EXPOSE 3000

# Starts as root only long enough to fix ownership of the data volume, then
# drops to `node` (see the entrypoint).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["portal-healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "portal-entrypoint"]
CMD ["web"]
