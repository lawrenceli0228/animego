// Next 15+ server-side instrumentation entry. Next calls `register()`
// exactly once per server boot, before the first request. We dispatch to
// the runtime-specific Sentry init so the Node + edge SDKs each get
// loaded only in the environment they target.
//
// The `onRequestError` hook (also Next 15+) forwards uncaught RSC /
// route-handler / server-action errors to Sentry's `captureRequestError`
// helper, which adds Next-aware breadcrumbs (routerKind, routeType,
// renderSource) that bare `Sentry.captureException` would miss.
import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(err, request, context);
};
