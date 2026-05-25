"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";

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

function dandanToArtplayer(raw: DandanCommentRaw): ArtplayerDanmaku {
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
      const data = await apiGet<DandanCommentsResponse>(
        `/api/dandanplay/comments/${episodeId}`,
      );
      if (!mounted.current) return;
      const converted = (data.comments || []).map(dandanToArtplayer);
      setDanmakuList(converted);
      setCount(data.count || 0);
    } catch (err) {
      if (!mounted.current) return;
      // 401 is handled globally via auth:expired — don't surface it as a load error
      if (err instanceof ApiError && err.status === 401) {
        setDanmakuList([]);
        setCount(0);
        return;
      }
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
