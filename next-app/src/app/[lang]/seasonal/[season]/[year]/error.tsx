"use client";

// Route-level error boundary for /seasonal/[season]/[year].
//
// Without one, a throw inside this route's server render bubbles to the root
// and replaces the whole document with a blank 500. That was Sentry issue
// JAVASCRIPT-NEXTJS-2: 15 full-page crashes on /seasonal/summer/2026, with
// visitors retrying two or three times and giving up. With the boundary, only
// the page segment swaps.
//
// The body is shared with /anime/[id] — see RouteErrorBody, including why the
// retry button is a full reload rather than `reset()` or `unstable_retry()`.
//
// `reset` is deliberately not taken; Next still passes it.

import RouteErrorBody from "@/components/error/RouteErrorBody";

interface SeasonalErrorProps {
  error: Error & { digest?: string };
}

export default function SeasonalError({ error }: SeasonalErrorProps) {
  return <RouteErrorBody error={error} scope="seasonal" />;
}
