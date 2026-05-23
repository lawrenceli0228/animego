import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Standalone output bundles a minimal Node server + only the deps the
  // tree actually uses. Reduces the Docker image from ~600MB (full
  // node_modules) to ~120MB. Required for the multi-stage Dockerfile.
  output: "standalone",

  turbopack: {
    root: path.resolve(__dirname),
  },

  // Dev-only rewrite to the local go-api on :8080. In docker-compose
  // (local and prod) RSC reads GO_API_INTERNAL_URL directly via the
  // Docker network, and browser requests for /api/* hit nginx, which
  // routes to legacy Express:5001. Phase 8.5 will switch nginx /api/
  // upstream from `app` to `go_api`.
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8080/api/:path*",
      },
    ];
  },
};

export default nextConfig;
