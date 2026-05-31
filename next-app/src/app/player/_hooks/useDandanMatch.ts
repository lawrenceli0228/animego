"use client";

// Ported from legacy client/src/hooks/useDandanMatch.js (P6.6).
// Three-tier matching hook for the Player surface.
// States: idle -> matching -> ready | manual | error
// Steps:  1=parsing, 2=matching, 3=mapping
//
// Not assigned to Subagent A or B (they own VideoPlayer + jassub and
// EpisodeFileList + Match progress + 2 player hooks `usePlaybackSession`/
// `useDandanComments` respectively). Lives next to PlayerShell since that
// is its sole consumer.

import { useState, useCallback, useRef, useEffect } from "react";

interface MountedRef {
  current: boolean;
}

function useIsMounted(): MountedRef {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

interface DandanEpisode {
  number?: number;
  rawEpisodeNumber?: string | number;
  dandanEpisodeId: number;
  title?: string;
}

interface DandanEpisodeMapEntry {
  dandanEpisodeId: number;
  title?: string;
}

/**
 * Build a map of {requestedEpisodeNumber -> {dandanEpisodeId, title}} against
 * dandanplay's episode list. Ported from server/client shared episodeMap.js.
 *
 * Three-level fallback:
 *   1. pure numeric episodeNumber
 *   2. OVA/Special prefix
 *   3. index-based on pure-numeric-only entries
 */
function buildEpisodeMap(
  dandanEpisodes: DandanEpisode[] | undefined,
  requestedEpisodes: number[],
): Record<number, DandanEpisodeMapEntry> {
  const map: Record<number, DandanEpisodeMapEntry> = {};
  if (!Array.isArray(dandanEpisodes) || dandanEpisodes.length === 0) return map;

  for (const epNum of requestedEpisodes) {
    const match = dandanEpisodes.find((e) => e.number === epNum);
    if (match) {
      map[epNum] = {
        dandanEpisodeId: match.dandanEpisodeId,
        title: match.title,
      };
    }
  }

  for (const epNum of requestedEpisodes) {
    if (map[epNum]) continue;
    const ovaMatch = dandanEpisodes.find((e) => {
      const raw = e.rawEpisodeNumber;
      if (!raw) return false;
      const m = String(raw).match(/^[OS](\d+)$/i);
      return Boolean(m && parseInt(m[1], 10) === epNum);
    });
    if (ovaMatch) {
      map[epNum] = {
        dandanEpisodeId: ovaMatch.dandanEpisodeId,
        title: ovaMatch.title,
      };
    }
  }

  const regulars = dandanEpisodes.filter((e) =>
    /^\d+$/.test(String(e.rawEpisodeNumber || "")),
  );
  const pool = regulars.length > 0 ? regulars : dandanEpisodes;

  for (const epNum of requestedEpisodes) {
    if (map[epNum]) continue;
    const byIndex = pool[epNum - 1];
    if (byIndex) {
      map[epNum] = {
        dandanEpisodeId: byIndex.dandanEpisodeId,
        title: byIndex.title,
      };
    }
  }

  return map;
}

interface MatchFile {
  fileName: string;
  episode: number | null;
  fileHash?: string;
  fileSize?: number;
}

interface MatchBody {
  keyword: string;
  episodes: number[];
  fileName: string;
  files: MatchFile[];
  fileHash?: string;
  fileSize?: number;
}

interface AnimeShape {
  anilistId?: number;
  dandanAnimeId?: number;
  bgmId?: number | string;
  titleChinese?: string;
  titleNative?: string;
  titleRomaji?: string;
  coverImageUrl?: string;
  imageUrl?: string;
  title?: string;
  episodes?: number;
  status?: string;
  season?: string;
  seasonYear?: number | string;
  averageScore?: number | string;
  bangumiScore?: number | string;
  bangumiVotes?: number;
  genres?: string[];
  format?: string;
  studios?: string[];
  animeSource?: string;
  duration?: number;
  source?: string;
  [key: string]: unknown;
}

export interface MatchResult {
  matched: boolean;
  anime: AnimeShape;
  siteAnime?: AnimeShape | null;
  episodeMap: Record<number, DandanEpisodeMapEntry>;
  source?: string;
}

export type MatchPhase = "idle" | "matching" | "ready" | "manual" | "error";
export type StepValue = "pending" | "active" | "done" | "fail";
export interface StepStatus {
  1: StepValue;
  2: StepValue;
  3: StepValue;
}

interface MatchResponse {
  matched?: boolean;
  anime?: AnimeShape;
  siteAnime?: AnimeShape | null;
  episodeMap?: Record<number, DandanEpisodeMapEntry>;
  [key: string]: unknown;
}

interface EpisodesResponse {
  episodes?: DandanEpisode[];
}

async function matchAnime(body: MatchBody): Promise<MatchResponse> {
  const res = await fetch("/api/dandanplay/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`matchAnime: HTTP ${res.status}`) as Error & {
      response?: { status: number };
    };
    err.response = { status: res.status };
    throw err;
  }
  return (await res.json()) as MatchResponse;
}

