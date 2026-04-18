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

  const mkvBlobUrlRef = useRef(null);
  const subtitleTaskRef = useRef(null);

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
  }, [cancelSubtitleTask, cleanupMkvBlob]);

  const play = useCallback((fileItem, episodeMap) => {
    cancelSubtitleTask();
    cleanupMkvBlob();

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
    clearComments();
  }, [cancelSubtitleTask, cleanupMkvBlob, clearComments]);

  return {
    phase: playingFile ? 'playing' : 'none',
    playingFile,
    playingEp,
    videoUrl,
    subtitleUrl,
    subtitleType,
    subtitleContent,
    play,
    back,
  };
}
