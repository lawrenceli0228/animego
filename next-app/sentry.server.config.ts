// Server-runtime Sentry init. Loaded from `instrumentation.ts#register`
// when NEXT_RUNTIME === 'nodejs'. SDK no-ops automatically when DSN is
// empty (Sentry's internal init checks for falsy DSN), so no manual guard
// is needed -- DSN-missing is the default state during local dev.
//
// Env: SENTRY_DSN (server, secret). Sample rates are intentionally low
// (10% traces, 0% replay session, 100% replay-on-error) to keep cost
// down on the free tier. Replay only exists on the client; the values
// below are inert on the server but kept here as a single source of
// truth -- the client config mirrors them.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // 10% of transactions get full performance traces. Drop to 0 if quota
  // pressure becomes a problem; errors are always captured at 100%.
  tracesSampleRate: 0.1,
  // Verbose SDK logs are noisy in prod logs; flip on temporarily when
  // debugging an integration issue.
  debug: false,
});
