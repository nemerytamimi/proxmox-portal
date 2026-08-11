/**
 * Shared string unions. SQLite has no enum support, so these mirror the String
 * columns in prisma/schema.prisma and are the single source of truth for what
 * those columns may contain.
 */

export const GUEST_KINDS = ["LXC", "VM"] as const;
export type GuestKind = (typeof GUEST_KINDS)[number];

export const ROLES = ["USER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const GUEST_STATUSES = [
  "PROVISIONING",
  "ACTIVE",
  "UPDATING",
  "MIGRATING",
  "DESTROYING",
  "DESTROYED",
  "ERROR",
] as const;
export type GuestStatus = (typeof GUEST_STATUSES)[number];

export const JOB_KINDS = ["APPLY", "DESTROY", "MIGRATE"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = ["QUEUED", "RUNNING", "OK", "FAILED", "CANCELLED"] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * The OS families Proxmox accepts for a container. This is a closed set in the
 * provider — anything else is rejected at apply time, minutes after the order
 * was approved and a VMID allocated — so the order form constrains it up front.
 */
export const OS_TYPES = [
  "debian",
  "ubuntu",
  "alpine",
  "archlinux",
  "centos",
  "devuan",
  "fedora",
  "gentoo",
  "nixos",
  "opensuse",
  "unmanaged",
] as const;
export type OsType = (typeof OS_TYPES)[number];

/** Guess the family from a template's file name, e.g. debian-13-standard… */
export function osTypeFromTemplate(volid: string): OsType {
  const name = volid.toLowerCase();
  for (const type of OS_TYPES) {
    if (type !== "unmanaged" && name.includes(type)) return type;
  }
  return "debian";
}

export const ADDRESSING_MODES = ["static", "dhcp"] as const;
export type Addressing = (typeof ADDRESSING_MODES)[number];

/** Power actions are applied straight to the PVE API; they change no state. */
export const POWER_ACTIONS = ["start", "shutdown", "stop", "reboot"] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

/** A guest is busy while a job is in flight; the UI disables mutations then. */
export function isBusy(status: string): boolean {
  return (
    status === "PROVISIONING" ||
    status === "UPDATING" ||
    status === "MIGRATING" ||
    status === "DESTROYING"
  );
}

export function isTerminal(state: string): boolean {
  return state === "OK" || state === "FAILED" || state === "CANCELLED";
}
