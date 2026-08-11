import Link from "next/link";
import { redirect } from "next/navigation";

import { logoutAction } from "../(auth)/actions";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const isAdmin = session.user.role === "ADMIN";

  // A pending count on the tab is the difference between an approval queue that
  // gets drained and one nobody remembers to look at.
  const pending = isAdmin
    ? await prisma.order.count({ where: { status: "PENDING" } })
    : 0;

  const links: Array<{ href: string; label: string; badge?: number }> = [
    { href: "/dashboard", label: "My guests" },
    { href: "/order", label: "Order" },
  ];
  if (isAdmin) {
    links.push(
      { href: "/admin/orders", label: "Approvals", badge: pending },
      { href: "/admin/nodes", label: "Nodes" },
      { href: "/admin/users", label: "Users" },
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <Link href="/dashboard" className="font-semibold">
            Proxmox Portal
          </Link>

          <nav className="flex flex-1 flex-wrap items-center gap-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded px-3 py-1.5 text-sm text-muted transition hover:bg-panel-2 hover:text-fg"
              >
                {l.label}
                {l.badge ? (
                  <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-ink">
                    {l.badge}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted">
              {session.user.email}
              {isAdmin && <span className="ml-2 text-accent">admin</span>}
            </span>
            <form action={logoutAction}>
              <button className="rounded border border-line px-2 py-1 text-xs text-muted transition hover:border-accent hover:text-fg">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
