"use client";

/**
 * PlayerShell — P6.6 ported entry shell for `/player`. Replaces the P6.5
 * placeholder that just read `?seriesId&fileId&resumeEpisode`.
 *
 * Ports legacy client/src/pages/PlayerPage.jsx (962 LOC) into next-app
 * with three transport rewrites:
 *   1. react-router-dom `useLocation().state` → `useSearchParams()`
 *   2. `useNavigate()` → `useRouter().push()`
 *   3. axios call sites → fetch() via the underlying hooks
 *
 * Supports BOTH entry modes (parity port):
 *   - Library hand-off: `?seriesId=&resumeEpisode=` → loads Series + Episodes
 *     + FileRefs from Dexie, auto-matches against dandanplay, auto-resumes
 *     a specific episode when resumeEpisode is set.
 *   - Drop-zone: `/player` with no params → DropZone surface; on drop, the
 *     matching pipeline (useDandanMatch) takes over.
 */

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type CSSProperties,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import toast from "react-hot-toast";

import { useLang } from "@/lib/lang-client";
import {
  ChapterBar,
  CornerBrackets,
  SectionNum,
} from "@/components/landing/shared/hud";
import { mono, PLAYER_HUE } from "@/components/landing/shared/hud-tokens";

// Library lib (P6.2 ported)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module with JSDoc types
import { db } from "@/lib/library/db/db.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { createHashPool } from "@/lib/library/hashPool.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { groupByFolder } from "@/lib/library/grouping.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {
  episodeListFromSeriesDetail,
  isWatchableKind,
} from "@/lib/library/buildLibraryMatchResult.js";
import { flattenDropFiles } from "@/lib/dropFiles";

// Library-owned hooks reused here (P6.4 ports — already in tree)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module
import { useFileHandles } from "@/app/library/_hooks/useFileHandles";
import { useSeriesDetail } from "@/app/library/_hooks/useSeriesDetail";
import { useVideoFiles } from "@/app/library/_hooks/useVideoFiles";

// Player-surface hooks
import { useDandanMatch } from "../_hooks/useDandanMatch";
// Subagent B's hooks — must exist before the page mounts. While B is still
// running these imports will fail tsc; PlayerShell's own errors should
// drop to zero once those land.
import { useDandanComments } from "../_hooks/useDandanComments";
import { usePlaybackSession } from "../_hooks/usePlaybackSession";

// Library-owned component reused here
import { LibraryAccessEmpty } from "@/app/library/_components/LibraryAccessEmpty";

// Subagent A's files
import { VideoPlayer } from "./VideoPlayer"; // eslint-disable-line @typescript-eslint/no-unused-vars

// Subagent B's player components
import { EpisodeFileList } from "./EpisodeFileList";
import { EpisodeNav } from "./EpisodeNav";
import { MatchProgress } from "./MatchProgress";
import { DropZone } from "./DropZone";

// Player components owned by this subagent
import { ManualSearch } from "./ManualSearch";
import { DanmakuPicker } from "./DanmakuPicker";
import { PlayerHudFrame } from "./PlayerHudFrame";
import { HeatmapTuner } from "./HeatmapTuner";

const FADE_UP_CSS = `@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`;
const fadeUp: CSSProperties = {
  animation: "fadeUp 300ms cubic-bezier(0.4,0,0.2,1) both",
};

const HUE = PLAYER_HUE.stream;
const HUE_DANMAKU = PLAYER_HUE.ingest;

// Tiny `{{var}}` interpolation for toast strings — t() doesn't support it.
// Param renamed `tpl` so it doesn't shadow the module-level `s` styles object.
function fmtTpl(tpl: string, vars: Record<string, string | number>): string {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}

function fmtMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function isMobile(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth <= 600;
}

