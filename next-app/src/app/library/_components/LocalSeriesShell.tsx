"use client";

// LocalSeriesShell — P6.4 subagent C ported entry shell for
// /library/[seriesId]. Mirrors client/src/pages/LocalSeriesPage.jsx
// structure 1:1; swaps useNavigate/useParams for Next 16's router + the
// `seriesId` prop forwarded by the route page (which awaits params).

import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

import {
  mono,
  PLAYER_HUE,
} from "@/components/landing/shared/hud-tokens";
import { useLang } from "@/lib/lang-client";

// Library lib (P6.2 ported)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module with JSDoc types
import { db } from "@/lib/library/db/db.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { makeProgressRepo } from "@/lib/library/db/progressRepo.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { makeOpsLogRepo } from "@/lib/library/db/opsLogRepo.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { ulid } from "@/lib/library/ulid.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { buildLibraryMatchResult } from "@/lib/library/buildLibraryMatchResult.js";

// Hooks owned by this subagent / unowned support hooks
import { useSeriesDetail } from "../_hooks/useSeriesDetail";
import { useLibrary } from "../_hooks/useLibrary";
import { useSiteAnimeForSeries } from "../_hooks/useSiteAnimeForSeries";

// Subagent B hooks (file handles for FSA permission re-grant).
import { useFileHandles } from "../_hooks/useFileHandles";

// Services
import { performMerge, undoMerge } from "../_services/mergeOps";
import { splitSeries } from "../_services/splitSeries";
import { rematchSeries } from "../_services/rematchSeries";
import { deleteSeriesCascade } from "../_services/deleteSeries";

// Components owned by this subagent
import { OpsLogDrawer } from "./OpsLogDrawer";
import { SeriesActionsMenu } from "./SeriesActionsMenu";
import { UndoToast } from "./UndoToast";

// Components owned by subagent B
import { MergeDialog } from "./MergeDialog";
import { SplitDialog } from "./SplitDialog";
import { RematchDialog } from "./RematchDialog";

// Player components (owned by P6.6). They don't exist yet during this port
// pass; tsc will flag these as unresolved imports — that's expected per
// the P6.4 contract. TODO P6 verify these paths once the player surface
// lands.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — P6.6 not yet ported
import { EpisodeFileList } from "@/app/player/_components/EpisodeFileList";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — P6.6 not yet ported
import { DanmakuPicker } from "@/app/player/_components/DanmakuPicker";

const HUE = PLAYER_HUE.local;

interface SeriesRecord {
  id: string;
  titleZh?: string;
  titleJa?: string;
  titleEn?: string;
  type?: string;
  posterUrl?: string;
  totalEpisodes?: number;
}

interface EpisodeRow {
  id: string;
  seriesId: string;
  number: number;
  kind: string;
  primaryFileId?: string;
}

interface FileRefRow {
  id: string;
  libraryId: string;
  relPath: string;
}

