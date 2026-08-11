"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncNodes } from "@/lib/nodes";
import { ADDRESSING_MODES } from "@/lib/types";

export interface NodeState {
  error?: string;
  issues?: string[];
  ok?: string;
}

export async function refreshNodesAction(): Promise<void> {
  await requireAdmin();
  await syncNodes();
  revalidatePath("/admin/nodes");
}

const profileSchema = z
  .object({
    nodeId: z.string().min(1),
    configured: z.coerce.boolean(),
    allowLxc: z.coerce.boolean(),
    allowVms: z.coerce.boolean(),
    bridge: z.string().trim().min(1, "A bridge is required"),
    mtu: z.coerce.number().int().min(0).max(9000),
    addressing: z.enum(ADDRESSING_MODES),
    subnetPrefix: z.string().trim().optional(),
    gateway: z.string().trim().optional(),
    ipPoolStart: z.coerce.number().int().min(2).max(254).optional(),
    ipPoolEnd: z.coerce.number().int().min(2).max(254).optional(),
    dnsServers: z.string().trim().default("1.1.1.1,8.8.8.8"),
    defaultDatastore: z.string().trim().min(1),
    templateDatastore: z.string().trim().min(1),
    notes: z.string().trim().optional(),
  })
  .refine(
    (v) =>
      v.addressing !== "static" ||
      (!!v.subnetPrefix && !!v.gateway && !!v.ipPoolStart && !!v.ipPoolEnd),
    {
      message:
        "Static addressing needs a subnet prefix, a gateway and an IP pool range",
      path: ["subnetPrefix"],
    },
  )
  .refine(
    (v) =>
      v.addressing !== "static" ||
      (v.ipPoolStart ?? 0) <= (v.ipPoolEnd ?? 0),
    { message: "The IP pool range is inverted", path: ["ipPoolEnd"] },
  );

export async function saveNodeAction(
  _prev: NodeState,
  formData: FormData,
): Promise<NodeState> {
  const admin = await requireAdmin();

  const raw = Object.fromEntries(formData.entries());
  const parsed = profileSchema.safeParse({
    ...raw,
    // Unchecked checkboxes are simply absent from the payload.
    configured: formData.get("configured") === "on",
    allowLxc: formData.get("allowLxc") === "on",
    allowVms: formData.get("allowVms") === "on",
    subnetPrefix: raw.subnetPrefix || undefined,
    gateway: raw.gateway || undefined,
    ipPoolStart: raw.ipPoolStart || undefined,
    ipPoolEnd: raw.ipPoolEnd || undefined,
    notes: raw.notes || undefined,
  });

  if (!parsed.success) {
    return {
      error: "Check the profile.",
      issues: parsed.error.issues.map((i) => i.message),
    };
  }

  const { nodeId, ...profile } = parsed.data;

  await prisma.pveNode.update({
    where: { id: nodeId },
    data: {
      configured: profile.configured,
      allowLxc: profile.allowLxc,
      allowVms: profile.allowVms,
      bridge: profile.bridge,
      mtu: profile.mtu,
      addressing: profile.addressing,
      subnetPrefix: profile.subnetPrefix ?? null,
      gateway: profile.gateway ?? null,
      ipPoolStart: profile.ipPoolStart ?? null,
      ipPoolEnd: profile.ipPoolEnd ?? null,
      dnsServers: profile.dnsServers,
      defaultDatastore: profile.defaultDatastore,
      templateDatastore: profile.templateDatastore,
      notes: profile.notes ?? null,
    },
  });

  await audit(admin.id, "node.configure", nodeId, profile.bridge);
  revalidatePath("/admin/nodes");
  return { ok: "Saved." };
}
