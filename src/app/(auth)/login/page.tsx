"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useActionState } from "react";

import { loginAction, type FormState } from "../actions";
import { Alert, Button, Field, inputClass } from "@/components/ui";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";
  const [state, action, pending] = useActionState<FormState, FormData>(
    loginAction,
    {},
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />

      {state.error && <Alert title={state.error} />}

      <Field label="Email">
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className={inputClass}
        />
      </Field>

      <Field label="Password">
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </Field>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-xl font-semibold">Proxmox Portal</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        Sign in to order and manage your containers and virtual machines.
      </p>

      <div className="rounded-lg border border-line bg-panel p-6">
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>

      <p className="mt-4 text-center text-sm text-muted">
        No account?{" "}
        <Link href="/register" className="text-accent hover:underline">
          Register
        </Link>
      </p>
    </main>
  );
}
