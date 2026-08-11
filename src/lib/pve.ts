import { Agent, request } from "undici";

import { env } from "./env";

/**
 * Minimal Proxmox VE API client.
 *
 * Only the read paths and the two mutations Terraform deliberately does not own
 * live here: power actions (which change no infrastructure) and the container
 * migrate call (which the bpg provider has no equivalent for). Everything that
 * alters a guest's shape goes through Terraform instead.
 */

export interface PveNodeSummary {
  node: string;
  status: "online" | "offline" | "unknown";
  maxcpu?: number;
  maxmem?: number;
  cpu?: number;
  mem?: number;
}

export interface PveBridge {
  iface: string;
  cidr?: string;
  mtu?: number;
  active?: boolean;
}

export interface PveStorage {
  storage: string;
  type: string;
  content: string[];
  avail?: number;
  total?: number;
}

export interface PveContent {
  volid: string;
  format?: string;
  size?: number;
  content: string;
}

export interface PveGuestStatus {
  status: string; // "running" | "stopped" | ...
  uptime?: number;
  cpu?: number;
  cpus?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  name?: string;
}

export interface PveClusterGuest {
  vmid: number;
  node: string;
  type: "lxc" | "qemu";
  name?: string;
  status?: string;
}

/** Thrown for any non-2xx PVE response so callers can surface the real reason. */
export class PveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "PveError";
  }
}

let agent: Agent | null = null;

function dispatcher(): Agent {
  if (!agent) {
    agent = new Agent({
      connect: {
        // The stock PVE certificate is self-signed; PVE_INSECURE mirrors the
        // provider's `insecure` flag rather than inventing a second policy.
        rejectUnauthorized: !env.pveInsecure,
      },
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
    });
  }
  return agent;
}

