import { ReviewCard, type NodeChoice, type PendingOrder } from "./ReviewCard";
import { requireAdmin } from "@/lib/auth";
import { listTemplates, listVmImages } from "@/lib/catalog";
import { prisma } from "@/lib/db";
import { syncNodes, unusableReason } from "@/lib/nodes";
import { imageOf } from "@/lib/orders";
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

  // Which nodes can see each image, so a node without the order's image or
  // ISO is shown as blocked instead of failing at apply time. Only fetched
  // when there is something to review.
  const volumeNodes = new Map<string, string[]>();
  if (orders.length > 0) {
    const [templates, vmImages] = await Promise.all([
      listTemplates().catch(() => []),
      listVmImages().catch(() => []),
    ]);
    for (const e of [...templates, ...vmImages]) volumeNodes.set(e.volid, e.nodes);
  }

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
        const image = imageOf(order);
        const imageNodes = image ? volumeNodes.get(image.volid) : undefined;

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
          blockedBecause:
            unusableReason(n, kind) ??
            (image && imageNodes && !imageNodes.includes(n.name)
              ? `does not have ${image.contentType === "iso" ? "this ISO" : "this image"}`
              : null),
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
            order.isoFileId ??
            order.templateFileId ??
            (order.cloneVmId ? `clone of ${order.cloneVmId}` : "—"),
          source:
            kind === "LXC"
              ? "Template"
              : order.isoFileId
                ? "ISO installer"
                : order.cloneVmId
                  ? "Clone"
                  : "Cloud image",
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
