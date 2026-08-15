"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { mono, PLAYER_HUE } from "@/components/landing/shared/hud-tokens";
import { CornerBrackets } from "@/components/landing/shared/hud";
import { useLang } from "@/lib/lang-client";

// ManualSearch is owned by the P6.6 Player port (subagent C in the next
// fan-out). It doesn't exist in next-app yet; this dynamic import resolves
// to a placeholder until that lands, at which point the import string
// will simply pick up the real module.
//
// TODO P6 verify: once subagent C ships ManualSearch into
// `next-app/src/app/player/_components/ManualSearch.tsx`, point this
// import at that path (or the agreed shared location) and drop the
// fallback shim.
const ManualSearch = dynamic(
  () =>
    import("./ManualSearchPlaceholder").then((m) => m.ManualSearchPlaceholder),
  { ssr: false },
) as unknown as React.ComponentType<{
  defaultKeyword: string;
  onSelect: (item: unknown) => void;
  onBack: () => void;
}>;

const HUE = PLAYER_HUE.stream;

interface SeriesLike {
  id: string;
  titleEn?: string;
  titleZh?: string;
  titleJa?: string;
}

/**
 * Two ids, two universes. Naming them apart is the whole point of this type.
 *
 *   dandanAnimeId — dandanplay's per-season anime id. Lands on `Season.animeId`
 *                   and drives danmaku + episode listings.
 *   anilistId     — AniList's id. Lands on `Series.anilistId` and drives
 *                   subscriptions and watch-progress sync.
 *
 * `/api/dandanplay/search` returns two disjoint row shapes and they do NOT
 * overlap: `source: "animeCache"` rows carry `anilistId` and never
 * `dandanAnimeId`; `source: "dandanplay"` rows carry `dandanAnimeId` and never
 * `anilistId`. Either may be absent — the picker offers both sections — so both
 * fields are optional and `normalize` rejects a hit that has neither.
 */
export interface RematchPayload {
  dandanAnimeId?: number;
  anilistId?: number;
  titleZh?: string;
  titleEn?: string;
  posterUrl?: string;
  type: "tv" | "movie" | "ova" | "web";
}

interface RematchDialogProps {
  open: boolean;
  sourceSeries: SeriesLike;
  onClose: () => void;
  onConfirm: (payload: RematchPayload) => void;
}

function pickTitle(series: SeriesLike | undefined | null): string {
  return (
    series?.titleEn || series?.titleZh || series?.titleJa || series?.id || ""
  );
}

/** Positive integer or nothing. Search JSON is untrusted input. */
function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Normalize a raw search hit into the rematch payload.
 *
 * This used to read `Number(it.dandanAnimeId ?? it.anilistId ?? NaN)` and hand
 * the result over as `animeId`. Since animeCache rows never carry
 * `dandanAnimeId`, every pick from the (richer, first-listed) cache section fell
 * through to `anilistId` — and an AniList id was then written into
 * `Season.animeId` and `userOverride.overrideSeasonAnimeId`, both of which are
 * dandanplay id space. The import pipeline looks up seasons by dandanplay id
 * (`findReusableSeason`), so the poisoned row could never match again: a
 * duplicate card on the next import, plus danmaku pointed at whatever
 * dandanplay anime happens to share that number.
 *
 * Now each id is carried in its own field and neither substitutes for the
 * other.
 */
function normalize(item: unknown): RematchPayload | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const dandanAnimeId = toPositiveInt(it.dandanAnimeId);
  const anilistId = toPositiveInt(it.anilistId);
  if (dandanAnimeId === undefined && anilistId === undefined) return null;
  let type: RematchPayload["type"] = "tv";
  if (typeof it.format === "string") {
    const f = it.format.toLowerCase();
    if (f.includes("movie")) type = "movie";
    else if (f.includes("ova")) type = "ova";
    else if (f.includes("web")) type = "web";
  }
  return {
    dandanAnimeId,
    anilistId,
    titleZh: (it.titleChinese as string) || undefined,
    titleEn: (it.title as string) || undefined,
    posterUrl:
      (it.coverImageUrl as string) || (it.imageUrl as string) || undefined,
    type,
  };
}

/**
 * RematchDialog — pick a different dandanplay anime for an existing series.
 *
 * Wraps the existing ManualSearch picker in a modal shell. The picked item is
 * normalized into the shape rematchSeries() expects (both ids, kept apart, plus
 * display fields) before being handed to onConfirm. Backdrop click + Escape +
 * Cancel all close.
 */
export function RematchDialog({
  open,
  sourceSeries,
  onClose,
  onConfirm,
}: RematchDialogProps) {
  const { t } = useLang();

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sourceTitle = pickTitle(sourceSeries);

  function handleSelect(item: unknown) {
    const payload = normalize(item);
    if (payload) onConfirm(payload);
  }

  return (
    <div
      data-testid="rematch-dialog-backdrop"
      style={s.backdrop}
      onClick={onClose}
    >
      <div
        data-testid="rematch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rematch-source-title"
        style={s.dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <CornerBrackets inset={4} size={10} opacity={0.35} hue={HUE} />

        <div style={s.header}>
          <span style={s.kicker}>{t("library.rematchDialog.title")}</span>
          <span
            id="rematch-source-title"
            data-testid="rematch-source-title"
            style={s.title}
          >
            {sourceTitle}
          </span>
        </div>

        <div style={s.body}>
          <ManualSearch
            defaultKeyword={sourceTitle}
            onSelect={handleSelect}
            onBack={onClose}
          />
        </div>

        <div style={s.footer}>
          <button
            data-testid="rematch-cancel"
            type="button"
            style={s.cancelBtn}
            onClick={onClose}
          >
            {t("library.bulk.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default RematchDialog;

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "oklch(2% 0 0 / 0.65)",
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  dialog: {
    position: "relative",
    width: "min(640px, 100%)",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
    background: `oklch(12% 0.03 ${HUE} / 0.96)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 6,
    boxShadow: "0 8px 32px oklch(2% 0 0 / 0.6)",
    color: "#fff",
    overflow: "hidden",
  },
  header: {
    padding: "16px 20px 12px",
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  kicker: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE})`,
    textTransform: "uppercase",
    letterSpacing: "0.18em",
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 16,
    color: "#fff",
    lineHeight: 1.3,
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: 0,
  },
  footer: {
    padding: "12px 20px",
    borderTop: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
  },
  cancelBtn: {
    ...mono,
    padding: "8px 16px",
    background: "transparent",
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 3,
    color: "rgba(235,235,245,0.85)",
    cursor: "pointer",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  },
};
