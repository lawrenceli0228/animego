import { useState, useCallback, useRef, useEffect } from 'react';
import { resolveSubtitle } from '../utils/resolveSubtitle';

/**
 * Owns the playback half of PlayerPage.
 *
 * Phase: 'none' (no file playing) | 'playing' (video active).
 * Read-only on MatchingMachine: episodeMap is passed as a play() arg, never mutated.
 *
 * Invariants (see docs/designs/playerPage-state-machine.md §五):
 *   1. mkv blob URL revoked on next play / back / unmount
 *   6. pending mkv extraction canceled before next play / on back / unmount,
 *      and a stale task's late resolve is ignored.
 *
 * P2 session-resume surface:
 *   lastTimeRef — volatile Map<fileId, seconds>; cleared only on unmount.
 *   getLastTime(episodeId) — returns null for unknown ids.
 *   setLastTime(episodeId, sec) — rounds to integer; rejects empty id, non-numeric,
 *     and any value that rounds to ≤ 0 (so 0.4 → round 0 → reject).
 *   resumeAt — read once by VideoPlayer on loadedmetadata; set by play() from Map.
 */
export default function usePlaybackSession({
  getVideoUrl,
  getSubtitleUrl,
  loadComments,
  clearComments,
}) {
  const [playingFile, setPlayingFile] = useState(null);
  const [playingEp, setPlayingEp] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [subtitleUrl, setSubtitleUrl] = useState(null);
  const [subtitleType, setSubtitleType] = useState(null);
  const [subtitleContent, setSubtitleContent] = useState(null);
  const [resumeAt, setResumeAt] = useState(null);

  const mkvBlobUrlRef = useRef(null);
  const subtitleTaskRef = useRef(null);
  const lastTimeRef = useRef(new Map());

  const cancelSubtitleTask = useCallback(() => {
    if (subtitleTaskRef.current) {
      subtitleTaskRef.current.cancel();
      subtitleTaskRef.current = null;
    }
  }, []);

  const cleanupMkvBlob = useCallback(() => {
    if (mkvBlobUrlRef.current) {
      URL.revokeObjectURL(mkvBlobUrlRef.current);
      mkvBlobUrlRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    cancelSubtitleTask();
    cleanupMkvBlob();
    lastTimeRef.current.clear();
  }, [cancelSubtitleTask, cleanupMkvBlob]);

  const getLastTime = useCallback((episodeId) => {
    const val = lastTimeRef.current.get(episodeId);
    return val !== undefined ? val : null;
  }, []);

  const setLastTime = useCallback((episodeId, sec) => {
    if (!episodeId) return;
    if (typeof sec !== 'number' || isNaN(sec)) return;
    const rounded = Math.round(sec);
    if (rounded <= 0) return;
    lastTimeRef.current.set(episodeId, rounded);
  }, []);

  const play = useCallback((fileItem, episodeMap) => {
    cancelSubtitleTask();
    cleanupMkvBlob();

    const stored = lastTimeRef.current.get(fileItem.fileId);
    setResumeAt(stored !== undefined ? stored : null);

    setVideoUrl(getVideoUrl(fileItem.file));
    setPlayingFile(fileItem);
    setPlayingEp(fileItem.episode);

    const epData = episodeMap?.[fileItem.episode];
    if (epData?.dandanEpisodeId) loadComments(epData.dandanEpisodeId);
    else clearComments();

    const sub = resolveSubtitle(fileItem, getSubtitleUrl);
    if (sub.kind === 'sync') {
      setSubtitleUrl(sub.state.url);
      setSubtitleType(sub.state.type);
      setSubtitleContent(sub.state.content);
      return;
    }

    setSubtitleUrl(null);
    setSubtitleType(null);
    setSubtitleContent(null);

    if (sub.kind !== 'mkv') return;

    subtitleTaskRef.current = sub.task;
    sub.task.promise.then((result) => {
      // Stale task from a previous play() — ignore (invariant #6).
      if (subtitleTaskRef.current !== sub.task) {
        if (result?.isBlob) URL.revokeObjectURL(result.url);
        return;
      }
      subtitleTaskRef.current = null;
      if (!result) return;
      if (result.isBlob) {
        cleanupMkvBlob();
        mkvBlobUrlRef.current = result.url;
      }
      setSubtitleUrl(result.url);
      setSubtitleType(result.type);
      if (result.content != null) setSubtitleContent(result.content);
    });
  }, [getVideoUrl, getSubtitleUrl, loadComments, clearComments, cancelSubtitleTask, cleanupMkvBlob]);

  const back = useCallback(() => {
    cancelSubtitleTask();
    cleanupMkvBlob();
    setPlayingFile(null);
    setPlayingEp(null);
    setVideoUrl(null);
    setSubtitleUrl(null);
    setSubtitleType(null);
    setSubtitleContent(null);
    setResumeAt(null);
    clearComments();
    // lastTimeRef is intentionally NOT cleared — resume survives back→play within session.
  }, [cancelSubtitleTask, cleanupMkvBlob, clearComments]);

  return {
    phase: playingFile ? 'playing' : 'none',
    playingFile,
    playingEp,
    videoUrl,
    subtitleUrl,
    subtitleType,
    subtitleContent,
    resumeAt,
    play,
    back,
    getLastTime,
    setLastTime,
  };
}