interface ProgressRow {
  episodeId: string;
  seriesId: string;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
  completed: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpsLogEntry = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SeasonRow = any;

const s = {
  page: {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "24px 24px 48px",
    display: "flex",
    flexDirection: "column",
    gap: 24,
    color: "#fff",
  } as CSSProperties,
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  } as CSSProperties,
  topbarSpacer: { flex: 1 } as CSSProperties,
  backBtn: {
    ...mono,
    padding: "6px 12px",
    background: "transparent",
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.50)`,
    borderRadius: 3,
    color: "rgba(235,235,245,0.85)",
    cursor: "pointer",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  } as CSSProperties,
  sectionLabel: {
    ...mono,
    fontSize: 10,
    color: "rgba(235,235,245,0.45)",
    textTransform: "uppercase",
    letterSpacing: "0.15em",
  } as CSSProperties,
  folderTree: {
    ...mono,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 11,
    color: "rgba(235,235,245,0.55)",
    padding: 12,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.20)`,
    borderRadius: 4,
  } as CSSProperties,
  folderGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
  } as CSSProperties,
  folderRow: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.85)",
    padding: "2px 0",
    letterSpacing: "0.04em",
  } as CSSProperties,
  fileRow: {
    ...mono,
    display: "grid",
    gridTemplateColumns: "14px 36px 1fr 16px",
    alignItems: "center",
    gap: 8,
    fontSize: 10.5,
    color: "rgba(235,235,245,0.55)",
    padding: "2px 0 2px 12px",
  } as CSSProperties,
  fileBranch: {
    color: "rgba(235,235,245,0.30)",
    textAlign: "center",
  } as CSSProperties,
  fileEpBadge: {
    color: `oklch(72% 0.15 ${HUE})`,
    letterSpacing: "0.06em",
  } as CSSProperties,
  fileName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as CSSProperties,
  watchedMark: {
    color: `oklch(70% 0.16 ${HUE})`,
    textAlign: "center",
  } as CSSProperties,
  emptyState: {
    ...mono,
    fontSize: 12,
    color: "rgba(235,235,245,0.55)",
    textAlign: "center",
    padding: 32,
  } as CSSProperties,
};

function pickTitle(series: SeriesRecord | null | undefined): string {
  return (
    series?.titleZh ||
    series?.titleEn ||
    series?.titleJa ||
    series?.id ||
    ""
  );
}

interface LocalSeriesShellProps {
  seriesId: string;
}

