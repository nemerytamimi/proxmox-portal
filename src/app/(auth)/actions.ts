"use server";

import { redirect } from "next/navigation";
import { AuthError as NextAuthError } from "next-auth";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { hashPassword, signIn } from "@/lib/auth";
import { prisma } from "@/lib/db";

const registerSchema = z
  .object({
    name: z.string().trim().max(80).optional(),
    email: z.string().trim().toLowerCase().email("Enter a valid email address"),
    password: z.string().min(10, "Use at least 10 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "The passwords do not match",
    path: ["confirm"],
  });

export interface FormState {
  error?: string;
}

export async function registerAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name") || undefined,
    email: formData.get("email"),
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid details" };
  }

  const { name, email, password } = parsed.data;

  if (await prisma.user.findUnique({ where: { email } })) {
    return { error: "An account with that email already exists." };
  }

  // Bootstrapping: somebody has to be able to approve the first order, and
  // there is no out-of-band admin creation step.
  const isFirst = (await prisma.user.count()) === 0;

  const user = await prisma.user.create({
    data: {
      email,
      name: name ?? null,
      passwordHash: await hashPassword(password),
      role: isFirst ? "ADMIN" : "USER",
    },
  });

  await audit(
    user.id,
    "user.register",
    user.id,
    isFirst ? "first account — granted ADMIN" : "self-registered",
  );

  await signIn("credentials", {
    email,
    password,
    redirectTo: "/dashboard",
  });

  return {};
}

export async function loginAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");

  if (!email || !password) return { error: "Enter your email and password." };

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: next.startsWith("/") ? next : "/dashboard",
    });
  } catch (err) {
    // signIn throws a redirect on success; only a real CredentialsSignin is an
    // error worth showing.
    if (err instanceof NextAuthError) {
      return { error: "Incorrect email or password." };
    }
    throw err;
  }

  return {};
}

export async function logoutAction(): Promise<void> {
  const { signOut } = await import("@/lib/auth");
  await signOut({ redirect: false });
  redirect("/login");
}
