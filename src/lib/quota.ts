import { prisma } from "./db";

/**
 * Quotas count everything a user has asked the cluster to hold: guests that
 * exist plus orders still waiting for approval. Counting pending orders matters
 * — otherwise a user can queue twenty requests that each pass on their own and
 * blow the ceiling the moment an admin approves them.
 */

export interface QuotaLimits {
  maxGuests: number;
  maxCores: number;
  maxMemoryMb: number;
  maxDiskGb: number;
}

export const DEFAULT_QUOTA: QuotaLimits = {
  maxGuests: 3,
  maxCores: 6,
  maxMemoryMb: 8192,
  maxDiskGb: 100,
};

export interface QuotaUsage extends QuotaLimits {
  usedGuests: number;
  usedCores: number;
  usedMemoryMb: number;
  usedDiskGb: number;
}

export async function limitsFor(userId: string): Promise<QuotaLimits> {
  const quota = await prisma.quota.findUnique({ where: { userId } });
  return quota
    ? {
        maxGuests: quota.maxGuests,
        maxCores: quota.maxCores,
        maxMemoryMb: quota.maxMemoryMb,
        maxDiskGb: quota.maxDiskGb,
      }
    : DEFAULT_QUOTA;
}

export async function usageFor(userId: string): Promise<QuotaUsage> {
  const limits = await limitsFor(userId);

  const [guests, pending] = await Promise.all([
    prisma.guest.findMany({
      where: { ownerId: userId, status: { notIn: ["DESTROYED"] } },
      select: { cores: true, memoryMb: true, diskGb: true },
    }),
    prisma.order.findMany({
      where: { userId, status: "PENDING" },
      select: { cores: true, memoryMb: true, diskGb: true },
    }),
  ]);

  const all = [...guests, ...pending];
  return {
    ...limits,
    usedGuests: all.length,
    usedCores: all.reduce((n, g) => n + g.cores, 0),
    usedMemoryMb: all.reduce((n, g) => n + g.memoryMb, 0),
    usedDiskGb: all.reduce((n, g) => n + g.diskGb, 0),
  };
}

export interface QuotaRequest {
  cores: number;
  memoryMb: number;
  diskGb: number;
  /** Set when re-sizing: that guest's current usage is replaced, not added. */
  replacingGuestId?: string;
}

export interface QuotaCheck {
  ok: boolean;
  errors: string[];
  usage: QuotaUsage;
}

/**
 * Check a new or resized request against the user's ceiling. Every breach is
 * reported at once so the form can show them together instead of one per
 * submit.
 */
export async function checkQuota(
  userId: string,
  req: QuotaRequest,
): Promise<QuotaCheck> {
  const usage = await usageFor(userId);
  const errors: string[] = [];

  let { usedGuests, usedCores, usedMemoryMb, usedDiskGb } = usage;

  if (req.replacingGuestId) {
    const existing = await prisma.guest.findUnique({
      where: { id: req.replacingGuestId },
      select: { cores: true, memoryMb: true, diskGb: true },
    });
    if (existing) {
      usedGuests -= 1;
      usedCores -= existing.cores;
      usedMemoryMb -= existing.memoryMb;
      usedDiskGb -= existing.diskGb;
    }
  }

  if (usedGuests + 1 > usage.maxGuests) {
    errors.push(
      `Guest limit reached: ${usedGuests} of ${usage.maxGuests} already in use.`,
    );
  }
  if (usedCores + req.cores > usage.maxCores) {
    errors.push(
      `Core limit exceeded: ${usedCores} of ${usage.maxCores} used, requested ${req.cores}.`,
    );
  }
  if (usedMemoryMb + req.memoryMb > usage.maxMemoryMb) {
    errors.push(
      `Memory limit exceeded: ${usedMemoryMb} MB of ${usage.maxMemoryMb} MB used, requested ${req.memoryMb} MB.`,
    );
  }
  if (usedDiskGb + req.diskGb > usage.maxDiskGb) {
    errors.push(
      `Disk limit exceeded: ${usedDiskGb} GB of ${usage.maxDiskGb} GB used, requested ${req.diskGb} GB.`,
    );
  }

  return { ok: errors.length === 0, errors, usage };
}
