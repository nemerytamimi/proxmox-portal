# Proxmox Portal

Self-service containers and virtual machines for a Proxmox VE cluster. A
registered user orders an LXC or VM from a form, an administrator approves it
and chooses which node it lands on, and **Terraform** does the actual work.
Owners then manage their own guest — power, resize, destroy — from the same UI.

Every change to a guest's shape goes through `terraform apply` against a
per-guest workspace. Nothing is created by clicking directly at the Proxmox API.

## What it does

- **Registration and login** — email + password. The first account created
  becomes the administrator.
- **Ordering** — container templates and cloud images are read live from the
  cluster's storage, so anything downloaded to Proxmox is immediately orderable.
- **Quotas** — per-user ceilings on guests, cores, memory and disk, counting
  both running guests and orders still awaiting approval.
- **Approval with node selection** — the admin picks the target node from a
  dropdown built from the live cluster. Nodes that cannot host the guest are
  shown with the reason (offline, no KVM, no network profile).
- **Provisioning** — a background worker runs `init` → `apply` and streams the
  Terraform log to the browser over SSE.
- **Lifecycle** — start/stop/reboot go straight to the Proxmox API; resize and
  destroy go through Terraform. Disks may grow, never shrink.
- **Migration** — admins move a guest to another node, with an explicit warning
  when the move will change its address.
- **Node management** — nodes are discovered from the cluster automatically. A
  node that is offline today, or added next month, appears on its own.
- **Audit log** — every state-changing action records who did it.

## Architecture

Two systemd units in one LXC, sharing a SQLite database in WAL mode:

| Unit | Role |
| --- | --- |
| `proxmox-portal-web` | Next.js server: UI, server actions, SSE log streaming |
| `proxmox-portal-worker` | Drains the job queue and runs `terraform` |

The worker is a separate process on purpose: a fifteen-minute apply should never
hold an HTTP request open, and restarting the UI must not orphan a running
Terraform.

```
/opt/proxmox-portal          the app
/var/lib/proxmox-portal/
  portal.db                  SQLite (WAL)
  portal.env                 credentials, mode 600
  workspaces/<guestId>/      one Terraform workspace + state per guest
  logs/<jobId>.log           what the browser tails
  plugin-cache/              shared provider cache
```

One workspace per guest is the key isolation decision: a wedged apply on one
order cannot block anyone else's, and destroying a guest is a self-contained
`terraform destroy` rather than surgery on a shared configuration.

## Cluster assumptions

The portal makes no assumptions about the shape of the cluster — nodes,
storages, bridges and templates are all read from the API. Two behaviours exist
because of what Proxmox itself does not offer:

- **Network profiles are per node.** Bridges are not cluster-wide. A node must be
  given a bridge, MTU and addressing mode by an admin before it can be used, and
  moving a guest between nodes with different profiles re-addresses it.
- **Containers cannot be migrated by Terraform.** The `bpg/proxmox` provider
  supports `migrate` on VMs only; changing `node_name` on a container would
  destroy and recreate it. The worker therefore moves containers through the
  Proxmox API and re-attaches them to Terraform state with `state rm` +
  `import`.

### Credentials are create-time only

Both vendored modules ignore changes to `initialization.user_account`. Proxmox
never returns a guest's password or injected keys, so a guest brought into state
by `import` comes back without them; without this the next plan would propose
*replacing* the guest — destroying its disk — to fix a value it cannot read.
The practical consequence: changing a guest's password in the portal after
creation does not take effect. Change it inside the guest.

## Installation

Quickest: on any Proxmox VE node, as root. No clone needed.

```bash
bash -c "$(curl -fsSL https://github.com/nemerytamimi/proxmox-portal/releases/latest/download/create-lxc.sh)" -- \
  --ssh-key /root/.ssh/terraform_pve        # -- --help for all options
```

This creates a Debian LXC running the newest release's image under Docker
Compose (`--mode native` installs with systemd instead). Each release's notes
carry the same command pinned to that version. The manual steps, and what the
script automates, are in [deploy/install.md](deploy/install.md).

## Container image and CI

One image, `ghcr.io/nemerytamimi/proxmox-portal`, runs both roles:
`docker run … web` (the default) or `docker run … worker`. [compose.yml](compose.yml)
wires the two together over a shared data volume.

| Workflow | Trigger | Does |
| --- | --- | --- |
| [build.yml](.github/workflows/build.yml) | push, PR | prisma validate, build, typecheck, Terraform fmt/validate, ShellCheck, Hadolint, actionlint → build image → smoke test → Docker Scout gate → push |
| [release.yml](.github/workflows/release.yml) | release published | finds the already-tested image for the release commit (`latest` if it matches, else `sha-<commit>`), smoke-tests it, retags it, verifies the digests; attaches `create-lxc.sh`, `compose.yml` and `SHA256SUMS` pinned to the release, and appends image, install and upgrade details to the release notes |

Image tags: `<branch>` and `sha-<commit>` on every branch push, `latest` on the
default branch, `<tag>` plus `1.2.3`/`1.2` on a semver tag push and on release.
Pull requests build and test but never push.

The Scout step runs only when the `DOCKERHUB_USERNAME` repository variable and
`DOCKERHUB_TOKEN` secret are set. It fails on critical or high CVEs that have a
fix available.

Run the smoke test locally with `scripts/ci/smoke-test.sh <image>`.

## Development

The app is developed on the Proxmox host and pushed into the container:

```bash
./deploy/sync.sh              # sync, npm install, prisma db push, build, restart
./deploy/sync.sh --no-build   # sync only
```

Useful checks inside the container:

```bash
npx tsc --noEmit
npx prisma studio
journalctl -u proxmox-portal-worker -f
```

## Layout

| Path | What |
| --- | --- |
| `prisma/schema.prisma` | Data model. SQLite has no enums; status columns are strings backed by the unions in `src/lib/types.ts`. |
| `src/lib/pve.ts` | Proxmox API client: discovery, status, power, migrate, tasks. |
| `src/lib/terraform/generate.ts` | Workspace and tfvars generation. |
| `src/lib/terraform/run.ts` | Terraform process runner and log capture. |
| `src/lib/orders.ts` | Order submission, approval, job queueing. |
| `src/lib/guests.ts` | Resize, destroy, migrate, power, migration preview. |
| `src/lib/ipam.ts` | VMID and address allocation. |
| `src/lib/nodes.ts` | Node discovery and placement rules. |
| `worker/index.ts` | The job loop. |
| `terraform/modules/{lxc,vm}` | Vendored modules the workspaces call. |
