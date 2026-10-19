"use client";

// Route-level error boundary for /genre/[slug], as /seasonal and /anime have:
// a throw while this route renders swaps only the page segment instead of
// replacing the whole document with a blank 500.
//
// The body is the shared one (RouteErrorBody), with its generic headline —
// "this page didn't load" is true of a genre page too.

import RouteErrorBody from "@/components/error/RouteErrorBody";

interface GenreErrorProps {
  error: Error & { digest?: string };
}

export default function GenreError({ error }: GenreErrorProps) {
  return <RouteErrorBody error={error} scope="detail" />;
}
