"use client";

// The visible body of the root 404.
//
// It is a Client Component for one reason: `not-found.tsx` is handed no props
// by Next — not even `params` — so it is the single route file on the site
// that cannot ask resolveLocale() what language it is rendering. See the
// comment in ../not-found.tsx for why the alternatives are worse.
//
// `useLang()` closes that gap without a server-side language lookup here: it
// reads the LanguageProvider's value, and falls back to deriving the locale
// from usePathname() when the provider is out of reach. Either way the answer
// comes from the URL, so /en/nope renders English.
//
// It says the URL and not the cookie deliberately, because the previous version
// of this comment said the opposite — "it is the cookie and not the URL, in
// practice always" — and described a LanguageProvider effect that swaps the
// route locale for the cookie after mount. There is no such effect;
// @/lib/lang-client contains no useEffect, no useState and no cookie read at
// all. The same wrong claim is repeated in about a dozen other files; see
// TODOS.md.
//
// Do not "fix" the params gap by passing a lang prop down from
// ../not-found.tsx: that file is handed no params either, which is the whole
// reason this component exists. That part of the old note was right.
//
// This body now renders on the SERVER, with a real 404 status. It used to
// arrive as a client render inside an already-committed 200, because a
// loading.tsx sat above every route; that boundary is gone (see
// ../../routeBoundaries.test.ts). "use client" stays because the params
// problem above is unchanged — the component is still the only way this route
// learns its locale.
//
// Everything that must not differ between the server render and the hydrated
// one arrives as a prop: `seasonHref` is built from the server's clock, since
// computing it here would read the visitor's timezone and disagree with the
// server across a month or year boundary. The search label arrives from the
// real server dictionaries rather than being looked up in the -spa copy,
// because those two have drifted before and a 404 page is a bad place to
// discover it again.

import Link from "@/components/ui/LocaleLink";
import type { CSSProperties } from "react";
import { useLang } from "@/lib/lang-client";
import { type Lang } from "@/lib/i18n/lang";

// Per-language tables rather than `lang === "zh" ? … : …`. Same rendered
// strings; the difference is that a third language becomes a compile error
// here instead of silently resolving to the English arm of a ternary.
const TITLE: Record<Lang, string> = {
  zh: "找不到这一页",
  en: "Page not found",
  "zh-Hant": "找不到這一頁",
};

const DESC: Record<Lang, string> = {
  zh: "链接可能错了，或者番剧从我们这边失踪了。回首页或者用搜索看看?",
  en: "The link may be wrong, or this anime has slipped off our shelves. Try the homepage or search.",
  "zh-Hant": "連結可能錯了，或者番劇從我們這邊失蹤了。回首頁或者用搜尋看看?",
};

const BACK_HOME: Record<Lang, string> = {
  zh: "回首页",
  en: "Back home",
  "zh-Hant": "回首頁",
};

const GO_SEASONAL: Record<Lang, string> = {
  zh: "看当季新番",
  en: "Browse seasonal",
  "zh-Hant": "看當季新番",
};

const s = {
  main: {
    minHeight: "calc(100vh - 280px)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "80px 24px",
    textAlign: "center",
  } as CSSProperties,
  marker: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: "0.18em",
    color: "rgba(235,235,245,0.30)",
    textTransform: "uppercase",
    marginBottom: 16,
  } as CSSProperties,
  number: {
    fontFamily: "var(--font-display)",
    fontSize: "clamp(5rem, 4rem + 8vw, 9rem)",
    fontWeight: 800,
    letterSpacing: "-0.04em",
    lineHeight: 0.9,
    background:
      "linear-gradient(135deg, #ffffff 0%, oklch(78% 0.14 210) 60%, oklch(72% 0.18 195) 100%)",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
    color: "transparent",
    marginBottom: 16,
  } as CSSProperties,
  title: {
    fontFamily: "var(--font-display)",
    fontSize: "clamp(1.5rem, 1rem + 1.8vw, 2rem)",
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.02em",
    marginBottom: 12,
  } as CSSProperties,
  desc: {
    fontSize: 15,
    color: "rgba(235,235,245,0.60)",
    lineHeight: 1.6,
    maxWidth: 480,
    marginBottom: 36,
  } as CSSProperties,
  actions: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap" as const,
    justifyContent: "center",
  },
  btnFill: {
    padding: "10px 22px",
    borderRadius: 8,
    background: "#0a84ff",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    border: "none",
    textDecoration: "none",
    transition: "background 150ms",
  } as CSSProperties,
  btnOutline: {
    padding: "10px 22px",
    borderRadius: 8,
    border: "1px solid rgba(120,120,140,0.45)",
    color: "rgba(235,235,245,0.85)",
    fontSize: 14,
    fontWeight: 500,
    background: "transparent",
    textDecoration: "none",
    transition: "border-color 150ms, color 150ms",
  } as CSSProperties,
  hint: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: "rgba(235,235,245,0.30)",
    marginTop: 32,
    letterSpacing: "0.04em",
  } as CSSProperties,
};

interface NotFoundBodyProps {
  /** Built from the server's clock — see the note at the top of this file. */
  seasonHref: string;
  /** `nav.search` from each server dictionary, keyed by language. */
  searchLabel: Record<Lang, string>;
}

export default function NotFoundBody({
  seasonHref,
  searchLabel,
}: NotFoundBodyProps) {
  const { lang } = useLang();

  return (
    <main style={s.main}>
      <div style={s.marker}>§04 - NOT FOUND</div>
      <div style={s.number}>404</div>
      <h1 style={s.title}>{TITLE[lang]}</h1>
      <p style={s.desc}>{DESC[lang]}</p>
      <div style={s.actions}>
        <Link href="/" prefetch={false} style={s.btnFill}>
          {BACK_HOME[lang]}
        </Link>
        <Link href="/search" prefetch={false} style={s.btnOutline}>
          {searchLabel[lang]}
        </Link>
        <Link href={seasonHref} prefetch={false} style={s.btnOutline}>
          {GO_SEASONAL[lang]}
        </Link>
      </div>
      <div style={s.hint}>HTTP 404 / animegoclub.com</div>
    </main>
  );
}
