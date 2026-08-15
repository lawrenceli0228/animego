"use client";

import Link from "next/link";
import FadeImage from "@/components/ui/FadeImage";
import { useLang } from "@/lib/lang-client";
import type { FeedItem } from "@/lib/types";
import { dispatchDiscussionNavigation } from "@/components/anime/episodeDiscussionState";
import {
  feedActorTarget,
  feedItemKey,
  feedItemTarget,
  feedItemTime,
} from "./activityFeedState";

interface ActivityFeedViewProps {
  items: FeedItem[];
  state: "ok" | "anonymous" | "error";
  nowMs: number;
}

function timeAgo(iso: string, lang: "zh" | "en", nowMs: number): string {
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return "";
  const diff = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diff < 60) return lang === "zh" ? "刚刚" : "just now";
  if (diff < 3600) {
    const minutes = Math.floor(diff / 60);
    return lang === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return lang === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  }
  const days = Math.floor(diff / 86400);
  return lang === "zh" ? `${days} 天前` : `${days}d ago`;
}

function pickTitle(item: FeedItem, lang: "zh" | "en"): string {
  if (item.kind?.toLowerCase() === "follow") {
    return item.targetUsername || (lang === "zh" ? "一位用户" : "a user");
  }
  return lang === "zh"
    ? item.titleChinese || item.title
    : item.title || item.titleChinese || `Anime #${item.anilistId}`;
}

function actionCopy(item: FeedItem, lang: "zh" | "en"): string {
  const kind = item.kind?.toLowerCase() ?? "";
  if (kind === "follow") {
    return lang === "zh" ? "关注了" : "followed";
  }
  if (kind.includes("comment")) {
    return lang === "zh"
      ? `讨论了第 ${item.episode} 集`
      : `commented on episode ${item.episode}`;
  }
  if (item.status === "completed" || kind === "completed") {
    return lang === "zh" ? "看完了这部番" : "completed this anime";
  }
  return lang === "zh"
    ? `看到第 ${item.episode} 集`
    : `watched episode ${item.episode}`;
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  borderRadius: 10,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid #38383a",
} as const;

export default function ActivityFeedView({ items, state, nowMs }: ActivityFeedViewProps) {
  const { lang, t } = useLang();
  return (
    <section style={{ marginTop: 40 }} aria-label={t("social.feedTitle")}>
      <header style={{ marginBottom: 16 }}>
        <p style={{ color: "#0a84ff", fontSize: 13, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>
          {t("social.feedLabel")}
        </p>
        <h2 style={{ fontSize: "clamp(20px,2.5vw,28px)", color: "#fff" }}>
          {t("social.feedTitle")}
        </h2>
      </header>

      {state === "anonymous" ? (
        <div style={{ ...rowStyle, minHeight: 110, justifyContent: "center", flexDirection: "column", textAlign: "center" }}>
          <p style={{ margin: 0, color: "rgba(235,235,245,.65)", fontSize: 13 }}>
            {t("social.feedLogin")}
          </p>
          <Link href="/login" prefetch={false} style={{ padding: "8px 18px", borderRadius: 8, background: "#0a84ff", color: "#fff", textDecoration: "none", fontSize: 12, fontWeight: 700 }}>
            {t("nav.login")}
          </Link>
        </div>
      ) : state === "error" ? (
        <div style={{ ...rowStyle, minHeight: 90, justifyContent: "center", color: "rgba(235,235,245,.45)", fontSize: 13 }}>
          {t("social.feedError")}
        </div>
      ) : items.length === 0 ? (
        <div style={{ ...rowStyle, minHeight: 100, justifyContent: "center", flexDirection: "column", textAlign: "center" }}>
          <span style={{ color: "rgba(235,235,245,.42)", fontSize: 13 }}>{t("social.noActivity")}</span>
          <Link href="/search" style={{ color: "#0a84ff", fontSize: 12, textDecoration: "none" }}>
            {t("social.browseAnime")}
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((item) => {
            const title = pickTitle(item, lang);
            const timestamp = feedItemTime(item);
            const target = feedItemTarget(item);
            return (
              <article key={feedItemKey(item)} style={rowStyle}>
                <Link href={target} prefetch={false} onNavigate={() => dispatchDiscussionNavigation(target)} aria-hidden="true" tabIndex={-1} style={{ width: 36, height: 52, flexShrink: 0, borderRadius: 4, overflow: "hidden", background: "#2c2c2e", display: "grid", placeItems: "center", color: "rgba(235,235,245,.55)", textDecoration: "none", fontWeight: 700 }}>
                  {item.coverImageUrl && (
                    <FadeImage src={item.coverImageUrl} alt="" width={36} height={52} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  )}
                  {!item.coverImageUrl && title.slice(0, 1).toUpperCase()}
                </Link>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link href={target} prefetch={false} onNavigate={() => dispatchDiscussionNavigation(target)} style={{ display: "block", color: "#fff", textDecoration: "none", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {title}
                  </Link>
                  <div style={{ marginTop: 3, color: "rgba(235,235,245,.5)", fontSize: 11 }}>
                    <Link href={feedActorTarget(item)} prefetch={false} style={{ color: "#0a84ff", textDecoration: "none", fontWeight: 600 }}>
                      {item.username}
                    </Link>{" "}
                    <Link href={target} prefetch={false} onNavigate={() => dispatchDiscussionNavigation(target)} style={{ color: "inherit", textDecoration: "none" }}>
                      {actionCopy(item, lang)}
                    </Link>
                  </div>
                  {(item.isSpoiler || item.excerpt || item.content) && (
                    <p style={{ margin: "5px 0 0", color: "rgba(235,235,245,.42)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.isSpoiler ? t("comment.spoilerPreview") : item.excerpt || item.content}
                    </p>
                  )}
                </div>
                {timestamp && <time dateTime={timestamp} style={{ color: "rgba(235,235,245,.32)", fontSize: 10, flexShrink: 0 }}>{timeAgo(timestamp, lang, nowMs)}</time>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
