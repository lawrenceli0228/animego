import { getDictByLang } from "@/lib/i18n";
import { type Lang } from "@/lib/i18n/lang";
import NotFoundBody from "./_components/NotFoundBody";

// Root-level not-found component. Next 16 invokes this when:
//   - A page calls notFound() from next/navigation
//   - A URL doesn't match any route
// At root level it ALSO sets HTTP status to 404 (per-segment not-found.tsx
// only renders the body; only the root one sets the status code).
//
// That sentence was WRONG for most of this file's life, and three separate
// documents recorded it as comment rot: a `loading.tsx` above these routes put
// them behind a Suspense boundary, the shell flushed before any page could call
// notFound(), and the status was already committed to 200. /anime/999999999 and
// /seasonal/badseason/2026 answered 200 with a not-found body — a soft 404.
//
// It is true as of 2026-08-28, because the boundary is gone: the root
// loading.tsx was the HOME PAGE's skeleton sitting one directory too high, and
// it now lives in ./(home)/ where it wraps only the page it was written for.
// See ../routeBoundaries.test.ts, which fails if a loading.tsx is ever placed
// above a route that can call notFound() again.
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
//   3. Render the body in a client leaf that calls useLang(). That is
//      ./_components/NotFoundBody.tsx, and it is what ships: it reads the
//      locale without this file needing params of its own.
//
// ── A correction, because the previous version of this note was confident and
//    wrong in two directions at once ──────────────────────────────────────────
//
// It said useLang() "resolves the visitor's own `lang` cookie", and that the
// 404 body therefore rendered client-side in the cookie's language — "/en/nope
// renders Chinese for a visitor with no cookie", labelled "measured".
//
// Neither half holds. @/lib/lang-client has no useEffect, no useState and no
// cookie read anywhere in it; LanguageProvider is a pass-through of the `lang`
// prop and useLang() falls back to deriving the locale from usePathname(). It
// follows the URL, and has for longer than this comment admits. That claim is
// repeated in about a dozen other files and is wrong in all of them — see
// TODOS.md; it is its own cleanup, not a detail of this change.
//
// So /en/nope renders English, and it does so for the ordinary reason — the URL
// says so. Measured in a production build (not `next dev`): /en/anime/{missing}
// serves <html lang="en"> with "Page not found", the bare path serves zh-CN with
// "找不到这一页", and the console reports no hydration mismatch.
//
// ── What removing the boundary did and did not change ──────────────────────
//
// It changed the status, which was the point: Next returns "200 for streamed
// responses, and 404 for non-streamed responses" (same docs file as above,
// under `not-found.js`). No loading.tsx above the route means nothing flushes
// early, so the response is non-streamed and the status is a real 404.
//
// It did NOT put this body into the first HTML chunk. Measured on a production
// build, a 404 response's <body> is an empty Suspense placeholder and the UI
// arrives in the RSC payload; the browser then renders it in full. Before the
// change the initial HTML at least carried the layout shell, because that is
// exactly what the loading.tsx had flushed. So the served bytes got emptier
// while the status got correct.
//
// That trade is fine, and deliberately not "fixed" here: a 404's body is not
// indexed — the status settles it, and Next injects its own noindex on top
// (docs, same file). A reader with JavaScript sees the whole page. What must
// not silently regress is that last part, so it is asserted in a browser in
// e2e/specs/sandbox/not-found-status.spec.ts rather than by reading the HTML.
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
    "zh-Hant": getDictByLang("zh-Hant").nav.search,
  };

  return (
    <NotFoundBody
      seasonHref={`/seasonal/${season.toLowerCase()}/${year}`}
      searchLabel={searchLabel}
    />
  );
}
