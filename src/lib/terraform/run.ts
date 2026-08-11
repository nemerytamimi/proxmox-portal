import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { env } from "../env";

/**
 * Terraform process runner.
 *
 * Everything is appended to a per-job log file rather than buffered in memory:
 * an apply can run for minutes and the browser tails that file over SSE, so the
 * user watches the same bytes the worker recorded.
 */

export interface RunResult {
  code: number;
  ok: boolean;
}

export interface RunOptions {
  cwd: string;
  logPath: string;
  /** Secrets injected as TF_VAR_* so they never touch the workspace on disk. */
  secrets?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Credentials and runner settings shared by every terraform invocation. */
function terraformEnv(
  secrets: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const vars: NodeJS.ProcessEnv = {
    ...process.env,

    // Non-interactive: no colour codes in the log, no prompts to hang on.
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    TF_CLI_ARGS: "-no-color",

    // Without a shared cache every workspace re-downloads the provider — over
    // a 1420-MTU WireGuard link that is both slow and prone to TLS stalls.
    TF_PLUGIN_CACHE_DIR: env.pluginCacheDir,

    TF_VAR_pve_endpoint: env.pveEndpoint,
    TF_VAR_pve_api_token: env.pveApiToken,
    TF_VAR_pve_insecure: String(env.pveInsecure),
    TF_VAR_pve_ssh_username: env.pveSshUsername,
    TF_VAR_pve_ssh_private_key: env.pveSshPrivateKey,
    // Complex TF_VAR values are parsed as HCL; a JSON object literal is valid.
    TF_VAR_pve_node_addresses: JSON.stringify(env.pveNodeAddresses),
  };

  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined) vars[`TF_VAR_${key}`] = value;
  }

  return vars;
}

export async function runTerraform(
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  await mkdir(path.dirname(opts.logPath), { recursive: true });
  const log = createWriteStream(opts.logPath, { flags: "a" });

  const header = `\n$ terraform ${args.join(" ")}\n`;
  log.write(header);

  return new Promise<RunResult>((resolve) => {
    const child = spawn(env.terraformBin, args, {
      cwd: opts.cwd,
      env: terraformEnv(opts.secrets),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    const timeout = setTimeout(
      () => {
        log.write(`\n[portal] timed out after ${opts.timeoutMs}ms, killing\n`);
        child.kill("SIGKILL");
      },
      opts.timeoutMs ?? 45 * 60_000,
    );

    child.on("error", (err) => {
      clearTimeout(timeout);
      log.write(`\n[portal] failed to start terraform: ${err.message}\n`);
      log.end();
      resolve({ code: -1, ok: false });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const exit = code ?? -1;
      log.write(`\n[portal] terraform exited with ${exit}\n`);
      log.end();
      resolve({ code: exit, ok: exit === 0 });
    });
  });
}

/** Append a portal-generated line to a job log, alongside terraform's output. */
export async function logLine(logPath: string, line: string): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(logPath, { flags: "a" });
    stream.write(`[portal] ${line}\n`, (err) =>
      err ? reject(err) : (stream.end(), resolve()),
    );
  });
}

export async function init(opts: RunOptions): Promise<RunResult> {
  return runTerraform(["init", "-upgrade=false"], opts);
}

export async function apply(opts: RunOptions): Promise<RunResult> {
  return runTerraform(["apply", "-auto-approve"], opts);
}

export async function plan(opts: RunOptions): Promise<RunResult> {
  // -detailed-exitcode: 0 = no changes, 2 = changes pending, 1 = error.
  return runTerraform(["plan", "-detailed-exitcode"], opts);
}

export async function destroy(opts: RunOptions): Promise<RunResult> {
  return runTerraform(["destroy", "-auto-approve"], opts);
}

export async function refresh(opts: RunOptions): Promise<RunResult> {
  return runTerraform(["apply", "-refresh-only", "-auto-approve"], opts);
}

/**
 * Drop a resource from state without touching the cluster. Used by the LXC
 * migration path, which moves the container out of band and then re-attaches
 * it to state at its new address.
 */
export async function stateRm(
  address: string,
  opts: RunOptions,
): Promise<RunResult> {
  return runTerraform(["state", "rm", address], opts);
}

export async function importResource(
  address: string,
  id: string,
  opts: RunOptions,
): Promise<RunResult> {
  return runTerraform(["import", address, id], opts);
}

/** Read `terraform output -json`, bypassing the log file. */
export async function readOutputs(
  cwd: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn(env.terraformBin, ["output", "-json"], {
      cwd,
      env: terraformEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
    });
    child.on("close", () => {
      try {
        const parsed = JSON.parse(buf) as Record<string, { value: unknown }>;
        resolve(
          Object.fromEntries(
            Object.entries(parsed).map(([k, v]) => [k, v.value]),
          ),
        );
      } catch {
        resolve({});
      }
    });
    child.on("error", () => resolve({}));
  });
}

/** The resource address of the guest inside a generated workspace. */
export function guestAddress(kind: "LXC" | "VM"): string {
  return kind === "LXC"
    ? "module.guest.proxmox_virtual_environment_container.this"
    : "module.guest.proxmox_virtual_environment_vm.this";
}
