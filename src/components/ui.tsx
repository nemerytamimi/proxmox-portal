import type { ReactNode } from "react";

/** Small shared primitives, so pages stay about behaviour rather than classes. */

export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && (
              <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>
            )}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const TONES: Record<string, string> = {
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
  info: "bg-accent/15 text-accent",
  muted: "bg-line text-muted",
};

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: keyof typeof TONES | string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
        TONES[tone] ?? TONES.muted
      }`}
    >
      {children}
    </span>
  );
}

/** Maps a guest or job status onto a colour, in one place. */
export function statusTone(status: string): string {
  switch (status) {
    case "ACTIVE":
    case "OK":
    case "running":
      return "ok";
    case "ERROR":
    case "FAILED":
      return "bad";
    case "DESTROYED":
    case "CANCELLED":
    case "stopped":
      return "muted";
    default:
      return "warn";
  }
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  const styles = {
    primary: "bg-accent text-ink hover:opacity-90",
    ghost: "border border-line bg-panel-2 hover:border-accent",
    danger: "border border-bad/50 text-bad hover:bg-bad/10",
  }[variant];

  return (
    <button
      {...props}
      className={`rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export function Alert({
  tone = "bad",
  title,
  items,
  children,
}: {
  tone?: "bad" | "warn" | "ok";
  title?: string;
  items?: string[];
  children?: ReactNode;
}) {
  const border = { bad: "border-bad/40", warn: "border-warn/40", ok: "border-ok/40" }[tone];
  const text = { bad: "text-bad", warn: "text-warn", ok: "text-ok" }[tone];
  return (
    <div className={`rounded-md border ${border} bg-panel-2 px-4 py-3 text-sm`}>
      {title && <p className={`font-medium ${text}`}>{title}</p>}
      {items && items.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-muted">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

export function bytes(n?: number): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
