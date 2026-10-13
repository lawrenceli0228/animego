"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "@/lib/lang-client";
import {
  useSubtitleTracks,
  type SubtitleSourceItem,
  type UseSubtitleTracksResult,
} from "./useSubtitleTracks";

/**
 * Owns the playback half of PlayerPage.
 *
 * Phase: 'none' (no file playing) | 'playing' (video active).
 * Read-only on MatchingMachine: episodeMap is passed as a play() arg, never mutated.
 *
 * Invariants (see docs/designs/playerPage-state-machine.md §五):
 *   1. subtitle blob URL revoked on next play / back / unmount
 *   6. pending subtitle resolution canceled before next play / on back /
 *      unmount, and a stale task's late resolve is ignored.
 *
 * Subtitles are a list now, not one url: every text track in an MKV, every
 * matching sidecar, and any file the reader loads (useSubtitleTracks). #6 is
 * kept there — the scan worker is terminated on the next play, back and
 * unmount, and every result carries the playback key it was started for.
 * #1 moved to VideoPlayer, which now makes the one blob url it shows (it
 * needs the VTT text anyway, to apply the reader's timing offset).
 *
 * P2 session-resume surface:
 *   lastTimeRef — volatile Map<fileId, seconds>; cleared only on unmount.
 *   getLastTime(episodeId) — returns null for unknown ids.
 *   setLastTime(episodeId, sec) — rounds to integer; rejects empty id, non-numeric,
 *     and any value that rounds to ≤ 0 (so 0.4 → round 0 → reject).
 *   resumeAt — read once by VideoPlayer on loadedmetadata; set by play() from Map.
 */

export interface PlaybackFileItem extends SubtitleSourceItem {
  episode: number | null;
  parsedKind?: string | null;
  /**
   * Dexie `Episode.id` (a ULID) — set ONLY when playback started from the
   * library. Its presence is the source split of design doc §3.2: with it,
   * progress is authoritative and syncs; without it (a file dragged onto
   * /player) the localStorage path keeps position only.
   *
   * Not the same thing as `fileId`, which is a `FileRef.id`, nor as the
   * dandanplay `Episode.episodeId`.
   */
  _episodeId?: string;
  /** Dexie `Series.id` owning `_episodeId`. Same library-only lifetime. */
  _seriesId?: string;
}

export type EpisodeMap = Record<
  string | number,
  { dandanEpisodeId?: number | string | null } | undefined
>;

interface UsePlaybackSessionArgs {
  getVideoUrl: (file: File) => string;
  loadComments: (episodeId: number | string) => void | Promise<void>;
  clearComments: () => void;
}

type Phase = "none" | "playing";

interface QueryLocalFontsWindow {
  queryLocalFonts?: () => Promise<unknown>;
}

export interface UsePlaybackSessionResult {
  phase: Phase;
  playingFile: PlaybackFileItem | null;
  playingEp: number | null;
  videoUrl: string | null;
  subtitles: UseSubtitleTracksResult;
  resumeAt: number | null;
  play: (fileItem: PlaybackFileItem, episodeMap?: EpisodeMap) => void;
  back: () => void;
  getLastTime: (episodeId: string) => number | null;
  setLastTime: (episodeId: string, sec: number) => void;
}

