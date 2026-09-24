import { z } from "zod";

import { audit } from "./audit";
import { volumeOnNode } from "./catalog";
import { prisma } from "./db";
import { encryptSecret } from "./crypto";
import { allocate } from "./ipam";
import { checkQuota } from "./quota";
import { unusableReason } from "./nodes";
import { GUEST_KINDS, OS_TYPES } from "./types";

/**
 * Order lifecycle: a user describes what they want, an admin decides where it
 * goes. Nothing touches the cluster until approval, which is also the moment a
 * VMID and address are reserved — allocating at submit time would strand ids on
 * orders that are never approved.
 */

export const orderSchema = z
  .object({
    kind: z.enum(GUEST_KINDS),
    hostname: z
      .string()
      .trim()
      .min(1, "Hostname is required")
      .max(63)
      .regex(
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
        "Lowercase letters, digits and hyphens only; must not start or end with a hyphen",
      ),
    cores: z.coerce.number().int().min(1).max(32),
    memoryMb: z.coerce.number().int().min(256).max(131072),
    swapMb: z.coerce.number().int().min(0).max(65536).default(512),
    diskGb: z.coerce.number().int().min(4).max(2048),
    templateFileId: z.string().trim().min(1).optional(),
    cloneVmId: z.coerce.number().int().positive().optional(),
    isoFileId: z.string().trim().min(1).optional(),
    // Constrained rather than free text: Proxmox rejects anything outside this
    // set, and it only finds out at apply time.
    osType: z.enum(OS_TYPES).default("debian"),
    ciUser: z.string().trim().default("debian"),
    sshPublicKey: z
      .string()
      .trim()
      .optional()
      .refine(
        (v) => !v || /^(ssh-(rsa|ed25519)|ecdsa-sha2-)\S+\s+\S+/.test(v),
        "That does not look like an OpenSSH public key",
      ),
    rootPassword: z.string().min(8).max(128).optional().or(z.literal("")),
    preferredNodeId: z.string().trim().optional().or(z.literal("")),
  })
  .refine((o) => o.kind === "VM" || !!o.templateFileId, {
    message: "A container template is required",
    path: ["templateFileId"],
  })
  .refine(
    (o) =>
      o.kind === "LXC" ||
      [o.templateFileId, o.cloneVmId, o.isoFileId].filter(Boolean).length === 1,
    {
      message: "Pick exactly one of a cloud image, an ISO, or a template to clone",
      path: ["templateFileId"],
    },
  )
  .refine((o) => o.kind === "VM" || !o.isoFileId, {
    message: "ISOs are for virtual machines only",
    path: ["isoFileId"],
  })
  // An ISO installer asks for the account itself; nothing is injected.
  .refine((o) => !!o.isoFileId || !!o.sshPublicKey || !!o.rootPassword, {
    message: "Provide an SSH public key or a root password — otherwise you cannot log in",
    path: ["sshPublicKey"],
  });

/** Whether an order or guest boots an installer ISO rather than a prepared image. */
export function isIsoInstall(g: { kind: string; isoFileId: string | null }): boolean {
  return g.kind === "VM" && !!g.isoFileId;
}

export type OrderInput = z.infer<typeof orderSchema>;

export class OrderError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export async function createOrder(
  userId: string,
  input: OrderInput,
): Promise<string> {
  const quota = await checkQuota(userId, {
    cores: input.cores,
    memoryMb: input.memoryMb,
    diskGb: input.diskGb,
  });
  if (!quota.ok) {
    throw new OrderError("This request exceeds your quota.", quota.errors);
  }

  const clash = await prisma.guest.findFirst({
    where: { hostname: input.hostname, status: { not: "DESTROYED" } },
  });
  if (clash) {
    throw new OrderError(`The hostname "${input.hostname}" is already in use.`);
  }

  const order = await prisma.order.create({
    data: {
      userId,
      kind: input.kind,
      hostname: input.hostname,
      cores: input.cores,
      memoryMb: input.memoryMb,
      swapMb: input.swapMb,
      diskGb: input.diskGb,
      templateFileId: input.templateFileId ?? null,
      cloneVmId: input.cloneVmId ?? null,
      isoFileId: input.kind === "VM" ? (input.isoFileId ?? null) : null,
      osType: input.osType,
      ciUser: input.ciUser,
      sshPublicKey: input.sshPublicKey || null,
      rootPasswordEnc: input.rootPassword
        ? encryptSecret(input.rootPassword)
        : null,
      preferredNodeId: input.preferredNodeId || null,
      status: "PENDING",
    },
  });

  await audit(userId, "order.create", order.id, `${input.kind} ${input.hostname}`);
  return order.id;
}

