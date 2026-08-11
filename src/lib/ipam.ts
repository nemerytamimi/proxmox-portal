import type { PveNode } from "@prisma/client";

import { prisma } from "./db";
import { listClusterGuests, nextId } from "./pve";

/**
 * VMID and address allocation.
 *
 * The house convention on this cluster is that a guest's last IP octet equals
 * its VMID, so on a statically addressed node the two allocations are the same
 * decision. That keeps 10.98.3.x readable at a glance but means the VMID has to
 * come from the node's pool range rather than from /cluster/nextid.
 */

export interface Allocation {
  vmid: number;
  /** "10.98.3.140/24" on a static node, "dhcp" on a DHCP one. */
  ipv4Address: string;
  ipv4Gateway: string | null;
}

export class AllocationError extends Error {}

/** VMIDs in use anywhere — on the cluster, or reserved by a portal record. */
async function takenVmids(): Promise<Set<number>> {
  const [cluster, guests] = await Promise.all([
    listClusterGuests(),
    prisma.guest.findMany({
      where: { status: { not: "DESTROYED" } },
      select: { vmid: true },
    }),
  ]);

  const taken = new Set<number>();
  for (const g of cluster) taken.add(g.vmid);
  for (const g of guests) taken.add(g.vmid);
  return taken;
}

export async function allocate(node: PveNode): Promise<Allocation> {
  const taken = await takenVmids();

  if (node.addressing === "dhcp") {
    // Nothing ties the id to an address here, so let Proxmox pick, then step
    // forward past anything the portal has reserved but not yet created.
    let vmid = await nextId();
    while (taken.has(vmid)) vmid += 1;
    return { vmid, ipv4Address: "dhcp", ipv4Gateway: null };
  }

  if (!node.subnetPrefix || !node.gateway) {
    throw new AllocationError(
      `Node ${node.name} is set to static addressing but has no subnet prefix or gateway configured.`,
    );
  }

  const start = node.ipPoolStart ?? 2;
  const end = node.ipPoolEnd ?? 254;
  if (start > end) {
    throw new AllocationError(
      `Node ${node.name} has an inverted IP pool range (${start}–${end}).`,
    );
  }

  for (let candidate = start; candidate <= end; candidate += 1) {
    if (taken.has(candidate)) continue;
    return {
      vmid: candidate,
      ipv4Address: `${node.subnetPrefix}.${candidate}/24`,
      ipv4Gateway: node.gateway,
    };
  }

  throw new AllocationError(
    `No free VMID/address left on ${node.name}: the pool ${start}–${end} is fully allocated.`,
  );
}

/**
 * Work out the address a guest should get after moving to a different node.
 * Bridges are per-node here — `vmbr1` (10.98.3.0/24) exists only on
 * vmi3482497 — so a migration is nearly always a re-addressing too.
 */
export async function reallocateForNode(
  node: PveNode,
  currentVmid: number,
): Promise<Allocation> {
  if (node.addressing === "dhcp") {
    return { vmid: currentVmid, ipv4Address: "dhcp", ipv4Gateway: null };
  }

  if (!node.subnetPrefix || !node.gateway) {
    throw new AllocationError(
      `Node ${node.name} is set to static addressing but has no subnet prefix or gateway configured.`,
    );
  }

  // Keeping the VMID keeps the convention intact, but only if that octet is
  // inside the target node's pool and not already spoken for.
  const start = node.ipPoolStart ?? 2;
  const end = node.ipPoolEnd ?? 254;
  const taken = await takenVmids();

  if (currentVmid >= start && currentVmid <= end) {
    return {
      vmid: currentVmid,
      ipv4Address: `${node.subnetPrefix}.${currentVmid}/24`,
      ipv4Gateway: node.gateway,
    };
  }

  for (let candidate = start; candidate <= end; candidate += 1) {
    if (taken.has(candidate) && candidate !== currentVmid) continue;
    return {
      vmid: currentVmid,
      ipv4Address: `${node.subnetPrefix}.${candidate}/24`,
      ipv4Gateway: node.gateway,
    };
  }

  throw new AllocationError(
    `No free address left in ${node.name}'s pool ${start}–${end} for the migrated guest.`,
  );
}

/**
 * Does moving to `target` change how the guest is reached? Used to warn before
 * a migration silently changes someone's SSH address.
 */
export function willReaddress(
  from: Pick<PveNode, "bridge" | "addressing" | "subnetPrefix">,
  to: Pick<PveNode, "bridge" | "addressing" | "subnetPrefix">,
): boolean {
  return (
    from.bridge !== to.bridge ||
    from.addressing !== to.addressing ||
    from.subnetPrefix !== to.subnetPrefix
  );
}
