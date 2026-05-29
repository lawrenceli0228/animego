import Link from "next/link";
import { ApiError, apiGet } from "@/lib/api";
import { pickTitle } from "@/lib/formatters";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict, Lang } from "@/lib/i18n";
import type { WatchingItem } from "@/lib/types";

// RSC ContinueWatching. Server-side tries
// `/api/subscriptions?status=watching`. 401 → render the logged-out
// CTA stub. Authed-with-zero-rows → hide the section entirely (matches
// legacy ContinueWatching.jsx: `if (!user || !list?.length) return null`
// becomes "show stub when no auth, hide when authed-but-empty" — a
// homepage with the CTA still makes sense for new visitors).
//
// Cookie forwarding via lib/api.ts buildHeaders() — same path the
// ActivityFeed sibling uses. Both rely on P8.1 cookie dual-track
// (commit cc073f9).

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

const wrapStyle = {
  position: "relative" as const,
  borderRadius: 12,
  overflow: "hidden",
  minHeight: 240,
} as const;

const stubGridStyle = {
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

const realGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 16,
} as const;

const cardLinkStyle = {
  textDecoration: "none",
  color: "inherit",
  borderRadius: 12,
  overflow: "hidden",
  display: "block",
} as const;

const cardInnerStyle = {
  position: "relative" as const,
} as const;

const cardImgStyle = {
  width: "100%",
  aspectRatio: "3/4",
  objectFit: "cover" as const,
  display: "block",
  background: "#2c2c2e",
} as const;

const epBadgeStyle = {
  position: "absolute" as const,
  top: 6,
  right: 6,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(4px)",
  borderRadius: 6,
  padding: "2px 6px",
  fontSize: 11,
  fontWeight: 600,
  color: "#0a84ff",
} as const;

const cardOverlayStyle = {
  position: "absolute" as const,
  bottom: 0,
  left: 0,
  right: 0,
  padding: "24px 8px 6px",
  background:
    "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)",
} as const;

const cardTitleStyle = {
  fontFamily: "'Sora',sans-serif",
  fontSize: 12,
  fontWeight: 600,
  color: "#ffffff",
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical" as const,
  lineHeight: 1.35,
  marginBottom: 5,
  textShadow: "0 1px 3px rgba(0,0,0,0.5)",
} as const;

const progressTrackStyle = {
  height: 3,
  borderRadius: 1.5,
  background: "rgba(255,255,255,0.15)",
} as const;

function progressFillStyle(currentEpisode: number, episodes: number | null) {
  const pct = episodes && episodes > 0
    ? Math.min(100, (currentEpisode / episodes) * 100)
    : 0;
  return {
    height: "100%",
    borderRadius: 1.5,
    width: `${pct}%`,
    background: "#0a84ff",
  } as const;
}

function badgeText(item: WatchingItem, dict: Dict, lang: Lang): string {
  const epUnit = dict.detail.epUnit;
  if (item.currentEpisode > 0) {
    if (item.episodes && item.episodes > 0) {
      return `${item.currentEpisode}/${item.episodes} ${epUnit}`;
    }
    return `${item.currentEpisode} ${epUnit}`;
  }
  if (item.episodes && item.episodes > 0) {
    return `${item.episodes} ${epUnit}`;
  }
  return lang === "zh" ? "在追" : "Watching";
}

function LoggedOutStub({ dict, lang }: ContinueWatchingProps) {
  const copy =
    lang === "zh"
      ? "登录后追番进度会出现在这里"
      : "Login to track your watching progress";
  const cta = dict.nav.login;
  const ctaAria = lang === "zh" ? "登录 AnimeGo" : "Login to AnimeGo";
  return (
    <section style={sectionStyle} aria-label={dict.home.watchingTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.home.continueLabel}</p>
        <h2 style={titleStyle}>{dict.home.watchingTitle}</h2>
      </div>
      <div style={wrapStyle}>
        <div style={stubGridStyle} aria-hidden="true">
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

function WatchingGrid({
  items,
  dict,
  lang,
}: {
  items: WatchingItem[];
  dict: Dict;
  lang: Lang;
}) {
  return (
    <section style={sectionStyle} aria-label={dict.home.watchingTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.home.continueLabel}</p>
        <h2 style={titleStyle}>{dict.home.watchingTitle}</h2>
      </div>
      <div style={realGridStyle}>
        {items.map((item) => (
          <Link
            key={item.anilistId}
            href={`/anime/${item.anilistId}`}
            style={cardLinkStyle}
          >
            <div style={cardInnerStyle}>
              {item.coverImageUrl ? (
                <FadeImage
                  src={item.coverImageUrl}
                  alt={pickTitle(item, lang)}
                  style={cardImgStyle}
                />
              ) : (
                <div style={{ ...cardImgStyle, background: "#2c2c2e" }} />
              )}
              <div style={epBadgeStyle}>{badgeText(item, dict, lang)}</div>
              <div style={cardOverlayStyle}>
                <div style={cardTitleStyle}>{pickTitle(item, lang)}</div>
                {item.episodes && item.episodes > 0 ? (
                  <div style={progressTrackStyle}>
                    <div
                      style={progressFillStyle(item.currentEpisode, item.episodes)}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function ContinueWatching({
  dict,
  lang,
}: ContinueWatchingProps) {
  let items: WatchingItem[] = [];
  let loggedOut = false;
  try {
    items = await apiGet<WatchingItem[]>(
      "/api/subscriptions?status=watching",
      { cache: "no-store" },
    );
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      loggedOut = true;
    } else {
      loggedOut = true;
    }
  }

  if (loggedOut) {
    return <LoggedOutStub dict={dict} lang={lang} />;
  }
  // Authed but nothing in this bucket — hide the section entirely.
  // Matches legacy ContinueWatching.jsx: `if (!list?.length) return null`.
  if (items.length === 0) return null;
  return <WatchingGrid items={items} dict={dict} lang={lang} />;
}
