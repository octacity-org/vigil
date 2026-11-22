import { join } from "node:path";
import type { NextConfig } from "next";

// The app runs on the user's computer only (decision 0008): no telemetry, no external images.
const config: NextConfig = {
  // A self-contained server for the Docker image (#261); the trace starts at the repository root (workspace packages).
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  transpilePackages: ["@vigil/api-types"],
};

export default config;
