"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
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
