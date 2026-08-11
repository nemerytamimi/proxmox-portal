"use client";

import { useActionState, useState } from "react";

import { submitOrderAction, type OrderFormState } from "./actions";
import type { CatalogEntry } from "@/lib/catalog";
import { OS_TYPES, osTypeFromTemplate } from "@/lib/types";
import { Alert, Button, Field, inputClass } from "@/components/ui";

export interface NodeOption {
  id: string;
  name: string;
  allowVms: boolean;
  addressing: string;
  bridge: string;
}

export function OrderForm({
  templates,
  images,
  nodes,
}: {
  templates: CatalogEntry[];
  images: CatalogEntry[];
  nodes: NodeOption[];
}) {
  const [kind, setKind] = useState<"LXC" | "VM">("LXC");
  const [template, setTemplate] = useState("");
  const [osType, setOsType] = useState<string>("debian");
  const [state, action, pending] = useActionState<OrderFormState, FormData>(
    submitOrderAction,
    {},
  );

  const catalog = kind === "LXC" ? templates : images;
  // A VM can only be placed where there is KVM, so a preference for a node
  // without it is not worth offering.
  const preferable = nodes.filter((n) => kind === "LXC" || n.allowVms);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="kind" value={kind} />

      {state.error && <Alert title={state.error} items={state.issues} />}

      <Field label="Type">
        <div className="flex gap-2">
          {(["LXC", "VM"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-md border px-4 py-2 text-sm transition ${
                kind === k
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-line bg-panel-2 text-muted hover:text-fg"
              }`}
            >
              {k === "LXC" ? "Container (LXC)" : "Virtual machine"}
            </button>
          ))}
        </div>
      </Field>

      {kind === "VM" && preferable.length === 0 && (
        <Alert
          tone="warn"
          title="No node can currently run virtual machines."
          items={[
            "A node needs hardware virtualisation (/dev/kvm) and a network profile before it can host a VM. An admin can enable one under Nodes.",
          ]}
        />
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Hostname"
          hint="Lowercase letters, digits and hyphens."
        >
          <input
            name="hostname"
            required
            pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
            placeholder="build-agent"
            className={inputClass}
          />
        </Field>

        <Field
          label={kind === "LXC" ? "Template" : "Cloud image"}
          hint={
            catalog.length === 0
              ? "Nothing available — an admin needs to download one onto the cluster."
              : undefined
          }
        >
          <select
            name="templateFileId"
            required
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              // Keep the OS family in step with the image the user picked;
              // a mismatch is only rejected once Terraform runs.
              if (e.target.value) setOsType(osTypeFromTemplate(e.target.value));
            }}
            className={inputClass}
          >
            <option value="">Select…</option>
            {catalog.map((c) => (
              <option key={c.volid} value={c.volid}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Cores">
          <input
            name="cores"
            type="number"
            min={1}
            max={32}
            defaultValue={1}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Memory (MB)">
          <input
            name="memoryMb"
            type="number"
            min={256}
            step={256}
            defaultValue={1024}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Swap (MB)" hint={kind === "VM" ? "Containers only." : undefined}>
          <input
            name="swapMb"
            type="number"
            min={0}
            step={256}
            defaultValue={512}
            disabled={kind === "VM"}
            className={inputClass}
          />
        </Field>
        <Field label="Disk (GB)">
          <input
            name="diskGb"
            type="number"
            min={4}
            defaultValue={kind === "LXC" ? 8 : 20}
            required
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        {kind === "LXC" ? (
          <Field
            label="OS family"
            hint="Set automatically from the template. This is not a login name — credentials are further down."
          >
            <select
              name="osType"
              value={osType}
              onChange={(e) => setOsType(e.target.value)}
              className={inputClass}
            >
              {OS_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field
            label="Cloud-init user"
            hint="The login account cloud-init creates in the VM."
          >
            <input name="ciUser" defaultValue="debian" className={inputClass} />
          </Field>
        )}

        <Field
          label="Preferred node"
          hint="A suggestion only — an administrator makes the final placement."
        >
          <select name="preferredNodeId" className={inputClass}>
            <option value="">No preference</option>
            {preferable.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.bridge}, {n.addressing})
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="rounded-md border border-line p-4">
        <legend className="px-2 text-sm font-medium">Login credentials</legend>
        <p className="mb-4 text-xs text-muted">
          Provide at least one. The password is encrypted at rest and is never
          shown again after you submit.
        </p>

        <div className="space-y-4">
          <Field label="SSH public key">
            <textarea
              name="sshPublicKey"
              rows={3}
              placeholder="ssh-ed25519 AAAA… you@laptop"
              className={`${inputClass} font-mono text-xs`}
            />
          </Field>

          <Field
            label={kind === "LXC" ? "Root password" : "User password"}
            hint="At least 8 characters."
          >
            <input
              name="rootPassword"
              type="password"
              minLength={8}
              autoComplete="new-password"
              className={inputClass}
            />
          </Field>
        </div>
      </fieldset>

      <Button type="submit" disabled={pending}>
        {pending ? "Submitting…" : "Submit order for approval"}
      </Button>
    </form>
  );
}
