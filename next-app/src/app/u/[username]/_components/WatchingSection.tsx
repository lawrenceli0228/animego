"use client";

import { useState } from "react";
import Link from "next/link";
import type { WatchingEntry } from "./types";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n";

interface WatchingSectionProps {
  watching: WatchingEntry[];
  lang: Lang;
}

const STATUS_ORDER = ["watching", "completed", "plan_to_watch", "dropped"] as const;
type StatusKey = (typeof STATUS_ORDER)[number];

const PAGE_SIZE = 12;

// Minimal anime card for profile pages — simpler than the landing AnimeCard
// (no hover details overlay), just cover + title on click.
function ProfileAnimeCard({ anime }: { anime: WatchingEntry }) {
  const title =
    anime.titleChinese ?? anime.titleRomaji ?? anime.titleEnglish ?? anime.titleNative ?? "";

  return (
    <Link
      href={`/anime/${anime.anilistId}`}
      prefetch={false}
      title={title}
      style={{
        display: "block",
        textDecoration: "none",
        color: "inherit",
        width: 120,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 120,
          height: 170,
          borderRadius: 8,
          overflow: "hidden",
          background: anime.posterAccent
            ? `rgba(${anime.posterAccent}, 0.15)`
            : "#2c2c2e",
          border: "1px solid #38383a",
          marginBottom: 6,
          position: "relative",
        }}
      >
        {anime.coverImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={anime.coverImageUrl}
            alt={title}
            width={120}
            height={170}
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : null}
      </div>
      <div
        title={title}
        style={{
          fontSize: 11,
          color: "rgba(235,235,245,0.70)",
          lineHeight: 1.3,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {title}
      </div>
    </Link>
  );
}

export default function WatchingSection({ watching, lang: _lang }: WatchingSectionProps) {
  const { t } = useLang();
  const [expanded, setExpanded] = useState<Partial<Record<StatusKey, boolean>>>({});

  if (watching.length === 0) {
    return (
      <p
        style={{
          color: "rgba(235,235,245,0.30)",
          textAlign: "center",
          paddingTop: 40,
        }}
      >
        {t("social.emptyList")}
      </p>
    );
  }

  const statusLabels: Record<StatusKey, string> = {
    watching: t("sub.watching"),
    completed: t("sub.completed"),
    plan_to_watch: t("sub.planToWatch"),
    dropped: t("sub.dropped"),
  };

  const byStatus = STATUS_ORDER.reduce<Record<StatusKey, WatchingEntry[]>>(
    (acc, s) => {
      acc[s] = watching.filter((a) => a.subscriptionStatus === s);
      return acc;
    },
    { watching: [], completed: [], plan_to_watch: [], dropped: [] },
  );

  return (
    <>
      {STATUS_ORDER.map((status) => {
        const list = byStatus[status];
        if (list.length === 0) return null;
        const isExpanded = expanded[status] ?? false;
        const shown = isExpanded ? list : list.slice(0, PAGE_SIZE);
        const hasMore = list.length > PAGE_SIZE;

        return (
          <section key={status} style={{ marginBottom: 40 }}>
            <div
              style={{
                marginBottom: 12,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <h2
                style={{ fontSize: 16, fontWeight: 700, color: "#ffffff", margin: 0 }}
              >
                {statusLabels[status]}
              </h2>
              <span
                style={{
                  fontSize: 12,
                  color: "#0a84ff",
                  background: "rgba(10,132,255,0.15)",
                  padding: "2px 8px",
                  borderRadius: 99,
                  fontWeight: 600,
                }}
              >
                {list.length}
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {shown.map((anime) => (
                <ProfileAnimeCard key={anime.anilistId} anime={anime} />
              ))}
            </div>
            {hasMore && (
              <button
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [status]: !isExpanded }))
                }
                style={{
                  marginTop: 12,
                  padding: "8px 20px",
                  borderRadius: 8,
                  border: "1px solid rgba(84,84,88,0.65)",
                  background: "transparent",
                  color: "rgba(235,235,245,0.60)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {isExpanded
                  ? t("social.showLess")
                  : `${t("social.showMore")} (${list.length - PAGE_SIZE})`}
              </button>
            )}
          </section>
        );
      })}
    </>
  );
}
