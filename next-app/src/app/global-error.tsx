"use client";

// App Router catches uncaught render errors from the root layout in this
// file. Without it, React rendering exceptions (hydration mismatches,
// throws inside Server Components that escape to the client) never reach
// Sentry. Recommended by @sentry/nextjs for App Router projects -- the
// build emits a warning when this file is missing.
//
// This boundary only fires for errors that escape every other error
// boundary, so the UI here is intentionally minimal -- it's the last
// thing the user sees before a full reload.
import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

interface GlobalErrorProps {
  error: Error & { digest?: string };
}

export default function GlobalError({ error }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body>
        {/* NextError renders the default Next 500 page so the user sees
            *something* coherent instead of a blank screen. */}
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
