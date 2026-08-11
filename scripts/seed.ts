/**
 * Create or promote an administrator from the command line.
 *
 * Registration already grants ADMIN to the first account, so this exists for
 * the cases that bypasses: a locked-out admin, or seeding an install before
 * anyone visits it.
 *
 *   npm run seed -- admin@example.com 'a good password'
 */

import "dotenv/config";

import bcrypt from "bcryptjs";

import { prisma } from "../src/lib/db";

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error("usage: npm run seed -- <email> <password>");
    process.exit(1);
  }
  if (password.length < 10) {
    console.error("Use a password of at least 10 characters.");
    process.exit(1);
  }

  const normalised = email.toLowerCase();
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email: normalised },
    create: { email: normalised, passwordHash, role: "ADMIN" },
    update: { passwordHash, role: "ADMIN", disabled: false },
  });

  console.log(`${user.email} is now an administrator.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
