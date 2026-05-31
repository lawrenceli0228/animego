import Link from "next/link";
import type { CSSProperties } from "react";
import { getDict, getLang } from "@/lib/i18n";

// Root-level not-found component. Next 16 invokes this when:
//   - A page calls notFound() from next/navigation
//   - A URL doesn't match any route
// At root level it ALSO sets HTTP status to 404 (per-segment not-found.tsx
// only renders the body; only the root one sets the status code). This
// fixes the soft-404 issue where /anime/999999999, /seasonal/badseason/...,
// and other notFound() callers were returning HTTP 200 with the default
// Next not-found body.

type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";

function getCurrentSeason(): Season {
  const m = new Date().getMonth() + 1;
  if (m <= 3) return "WINTER";
  if (m <= 6) return "SPRING";
  if (m <= 9) return "SUMMER";
  return "FALL";
}

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

export default async function NotFound() {
  const [dict, lang] = await Promise.all([getDict(), getLang()]);
  const season = getCurrentSeason();
  const year = new Date().getFullYear();
  const seasonHref = `/seasonal/${season.toLowerCase()}/${year}`;

  const title = lang === "zh" ? "找不到这一页" : "Page not found";
  const desc =
    lang === "zh"
      ? "链接可能错了，或者番剧从我们这边失踪了。回首页或者用搜索看看?"
      : "The link may be wrong, or this anime has slipped off our shelves. Try the homepage or search.";
  const backHome = lang === "zh" ? "回首页" : "Back home";
  const goSearch = dict.nav.search;
  const goSeasonal = lang === "zh" ? "看当季新番" : "Browse seasonal";

  return (
    <main style={s.main}>
      <div style={s.marker}>§04 - NOT FOUND</div>
      <div style={s.number}>404</div>
      <h1 style={s.title}>{title}</h1>
      <p style={s.desc}>{desc}</p>
      <div style={s.actions}>
        <Link href="/" prefetch={false} style={s.btnFill}>
          {backHome}
        </Link>
        <Link href="/search" prefetch={false} style={s.btnOutline}>
          {goSearch}
        </Link>
        <Link href={seasonHref} prefetch={false} style={s.btnOutline}>
          {goSeasonal}
        </Link>
      </div>
      <div style={s.hint}>HTTP 404 / animegoclub.com</div>
    </main>
  );
}
