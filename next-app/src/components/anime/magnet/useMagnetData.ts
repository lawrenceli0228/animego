"use client";

// The panel's two reads: the torrent list (by anilistId, or a keyword) and
// the franchise's episode offset, fetched side by side when the panel opens.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { toRows, type MagnetRow, type TorrentItem } from "@/lib/magnet/list";
import { buildTorrentRequest, episodeOffsetPath, readOffsetAnswer } from "@/lib/magnet/request";

/**
 * Answers kept for the life of the document, five minutes fresh. Re-opening
 * the panel, or going back to a title already searched, paints at once; a
 * stale answer still paints while the fresh one is fetched. go-api caches
 * the same request for an hour, so a miss here usually hits there.
 */
const FRESH_MS = 5 * 60 * 1000;
/** A popular show's answer parses to a thousand rows; keep the last few answers, not every one. */
const LIST_CACHE_LIMIT = 12;
const listCache = new Map<string, { rows: MagnetRow[]; at: number }>();

function remember(key: string, rows: MagnetRow[]): void {
  listCache.delete(key);
  listCache.set(key, { rows, at: Date.now() });
  while (listCache.size > LIST_CACHE_LIMIT) {
    const oldest = listCache.keys().next().value;
    if (oldest === undefined) break;
    listCache.delete(oldest);
  }
}

/** Offsets per anime for the life of the document; an answer, known or not, does not change. */
const offsetCache = new Map<number, number | undefined>();

export type ListStatus = "loading" | "ready" | "error";

export interface ListView {
  status: ListStatus;
  rows: readonly MagnetRow[];
  /** Fetch again, past both caches' copy of this request. */
  retry: () => void;
}

const NO_ROWS: readonly MagnetRow[] = [];

export function useTorrentRows(anilistId: number, manualQ: string | null): ListView {
  const req = useMemo(() => buildTorrentRequest(anilistId, manualQ), [anilistId, manualQ]);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ key: string; status: "ready" | "error"; rows: MagnetRow[] } | null>(
    null,
  );
  const key = `${req.cacheKey}#${attempt}`;

  useEffect(() => {
    if (req.skip) return;
    const entry = listCache.get(req.cacheKey);
    if (entry && Date.now() - entry.at < FRESH_MS) return;
    const controller = new AbortController();
    apiGet<TorrentItem[]>(req.path, { signal: controller.signal })
      .then((data) => {
        const rows = toRows(Array.isArray(data) ? data : []);
        remember(req.cacheKey, rows);
        setSettled({ key, status: "ready", rows });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("[magnet] torrent search failed:", err);
        setSettled({ key, status: "error", rows: [] });
      });
    return () => controller.abort();
  }, [req, key]);

  const retry = useCallback(() => {
    listCache.delete(req.cacheKey);
    setAttempt((n) => n + 1);
  }, [req.cacheKey]);

  if (req.skip) return { status: "ready", rows: NO_ROWS, retry };
  if (settled?.key === key) return { status: settled.status, rows: settled.rows, retry };
  const cached = listCache.get(req.cacheKey);
  if (cached) return { status: "ready", rows: cached.rows, retry };
  return { status: "loading", rows: NO_ROWS, retry };
}

/**
 * How many episodes precede this season in its franchise's continuous
 * numbering, or undefined while unknown. A failed read stays unknown, which
 * only means cumulative numbers past the season show no tag.
 */
export function useEpisodeOffset(anilistId: number): number | undefined {
  const [answer, setAnswer] = useState<{ id: number; offset: number | undefined } | null>(null);

  useEffect(() => {
    if (offsetCache.has(anilistId)) return;
    const controller = new AbortController();
    apiGet<unknown>(episodeOffsetPath(anilistId), { signal: controller.signal })
      .then((data) => {
        const offset = readOffsetAnswer(data);
        offsetCache.set(anilistId, offset);
        setAnswer({ id: anilistId, offset });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("[magnet] episode offset unavailable:", err);
      });
    return () => controller.abort();
  }, [anilistId]);

  if (offsetCache.has(anilistId)) return offsetCache.get(anilistId);
  return answer?.id === anilistId ? answer.offset : undefined;
}