async function getEpisodes(
  animeId: number,
  bgmId?: number | string,
): Promise<EpisodesResponse> {
  const qs = bgmId ? `?bgmId=${encodeURIComponent(String(bgmId))}` : "";
  const url = `/api/dandanplay/episodes/${animeId || 0}${qs}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) {
    const err = new Error(`getEpisodes: HTTP ${res.status}`) as Error & {
      response?: { status: number };
    };
    err.response = { status: res.status };
    throw err;
  }
  return (await res.json()) as EpisodesResponse;
}

export interface BasicFile {
  fileName: string;
  episode: number | null;
  fileSize: number;
}

export interface HashedFile {
  fileName: string;
  episode: number | null;
  fileHash: string;
  fileSize: number;
}

export interface UseDandanMatchResult {
  phase: MatchPhase;
  step: number;
  stepStatus: StepStatus;
  matchResult: MatchResult | null;
  error: string | null;
  startMatch: (
    keyword: string,
    episodes: number[],
    firstFileName: string,
    basicFiles: BasicFile[],
    getFilesHashes: (() => Promise<HashedFile[] | null>) | null,
  ) => Promise<void>;
  selectManual: (anime: AnimeShape, episodes: number[]) => Promise<void>;
  reset: () => void;
  updateEpisodeMap: (
    epNum: number,
    data: DandanEpisodeMapEntry,
    newAnime?: AnimeShape | null,
  ) => void;
}

export function useDandanMatch(): UseDandanMatchResult {
  const [phase, setPhase] = useState<MatchPhase>("idle");
  const [step, setStep] = useState<number>(0);
  const [stepStatus, setStepStatus] = useState<StepStatus>({
    1: "pending",
    2: "pending",
    3: "pending",
  });
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useIsMounted();

  const startMatch = useCallback<UseDandanMatchResult["startMatch"]>(
    async (keyword, episodes, firstFileName, basicFiles, getFilesHashes) => {
      setPhase("matching");
      setError(null);
      setStep(1);
      setStepStatus({ 1: "active", 2: "pending", 3: "pending" });

      try {
        // Step 1: compute hashes for all files (10s timeout)
        let filesData: HashedFile[] | null = null;
        if (getFilesHashes) {
          filesData = await Promise.race([
            getFilesHashes(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
          ]);
        }
        setStepStatus((s) => ({ ...s, 1: "done" }));

        // Step 2: combined matching (all file hashes + keyword in one request)
        setStep(2);
        setStepStatus((s) => ({ ...s, 2: "active" }));

        const files: (BasicFile | HashedFile)[] = filesData || basicFiles;
        const body: MatchBody = {
          keyword,
          episodes,
          fileName: firstFileName,
          files: files as MatchFile[],
        };
        if (filesData?.[0]?.fileHash) {
          body.fileHash = filesData[0].fileHash;
          body.fileSize = filesData[0].fileSize;
        }

        const result = await matchAnime(body);
        if (!mounted.current) return;

        if (result.matched) {
          setStepStatus((s) => ({ ...s, 2: "done", 3: "done" }));
          setStep(3);
          setMatchResult(result as MatchResult);
          setPhase("ready");
          return;
        }

        // All phases failed -> manual
        setStepStatus((s) => ({ ...s, 2: "fail", 3: "fail" }));
        setPhase("manual");
      } catch (err: unknown) {
        if (!mounted.current) return;
        const status =
          err && typeof err === "object" && "response" in err
            ? (err as { response?: { status?: number } }).response?.status
            : undefined;
        // 401 is handled globally via auth:expired; don't render an error page
        if (status === 401) return;
        const msg = err instanceof Error ? err.message : "Match failed";
        setError(msg);
        setPhase("error");
      }
    },
    [mounted],
  );

  const selectManual = useCallback<UseDandanMatchResult["selectManual"]>(
    async (anime, episodes) => {
      setPhase("matching");
      setStep(3);
      setStepStatus({ 1: "done", 2: "done", 3: "active" });

      try {
        let epData: EpisodesResponse | undefined;
        if (anime.bgmId) {
          epData = await getEpisodes(0, anime.bgmId);
        } else if (anime.dandanAnimeId) {
          epData = await getEpisodes(anime.dandanAnimeId);
        }

        if (!mounted.current) return;

        if (!epData) {
          setPhase("error");
          setError("Could not fetch episode list");
          return;
        }

        const episodeMap = buildEpisodeMap(epData.episodes, episodes);

        setStepStatus((s) => ({ ...s, 3: "done" }));

        const siteAnime: AnimeShape | null = anime.anilistId
          ? {
              anilistId: anime.anilistId,
              titleChinese: anime.titleChinese,
              titleNative: anime.titleNative || anime.title,
              titleRomaji: anime.titleRomaji,
              coverImageUrl: anime.coverImageUrl,
              episodes: anime.episodes,
              status: anime.status,
              season: anime.season,
              seasonYear: anime.seasonYear,
              averageScore: anime.averageScore,
              bangumiScore: anime.bangumiScore,
              bangumiVotes: anime.bangumiVotes,
              genres: anime.genres,
              format: anime.format,
              bgmId: anime.bgmId,
              studios: anime.studios,
              source: anime.animeSource,
              duration: anime.duration,
            }
          : null;

        setMatchResult({
          matched: true,
          anime: {
            anilistId: anime.anilistId,
            titleChinese: anime.titleChinese,
            titleNative: anime.title || anime.titleNative,
            titleRomaji: anime.titleRomaji,
            coverImageUrl: anime.coverImageUrl || anime.imageUrl,
            episodes: anime.episodes,
          },
          siteAnime,
          episodeMap,
          source: anime.source || "manual",
        });
        setPhase("ready");
      } catch (err: unknown) {
        if (!mounted.current) return;
        const status =
          err && typeof err === "object" && "response" in err
            ? (err as { response?: { status?: number } }).response?.status
            : undefined;
        if (status === 401) return;
        const msg = err instanceof Error ? err.message : "Episode fetch failed";
        setError(msg);
        setPhase("error");
      }
    },
    [mounted],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setStep(0);
    setStepStatus({ 1: "pending", 2: "pending", 3: "pending" });
    setMatchResult(null);
    setError(null);
  }, []);

  const updateEpisodeMap = useCallback<UseDandanMatchResult["updateEpisodeMap"]>(
    (epNum, data, newAnime) => {
      setMatchResult((prev) => {
        if (!prev) return prev;
        const updated: MatchResult = {
          ...prev,
          episodeMap: { ...prev.episodeMap, [epNum]: data },
        };
        if (newAnime) {
          updated.anime = {
            ...prev.anime,
            dandanAnimeId: newAnime.dandanAnimeId || prev.anime.dandanAnimeId,
            bgmId: newAnime.bgmId || prev.anime.bgmId,
            titleChinese:
              newAnime.titleChinese ||
              newAnime.title ||
              prev.anime.titleChinese,
            titleNative:
              newAnime.titleNative ||
              newAnime.title ||
              prev.anime.titleNative,
            titleRomaji: newAnime.titleRomaji || prev.anime.titleRomaji,
            coverImageUrl:
              newAnime.coverImageUrl ||
              newAnime.imageUrl ||
              prev.anime.coverImageUrl,
            episodes: newAnime.episodes || prev.anime.episodes,
          };
        }
        return updated;
      });
    },
    [],
  );

  return {
    phase,
    step,
    stepStatus,
    matchResult,
    error,
    startMatch,
    selectManual,
    reset,
    updateEpisodeMap,
  };
}

export default useDandanMatch;
