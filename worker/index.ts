/**
 * Job worker.
 *
 * Runs as its own systemd unit against the same SQLite file as the web server.
 * Keeping it out of the Next.js process means a fifteen-minute apply is never
 * holding an HTTP request open, and restarting the UI cannot orphan a running
 * terraform.
 *
 * Jobs are drained strictly one at a time. Two applies against different
 * workspaces would be safe on their own, but they would race for the same
 * Proxmox API token and the same provider plugin cache, and a serial queue is
 * far easier to reason about when something goes wrong at 2am.
 */

import "dotenv/config";

import type { Guest, Job, PveNode } from "@prisma/client";

import { prisma } from "../src/lib/db";
import { decryptSecret } from "../src/lib/crypto";
import { paths } from "../src/lib/env";
import { reallocateForNode, willReaddress } from "../src/lib/ipam";
import { migrateGuest, waitForTask } from "../src/lib/pve";
import {
  ensureRuntimeDirs,
  writeWorkspace,
} from "../src/lib/terraform/generate";
import {
  apply,
  destroy,
  guestAddress,
  importResource,
  init,
  logLine,
  readOutputs,
  stateRm,
  type RunOptions,
} from "../src/lib/terraform/run";

const POLL_INTERVAL_MS = 3_000;

let shuttingDown = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secretsFor(guest: Guest): Record<string, string | undefined> {
  if (!guest.rootPasswordEnc) return {};
  const password = decryptSecret(guest.rootPasswordEnc);
  // The LXC and VM modules name this differently.
  return guest.kind === "LXC"
    ? { root_password: password }
    : { ci_password: password };
}

function runOptions(guest: Guest, job: Job): RunOptions {
  return {
    cwd: paths.workspace(guest.id),
    logPath: job.logPath,
    secrets: secretsFor(guest),
  };
}

async function finish(
  job: Job,
  state: "OK" | "FAILED",
  opts: { exitCode?: number; error?: string } = {},
): Promise<void> {
  await prisma.job.update({
    where: { id: job.id },
    data: {
      state,
      exitCode: opts.exitCode ?? null,
      error: opts.error ?? null,
      finishedAt: new Date(),
    },
  });
}

