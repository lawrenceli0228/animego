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

export interface RematchPayload {
  animeId: number;
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

/**
 * Normalize a raw dandanplay search hit to the rematch payload that the
 * service layer expects. Falls back to anilistId when dandanAnimeId is
 * missing (some search response shapes only carry one).
 */
function normalize(item: unknown): RematchPayload | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const animeId = Number(it.dandanAnimeId ?? it.anilistId ?? NaN);
  if (!Number.isInteger(animeId) || animeId <= 0) return null;
  let type: RematchPayload["type"] = "tv";
  if (typeof it.format === "string") {
    const f = it.format.toLowerCase();
    if (f.includes("movie")) type = "movie";
    else if (f.includes("ova")) type = "ova";
    else if (f.includes("web")) type = "web";
  }
  return {
    animeId,
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
 * normalized into the shape rematchSeries() expects (animeId + display fields)
 * before being handed to onConfirm. Backdrop click + Escape + Cancel all close.
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
