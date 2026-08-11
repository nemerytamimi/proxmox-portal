import { z } from "zod";

import { audit } from "./audit";
import { prisma } from "./db";
import { enqueue } from "./orders";
import { willReaddress } from "./ipam";
import { guestStatus, observedIpv4, powerAction } from "./pve";
import { checkQuota } from "./quota";
import { unusableReason } from "./nodes";
import { isBusy, type PowerAction } from "./types";

export class GuestError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

async function loadOwned(guestId: string, userId: string, isAdmin: boolean) {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    include: { node: true, owner: true },
  });
  if (!guest) throw new GuestError("Guest not found.");
  if (!isAdmin && guest.ownerId !== userId) {
    throw new GuestError("Guest not found."); // don't leak existence
  }
  return guest;
}

/** Live status straight from Proxmox — state files lag reality. */
export async function liveStatus(guestId: string) {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    include: { node: true },
  });
  if (!guest || guest.status === "DESTROYED") return null;
  try {
    return await guestStatus(
      guest.kind as "LXC" | "VM",
      guest.node.name,
      guest.vmid,
    );
  } catch {
    return null;
  }
}

/**
 * The address the guest is actually reachable on. Matters most for DHCP nodes,
 * where the requested value is literally the string "dhcp".
 */
export async function observedAddress(guestId: string): Promise<string | null> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    include: { node: true },
  });
  if (!guest || guest.status === "DESTROYED") return null;
  return observedIpv4(guest.kind as "LXC" | "VM", guest.node.name, guest.vmid);
}

export async function doPowerAction(
  userId: string,
  isAdmin: boolean,
  guestId: string,
  action: PowerAction,
): Promise<void> {
  const guest = await loadOwned(guestId, userId, isAdmin);

  if (guest.status === "DESTROYED") {
    throw new GuestError("This guest has been destroyed.");
  }
  if (isBusy(guest.status)) {
    throw new GuestError(
      "A Terraform job is running against this guest; wait for it to finish.",
    );
  }

  await powerAction(
    guest.kind as "LXC" | "VM",
    guest.node.name,
    guest.vmid,
    action,
  );
  await audit(userId, `guest.${action}`, guest.id, guest.hostname);
}

export const resizeSchema = z.object({
  cores: z.coerce.number().int().min(1).max(32),
  memoryMb: z.coerce.number().int().min(256).max(131072),
  swapMb: z.coerce.number().int().min(0).max(65536),
  diskGb: z.coerce.number().int().min(4).max(2048),
});

/**
 * Resize rewrites the desired specs and re-applies. Disk shrink is refused
 * outright: Proxmox cannot shrink a volume, and Terraform would either error
 * out mid-apply or, worse, propose a replacement that discards the data.
 */
export async function resizeGuest(
  userId: string,
  isAdmin: boolean,
  guestId: string,
  input: z.infer<typeof resizeSchema>,
): Promise<string> {
  const guest = await loadOwned(guestId, userId, isAdmin);

  if (guest.status === "DESTROYED") {
    throw new GuestError("This guest has been destroyed.");
  }
  if (isBusy(guest.status)) {
    throw new GuestError("A job is already running against this guest.");
  }
  if (input.diskGb < guest.diskGb) {
    throw new GuestError(
      `Disks cannot be shrunk. This guest already has ${guest.diskGb} GB.`,
    );
  }

  const quota = await checkQuota(guest.ownerId, {
    cores: input.cores,
    memoryMb: input.memoryMb,
    diskGb: input.diskGb,
    replacingGuestId: guest.id,
  });
  if (!quota.ok) {
    throw new GuestError("This resize exceeds the quota.", quota.errors);
  }

  await prisma.guest.update({
    where: { id: guest.id },
    data: {
      cores: input.cores,
      memoryMb: input.memoryMb,
      swapMb: input.swapMb,
      diskGb: input.diskGb,
      status: "UPDATING",
    },
  });

  const jobId = await enqueue(guest.id, "APPLY", userId);
  await audit(
    userId,
    "guest.resize",
    guest.id,
    `${guest.cores}c/${guest.memoryMb}MB/${guest.diskGb}GB -> ` +
      `${input.cores}c/${input.memoryMb}MB/${input.diskGb}GB`,
  );
  return jobId;
}

