"use client";

// Route-level error boundary for /person/[id]: a failed render (the API
// unreachable, a chunk that failed to load) swaps the page segment for the
// shared error body and keeps the site chrome. "detail" scope: the headline
// says "this page", which is what this is. See RouteErrorBody for why the
// button reloads rather than resetting.

import RouteErrorBody from "@/components/error/RouteErrorBody";

interface PersonErrorProps {
  error: Error & { digest?: string };
}

export default function PersonError({ error }: PersonErrorProps) {
  return <RouteErrorBody error={error} scope="detail" />;
}
