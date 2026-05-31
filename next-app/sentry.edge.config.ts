// Edge-runtime Sentry init. Loaded from `instrumentation.ts#register`
// when NEXT_RUNTIME === 'edge'. Currently this project has no edge
// routes -- everything runs Node 22 -- but the file is wired up anyway
// so middleware or future edge handlers are covered without another
// integration pass.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  debug: false,
});
