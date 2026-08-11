import { UserRow, type UserView } from "./UserRow";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DEFAULT_QUOTA } from "@/lib/quota";
import { Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requireAdmin();

  const users = await prisma.user.findMany({
    include: {
      quota: true,
      _count: { select: { guests: true } },
    },
    orderBy: [{ role: "asc" }, { email: "asc" }],
  });

  const views: UserView[] = users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: u.disabled,
    guestCount: u._count.guests,
    quota: u.quota
      ? {
          maxGuests: u.quota.maxGuests,
          maxCores: u.quota.maxCores,
          maxMemoryMb: u.quota.maxMemoryMb,
          maxDiskGb: u.quota.maxDiskGb,
        }
      : DEFAULT_QUOTA,
    usingDefaults: !u.quota,
  }));

  const recent = await prisma.auditLog.findMany({
    include: { actor: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  return (
    <div className="space-y-6">
      <Panel
        title="Users and quotas"
        description={`Users without an explicit quota get the defaults: ${DEFAULT_QUOTA.maxGuests} guests, ${DEFAULT_QUOTA.maxCores} cores, ${DEFAULT_QUOTA.maxMemoryMb} MB, ${DEFAULT_QUOTA.maxDiskGb} GB.`}
      >
        <p className="text-sm text-muted">
          {views.length} account{views.length === 1 ? "" : "s"} ·{" "}
          {views.filter((v) => v.role === "ADMIN").length} admin
        </p>
      </Panel>

      {views.map((user) => (
        <UserRow key={user.id} user={user} />
      ))}

      <Panel title="Recent activity">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="pb-2 pr-4">When</th>
                <th className="pb-2 pr-4">Who</th>
                <th className="pb-2 pr-4">Action</th>
                <th className="pb-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((log) => (
                <tr key={log.id} className="border-b border-line/50">
                  <td className="py-2 pr-4 text-muted">
                    {log.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="py-2 pr-4">{log.actor?.email ?? "—"}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{log.action}</td>
                  <td className="py-2 text-muted">{log.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
