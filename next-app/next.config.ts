import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import bundleAnalyzer from "@next/bundle-analyzer";
import path from "node:path";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

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
      {
        // P11: legacy /season (old SPA path, retired with the Express SPA)
        // -> the live seasonal grid. Keeps old bookmarks / search-index
        // URLs out of the dead legacy route.
        source: "/season",
        destination: `/seasonal/${season}/${year}`,
        permanent: true,
      },
    ];
  },

  // Cache the jassub subtitle-engine static binaries (WASM / worker / font) hard.
  // They live in public/jassub/ (built by `build:jassub` at prebuild) at stable,
  // non-content-hashed paths, so Next serves them with the public/ default
  // `Cache-Control: public, max-age=0`. That means the ~2 MB worker WASM is
  // re-fetched from the origin on every player open; on a slow load it blows
  // jassub's 10 s init budget and subtitles silently fail to appear (Cf-Cache-
  // Status was DYNAMIC because CF doesn't edge-cache .wasm by extension either).
  // A long max-age lets the browser AND the CF edge cache them. No `immutable`:
  // the paths are not content-hashed, so a 30-day window self-heals after a
  // jassub upgrade instead of pinning a stale worker for a year. Verified vs the
  // Next 16 headers() docs — headers are checked before /public, and non-hashed
  // public assets CAN have Cache-Control overridden (only SHA-hashed
  // /_next/static immutable assets cannot).
  async headers() {
    return [
      {
        source: "/jassub/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=2592000" }, // 30 days
        ],
      },
    ];
  },
};

// Sentry wraps the Next config so the webpack plugin can (a) inject the
// SDK at build time and (b) upload source maps to Sentry when an auth
// token is provided. The plugin is safe to invoke unconditionally: with
// no DSN at runtime the SDK no-ops, and with no auth token at build time
// the source-map upload step is skipped (see `sourcemaps.disable` below).
//
// CSP note: we deliberately do NOT set `tunnelRoute`. Sentry events go
// direct to ingest.sentry.io, which keeps nginx's strict CSP block in
// `nginx/default.conf` untouched. If ad-blocker bypass becomes a need,
// add the tunnel route here AND amend the CSP `connect-src` -- not one
// without the other.
export default withBundleAnalyzer(withSentryConfig(nextConfig, {
  // Suppress the SDK's verbose build logs locally; CI still sees them so
  // source-map upload failures stay visible in build logs.
  silent: !process.env.CI,
  // Don't widen client source maps to include Next internals + deps --
  // keeps source-map upload (and the resulting bundle) smaller. Trade-off
  // is unreadable stack frames inside node_modules, which is fine.
  widenClientFileUpload: false,
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeReplayShadowDom: true,
    excludeReplayIframe: true,
    excludeReplayWorker: true,
  },
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
    automaticVercelMonitors: false,
  },
  // Source-map upload is gated on SENTRY_AUTH_TOKEN. Without the token
  // the plugin skips upload entirely so dev / unauthenticated CI builds
  // don't fail. With the token set (prod CI), maps upload normally.
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
}));
