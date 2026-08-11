"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin, requireUser } from "@/lib/auth";
import {
  destroyGuest,
  doPowerAction,
  GuestError,
  migrateGuestToNode,
  reapplyGuest,
  resizeSchema,
  resizeGuest,
} from "@/lib/guests";
import { POWER_ACTIONS, type PowerAction } from "@/lib/types";

export interface ActionState {
  error?: string;
  issues?: string[];
  ok?: string;
}

function fail(err: unknown): ActionState {
  if (err instanceof GuestError) return { error: err.message, issues: err.issues };
  throw err;
}

export async function powerActionForm(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const guestId = String(formData.get("guestId"));
  const action = String(formData.get("action")) as PowerAction;

  if (!POWER_ACTIONS.includes(action)) return { error: "Unknown action." };

  try {
    await doPowerAction(user.id, user.role === "ADMIN", guestId, action);
  } catch (err) {
    return fail(err);
  }

  revalidatePath(`/guests/${guestId}`);
  return { ok: `Sent ${action}.` };
}

export async function resizeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const guestId = String(formData.get("guestId"));

  const parsed = resizeSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return {
      error: "Check the values.",
      issues: parsed.error.issues.map((i) => i.message),
    };
  }

  try {
    await resizeGuest(user.id, user.role === "ADMIN", guestId, parsed.data);
  } catch (err) {
    return fail(err);
  }

  revalidatePath(`/guests/${guestId}`);
  return { ok: "Resize queued." };
}

export async function destroyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const guestId = String(formData.get("guestId"));

  // Typing the hostname is the only thing standing between a stray click and
  // someone's data.
  if (
    String(formData.get("confirm")).trim() !==
    String(formData.get("hostname")).trim()
  ) {
    return { error: "Type the hostname exactly to confirm." };
  }

  try {
    await destroyGuest(user.id, user.role === "ADMIN", guestId);
  } catch (err) {
    return fail(err);
  }

  revalidatePath(`/guests/${guestId}`);
  return { ok: "Destroy queued." };
}

export async function reapplyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const guestId = String(formData.get("guestId"));

  try {
    await reapplyGuest(user.id, user.role === "ADMIN", guestId);
  } catch (err) {
    return fail(err);
  }

  revalidatePath(`/guests/${guestId}`);
  return { ok: "Re-apply queued." };
}

/** Placement is an operator decision, so migration is admin-only. */
export async function migrateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const guestId = String(formData.get("guestId"));
  const targetNodeId = String(formData.get("targetNodeId"));

  if (!targetNodeId) return { error: "Choose a target node." };
  if (String(formData.get("acknowledge")) !== "yes") {
    return { error: "Confirm that you understand the guest may be re-addressed." };
  }

  try {
    await migrateGuestToNode(admin.id, guestId, targetNodeId);
  } catch (err) {
    return fail(err);
  }

  revalidatePath(`/guests/${guestId}`);
  return { ok: "Migration queued." };
}
