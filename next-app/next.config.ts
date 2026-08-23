import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import bundleAnalyzer from "@next/bundle-analyzer";
import path from "node:path";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

// An identifier for this build, inlined into both the client bundle and the
// server bundle by the `env` option below.
//
// The comparison it enables is between two builds, not two processes: a tab
// opened before a deploy holds the old value in its own JavaScript, asks
// /version.json (served by the new deployment) for the current one, and finds
// them different. See components/layout/StaleTabNotice.tsx.
//
// Next inlines `env` values at BUILD time on both sides, which is the whole
// reason this works — if the server read it at runtime instead, `next start`
// would re-evaluate this file, produce a third value, and every visitor would
// be told to refresh forever. There is a test that pins that behaviour
// (lib/buildId.test.ts) because getting it wrong is invisible in development,
// where client and server are the same process.
//
// GIT_SHA when the deploy provides one, so two rebuilds of the same commit are
// the same build; the timestamp otherwise, so a local build still differs from
// the last one.
const BUILD_ID = process.env.GIT_SHA?.trim() || `t${Date.now()}`;

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },

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

  // Image Optimization. Until this commit there was no `images` key at all, so
  // the whole section ran on Next 16 defaults -- which meant `remotePatterns:
  // []`, i.e. every AniList URL fed to next/image answered 400, which is why
  // the codebase had exactly one next/image call site and it was a local file.
  //
  // ## Why AVIF and not just WebP
  //
  // Measured on this repo's own material (flat cel-shaded covers), at equal
  // byte size, AVIF's banding is 1/3.8 of WebP's and 1/9.4 of JPEG's. The
  // cause is chroma subsampling, not the codec's entropy coder: sharp emits
  // AVIF at 4:4:4 by default while WebP and JPEG default to 4:2:0, halving
  // chroma resolution -- exactly what blurs the coloured line art anime is
  // made of. WebP's apparent size advantage in a naive comparison is bought
  // with that chroma. Order matters here: the first entry the browser's Accept
  // header matches wins, so AVIF leads and WebP is the fallback.
  //
  // ## qualities: why 85 and not the default 75
  //
  // THIS IS THE ONE THAT FAILS SILENTLY. Next does not pass `quality` through
  // to the AVIF encoder; it passes `quality - 20`:
  //
  //   image-optimizer.js: transformer.avif({ quality: Math.max(quality - 20, 1), effort: 3 })
  //
  // So the default quality={75} produces AVIF q55, which on this material is
  // below the knee -- gradients (sky, skin) start to band. quality={85} lands
  // on AVIF q65, which measures SSIM 0.986-0.988 against the source. Since
  // Next 16 `qualities` is an allowlist, 85 has to be named here or the call
  // sites asking for it get silently clamped. 75 stays in the list because
  // that is what a call site that passes nothing gets.
  //
  // ## The container is 512 MB and has no volume (docker-compose.yml)
  //
  // Both of the next two keys exist because of that, and neither default is
  // safe here:
  //
  //  - maximumResponseBody defaults to 50 MB, and the source image is read
  //    fully into memory before sharp touches it. The largest thing we
  //    actually reference is a ~708 KB cover, so 8 MB is already generous;
  //    50 MB x a few concurrent requests is how this container gets OOM-killed.
  //  - maximumDiskCacheSize defaults to "50% of free disk measured at startup",
  //    which inside a container reads the HOST disk. The cache is also thrown
  //    away on every deploy (writable layer, no volume), so an unbounded one
  //    buys nothing and can crowd the host.
  //
  // ## Edge caching is NOT free here -- see docs/ section 12.6
  //
  // The optimizer sets `Vary: Accept` unconditionally on every /_next/image
  // response, and Cloudflare's default for a Vary'd response is to skip the
  // cache and report BYPASS. A plain "cache /_next/image*" rule therefore does
  // nothing. It needs the Cache Rules `vary` setting (Cloudflare shipped it
  // 2026-07-02, API-only, works on the free plan) with `accept` normalized
  // over image/avif + image/webp. Without that rule every variant of every
  // image is an origin request.
  images: {
    // AniList's media CDN, and nothing else. Covers, banners, character and
    // voice-actor portraits all live under /file/anilistcdn/. `search: ""`
    // forbids a query string -- omitting it implies `**`, which would let a
    // crafted query turn the optimizer into a proxy for arbitrary AniList
    // responses.
    //
    // Deliberately NOT listed: user avatars. They are served from go-api's
    // volume at /api/avatars/*, and Next resolves a same-origin path through
    // `fetchInternalImage`, a mocked request handled inside the next-app
    // process -- which has no /api route in production (rewrites() returns []
    // there; nginx is what routes /api to go-api). Optimizing an avatar would
    // 404 into FallbackImg's onError and silently show the default card. They
    // stay on plain <img>.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "s4.anilist.co",
        pathname: "/file/anilistcdn/**",
        search: "",
      },
    ],

    formats: ["image/avif", "image/webp"],
    qualities: [75, 85],

    // AniList serves its own covers with a ~31 day max-age; matching it means
    // a variant is re-encoded about as often as the upstream file changes.
    // The effective TTL is max(this, upstream Cache-Control) either way.
    minimumCacheTTL: 2678400, // 31 days

    maximumResponseBody: 8_000_000,
    maximumDiskCacheSize: 500_000_000,
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
