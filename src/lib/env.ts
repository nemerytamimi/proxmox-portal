/**
 * Environment access. Read lazily rather than at module load so that Next's
 * build step (which imports route modules without a populated .env) does not
 * explode on a missing credential.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get pveEndpoint(): string {
    // Normalise: the provider and the API both want a trailing slash-free base.
    return required("PVE_ENDPOINT").replace(/\/+$/, "");
  },
  get pveApiToken(): string {
    return required("PVE_API_TOKEN");
  },
  get pveInsecure(): boolean {
    return optional("PVE_INSECURE", "true") === "true";
  },
  get pveSshUsername(): string {
    return optional("PVE_SSH_USERNAME", "root");
  },
  get pveSshPrivateKey(): string {
    return optional(
      "PVE_SSH_PRIVATE_KEY",
      "/var/lib/proxmox-portal/ssh/terraform_pve",
    );
  },
  /**
   * The cluster is quorate over WireGuard, so the address the API advertises
   * for a node is often not the one Terraform can reach. Pinned here as
   * `name=ip,name=ip`.
   */
  get pveNodeAddresses(): Record<string, string> {
    const raw = optional("PVE_NODE_ADDRESSES", "");
    const out: Record<string, string> = {};
    for (const pair of raw.split(",")) {
      const [name, addr] = pair.split("=").map((s) => s?.trim());
      if (name && addr) out[name] = addr;
    }
    return out;
  },
  get terraformBin(): string {
    return optional("TERRAFORM_BIN", "/usr/local/bin/terraform");
  },
  get dataDir(): string {
    return optional("PORTAL_DATA_DIR", "/var/lib/proxmox-portal");
  },
  get pluginCacheDir(): string {
    return optional(
      "TF_PLUGIN_CACHE_DIR",
      `${optional("PORTAL_DATA_DIR", "/var/lib/proxmox-portal")}/plugin-cache`,
    );
  },
  get encryptionKey(): string {
    return required("APP_ENCRYPTION_KEY");
  },
};

export const paths = {
  workspaces: () => `${env.dataDir}/workspaces`,
  workspace: (guestId: string) => `${env.dataDir}/workspaces/${guestId}`,
  logs: () => `${env.dataDir}/logs`,
  log: (jobId: string) => `${env.dataDir}/logs/${jobId}.log`,
};
