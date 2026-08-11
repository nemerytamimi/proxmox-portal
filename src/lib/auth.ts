import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { prisma } from "./db";
import type { Role } from "./types";

/**
 * Credentials auth with a JWT session. Auth.js database sessions do not work
 * with the Credentials provider, so the Prisma adapter is deliberately absent —
 * users are read from the same Prisma models the rest of the app uses.
 */

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
        });
        // Compare regardless of whether the user exists so that a missing
        // account and a wrong password take the same time to answer.
        const hash =
          user?.passwordHash ??
          "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin";
        const ok = await bcrypt.compare(parsed.data.password, hash);

        if (!user || !ok || user.disabled) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? user.email,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.uid = user.id;
        token.role = (user as { role?: string }).role ?? "USER";
      }
      // Re-read the role on refresh so promoting or disabling a user takes
      // effect without waiting for their session to expire.
      if (trigger === "update" || (token.uid && !user)) {
        const fresh = await prisma.user.findUnique({
          where: { id: token.uid as string },
          select: { role: true, disabled: true },
        });
        if (!fresh || fresh.disabled) return null;
        token.role = fresh.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.uid as string;
        session.user.role = (token.role as Role) ?? "USER";
      }
      return session;
    },
  },
});

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new AuthError("Not signed in", 401);
  return session.user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new AuthError("Admins only", 403);
  return user;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
