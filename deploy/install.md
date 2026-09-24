# Installing the portal

> **Shortcut:** [`create-lxc.sh`](create-lxc.sh) runs steps 2–6 for you on a PVE
> node: it creates the container, applies the MTU fix, copies in the SSH key,
> writes `portal.env` with fresh secrets, and installs the portal, either as the
> published Docker image (default) or natively with the systemd units below.
> Step 1, the API token, is still yours to do.
>
> ```bash
> bash -c "$(curl -fsSL https://github.com/nemerytamimi/proxmox-portal/releases/latest/download/create-lxc.sh)" -- \
>   --ip 10.98.3.131/24 --gw 10.98.3.1 --mtu 1420 \
>   --ssh-key /root/.ssh/terraform_pve --pve-token 'terraform@pve!provider=…'
> ```
>
> `releases/latest/download/` installs the newest release; swap in
> `releases/download/<tag>/` for a specific one. Each release's notes show the
> exact command for it.
>
> Docker installs upgrade with `docker compose pull && docker compose up -d` in
> `/opt/proxmox-portal` after changing `PORTAL_TAG` in its `.env`.

The portal runs in its own LXC. These steps are what was actually done to build
the reference install (CT 131, `10.98.3.131`) on the `nemertamimi` cluster.

## 1. Proxmox API token

The portal uses the same kind of token Terraform does. If you already have one,
reuse it; otherwise:

```bash
pveum role add TerraformProv -privs "Datastore.Allocate,Datastore.AllocateSpace,Datastore.AllocateTemplate,Datastore.Audit,Pool.Allocate,Pool.Audit,Sys.Audit,Sys.Console,Sys.Modify,VM.Allocate,VM.Audit,VM.Clone,VM.Config.CDROM,VM.Config.CPU,VM.Config.Cloudinit,VM.Config.Disk,VM.Config.HWType,VM.Config.Memory,VM.Config.Network,VM.Config.Options,VM.Console,VM.Migrate,VM.PowerMgmt,VM.Snapshot"
pveum user add terraform@pve
pveum acl modify / --user terraform@pve --role TerraformProv
pveum user token add terraform@pve provider --privsep 0
```

The token value is printed once. `VM.Migrate` is required for the migration
feature.

## 2. The container

Create it with Terraform (`portal-lxc.tf` in the sibling
`proxmox-terraform` repo) or by hand. Debian 13, 2 cores, 3 GB RAM, 20 GB disk,
`nesting=1`.

> **If your guest bridge runs a reduced MTU, fix it inside the container before
> anything else.** Proxmox applies `mtu=` only to the host side of the veth, so
> the guest's `eth0` still comes up at 1500. The mismatch black-holes large TLS
> handshakes: small requests work while `npm install` and Terraform provider
> downloads stall with no useful error.

```bash
pct exec 131 -- bash -c 'cat > /etc/network/if-up.d/zz-mtu <<EOF
#!/bin/sh
[ "\$IFACE" = "eth0" ] || exit 0
ip link set dev eth0 mtu 1420
EOF
chmod +x /etc/network/if-up.d/zz-mtu
ip link set dev eth0 mtu 1420'
```

This has to be an ifupdown hook, not a systemd unit — a unit runs before
ifupdown brings the interface up and the setting is lost.

## 3. Runtime

Inside the container:

```bash
apt-get update
apt-get install -y curl ca-certificates gnupg unzip sqlite3 openssh-client
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# Match the Terraform version you use elsewhere.
curl -fsSL -o /tmp/tf.zip https://releases.hashicorp.com/terraform/1.16.4/terraform_1.16.4_linux_amd64.zip
unzip -o /tmp/tf.zip -d /usr/local/bin/
```

## 4. Data directory and credentials

```bash
mkdir -p /var/lib/proxmox-portal/{workspaces,logs,plugin-cache,ssh}
```

The provider falls back to SSH for a few operations (importing a disk image,
uploading snippets), so copy in a private key whose public half is in `root`'s
`authorized_keys` on every node:

```bash
pct push 131 /root/.ssh/terraform_pve /var/lib/proxmox-portal/ssh/terraform_pve
pct exec 131 -- chmod 600 /var/lib/proxmox-portal/ssh/terraform_pve
```

Write `/var/lib/proxmox-portal/portal.env` from
[`.env.example`](../.env.example) and `chmod 600` it. Generate the two secrets
with `openssl rand -base64 32`. It lives on the data volume rather than in the
repo so a redeploy cannot clobber it.

## 5. The application

```bash
git clone <your-repo-url> /opt/proxmox-portal
cd /opt/proxmox-portal
ln -sf /var/lib/proxmox-portal/portal.env .env
npm install
npx prisma db push
npm run build

install -m644 deploy/proxmox-portal-web.service /etc/systemd/system/
install -m644 deploy/proxmox-portal-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now proxmox-portal-web proxmox-portal-worker
```

## 6. First run

Open `http://<container-ip>:3000` and register. **The first account becomes the
administrator.** If you are ever locked out:

```bash
npm run seed -- admin@example.com 'a sufficiently long password'
```

Then, as that admin:

1. Go to **Nodes**. Every node in the cluster is listed, including offline ones.
2. For each node you want to use, set the guest network profile — bridge, MTU,
   static or DHCP, and for static the subnet, gateway and pool range — then tick
   **Available for provisioning**. Detected bridges and storages are shown above
   the form for reference.
3. Tick **Allow VMs** only on nodes with hardware virtualisation. The portal
   probes for this and seeds the flag, but you have the final say.

Nothing can be ordered onto a node until it is configured, which is deliberate:
bridges are per-node and there is no safe default to guess.

## Upgrading

```bash
cd /opt/proxmox-portal
git pull
npm install
npx prisma db push
npm run build
systemctl restart proxmox-portal-web proxmox-portal-worker
```

Stopping the worker lets the job it is holding finish first
(`TimeoutStopSec=900`), so an in-flight apply is not abandoned half-done.

## Operating notes

- **Logs**: `journalctl -u proxmox-portal-worker -f`. Per-job Terraform output is
  in `/var/lib/proxmox-portal/logs/<jobId>.log`.
- **A guest stuck in ERROR**: open it and use **Re-apply**. That replays the
  desired state, which reconciles most failures.
- **Interrupted jobs**: a job still marked `RUNNING` when the worker starts is
  failed on purpose rather than retried — the guest is in an unknown state and
  silently re-running a half-applied change is worse than saying so.
- **Backups**: `/var/lib/proxmox-portal` is the whole of the portal's state. The
  database and the Terraform workspaces must be backed up together; a workspace
  without its state file cannot manage its guest.
