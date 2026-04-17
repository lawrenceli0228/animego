import { useEffect, useRef } from 'react';
import Artplayer from 'artplayer';
import artplayerPluginDanmuku from 'artplayer-plugin-danmuku';

const s = {
  wrapper: { width: '100%', position: 'relative' },
  player: { width: '100%', aspectRatio: '16/9', background: '#000' },
};

const PROGRESS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SAVE_INTERVAL_MS = 5000;
const RESTORE_MIN_SECONDS = 5;
const RESTORE_TAIL_MARGIN = 10;

function readProgress(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.t !== 'number') return null;
    if (Date.now() - (parsed.savedAt || 0) > PROGRESS_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.t;
  } catch {
    return null;
  }
}

function writeProgress(key, t) {
  try {
    localStorage.setItem(key, JSON.stringify({ t, savedAt: Date.now() }));
  } catch {
    // storage full or disabled — ignore
  }
}

export default function VideoPlayer({ videoUrl, danmakuList, subtitleUrl, onEnded, progressKey }) {
  const containerRef = useRef(null);
  const artRef = useRef(null);
  const progressKeyRef = useRef(progressKey);

  // Keep the ref in sync so event handlers always see the latest key
  useEffect(() => { progressKeyRef.current = progressKey; }, [progressKey]);

  useEffect(() => {
    if (!containerRef.current || !videoUrl) return;

    const subtitleConfig = subtitleUrl
      ? { url: subtitleUrl, type: 'vtt', encoding: 'utf-8', style: { color: '#fff', fontSize: '20px' } }
      : {};

    const art = new Artplayer({
      container: containerRef.current,
      url: videoUrl,
      autoSize: true,
      fullscreen: true,
      autoplay: true,
      theme: '#0a84ff',
      volume: 0.8,
      subtitle: subtitleConfig,
      plugins: [
        artplayerPluginDanmuku({
          danmuku: danmakuList || [],
          speed: 5,
          opacity: 0.8,
          fontSize: 24,
          antiOverlap: true,
          synchronousPlayback: true,
          emitter: false,
        }),
      ],
    });

    if (onEnded) art.on('video:ended', onEnded);

    // Progress memory: restore on canplay, throttle-save on timeupdate
    let restored = false;
    let lastSaveAt = 0;
    art.on('video:canplay', () => {
      const key = progressKeyRef.current;
      if (!key || restored) return;
      restored = true;
      const saved = readProgress(key);
      if (saved != null && saved > RESTORE_MIN_SECONDS && saved < art.duration - RESTORE_TAIL_MARGIN) {
        art.currentTime = saved;
      }
    });
    art.on('video:timeupdate', () => {
      const key = progressKeyRef.current;
      if (!key) return;
      const now = Date.now();
      if (now - lastSaveAt < SAVE_INTERVAL_MS) return;
      lastSaveAt = now;
      if (art.currentTime > RESTORE_MIN_SECONDS) writeProgress(key, art.currentTime);
    });

    artRef.current = art;
    return () => {
      // Save final position before teardown (episode switch or unmount)
      const key = progressKeyRef.current;
      if (key && art.currentTime > RESTORE_MIN_SECONDS && art.currentTime < art.duration - RESTORE_TAIL_MARGIN) {
        writeProgress(key, art.currentTime);
      }
      art.destroy(false);
      artRef.current = null;
    };
  }, [videoUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Patch subtitle dynamically without recreating player
  useEffect(() => {
    const art = artRef.current;
    if (!art || !subtitleUrl) return;
    art.subtitle.switch(subtitleUrl, { type: 'vtt', encoding: 'utf-8' });
  }, [subtitleUrl]);

  useEffect(() => {
    const danmuku = artRef.current?.plugins?.artplayerPluginDanmuku;
    if (danmuku && danmakuList?.length) {
      danmuku.load(danmakuList);
    }
  }, [danmakuList]);

  return (
    <div style={s.wrapper}>
      <div ref={containerRef} style={s.player} />
    </div>
  );
}