async function setGuest(
  guestId: string,
  data: Partial<Guest>,
): Promise<void> {
  await prisma.guest.update({
    where: { id: guestId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: data as any,
  });
}

/**
 * Pull vmid/ip back out of the workspace after an apply. Terraform is the
 * authority here — on a DHCP node the address the guest actually got is not
 * something the portal could have predicted.
 */
async function reconcileOutputs(guest: Guest): Promise<Partial<Guest>> {
  const outputs = await readOutputs(paths.workspace(guest.id));
  const patch: Partial<Guest> = {};

  const vmid = Number(outputs.vm_id);
  if (Number.isFinite(vmid) && vmid > 0) patch.vmid = vmid;

  const ip = outputs.ipv4_address;
  if (typeof ip === "string" && ip.length > 0) patch.ipv4Address = ip;

  return patch;
}

// ---------------------------------------------------------------------------
// Job kinds
// ---------------------------------------------------------------------------

async function runApply(
  job: Job,
  guest: Guest,
  node: PveNode,
): Promise<void> {
  await writeWorkspace(guest, node);
  const opts = runOptions(guest, job);

  const initResult = await init(opts);
  if (!initResult.ok) {
    await setGuest(guest.id, {
      status: "ERROR",
      statusDetail: "terraform init failed",
    });
    await finish(job, "FAILED", {
      exitCode: initResult.code,
      error: "terraform init failed",
    });
    return;
  }

  const result = await apply(opts);
  if (!result.ok) {
    await setGuest(guest.id, {
      status: "ERROR",
      statusDetail: `terraform apply exited ${result.code}`,
    });
    await finish(job, "FAILED", {
      exitCode: result.code,
      error: "terraform apply failed",
    });
    return;
  }

  await setGuest(guest.id, {
    ...(await reconcileOutputs(guest)),
    status: "ACTIVE",
    statusDetail: null,
  });
  await finish(job, "OK", { exitCode: 0 });
}

async function runDestroy(
  job: Job,
  guest: Guest,
  node: PveNode,
): Promise<void> {
  // Rewrite first: a workspace left stale by a failed resize would otherwise
  // destroy against the wrong node or address.
  await writeWorkspace(guest, node);
  const opts = runOptions(guest, job);

  const initResult = await init(opts);
  if (!initResult.ok) {
    await setGuest(guest.id, {
      status: "ERROR",
      statusDetail: "terraform init failed during destroy",
    });
    await finish(job, "FAILED", { exitCode: initResult.code });
    return;
  }

  const result = await destroy(opts);
  if (!result.ok) {
    await setGuest(guest.id, {
      status: "ERROR",
      statusDetail: `terraform destroy exited ${result.code}`,
    });
    await finish(job, "FAILED", {
      exitCode: result.code,
      error: "terraform destroy failed",
    });
    return;
  }

  await setGuest(guest.id, {
    status: "DESTROYED",
    statusDetail: null,
    destroyedAt: new Date(),
  });
  await finish(job, "OK", { exitCode: 0 });
}

/**
 * Move a guest to another node.
 *
 * VMs are Terraform's job: the vendored module sets `migrate = true`, so
 * changing node_name issues a real PVE migration.
 *
 * Containers have no such support in the provider — a node_name change would
 * destroy and recreate them, losing the disk. So the portal migrates the
 * container itself through the PVE API and then reattaches it to Terraform
 * state at its new location with `state rm` + `import`.
 */
async function runMigrate(
  job: Job,
  guest: Guest,
  fromNode: PveNode,
): Promise<void> {
  if (!job.targetNodeId) {
    await finish(job, "FAILED", { error: "migration job has no target node" });
    return;
  }

  const target = await prisma.pveNode.findUnique({
    where: { id: job.targetNodeId },
  });
  if (!target) {
    await finish(job, "FAILED", { error: "target node no longer exists" });
    return;
  }

  const opts = runOptions(guest, job);

  // Bridges are per-node on this cluster, so the guest usually needs a new
  // address on the far side. Work it out before anything moves.
  const readdressing = willReaddress(fromNode, target);
  const allocation = await reallocateForNode(target, guest.vmid);
  if (readdressing) {
    await logLine(
      job.logPath,
      `network profile differs (${fromNode.bridge}/${fromNode.addressing} -> ` +
        `${target.bridge}/${target.addressing}); guest will be re-addressed to ` +
        `${allocation.ipv4Address}`,
    );
  }

  const moved: Partial<Guest> = {
    nodeId: target.id,
    bridge: target.bridge,
    mtu: target.mtu,
    ipv4Address: allocation.ipv4Address,
    ipv4Gateway: allocation.ipv4Gateway,
  };

  if (guest.kind === "VM") {
    await setGuest(guest.id, moved);
    const updated = await prisma.guest.findUniqueOrThrow({
      where: { id: guest.id },
    });

    await writeWorkspace(updated, target);
    const initResult = await init(opts);
    if (!initResult.ok) {
      await setGuest(guest.id, {
        status: "ERROR",
        statusDetail: "terraform init failed during migration",
      });
      await finish(job, "FAILED", { exitCode: initResult.code });
      return;
    }

    const result = await apply(opts);
    if (!result.ok) {
      await setGuest(guest.id, {
        status: "ERROR",
        statusDetail: `migration apply exited ${result.code}`,
      });
      await finish(job, "FAILED", {
        exitCode: result.code,
        error: "terraform migration apply failed",
      });
      return;
    }

    await setGuest(guest.id, {
      ...(await reconcileOutputs(updated)),
      status: "ACTIVE",
      statusDetail: null,
    });
    await finish(job, "OK", { exitCode: 0 });
    return;
  }

  // --- container path -------------------------------------------------------
  try {
    await logLine(
      job.logPath,
      `migrating container ${guest.vmid} from ${fromNode.name} to ${target.name} via the PVE API`,
    );
    const upid = await migrateGuest(
      "LXC",
      fromNode.name,
      guest.vmid,
      target.name,
      // `local` is a dir store on every node, so this is an offline move;
      // restart lets PVE stop, copy and start it again without us doing it.
      { restart: true },
    );
    await waitForTask(fromNode.name, upid);
    await logLine(job.logPath, "PVE migration task completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logLine(job.logPath, `PVE migration failed: ${message}`);
    // Nothing has been touched in Terraform state yet, so the guest is still
    // consistent on its original node.
    await setGuest(guest.id, {
      status: "ERROR",
      statusDetail: `migration failed: ${message}`,
    });
    await finish(job, "FAILED", { error: message });
    return;
  }

  await setGuest(guest.id, moved);
  const updated = await prisma.guest.findUniqueOrThrow({
    where: { id: guest.id },
  });
  await writeWorkspace(updated, target);

  const initResult = await init(opts);
  if (!initResult.ok) {
    await setGuest(guest.id, {
      status: "ERROR",
      statusDetail:
        "container moved, but terraform init failed — state needs re-import",
    });
    await finish(job, "FAILED", { exitCode: initResult.code });
    return;
  }

  // Detach the old (node, vmid) tuple and reattach at the new node. The
  // container itself is untouched by either step.
  const address = guestAddress("LXC");
  await stateRm(address, opts);
  const imported = await importResource(
    address,
    `${target.name}/${guest.vmid}`,
    opts,
  );
  if (!imported.ok) {
    await setGuest(guest.id, {
      status: "ERROR",
      statusDetail:
        `container is running on ${target.name} but could not be imported back ` +
        `into Terraform state; re-import ${address} as ${target.name}/${guest.vmid}`,
    });
    await finish(job, "FAILED", {
      exitCode: imported.code,
      error: "terraform import failed after migration",
    });
    return;
  }

  // Now reconcile the network change the move implies.
  const result = await apply(opts);
  if (!result.ok) {
    await setGuest(guest.id, {
      status: "ERROR",
      statusDetail: `post-migration apply exited ${result.code}`,
    });
    await finish(job, "FAILED", {
      exitCode: result.code,
      error: "post-migration apply failed",
    });
    return;
  }

  await setGuest(guest.id, {
    ...(await reconcileOutputs(updated)),
    status: "ACTIVE",
    statusDetail: null,
  });
  await finish(job, "OK", { exitCode: 0 });
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

async function runJob(job: Job): Promise<void> {
  const guest = await prisma.guest.findUnique({
    where: { id: job.guestId },
    include: { node: true },
  });

  if (!guest) {
    await finish(job, "FAILED", { error: "guest record disappeared" });
    return;
  }

  console.log(`[worker] ${job.kind} ${guest.hostname} (${job.id})`);

  await prisma.job.update({
    where: { id: job.id },
    data: { state: "RUNNING", startedAt: new Date() },
  });

  const busyStatus =
    job.kind === "DESTROY"
      ? "DESTROYING"
      : job.kind === "MIGRATE"
        ? "MIGRATING"
        : guest.status === "ACTIVE"
          ? "UPDATING"
          : "PROVISIONING";
  await setGuest(guest.id, { status: busyStatus });

  try {
    if (job.kind === "APPLY") await runApply(job, guest, guest.node);
    else if (job.kind === "DESTROY") await runDestroy(job, guest, guest.node);
    else if (job.kind === "MIGRATE") await runMigrate(job, guest, guest.node);
    else await finish(job, "FAILED", { error: `unknown job kind ${job.kind}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job ${job.id} threw:`, message);
    await logLine(job.logPath, `worker error: ${message}`);
    await setGuest(guest.id, { status: "ERROR", statusDetail: message });
    await finish(job, "FAILED", { error: message });
  }
}

/**
 * A job left RUNNING is a job whose worker died mid-flight. Its guest is in an
 * unknown state, so mark both rather than silently retrying something that may
 * have half-applied.
 */
async function recoverInterruptedJobs(): Promise<void> {
  const stuck = await prisma.job.findMany({ where: { state: "RUNNING" } });
  for (const job of stuck) {
    await logLine(
      job.logPath,
      "worker restarted while this job was running; marking it failed",
    );
    await prisma.job.update({
      where: { id: job.id },
      data: {
        state: "FAILED",
        error: "worker restarted while the job was running",
        finishedAt: new Date(),
      },
    });
    await prisma.guest.update({
      where: { id: job.guestId },
      data: {
        status: "ERROR",
        statusDetail:
          "a job was interrupted by a worker restart; re-run it to reconcile",
      },
    });
  }
  if (stuck.length > 0) {
    console.log(`[worker] recovered ${stuck.length} interrupted job(s)`);
  }
}

async function main(): Promise<void> {
  await ensureRuntimeDirs();
  await recoverInterruptedJobs();
  console.log("[worker] ready");

  while (!shuttingDown) {
    const job = await prisma.job.findFirst({
      where: { state: "QUEUED" },
      orderBy: { createdAt: "asc" },
    });

    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    await runJob(job);
  }

  console.log("[worker] stopped");
  await prisma.$disconnect();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Let the in-flight job finish; systemd's TimeoutStopSec covers the rest.
    console.log(`[worker] ${signal} received, finishing current job`);
    shuttingDown = true;
  });
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