export function LocalSeriesShell({ seriesId }: LocalSeriesShellProps) {
  const { t } = useLang();
  const router = useRouter();
  const fileHandles = useFileHandles({ db });
  const seriesDetail = useSeriesDetail(seriesId ?? null, {
    db,
    fileHandles,
  });
  const { status, series, episodes, fileRefByEpisode, refresh } = seriesDetail;

  // P6 type widen: useSeriesDetail returns SeriesRecord (loose),
  // buildLibraryMatchResult wants the canonical Series. Runtime
  // shape matches; the difference is JSDoc vs TS strictness.
  const libraryMatchResult = useMemo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => buildLibraryMatchResult(seriesDetail as any),
    [seriesDetail],
  );

  // Fetch siteAnime for rich AniList metadata.
  const { data: siteAnime, loading: siteAnimeLoading } =
    useSiteAnimeForSeries({ series });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enrichedMatchResult: any = useMemo(() => {
    if (!libraryMatchResult) return null;
    if (!siteAnime) return libraryMatchResult;
    return { ...libraryMatchResult, siteAnime };
  }, [libraryMatchResult, siteAnime]);

  const [progressByEp, setProgressByEp] = useState<Map<string, ProgressRow>>(
    new Map(),
  );

  useEffect(() => {
    if (!seriesId) return undefined;
    let cancelled = false;
    const repo = makeProgressRepo(db);
    repo
      .getBySeries(seriesId)
      .then((rows: ProgressRow[]) => {
        if (cancelled) return;
        const m = new Map<string, ProgressRow>();
        for (const p of rows) m.set(p.episodeId, p);
        setProgressByEp(m);
      })
      .catch(() => {
        if (!cancelled) setProgressByEp(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [seriesId, episodes]);

  // §5.6 file tree.
  const filesByFolder = useMemo(() => {
    const folders = new Map<
      string,
      Array<{
        epId: string;
        epNumber: number;
        fileName: string;
        watched: boolean;
      }>
    >();
    for (const ep of episodes as EpisodeRow[]) {
      const ref = fileRefByEpisode.get(ep.id) as FileRefRow | undefined;
      if (!ref) continue;
      const slash = ref.relPath.lastIndexOf("/");
      const dir = slash >= 0 ? ref.relPath.slice(0, slash) : t("library.localSeries.rootFolder");
      const fileName =
        slash >= 0 ? ref.relPath.slice(slash + 1) : ref.relPath;
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir)!.push({
        epId: ep.id,
        epNumber: ep.number,
        fileName,
        watched: !!progressByEp.get(ep.id)?.completed,
      });
    }
    const entries = Array.from(folders.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [, files] of entries)
      files.sort((a, b) => a.epNumber - b.epNumber);
    return entries;
  }, [episodes, fileRefByEpisode, progressByEp]);

  const handleBack = useCallback(() => {
    router.push("/library");
  }, [router]);

  // EpisodeFileList click → /player with seriesId+resumeEpisode query.
  const handlePlayItem = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fileItem: any) => {
      if (!seriesId) return;
      router.push(
        `/player?seriesId=${encodeURIComponent(seriesId)}&resumeEpisode=${fileItem.episode}`,
      );
    },
    [router, seriesId],
  );

  // DanmakuPicker for the EpisodeFileList rows. Locally-mounted so users
  // can fix mismatched danmaku before pressing play.
  const [pickerEp, setPickerEp] = useState<number | null>(null);

  const handleDanmakuConfirm = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (data: any, _newAnime: unknown) => {
      if (pickerEp == null || !data?.dandanEpisodeId) {
        setPickerEp(null);
        return;
      }
      // Persist new dandanEpisodeId on the matching IDB Episode row.
      const target = (episodes as EpisodeRow[]).find(
        (e) =>
          e.number === pickerEp &&
          e.kind !== "sp" &&
          e.kind !== "commentary",
      );
      if (!target) {
        setPickerEp(null);
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).episodes.update(target.id, {
          episodeId: data.dandanEpisodeId,
          updatedAt: Date.now(),
        });
        refresh();
        toast.success(t("library.toast.danmakuUpdated"));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[localseries] failed to update episode danmaku id:", err);
        toast.error(t("library.toast.danmakuUpdateFailed"));
      } finally {
        setPickerEp(null);
      }
    },
    [pickerEp, episodes, refresh],
  );

  // §5.6 Actions menu — 详情页是移动端唯一管理入口。
  const { series: allSeries } = useLibrary({ db }) as {
    series: SeriesRecord[];
  };
  const [activeDialog, setActiveDialog] = useState<
    "merge" | "split" | "rematch" | "opslog" | null
  >(null);
  const [splitSeasons, setSplitSeasons] = useState<SeasonRow[]>([]);
  const [opsLogEntries, setOpsLogEntries] = useState<OpsLogEntry[]>([]);
  const [undoToast, setUndoToast] = useState<{
    opIds: string[];
    title: string;
    meta?: string;
  } | null>(null);

  // SplitDialog seasons — load on demand.
  useEffect(() => {
    if (activeDialog !== "split" || !seriesId) {
      setSplitSeasons([]);
      return undefined;
    }
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).seasons
      .where("seriesId")
      .equals(seriesId)
      .toArray()
      .then((rows: SeasonRow[]) => {
        if (!cancelled) setSplitSeasons(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn(
            "[localseries] failed to load seasons for split:",
            err,
          );
          setSplitSeasons([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeDialog, seriesId]);

  // 24h ops log — load on demand.
  useEffect(() => {
    if (activeDialog !== "opslog" || !seriesId) {
      setOpsLogEntries([]);
      return undefined;
    }
    let cancelled = false;
    makeOpsLogRepo(db)
      .listForSeries(seriesId, { limit: 50 })
      .then((rows: OpsLogEntry[]) => {
        if (!cancelled) setOpsLogEntries(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn("[localseries] failed to load opsLog:", err);
          setOpsLogEntries([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeDialog, seriesId]);

  const closeDialog = useCallback(() => setActiveDialog(null), []);

  const handleMergeConfirm = useCallback(
    async (targetSeriesId: string) => {
      if (!seriesId || !series || seriesId === targetSeriesId) {
        setActiveDialog(null);
        return;
      }
      const targetSeries =
        allSeries.find((sr) => sr.id === targetSeriesId) ?? null;
      const targetTitle = pickTitle(targetSeries) || targetSeriesId;
      const sourceTitle = pickTitle(series) || seriesId;
      try {
        const op = await performMerge({
          db,
          sourceSeriesId: seriesId,
          targetSeriesId,
          summary: { targetTitle, sourceTitle },
        });
        if (op) {
          setUndoToast({
            opIds: [op.id],
            title: targetTitle,
            meta: t("library.undoToast.mergeFromSource").replace("{{source}}", sourceTitle),
          });
          // Source vanishes after merge — navigate so back-button stays sane.
          router.replace(
            `/player?seriesId=${encodeURIComponent(targetSeriesId)}`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[localseries] merge failed:", err);
      } finally {
        setActiveDialog(null);
      }
    },
    [seriesId, series, allSeries, router],
  );

  const handleSplitConfirm = useCallback(
    async ({ seasonIds, name }: { seasonIds: string[]; name: string }) => {
      if (!seriesId) return;
      try {
        await splitSeries({
          db,
          sourceSeriesId: seriesId,
          seasonIds,
          name,
          ulid,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[localseries] split failed:", err);
      } finally {
        setActiveDialog(null);
      }
    },
    [seriesId],
  );

  const handleRematchConfirm = useCallback(
    async (payload: {
      animeId: number;
      titleZh?: string;
      titleEn?: string;
      posterUrl?: string;
      type?: "tv" | "movie" | "ova" | "web";
    }) => {
      if (!seriesId) return;
      try {
        await rematchSeries({
          db,
          seriesId,
          animeId: payload.animeId,
          titleZh: payload.titleZh,
          titleEn: payload.titleEn,
          posterUrl: payload.posterUrl,
          type: payload.type,
          ulid,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[localseries] rematch failed:", err);
      } finally {
        setActiveDialog(null);
      }
    },
    [seriesId],
  );

  const handleUndoMerge = useCallback(async () => {
    if (!undoToast) return;
    for (const opId of [...undoToast.opIds].reverse()) {
      try {
        await undoMerge({ db, opId });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[localseries] undo merge failed:", err);
      }
    }
  }, [undoToast]);

  const handleDelete = useCallback(async () => {
    if (!seriesId || !series) return;
    const title = pickTitle(series) || seriesId;
    const ok = window.confirm(
      t("library.confirm.deleteSingle").replace("{{title}}", title),
    );
    if (!ok) return;
    try {
      await deleteSeriesCascade({ db, seriesId });
      toast.success(t("library.toast.deleteSuccess").replace("{{title}}", title));
      router.push("/library");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[localseries] delete failed:", err);
      toast.error(t("library.toast.deleteFailed"));
    }
  }, [seriesId, series, router]);

  if (status === "loading" || status === "idle") {
    return (
      <div style={s.page}>
        <div style={s.topbar}>
          <button style={s.backBtn} onClick={handleBack} type="button">
            {t("library.localSeries.backBtn")}
          </button>
        </div>
        <div style={s.emptyState} data-testid="loading-state">
          {t("library.localSeries.loading")}
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={s.page}>
        <div style={s.topbar}>
          <button style={s.backBtn} onClick={handleBack} type="button">
            {t("library.localSeries.backBtn")}
          </button>
        </div>
        <div style={s.emptyState} data-testid="error-state">
          {t("library.localSeries.loadFailed")}
        </div>
      </div>
    );
  }

  if (status === "missing" || !series || !libraryMatchResult) {
    return (
      <div style={s.page}>
        <div style={s.topbar}>
          <button style={s.backBtn} onClick={handleBack} type="button">
            {t("library.localSeries.backBtn")}
          </button>
        </div>
        <div style={s.emptyState} data-testid="missing-state">
          {t("library.localSeries.notFound")}
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <div style={s.topbar}>
        <button
          style={s.backBtn}
          onClick={handleBack}
          type="button"
          data-testid="back-btn"
        >
          {t("library.localSeries.backBtn")}
        </button>
        <div style={s.topbarSpacer} />
        <SeriesActionsMenu
          onMerge={() => setActiveDialog("merge")}
          onSplit={() => setActiveDialog("split")}
          onRematch={() => setActiveDialog("rematch")}
          onOpsLog={() => setActiveDialog("opslog")}
          onDelete={handleDelete}
        />
      </div>

      <div data-testid="series-list">
        <EpisodeFileList
          anime={enrichedMatchResult.anime}
          siteAnime={enrichedMatchResult.siteAnime}
          episodeMap={enrichedMatchResult.episodeMap}
          videoFiles={enrichedMatchResult.videoFiles}
          supplementaryFiles={enrichedMatchResult.supplementaryFiles || []}
          onPlay={handlePlayItem}
          onClear={handleBack}
          onSetDanmaku={(epNum: number) => setPickerEp(epNum)}
          clearLabel={t("library.localSeries.backToLibrary")}
          siteAnimeLoading={siteAnimeLoading}
        />
      </div>

      {filesByFolder.length > 0 && (
        <div>
          <div style={{ ...s.sectionLabel, marginBottom: 8 }}>
            // FILE SOURCES //
          </div>
          <div style={s.folderTree} data-testid="source-list">
            {filesByFolder.map(([dir, files]) => (
              <div
                key={dir}
                style={s.folderGroup}
                data-testid={`folder-group-${dir}`}
              >
                <div style={s.folderRow}>📁 {dir}/</div>
                {files.map((f, i) => {
                  const branch = i === files.length - 1 ? "└" : "├";
                  return (
                    <div
                      key={f.epId}
                      style={s.fileRow}
                      data-testid={`file-row-${f.epId}`}
                    >
                      <span style={s.fileBranch} aria-hidden>
                        {branch}
                      </span>
                      <span style={s.fileEpBadge}>
                        EP{String(f.epNumber).padStart(2, "0")}
                      </span>
                      <span style={s.fileName}>{f.fileName}</span>
                      <span
                        style={s.watchedMark}
                        aria-hidden
                        data-testid={`file-watched-${f.epId}`}
                      >
                        {f.watched ? "✓" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <DanmakuPicker
        isOpen={pickerEp != null}
        onClose={() => setPickerEp(null)}
        onConfirm={handleDanmakuConfirm}
        currentAnime={libraryMatchResult.anime}
        currentEpisodeId={
          pickerEp != null
            ? libraryMatchResult.episodeMap?.[pickerEp]?.dandanEpisodeId
            : null
        }
        episodeNumber={pickerEp}
        defaultKeyword={
          libraryMatchResult.anime.titleRomaji ||
          libraryMatchResult.anime.titleChinese ||
          ""
        }
      />

      {activeDialog === "merge" && series && (
        <MergeDialog
          open
          sourceSeries={series}
          allSeries={allSeries}
          onClose={closeDialog}
          onConfirm={handleMergeConfirm}
        />
      )}

      {activeDialog === "split" && series && (
        <SplitDialog
          open
          sourceSeries={series}
          seasons={splitSeasons}
          onClose={closeDialog}
          onConfirm={handleSplitConfirm}
        />
      )}

      {activeDialog === "rematch" && series && (
        <RematchDialog
          open
          sourceSeries={series}
          onClose={closeDialog}
          onConfirm={handleRematchConfirm}
        />
      )}

      <OpsLogDrawer
        open={activeDialog === "opslog"}
        entries={opsLogEntries}
        onClose={closeDialog}
      />

      {undoToast && (
        <UndoToast
          open
          title={undoToast.title}
          meta={undoToast.meta}
          onUndo={handleUndoMerge}
          onDismiss={() => setUndoToast(null)}
        />
      )}
    </div>
  );
}
