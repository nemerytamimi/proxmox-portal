import Link from "next/link";
import { notFound } from "next/navigation";

import {
  DangerZone,
  MigrateForm,
  PowerControls,
  ResizeForm,
  type MigrationTarget,
} from "./GuestActions";
import { JobLog } from "@/components/JobLog";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { liveStatus, observedAddress } from "@/lib/guests";
import { willReaddress } from "@/lib/ipam";
import { placeableNodes } from "@/lib/nodes";
import { isBusy } from "@/lib/types";
import { Badge, bytes, Panel, statusTone } from "@/components/ui";

export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line/50 py-2 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export default async function GuestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const isAdmin = session!.user.role === "ADMIN";

  const guest = await prisma.guest.findUnique({
    where: { id },
    include: {
      node: true,
      owner: { select: { email: true } },
      jobs: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!guest || (!isAdmin && guest.ownerId !== session!.user.id)) notFound();

  const busy = isBusy(guest.status);
  const latestJob = guest.jobs[0];

  // Live from Proxmox: the state file says what we asked for, not what is.
  const [live, observed] =
    guest.status === "DESTROYED"
      ? [null, null]
      : await Promise.all([liveStatus(guest.id), observedAddress(guest.id)]);
  const running = live?.status === "running";

  const isIso = guest.kind === "VM" && !!guest.isoFileId;
  const source =
    guest.kind === "LXC"
      ? guest.templateFileId
      : (guest.isoFileId ??
        guest.templateFileId ??
        (guest.cloneVmId ? `clone of ${guest.cloneVmId}` : null));

  // Proxmox's own noVNC console for this VM. It needs a Proxmox login; the
  // portal has no console of its own.
  let consoleUrl: string | null = null;
  if (isIso && guest.status !== "DESTROYED") {
    try {
      const q = new URLSearchParams({
        console: "kvm",
        novnc: "1",
        vmid: String(guest.vmid),
        vmname: guest.hostname,
        node: guest.node.name,
      });
      consoleUrl = `${env.pveEndpoint}/?${q}`;
    } catch {
      consoleUrl = null;
    }
  }
  const dns = guest.node.dnsServers
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  let targets: MigrationTarget[] = [];
  if (isAdmin && guest.status !== "DESTROYED") {
    const nodes = await placeableNodes(guest.kind as "LXC" | "VM");
    targets = nodes
      .filter((n) => n.id !== guest.nodeId)
      .map((n) => ({
        id: n.id,
        name: n.name,
        bridge: n.bridge,
        addressing: n.addressing,
        readdresses: willReaddress(guest.node, n),
      }));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/dashboard" className="text-sm text-muted hover:text-fg">
          ← Back
        </Link>
        <h1 className="text-xl font-semibold">{guest.hostname}</h1>
        <Badge tone={statusTone(guest.status)}>{guest.status}</Badge>
        {live && <Badge tone={statusTone(live.status)}>{live.status}</Badge>}
      </div>

      {guest.statusDetail && (
        <div className="rounded-md border border-bad/40 bg-panel-2 px-4 py-3 text-sm text-bad">
          {guest.statusDetail}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Details">
          <Row label="Kind" value={guest.kind} />
          <Row label="Node" value={guest.node.name} />
          <Row label="VMID" value={guest.vmid} />
          {source && (
            <Row
              label={isIso ? "Installed from ISO" : guest.kind === "LXC" ? "Template" : "Image"}
              value={<span className="break-all font-mono text-xs">{source}</span>}
            />
          )}
          <Row
            label="Address"
            value={
              guest.ipv4Address === "dhcp"
                ? (observed ?? "DHCP — not reported yet")
                : guest.ipv4Address
            }
          />
          {observed && guest.ipv4Address !== "dhcp" && !guest.ipv4Address.startsWith(observed) && (
            <Row label="Observed" value={observed} />
          )}
          <Row label="Gateway" value={guest.ipv4Gateway ?? "—"} />
          <Row label="Bridge" value={`${guest.bridge}${guest.mtu ? ` (MTU ${guest.mtu})` : ""}`} />
          <Row
            label="Specs"
            value={`${guest.cores} cores · ${guest.memoryMb} MB · ${guest.diskGb} GB`}
          />
          {isAdmin && <Row label="Owner" value={guest.owner.email} />}
        </Panel>

        <Panel title="Live from Proxmox">
          {live ? (
            <>
              <Row label="State" value={live.status} />
              <Row
                label="Uptime"
                value={
                  live.uptime
                    ? `${Math.floor(live.uptime / 3600)}h ${Math.floor((live.uptime % 3600) / 60)}m`
                    : "—"
                }
              />
              <Row
                label="CPU"
                value={live.cpu !== undefined ? `${(live.cpu * 100).toFixed(1)}%` : "—"}
              />
              <Row
                label="Memory"
                value={`${bytes(live.mem)} / ${bytes(live.maxmem)}`}
              />
              <Row
                label="Disk"
                value={`${bytes(live.disk)} / ${bytes(live.maxdisk)}`}
              />
            </>
          ) : (
            <p className="py-4 text-sm text-muted">
              {guest.status === "DESTROYED"
                ? "This guest has been destroyed."
                : "Not reachable on the cluster yet."}
            </p>
          )}
        </Panel>
      </div>

      {isIso && guest.status !== "DESTROYED" && (
        <Panel
          title="Install from ISO"
          description="This VM booted the installer on a blank disk. Nothing inside it is configured by the portal: finish the install from the console."
        >
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Open the console
              {consoleUrl ? (
                <>
                  {" "}
                  in Proxmox:{" "}
                  <a
                    href={consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    VM {guest.vmid} on {guest.node.name}
                  </a>{" "}
                  <span className="text-muted">(needs a Proxmox login)</span>
                </>
              ) : (
                <> for VM {guest.vmid} on {guest.node.name} in Proxmox.</>
              )}
            </li>
            <li>
              Configure the network in the installer
              {guest.ipv4Address === "dhcp" ? (
                <> as DHCP; the address shows above once the VM reports one.</>
              ) : (
                <>
                  {" "}
                  with the address reserved for this VM:
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line bg-panel-2 p-3 font-mono text-xs">
                    <dt className="text-muted">Address</dt>
                    <dd>{guest.ipv4Address}</dd>
                    <dt className="text-muted">Gateway</dt>
                    <dd>{guest.ipv4Gateway ?? "—"}</dd>
                    <dt className="text-muted">DNS</dt>
                    <dd>{dns.join(", ") || "—"}</dd>
                    {guest.mtu > 0 && (
                      <>
                        <dt className="text-muted">MTU</dt>
                        <dd>{guest.mtu}</dd>
                      </>
                    )}
                  </dl>
                </>
              )}
            </li>
            <li>Create your user and password in the installer.</li>
            <li>
              Reboot when it finishes. The VM boots from its disk from then on; the
              ISO stays attached until someone ejects it in Proxmox.
            </li>
          </ol>
        </Panel>
      )}

      {guest.status !== "DESTROYED" && (
        <Panel
          title="Power"
          description="Applied directly through the Proxmox API — running or stopped is not part of the Terraform-managed state."
        >
          <PowerControls guestId={guest.id} busy={busy} running={running} />
        </Panel>
      )}

      {latestJob && (
        <Panel
          title={`Latest job — ${latestJob.kind}`}
          description={`Queued ${latestJob.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC`}
        >
          <JobLog jobId={latestJob.id} initialState={latestJob.state} />
        </Panel>
      )}

      {guest.status !== "DESTROYED" && (
        <Panel
          title="Resize"
          description="Rewrites the desired specs and re-runs Terraform. Disks can grow but never shrink."
        >
          <ResizeForm
            guestId={guest.id}
            busy={busy}
            isLxc={guest.kind === "LXC"}
            current={{
              cores: guest.cores,
              memoryMb: guest.memoryMb,
              swapMb: guest.swapMb,
              diskGb: guest.diskGb,
            }}
          />
        </Panel>
      )}

      {isAdmin && guest.status !== "DESTROYED" && (
        <Panel
          title="Migrate"
          description={
            guest.kind === "VM"
              ? isIso
                ? "Terraform issues a live migration when the node changes. Eject the install ISO in Proxmox first: Proxmox refuses to migrate a VM with a CD-ROM on node-local storage."
                : "Terraform issues a live migration when the node changes."
              : "Containers are moved through the Proxmox API and then re-imported into Terraform state — the provider cannot migrate them directly."
          }
        >
          <MigrateForm guestId={guest.id} busy={busy} targets={targets} />
        </Panel>
      )}

      {guest.status !== "DESTROYED" && (
        <Panel title="Danger zone">
          <DangerZone
            guestId={guest.id}
            hostname={guest.hostname}
            busy={busy}
            errored={guest.status === "ERROR"}
          />
        </Panel>
      )}

      {guest.jobs.length > 1 && (
        <Panel title="Job history">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="pb-2 pr-4">Kind</th>
                <th className="pb-2 pr-4">State</th>
                <th className="pb-2 pr-4">Started</th>
                <th className="pb-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {guest.jobs.map((j) => (
                <tr key={j.id} className="border-b border-line/50">
                  <td className="py-2 pr-4">{j.kind}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={statusTone(j.state)}>{j.state}</Badge>
                  </td>
                  <td className="py-2 pr-4 text-muted">
                    {j.startedAt
                      ? j.startedAt.toISOString().replace("T", " ").slice(0, 19)
                      : "—"}
                  </td>
                  <td className="py-2 text-muted">{j.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
