"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { approveOrder, OrderError, rejectOrder } from "@/lib/orders";

export interface ReviewState {
  error?: string;
  issues?: string[];
  ok?: string;
}

export async function approveAction(
  _prev: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const admin = await requireAdmin();
  const orderId = String(formData.get("orderId"));
  const nodeId = String(formData.get("nodeId"));
  const note = String(formData.get("note") ?? "").trim();

  if (!nodeId) return { error: "Choose a target node." };

  try {
    await approveOrder(admin.id, orderId, nodeId, note || undefined);
  } catch (err) {
    if (err instanceof OrderError) return { error: err.message, issues: err.issues };
    // Allocation failures (a full IP pool, an unconfigured node) surface here
    // and are worth showing verbatim rather than as a generic failure.
    return { error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath("/admin/orders");
  return { ok: "Approved — provisioning has been queued." };
}

export async function rejectAction(
  _prev: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const admin = await requireAdmin();
  const orderId = String(formData.get("orderId"));
  const note = String(formData.get("note") ?? "").trim();

  if (!note) return { error: "Give a reason — the requester sees it." };

  try {
    await rejectOrder(admin.id, orderId, note);
  } catch (err) {
    if (err instanceof OrderError) return { error: err.message };
    throw err;
  }

  revalidatePath("/admin/orders");
  return { ok: "Rejected." };
}
