"use client";

// The one body behind every route-level error boundary.
//
// It replaced two files — app/[lang]/anime/[id]/error.tsx and
// app/[lang]/seasonal/[season]/[year]/error.tsx — that were the same 120 lines
// twice over, differing only in one noun inside one sentence. Both had drifted
// into being wrong in the same two ways, which is the usual argument for
// keeping one copy: a fix applied to one of them would have left the other.
//
// ── What was wrong, and what the evidence was ─────────────────────────────
//
// 1. The copy blamed the upstream. It read "可能是上游数据源一时繁忙" —
//    the data source is busy — and that is not what visitors were hitting.
//    Every one of the 17 events on Sentry JAVASCRIPT-NEXTJS-N between
//    2026-08-07 and 2026-08-30 is a CLIENT-side TypeError:
//
//      Cannot read properties of undefined (reading 'call')
//        at __webpack_require__  (webpack-<hash>.js:1:144)
//
//    thrown while React resolves a client module during render, with
//    `handled: yes` — caught right here. Nothing upstream is involved. The
//    sentence named a cause the page could not know, and named the wrong one.
//
//    The boundary does also catch the failure it was originally written for
//    (loadDetail() throwing on a go-api 502 while AniList rate-limits an SEO
//    crawl), so the copy cannot swing to blaming the browser either. It now
//    says what is true for both — that this did not load — and then says the
//    thing that actually works.
//
// 2. The retry button could not fix the error it was most often shown for.
//    It called `reset()`, which Next documents as clearing the error state and
//    re-rendering the children "without re-fetching the contents"
//    (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
//    error.md, under `reset`). Re-rendering the same tree over the same broken
//    module graph reproduces the same TypeError, so the visible behaviour of
//    "重试" on the client-side failure was: nothing changes. The Sentry bursts
//    are consistent with that — 3 events in 47 seconds on 2026-08-30, on three
//    different anime, ending when the visitor gave up rather than when
//    anything recovered.
//
// ── Why the button is a full reload, and not `unstable_retry()` ───────────
//
// Next 16.2 added `unstable_retry`, and the same docs page says to prefer it
// over `reset()` in most cases: it re-FETCHES and re-renders, so it does fix
// the transient-upstream case properly. It is still not the right primary
// action here, because it reuses the JavaScript already in the page. When the
// failure is a module missing from `__webpack_modules__`, re-fetching the RSC
// payload hands the same module ids to the same runtime and fails again.
//
// A full document load is the only action that clears BOTH classes: the
// server-side blip gets a new request, and the client-side one gets a new
// module graph. It costs one page load, and on /anime/* that is an ISR page
// behind Cloudflare, so it is close to free. One button that always works
// beats two buttons that each work half the time.
//
// If a soft retry is ever wanted back, `unstable_retry` is the prop to take —
// NOT `reset`. Escalating (soft first, hard on the second click) needs state
// that survives a failed retry, and whether this component keeps its state
// across one is unverified; do not assume it does.

import * as Sentry from "@sentry/nextjs";
import { useEffect, type CSSProperties } from "react";

import Link from "@/components/ui/LocaleLink";
import { type Lang } from "@/lib/i18n/lang";
import { useLang } from "@/lib/lang-client";

/**
 * Which route is apologising. Only the headline changes; everything else is
 * shared, because everything else is true of any route that failed to render.
 */
export type ErrorScope = "detail" | "seasonal";