/**
 * Approve an order onto a specific node. The node is the admin's decision, not
 * the user's: only an admin can see which nodes are online, which have KVM, and
 * which have capacity.
 */
export async function approveOrder(
  adminId: string,
  orderId: string,
  nodeId: string,
  note?: string,
): Promise<string> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new OrderError("Order not found.");
  if (order.status !== "PENDING") {
    throw new OrderError(`This order is already ${order.status.toLowerCase()}.`);
  }

  const node = await prisma.pveNode.findUnique({ where: { id: nodeId } });
  if (!node) throw new OrderError("That node no longer exists.");

  const reason = unusableReason(node, order.kind as "LXC" | "VM");
  if (reason) {
    throw new OrderError(`${node.name} cannot host this guest: ${reason}.`);
  }

  // Node-local storage differs per node: without this check the apply fails
  // minutes later, after a VMID and address have been allocated.
  const image = imageOf(order);
  if (image && !(await volumeOnNode(node.name, image.volid, image.contentType))) {
    throw new OrderError(
      `${node.name} does not have ${image.volid}. Pick a node that does, or copy the file to this node first.`,
    );
  }

  const allocation = await allocate(node);

  // Belt and braces: allocation consults the live cluster and active guests,
  // but two admins approving at once could still land on the same id.
  const collision = await prisma.guest.findFirst({
    where: {
      nodeId: node.id,
      vmid: allocation.vmid,
      status: { not: "DESTROYED" },
    },
  });
  if (collision) {
    throw new OrderError(
      `VMID ${allocation.vmid} on ${node.name} was just taken by "${collision.hostname}". Try approving again.`,
    );
  }

  const guest = await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: "APPROVED",
        nodeId: node.id,
        reviewerId: adminId,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
      },
    });

    return tx.guest.create({
      data: {
        ownerId: order.userId,
        orderId: order.id,
        nodeId: node.id,
        kind: order.kind,
        vmid: allocation.vmid,
        hostname: order.hostname,
        cores: order.cores,
        memoryMb: order.memoryMb,
        swapMb: order.swapMb,
        diskGb: order.diskGb,
        ipv4Address: allocation.ipv4Address,
        ipv4Gateway: allocation.ipv4Gateway,
        bridge: node.bridge,
        mtu: node.mtu,
        datastore: node.defaultDatastore,
        templateFileId: order.templateFileId,
        cloneVmId: order.cloneVmId,
        isoFileId: order.isoFileId,
        osType: order.osType,
        ciUser: order.ciUser,
        sshPublicKey: order.sshPublicKey,
        rootPasswordEnc: order.rootPasswordEnc,
        status: "PROVISIONING",
        workspacePath: "",
      },
    });
  });

  await prisma.guest.update({
    where: { id: guest.id },
    data: { workspacePath: `workspaces/${guest.id}` },
  });

  await enqueue(guest.id, "APPLY", adminId);
  await audit(
    adminId,
    "order.approve",
    order.id,
    `${order.kind} ${order.hostname} -> ${node.name} (vmid ${allocation.vmid}, ${allocation.ipv4Address})`,
  );

  return guest.id;
}

export async function rejectOrder(
  adminId: string,
  orderId: string,
  note: string,
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new OrderError("Order not found.");
  if (order.status !== "PENDING") {
    throw new OrderError(`This order is already ${order.status.toLowerCase()}.`);
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: "REJECTED",
      reviewerId: adminId,
      reviewedAt: new Date(),
      reviewNote: note,
    },
  });
  await audit(adminId, "order.reject", orderId, note);
}

/** Queue a job for the worker. Log path is derived, never chosen by a caller. */
export async function enqueue(
  guestId: string,
  kind: "APPLY" | "DESTROY" | "MIGRATE",
  createdBy: string | null,
  targetNodeId?: string,
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      guestId,
      kind,
      state: "QUEUED",
      targetNodeId: targetNodeId ?? null,
      createdBy,
      logPath: "",
    },
  });

  const { paths } = await import("./env");
  await prisma.job.update({
    where: { id: job.id },
    data: { logPath: paths.log(job.id) },
  });

  return job.id;
}

/** The storage volume an order is built from, if any (a clone has none). */
export function imageOf(order: {
  kind: string;
  templateFileId: string | null;
  isoFileId: string | null;
}): { volid: string; contentType: "vztmpl" | "import" | "iso" } | null {
  if (order.kind === "VM" && order.isoFileId) {
    return { volid: order.isoFileId, contentType: "iso" };
  }
  if (!order.templateFileId) return null;
  return {
    volid: order.templateFileId,
    contentType: order.kind === "LXC" ? "vztmpl" : "import",
  };
}
