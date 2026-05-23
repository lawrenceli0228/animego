import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";

// Phase 8.0 placeholder: this section needs auth + client-side Dexie/IndexedDB
// progress reads (legacy useSubscriptions('watching')) that have not yet been
// ported. We render an RSC stub so the homepage has 6 sections at cutover and
// LCP measurements have above-the-fold content. No 'use client' on purpose --
// Phase 6 will swap this for an auth-aware client component backed by Dexie.
//
// Phase 6 TODO:
//   - mark as 'use client'
//   - wire AuthContext (port from client/src/context/AuthContext.jsx)
//   - read library/progress from Dexie (port from client/src/db/library.ts)
//   - hide the placeholder when an authed user has zero watching entries
//   - render real cards via AnimeCard (cover, ep progress, title)
interface ContinueWatchingProps {
  dict: Dict;
  lang: Lang;
}

const PLACEHOLDER_COUNT = 4;

const sectionStyle = { marginTop: 40 } as const;

const headerStyle = { marginBottom: 16 } as const;

const labelStyle = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase" as const,
  marginBottom: 8,
} as const;

const titleStyle = {
  fontSize: "clamp(22px,3vw,32px)",
  color: "#ffffff",
} as const;

// Outer wrap is relative so the CTA overlay can position-absolute over the
// dummy poster grid. min-height keeps the section paint stable when the grid
// content is just placeholder boxes.
const wrapStyle = {
  position: "relative" as const,
  borderRadius: 12,
  overflow: "hidden",
  minHeight: 240,
} as const;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 16,
  filter: "blur(2px)",
  opacity: 0.55,
  pointerEvents: "none" as const,
} as const;

const placeholderCardStyle = {
  aspectRatio: "3/4",
  borderRadius: 12,
  background:
    "linear-gradient(180deg, rgba(120,120,128,0.18) 0%, rgba(28,28,30,0.95) 100%)",
  border: "1px solid #38383a",
} as const;

const overlayStyle = {
  position: "absolute" as const,
  inset: 0,
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  textAlign: "center" as const,
  background:
    "radial-gradient(ellipse at center, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 70%, transparent 100%)",
  padding: "24px 16px",
} as const;

const overlayCopyStyle = {
  color: "rgba(235,235,245,0.85)",
  fontSize: 14,
  fontWeight: 500,
  maxWidth: 360,
  lineHeight: 1.5,
} as const;

const ctaStyle = {
  display: "inline-block",
  padding: "10px 22px",
  borderRadius: 8,
  background: "#0a84ff",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  letterSpacing: "0.5px",
} as const;

export default function ContinueWatching({
  dict,
  lang,
}: ContinueWatchingProps) {
  // Phase 6: replace with real Dexie-backed list once auth + library land.
  const copy =
    lang === "zh"
      ? "登录后追番进度会出现在这里"
      : "Login to track your watching progress";
  const cta = dict.nav.login;
  const ctaAria =
    lang === "zh" ? "登录 AnimeGo" : "Login to AnimeGo";

  return (
    <section style={sectionStyle} aria-label={dict.home.watchingTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.home.continueLabel}</p>
        <h2 style={titleStyle}>{dict.home.watchingTitle}</h2>
      </div>

      <div style={wrapStyle}>
        {/* Dummy poster grid keeps LCP non-empty until Phase 6 ports the
            real Dexie-backed list. The grid is blurred + dimmed so it
            reads as a backdrop behind the login CTA. */}
        <div style={gridStyle} aria-hidden="true">
          {Array.from({ length: PLACEHOLDER_COUNT }).map((_, i) => (
            <div key={i} style={placeholderCardStyle} />
          ))}
        </div>

        <div style={overlayStyle}>
          <p style={overlayCopyStyle}>{copy}</p>
          <Link href="/login" aria-label={ctaAria} style={ctaStyle}>
            {cta}
          </Link>
        </div>
      </div>
    </section>
  );
}
