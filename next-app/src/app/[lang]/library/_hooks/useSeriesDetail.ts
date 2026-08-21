"use client";

// Ported from client/src/hooks/useSeriesDetail.js (P6.4 subagent C).
// Loads a Series + its Episodes + their FileRefs from IDB. Lazily resolves
// Files via FSA only on demand (returned `getFile(episodeId)`).

import { useState, useEffect, useCallback } from "react";
import { resolveMergedSeriesIds } from "../_services/resolveMergedIds";
import { buildGroupTotals } from "../_services/seriesGroups";
import type Dexie from "dexie";

// Types are JSDoc only on the JS side — mirror them in TS-friendly form.
// Keep loose so we don't have to import every legacy type.
interface SeriesRecord {
  id: string;
  titleZh?: string;
  titleJa?: string;
  titleEn?: string;
  type?: "tv" | "movie" | "ova" | "web";
  bangumiId?: number;
  posterUrl?: string;
  totalEpisodes?: number;
  confidence?: number;
  createdAt?: number;
  updatedAt?: number;
}

interface EpisodeRecord {
  id: string;
  seriesId: string;
  seasonId?: string;
  episodeId?: number;
  number: number;
  kind:
    | "main"
    | "sp"
    | "ova"
    | "movie"
    | "pv"
    | "commentary"
    | "ncop"
    | "nced"
    | "bonus"
    | "trailer"
    | "interview"
    | "wp"
    | "cm"
    | "menu";
  title?: string;
  primaryFileId: string;
  alternateFileIds: string[];
  version?: number;
  updatedAt?: number;
}

interface FileRefRecord {
  id: string;
  libraryId: string;
  episodeId?: string;
  relPath: string;
  size: number;
  mtime: number;
  hash16M?: string;
  resolution?: "480p" | "720p" | "1080p" | "2160p";
  source?: "raw" | "sub";
  group?: string;
  codec?: string;
  matchStatus: "pending" | "matched" | "manual" | "ambiguous" | "failed";
  matchCandidates?: { animeId: number; episodeId: number; score: number }[];
}

export type SeriesDetailStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "missing";

interface FileHandlesAdapter {
  selectFileByName: (
    libraryId: string,
    relPath: string,
  ) => Promise<File | null>;
}

export interface UseSeriesDetailResult {
  status: SeriesDetailStatus;
  series: SeriesRecord | null;
  episodes: EpisodeRecord[];
  fileRefByEpisode: Map<string, FileRefRecord>;
  /**
   * Episodes this whole card claims, folded across the merge group.
   * `undefined` means unknown — an unbound series, or one whose count never
   * resolved.
   *
   * Not `series.totalEpisodes`: that is one member's own count, and a card can
   * be several soft-merged members. It is computed by `buildGroupTotals`, the
   * same function the library grid folds with, because the number that sizes
   * the detail sheet's grid and the number the player normalises episode
   * numbers against have to be the same one. Read them from different places
   * and the sheet can label a chip "01" that opens a player headed "EP13".
   */
  groupTotal: number | undefined;
  getFile: (episodeId: string) => Promise<File | null>;
  refresh: () => void;
}

