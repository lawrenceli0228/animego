import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";

// Phase 8.0 placeholder: the social feed needs auth + the Go API
// /api/users/feed endpoint plumbed through the next-app data layer (the
// legacy useFeed() hook reads paginated friend activity). Until Phase 6
// lands auth + the server-side feed loader, this RSC stub renders dummy
// rows + a login CTA so the homepage has 6 sections at cutover.
//
// Phase 6 TODO:
//   - mark as 'use client' (or wrap a client child component)
//   - wire AuthContext (port from client/src/context/AuthContext.jsx)
//   - call apiGet('/api/users/feed') server-side OR via a client hook
//   - render real items (avatar, action verb, title, timeAgo)
//   - keep load-more pagination from legacy useFeed
interface ActivityFeedProps {
  dict: Dict;
  lang: Lang;
}

const PLACEHOLDER_ROWS = 4;

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
  fontSize: "clamp(20px,2.5vw,28px)",
  color: "#ffffff",
} as const;

const wrapStyle = {
  position: "relative" as const,
  borderRadius: 12,
  overflow: "hidden",
  minHeight: 240,
} as const;

const listStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 8,
  filter: "blur(2px)",
  opacity: 0.55,
  pointerEvents: "none" as const,
} as const;

const placeholderRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  borderRadius: 10,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid #38383a",
  height: 64,
} as const;

const placeholderCoverStyle = {
  width: 36,
  height: 52,
  borderRadius: 4,
  background:
    "linear-gradient(180deg, rgba(120,120,128,0.20) 0%, rgba(60,60,67,0.40) 100%)",
  flexShrink: 0,
} as const;

const placeholderTextWideStyle = {
  height: 12,
  borderRadius: 4,
  background: "rgba(235,235,245,0.10)",
  flex: 1,
  maxWidth: 320,
} as const;

const placeholderTextNarrowStyle = {
  height: 10,
  width: 48,
  borderRadius: 4,
  background: "rgba(235,235,245,0.08)",
  flexShrink: 0,
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

export default function ActivityFeed({ dict, lang }: ActivityFeedProps) {
  // Phase 6: replace with real /api/users/feed pagination + auth gate.
  const copy =
    lang === "zh"
      ? "登录后查看关注的人在追什么"
      : "Login to see what your friends are watching";
  const cta = dict.nav.login;
  const ctaAria =
    lang === "zh" ? "登录 AnimeGo" : "Login to AnimeGo";

  return (
    <section style={sectionStyle} aria-label={dict.social.feedTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.social.feedLabel}</p>
        <h2 style={titleStyle}>{dict.social.feedTitle}</h2>
      </div>

      <div style={wrapStyle}>
        {/* Dummy rows mirror the legacy feed item shape (cover + text +
            timestamp). They sit blurred behind the login CTA so the
            section paints something meaningful for LCP. */}
        <div style={listStyle} aria-hidden="true">
          {Array.from({ length: PLACEHOLDER_ROWS }).map((_, i) => (
            <div key={i} style={placeholderRowStyle}>
              <div style={placeholderCoverStyle} />
              <div style={placeholderTextWideStyle} />
              <div style={placeholderTextNarrowStyle} />
            </div>
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
