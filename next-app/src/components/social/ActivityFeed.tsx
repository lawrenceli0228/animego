import Link from "next/link";
import FadeImage from "@/components/ui/FadeImage";
import { ApiError, apiGet } from "@/lib/api";
import type { Dict, Lang } from "@/lib/i18n";
import type { FeedItem, FeedResponse } from "@/lib/types";

// RSC activity feed. Server-side tries `/api/feed?page=1`; Express
// returns 401 if the session cookie is missing/invalid, which we treat
// as "render the logged-out CTA stub". A successful fetch with zero
// items still renders the section header so the page reserves space
// (better LCP than a sudden post-hydrate insertion).
//
// Cookie forwarding: lib/api.ts buildHeaders() pulls next/headers
// cookies() in the RSC context and forwards as Cookie: ...; Express
// auth middleware reads `req.cookies.session` and verifies the JWT.
// This relies on the P8.1 cookie dual-track commit cc073f9.

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

export default async function ActivityFeed({ dict, lang }: ActivityFeedProps) {
  // The Express envelope here is unusual: the response body is
  // `{data, hasMore, nextPage}` directly (not wrapped in another
  // `{data: ...}` layer), so apiGet's `env.data` unwrap returns the
  // items array directly — but the `hasMore` / `nextPage` fields are
  // lost in the cast. v1 only shows page 1 (no infinite scroll yet),
  // so dropping them is fine.
  let items: FeedItem[] = [];
  let loggedOut = false;
  try {
    const resp = await apiGet<FeedResponse>("/api/feed?page=1", { cache: "no-store" });
    items = resp.data ?? [];
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      loggedOut = true;
    } else {
      // Network blip / server 500 — render the stub so the page doesn't
      // explode. Treating this as "logged out" is a UX compromise: a
      // logged-in user with a flaky backend sees the login CTA instead
      // of a spinner. Better than a hard 500 page; revisit when the
      // observability lane reports real failure rates.
      loggedOut = true;
    }
  }

  if (loggedOut) {
    return <LoggedOutStub dict={dict} lang={lang} />;
  }
  return <FeedList items={items} dict={dict} lang={lang} />;
}
