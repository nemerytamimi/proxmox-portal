"use client";

import { useActionState, useState } from "react";

import {
  destroyAction,
  migrateAction,
  powerActionForm,
  reapplyAction,
  resizeAction,
  type ActionState,
} from "./actions";
import { Alert, Button, Field, inputClass } from "@/components/ui";

export interface MigrationTarget {
  id: string;
  name: string;
  bridge: string;
  addressing: string;
  readdresses: boolean;
}

function Feedback({ state }: { state: ActionState }) {
  if (state.error) return <Alert title={state.error} items={state.issues} />;
  if (state.ok) return <Alert tone="ok" title={state.ok} />;
  return null;
}

export function PowerControls({
  guestId,
  busy,
  running,
}: {
  guestId: string;
  busy: boolean;
  running: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    powerActionForm,
    {},
  );

  const buttons = running
    ? ([
        ["shutdown", "Shut down"],
        ["reboot", "Reboot"],
        ["stop", "Force stop"],
      ] as const)
    : ([["start", "Start"]] as const);

  return (
    <div className="space-y-3">
      <Feedback state={state} />
      <form action={action} className="flex flex-wrap gap-2">
        <input type="hidden" name="guestId" value={guestId} />
        {buttons.map(([value, label]) => (
          <Button
            key={value}
            type="submit"
            name="action"
            value={value}
            variant={value === "stop" ? "danger" : "ghost"}
            disabled={busy || pending}
          >
            {label}
          </Button>
        ))}
      </form>
      {busy && (
        <p className="text-xs text-muted">
          A Terraform job is running; power actions are disabled until it finishes.
        </p>
      )}
    </div>
  );
}

export function ResizeForm({
  guestId,
  busy,
  isLxc,
  current,
}: {
  guestId: string;
  busy: boolean;
  isLxc: boolean;
  current: { cores: number; memoryMb: number; swapMb: number; diskGb: number };
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    resizeAction,
    {},
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="guestId" value={guestId} />
      <Feedback state={state} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Cores">
          <input
            name="cores"
            type="number"
            min={1}
            max={32}
            defaultValue={current.cores}
            className={inputClass}
          />
        </Field>
        <Field label="Memory (MB)">
          <input
            name="memoryMb"
            type="number"
            min={256}
            step={256}
            defaultValue={current.memoryMb}
            className={inputClass}
          />
        </Field>
        <Field label="Swap (MB)">
          <input
            name="swapMb"
            type="number"
            min={0}
            step={256}
            defaultValue={current.swapMb}
            disabled={!isLxc}
            className={inputClass}
          />
        </Field>
        <Field label="Disk (GB)" hint="Can only grow.">
          <input
            name="diskGb"
            type="number"
            min={current.diskGb}
            defaultValue={current.diskGb}
            className={inputClass}
          />
        </Field>
      </div>

      <Button type="submit" disabled={busy || pending}>
        {pending ? "Queueing…" : "Apply changes"}
      </Button>
    </form>
  );
}

export function MigrateForm({
  guestId,
  busy,
  targets,
}: {
  guestId: string;
  busy: boolean;
  targets: MigrationTarget[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    migrateAction,
    {},
  );
  const [selected, setSelected] = useState("");

  const target = targets.find((t) => t.id === selected);

  if (targets.length === 0) {
    return (
      <p className="text-sm text-muted">
        No other node can host this guest right now.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="guestId" value={guestId} />
      <Feedback state={state} />

      <Field label="Target node">
        <select
          name="targetNodeId"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className={inputClass}
        >
          <option value="">Select a node…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.bridge}, {t.addressing})
            </option>
          ))}
        </select>
      </Field>

      {target?.readdresses && (
        <Alert
          tone="warn"
          title="This move changes the guest's address."
          items={[
            `${target.name} uses ${target.bridge} with ${target.addressing} addressing, which differs from the current node.`,
            "The guest will get a new IP and its current address will stop working.",
          ]}
        />
      )}

      <label className="flex items-start gap-2 text-sm text-muted">
        <input type="checkbox" name="acknowledge" value="yes" className="mt-1" />
        <span>
          I understand the guest will be stopped, moved and may be re-addressed.
        </span>
      </label>

      <Button type="submit" variant="ghost" disabled={busy || pending || !selected}>
        {pending ? "Queueing…" : "Migrate"}
      </Button>
    </form>
  );
}

export function DangerZone({
  guestId,
  hostname,
  busy,
  errored,
}: {
  guestId: string;
  hostname: string;
  busy: boolean;
  errored: boolean;
}) {
  const [destroyState, destroy, destroying] = useActionState<ActionState, FormData>(
    destroyAction,
    {},
  );
  const [reapplyState, reapply, reapplying] = useActionState<ActionState, FormData>(
    reapplyAction,
    {},
  );

  return (
    <div className="space-y-6">
      {errored && (
        <form action={reapply} className="space-y-3">
          <input type="hidden" name="guestId" value={guestId} />
          <Feedback state={reapplyState} />
          <p className="text-sm text-muted">
            This guest is in an error state. Re-applying replays the desired
            configuration, which is usually enough to reconcile it.
          </p>
          <Button type="submit" variant="ghost" disabled={busy || reapplying}>
            {reapplying ? "Queueing…" : "Re-apply"}
          </Button>
        </form>
      )}

      <form action={destroy} className="space-y-3">
        <input type="hidden" name="guestId" value={guestId} />
        <input type="hidden" name="hostname" value={hostname} />
        <Feedback state={destroyState} />

        <Field
          label="Destroy this guest"
          hint={`Runs terraform destroy. This cannot be undone. Type "${hostname}" to confirm.`}
        >
          <input name="confirm" placeholder={hostname} className={inputClass} />
        </Field>

        <Button type="submit" variant="danger" disabled={busy || destroying}>
          {destroying ? "Queueing…" : "Destroy"}
        </Button>
      </form>
    </div>
  );
}
