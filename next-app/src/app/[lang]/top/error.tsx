"use client";

// Route-level error boundary for /top and /top/[year], as /genre and /seasonal
// have: a throw while a ranking renders swaps only the page segment instead of
// replacing the whole document with a blank 500.

import RouteErrorBody from "@/components/error/RouteErrorBody";

interface TopErrorProps {
  error: Error & { digest?: string };
}

export default function TopError({ error }: TopErrorProps) {
  return <RouteErrorBody error={error} scope="detail" />;
}
