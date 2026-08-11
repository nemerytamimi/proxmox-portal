import { PrismaClient } from "@prisma/client";

/**
 * The web server and the worker are separate processes against the same SQLite
 * file, so WAL mode is not optional — without it the worker's long writes block
 * every page render.
 */
function create(): PrismaClient {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  void client.$executeRawUnsafe("PRAGMA journal_mode = WAL;").catch(() => {});
  void client.$executeRawUnsafe("PRAGMA busy_timeout = 10000;").catch(() => {});
  return client;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? create();

// Next's dev server re-evaluates modules on every edit; without this the
// connection pool grows until SQLite starts refusing writers.
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
