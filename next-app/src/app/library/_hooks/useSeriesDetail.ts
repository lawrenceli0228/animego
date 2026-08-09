"use client";

// Ported from client/src/hooks/useSeriesDetail.js (P6.4 subagent C).
// Loads a Series + its Episodes + their FileRefs from IDB. Lazily resolves
// Files via FSA only on demand (returned `getFile(episodeId)`).

import { useState, useEffect, useCallback } from "react";
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
      return;
    }

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
          return;
        }

        // performMerge is a SOFT merge — read across mergedFrom so the
        // merged card shows every contributing episode.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userOverrideTable = (db as any).userOverride;
        const override = userOverrideTable
          ? await userOverrideTable.get(seriesId)
          : null;
        if (cancelled) return;
        const mergedSeriesIds: string[] = Array.isArray(override?.mergedFrom)
          ? override.mergedFrom
          : [];
        const allSeriesIds = [seriesId, ...mergedSeriesIds];

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

        if (cancelled) return;

        setSeries(seriesRecord);
        setEpisodes(epRecords);
        setFileRefByEpisode(refMap);
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

  return { status, series, episodes, fileRefByEpisode, getFile, refresh };
}
