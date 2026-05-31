"use client";

// LibraryShell — P6.4 subagent C ported entry shell. Mirrors the legacy
// client/src/pages/LibraryPage.jsx structure 1:1 but swaps router-dom for
// next/navigation and rewrites the import paths to next-app's @/* roots.
//
// Browser-only by construction: Dexie + FSA are loaded via this shell.
// The route page (next-app/src/app/library/page.tsx) imports us with
// `next/dynamic({ ssr: false })` so we never run on the server.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { motion, useReducedMotion } from "motion/react";

import {
  mono,
  PLAYER_HUE,
  LOCAL_HEX_GLYPH,
  useCountUp,
} from "@/components/landing/shared/hud-tokens";
import { CornerBrackets } from "@/components/landing/shared/hud";
import { useLang } from "@/lib/lang-client";

// Library lib (P6.2 ported)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module with JSDoc types
import { db } from "@/lib/library/db/db.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { isFsaSupported } from "@/lib/library/handles/fsaFeatureCheck.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { enumerateAll } from "@/lib/library/enumerator.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {
  applySeriesFilter,
  computeFilterCounts,
} from "@/lib/library/seriesFilter.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { migrateLegacyProgress } from "@/lib/library/db/migrateLegacyProgress.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { ulid } from "@/lib/library/ulid.js";

// Hooks owned by this subagent / unowned support hooks
import { useLibrary } from "../_hooks/useLibrary";
import { useResume } from "../_hooks/useResume";
import { useVideoFiles } from "../_hooks/useVideoFiles";
import { useSeriesProgressMap } from "../_hooks/useSeriesProgressMap";
import { useUnclassified } from "../_hooks/useUnclassified";
import { useWatchRhythm } from "../_hooks/useWatchRhythm";
import { useSeriesLibraryStatus } from "../_hooks/useSeriesLibraryStatus";

// Hooks owned by subagent B (import + handles + user override + selection).
// These files don't exist yet while this subagent runs — trust the integrator.
import { useFileHandles } from "../_hooks/useFileHandles";
import { useImport } from "../_hooks/useImport";
import { useUserOverride } from "../_hooks/useUserOverride";
import { useSeriesSelection } from "../_hooks/useSeriesSelection";

// Services
import { createDandanClient } from "../_services/dandanClient";
import { performMerge, undoMerge } from "../_services/mergeOps";
import { splitSeries } from "../_services/splitSeries";
import { rematchSeries } from "../_services/rematchSeries";
import { deleteSeriesCascade } from "../_services/deleteSeries";
import { dedupeSeriesByAnimeId } from "../_services/dedupeSeries";
import { refreshAllSeriesMetadata } from "../_services/refreshSeriesMetadata";

// Components — owned by this subagent
import { SeriesDetailSheet } from "./SeriesDetailSheet";
import { HudCelebration } from "./HudCelebration";
import { UnavailableSeriesSection } from "./UnavailableSeriesSection";
import { UndoToast } from "./UndoToast";

// Components owned by subagent A
import { SeriesGrid } from "./SeriesGrid";
import { SeriesCardSkeleton } from "./SeriesCardSkeleton";
import { FilterChips } from "./FilterChips";
import { SearchBar } from "./SearchBar";
import { ScrollRow } from "./ScrollRow";
import { NewAdditionsRow } from "./NewAdditionsRow";
import { RecentlyPlayedRow } from "./RecentlyPlayedRow";
import { WatchRhythmStrip } from "./WatchRhythmStrip";
import { LibraryEmptyState } from "./LibraryEmptyState";
import { UnclassifiedSection } from "./UnclassifiedSection";

// Components owned by subagent B
import { DropZone } from "./DropZone";
import { ImportDrawer } from "./ImportDrawer";
import { ImportMiniPill } from "./ImportMiniPill";
import { BulkActionToolbar } from "./BulkActionToolbar";
import { HudOverflowMenu } from "./HudOverflowMenu";
import { FsaUnsupportedBanner } from "./FsaUnsupportedBanner";
import { MergeDialog } from "./MergeDialog";
import { SplitDialog } from "./SplitDialog";
import { RematchDialog } from "./RematchDialog";

// Tiny `{{var}}` interpolation for toast strings — t() doesn't support it.
function fmtTpl(tpl: string, vars: Record<string, string | number>): string {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) =>
    String(vars[k] ?? ""),
  );
}

/**
 * Mount-time count-up wrapper. Pulls useCountUp's ref into the rendered <span>
 * so the value animates from 0 to target on first reveal. Reduced-motion users
 * see the target value immediately.
 */
