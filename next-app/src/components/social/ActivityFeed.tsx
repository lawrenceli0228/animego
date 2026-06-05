"use client";

import Link from "next/link";
import FadeImage from "@/components/ui/FadeImage";
import { useAuthGatedList } from "@/lib/useAuthGatedList";
import type { Dict, Lang } from "@/lib/i18n";
import type { FeedItem } from "@/lib/types";

// Client island activity feed. Was an async RSC that read cookies()
// server-side — that personalized the homepage HTML and blocked edge caching.
// Now it fetches `/api/feed?page=1` on the client, gated on the `auth_hint`
// cookie (see useAuthGatedList): anonymous loads render the CTA stub with zero
// auth requests; authed loads render the feed (empty-state included). The
// homepage shell around it stays anonymous and CF-cacheable.

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
} as const;

const stubListStyle = {
  ...listStyle,
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

const emptyStyle = {
  color: "rgba(235,235,245,0.40)",
  fontSize: 13,
  textAlign: "center" as const,
  padding: "32px 0",
} as const;

const itemRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  borderRadius: 10,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid #38383a",
  color: "inherit",
  textDecoration: "none",
} as const;

const itemCoverStyle = {
  width: 36,
  height: 52,
  flexShrink: 0,
  borderRadius: 4,
  background: "#2c2c2e",
  border: "1px solid #38383a",
  overflow: "hidden",
} as const;

const itemTextWrapStyle = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column" as const,
  gap: 2,
} as const;

const itemLineTopStyle = {
  fontSize: 13,
  color: "#ffffff",
  whiteSpace: "nowrap" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const itemLineBottomStyle = {
  fontSize: 11,
  color: "rgba(235,235,245,0.50)",
} as const;

const itemTimeStyle = {
  fontSize: 11,
  color: "rgba(235,235,245,0.40)",
  flexShrink: 0,
} as const;

function timeAgo(iso: string, lang: Lang): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return lang === "zh" ? "刚刚" : "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return lang === "zh" ? `${m} 分钟前` : `${m}m ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return lang === "zh" ? `${h} 小时前` : `${h}h ago`;
  }
  const d = Math.floor(diff / 86400);
  return lang === "zh" ? `${d} 天前` : `${d}d ago`;
}

function pickFeedTitle(item: FeedItem, lang: Lang): string {
  if (lang === "zh") return item.titleChinese || item.title;
  return item.title || item.titleChinese || `Anime #${item.anilistId}`;
}

function actionLabel(item: FeedItem, lang: Lang): string {
  // Legacy mirrored social.feedActionWatched — keep the same wording so
  // returning users see what they're used to.
  if (lang === "zh") return `${item.username} 看到第 ${item.episode} 集`;
  return `${item.username} watched episode ${item.episode}`;
}

function LoggedOutStub({ dict, lang }: ActivityFeedProps) {
  const copy =
    lang === "zh"
      ? "登录后查看关注的人在追什么"
      : "Login to see what your friends are watching";
  const cta = dict.nav.login;
  const ctaAria = lang === "zh" ? "登录 AnimeGoClub" : "Login to AnimeGoClub";
  return (
    <section style={sectionStyle} aria-label={dict.social.feedTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.social.feedLabel}</p>
        <h2 style={titleStyle}>{dict.social.feedTitle}</h2>
      </div>
      <div style={wrapStyle}>
        <div style={stubListStyle} aria-hidden="true">
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

function FeedList({ items, dict, lang }: { items: FeedItem[]; dict: Dict; lang: Lang }) {
  return (
    <section style={sectionStyle} aria-label={dict.social.feedTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.social.feedLabel}</p>
        <h2 style={titleStyle}>{dict.social.feedTitle}</h2>
      </div>
      {items.length === 0 ? (
        <p style={emptyStyle}>
          {lang === "zh"
            ? "还没动态。关注几个人就有内容了。"
            : "No activity yet. Follow a few people to see updates here."}
        </p>
      ) : (
        <div style={listStyle}>
          {items.map((item) => (
            <Link
              key={`${item.username}-${item.anilistId}-${item.lastWatchedAt}`}
              href={`/anime/${item.anilistId}`}
              style={itemRowStyle}
            >
              <div style={itemCoverStyle}>
                {item.coverImageUrl ? (
                  <FadeImage
                    src={item.coverImageUrl}
                    alt={pickFeedTitle(item, lang)}
                    width={36}
                    height={52}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : null}
              </div>
              <div style={itemTextWrapStyle}>
                <div style={itemLineTopStyle}>{pickFeedTitle(item, lang)}</div>
                <div style={itemLineBottomStyle}>{actionLabel(item, lang)}</div>
              </div>
              <div style={itemTimeStyle}>{timeAgo(item.lastWatchedAt, lang)}</div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// Initial / first-paint state — the neutral blurred rows that land in the
// edge-cached HTML (no overlay, no user data, same for everyone). The client
// swaps it for the stub or the real feed after hydration.
function LoadingSkeleton({ dict }: { dict: Dict }) {
  return (
    <section style={sectionStyle} aria-label={dict.social.feedTitle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.social.feedLabel}</p>
        <h2 style={titleStyle}>{dict.social.feedTitle}</h2>
      </div>
      <div style={wrapStyle}>
        <div style={stubListStyle} aria-hidden="true">
          {Array.from({ length: PLACEHOLDER_ROWS }).map((_, i) => (
            <div key={i} style={placeholderRowStyle}>
              <div style={placeholderCoverStyle} />
              <div style={placeholderTextWideStyle} />
              <div style={placeholderTextNarrowStyle} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function ActivityFeed({ dict, lang }: ActivityFeedProps) {
  // `/api/feed` returns `{ data, hasMore, nextPage }` directly;
  // useAuthGatedList unwraps `data` to FeedItem[]. v1 only shows page 1 (no
  // infinite scroll yet), so the hasMore / nextPage fields are dropped.
  const { status, items } = useAuthGatedList<FeedItem>("/api/feed?page=1");

  if (status === "loading") return <LoadingSkeleton dict={dict} />;
  if (status === "anonymous") return <LoggedOutStub dict={dict} lang={lang} />;
  return <FeedList items={items} dict={dict} lang={lang} />;
}
