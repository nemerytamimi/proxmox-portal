"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";

export interface UserState {
  error?: string;
  ok?: string;
}

const quotaSchema = z.object({
  userId: z.string().min(1),
  maxGuests: z.coerce.number().int().min(0).max(100),
  maxCores: z.coerce.number().int().min(0).max(512),
  maxMemoryMb: z.coerce.number().int().min(0).max(1048576),
  maxDiskGb: z.coerce.number().int().min(0).max(65536),
});

export async function saveQuotaAction(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  const admin = await requireAdmin();

  const parsed = quotaSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid quota" };
  }

  const { userId, ...limits } = parsed.data;

  await prisma.quota.upsert({
    where: { userId },
    create: { userId, ...limits },
    update: limits,
  });

  await audit(
    admin.id,
    "user.quota",
    userId,
    `${limits.maxGuests} guests / ${limits.maxCores} cores / ${limits.maxMemoryMb} MB / ${limits.maxDiskGb} GB`,
  );
  revalidatePath("/admin/users");
  return { ok: "Quota saved." };
}

export async function setRoleAction(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId"));
  const role = String(formData.get("role"));

  if (role !== "USER" && role !== "ADMIN") return { error: "Unknown role." };

  // Locking every admin out of the portal would need a database edit to undo.
  if (role === "USER") {
    const admins = await prisma.user.count({
      where: { role: "ADMIN", disabled: false },
    });
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (admins <= 1 && target?.role === "ADMIN") {
      return { error: "This is the only administrator; promote someone else first." };
    }
  }

  await prisma.user.update({ where: { id: userId }, data: { role } });
  await audit(admin.id, "user.role", userId, role);
  revalidatePath("/admin/users");
  return { ok: `Role set to ${role}.` };
}

export async function toggleDisabledAction(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId"));

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { error: "User not found." };

  if (user.id === admin.id) {
    return { error: "You cannot disable your own account." };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { disabled: !user.disabled },
  });
  await audit(
    admin.id,
    user.disabled ? "user.enable" : "user.disable",
    userId,
    user.email,
  );
  revalidatePath("/admin/users");
  return { ok: user.disabled ? "Account enabled." : "Account disabled." };
}