function StatNum({
  value,
  delay = 0,
  style,
}: {
  value: number;
  delay?: number;
  style?: CSSProperties;
}) {
  const [ref, n] = useCountUp(value, { duration: 1.0, delay });
  return (
    <span ref={ref as React.RefObject<HTMLDivElement>} style={style}>
      {n}
    </span>
  );
}

const HUE = PLAYER_HUE.stream;
const PRIVACY_PULSE_CSS =
  "@keyframes libraryPrivacyPulse{0%,100%{opacity:0.55;transform:scale(0.92)}50%{opacity:1;transform:scale(1)}}";

// §5.x — sparse-row threshold (Q1 design decision A). Below this count we
// skip the discovery rows entirely and surface only the main grid + a
// "drop more folders" hint, matching Apple TV+ small-library behavior.
const ROWS_THRESHOLD = 5;
const SKELETON_ROW_COUNT = 8;
const SKELETON_GRID_COUNT = 8;
const SKELETON_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: 24,
};

const s = {
  page: {
    maxWidth: 1400,
    margin: "0 auto",
    padding: "32px 24px 96px",
    display: "flex",
    flexDirection: "column",
    gap: 24,
  } as CSSProperties,
  hudHeader: {
    position: "relative",
    padding: "24px 0 32px",
    borderBottom: "1px solid #38383a",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 24,
    flexWrap: "wrap",
  } as CSSProperties,
  hudHeaderInner: { flex: 1, minWidth: 0 } as CSSProperties,
  hudKicker: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.30)",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    marginBottom: 12,
  } as CSSProperties,
  hudTitle: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: 32,
    letterSpacing: "-0.02em",
    color: "#fff",
    margin: "0 0 8px",
    display: "flex",
    alignItems: "baseline",
    gap: 14,
    flexWrap: "wrap",
  } as CSSProperties,
  hudTitleEn: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.30)",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  } as CSSProperties,
  hudSubtitle: {
    color: "rgba(235,235,245,0.60)",
    fontSize: 13,
    display: "flex",
    gap: 14,
    alignItems: "center",
    flexWrap: "wrap",
  } as CSSProperties,
  hudNum: { ...mono, color: "#fff" } as CSSProperties,
  hudDot: { color: "rgba(235,235,245,0.18)" } as CSSProperties,
  hudPrivacy: {
    ...mono,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 10,
    color: "#30d158",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  } as CSSProperties,
  hudPrivacyDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#30d158",
    boxShadow: "0 0 8px #30d158",
    animation: "libraryPrivacyPulse 2s ease-in-out infinite",
  } as CSSProperties,
  hudActions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  } as CSSProperties,
  addBtn: {
    ...mono,
    padding: "8px 16px",
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.55)`,
    borderRadius: 4,
    color: `oklch(72% 0.15 ${HUE})`,
    cursor: "pointer",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  } as CSSProperties,
};

// Light typings for legacy hook returns we touch in the shell.
// Reuse the SeriesRecord type from useLibrary so the shape stays in sync
// with what the hook actually returns.
// P6 TODO: tighten when useLibrary gets typed exports; for now widen to any
// eslint-disable-next-line -eslint/no-explicit-any
type SeriesRecord = any;

type LibraryFilter =
  | "recent"
  | "new"
  | "inProgress"
  | "done"
  | "almostDone"
  | "stalled"
  | "fresh"
  | null;

interface ImportSummary {
  crossFolderMerges?: Array<{ seriesId: string; folders: string[] }>;
  // additional fields tolerated but unused at the shell level
  [key: string]: unknown;
}

export function LibraryShell() {
  const { t } = useLang();
  const router = useRouter();
  const fsaSupported = isFsaSupported();

  const dandan = useMemo(() => createDandanClient(), []);
  const { series, loading } = useLibrary({ db }) as {
    series: SeriesRecord[];
    loading: boolean;
  };
  const { entries: resumeEntries } = useResume({ db });
  const {
    status,
    pickFolder,
    libraryStatus,
    reauthorize: reauthorizeHandle,
    refresh: refreshHandles,
  } = useFileHandles({ db });
  const { availabilityBySeries, ready: availabilityIndexReady } =
    useSeriesLibraryStatus({ db, libraryStatus });

  // Combine: index loaded AND handles probed.
  const availabilityReady =
    availabilityIndexReady && status !== "idle" && status !== "loading";
  const {
    run: runImport,
    progress: importProgress,
    summary: importSummary,
    status: importStatus,
    error: importError,
    cancel: cancelImport,
  } = useImport({ db, dandan });
  const [importDismissed, setImportDismissed] = useState(false);
  const { processFiles } = useVideoFiles();
  const {
    all: overrides,
    lock,
    unlock,
    clear,
  } = useUserOverride({ db });
  const { entries: unclassifiedEntries } = useUnclassified({ db });
  const { map: progressMap } = useSeriesProgressMap({ db });
  const watchRhythm = useWatchRhythm({ db });
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // SearchBar handle type comes from subagent A.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const searchRef = useRef<any>(null);
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);
  const [splitSourceId, setSplitSourceId] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [splitSeasons, setSplitSeasons] = useState<any[]>([]);
  const [rematchSourceId, setRematchSourceId] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<{
    opIds: string[];
    title: string;
    meta?: string;
  } | null>(null);
  const [autoMergeQueue, setAutoMergeQueue] = useState<
    Array<{ seriesId: string; title: string; meta: string }>
  >([]);
  const [detailSeriesId, setDetailSeriesId] = useState<string | null>(null);
  const consumedSummaryRef = useRef<ImportSummary | null>(null);
  const selection = useSeriesSelection();

  const visibleSeries = useMemo(
    () => applySeriesFilter(series, progressMap, activeFilter, searchQuery),
    [series, progressMap, activeFilter, searchQuery],
  ) as SeriesRecord[];

  // Main grid only shows accessible series. offline / partial drop into
  // UnavailableSeriesSection.
  const mainGridSeries = useMemo(
    () =>
      visibleSeries.filter((sr) => {
        const av = availabilityBySeries.get(sr.id);
        return av !== "offline" && av !== "partial";
      }),
    [visibleSeries, availabilityBySeries],
  );

  const unavailableSeries = useMemo(
    () =>
      series.filter((sr) => {
        const av = availabilityBySeries.get(sr.id);
        return av === "offline" || av === "partial";
      }),
    [series, availabilityBySeries],
  );

  const filterCounts = useMemo(
    () => computeFilterCounts(series, progressMap),
    [series, progressMap],
  );

  const mergeSource = useMemo(
    () => series.find((sr) => sr.id === mergeSourceId) ?? null,
    [series, mergeSourceId],
  );

  const splitSource = useMemo(
    () => series.find((sr) => sr.id === splitSourceId) ?? null,
    [series, splitSourceId],
  );

  const rematchSource = useMemo(
    () => series.find((sr) => sr.id === rematchSourceId) ?? null,
    [series, rematchSourceId],
  );

  // Load seasons for the split source on demand.
  useEffect(() => {
    if (!splitSourceId) {
      setSplitSeasons([]);
      return undefined;
    }
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).seasons
      .where("seriesId")
      .equals(splitSourceId)
      .toArray()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((rows: any[]) => {
        if (!cancelled) setSplitSeasons(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn("[library] failed to load seasons for split:", err);
          setSplitSeasons([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [splitSourceId]);

  // Global `/` keybinding — focuses the SearchBar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      searchRef.current?.focus?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // One-shot legacy progress migration on first mount.
  useEffect(() => {
    let cancelled = false;
    migrateLegacyProgress({ db }).catch((err: unknown) => {
      if (!cancelled) {
        // eslint-disable-next-line no-console
        console.warn("[LibraryShell] migrateLegacyProgress failed:", err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const showAddBtn = fsaSupported && series.length > 0;

  const handleAddFolder = useCallback(async () => {
    if (!fsaSupported) return;
    const libraryId = ulid();
    const record = await pickFolder(libraryId);
    if (!record) return;

    const collected = await enumerateAll(record.handle);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allFiles = collected.map(({ file }: any) => file);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pathMap = new Map<File, string>(
      collected.map(({ file, relPath }: any) => [file, relPath]),
    );
    const { files: items } = processFiles(allFiles, { pathMap });
    setImportDismissed(false);
    // P6 type widen: ParsedEpisodeItem.parsedKind is string after
    // processFiles; EpisodeItem types it as a union literal. Legacy
    // SPA passed the value through unchanged at runtime — keeping
    // parity by widening to `any` at the boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runImport({ items: items as any, libraryId: record.libraryId });
  }, [fsaSupported, pickFolder, processFiles, runImport]);

  const handlePickSeries = useCallback((id: string) => {
    // Open the in-page episode picker. The user picks an exact episode there
    // and `handlePickEpisode` routes to /player with the resume target.
    setDetailSeriesId(id);
  }, []);

  // P6 navigation: URL query params per P6-DESIGN §3.1.
  // Legacy used useNavigate('/player', { state: {...} }); we encode in the
  // querystring so refresh recovers.
  const handlePickEpisode = useCallback(
    (seriesId: string, episodeNumber: number) => {
      setDetailSeriesId(null);
      router.push(
        `/player?seriesId=${encodeURIComponent(seriesId)}&resumeEpisode=${episodeNumber}`,
      );
    },
    [router],
  );

  const handlePlaySeries = useCallback(
    (seriesId: string) => {
      setDetailSeriesId(null);
      router.push(`/player?seriesId=${encodeURIComponent(seriesId)}`);
    },
    [router],
  );

  const handleResume = useCallback(
    (id: string, episodeNumber: number) => {
      router.push(
        `/player?seriesId=${encodeURIComponent(id)}&resumeEpisode=${episodeNumber}`,
      );
    },
    [router],
  );

  const handleOverrideAction = useCallback(
    async (seriesId: string, action: string) => {
      try {
        if (action === "lock") await lock(seriesId);
        else if (action === "unlock") await unlock(seriesId);
        else if (action === "clear") await clear(seriesId);
        else if (action === "merge") setMergeSourceId(seriesId);
        else if (action === "split") setSplitSourceId(seriesId);
        else if (action === "rematch") setRematchSourceId(seriesId);
        else if (action === "delete") {
          const target = series.find((sr) => sr.id === seriesId);
          const title =
            target?.titleZh ||
            target?.titleEn ||
            target?.titleJa ||
            seriesId;
          const ok = window.confirm(
            t("library.confirm.deleteSingle").replace("{{title}}", title),
          );
          if (!ok) return;
          await deleteSeriesCascade({ db, seriesId });
          toast.success(t("library.toast.deleteSuccess").replace("{{title}}", title));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[library] override action ${action} failed:`, err);
        toast.error(t("library.toast.deleteFailed"));
      }
    },
    [lock, unlock, clear, series],
  );

  const handleMergeConfirm = useCallback(
    async (targetSeriesId: string) => {
      if (!mergeSourceId || mergeSourceId === targetSeriesId) {
        setMergeSourceId(null);
        return;
      }
      const sourceSeries =
        series.find((sr) => sr.id === mergeSourceId) ?? null;
      const targetSeries =
        series.find((sr) => sr.id === targetSeriesId) ?? null;
      const targetTitle =
        targetSeries?.titleZh ||
        targetSeries?.titleEn ||
        targetSeries?.titleJa ||
        targetSeriesId;
      const sourceTitle =
        sourceSeries?.titleZh ||
        sourceSeries?.titleEn ||
        sourceSeries?.titleJa ||
        mergeSourceId;
      try {
        const op = await performMerge({
          db,
          sourceSeriesId: mergeSourceId,
          targetSeriesId,
          summary: { targetTitle, sourceTitle },
        });
        if (op) {
          setUndoToast({
            opIds: [op.id],
            title: targetTitle,
            meta: t("library.undoToast.mergeFromSource").replace("{{source}}", sourceTitle),
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[library] merge failed:", err);
      } finally {
        setMergeSourceId(null);
      }
    },
    [mergeSourceId, series],
  );

  const handleBulkDelete = useCallback(async () => {
    const ids: string[] = selection.ids;
    if (ids.length === 0) return;
    const titles = ids
      .map((id) => series.find((sr) => sr.id === id))
      .map((sr) => sr?.titleZh || sr?.titleEn || sr?.titleJa || sr?.id || "?");
    const preview =
      titles.slice(0, 3).join(", ") +
      (titles.length > 3
        ? t("library.confirm.deleteBulkPreviewMore").replace("{{total}}", String(titles.length))
        : "");
    const ok = window.confirm(
      t("library.confirm.deleteBulk")
        .replace("{{count}}", String(ids.length))
        .replace("{{preview}}", preview),
    );
    if (!ok) return;
    let okCount = 0;
    for (const id of ids) {
      try {
        await deleteSeriesCascade({ db, seriesId: id });
        okCount += 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[library] bulk delete step failed:", err);
      }
    }
    selection.clear();
    if (okCount === ids.length) {
      toast.success(t("library.toast.deleteSuccessCount").replace("{{count}}", String(okCount)));
    } else if (okCount > 0) {
      toast.success(
        t("library.toast.deleteSuccessPartial")
          .replace("{{ok}}", String(okCount))
          .replace("{{total}}", String(ids.length)),
      );
    } else {
      toast.error(t("library.toast.deleteFailed"));
    }
  }, [selection, series]);

  const handleBulkMerge = useCallback(async () => {
    const ids: string[] = selection.ids;
    if (ids.length < 2) return;
    const [targetSeriesId, ...sourceIds] = ids;
    const targetSeries =
      series.find((sr) => sr.id === targetSeriesId) ?? null;
    const targetTitle =
      targetSeries?.titleZh ||
      targetSeries?.titleEn ||
      targetSeries?.titleJa ||
      targetSeriesId;
    const opIds: string[] = [];
    for (const sourceId of sourceIds) {
      try {
        const op = await performMerge({
          db,
          sourceSeriesId: sourceId,
          targetSeriesId,
          summary: { targetTitle, batch: true },
        });
        if (op) opIds.push(op.id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[library] bulk merge step failed:", err);
      }
    }
    selection.clear();
    if (opIds.length > 0) {
      setUndoToast({
        opIds,
        title: t("library.undoToast.mergeBulkTitle").replace("{{target}}", targetTitle),
        meta: t("library.undoToast.mergeBulkMeta").replace("{{count}}", String(opIds.length)),
      });
    }
  }, [selection, series]);

  const handleSelectAllVisible = useCallback(() => {
    selection.selectAll(visibleSeries.map((sr) => sr.id));
  }, [selection, visibleSeries]);

  const handleUndoMerge = useCallback(async () => {
    if (!undoToast) return;
    const ids = [...undoToast.opIds].reverse();
    for (const opId of ids) {
      try {
        await undoMerge({ db, opId });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[library] undo merge step failed:", err);
      }
    }
  }, [undoToast]);

  const reducedMotion = useReducedMotion();

  // §5.x — Q2 import-celebration trigger.
  const celebrationConsumedRef = useRef<ImportSummary | null>(null);
  const [celebrationKey, setCelebrationKey] = useState<number | null>(null);
  const [celebrationStats, setCelebrationStats] = useState({
    seriesCount: 0,
    episodeCount: 0,
  });

  useEffect(() => {
    if (!importSummary || importSummary === celebrationConsumedRef.current)
      return;
    celebrationConsumedRef.current = importSummary;
    setCelebrationStats({
      seriesCount: series.length,
      episodeCount: series.reduce(
        (sum, sr) =>
          sum +
          (typeof sr.totalEpisodes === "number" ? sr.totalEpisodes : 0),
        0,
      ),
    });
    setCelebrationKey(Date.now());
  }, [importSummary, series]);

  // §5.6 auto-merge toast.
  useEffect(() => {
    if (!importSummary || importSummary === consumedSummaryRef.current)
      return;
    consumedSummaryRef.current = importSummary;
    const merges = importSummary.crossFolderMerges || [];
    if (merges.length === 0) return;

    const entries = merges.map((m) => {
      const sr = series.find((s2) => s2.id === m.seriesId) ?? null;
      const title =
        sr?.titleZh || sr?.titleEn || sr?.titleJa || m.seriesId;
      const folderLabels = m.folders
        .map((f) => f.split("/").pop() || "/")
        .join(" · ");
      return {
        seriesId: m.seriesId,
        title,
        meta: t("library.undoToast.autoMergeMeta")
          .replace("{{folderCount}}", String(m.folders.length))
          .replace("{{folderLabels}}", folderLabels),
      };
    });
    setAutoMergeQueue((q) => [...q, ...entries]);
  }, [importSummary, series]);

  const currentAutoMerge = autoMergeQueue[0] ?? null;

  const handleAutoMergeView = useCallback(() => {
    if (!currentAutoMerge) return;
    router.push(
      `/player?seriesId=${encodeURIComponent(currentAutoMerge.seriesId)}`,
    );
  }, [currentAutoMerge, router]);

  const handleAutoMergeDismiss = useCallback(() => {
    setAutoMergeQueue((q) => q.slice(1));
  }, []);

  const handleSplitConfirm = useCallback(
    async ({ seasonIds, name }: { seasonIds: string[]; name: string }) => {
      if (!splitSourceId) return;
      try {
        await splitSeries({
          db,
          sourceSeriesId: splitSourceId,
          seasonIds,
          name,
          ulid,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[library] split failed:", err);
      } finally {
        setSplitSourceId(null);
      }
    },
    [splitSourceId],
  );

  const handleRematchConfirm = useCallback(
    async (payload: {
      animeId: number;
      titleZh?: string;
      titleEn?: string;
      posterUrl?: string;
      type?: "tv" | "movie" | "ova" | "web";
    }) => {
      if (!rematchSourceId) return;
      try {
        await rematchSeries({
          db,
          seriesId: rematchSourceId,
          animeId: payload.animeId,
          titleZh: payload.titleZh,
          titleEn: payload.titleEn,
          posterUrl: payload.posterUrl,
          type: payload.type,
          ulid,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[library] rematch failed:", err);
      } finally {
        setRematchSourceId(null);
      }
    },
    [rematchSourceId],
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleIgnoreUnclassified = useCallback(async (fileRef: any) => {
    if (!fileRef?.id) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).fileRefs.delete(fileRef.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[library] ignore unclassified failed:", err);
    }
  }, []);

  const handleResetLibrary = useCallback(async () => {
    const ok = window.confirm(t("library.confirm.resetLibrary"));
    if (!ok) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tables = db as any;
    await tables.transaction("rw", tables.tables, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await Promise.all(tables.tables.map((tbl: any) => tbl.clear()));
    });
  }, []);

  // Re-probe persisted FSA handles.
  const [availRefreshing, setAvailRefreshing] = useState(false);
  const handleRefreshAvailability = useCallback(async () => {
    if (availRefreshing) return;
    setAvailRefreshing(true);
    try {
      await refreshHandles();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[library] refresh handles failed:", err);
    } finally {
      setAvailRefreshing(false);
    }
  }, [refreshHandles, availRefreshing]);

  // Section-level reauthorize.
  const reauthorizableLibIds = useMemo<string[]>(() => {
    const ids: string[] = [];
    for (const [libId, st] of libraryStatus as Map<string, string>) {
      if (st !== "ready") ids.push(libId);
    }
    return ids;
  }, [libraryStatus]);
  const [availReauthorizing, setAvailReauthorizing] = useState(false);
  const handleReauthorizeAll = useCallback(async () => {
    if (availReauthorizing || reauthorizableLibIds.length === 0) return;
    setAvailReauthorizing(true);
    try {
      for (const libId of reauthorizableLibIds) {
        await reauthorizeHandle(libId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[library] reauthorize failed:", err);
    } finally {
      setAvailReauthorizing(false);
    }
  }, [availReauthorizing, reauthorizableLibIds, reauthorizeHandle]);

  // One-click "merge duplicates".
  const [dedupeBusy, setDedupeBusy] = useState(false);
  const handleDedupe = useCallback(async () => {
    if (dedupeBusy) return;
    setDedupeBusy(true);
    try {
      const result = await dedupeSeriesByAnimeId({ db });
      if (result.groups === 0) {
        toast.success(t("library.toast.dedupeNone"));
      } else if (result.merged === 0) {
        toast(
          t("library.toast.dedupeSkipped")
            .replace("{{groups}}", String(result.groups))
            .replace("{{skipped}}", String(result.skipped)),
        );
      } else {
        toast.success(
          t("library.toast.dedupeSuccess")
            .replace("{{merged}}", String(result.merged))
            .replace("{{groups}}", String(result.groups)),
        );
        if (result.opIds.length > 0) {
          setUndoToast({
            opIds: result.opIds,
            title: t("library.undoToast.dedupeBulkTitle").replace("{{count}}", String(result.merged)),
            meta: t("library.undoToast.dedupeBulkMeta").replace("{{groups}}", String(result.groups)),
          });
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[library] dedupe failed:", err);
      toast.error(t("library.toast.mergeFailed"));
    } finally {
      setDedupeBusy(false);
    }
  }, [dedupeBusy]);

  // Refresh enrichment (titleZh/titleEn/posterUrl) for every series.
  const [refreshingMeta, setRefreshingMeta] = useState(false);
  const handleRefreshMetadata = useCallback(async () => {
    if (refreshingMeta) return;
    setRefreshingMeta(true);
    const toastId = toast.loading(
      fmtTpl(t("library.refreshMetaProgress"), {
        done: 0,
        total: series.length,
      }),
    );
    try {
      const summary = await refreshAllSeriesMetadata({
        db,
        dandan,
        onProgress: (done, total, last) => {
          // eslint-disable-next-line no-console
          console.log("[refresh-meta]", last);
          toast.loading(
            fmtTpl(t("library.refreshMetaProgress"), { done, total }),
            { id: toastId },
          );
        },
      });

      const reasonCounts: Record<string, number> = {};
      for (const r of summary.results) {
        if (r.changed) continue;
        const key = r.skipReason || "unknown";
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
      const reasonStr = Object.entries(reasonCounts)
        .map(([k, v]) => `${k}:${v}`)
        .join(" / ");

      // eslint-disable-next-line no-console
      console.log("[refresh-meta] summary:", summary);

      if (summary.changed === 0) {
        toast.success(
          `${t("library.refreshMetaNothing")}${reasonStr ? ` · ${reasonStr}` : ""}`,
          { id: toastId, duration: 6000 },
        );
      } else {
        toast.success(
          fmtTpl(t("library.refreshMetaDone"), {
            changed: summary.changed,
            total: summary.total,
          }) + (reasonStr ? ` · ${reasonStr}` : ""),
          { id: toastId, duration: 6000 },
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      toast.error(
        fmtTpl(t("library.refreshMetaFailed"), { error: errMsg }),
        { id: toastId },
      );
    } finally {
      setRefreshingMeta(false);
    }
  }, [refreshingMeta, series.length, dandan, t]);

  const showEmptyState = !loading && series.length === 0;
  const showBanner = !fsaSupported;
  const totalEpisodes = useMemo(
    () =>
      series.reduce(
        (sum, sr) =>
          sum +
          (typeof sr.totalEpisodes === "number" ? sr.totalEpisodes : 0),
        0,
      ),
    [series],
  );

  return (
    <div style={s.page}>
      <style>{PRIVACY_PULSE_CSS}</style>
      {showBanner && <FsaUnsupportedBanner />}

      {selection.selectionMode ? (
        <BulkActionToolbar
          count={selection.count}
          onCancel={selection.clear}
          onSelectAll={handleSelectAllVisible}
          onMerge={handleBulkMerge}
          onDelete={handleBulkDelete}
        />
      ) : (
        <motion.header
          style={s.hudHeader}
          data-testid="library-hud-header"
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={reducedMotion ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          <CornerBrackets inset={-8} size={14} opacity={0.3} />
          <div style={s.hudHeaderInner}>
            <div style={s.hudKicker}>// 02 / LOCAL · MEDIA · LIBRARY //</div>
            <h1 style={s.hudTitle}>
              <span>
                {t("nav.library")}
                {` ${LOCAL_HEX_GLYPH}`}
              </span>
              <span style={s.hudTitleEn}>LIBRARY</span>
            </h1>
            <div style={s.hudSubtitle}>
              <span>
                <StatNum value={series.length} delay={0.2} style={s.hudNum} />
                &nbsp;series
              </span>
              {totalEpisodes > 0 && (
                <>
                  <span style={s.hudDot}>·</span>
                  <span>
                    <StatNum
                      value={totalEpisodes}
                      delay={0.3}
                      style={s.hudNum}
                    />
                    &nbsp;episodes
                  </span>
                </>
              )}
              <span style={s.hudDot}>·</span>
              <span style={s.hudPrivacy}>
                <span aria-hidden style={s.hudPrivacyDot} />
                stored on this device
              </span>
            </div>
            <div style={{ marginTop: 12 }}>
              <WatchRhythmStrip rhythm={watchRhythm} compact />
            </div>
          </div>
          <div style={s.hudActions}>
            {showAddBtn && (
              <button
                style={s.addBtn}
                onClick={handleAddFolder}
                type="button"
                data-testid="library-add-folder"
              >
                + {t("library.addFolder")}
              </button>
            )}
            {series.length > 0 && (
              <HudOverflowMenu
                testId="library-overflow"
                ariaLabel={t("library.overflow.moreActions")}
                items={[
                  ...(series.length > 1
                    ? [
                        {
                          id: "dedupe",
                          label: dedupeBusy
                            ? t("library.overflow.dedupeBusy")
                            : t("library.overflow.dedupe"),
                          onClick: handleDedupe,
                          disabled: dedupeBusy,
                          icon: "⇄",
                          testId: "library-dedupe",
                        },
                      ]
                    : []),
                  {
                    id: "refresh-meta",
                    label: refreshingMeta
                      ? t("library.overflow.refreshMetaBusy")
                      : t("library.refreshMeta"),
                    onClick: handleRefreshMetadata,
                    disabled: refreshingMeta,
                    icon: "↻",
                    testId: "library-refresh-meta",
                  },
                  {
                    id: "refresh-availability",
                    label: availRefreshing
                      ? t("library.overflow.refreshAvailBusy")
                      : t("library.overflow.refreshAvail"),
                    onClick: handleRefreshAvailability,
                    disabled: availRefreshing,
                    icon: "⌐",
                    testId: "library-refresh-availability",
                  },
                  {
                    id: "reset",
                    label: t("library.overflow.reset"),
                    onClick: handleResetLibrary,
                    danger: true,
                    divideBefore: true,
                    icon: "⊘",
                    testId: "library-reset",
                  },
                ]}
              />
            )}
          </div>
        </motion.header>
      )}

      {showEmptyState ? (
        fsaSupported ? (
          <DropZone onPick={handleAddFolder} isFsaSupported={fsaSupported} />
        ) : (
          <LibraryEmptyState
            onAddFolder={handleAddFolder}
            isFsaSupported={fsaSupported}
          />
        )
      ) : (
        <>
          {series.length >= ROWS_THRESHOLD &&
            (availabilityReady ? (
              <>
                <RecentlyPlayedRow
                  entries={resumeEntries}
                  onPlay={handleResume}
                  availabilityBySeries={availabilityBySeries}
                />
                <NewAdditionsRow
                  series={series}
                  onPickSeries={handlePickSeries}
                  availabilityBySeries={availabilityBySeries}
                />
              </>
            ) : (
              <>
                <ScrollRow
                  label={t("library.row.continueWatching")}
                  testId="row-recently-played-skeleton"
                >
                  {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                    <SeriesCardSkeleton key={`rp-skel-${i}`} compact />
                  ))}
                </ScrollRow>
                <ScrollRow
                  label={t("library.row.newAdditions")}
                  testId="row-new-additions-skeleton"
                >
                  {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                    <SeriesCardSkeleton key={`na-skel-${i}`} compact />
                  ))}
                </ScrollRow>
              </>
            ))}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <FilterChips
              active={activeFilter}
              counts={filterCounts}
              onChange={setActiveFilter}
            />
            <span style={{ flex: 1 }} />
            <SearchBar
              ref={searchRef}
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </div>
          {!availabilityReady ? (
            <div style={SKELETON_GRID_STYLE} data-testid="library-grid-skeleton">
              {Array.from({ length: SKELETON_GRID_COUNT }).map((_, i) => (
                <SeriesCardSkeleton key={`grid-skel-${i}`} />
              ))}
            </div>
          ) : (activeFilter || searchQuery) && mainGridSeries.length === 0 ? (
            <div
              style={{
                ...mono,
                padding: "32px 16px",
                textAlign: "center",
                color: "rgba(235,235,245,0.45)",
                fontSize: 11,
                letterSpacing: "0.10em",
                textTransform: "uppercase",
                border: `1px dashed oklch(46% 0.06 ${HUE} / 0.30)`,
                borderRadius: 4,
              }}
              data-testid="library-filter-empty"
            >
              {"// NO MATCHES //"}
            </div>
          ) : (
            <SeriesGrid
              series={mainGridSeries}
              onPickSeries={handlePickSeries}
              overrides={overrides}
              progressMap={progressMap}
              onOverrideAction={handleOverrideAction}
              selectionMode={selection.selectionMode}
              selectedIds={new Set(selection.ids)}
              onToggleSelect={(id: string) => selection.toggle(id)}
              onLongPress={(id: string) => selection.toggle(id)}
              availabilityBySeries={availabilityBySeries}
            />
          )}
          <UnavailableSeriesSection
            series={unavailableSeries}
            availabilityBySeries={availabilityBySeries}
            onRefresh={handleRefreshAvailability}
            onReauthorize={
              reauthorizableLibIds.length > 0
                ? handleReauthorizeAll
                : undefined
            }
            onPickSeries={handlePickSeries}
            onDelete={(seriesId: string) =>
              handleOverrideAction(seriesId, "delete")
            }
            refreshing={availRefreshing}
            reauthorizing={availReauthorizing}
          />
          <UnclassifiedSection
            entries={unclassifiedEntries}
            defaultOpen
            onIgnore={handleIgnoreUnclassified}
          />
        </>
      )}

      {!importDismissed && importStatus !== "idle" && (
        // P6 type widen: ImportDrawer (subagent B) has its own
        // ImportProgress/ImportSummary interfaces that differ slightly
        // from @/lib/library/types (subagent C's source). Widening to
        // any at the call site preserves runtime parity until P6.9
        // pulls the two interface definitions into one canonical type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <ImportDrawer
          status={importStatus}
          progress={importProgress as any}
          summary={importSummary as any}
          error={importError}
          onCancel={cancelImport}
          onDismiss={() => setImportDismissed(true)}
        />
      )}

      {importDismissed && (
        <ImportMiniPill
          status={importStatus}
          progress={importProgress}
          summary={importSummary}
          onExpand={() => setImportDismissed(false)}
        />
      )}

      {mergeSource && (
        <MergeDialog
          open
          sourceSeries={mergeSource}
          allSeries={series}
          onClose={() => setMergeSourceId(null)}
          onConfirm={handleMergeConfirm}
        />
      )}

      {splitSource && (
        <SplitDialog
          open
          sourceSeries={splitSource}
          seasons={splitSeasons}
          onClose={() => setSplitSourceId(null)}
          onConfirm={handleSplitConfirm}
        />
      )}

      {rematchSource && (
        <RematchDialog
          open
          sourceSeries={rematchSource}
          onClose={() => setRematchSourceId(null)}
          onConfirm={handleRematchConfirm}
        />
      )}

      <HudCelebration
        triggerKey={celebrationKey}
        seriesCount={celebrationStats.seriesCount}
        episodeCount={celebrationStats.episodeCount}
        onComplete={() => setCelebrationKey(null)}
      />

      {detailSeriesId &&
        (() => {
          const target = series.find((sr) => sr.id === detailSeriesId);
          if (!target) return null;
          return (
            <SeriesDetailSheet
              series={target}
              onClose={() => setDetailSeriesId(null)}
              onPickEpisode={handlePickEpisode}
              onPlaySeries={handlePlaySeries}
            />
          );
        })()}

      {undoToast ? (
        <UndoToast
          open
          title={undoToast.title}
          meta={undoToast.meta}
          onUndo={handleUndoMerge}
          onDismiss={() => setUndoToast(null)}
        />
      ) : currentAutoMerge ? (
        <UndoToast
          open
          key={currentAutoMerge.seriesId}
          testId="auto-merge-toast"
          title={currentAutoMerge.title}
          meta={currentAutoMerge.meta}
          onView={handleAutoMergeView}
          onDismiss={handleAutoMergeDismiss}
        />
      ) : null}
    </div>
  );
}
