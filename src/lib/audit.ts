import { prisma } from "./db";

/**
 * Every state-changing action is recorded. Provisioning is the kind of thing
 * people ask "who did that, and when" about weeks later, and the Terraform logs
 * alone do not say who pressed the button.
 */
export async function audit(
  actorId: string | null,
  action: string,
  target?: string,
  detail?: string,
): Promise<void> {
  await prisma.auditLog.create({
    data: { actorId, action, target: target ?? null, detail: detail ?? null },
  });
}
