import { prisma } from "./db";
import { listContent } from "./pve";

/**
 * What a user can actually pick from, read live from the cluster's storage
 * rather than hard-coded. A template downloaded to Proxmox this morning shows
 * up in the order form this morning.
 */

export interface CatalogEntry {
  volid: string;
  label: string;
  sizeBytes?: number;
  /** Nodes on which this volume is visible. */
  nodes: string[];
}

function prettify(volid: string): string {
  const file = volid.split("/").pop() ?? volid;
  return file
    .replace(/\.(tar\.(zst|gz|xz)|qcow2|img|iso)$/i, "")
    .replace(/_/g, " ");
}

async function gather(
  contentType: "vztmpl" | "import" | "iso",
  storageOf: (node: { templateDatastore: string; defaultDatastore: string }) => string,
): Promise<CatalogEntry[]> {
  const nodes = await prisma.pveNode.findMany({
    where: { online: true, configured: true },
  });

  const byVolid = new Map<string, CatalogEntry>();

  for (const node of nodes) {
    try {
      const items = await listContent(node.name, storageOf(node), contentType);
      for (const item of items) {
        const existing = byVolid.get(item.volid);
        if (existing) {
          existing.nodes.push(node.name);
          continue;
        }
        byVolid.set(item.volid, {
          volid: item.volid,
          label: prettify(item.volid),
          sizeBytes: item.size,
          nodes: [node.name],
        });
      }
    } catch {
      // A node whose storage cannot be listed should not empty the whole
      // catalogue; skip it and use what the others report.
    }
  }

  return [...byVolid.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** LXC templates (`vztmpl`). */
export async function listTemplates(): Promise<CatalogEntry[]> {
  return gather("vztmpl", (n) => n.templateDatastore);
}

/**
 * Cloud images for VMs. These live under the `import` content type — not
 * `iso` — because that is what the provider needs to build a VM disk from a
 * downloaded qcow2.
 */
export async function listCloudImages(): Promise<CatalogEntry[]> {
  return gather("import", (n) => n.templateDatastore);
}
