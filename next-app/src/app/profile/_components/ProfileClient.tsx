"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { pickTitle, formatScore } from "@/lib/formatters";
import type { Lang, Dict } from "@/lib/i18n";
import type { SubscriptionListItem, SubscriptionStatus } from "./types";
import AnimeStatsPanel from "./AnimeStatsPanel";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: SubscriptionStatus; color: string }[] = [
  { value: "watching", color: "#0a84ff" },
  { value: "completed", color: "#30d158" },
  { value: "plan_to_watch", color: "#5ac8fa" },
  { value: "dropped", color: "#ff453a" },
];

const SORT_OPTIONS: {
  value: "updatedAt" | "score" | "title" | "avgScore";
  zh: string;
  en: string;
}[] = [
  { value: "updatedAt", zh: "最近更新", en: "Recently Updated" },
  { value: "score", zh: "我的评分", en: "My Score" },
  { value: "title", zh: "标题", en: "Title" },
  // avgScore is kept for UI parity but will silently no-op since
  // GET /api/subscriptions does not include averageScore in its response.
  { value: "avgScore", zh: "均分", en: "Average Score" },
];

function scoreColor(s: number | null | undefined): string {
  if (!s) return "rgba(235,235,245,0.40)";
  if (s >= 75) return "#30d158";
  if (s >= 50) return "#ff9f0a";
  return "#ff453a";
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function ProfileListSkeleton() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: 12,
      }}
    >
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: 12,
            padding: 12,
            borderRadius: 10,
            background: "#1c1c1e",
            border: "1px solid #38383a",
          }}
        >
          <div
            style={{
              width: 56,
              height: 80,
              borderRadius: 6,
              background: "#2c2c2e",
              flexShrink: 0,
            }}
          />
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <div
              style={{
                height: 14,
                background: "#2c2c2e",
                borderRadius: 4,
                width: "80%",
              }}
            />
            <div
              style={{
                height: 11,
                background: "#2c2c2e",
                borderRadius: 4,
                width: "50%",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Anime Card ───────────────────────────────────────────────────────────────

interface AnimeCardProps {
  item: SubscriptionListItem;
  lang: Lang;
}

function AnimeCard({ item, lang }: AnimeCardProps) {
  const [hovered, setHovered] = useState(false);
  const title = pickTitle(item, lang);

  return (
    <Link
      href={`/anime/${item.anilistId}`}
      style={{
        display: "flex",
        gap: 12,
        padding: 12,
        borderRadius: 10,
        background: hovered ? "#2c2c2e" : "#1c1c1e",
        border: "1px solid #38383a",
        cursor: "pointer",
        transition: "background 0.2s",
        textDecoration: "none",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Cover */}
      {item.coverImageUrl ? (
        <img
          src={item.coverImageUrl}
          alt={title}
          style={{
            width: 56,
            height: 80,
            objectFit: "cover",
            borderRadius: 6,
            flexShrink: 0,
          }}
          loading="lazy"
        />
      ) : (
        <div
          style={{
            width: 56,
            height: 80,
            borderRadius: 6,
            background: "#2c2c2e",
            flexShrink: 0,
          }}
        />
      )}

      {/* Info */}
      <div
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <p
          style={{
            fontFamily: "'Sora', sans-serif",
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            margin: 0,
            marginBottom: 4,
            lineHeight: 1.35,
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {title || "—"}
        </p>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {item.score != null && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#0a84ff",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {lang === "zh" ? "我" : "Me"}: {item.score}/10
            </span>
          )}
          {item.currentEpisode > 0 && (
            <span style={{ fontSize: 11, color: "rgba(235,235,245,0.40)" }}>
              {lang === "zh"
                ? `看到第 ${item.currentEpisode} 集`
                : `Ep ${item.currentEpisode}`}
              {item.episodes != null ? ` / ${item.episodes}` : ""}
            </span>
          )}
          {item.format && (
            <span
              style={{
                fontSize: 10,
                color: "rgba(235,235,245,0.30)",
                padding: "1px 6px",
                borderRadius: 4,
                background: "rgba(120,120,128,0.12)",
              }}
            >
              {item.format}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface ProfileClientProps {
  /** Username from /api/auth/me — null when SSR fetch 401s. */
  username: string | null;
  /** Initial "watching" list SSR-fetched for fast first paint. */
  initialItems: SubscriptionListItem[];
  /** All subscriptions (no status filter) for the stats panel. */
  allSubsInitial: SubscriptionListItem[];
  dict: Dict;
  lang: Lang;
}

export default function ProfileClient({
  username,
  initialItems,
  allSubsInitial,
  dict,
  lang,
}: ProfileClientProps) {
  const [activeStatus, setActiveStatus] = useState<SubscriptionStatus>("watching");
  const [sortBy, setSortBy] = useState<"updatedAt" | "score" | "title" | "avgScore">(
    "updatedAt",
  );
  const [search, setSearch] = useState("");
  // Client-side cache keyed by status. Seeded with SSR data.
  const [cache, setCache] = useState<Partial<Record<SubscriptionStatus, SubscriptionListItem[]>>>(
    { watching: initialItems },
  );
  const [loading, setLoading] = useState(false);
  const [allSubs, setAllSubs] =
    useState<SubscriptionListItem[]>(allSubsInitial);

  const fetchStatus = useCallback(
    async (status: SubscriptionStatus) => {
      if (cache[status] !== undefined) return;
      setLoading(true);
      try {
        const items = await apiGet<SubscriptionListItem[]>(
          `/api/subscriptions?status=${status}`,
        );
        setCache((prev) => ({ ...prev, [status]: items ?? [] }));
      } catch {
        setCache((prev) => ({ ...prev, [status]: [] }));
      } finally {
        setLoading(false);
      }
    },
    [cache],
  );

  const handleTabChange = useCallback(
    (status: SubscriptionStatus) => {
      setActiveStatus(status);
      fetchStatus(status);
    },
    [fetchStatus],
  );

  const currentItems = cache[activeStatus] ?? [];

  const filtered = useMemo(() => {
    let list = currentItems;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          (s.titleChinese ?? "").toLowerCase().includes(q) ||
          (s.titleRomaji ?? "").toLowerCase().includes(q) ||
          (s.titleEnglish ?? "").toLowerCase().includes(q) ||
          (s.titleNative ?? "").toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    switch (sortBy) {
      case "score":
        sorted.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        break;
      case "title":
        sorted.sort((a, b) =>
          pickTitle(a, lang).localeCompare(pickTitle(b, lang)),
        );
        break;
      case "avgScore":
        // averageScore is absent from the subscriptions list endpoint.
        // No-op sort (keep server order) to avoid breaking the UI.
        break;
      default:
        // updatedAt: already sorted DESC by server
        break;
    }
    return sorted;
  }, [currentItems, search, sortBy, lang]);

  const statusLabels: Record<SubscriptionStatus, string> = {
    watching: dict.sub.watching,
    completed: dict.sub.completed,
    plan_to_watch: dict.sub.planToWatch,
    dropped: dict.sub.dropped,
  };

  const displayName = username ?? (lang === "zh" ? "我" : "My");

  return (
    <div className="container" style={{ paddingTop: 40, paddingBottom: 60 }}>
      {/* Page header */}
      <div style={{ marginBottom: 36 }}>
        <p
          style={{
            color: "#0a84ff",
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "2px",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          {dict.profile.label}
        </p>
        <h1
          style={{
            fontSize: "clamp(24px, 3.5vw, 38px)",
            color: "#ffffff",
            fontFamily: "'Sora', sans-serif",
            margin: 0,
          }}
        >
          {displayName}
          {dict.profile.titleSuffix}
        </h1>
      </div>

      {/* Stats panel — computed from all subscriptions */}
      <AnimeStatsPanel allSubs={allSubs} lang={lang} />

      {/* Status tabs */}
      <nav
        aria-label={lang === "zh" ? "追番状态" : "Watch status"}
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 20,
          background: "#1c1c1e",
          borderRadius: 12,
          padding: 5,
          width: "fit-content",
          border: "1px solid #38383a",
        }}
      >
        {STATUS_OPTIONS.map((opt) => {
          const isActive = activeStatus === opt.value;
          const count = cache[opt.value]?.length;
          return (
            <button
              key={opt.value}
              onClick={() => handleTabChange(opt.value)}
              aria-pressed={isActive}
              style={{
                padding: "8px 20px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                border: "none",
                transition: "all 0.2s",
                fontFamily: "'Sora', sans-serif",
                background: isActive
                  ? `linear-gradient(135deg,${opt.color}33,${opt.color}22)`
                  : "transparent",
                color: isActive ? opt.color : "rgba(235,235,245,0.30)",
                boxShadow: isActive ? `0 2px 12px ${opt.color}30` : "none",
                borderBottom: isActive
                  ? `2px solid ${opt.color}`
                  : "2px solid transparent",
              }}
            >
              {statusLabels[opt.value]}
              {count != null && (
                <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Sort + Search bar */}
      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 24,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={lang === "zh" ? "搜索我的列表..." : "Search my list..."}
          aria-label={lang === "zh" ? "搜索追番列表" : "Search watchlist"}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #38383a",
            background: "#1c1c1e",
            color: "#fff",
            fontSize: 13,
            flex: "1 1 200px",
            minWidth: 180,
            outline: "none",
          }}
        />
        <select
          value={sortBy}
          onChange={(e) =>
            setSortBy(
              e.target.value as "updatedAt" | "score" | "title" | "avgScore",
            )
          }
          aria-label={lang === "zh" ? "排序方式" : "Sort by"}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #38383a",
            background: "#1c1c1e",
            color: "rgba(235,235,245,0.60)",
            fontSize: 13,
            cursor: "pointer",
            outline: "none",
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {lang === "zh" ? o.zh : o.en}
            </option>
          ))}
        </select>
      </div>

      {/* List */}
      {loading ? (
        <ProfileListSkeleton />
      ) : filtered.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "60px 0",
            color: "rgba(235,235,245,0.30)",
            fontFamily: "'Sora', sans-serif",
            fontSize: 15,
          }}
        >
          {search ? (
            lang === "zh" ? "无匹配结果" : "No matches"
          ) : (
            <>
              {dict.profile.noAnime} 「{statusLabels[activeStatus]}」{" "}
              {dict.profile.noAnimeSuffix}
            </>
          )}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 12,
          }}
        >
          {filtered.map((item) => (
            <AnimeCard key={item.anilistId} item={item} lang={lang} />
          ))}
        </div>
      )}
    </div>
  );
}