const s = {
  page: { minHeight: "calc(100vh - 56px)", padding: "0 24px 48px" } as CSSProperties,
  mobile: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "calc(100vh - 56px)",
    color: "rgba(235,235,245,0.60)",
    textAlign: "center",
    gap: 16,
    padding: 24,
  } as CSSProperties,
  mobileTitle: {
    fontFamily: "'Sora',sans-serif",
    fontWeight: 600,
    fontSize: 20,
    color: "#ffffff",
  } as CSSProperties,
  playHeader: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    gap: 24,
    maxWidth: 1400,
    margin: "16px auto 12px",
    padding: "20px 28px 20px 56px",
    background: `linear-gradient(180deg, oklch(14% 0.04 ${HUE} / 0.55) 0%, rgba(20,20,22,0.55) 100%)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.36)`,
    borderRadius: 4,
  } as CSSProperties,
  epEyebrow: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    marginBottom: 6,
  } as CSSProperties,
  epTitle: {
    fontFamily: "'Sora',sans-serif",
    fontWeight: 600,
    fontSize: 18,
    color: "#ffffff",
    letterSpacing: "-0.01em",
    lineHeight: 1.25,
  } as CSSProperties,
  epSubtitle: {
    fontSize: 13,
    color: "rgba(235,235,245,0.45)",
    marginTop: 4,
    fontFamily: "'JetBrains Mono',monospace",
    letterSpacing: "0.04em",
  } as CSSProperties,
  danmakuChip: {
    ...mono,
    padding: "5px 12px",
    borderRadius: 9999,
    fontSize: 11,
    background: `oklch(62% 0.19 ${HUE} / 0.10)`,
    color: `oklch(78% 0.15 ${HUE})`,
    border: `1px solid oklch(62% 0.19 ${HUE} / 0.28)`,
    letterSpacing: "0.10em",
  } as CSSProperties,
  loadingChip: {
    ...mono,
    padding: "5px 12px",
    borderRadius: 9999,
    fontSize: 11,
    background: "rgba(235,235,245,0.06)",
    color: "rgba(235,235,245,0.55)",
    border: "1px solid rgba(235,235,245,0.16)",
    letterSpacing: "0.10em",
  } as CSSProperties,
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  } as CSSProperties,
  playerWrap: { maxWidth: 1400, margin: "0 auto" } as CSSProperties,
  danmakuInfo: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.30)",
    textAlign: "center",
    padding: "8px 0",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
  } as CSSProperties,
  errorBox: {
    maxWidth: 600,
    margin: "64px auto",
    textAlign: "center",
    padding: 48,
    color: "rgba(235,235,245,0.60)",
  } as CSSProperties,
  errorTitle: {
    fontSize: 18,
    fontWeight: 600,
    color: "#ff453a",
    marginBottom: 12,
  } as CSSProperties,
  retryBtn: {
    marginTop: 16,
    padding: "10px 20px",
    borderRadius: 8,
    background: "#0a84ff",
    color: "#fff",
    border: "none",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  } as CSSProperties,
  dropOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 9000,
    background: `oklch(14% 0.04 ${HUE_DANMAKU} / 0.78)`,
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  } as CSSProperties,
  dropOverlayInner: {
    border: `2px dashed oklch(72% 0.19 ${HUE_DANMAKU})`,
    borderRadius: 4,
    padding: "64px 96px",
    textAlign: "center",
    background: `oklch(14% 0.04 ${HUE_DANMAKU} / 0.55)`,
  } as CSSProperties,
  dropOverlayEyebrow: {
    ...mono,
    fontSize: 11,
    color: `oklch(78% 0.15 ${HUE_DANMAKU})`,
    textTransform: "uppercase",
    letterSpacing: "0.20em",
    marginBottom: 12,
  } as CSSProperties,
  dropOverlayTitle: {
    fontFamily: "'Sora',sans-serif",
    fontWeight: 700,
    fontSize: 28,
    color: "#fff",
    letterSpacing: "-0.01em",
  } as CSSProperties,
  backBtn: (hover: boolean): CSSProperties => ({
    position: "relative",
    background: hover ? `oklch(62% 0.19 ${HUE} / 0.10)` : "transparent",
    border: `1px solid oklch(46% 0.06 ${HUE} / ${hover ? 0.65 : 0.4})`,
    borderRadius: 2,
    padding: "8px 14px",
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: hover ? "#fff" : "rgba(235,235,245,0.75)",
    cursor: "pointer",
    transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
    overflow: "visible",
  }),
  danmakuBtn: (hover: boolean): CSSProperties => ({
    background: hover
      ? `oklch(62% 0.19 ${HUE_DANMAKU} / 0.12)`
      : "transparent",
    border: `1px solid oklch(62% 0.19 ${HUE_DANMAKU} / ${hover ? 0.55 : 0.32})`,
    borderRadius: 2,
    padding: "7px 14px",
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: hover
      ? `oklch(78% 0.15 ${HUE_DANMAKU})`
      : `oklch(72% 0.15 ${HUE_DANMAKU} / 0.85)`,
    cursor: "pointer",
    transition: "all 150ms",
  }),
};

interface HudBackButtonProps {
  onClick: () => void;
  label: string;
}

function HudBackButton({ onClick, label }: HudBackButtonProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      style={s.backBtn(hover)}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <CornerBrackets
        show={hover}
        animate
        inset={-3}
        size={6}
        opacity={0.5}
        hue={PLAYER_HUE.stream}
      />
      ← {label}
    </button>
  );
}

function HudDanmakuButton({ onClick, label }: HudBackButtonProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      style={s.danmakuBtn(hover)}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      DANMAKU // {label}
    </button>
  );
}

// Dev-mode gate for HeatmapTuner. Matches legacy localStorage flag.
function isDevModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem("animego.devMode") === "1";
  } catch {
    return false;
  }
}

// Loose shape — VideoPlayer (Subagent A) defines the canonical type. Players
// pass these around verbatim; treating as `any` here keeps PlayerShell
// independent of that file's typing decisions.
/* eslint-disable @typescript-eslint/no-explicit-any */
type FileItem = any;

