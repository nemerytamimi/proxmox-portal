"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import {
  loadVmImagesAction,
  submitOrderAction,
  type OrderFormState,
} from "./actions";
import type { CatalogEntry, VmImageEntry } from "@/lib/catalog";
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
  /** Cloud images and ISOs across every VM-capable node. */
  images: VmImageEntry[];
  nodes: NodeOption[];
}) {
  const [kind, setKind] = useState<"LXC" | "VM">("LXC");
  const [preferredNodeId, setPreferredNodeId] = useState("");
  const [image, setImage] = useState("");
  const [osType, setOsType] = useState<string>("debian");

  // The chosen node's own images, read live when a preferred node is picked.
  const [nodeImages, setNodeImages] = useState<VmImageEntry[] | null>(null);
  const [loadingImages, setLoadingImages] = useState(false);
  const [imagesError, setImagesError] = useState<string | undefined>();
  const request = useRef(0);

  const [state, action, pending] = useActionState<OrderFormState, FormData>(
    submitOrderAction,
    {},
  );

  // A VM can only be placed where there is KVM, so a preference for a node
  // without it is not worth offering.
  const preferable = nodes.filter((n) => kind === "LXC" || n.allowVms);
  const preferred = preferable.find((n) => n.id === preferredNodeId);

  useEffect(() => {
    if (kind !== "VM" || !preferred) {
      setNodeImages(null);
      setImagesError(undefined);
      setLoadingImages(false);
      return;
    }
    // Answers can arrive out of order when the user flips between nodes; only
    // the latest one counts.
    const id = ++request.current;
    setLoadingImages(true);
    setImagesError(undefined);
    loadVmImagesAction(preferred.id)
      .then((res) => {
        if (id !== request.current) return;
        setNodeImages(res.images);
        setImagesError(res.error);
      })
      .catch(() => {
        if (id !== request.current) return;
        setNodeImages([]);
        setImagesError(`Could not read the storage on ${preferred.name}.`);
      })
      .finally(() => {
        if (id === request.current) setLoadingImages(false);
      });
  }, [kind, preferred]);

  const vmCatalog = nodeImages ?? images;
  const lxcCatalog = preferred
    ? templates.filter((t) => t.nodes.includes(preferred.name))
    : templates;

  const catalog: Array<CatalogEntry & { source?: VmImageEntry["source"] }> =
    kind === "LXC" ? lxcCatalog : vmCatalog;
  // A selection the current list no longer contains (another node, another
  // kind) is dropped rather than submitted.
  const selected = catalog.find((c) => c.volid === image);
  const isIso = kind === "VM" && selected?.source === "ISO";

  const cloudImages = vmCatalog.filter((c) => c.source === "CLOUD_IMAGE");
  const isos = vmCatalog.filter((c) => c.source === "ISO");

  const where = preferred ? `on ${preferred.name}` : "on any node";
  const imageHint = loadingImages
    ? `Reading storage on ${preferred?.name}…`
    : imagesError
      ? imagesError
      : catalog.length === 0
        ? `Nothing available ${where}. An admin needs to download one onto the cluster.`
        : kind === "VM"
          ? `${cloudImages.length} cloud image${cloudImages.length === 1 ? "" : "s"} and ${isos.length} ISO${isos.length === 1 ? "" : "s"} ${where}.`
          : preferred
            ? `Templates on ${preferred.name}.`
            : undefined;

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="kind" value={kind} />
      {kind === "VM" && (
        <>
          <input
            type="hidden"
            name="templateFileId"
            value={selected?.source === "CLOUD_IMAGE" ? selected.volid : ""}
          />
          <input type="hidden" name="isoFileId" value={isIso ? selected!.volid : ""} />
        </>
      )}

      {state.error && <Alert title={state.error} items={state.issues} />}

      <Field label="Type">
        <div className="flex gap-2">
          {(["LXC", "VM"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                setImage("");
                // A preference for a node without KVM is not valid for a VM.
                if (k === "VM" && !nodes.find((n) => n.id === preferredNodeId)?.allowVms) {
                  setPreferredNodeId("");
                }
              }}
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
          label="Preferred node"
          hint={
            kind === "VM"
              ? "Lists that node's own images and ISOs. An administrator makes the final placement."
              : "A suggestion only — an administrator makes the final placement."
          }
        >
          <select
            name="preferredNodeId"
            value={preferredNodeId}
            onChange={(e) => setPreferredNodeId(e.target.value)}
            className={inputClass}
          >
            <option value="">No preference</option>
            {preferable.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.bridge}, {n.addressing})
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label={kind === "LXC" ? "Template" : "Cloud image or ISO"}
          hint={imageHint}
        >
          <select
            name={kind === "LXC" ? "templateFileId" : undefined}
            required
            disabled={loadingImages}
            value={selected ? selected.volid : ""}
            onChange={(e) => {
              setImage(e.target.value);
              // Keep the OS family in step with the image the user picked;
              // a mismatch is only rejected once Terraform runs.
              if (kind === "LXC" && e.target.value) {
                setOsType(osTypeFromTemplate(e.target.value));
              }
            }}
            className={inputClass}
          >
            <option value="">{loadingImages ? "Loading…" : "Select…"}</option>
            {kind === "LXC" ? (
              lxcCatalog.map((c) => (
                <option key={c.volid} value={c.volid}>
                  {c.label}
                </option>
              ))
            ) : (
              <>
                {cloudImages.length > 0 && (
                  <optgroup label="Cloud images — ready to boot, set up by cloud-init">
                    {cloudImages.map((c) => (
                      <option key={c.volid} value={c.volid}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {isos.length > 0 && (
                  <optgroup label="ISO installers — install from the console">
                    {isos.map((c) => (
                      <option key={c.volid} value={c.volid}>
                        {c.label}
                        {!preferred && c.nodes.length > 0 ? ` (${c.nodes.join(", ")})` : ""}
                      </option>
                    ))}
                  </optgroup>
                )}
              </>
            )}
          </select>
        </Field>

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
        ) : isIso ? (
          <div />
        ) : (
          <Field
            label="Cloud-init user"
            hint="The login account cloud-init creates in the VM."
          >
            <input name="ciUser" defaultValue="debian" className={inputClass} />
          </Field>
        )}
      </div>

      {isIso && (
        <Alert
          tone="warn"
          title="This VM boots the installer. You finish the install yourself."
          items={[
            "It gets a blank disk with the ISO attached. Open the console from Proxmox once it is running and go through the installer.",
            "Nothing is configured for you: set the network, user and password in the installer. The guest page shows the address reserved for it.",
            "After the install it boots from its disk; the ISO can stay attached or be ejected.",
          ]}
        />
      )}

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
            defaultValue={kind === "VM" ? 2048 : 1024}
            key={`mem-${kind}`}
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
            key={`disk-${kind}`}
            required
            className={inputClass}
          />
        </Field>
      </div>

      {!isIso && (
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
      )}

      <Button type="submit" disabled={pending || loadingImages}>
        {pending ? "Submitting…" : "Submit order for approval"}
      </Button>
    </form>
  );
}
