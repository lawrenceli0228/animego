"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * dandanplay comment record (raw HTTP shape).
 *   p — "time,mode,color,uid" (comma joined).
 *   m — comment text.
 */
interface DandanCommentRaw {
  p: string;
  m: string;
}

interface DandanCommentsResponse {
  comments?: DandanCommentRaw[];
  count?: number;
}

export interface ArtplayerDanmaku {
  text: string;
  time: number;
  mode: 0 | 1 | 2;
  color: string;
}

/**
 * dandanplay comment format -> ArtPlayer danmuku format.
 * dandanplay mode: 1=scroll, 4=bottom, 5=top
 * ArtPlayer mode:  0=scroll, 1=top,    2=bottom
 */
const MODE_MAP: Record<number, 0 | 1 | 2> = { 1: 0, 4: 2, 5: 1 };

// Exported for unit tests — pure transform with no React deps.
export function dandanToArtplayer(raw: DandanCommentRaw): ArtplayerDanmaku {
  const parts = raw.p.split(",");
  const time = parseFloat(parts[0]);
  const type = parseInt(parts[1], 10);
  const color = parseInt(parts[2], 10);

  return {
    text: raw.m,
    time,
    mode: MODE_MAP[type] ?? 0,
    color: "#" + color.toString(16).padStart(6, "0"),
  };
}

export interface UseDandanCommentsResult {
  danmakuList: ArtplayerDanmaku[];
  loading: boolean;
  error: string | null;
  count: number;
  loadComments: (episodeId: number | string) => Promise<void>;
  clearComments: () => void;
}

export function useDandanComments(): UseDandanCommentsResult {
  const [danmakuList, setDanmakuList] = useState<ArtplayerDanmaku[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadComments = useCallback(async (episodeId: number | string) => {
    if (!episodeId) return;
    setLoading(true);
    setError(null);

    try {
      // dandanplay /comments/:id returns FLAT `{count, comments}` — no
      // `{data: ...}` envelope, so apiGet (which unwraps env.data) yields
      // undefined and silently sets count=0. Plain fetch sees the raw
      // shape directly. /search and /episodes follow the same flat
      // pattern; /match too. Matches DanmakuPicker's plain-fetch style.
      const res = await fetch(`/api/dandanplay/comments/${episodeId}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!mounted.current) return;
      // 401 is handled globally via auth:expired — don't surface as load error
      if (res.status === 401) {
        setDanmakuList([]);
        setCount(0);
        return;
      }
      if (!res.ok) {
        throw new Error(`loadComments: HTTP ${res.status}`);
      }
      const data = (await res.json()) as DandanCommentsResponse;
      if (!mounted.current) return;
      const converted = (data.comments || []).map(dandanToArtplayer);
      setDanmakuList(converted);
      setCount(data.count || 0);
    } catch (err) {
      if (!mounted.current) return;
      const msg =
        err instanceof Error ? err.message : "Failed to load comments";
      setError(msg);
      setDanmakuList([]);
      setCount(0);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const clearComments = useCallback(() => {
    setDanmakuList([]);
    setCount(0);
    setError(null);
  }, []);

  return { danmakuList, loading, error, count, loadComments, clearComments };
}

export default useDandanComments;