function PlayerShellInner() {
  const { t } = useLang();
  // P3: library mode entry — read seriesId + optional resumeEpisode from URL
  // search params (next/navigation), replacing react-router-dom location.state.
  const sp = useSearchParams();
  const router = useRouter();
  const locationSeriesId = sp.get("seriesId");
  const resumeEpisodeRaw = sp.get("resumeEpisode");
  const locationResumeEpisode = useMemo(() => {
    if (resumeEpisodeRaw == null) return null;
    const n = Number(resumeEpisodeRaw);
    return Number.isFinite(n) ? n : null;
  }, [resumeEpisodeRaw]);

  const fileHandles = useFileHandles({ db });
  const seriesDetail = useSeriesDetail(locationSeriesId, { db, fileHandles });

  // Becomes true once a library getFile() returns null while permissions are
  // denied — drives the empty-state switch even before the next render reads
  // fileHandles.status. Reset on seriesId / refresh.
  const [denialDetected, setDenialDetected] = useState(false);
  useEffect(() => {
    setDenialDetected(false);
  }, [locationSeriesId]);

  const {
    videoFiles,
    keyword,
    processFiles,
    getVideoUrl,
    getSubtitleUrl,
    clear: clearFiles,
  } = useVideoFiles();
  const {
    phase,
    stepStatus,
    matchResult,
    error,
    startMatch,
    selectManual,
    reset: resetMatch,
    updateEpisodeMap,
  } = useDandanMatch();
  const {
    danmakuList,
    count: danmakuCount,
    loading: loadingDanmaku,
    loadComments,
    clearComments,
  } = useDandanComments();
  const playback = usePlaybackSession({
    getVideoUrl,
    getSubtitleUrl,
    loadComments,
    clearComments,
  });
  const {
    phase: playbackPhase,
    playingFile,
    playingEp,
    videoUrl,
    subtitleUrl,
    subtitleType,
    subtitleContent,
    play: startPlayback,
    back: stopPlayback,
    resumeAt,
    setLastTime,
  } = playback;

  const [pickerEp, setPickerEp] = useState<number | null>(null);
  const [isMobileView, setIsMobileView] = useState<boolean>(isMobile);
  const [devMode, setDevMode] = useState(false);

  useEffect(() => {
    setDevMode(isDevModeEnabled());
  }, []);

  useEffect(() => {
    const onResize = () => setIsMobileView(isMobile());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const hashPoolRef = useRef<ReturnType<typeof createHashPool> | null>(null);
  useEffect(() => {
    hashPoolRef.current = createHashPool();
    return () => {
      hashPoolRef.current?.dispose();
      hashPoolRef.current = null;
    };
  }, []);

  // Determine current UI state — playback overlays match phase
  const uiPhase = playbackPhase === "playing" ? "playing" : phase;

  // P2: same-folder grouping. Multi-folder drops auto-pick the largest group.
  // `groupByFolder` is a JS module with JSDoc EpisodeItem types — its input
  // shape is structurally compatible with useVideoFiles' ParsedEpisodeItem but
  // tsc can't see that across module boundaries. Cast to `any` at the call
  // site; downstream code keeps the loose `FileItem` (= any) alias.
  const groups: any[] = useMemo(
    () => groupByFolder(videoFiles as any),
    [videoFiles],
  );
  const dropZoneItems: FileItem[] = groups[0]?.items ?? videoFiles;
  const skippedFileCount = useMemo(
    () => groups.slice(1).reduce((n: number, g: any) => n + g.items.length, 0),
    [groups],
  );

  // Library mode pickedItems — episode rows derived from IDB.
  // `episodeListFromSeriesDetail` accepts the IDB Episode + FileRef shapes;
  // useSeriesDetail's TS-typed records are structurally compatible. Cast to
  // `any` to bridge the JSDoc-to-TS boundary.
  const libraryVideoFiles: FileItem[] = useMemo(() => {
    if (!locationSeriesId || seriesDetail.status !== "ready") return [];
    return episodeListFromSeriesDetail(
      seriesDetail.episodes as any,
      seriesDetail.fileRefByEpisode as any,
    );
  }, [locationSeriesId, seriesDetail]);

  // pickedItems unifies the rendered file list across both entry paths so
  // EpisodeFileList sees the same shape regardless of how matchResult arrived.
  const pickedItems: FileItem[] = locationSeriesId
    ? libraryVideoFiles
    : dropZoneItems;

  // Split BD/DVD extras off the main list. Mirrors legacy splitting logic.
  const [pickedMainFiles, pickedSupplementaryFiles] = useMemo(() => {
    const main: FileItem[] = [];
    const sup: FileItem[] = [];
    for (const f of pickedItems) {
      (isWatchableKind(f.parsedKind) ? main : sup).push(f);
    }
    return [main, sup];
  }, [pickedItems]);

  // Episode numbers from matched files. Restricted to watchable kinds AND
  // deduped before producing chip numbers.
  const episodes: number[] = useMemo(() => {
    if (!matchResult?.episodeMap) return [];
    const seen = new Set<number>();
    for (const f of pickedItems) {
      if (f.episode == null) continue;
      if (!isWatchableKind(f.parsedKind)) continue;
      if (!matchResult.episodeMap[f.episode]) continue;
      seen.add(f.episode);
    }
    return [...seen].sort((a, b) => a - b);
  }, [pickedItems, matchResult]);

  // Toast on multi-folder auto-pick. Fires once per groups identity.
  const lastGroupsKey = useRef<string | null>(null);
  useEffect(() => {
    if (!groups.length) {
      lastGroupsKey.current = null;
      return;
    }
    const key = groups.map((g: any) => `${g.groupKey}:${g.items.length}`).join("|");
    if (lastGroupsKey.current === key) return;
    lastGroupsKey.current = key;
    if (groups.length > 1) {
      const picked = groups[0];
      const labelText =
        picked.groupKey === "__root__" ? t("player.rootFolder") : picked.label;
      toast(
        fmtTpl(t("player.multiFolderToast"), {
          label: labelText,
          picked: picked.items.length,
          others: skippedFileCount,
        }),
      );
    }
    if (groups[0]?.hasAmbiguity) {
      toast(t("player.alphaFallbackToast"));
    }
  }, [groups, skippedFileCount, t]);

  // Stable per-episode key for progress memory (localStorage).
  const progressKey = useMemo<string | null>(() => {
    if (playingEp == null || !matchResult?.anime) return null;
    const anime = matchResult.anime;
    const id = anime.anilistId || anime.dandanAnimeId || anime.bgmId;
    if (!id) return null;
    const suffix = playingFile?.parsedKind === "commentary" ? ":commentary" : "";
    return `animego:progress:${id}:${playingEp}${suffix}`;
  }, [playingEp, playingFile, matchResult]);

  const handleFiles = useCallback(
    async (fileList: FileList | File[], opts: { mode?: "append" | "replace" } = {}) => {
      const mode = opts.mode || "append";
      const { files, keyword: kw } = processFiles(fileList, { mode });
      if (!files.length) {
        toast.error(t("player.noVideos"));
        return;
      }

      const epNums: number[] = files
        .map((f: any) => f.episode)
        .filter(Boolean);
      const firstFile = files[0]?.fileName || "";

      const pool = hashPoolRef.current;
      const getFilesHashes = async () => {
        if (!pool) {
          return files.map((f: any) => ({
            fileName: f.fileName,
            episode: f.episode,
            fileHash: "",
            fileSize: f.file.size,
          }));
        }
        const results = await Promise.all(
          files.map(async (f: any) => ({
            fileName: f.fileName,
            episode: f.episode,
            fileHash: await pool.hash(f.file),
            fileSize: f.file.size,
          })),
        );
        return results;
      };

      const basicFiles = files.map((f: any) => ({
        fileName: f.fileName,
        episode: f.episode,
        fileSize: f.file.size,
      }));
      startMatch(kw, epNums, firstFile, basicFiles, getFilesHashes);
    },
    [processFiles, startMatch, t],
  );

  const handlePlay = useCallback(
    (fileItem: FileItem) => {
      startPlayback(fileItem, matchResult?.episodeMap);
    },
    [startPlayback, matchResult],
  );

  // P2: throttled progress tick. playingFile read via ref so the throttled
  // callback in VideoPlayer never sees a stale fileId during the one-render
  // window before its ref syncs.
  const playingFileIdRef = useRef<string | null>(null);
  useEffect(() => {
    playingFileIdRef.current = playingFile?.fileId ?? null;
  }, [playingFile]);
  const handleProgressTick = useCallback(
    (sec: number) => {
      const id = playingFileIdRef.current;
      if (id) setLastTime(id, sec);
    },
    [setLastTime],
  );

  // P2: resume toast — fires once per play() that actually resumes (>0).
  const lastResumeToastForFile = useRef<string | null>(null);
  useEffect(() => {
    if (!playingFile || !resumeAt || progressKey) return;
    if (lastResumeToastForFile.current === playingFile.fileId) return;
    lastResumeToastForFile.current = playingFile.fileId;
    toast(fmtTpl(t("player.resumedAt"), { time: fmtMmSs(resumeAt) }));
  }, [playingFile, resumeAt, progressKey, t]);

  const handleEpisodeSwitch = useCallback(
    (epNum: number) => {
      const fileItem = pickedItems.find(
        (f: any) => f.episode === epNum && isWatchableKind(f.parsedKind),
      );
      if (fileItem) startPlayback(fileItem, matchResult?.episodeMap);
    },
    [pickedItems, startPlayback, matchResult],
  );

  const handleBackToList = useCallback(() => {
    lastResumeToastForFile.current = null;
    stopPlayback();
  }, [stopPlayback]);

  const handleClearAll = useCallback(() => {
    stopPlayback();
    clearFiles();
    resetMatch();
  }, [stopPlayback, clearFiles, resetMatch]);

  // P3: library mode — sorted episode numbers used by EpisodeNav prev/next.
  const libraryEpisodeNumbers = useMemo<number[]>(() => {
    if (!locationSeriesId || seriesDetail.status !== "ready") return [];
    const seen = new Set<number>();
    for (const e of seriesDetail.episodes) {
      if (e.number == null) continue;
      if (!isWatchableKind(e.kind)) continue;
      seen.add(e.number);
    }
    return [...seen].sort((a, b) => a - b);
  }, [locationSeriesId, seriesDetail]);

  // Library auto-match — when seriesDetail becomes ready, fire startMatch().
  const libraryMatchedRef = useRef<string | null>(null);
  useEffect(() => {
    libraryMatchedRef.current = null;
  }, [locationSeriesId]);
  useEffect(() => {
    if (!locationSeriesId) return;
    if (seriesDetail.status !== "ready") return;
    if (libraryVideoFiles.length === 0) return;
    if (matchResult) return;
    if (libraryMatchedRef.current === locationSeriesId) return;

    libraryMatchedRef.current = locationSeriesId;

    const matchInputFiles = libraryVideoFiles.filter((f: any) =>
      isWatchableKind(f.parsedKind),
    );
    const epNums = matchInputFiles
      .map((f: any) => f.episode)
      .filter(Boolean) as number[];
    const firstName = matchInputFiles[0]?.fileName || "";
    const basicFiles = matchInputFiles.map((f: any) => ({
      fileName: f.fileName,
      episode: f.episode,
      fileSize: f._fileRef?.size ?? 0,
    }));
    const getFilesHashes = async () =>
      matchInputFiles.map((f: any) => ({
        fileName: f.fileName,
        episode: f.episode,
        fileHash: f._fileRef?.hash16M ?? "",
        fileSize: f._fileRef?.size ?? 0,
      }));

    const series = seriesDetail.series;
    // Keyword fallback chain matches legacy PlayerPage.jsx: title fields
    // are populated by importPipeline ONLY when dandanplay enrichment
    // succeeded at import time. When it didn't, the series record is
    // bare and titleZh/En/Ja are all empty -- in that case fall through
    // to series.name (the parsed series folder name) and finally the
    // first filename so dandanplay has SOMETHING to match against. An
    // empty keyword + filename guarantees matched:false and the user
    // never sees ManualSearch because phase races to "ready" anyway.
    const kw =
      series?.titleZh ||
      series?.titleEn ||
      series?.titleJa ||
      (series as { name?: string } | undefined)?.name ||
      firstName ||
      "";

    startMatch(kw, epNums, firstName, basicFiles, getFilesHashes);
  }, [
    locationSeriesId,
    seriesDetail.status,
    seriesDetail.series,
    libraryVideoFiles,
    matchResult,
    startMatch,
  ]);

  // Race-condition guard: user can click an episode BEFORE auto-match
  // completes. startPlayback then runs with an empty episodeMap and
  // loadComments never fires. When matchResult later lands with a
  // dandanEpisodeId for the currently-playing episode, retry the
  // comments fetch so the danmaku overlay catches up automatically.
  const danmakuRetryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!matchResult?.episodeMap) return;
    if (playbackPhase !== "playing") return;
    if (playingEp == null) return;
    const entry = matchResult.episodeMap[playingEp];
    const eid = entry?.dandanEpisodeId;
    if (!eid) return;
    const retryKey = `${playingFile?.fileId ?? ""}:${eid}`;
    if (danmakuRetryRef.current === retryKey) return;
    danmakuRetryRef.current = retryKey;
    loadComments(eid);
  }, [matchResult, playbackPhase, playingEp, playingFile, loadComments]);


  // P3: library mode — episode click handler
  const handleLibraryEpisodePlay = useCallback(
    async (episodeId: string) => {
      const file = await seriesDetail.getFile(episodeId);
      if (!file) {
        if (fileHandles.status === "denied") {
          setDenialDetected(true);
        } else {
          toast.error(t("library.fileMissing"));
        }
        return;
      }
      const ep = seriesDetail.episodes.find((e: any) => e.id === episodeId);
      const fileRef = seriesDetail.fileRefByEpisode.get(episodeId);
      if (!ep || !fileRef) return;

      // Prefer server-shaped matchResult.episodeMap when auto-match has landed;
      // fall back to a synthesis from IDB Episode.episodeId.
      let episodeMap: Record<number, any>;
      if (matchResult?.episodeMap) {
        episodeMap = matchResult.episodeMap;
      } else {
        episodeMap = {};
        for (const e of seriesDetail.episodes) {
          if (e.number == null || e.kind === "commentary") continue;
          episodeMap[e.number] = { dandanEpisodeId: e.episodeId };
        }
      }

      const fileItem = {
        fileId: fileRef.id,
        file,
        fileName:
          fileRef.relPath.split("/").pop() || fileRef.relPath,
        relativePath: fileRef.relPath,
        episode: ep.number,
        parsedKind: ep.kind || "main",
      };

      startPlayback(fileItem, episodeMap);
    },
    [seriesDetail, startPlayback, t, fileHandles.status, matchResult],
  );

  // Library mode empty-state derivations.
  const libraryEmptyKind = useMemo<
    "loading" | "missing" | "error" | "denied" | null
  >(() => {
    if (!locationSeriesId) return null;
    if (seriesDetail.status === "loading") return "loading";
    if (seriesDetail.status === "missing") return "missing";
    if (seriesDetail.status === "error") return "error";
    if (
      seriesDetail.status === "ready" &&
      (fileHandles.status === "denied" || denialDetected)
    ) {
      return "denied";
    }
    return null;
  }, [
    locationSeriesId,
    seriesDetail.status,
    fileHandles.status,
    denialDetected,
  ]);

  const libraryIdsForReauth = useMemo<string[]>(() => {
    const ids = new Set<string>();
    for (const ref of seriesDetail.fileRefByEpisode.values()) {
      if (ref?.libraryId) ids.add(ref.libraryId);
    }
    return Array.from(ids);
  }, [seriesDetail.fileRefByEpisode]);

  const handleReauthorize = useCallback(async () => {
    for (const libId of libraryIdsForReauth) {
      await fileHandles.reauthorize(libId);
    }
    setDenialDetected(false);
    seriesDetail.refresh();
  }, [fileHandles, libraryIdsForReauth, seriesDetail]);

  const handleBackToLibrary = useCallback(() => {
    router.push("/library");
  }, [router]);

  // Library mode "back" — exit the player and return to the library grid.
  const handleBackToLibraryGrid = useCallback(() => {
    router.push("/library");
  }, [router]);

  // Unified click handler for EpisodeFileList rows.
  const handleListPlay = useCallback(
    (fileItem: FileItem) => {
      if (fileItem?._episodeId) {
        handleLibraryEpisodePlay(fileItem._episodeId);
        return;
      }
      handlePlay(fileItem);
    },
    [handlePlay, handleLibraryEpisodePlay],
  );

  const handleRetryLoad = useCallback(() => {
    seriesDetail.refresh();
  }, [seriesDetail]);

  // P3: library mode prev/next — switch by episode number.
  const handleLibraryEpisodeSwitchByNumber = useCallback(
    (epNum: number) => {
      if (!locationSeriesId) return;
      const ep =
        seriesDetail.episodes.find(
          (e: any) => e.number === epNum && e.kind === "main",
        ) ??
        seriesDetail.episodes.find(
          (e: any) => e.number === epNum && isWatchableKind(e.kind),
        );
      if (!ep) return;
      handleLibraryEpisodePlay(ep.id);
    },
    [locationSeriesId, seriesDetail, handleLibraryEpisodePlay],
  );

  // P3: auto-play state.resumeEpisode when seriesDetail becomes ready.
  const [autoResumeAttempted, setAutoResumeAttempted] = useState(false);
  useEffect(() => {
    if (!locationSeriesId || locationResumeEpisode == null) return;
    if (seriesDetail.status !== "ready") return;
    if (libraryEmptyKind) return;
    if (playbackPhase === "playing") return;
    if (autoResumeAttempted) return;
    const ep =
      seriesDetail.episodes.find(
        (e: any) =>
          e.number === locationResumeEpisode && e.kind === "main",
      ) ??
      seriesDetail.episodes.find(
        (e: any) =>
          e.number === locationResumeEpisode && isWatchableKind(e.kind),
      );
    setAutoResumeAttempted(true);
    if (!ep) return;
    handleLibraryEpisodePlay(ep.id);
  }, [
    locationSeriesId,
    locationResumeEpisode,
    seriesDetail,
    playbackPhase,
    autoResumeAttempted,
    handleLibraryEpisodePlay,
    libraryEmptyKind,
  ]);

  // Page-level drag/drop. The inner DropZone only renders in idle phase, so
  // dragging files onto the page when match is ready/playing/manual/error
  // would otherwise be silently ignored.
  const [pageDragging, setPageDragging] = useState(false);
  const dragCounter = useRef(0);

  const handlePageDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
      e.preventDefault();
      dragCounter.current += 1;
      if (uiPhase !== "idle") setPageDragging(true);
    },
    [uiPhase],
  );

  const handlePageDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();
  }, []);

  const handlePageDragLeave = useCallback(() => {
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setPageDragging(false);
  }, []);

  const handlePageDrop = useCallback(
    async (e: React.DragEvent) => {
      dragCounter.current = 0;
      setPageDragging(false);
      // In idle, DropZone handles its own drop via stopPropagation.
      if (uiPhase === "idle") return;
      e.preventDefault();
      const files = await flattenDropFiles(e.dataTransfer);
      if (!files.length) return;
      stopPlayback();
      resetMatch();
      handleFiles(files, { mode: "replace" });
    },
    [uiPhase, stopPlayback, resetMatch, handleFiles],
  );

  const handleManualSelect = useCallback(
    (anime: any) => {
      const epNums = pickedItems
        .filter((f: any) => isWatchableKind(f.parsedKind))
        .map((f: any) => f.episode)
        .filter(Boolean) as number[];
      selectManual(anime, epNums);
    },
    [pickedItems, selectManual],
  );

  const handleUpdateDanmaku = useCallback(
    async (epNum: number, data: any, newAnime: any) => {
      updateEpisodeMap(epNum, data, newAnime);
      if (locationSeriesId && data?.dandanEpisodeId) {
        const target =
          seriesDetail.episodes.find(
            (e: any) => e.number === epNum && e.kind === "main",
          ) ??
          seriesDetail.episodes.find(
            (e: any) => e.number === epNum && isWatchableKind(e.kind),
          );
        if (target) {
          try {
            // `db.episodes` is a Dexie table — db.js exports it as a generic
            // Dexie instance via JSDoc, so tsc doesn't see the .episodes
            // table. Cast through any to access it like the legacy code did.
            await (db as any).episodes.update(target.id, {
              episodeId: data.dandanEpisodeId,
              updatedAt: Date.now(),
            });
            seriesDetail.refresh();
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[player] failed to persist danmaku update:", err);
          }
        }
      }
      if (playingEp === epNum && data.dandanEpisodeId) {
        loadComments(data.dandanEpisodeId);
      }
      toast.success(t("player.danmakuUpdated"));
    },
    [
      locationSeriesId,
      seriesDetail,
      updateEpisodeMap,
      playingEp,
      loadComments,
      t,
    ],
  );

  // Toast playback errors raised by VideoPlayer.
  const lastPlaybackErrorFileRef = useRef<string | null>(null);
  const handlePlaybackError = useCallback(
    (err: { kind?: string } | null) => {
      const fileId = playingFile?.fileId ?? null;
      if (lastPlaybackErrorFileRef.current === fileId) return;
      lastPlaybackErrorFileRef.current = fileId;
      const msg =
        err?.kind === "decode"
          ? t("player.decodeError")
          : t("player.errorGeneric");
      toast.error(msg, { duration: 8000 });
    },
    [playingFile, t],
  );

  useEffect(() => {
    lastPlaybackErrorFileRef.current = null;
  }, [playingFile?.fileId]);

  const handleVideoEnded = useCallback(() => {
    // Commentary tracks don't auto-advance.
    if (playingFile?.parsedKind === "commentary") return;
    if (locationSeriesId && libraryEpisodeNumbers.length > 0) {
      const idx = libraryEpisodeNumbers.indexOf(playingEp);
      if (idx >= 0 && idx < libraryEpisodeNumbers.length - 1) {
        handleLibraryEpisodeSwitchByNumber(libraryEpisodeNumbers[idx + 1]);
      }
      return;
    }
    const idx = episodes.indexOf(playingEp);
    if (idx >= 0 && idx < episodes.length - 1) {
      handleEpisodeSwitch(episodes[idx + 1]);
    }
  }, [
    locationSeriesId,
    libraryEpisodeNumbers,
    handleLibraryEpisodeSwitchByNumber,
    episodes,
    playingEp,
    playingFile,
    handleEpisodeSwitch,
  ]);

  // Mobile guard — after all hooks to satisfy Rules of Hooks
  if (isMobileView) {
    return (
      <div style={s.mobile}>
        <div style={s.mobileTitle}>{t("player.desktopOnly")}</div>
        <div>{t("player.desktopHint")}</div>
      </div>
    );
  }

  return (
    <div
      style={s.page}
      onDragEnter={handlePageDragEnter}
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
    >
      <style>{FADE_UP_CSS}</style>
      {pageDragging && uiPhase !== "idle" && (
        <div style={s.dropOverlay} aria-hidden>
          <div style={s.dropOverlayInner}>
            <div style={s.dropOverlayEyebrow}>INGEST //</div>
            <div style={s.dropOverlayTitle}>{t("player.dropReplace")}</div>
          </div>
        </div>
      )}

      {/* LIBRARY MODE — empty/denied/error/loading states */}
      {locationSeriesId && libraryEmptyKind && playbackPhase !== "playing" && (
        <div style={fadeUp}>
          <LibraryAccessEmpty
            kind={libraryEmptyKind}
            onReauthorize={
              libraryIdsForReauth.length ? handleReauthorize : undefined
            }
            onRetry={handleRetryLoad}
            onBackToLibrary={handleBackToLibrary}
          />
        </div>
      )}

      {/* IDLE — only shown when NOT in library mode */}
      {uiPhase === "idle" && !locationSeriesId && (
        <div style={fadeUp}>
          <DropZone onFiles={handleFiles} />
        </div>
      )}

      {/* IDLE fallback when in library mode but not yet ready */}
      {locationSeriesId && seriesDetail.status === "idle" && (
        <div style={fadeUp}>
          <DropZone onFiles={handleFiles} />
        </div>
      )}

      {/* MATCHING */}
      {uiPhase === "matching" && (
        <div style={{ marginTop: 64, ...fadeUp }}>
          <MatchProgress
            fileCount={pickedItems.length || videoFiles.length}
            keyword={
              keyword ||
              seriesDetail.series?.titleZh ||
              seriesDetail.series?.titleEn ||
              ""
            }
            stepStatus={stepStatus}
            onClear={
              locationSeriesId ? handleBackToLibraryGrid : handleClearAll
            }
          />
        </div>
      )}

      {/* MANUAL */}
      {uiPhase === "manual" && (
        <div style={{ marginTop: 32, ...fadeUp }}>
          <ManualSearch
            defaultKeyword={
              keyword ||
              seriesDetail.series?.titleZh ||
              seriesDetail.series?.titleEn ||
              ""
            }
            onSelect={handleManualSelect}
            onBack={
              locationSeriesId ? handleBackToLibraryGrid : handleClearAll
            }
          />
        </div>
      )}

      {/* ERROR */}
      {uiPhase === "error" && (
        <div style={{ ...s.errorBox, ...fadeUp }}>
          <div style={s.errorTitle}>{t("player.error")}</div>
          <div>{error || t("player.errorGeneric")}</div>
          <button
            type="button"
            style={s.retryBtn}
            onClick={
              locationSeriesId ? handleBackToLibraryGrid : handleClearAll
            }
          >
            {t("player.retry")}
          </button>
        </div>
      )}

      {/* READY */}
      {uiPhase === "ready" &&
        matchResult &&
        !libraryEmptyKind &&
        (locationResumeEpisode == null || autoResumeAttempted) && (
          <div
            data-testid={
              locationSeriesId ? "library-episode-list" : undefined
            }
            style={{ marginTop: 32, ...fadeUp }}
          >
            <EpisodeFileList
              anime={matchResult.anime}
              siteAnime={matchResult.siteAnime}
              episodeMap={matchResult.episodeMap}
              videoFiles={pickedMainFiles}
              supplementaryFiles={pickedSupplementaryFiles}
              onPlay={handleListPlay}
              onClear={
                locationSeriesId ? handleBackToLibraryGrid : handleClearAll
              }
              onSetDanmaku={setPickerEp}
              clearLabel={locationSeriesId ? "返回库" : undefined}
            />
          </div>
        )}

      {/* PLAYING */}
      {uiPhase === "playing" && (
        <div style={fadeUp}>
          <header style={s.playHeader}>
            <ChapterBar
              hue={HUE}
              height={56}
              top={8}
              left={20}
              trigger="mount"
            />
            <SectionNum n="01" style={{ top: 12, right: 16, fontSize: 10 }} />
            <CornerBrackets inset={6} size={8} opacity={0.32} />

            <HudBackButton
              onClick={handleBackToList}
              label={t("player.backToList")}
            />

            <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
              <div style={s.epEyebrow} aria-hidden>
                EPISODE / 集
              </div>
              <div style={s.epTitle}>
                EP{String(playingEp).padStart(2, "0")}
                {matchResult?.anime?.titleChinese &&
                  ` · ${matchResult.anime.titleChinese}`}
              </div>
              {matchResult?.episodeMap?.[playingEp]?.title && (
                <div style={s.epSubtitle}>
                  {matchResult.episodeMap[playingEp].title}
                </div>
              )}
            </div>

            <div style={s.headerActions}>
              {loadingDanmaku ? (
                <span style={s.loadingChip}>{t("player.loadingDanmaku")}</span>
              ) : danmakuCount > 0 ? (
                <span style={s.danmakuChip}>
                  {danmakuCount.toLocaleString()} {t("player.danmakuCount")}
                </span>
              ) : null}
              <HudDanmakuButton
                onClick={() => setPickerEp(playingEp)}
                label={t("player.setDanmaku")}
              />
            </div>
          </header>

          <div style={s.playerWrap}>
            <PlayerHudFrame
              videoUrl={videoUrl}
              danmakuList={danmakuList}
              subtitleUrl={subtitleUrl}
              subtitleType={subtitleType}
              subtitleContent={subtitleContent}
              onEnded={handleVideoEnded}
              onPlaybackError={handlePlaybackError}
              progressKey={progressKey}
              episode={playingEp}
              danmakuCount={danmakuCount}
              resumeAt={resumeAt}
              onProgressTick={handleProgressTick}
            />
            {danmakuCount === 0 && (
              <div style={s.danmakuInfo}>{t("player.noDanmaku")}</div>
            )}
            <EpisodeNav
              episodes={
                locationSeriesId ? libraryEpisodeNumbers : episodes
              }
              currentEpisode={playingEp}
              onSelect={
                locationSeriesId
                  ? handleLibraryEpisodeSwitchByNumber
                  : handleEpisodeSwitch
              }
            />
          </div>
        </div>
      )}

      {/* Shared DanmakuPicker — works from list view and playing view. */}
      <DanmakuPicker
        isOpen={pickerEp != null}
        onClose={() => setPickerEp(null)}
        onConfirm={(data, newAnime) => {
          if (pickerEp != null) {
            handleUpdateDanmaku(pickerEp, data, newAnime);
          }
          setPickerEp(null);
        }}
        currentAnime={matchResult?.anime}
        currentEpisodeId={
          pickerEp != null
            ? matchResult?.episodeMap?.[pickerEp]?.dandanEpisodeId
            : null
        }
        episodeNumber={pickerEp}
        defaultKeyword={
          keyword ||
          seriesDetail.series?.titleZh ||
          seriesDetail.series?.titleEn ||
          ""
        }
      />

      {/* Dev-only heatmap tuning panel */}
      {devMode && uiPhase === "playing" && <HeatmapTuner />}
    </div>
  );
}

/**
 * Player surface. The `useLang()` call sites resolve against the
 * cookie-driven LanguageProvider mounted in RootLayout, so Player follows
 * the site-wide language toggle instead of an independent localStorage
 * copy.
 */
export function PlayerShell() {
  return <PlayerShellInner />;
}

export default PlayerShell;