// Per-language tables rather than dictionary lookups, following
// app/[lang]/_components/NotFoundBody.tsx — the site's other "something has
// already gone wrong" surface, which chose the same thing for the same reason.
//
// t() returns the KEY ITSELF on a miss, silently (see lib/i18n.ts), so a copy
// key that reaches only zh-spa.js renders as `errors.routeErrorTitle` in the
// browser. spaDictCoverage.test.ts is the gate against that, and it is a test
// somebody has to run. A Record<Lang, string> is a compile error instead, and
// an error page is the worst place on the site to discover a missing key.
//
// The cost is real and worth naming: these strings are not where a translator
// looks. Two surfaces is the whole exception, and it stops here.
export const TITLE: Record<ErrorScope, Record<Lang, string>> = {
  detail: {
    zh: "这一页没能加载出来",
    // Curly apostrophe, not "didn't". React escapes a straight one to &#x27;
    // in the rendered HTML — invisible to a reader, and a trap for any test
    // that asserts on markup; the first version of the suite failed on exactly
    // that. U+2019 is also the correct typography.
    en: "This page didn’t load",
    "zh-Hant": "這一頁沒能載入",
  },
  seasonal: {
    zh: "这一季的番剧没能加载出来",
    en: "This season didn’t load",
    "zh-Hant": "這一季的番劇沒能載入",
  },
};

export const BODY: Record<Lang, string> = {
  zh: "刷新一次通常就好。如果还是不行，过一会儿再来，或者先回首页看看别的。",
  en: "Reloading usually fixes it. If it keeps happening, try again in a bit, or head back to the homepage.",
  "zh-Hant": "重新整理一次通常就好。如果還是不行，等一下再試試，或者先回首頁看看別的。",
};

export const RELOAD: Record<Lang, string> = {
  zh: "刷新页面",
  en: "Reload",
  "zh-Hant": "重新整理",
};

export const BACK_HOME: Record<Lang, string> = {
  zh: "回首页",
  en: "Back home",
  "zh-Hant": "回首頁",
};

const s = {
  card: {
    maxWidth: 460,
    margin: "0 auto",
    padding: "56px 24px 80px",
    textAlign: "center",
  } as CSSProperties,
  glyph: { fontSize: 40, marginBottom: 16 } as CSSProperties,
  title: {
    fontFamily: "var(--font-display)",
    fontSize: 22,
    color: "#ffffff",
    marginBottom: 10,
    lineHeight: 1.3,
  } as CSSProperties,
  body: {
    color: "rgba(235,235,245,0.60)",
    fontSize: 14,
    lineHeight: 1.7,
    marginBottom: 28,
  } as CSSProperties,
  actions: {
    display: "flex",
    gap: 12,
    justifyContent: "center",
    flexWrap: "wrap",
  } as CSSProperties,
  primaryBtn: {
    padding: "10px 22px",
    borderRadius: 10,
    border: "none",
    background: "#0a84ff",
    color: "#fff",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  } as CSSProperties,
  secondaryBtn: {
    padding: "10px 22px",
    borderRadius: 10,
    border: "1px solid rgba(84,84,88,0.65)",
    background: "transparent",
    color: "rgba(235,235,245,0.75)",
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
  } as CSSProperties,
  digest: {
    marginTop: 24,
    color: "rgba(235,235,245,0.25)",
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
  } as CSSProperties,
};

interface RouteErrorBodyProps {
  error: Error & { digest?: string };
  scope: ErrorScope;
}

export default function RouteErrorBody({ error, scope }: RouteErrorBodyProps) {
  const { lang } = useLang();

  // Sentry has to be told explicitly. An error.tsx boundary swallows the error
  // before the SDK's global handlers ever see it, so without this call a
  // regression in either route would be invisible — and this issue is only
  // known at all because the two files it replaced each made this call.
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="container" style={s.card}>
      <div style={s.glyph} aria-hidden="true">
        🌥️
      </div>
      <h1 style={s.title}>{TITLE[scope][lang]}</h1>
      <p style={s.body}>{BODY[lang]}</p>
      <div style={s.actions}>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={s.primaryBtn}
        >
          {RELOAD[lang]}
        </button>
        <Link href="/" prefetch={false} style={s.secondaryBtn}>
          {BACK_HOME[lang]}
        </Link>
      </div>
      {error.digest && <p style={s.digest}>{error.digest}</p>}
    </main>
  );
}
