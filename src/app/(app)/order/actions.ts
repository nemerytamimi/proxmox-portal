"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { listVmImages, type VmImageEntry } from "@/lib/catalog";
import { prisma } from "@/lib/db";
import { createOrder, orderSchema, OrderError } from "@/lib/orders";

export interface OrderFormState {
  error?: string;
  issues?: string[];
}

export async function submitOrderAction(
  _prev: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  const user = await requireUser();

  const raw = Object.fromEntries(formData.entries());
  const parsed = orderSchema.safeParse({
    ...raw,
    // Empty optional selects arrive as "" and must not become a value.
    templateFileId: raw.templateFileId || undefined,
    cloneVmId: raw.cloneVmId || undefined,
    isoFileId: raw.isoFileId || undefined,
    sshPublicKey: raw.sshPublicKey || undefined,
    rootPassword: raw.rootPassword || undefined,
    preferredNodeId: raw.preferredNodeId || undefined,
  });

  if (!parsed.success) {
    return {
      error: "Please correct the highlighted fields.",
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "form"}: ${i.message}`,
      ),
    };
  }

  try {
    await createOrder(user.id, parsed.data);
  } catch (err) {
    if (err instanceof OrderError) {
      return { error: err.message, issues: err.issues };
    }
    throw err;
  }

  redirect("/dashboard");
}

export interface VmImagesResult {
  images: VmImageEntry[];
  error?: string;
}

/**
 * The cloud images and ISOs on one node, read live from its storage. Called by
 * the order form when the user picks a preferred node, so the list reflects
 * what that node has right now rather than when the page loaded.
 */
export async function loadVmImagesAction(nodeId: string): Promise<VmImagesResult> {
  await requireUser();

  const node = await prisma.pveNode.findUnique({ where: { id: nodeId } });
  if (!node || !node.online || !node.configured || !node.allowVms) {
    return { images: [], error: "That node cannot host virtual machines right now." };
  }

  try {
    return { images: await listVmImages(node.name) };
  } catch {
    return { images: [], error: `Could not read the storage on ${node.name}.` };
  }
}
