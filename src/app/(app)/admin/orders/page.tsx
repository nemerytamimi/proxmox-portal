import { ReviewCard, type NodeChoice, type PendingOrder } from "./ReviewCard";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncNodes, unusableReason } from "@/lib/nodes";
import { Empty, Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  await requireAdmin();

  // Refresh the cluster's shape on the way in, so the dropdown reflects what is
  // online right now rather than whenever someone last visited Nodes.
  await syncNodes().catch(() => undefined);

  const [orders, nodes] = await Promise.all([
    prisma.order.findMany({
      where: { status: "PENDING" },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.pveNode.findMany({ orderBy: { name: "asc" } }),
  ]);

  const preferredNames = new Map(nodes.map((n) => [n.id, n.name]));

  return (
    <div className="space-y-6">
      <Panel
        title="Pending approvals"
        description="Approving allocates a VMID and address on the node you choose, then queues the Terraform apply."
      >
        {orders.length === 0 && <Empty>Nothing waiting for review.</Empty>}
      </Panel>

      {orders.map((order) => {
        const kind = order.kind as "LXC" | "VM";

        const choices: NodeChoice[] = nodes.map((n) => ({
          id: n.id,
          name: n.name,
          online: n.online,
          bridge: n.bridge,
          addressing: n.addressing,
          subnetPrefix: n.subnetPrefix,
          gateway: n.gateway,
          defaultDatastore: n.defaultDatastore,
          mtu: n.mtu,
          blockedBecause: unusableReason(n, kind),
        }));

        const pending: PendingOrder = {
          id: order.id,
          kind,
          hostname: order.hostname,
          cores: order.cores,
          memoryMb: order.memoryMb,
          swapMb: order.swapMb,
          diskGb: order.diskGb,
          templateLabel:
            order.templateFileId ??
            (order.cloneVmId ? `clone of ${order.cloneVmId}` : "—"),
          requester: order.user.email,
          requestedAt: order.createdAt
            .toISOString()
            .replace("T", " ")
            .slice(0, 16),
          preferredNodeName: order.preferredNodeId
            ? (preferredNames.get(order.preferredNodeId) ?? null)
            : null,
          hasSshKey: !!order.sshPublicKey,
          hasPassword: !!order.rootPasswordEnc,
        };

        return <ReviewCard key={order.id} order={pending} nodes={choices} />;
      })}
    </div>
  );
}
