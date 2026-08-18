import { getDictByLang } from "@/lib/i18n";
import { type Lang } from "@/lib/i18n/lang";
import NotFoundBody from "./_components/NotFoundBody";

// Root-level not-found component. Next 16 invokes this when:
//   - A page calls notFound() from next/navigation
//   - A URL doesn't match any route
// At root level it ALSO sets HTTP status to 404 (per-segment not-found.tsx
// only renders the body; only the root one sets the status code). This
// fixes the soft-404 issue where /anime/999999999, /seasonal/badseason/...,
// and other notFound() callers were returning HTTP 200 with the default
// Next not-found body.
//
// ── Why this one route file does not call resolveLocale() ──────────────────
//
// Every other page and layout under app/[lang]/ takes its language from the
// route param. This one cannot: Next passes not-found.js NO props at all —
// "not-found.js or global-not-found.js components do not accept any props"
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// not-found.md). There is no `params` to resolve, and no supported way to ask
// for one.
//
// The three ways out, and why this is the one:
//
//   1. Read the `lang` cookie with cookies(). Rejected outright. not-found
//      renders INSIDE the segment that threw notFound(), so a Dynamic API here
//      forces that segment dynamic — including /anime/[id], which is the whole
//      edge-cached SEO surface. A 404 body is not worth trading ISR for.
//   2. Hardcode the default language. Then every English reader gets a Chinese
//      404 at every URL, bare or prefixed.
//   3. Render the body in a client leaf that calls useLang(), which resolves
//      the visitor's own `lang` cookie. That is ./_components/NotFoundBody.tsx,
//      and it is what ships: an English reader gets an English 404 on ANY URL,
//      which is strictly more than (2) ever offers.
//
// What (3) does NOT do — measured, not assumed. The root ./loading.tsx puts
// every route behind a Suspense boundary, so by the time a page calls
// notFound() the shell has already flushed and Next can only deliver the 404 as
// an error in the RSC stream (`NEXT_HTTP_ERROR_FALLBACK;404`). The body is
// therefore rendered on the CLIENT, after the LanguageProvider's effect has
// already replaced the route-locale seed with the cookie. So the language here
// is the cookie's, never the URL's: /en/nope renders Chinese for a visitor with
// no cookie. Verified in a browser against a production build.
//
// That is the site-wide URL-vs-cookie split showing up at its sharpest, not
// something specific to this file — see the note beside SeasonalFilterChips in
// ./seasonal/[season]/[year]/page.tsx. Fixing it here alone is not possible and
// would not be right; it is one decision for the whole client layer.
//
// Everything order-dependent stays here on the server, where there is exactly
// one clock: the seasonal href below is computed from it and passed down,
// rather than being derived in the client component where the visitor's
// timezone could put it in a different season than the server's.
//
// Worth knowing for later: Next documents `global-not-found.js` as the
// intended answer for precisely this shape — "your root layout is defined
// using top-level dynamic segments ... which makes composing a consistent 404
// page harder". It is experimental, needs `experimental.globalNotFound`, and
// must ship its own <html>, fonts and global CSS, so adopting it is its own
// change rather than a detail of this one.

type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";

function getCurrentSeason(): Season {
  const m = new Date().getMonth() + 1;
  if (m <= 3) return "WINTER";
  if (m <= 6) return "SPRING";
  if (m <= 9) return "SUMMER";
  return "FALL";
}

export default function NotFound() {
  const season = getCurrentSeason();
  const year = new Date().getFullYear();

  // Resolved from the server dictionaries, not the client -spa copies. The
  // two have drifted before (a missing key renders as the key itself, with no
  // error and no warning), and this is the one page a visitor reaches when
  // something has already gone wrong. Typed as Record<Lang, string> so a third
  // language fails the build here rather than rendering "nav.search".
  const searchLabel: Record<Lang, string> = {
    zh: getDictByLang("zh").nav.search,
    en: getDictByLang("en").nav.search,
  };

  return (
    <NotFoundBody
      seasonHref={`/seasonal/${season.toLowerCase()}/${year}`}
      searchLabel={searchLabel}
    />
  );
}
