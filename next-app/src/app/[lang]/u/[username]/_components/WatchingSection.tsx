"use client";

import { useState } from "react";
import Link from "@/components/ui/LocaleLink";
import type { WatchingEntry } from "./types";
import { useLang } from "@/lib/lang-client";
import { pickTitle } from "@/lib/formatters";
import type { Lang } from "@/lib/i18n";

interface WatchingSectionProps {
  watching: WatchingEntry[];
}

const STATUS_ORDER = ["watching", "completed", "plan_to_watch", "dropped"] as const;
type StatusKey = (typeof STATUS_ORDER)[number];

const PAGE_SIZE = 12;

// Alpha channel for the poster-tile tint, as the `AA` pair of an `#RRGGBBAA`
// hex. 0x26 = 38/255 ≈ 15%, matching the opacity the old (broken) rgba() asked
// for. Kept as a named constant because "26" at a call site reads as a number,
// not an opacity.
const ACCENT_TINT_ALPHA = "26";

// Minimal anime card for profile pages — simpler than the landing AnimeCard
// (no hover details overlay), just cover + title on click.
//
// The title ladder used to be a hardcoded `titleChinese ?? titleRomaji ?? …`,
// i.e. Chinese-first regardless of language. That is the mirror image of the
// bug the zh work is fixing: it force-fed Chinese titles to English readers
// on every profile page. Delegating to the shared pickTitle() makes the
// preference bidirectional — zh gets Chinese first, en gets English first —
// and keeps this card on the same ladder as every other title render site.
// `lang` is the *client* language (see the parent's useLang note): the RSC
// `lang` prop is always "zh" under ISR islanding, so it cannot be used here.
function ProfileAnimeCard({ anime, lang }: { anime: WatchingEntry; lang: Lang }) {
  // pickTitle's en branch is deliberately narrow (english || romaji) and returns
  // "" rather than reaching for a Chinese or Japanese title. Correct for prose,
  // wrong for a poster card: title_romaji is nullable, so a row carrying only a
  // native/Chinese title would render a caption-less card with alt="" — which
  // screen readers announce as decorative. A title in an unexpected script is
  // still recoverable; an anonymous card is not. The tail only fires when
  // pickTitle finds nothing, so every entry that rendered before renders the
  // same bytes now.
  const title =
    pickTitle(anime, lang) || anime.titleNative || anime.titleChinese || "";

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
          // `posterAccent` is a hex string, not the `r, g, b` triplet rgba()
        // wants. The old `rgba(${anime.posterAccent}, 0.15)` expanded to
        // `rgba(#e45d35, 0.15)` — invalid, so the browser dropped the whole
        // declaration and the tinted placeholder never painted. The sibling
        // column `posterAccentRgb` does hold the triplet, but it is not in
        // this page's `WatchingEntry` (types.ts:53 carries only the hex), so
        // reaching for it here would mean widening the profile DTO.
        //
        // 8-digit hex instead: `#RRGGBBAA`, where 26 is 15% alpha. Safe
        // because the column is strictly `#RRGGBB` — checked against
        // production, 17,828 of 17,828 rows match /^#[0-9a-fA-F]{6}$/ with
        // zero exceptions.
        background: anime.posterAccent
            ? `${anime.posterAccent}${ACCENT_TINT_ALPHA}`
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

export default function WatchingSection({ watching }: WatchingSectionProps) {
  // No `lang` prop by design. An RSC-supplied language would be the URL's
  // locale, which says "zh" on the bare /u/… paths these profiles are shared
  // as — so this component would keep force-feeding Chinese titles to English
  // readers, exactly the bug this file used to have. useLang() SSR-seeds from
  // the route locale then reconciles from the cookie on mount, which is the
  // reader's own stated preference.
  const { t, lang } = useLang();
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
                <ProfileAnimeCard key={anime.anilistId} anime={anime} lang={lang} />
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
