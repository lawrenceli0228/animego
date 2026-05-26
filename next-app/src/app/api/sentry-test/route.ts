// TEMPORARY — added 2026-05-26 to verify @sentry/nextjs is wired and
// landing events in the dashboard after the P10 lane deploy. Revert
// immediately after the smoke event shows up in Sentry.
//
// `dynamic = "force-dynamic"` so Next doesn't try to statically
// pre-render this route and trip the throw at build time.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  throw new Error("p10 sentry smoke test — delete this route after verify");
}
