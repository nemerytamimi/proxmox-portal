import { OrderForm, type NodeOption } from "./OrderForm";
import { listCloudImages, listTemplates } from "@/lib/catalog";
import { prisma } from "@/lib/db";
import { Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OrderPage() {
  // The catalogue comes from the cluster's storage, so a template added to
  // Proxmox is orderable immediately.
  const [templates, images, nodes] = await Promise.all([
    listTemplates().catch(() => []),
    listCloudImages().catch(() => []),
    prisma.pveNode.findMany({
      where: { online: true, configured: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const options: NodeOption[] = nodes.map((n) => ({
    id: n.id,
    name: n.name,
    allowVms: n.allowVms,
    addressing: n.addressing,
    bridge: n.bridge,
  }));

  return (
    <Panel
      title="Order a guest"
      description="Describe what you need. An administrator reviews the request, chooses which node it lands on, and Terraform builds it."
    >
      <OrderForm templates={templates} images={images} nodes={options} />
    </Panel>
  );
}
