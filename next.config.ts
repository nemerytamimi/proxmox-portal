import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The worker and the PVE client both reach out over TLS to a Proxmox node
  // using a self-signed certificate; keep them out of the bundler's way.
  serverExternalPackages: ["undici", "bcryptjs", "@prisma/client"],
  output: "standalone",
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
