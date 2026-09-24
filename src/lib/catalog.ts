import type { PveNode } from "@prisma/client";

import { prisma } from "./db";
import { listContent, listStorage } from "./pve";

/**
 * What a user can actually pick from, read live from the cluster's storage
 * rather than hard-coded. A template downloaded to Proxmox this morning shows
 * up in the order form this morning.
 */

type ContentType = "vztmpl" | "import" | "iso";

/** How a VM is built from the file: imported as its disk, or booted to install. */
export type VmImageSource = "CLOUD_IMAGE" | "ISO";

export interface CatalogEntry {
  volid: string;
  label: string;
  sizeBytes?: number;
  /** Nodes on which this volume is visible. */
  nodes: string[];
}

export interface VmImageEntry extends CatalogEntry {
  source: VmImageSource;
}

function prettify(volid: string): string {
  const file = volid.split("/").pop() ?? volid;
  return file
    .replace(/\.(tar\.(zst|gz|xz)|qcow2|img|iso)$/i, "")
    .replace(/_/g, " ");
}

/**
 * Every storage on the node that is enabled for this content type. Not just
 * the node's template datastore: ISOs in particular often live on a separate
 * NFS/CIFS share. Falls back to the template datastore if the storage list
 * cannot be read.
 */
async function storagesFor(node: PveNode, contentType: ContentType): Promise<string[]> {
  try {
    const stores = await listStorage(node.name);
    const matching = stores
      .filter((s) => s.active !== 0 && s.content.includes(contentType))
      .map((s) => s.storage);
    return matching.length > 0 ? matching : [node.templateDatastore];
  } catch {
    return [node.templateDatastore];
  }
}

async function gather(
  contentType: ContentType,
  nodes: PveNode[],
): Promise<CatalogEntry[]> {
  const byVolid = new Map<string, CatalogEntry>();

  await Promise.all(
    nodes.map(async (node) => {
      for (const storage of await storagesFor(node, contentType)) {
        let items;
        try {
          items = await listContent(node.name, storage, contentType);
        } catch {
          // A storage that cannot be listed should not empty the whole
          // catalogue; skip it and use what the rest report.
          continue;
        }
        for (const item of items) {
          // `content=iso` also matches other files on some storage types.
          if (item.content && item.content !== contentType) continue;
          const existing = byVolid.get(item.volid);
          if (existing) {
            // Shared storage reports the same volume from every node.
            if (!existing.nodes.includes(node.name)) existing.nodes.push(node.name);
            continue;
          }
          byVolid.set(item.volid, {
            volid: item.volid,
            label: prettify(item.volid),
            sizeBytes: item.size,
            nodes: [node.name],
          });
        }
      }
    }),
  );

  return [...byVolid.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function usableNodes(): Promise<PveNode[]> {
  return prisma.pveNode.findMany({ where: { online: true, configured: true } });
}

/** LXC templates (`vztmpl`). */
export async function listTemplates(): Promise<CatalogEntry[]> {
  return gather("vztmpl", await usableNodes());
}

/**
 * Everything a VM can be built from: cloud images (content type `import`,
 * which is what the provider needs to build a VM disk from a downloaded
 * qcow2) and installer ISOs (`iso`).
 *
 * With `nodeName`, only that node is asked; this is what the order form calls
 * when the user picks a preferred node, so the list shows what that node
 * really has.
 */
export async function listVmImages(nodeName?: string): Promise<VmImageEntry[]> {
  const nodes = (await usableNodes()).filter(
    (n) => n.allowVms && (!nodeName || n.name === nodeName),
  );
  const [images, isos] = await Promise.all([
    gather("import", nodes),
    gather("iso", nodes),
  ]);
  return [
    ...images.map((e) => ({ ...e, source: "CLOUD_IMAGE" as const })),
    ...isos.map((e) => ({ ...e, source: "ISO" as const })),
  ];
}

/**
 * Whether a volume is visible from a node. Node-local storage (the default
 * `local`) is different on every node, so an image downloaded to one node
 * cannot build a guest on another.
 */
export async function volumeOnNode(
  nodeName: string,
  volid: string,
  contentType: ContentType,
): Promise<boolean> {
  const storage = volid.split(":")[0];
  if (!storage) return false;
  try {
    const items = await listContent(nodeName, storage, contentType);
    return items.some((i) => i.volid === volid);
  } catch {
    return false;
  }
}
