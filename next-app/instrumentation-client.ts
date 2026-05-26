// Next 15.3+ client-side instrumentation entry. Runs after the HTML
// document loads but before React hydration, which is the right moment
// to install error / performance hooks so hydration errors and early
// client crashes are captured.
//
// Sentry recommends this filename over `sentry.client.config.ts` for
// turbopack compatibility (the latter is deprecated as of @sentry/nextjs
// 9+). We're on webpack for now, but using the Next-native convention
// future-proofs us when turbopack stabilises.
//
// Env: NEXT_PUBLIC_SENTRY_DSN (must be public-prefixed so it's bundled
// into the client). DSN-missing = SDK no-ops internally; no manual guard.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  // Session replay: zero baseline cost (no sampling of healthy sessions),
  // 100% capture once an error fires. Keeps the replay quota focused on
  // actionable failures instead of background noise.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
  debug: false,
});

// Required by @sentry/nextjs for App Router navigation spans -- without
// it the SDK logs a warning at startup. Forwards Next's transition events
// to Sentry's app-router routing instrumentation.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
