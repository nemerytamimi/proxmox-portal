import type { PveNode } from "@prisma/client";

import { prisma } from "./db";
import { listNodes, probeVmCapability } from "./pve";

/**
 * Node discovery.
 *
 * The portal never hard-codes the cluster's shape. It asks Proxmox what nodes
 * exist and reconciles that into the database, so a node that is offline today
 * (`server`) or added next month appears on its own. What discovery will not do
 * is guess a node's guest network: bridges are per-node here, so a new node
 * arrives `configured = false` and an admin must fill in the profile before it
 * can be picked as a provisioning target.
 */

export interface SyncResult {
  discovered: number;
  added: string[];
  online: string[];
  offline: string[];
}

export async function syncNodes(): Promise<SyncResult> {
  const summaries = await listNodes();
  const existing = await prisma.pveNode.findMany();
  const byName = new Map(existing.map((n) => [n.name, n]));

  const result: SyncResult = {
    discovered: summaries.length,
    added: [],
    online: [],
    offline: [],
  };

  for (const s of summaries) {
    const online = s.status === "online";
    (online ? result.online : result.offline).push(s.node);

    const current = byName.get(s.node);
    const base = {
      online,
      maxCpu: s.maxcpu ?? null,
      maxMemoryMb: s.maxmem ? Math.round(s.maxmem / 1024 / 1024) : null,
      lastSeenAt: online ? new Date() : (current?.lastSeenAt ?? null),
    };

    // Only probe nodes that are up; an offline node tells us nothing and we
    // must not flip a working allowVms off because it happens to be down.
    const canRunVms = online ? await probeVmCapability(s.node) : null;

    if (!current) {
      await prisma.pveNode.create({
        data: {
          name: s.node,
          ...base,
          configured: false,
          // Seeded from the probe; an admin can override either way.
          allowVms: canRunVms === true,
          allowLxc: true,
        },
      });
      result.added.push(s.node);
      continue;
    }

    await prisma.pveNode.update({
      where: { id: current.id },
      data: {
        ...base,
        // Never overwrite a deliberate admin choice on a configured node —
        // only seed the capability while it is still untouched.
        ...(current.configured || canRunVms === null
          ? {}
          : { allowVms: canRunVms }),
      },
    });
  }

  // A node removed from the cluster is marked offline rather than deleted:
  // guests may still reference it.
  const seen = new Set(summaries.map((s) => s.node));
  for (const node of existing) {
    if (!seen.has(node.name) && node.online) {
      await prisma.pveNode.update({
        where: { id: node.id },
        data: { online: false },
      });
      result.offline.push(node.name);
    }
  }

  return result;
}

/**
 * Nodes an admin may actually place this kind of guest on. VM orders exclude
 * nodes without KVM — on this cluster that is `vmi3482497`, a VPS with no
 * nested virtualisation, where `qm start` fails outright.
 */
export async function placeableNodes(kind: "LXC" | "VM"): Promise<PveNode[]> {
  return prisma.pveNode.findMany({
    where: {
      online: true,
      configured: true,
      ...(kind === "VM" ? { allowVms: true } : { allowLxc: true }),
    },
    orderBy: { name: "asc" },
  });
}

/** Human-readable reason a node cannot be used, or null when it can. */
export function unusableReason(node: PveNode, kind: "LXC" | "VM"): string | null {
  if (!node.online) return "offline";
  if (!node.configured) return "no network profile configured";
  if (kind === "VM" && !node.allowVms) return "cannot run VMs (no KVM)";
  if (kind === "LXC" && !node.allowLxc) return "containers disabled";
  return null;
}
