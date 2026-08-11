import { NodeCard, type NodeView } from "./NodeCard";
import { refreshNodesAction } from "./actions";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncNodes } from "@/lib/nodes";
import { listBridges, listStorage } from "@/lib/pve";
import { Button, Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NodesPage() {
  await requireAdmin();

  // Discovery on load: a node that has just come back online should be here
  // without anyone having to press anything.
  await syncNodes().catch(() => undefined);

  const nodes = await prisma.pveNode.findMany({ orderBy: { name: "asc" } });

  const views: NodeView[] = await Promise.all(
    nodes.map(async (n) => {
      const [guestCount, bridges, storage] = await Promise.all([
        prisma.guest.count({
          where: { nodeId: n.id, status: { not: "DESTROYED" } },
        }),
        n.online ? listBridges(n.name).catch(() => []) : Promise.resolve([]),
        n.online ? listStorage(n.name).catch(() => []) : Promise.resolve([]),
      ]);

      return {
        id: n.id,
        name: n.name,
        online: n.online,
        configured: n.configured,
        allowLxc: n.allowLxc,
        allowVms: n.allowVms,
        bridge: n.bridge,
        mtu: n.mtu,
        addressing: n.addressing,
        subnetPrefix: n.subnetPrefix,
        gateway: n.gateway,
        ipPoolStart: n.ipPoolStart,
        ipPoolEnd: n.ipPoolEnd,
        dnsServers: n.dnsServers,
        defaultDatastore: n.defaultDatastore,
        templateDatastore: n.templateDatastore,
        notes: n.notes,
        maxCpu: n.maxCpu,
        maxMemoryMb: n.maxMemoryMb,
        guestCount,
        detectedBridges: bridges.map((b) => ({
          iface: b.iface,
          cidr: b.cidr,
          mtu: b.mtu,
        })),
        detectedStorage: storage.map((s) => s.storage),
      };
    }),
  );

  return (
    <div className="space-y-6">
      <Panel
        title="Cluster nodes"
        description="Discovered from Proxmox. A node cannot be used for provisioning until it is marked available and given a guest network profile — bridges are per-node, so there is no sensible default to guess."
        actions={
          <form action={refreshNodesAction}>
            <Button variant="ghost" type="submit">
              Refresh from cluster
            </Button>
          </form>
        }
      >
        <p className="text-sm text-muted">
          {views.length} node{views.length === 1 ? "" : "s"} known ·{" "}
          {views.filter((v) => v.online).length} online ·{" "}
          {views.filter((v) => v.configured).length} configured
        </p>
      </Panel>

      {views.map((node) => (
        <NodeCard key={node.id} node={node} />
      ))}
    </div>
  );
}
