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

  // /seasonal -> /seasonal/<current-season>/<current-year> at the HTTP
  // layer (308 Permanent Redirect). Computed at build time, so the
  // destination freezes to whatever season the Docker image was built
  // in — same lifecycle as sitemap.ts's CURRENT_SEASON_URL, which is
  // also build-time-pinned. A rebuild is required at each season
  // boundary; this is fine because every Phase release rebuilds anyway.
  //
  // Without this redirect, bare /seasonal triggered an infinite loop:
  // nginx's `^~ /seasonal/` location emits an implicit add-slash 301
  // for the bare form, and next-app's trailingSlash=false 308'd
  // /seasonal/ back to /seasonal.
  async redirects() {
    const now = new Date();
    const m = now.getMonth() + 1;
    const season =
      m <= 3 ? "winter" : m <= 6 ? "spring" : m <= 9 ? "summer" : "fall";
    const year = now.getFullYear();
    return [
      {
        source: "/seasonal",
        destination: `/seasonal/${season}/${year}`,
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
