"use client";

import Link from "next/link";
import { useActionState } from "react";

import { registerAction, type FormState } from "../actions";
import { Alert, Button, Field, inputClass } from "@/components/ui";

export default function RegisterPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(
    registerAction,
    {},
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-xl font-semibold">Create an account</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        The first account created becomes the administrator.
      </p>

      <div className="rounded-lg border border-line bg-panel p-6">
        <form action={action} className="space-y-4">
          {state.error && <Alert title={state.error} />}

          <Field label="Name" hint="Optional.">
            <input name="name" type="text" className={inputClass} />
          </Field>

          <Field label="Email">
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              className={inputClass}
            />
          </Field>

          <Field label="Password" hint="At least 10 characters.">
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              className={inputClass}
            />
          </Field>

          <Field label="Confirm password">
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              className={inputClass}
            />
          </Field>

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Creating…" : "Create account"}
          </Button>
        </form>
      </div>

      <p className="mt-4 text-center text-sm text-muted">
        Already registered?{" "}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
