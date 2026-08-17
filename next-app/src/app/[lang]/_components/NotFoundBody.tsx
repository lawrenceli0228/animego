"use client";

// The visible body of the root 404.
//
// It is a Client Component for one reason: `not-found.tsx` is handed no props
// by Next — not even `params` — so it is the single route file on the site
// that cannot ask resolveLocale() what language it is rendering. See the
// comment in ../not-found.tsx for why the alternatives are worse.
//
// `useLang()` closes that gap without any server-side language lookup: it
// resolves the visitor's own `lang` cookie, so an English reader gets an
// English 404 at every URL on the site rather than a Chinese one.
//
// It is the cookie and not the URL, in practice always. The root loading.tsx
// means the shell has flushed before any page can call notFound(), so this
// body is delivered as a streamed client render — past the point where the
// LanguageProvider has swapped its route-locale seed for the cookie. Do not
// "fix" that by passing a lang prop down from ../not-found.tsx: that file has
// no params either, which is the whole reason this component exists.
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
};

const DESC: Record<Lang, string> = {
  zh: "链接可能错了，或者番剧从我们这边失踪了。回首页或者用搜索看看?",
  en: "The link may be wrong, or this anime has slipped off our shelves. Try the homepage or search.",
};

const BACK_HOME: Record<Lang, string> = {
  zh: "回首页",
  en: "Back home",
};

const GO_SEASONAL: Record<Lang, string> = {
  zh: "看当季新番",
  en: "Browse seasonal",
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
    fontFamily: "'Sora', sans-serif",
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
    fontFamily: "'Sora', sans-serif",
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
