"use client";

// Route-level error boundary for /anime/[id].
//
// It exists so a throw inside this route swaps the page segment instead of the
// whole document: the Navbar and layout chrome stay, and the visitor gets a
// coherent surface rather than the bare "Internal Server Error" this route used
// to answer with when loadDetail() hit a transient upstream failure — go-api
// returning 502 "AniList upstream error" while AniList rate-limits us during an
// SEO crawl, or a 429 from go-api's own inbound limiter.
//
// That is why it was written. It is not the failure it mostly catches: the 17
// events on Sentry JAVASCRIPT-NEXTJS-N are client-side module-resolution
// TypeErrors, all on this route. The copy and the retry button both used to be
// written for the upstream story alone, and both were wrong for the common
// case — see the note in RouteErrorBody, which is where the body now lives and
// where that evidence is recorded.
//
// `reset` is deliberately not taken. Next still passes it; using it is what
// made the retry button a no-op on the client-side failure.

import RouteErrorBody from "@/components/error/RouteErrorBody";

interface DetailErrorProps {
  error: Error & { digest?: string };
}

export default function DetailError({ error }: DetailErrorProps) {
  return <RouteErrorBody error={error} scope="detail" />;
}