export function usePlaybackSession({
  getVideoUrl,
  loadComments,
  clearComments,
}: UsePlaybackSessionArgs): UsePlaybackSessionResult {
  const { lang } = useLang();
  const [playingFile, setPlayingFile] = useState<PlaybackFileItem | null>(null);
  const [playingEp, setPlayingEp] = useState<number | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const subtitles = useSubtitleTracks(lang);
  const { start: startSubtitles, stop: stopSubtitles } = subtitles;

  const lastTimeRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const times = lastTimeRef.current;
    return () => times.clear();
  }, []);

  const getLastTime = useCallback((episodeId: string) => {
    const val = lastTimeRef.current.get(episodeId);
    return val !== undefined ? val : null;
  }, []);

  const setLastTime = useCallback((episodeId: string, sec: number) => {
    if (!episodeId) return;
    if (typeof sec !== "number" || isNaN(sec)) return;
    const rounded = Math.round(sec);
    if (rounded <= 0) return;
    lastTimeRef.current.set(episodeId, rounded);
  }, []);

  const play = useCallback(
    (fileItem: PlaybackFileItem, episodeMap?: EpisodeMap) => {

      // Pre-flight readability probe: read the first 16 bytes so any FSA-handle
      // failure surfaces here as a tagged warning instead of downstream as the
      // <video> element's opaque "NotSupportedError" + a flurry of
      // ERR_FILE_NOT_FOUND on the blob URL. Common causes when this fails:
      //   - NotFoundError       → file moved/renamed after import
      //   - NotAllowedError     → permission revoked / library not reauthorized
      //   - InvalidStateError   → handle invalidated by browser sandbox
      // Fire-and-forget so play() stays synchronous (tests + callers expect sync).
      fileItem.file
        .slice(0, 16)
        .arrayBuffer()
        .catch((err: unknown) => {
          const e = err as { name?: string; message?: string } | null;
          // eslint-disable-next-line no-console
          console.warn(
            "[playback] file unreadable at play() — likely stale FSA handle",
            "name=",
            e?.name,
            "message=",
            e?.message,
            "fileName=",
            fileItem.fileName,
            "size=",
            fileItem.file?.size,
          );
        });

      // P6 verify: gesture-bound.
      // Kick the local-fonts permission prompt from the user-gesture context
      // of this play() call. jassub's CJK fallback runs deep in an async chain
      // (read/extract → jassub mount → loadCjkFallback) where Chrome has
      // already lost transient activation, so calling queryLocalFonts() there
      // silently fails. Triggering here means the prompt actually shows on the
      // first play that will use libass; subsequent plays inherit the
      // granted/denied state. Fire-and-forget — denial falls back to
      // LiberationSans (CJK as tofu), no error.
      //
      // The condition is "will jassub mount", not "is this an MKV". It was the
      // latter while MKV was the only path that produced raw ASS for libass;
      // a sidecar .ass now does too, and gating on the container would have
      // left exactly those files rendering CJK as tofu with nothing to
      // explain why.
      const win =
        typeof window !== "undefined"
          ? (window as Window & QueryLocalFontsWindow)
          : null;
      const mayUseLibass =
        /\.mkv$/i.test(fileItem.fileName) ||
        (fileItem.subtitles ?? []).some((sub) => /^(ass|ssa)$/i.test(sub.type));
      if (win && mayUseLibass && typeof win.queryLocalFonts === "function") {
        try {
          win.queryLocalFonts().catch(() => {});
        } catch {
          /* unsupported */
        }
      }

      const stored = lastTimeRef.current.get(fileItem.fileId);
      setResumeAt(stored !== undefined ? stored : null);

      setVideoUrl(getVideoUrl(fileItem.file));
      setPlayingFile(fileItem);
      setPlayingEp(fileItem.episode);

      const epData =
        fileItem.episode != null ? episodeMap?.[fileItem.episode] : undefined;
      if (epData?.dandanEpisodeId) loadComments(epData.dandanEpisodeId);
      else clearComments();

      startSubtitles(fileItem);
    },
    [getVideoUrl, loadComments, clearComments, startSubtitles],
  );

  const back = useCallback(() => {
    stopSubtitles();
    setPlayingFile(null);
    setPlayingEp(null);
    setVideoUrl(null);
    setResumeAt(null);
    clearComments();
    // lastTimeRef is intentionally NOT cleared — resume survives back→play within session.
  }, [stopSubtitles, clearComments]);

  return {
    phase: playingFile ? "playing" : "none",
    playingFile,
    playingEp,
    videoUrl,
    subtitles,
    resumeAt,
    play,
    back,
    getLastTime,
    setLastTime,
  };
}

export default usePlaybackSession;
