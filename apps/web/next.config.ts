import type { NextConfig } from "next";

// The app runs on the user's computer only (decision 0008): no telemetry, no external images.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  transpilePackages: ["@vigil/api-types"],
};

export default config;