export async function destroyGuest(
  userId: string,
  isAdmin: boolean,
  guestId: string,
): Promise<string> {
  const guest = await loadOwned(guestId, userId, isAdmin);

  if (guest.status === "DESTROYED") {
    throw new GuestError("This guest is already destroyed.");
  }
  if (isBusy(guest.status)) {
    throw new GuestError("A job is already running against this guest.");
  }

  await prisma.guest.update({
    where: { id: guest.id },
    data: { status: "DESTROYING" },
  });

  const jobId = await enqueue(guest.id, "DESTROY", userId);
  await audit(userId, "guest.destroy", guest.id, guest.hostname);
  return jobId;
}

export interface MigrationPreview {
  readdressing: boolean;
  fromNode: string;
  toNode: string;
  fromBridge: string;
  toBridge: string;
  note: string | null;
}

/**
 * What a migration would change, for the confirmation screen. On this cluster
 * `vmbr1` (10.98.3.0/24) exists only on vmi3482497, so moving off it means a
 * different bridge and a different address — worth saying out loud before
 * someone loses SSH to a box.
 */
export async function previewMigration(
  guestId: string,
  targetNodeId: string,
): Promise<MigrationPreview> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    include: { node: true },
  });
  if (!guest) throw new GuestError("Guest not found.");

  const target = await prisma.pveNode.findUnique({
    where: { id: targetNodeId },
  });
  if (!target) throw new GuestError("Target node not found.");

  const readdressing = willReaddress(guest.node, target);
  return {
    readdressing,
    fromNode: guest.node.name,
    toNode: target.name,
    fromBridge: guest.node.bridge,
    toBridge: target.bridge,
    note: readdressing
      ? `The guest moves from ${guest.node.bridge} (${guest.node.addressing}) to ` +
        `${target.bridge} (${target.addressing}) and will get a new address. ` +
        `Its current address ${guest.ipv4Address} will stop working.`
      : null,
  };
}

/** Admin-only: migration decides placement, which is not a tenant's call. */
export async function migrateGuestToNode(
  adminId: string,
  guestId: string,
  targetNodeId: string,
): Promise<string> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    include: { node: true },
  });
  if (!guest) throw new GuestError("Guest not found.");

  if (guest.status === "DESTROYED") {
    throw new GuestError("This guest has been destroyed.");
  }
  if (isBusy(guest.status)) {
    throw new GuestError("A job is already running against this guest.");
  }
  if (guest.nodeId === targetNodeId) {
    throw new GuestError("The guest is already on that node.");
  }

  const target = await prisma.pveNode.findUnique({
    where: { id: targetNodeId },
  });
  if (!target) throw new GuestError("Target node not found.");

  const reason = unusableReason(target, guest.kind as "LXC" | "VM");
  if (reason) {
    throw new GuestError(`${target.name} cannot host this guest: ${reason}.`);
  }

  await prisma.guest.update({
    where: { id: guest.id },
    data: { status: "MIGRATING" },
  });

  const jobId = await enqueue(guest.id, "MIGRATE", adminId, target.id);
  await audit(
    adminId,
    "guest.migrate",
    guest.id,
    `${guest.node.name} -> ${target.name}`,
  );
  return jobId;
}

/** Re-run the last desired state. The way out of an ERROR status. */
export async function reapplyGuest(
  userId: string,
  isAdmin: boolean,
  guestId: string,
): Promise<string> {
  const guest = await loadOwned(guestId, userId, isAdmin);
  if (guest.status === "DESTROYED") {
    throw new GuestError("This guest has been destroyed.");
  }
  if (isBusy(guest.status)) {
    throw new GuestError("A job is already running against this guest.");
  }

  const jobId = await enqueue(guest.id, "APPLY", userId);
  await audit(userId, "guest.reapply", guest.id, guest.hostname);
  return jobId;
}
