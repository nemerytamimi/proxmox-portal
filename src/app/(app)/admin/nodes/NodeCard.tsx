"use client";

import { useActionState, useState } from "react";

import { saveNodeAction, type NodeState } from "./actions";
import { Alert, Badge, Button, Field, inputClass } from "@/components/ui";

export interface NodeView {
  id: string;
  name: string;
  online: boolean;
  configured: boolean;
  allowLxc: boolean;
  allowVms: boolean;
  bridge: string;
  mtu: number;
  addressing: string;
  subnetPrefix: string | null;
  gateway: string | null;
  ipPoolStart: number | null;
  ipPoolEnd: number | null;
  dnsServers: string;
  defaultDatastore: string;
  templateDatastore: string;
  notes: string | null;
  maxCpu: number | null;
  maxMemoryMb: number | null;
  guestCount: number;
  /** Bridges actually present on the node, for reference while editing. */
  detectedBridges: Array<{ iface: string; cidr?: string; mtu?: number }>;
  detectedStorage: string[];
}

export function NodeCard({ node }: { node: NodeView }) {
  const [state, action, pending] = useActionState<NodeState, FormData>(
    saveNodeAction,
    {},
  );
  const [addressing, setAddressing] = useState(node.addressing);

  return (
    <article className="rounded-lg border border-line bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-semibold">{node.name}</h3>
          <Badge tone={node.online ? "ok" : "bad"}>
            {node.online ? "online" : "offline"}
          </Badge>
          {!node.configured && <Badge tone="warn">not configured</Badge>}
          {node.allowVms ? (
            <Badge tone="info">VMs</Badge>
          ) : (
            <Badge tone="muted">no KVM</Badge>
          )}
        </div>
        <span className="text-xs text-muted">
          {node.maxCpu ?? "?"} cores · {node.maxMemoryMb ?? "?"} MB ·{" "}
          {node.guestCount} portal guest{node.guestCount === 1 ? "" : "s"}
        </span>
      </header>

      {node.detectedBridges.length > 0 && (
        <p className="border-b border-line px-5 py-2 text-xs text-muted">
          Detected bridges:{" "}
          {node.detectedBridges
            .map(
              (b) =>
                `${b.iface}${b.cidr ? ` (${b.cidr})` : ""}${b.mtu ? ` MTU ${b.mtu}` : ""}`,
            )
            .join(" · ")}
          {node.detectedStorage.length > 0 && (
            <> — storage: {node.detectedStorage.join(", ")}</>
          )}
        </p>
      )}

      <form action={action} className="space-y-5 px-5 py-4">
        <input type="hidden" name="nodeId" value={node.id} />

        {state.error && <Alert title={state.error} items={state.issues} />}
        {state.ok && <Alert tone="ok" title={state.ok} />}

        <div className="flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="configured"
              defaultChecked={node.configured}
            />
            <span>Available for provisioning</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="allowLxc" defaultChecked={node.allowLxc} />
            <span>Allow containers</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="allowVms" defaultChecked={node.allowVms} />
            <span>Allow VMs (needs /dev/kvm)</span>
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Guest bridge">
            <input name="bridge" defaultValue={node.bridge} className={inputClass} />
          </Field>
          <Field label="MTU" hint="0 leaves it to Proxmox.">
            <input
              name="mtu"
              type="number"
              min={0}
              max={9000}
              defaultValue={node.mtu}
              className={inputClass}
            />
          </Field>
          <Field label="Addressing">
            <select
              name="addressing"
              value={addressing}
              onChange={(e) => setAddressing(e.target.value)}
              className={inputClass}
            >
              <option value="static">static</option>
              <option value="dhcp">dhcp</option>
            </select>
          </Field>
          <Field label="DNS servers" hint="Comma separated.">
            <input
              name="dnsServers"
              defaultValue={node.dnsServers}
              className={inputClass}
            />
          </Field>
        </div>

        {addressing === "static" && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Subnet prefix" hint="First three octets, e.g. 10.98.3">
              <input
                name="subnetPrefix"
                defaultValue={node.subnetPrefix ?? ""}
                placeholder="10.98.3"
                className={inputClass}
              />
            </Field>
            <Field label="Gateway">
              <input
                name="gateway"
                defaultValue={node.gateway ?? ""}
                placeholder="10.98.3.1"
                className={inputClass}
              />
            </Field>
            <Field label="Pool start" hint="Last octet — also the VMID.">
              <input
                name="ipPoolStart"
                type="number"
                min={2}
                max={254}
                defaultValue={node.ipPoolStart ?? 140}
                className={inputClass}
              />
            </Field>
            <Field label="Pool end">
              <input
                name="ipPoolEnd"
                type="number"
                min={2}
                max={254}
                defaultValue={node.ipPoolEnd ?? 229}
                className={inputClass}
              />
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default datastore" hint="Where guest disks land.">
            <input
              name="defaultDatastore"
              defaultValue={node.defaultDatastore}
              className={inputClass}
            />
          </Field>
          <Field
            label="Template datastore"
            hint="Holds container templates and cloud images."
          >
            <input
              name="templateDatastore"
              defaultValue={node.templateDatastore}
              className={inputClass}
            />
          </Field>
        </div>

        <Field label="Notes">
          <input
            name="notes"
            defaultValue={node.notes ?? ""}
            className={inputClass}
          />
        </Field>

        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save profile"}
        </Button>
      </form>
    </article>
  );
}