async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = `${env.pveEndpoint}/api2/json${path}`;

  let payload: string | undefined;
  const headers: Record<string, string> = {
    Authorization: `PVEAPIToken=${env.pveApiToken}`,
  };
  if (body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) form.set(k, String(v));
    }
    payload = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await request(url, {
    method,
    headers,
    body: payload,
    dispatcher: dispatcher(),
  });

  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new PveError(
      `PVE ${method} ${path} failed: ${res.statusCode} ${text.slice(0, 400)}`,
      res.statusCode,
      path,
    );
  }

  try {
    return (JSON.parse(text) as { data: T }).data;
  } catch {
    throw new PveError(`PVE ${method} ${path}: unparseable response`, 500, path);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function listNodes(): Promise<PveNodeSummary[]> {
  const nodes = await call<PveNodeSummary[]>("GET", "/nodes");
  return nodes.map((n) => ({ ...n, status: n.status ?? "unknown" }));
}

/**
 * Best-effort KVM probe: a node whose CPU exposes neither `vmx` nor `svm`
 * cannot start a QEMU guest. `vmi3482497` is a Contabo VPS with no nested
 * virtualisation and reports neither, which is exactly the case this catches.
 *
 * Returns null when the node cannot be interrogated (offline, slow, no
 * permission) so the caller can leave the admin's existing choice alone rather
 * than flipping a working node to "no VMs" on a transient error.
 */
export async function probeVmCapability(node: string): Promise<boolean | null> {
  try {
    const status = await call<{ cpuinfo?: { flags?: string } }>(
      "GET",
      `/nodes/${node}/status`,
    );
    const flags = (status.cpuinfo?.flags ?? "").split(/\s+/);
    if (flags.length <= 1) return null; // no flags reported: don't guess
    return flags.includes("vmx") || flags.includes("svm");
  } catch {
    return null;
  }
}

export async function listBridges(node: string): Promise<PveBridge[]> {
  const ifaces = await call<Array<PveBridge & { type: string }>>(
    "GET",
    `/nodes/${node}/network`,
  );
  return ifaces.filter((i) => i.type === "bridge" || i.type === "OVSBridge");
}

export async function listStorage(node: string): Promise<PveStorage[]> {
  const stores = await call<Array<Omit<PveStorage, "content"> & { content: string }>>(
    "GET",
    `/nodes/${node}/storage`,
  );
  return stores.map((s) => ({ ...s, content: (s.content ?? "").split(",") }));
}

/** Container templates (`vztmpl`) or cloud images (`import`/`iso`). */
export async function listContent(
  node: string,
  storage: string,
  contentType: "vztmpl" | "iso" | "import",
): Promise<PveContent[]> {
  return call<PveContent[]>(
    "GET",
    `/nodes/${node}/storage/${storage}/content?content=${contentType}`,
  );
}

/** Every guest the cluster knows about — used to avoid handing out a live VMID. */
export async function listClusterGuests(): Promise<PveClusterGuest[]> {
  const rows = await call<Array<PveClusterGuest & { type: string }>>(
    "GET",
    "/cluster/resources?type=vm",
  );
  return rows.filter(
    (r): r is PveClusterGuest => r.type === "lxc" || r.type === "qemu",
  );
}

export async function nextId(): Promise<number> {
  return Number(await call<string | number>("GET", "/cluster/nextid"));
}

// ---------------------------------------------------------------------------
// Guest status and power
// ---------------------------------------------------------------------------

function base(kind: "LXC" | "VM", node: string, vmid: number): string {
  return `/nodes/${node}/${kind === "LXC" ? "lxc" : "qemu"}/${vmid}`;
}

export async function guestStatus(
  kind: "LXC" | "VM",
  node: string,
  vmid: number,
): Promise<PveGuestStatus | null> {
  try {
    return await call<PveGuestStatus>(
      "GET",
      `${base(kind, node, vmid)}/status/current`,
    );
  } catch (err) {
    // A guest that Terraform has not created yet (or has just destroyed) is a
    // 500/404 here, which is expected rather than exceptional.
    if (err instanceof PveError && (err.status === 404 || err.status === 500)) {
      return null;
    }
    throw err;
  }
}

/**
 * Power actions bypass Terraform on purpose: running vs stopped is not part of
 * the desired state the portal manages, and routing it through an apply would
 * make a one-second action take a minute.
 */
export async function powerAction(
  kind: "LXC" | "VM",
  node: string,
  vmid: number,
  action: "start" | "stop" | "shutdown" | "reboot",
): Promise<string> {
  return call<string>("POST", `${base(kind, node, vmid)}/status/${action}`);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Move a guest to another node, returning the task UPID.
 *
 * For containers this is the only option: the bpg provider has no migrate
 * support for `proxmox_virtual_environment_container`, so changing `node_name`
 * in Terraform would destroy and recreate it. VMs are migrated by Terraform
 * itself (`migrate = true`) and should not come through here.
 *
 * `restart` lets PVE stop, move and restart a running container, which is what
 * an offline dir-storage migration between our nodes requires.
 */
export async function migrateGuest(
  kind: "LXC" | "VM",
  node: string,
  vmid: number,
  target: string,
  opts: { online?: boolean; restart?: boolean } = {},
): Promise<string> {
  const body: Record<string, string | number | undefined> = { target };
  if (kind === "LXC") {
    if (opts.restart) body.restart = 1;
  } else if (opts.online) {
    body.online = 1;
  }
  return call<string>("POST", `${base(kind, node, vmid)}/migrate`, body);
}

export interface PveTaskStatus {
  status: "running" | "stopped";
  exitstatus?: string;
  upid: string;
}

export async function taskStatus(
  node: string,
  upid: string,
): Promise<PveTaskStatus> {
  return call<PveTaskStatus>(
    "GET",
    `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
  );
}

/** Poll a PVE task to completion. Throws unless it ends with exitstatus OK. */
export async function waitForTask(
  node: string,
  upid: string,
  { timeoutMs = 30 * 60_000, intervalMs = 3_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await taskStatus(node, upid);
    if (status.status === "stopped") {
      if (status.exitstatus && status.exitstatus !== "OK") {
        throw new Error(`PVE task ${upid} failed: ${status.exitstatus}`);
      }
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`PVE task ${upid} did not finish within the timeout`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
