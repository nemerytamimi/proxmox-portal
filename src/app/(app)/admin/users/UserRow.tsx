"use client";

import { useActionState } from "react";

import {
  saveQuotaAction,
  setRoleAction,
  toggleDisabledAction,
  type UserState,
} from "./actions";
import { Alert, Badge, Button, inputClass } from "@/components/ui";

export interface UserView {
  id: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  guestCount: number;
  quota: {
    maxGuests: number;
    maxCores: number;
    maxMemoryMb: number;
    maxDiskGb: number;
  };
  /** True when the limits shown are the global defaults, not a saved override. */
  usingDefaults: boolean;
}

export function UserRow({ user }: { user: UserView }) {
  const [quotaState, saveQuota, savingQuota] = useActionState<UserState, FormData>(
    saveQuotaAction,
    {},
  );
  const [roleState, setRole, settingRole] = useActionState<UserState, FormData>(
    setRoleAction,
    {},
  );
  const [toggleState, toggle, toggling] = useActionState<UserState, FormData>(
    toggleDisabledAction,
    {},
  );

  const feedback = quotaState.error || roleState.error || toggleState.error;
  const success = quotaState.ok || roleState.ok || toggleState.ok;

  return (
    <article className="rounded-lg border border-line bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{user.email}</span>
          {user.name && <span className="text-sm text-muted">{user.name}</span>}
          <Badge tone={user.role === "ADMIN" ? "info" : "muted"}>{user.role}</Badge>
          {user.disabled && <Badge tone="bad">disabled</Badge>}
          {user.usingDefaults && <Badge tone="muted">default quota</Badge>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">
            {user.guestCount} guest{user.guestCount === 1 ? "" : "s"}
          </span>
          <form action={setRole}>
            <input type="hidden" name="userId" value={user.id} />
            <input
              type="hidden"
              name="role"
              value={user.role === "ADMIN" ? "USER" : "ADMIN"}
            />
            <Button variant="ghost" type="submit" disabled={settingRole}>
              {user.role === "ADMIN" ? "Demote" : "Promote to admin"}
            </Button>
          </form>
          <form action={toggle}>
            <input type="hidden" name="userId" value={user.id} />
            <Button
              variant={user.disabled ? "ghost" : "danger"}
              type="submit"
              disabled={toggling}
            >
              {user.disabled ? "Enable" : "Disable"}
            </Button>
          </form>
        </div>
      </header>

      <form action={saveQuota} className="space-y-3 px-5 py-4">
        <input type="hidden" name="userId" value={user.id} />

        {feedback && <Alert title={feedback} />}
        {success && !feedback && <Alert tone="ok" title={success} />}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {(
            [
              ["maxGuests", "Guests", user.quota.maxGuests],
              ["maxCores", "Cores", user.quota.maxCores],
              ["maxMemoryMb", "Memory (MB)", user.quota.maxMemoryMb],
              ["maxDiskGb", "Disk (GB)", user.quota.maxDiskGb],
            ] as const
          ).map(([name, label, value]) => (
            <label key={name} className="block">
              <span className="mb-1 block text-xs text-muted">{label}</span>
              <input
                name={name}
                type="number"
                min={0}
                defaultValue={value}
                className={inputClass}
              />
            </label>
          ))}
          <div className="flex items-end">
            <Button type="submit" disabled={savingQuota} className="w-full">
              {savingQuota ? "Saving…" : "Save quota"}
            </Button>
          </div>
        </div>
      </form>
    </article>
  );
}