export function useSeriesDetail(
  seriesId: string | null,
  ctx: { db: Dexie; fileHandles: FileHandlesAdapter },
): UseSeriesDetailResult {
  const { db, fileHandles } = ctx;

  const [status, setStatus] = useState<SeriesDetailStatus>(
    seriesId ? "loading" : "idle",
  );
  const [series, setSeries] = useState<SeriesRecord | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [fileRefByEpisode, setFileRefByEpisode] = useState<
    Map<string, FileRefRecord>
  >(new Map());
  const [groupTotal, setGroupTotal] = useState<number | undefined>(undefined);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!seriesId || typeof seriesId !== "string") {
      setStatus("idle");
      setSeries(null);
      setEpisodes([]);
      setFileRefByEpisode(new Map());
      setGroupTotal(undefined);
      return;
    }

    // Narrowed here, captured by the nested async loader below.
    const rootSeriesId: string = seriesId;
    let cancelled = false;
    setStatus("loading");

    async function load() {
      try {
        // 1. Fetch series
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const seriesRecord = (await (db as any).series.get(seriesId)) as
          | SeriesRecord
          | undefined;
        if (cancelled) return;
        if (!seriesRecord) {
          setStatus("missing");
          setSeries(null);
          setEpisodes([]);
          setFileRefByEpisode(new Map());
          setGroupTotal(undefined);
          return;
        }

        // performMerge is a SOFT merge — read across mergedFrom so the
        // merged card shows every contributing episode.
        //
        // The whole table, not a point lookup on this series: `mergedFrom` is
        // one hop, and merges chain. A→B then B→C leaves C pointing at B and B
        // pointing at A, so reading C's row alone loses every episode indexed
        // under A — while useLibrary hides A from the grid for being merged.
        // The files stay on disk and become reachable from nowhere.
        // resolveMergedSeriesIds walks the chain (and guards against cycles).
        // The table holds one row per series the user has touched, so this
        // scan is cheaper than the N lookups a recursive walk would need.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userOverrideTable = (db as any).userOverride;
        const overrides = userOverrideTable
          ? await userOverrideTable.toArray()
          : [];
        if (cancelled) return;
        const allSeriesIds = resolveMergedSeriesIds(overrides, seriesId);

        // 2. Fetch episodes for this series + every merged source.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const epRecords = (await (db as any).episodes
          .where("seriesId")
          .anyOf(allSeriesIds)
          .toArray()) as EpisodeRecord[];
        if (cancelled) return;
        epRecords.sort((a, b) => a.number - b.number);

        // 3. Fetch fileRefs for each episode's primaryFileId.
        const primaryFileIds = epRecords
          .map((ep) => ep.primaryFileId)
          .filter(Boolean);

        const refMap = new Map<string, FileRefRecord>();

        if (primaryFileIds.length) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const refs = (await (db as any).fileRefs
            .where("id")
            .anyOf(primaryFileIds)
            .toArray()) as FileRefRecord[];
          if (cancelled) return;

          const refById = new Map(refs.map((r) => [r.id, r]));
          for (const ep of epRecords) {
            if (ep.primaryFileId) {
              const ref = refById.get(ep.primaryFileId);
              if (ref) refMap.set(ep.id, ref);
            }
          }
        }

        // 4. The card's declared length, folded across the merge group the
        // same way the library grid folds it. Only the members' rows are
        // fetched, but the WHOLE override list is passed: buildGroupTotals
        // walks the merge chain itself, and a truncated list would resolve a
        // shorter group than the sheet did.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyDb = db as any;
        const [memberSeries, memberSeasons] = await Promise.all([
          anyDb.series.where("id").anyOf(allSeriesIds).toArray(),
          anyDb.seasons.where("seriesId").anyOf(allSeriesIds).toArray(),
        ]);
        if (cancelled) return;

        setSeries(seriesRecord);
        setEpisodes(epRecords);
        setFileRefByEpisode(refMap);
        setGroupTotal(
          buildGroupTotals(memberSeries, memberSeasons, overrides).get(rootSeriesId),
        );
        setStatus("ready");
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId, db, tick]);

  const getFile = useCallback(
    async (episodeId: string): Promise<File | null> => {
      try {
        const fileRef = fileRefByEpisode.get(episodeId);
        if (!fileRef) return null;
        if (!fileRef.libraryId) return null;

        const file = await fileHandles.selectFileByName(
          fileRef.libraryId,
          fileRef.relPath,
        );
        return file ?? null;
      } catch {
        return null;
      }
    },
    [fileRefByEpisode, fileHandles],
  );

  return {
    status,
    series,
    episodes,
    fileRefByEpisode,
    groupTotal,
    getFile,
    refresh,
  };
}
