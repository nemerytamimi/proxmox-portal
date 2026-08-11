"use client";

import { useActionState, useState } from "react";

import { approveAction, rejectAction, type ReviewState } from "./actions";
import { Alert, Badge, Button, Field, inputClass } from "@/components/ui";

export interface NodeChoice {
  id: string;
  name: string;
  online: boolean;
  bridge: string;
  addressing: string;
  subnetPrefix: string | null;
  gateway: string | null;
  defaultDatastore: string;
  mtu: number;
  /** Null when the node can host this guest, otherwise why it cannot. */
  blockedBecause: string | null;
}

export interface PendingOrder {
  id: string;
  kind: "LXC" | "VM";
  hostname: string;
  cores: number;
  memoryMb: number;
  swapMb: number;
  diskGb: number;
  templateLabel: string;
  requester: string;
  requestedAt: string;
  preferredNodeName: string | null;
  hasSshKey: boolean;
  hasPassword: boolean;
}

export function ReviewCard({
  order,
  nodes,
}: {
  order: PendingOrder;
  nodes: NodeChoice[];
}) {
  const [approveState, approve, approving] = useActionState<ReviewState, FormData>(
    approveAction,
    {},
  );
  const [rejectState, reject, rejecting] = useActionState<ReviewState, FormData>(
    rejectAction,
    {},
  );
  const [nodeId, setNodeId] = useState("");
  const [showReject, setShowReject] = useState(false);

  const selectable = nodes.filter((n) => !n.blockedBecause);
  const selected = nodes.find((n) => n.id === nodeId);

  return (
    <article className="rounded-lg border border-line bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-semibold">{order.hostname}</h3>
          <Badge tone="info">{order.kind}</Badge>
          <span className="text-sm text-muted">{order.requester}</span>
        </div>
        <span className="text-xs text-muted">{order.requestedAt}</span>
      </header>

      <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Specs</dt>
            <dd>
              {order.cores} cores · {order.memoryMb} MB
              {order.kind === "LXC" && ` · ${order.swapMb} MB swap`} · {order.diskGb} GB
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">
              {order.kind === "LXC" ? "Template" : "Image"}
            </dt>
            <dd className="text-right">{order.templateLabel}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Prefers</dt>
            <dd>{order.preferredNodeName ?? "no preference"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Credentials</dt>
            <dd>
              {[
                order.hasSshKey ? "SSH key" : null,
                order.hasPassword ? "password" : null,
              ]
                .filter(Boolean)
                .join(" + ") || "none"}
            </dd>
          </div>
        </dl>

        <form action={approve} className="space-y-3">
          <input type="hidden" name="orderId" value={order.id} />

          {approveState.error && (
            <Alert title={approveState.error} items={approveState.issues} />
          )}
          {approveState.ok && <Alert tone="ok" title={approveState.ok} />}

          <Field
            label="Target node"
            hint="Read live from the cluster. Nodes that cannot host this guest are listed with the reason."
          >
            <select
              name="nodeId"
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
              className={inputClass}
            >
              <option value="">Select a node…</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id} disabled={!!n.blockedBecause}>
                  {n.name}
                  {n.blockedBecause
                    ? ` — ${n.blockedBecause}`
                    : ` (${n.bridge}, ${n.addressing})`}
                </option>
              ))}
            </select>
          </Field>

          {selected && (
            <div className="rounded-md border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
              <p>
                Network: {selected.bridge}
                {selected.mtu ? `, MTU ${selected.mtu}` : ""} ·{" "}
                {selected.addressing === "static"
                  ? `${selected.subnetPrefix}.x, gateway ${selected.gateway}`
                  : "DHCP"}
              </p>
              <p>Storage: {selected.defaultDatastore}</p>
            </div>
          )}

          {selectable.length === 0 && (
            <Alert
              tone="warn"
              title="No node can host this guest."
              items={[
                order.kind === "VM"
                  ? "A VM needs an online node with KVM and a configured network profile."
                  : "An online node with a configured network profile is required.",
              ]}
            />
          )}

          <Field label="Note" hint="Optional; visible to the requester.">
            <input name="note" className={inputClass} />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={approving || !nodeId}>
              {approving ? "Approving…" : "Approve and provision"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowReject((v) => !v)}
            >
              Reject
            </Button>
          </div>
        </form>
      </div>

      {showReject && (
        <form action={reject} className="space-y-3 border-t border-line px-5 py-4">
          <input type="hidden" name="orderId" value={order.id} />
          {rejectState.error && <Alert title={rejectState.error} />}
          <Field label="Reason" hint="Shown to the requester on their dashboard.">
            <input name="note" required className={inputClass} />
          </Field>
          <Button type="submit" variant="danger" disabled={rejecting}>
            {rejecting ? "Rejecting…" : "Confirm rejection"}
          </Button>
        </form>
      )}
    </article>
  );
}
