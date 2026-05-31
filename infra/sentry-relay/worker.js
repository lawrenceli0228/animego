// Cloudflare Worker — Sentry relay for go-api (task #13).
//
// WHY: the prod VPS (HK / LucidaCloud) cannot reach sentry.io — the route is
// filtered upstream, so sentry-go's events never leave the box (client-side
// browser Sentry is unaffected, it hits sentry.io directly). This Worker runs
// on Cloudflare's edge, which CAN reach sentry.io, and forwards go-api's
// Sentry envelopes to the real ingest host.
//
//   go-api  --(SENTRY_DSN host = this Worker's domain)-->  CF Worker  -->  sentry.io
//
// go-api needs NO code change — only its SENTRY_DSN host is swapped to point
// here (sentry.Init reads the DSN and derives the ingest URL from its host).
//
// DEPLOY: see README.md in this directory. Bind to a custom domain such as
// sentry-relay.animegoclub.com, then set go-api's SENTRY_DSN host to it.

// The real Sentry ingest host + project id, from the original SENTRY_DSN
// (https://<key>@o4511456470368256.ingest.us.sentry.io/4511456471875584).
const SENTRY_INGEST_HOST = "o4511456470368256.ingest.us.sentry.io";
const ALLOWED_PROJECT_ID = "4511456471875584";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // sentry-go POSTs envelopes to /api/{projectId}/envelope/. Only forward
    // that exact shape for our own project — everything else is 404 so the
    // relay can't be used as a generic open proxy.
    const match = url.pathname.match(/^\/api\/(\d+)\/envelope\/?$/);
    if (
      request.method !== "POST" ||
      !match ||
      match[1] !== ALLOWED_PROJECT_ID
    ) {
      return new Response("Not found", { status: 404 });
    }

    const upstream = `https://${SENTRY_INGEST_HOST}${url.pathname}${url.search}`;
    const resp = await fetch(upstream, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    // Pass Sentry's response straight back so the SDK sees success / 429.
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  },
};
