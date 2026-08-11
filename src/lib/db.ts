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
  // `PRAGMA journal_mode` reports the mode it settled on, so it has to go
  // through $queryRaw — $executeRaw rejects a statement that returns rows.
  // Both of these report the value they settled on, so they have to go through
  // $queryRaw — $executeRaw rejects any statement that returns rows.
  void client.$queryRawUnsafe("PRAGMA journal_mode = WAL;").catch(() => {});
  void client.$queryRawUnsafe("PRAGMA busy_timeout = 10000;").catch(() => {});
  return client;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? create();

// Next's dev server re-evaluates modules on every edit; without this the
// connection pool grows until SQLite starts refusing writers.
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
