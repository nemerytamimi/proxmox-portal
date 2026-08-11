import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Proxmox Portal",
  description: "Self-service containers and virtual machines, applied with Terraform",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-fg">{children}</body>
    </html>
  );
}
