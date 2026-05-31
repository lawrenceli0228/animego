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
  debug: false,
  // Replay intentionally omitted from init. The full replay SDK (~500 kB
  // gzipped) is loaded lazily on first error so it does not bloat the
  // landing-page bundle. replaysSessionSampleRate stays 0 (no background
  // recording); on-error capture is wired below via beforeSend.
  beforeSend(event) {
    if (event.level === "error" || event.level === "fatal") {
      Sentry.lazyLoadIntegration("replayIntegration")
        .then((ReplayIntegration) => {
          Sentry.addIntegration(
            ReplayIntegration({ maskAllText: false, blockAllMedia: false }),
          );
        })
        .catch(() => {});
    }
    return event;
  },
});

// Required by @sentry/nextjs for App Router navigation spans -- without
// it the SDK logs a warning at startup. Forwards Next's transition events
// to Sentry's app-router routing instrumentation.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
