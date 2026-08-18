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
import { DENIED_URL_PATTERNS, IGNORED_ERROR_PATTERNS } from "@/lib/sentryFilters";

// One attempt per page load. See beforeSend.
let replayRequested = false;

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  debug: false,

  // Errors are reported at 100% — `tracesSampleRate` above governs tracing
  // only. Worth stating because the `client_sample_rate: 0.1` that appears in
  // every event's trace context reads like an error sample rate and is not
  // one; multiplying issue counts by ten gives a number ten times too big.

  // Injected third-party scripts, mostly from in-app WebViews. Rationale for
  // each pattern lives in lib/sentryFilters.ts, next to the tests that pin
  // them to the exact strings Sentry reported.
  //
  // These matter beyond quota. EventFilters runs as an event processor, which
  // @sentry/core resolves BEFORE beforeSend (client.js `_processEvent`), so a
  // filtered error never reaches the Replay block below and never triggers its
  // download. Before this, an extension's syntax error on someone's phone
  // pulled half a megabyte of Replay SDK onto that phone — 88 times.
  ignoreErrors: IGNORED_ERROR_PATTERNS,
  denyUrls: DENIED_URL_PATTERNS,

  // Replay intentionally omitted from init. The full replay SDK (~500 kB
  // gzipped) is loaded lazily on first error so it does not bloat the
  // landing-page bundle. replaysSessionSampleRate stays 0 (no background
  // recording); on-error capture is wired below.
  //
  // ⚠️ Neither `replaysSessionSampleRate` nor `replaysOnErrorSampleRate` is
  // set, and on-error capture needs the latter above 0. Until one is
  // configured this download most likely records nothing. Left as-is rather
  // than removed or enabled: turning it on starts uploading session
  // recordings of real users, which is a privacy and quota decision, not a
  // cleanup. Decide, then either set a rate or delete the block.
  beforeSend(event) {
    // Guarded, and deliberately not reset on failure. lazyLoadIntegration
    // fetches from https://browser.sentry-cdn.com, and this site's users are
    // overwhelmingly in mainland China, where that origin is not dependable.
    // Retrying per error would mean a stream of failing script tags on
    // exactly the sessions already going badly.
    if (!replayRequested && (event.level === "error" || event.level === "fatal")) {
      replayRequested = true;
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
