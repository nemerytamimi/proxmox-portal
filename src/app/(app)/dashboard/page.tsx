import Link from "next/link";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { usageFor } from "@/lib/quota";
import { Badge, Empty, Panel, statusTone } from "@/components/ui";

export const dynamic = "force-dynamic";

function Meter({
  label,
  used,
  max,
  unit = "",
}: {
  label: string;
  used: number;
  max: number;
  unit?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className={pct >= 100 ? "text-bad" : "text-fg"}>
          {used}
          {unit} / {max}
          {unit}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-panel-2">
        <div
          className={`h-full ${pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-ok"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  const session = await auth();
  const userId = session!.user.id;

  const [guests, orders, usage] = await Promise.all([
    prisma.guest.findMany({
      where: { ownerId: userId, status: { not: "DESTROYED" } },
      include: { node: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.order.findMany({
      where: { userId, status: { in: ["PENDING", "REJECTED"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    usageFor(userId),
  ]);

  return (
    <div className="space-y-6">
      <Panel title="Quota" description="Counts running guests and orders still awaiting approval.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Meter label="Guests" used={usage.usedGuests} max={usage.maxGuests} />
          <Meter label="Cores" used={usage.usedCores} max={usage.maxCores} />
          <Meter
            label="Memory"
            used={usage.usedMemoryMb}
            max={usage.maxMemoryMb}
            unit=" MB"
          />
          <Meter
            label="Disk"
            used={usage.usedDiskGb}
            max={usage.maxDiskGb}
            unit=" GB"
          />
        </div>
      </Panel>

      <Panel
        title="My guests"
        actions={
          <Link
            href="/order"
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-ink"
          >
            Order a guest
          </Link>
        }
      >
        {guests.length === 0 ? (
          <Empty>
            Nothing yet. <Link href="/order" className="text-accent hover:underline">Order a container or VM</Link> to get started.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="pb-2 pr-4">Hostname</th>
                  <th className="pb-2 pr-4">Kind</th>
                  <th className="pb-2 pr-4">Node</th>
                  <th className="pb-2 pr-4">VMID</th>
                  <th className="pb-2 pr-4">Address</th>
                  <th className="pb-2 pr-4">Specs</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.id} className="border-b border-line/50">
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/guests/${g.id}`}
                        className="font-medium text-accent hover:underline"
                      >
                        {g.hostname}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-muted">{g.kind}</td>
                    <td className="py-2.5 pr-4 text-muted">{g.node.name}</td>
                    <td className="py-2.5 pr-4 text-muted">{g.vmid}</td>
                    <td className="py-2.5 pr-4 text-muted">{g.ipv4Address}</td>
                    <td className="py-2.5 pr-4 text-muted">
                      {g.cores}c · {g.memoryMb} MB · {g.diskGb} GB
                    </td>
                    <td className="py-2.5">
                      <Badge tone={statusTone(g.status)}>{g.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {orders.length > 0 && (
        <Panel title="Orders awaiting a decision">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="pb-2 pr-4">Hostname</th>
                  <th className="pb-2 pr-4">Kind</th>
                  <th className="pb-2 pr-4">Requested</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-line/50">
                    <td className="py-2.5 pr-4 font-medium">{o.hostname}</td>
                    <td className="py-2.5 pr-4 text-muted">{o.kind}</td>
                    <td className="py-2.5 pr-4 text-muted">
                      {o.cores}c · {o.memoryMb} MB · {o.diskGb} GB
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={o.status === "REJECTED" ? "bad" : "warn"}>
                        {o.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 text-muted">{o.reviewNote ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
