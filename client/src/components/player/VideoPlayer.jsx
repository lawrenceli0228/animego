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

// Subtitle font size in px. Range used for the Artplayer slider.
const SUBTITLE_SIZE_MIN = 14;
const SUBTITLE_SIZE_MAX = 48;
const SUBTITLE_SIZE_STEP = 2;
const SUBTITLE_SIZE_DEFAULT = 20;
const SUBTITLE_SIZE_KEY = 'animego:subtitleFontSize';

// Distance from bottom of the video in px. Artplayer's progress bar + controls
// sit in the bottom ~50px, so the default lifts subtitles above them.
const SUBTITLE_OFFSET_MIN = 10;
const SUBTITLE_OFFSET_MAX = 200;
const SUBTITLE_OFFSET_STEP = 5;
const SUBTITLE_OFFSET_DEFAULT = 60;
const SUBTITLE_OFFSET_KEY = 'animego:subtitleOffset';

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function readNumberPref(key, min, max, fallback) {
  try {
    const raw = Number(localStorage.getItem(key));
    if (!Number.isFinite(raw) || raw === 0) return fallback;
    return clamp(raw, min, max);
  } catch {
    return fallback;
  }
}

function writeNumberPref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // storage full or disabled — ignore
  }
}

const readSubtitleSize = () =>
  readNumberPref(SUBTITLE_SIZE_KEY, SUBTITLE_SIZE_MIN, SUBTITLE_SIZE_MAX, SUBTITLE_SIZE_DEFAULT);
const writeSubtitleSize = (v) => writeNumberPref(SUBTITLE_SIZE_KEY, v);
const readSubtitleOffset = () =>
  readNumberPref(SUBTITLE_OFFSET_KEY, SUBTITLE_OFFSET_MIN, SUBTITLE_OFFSET_MAX, SUBTITLE_OFFSET_DEFAULT);
const writeSubtitleOffset = (v) => writeNumberPref(SUBTITLE_OFFSET_KEY, v);

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
  const subtitleSizeRef = useRef(readSubtitleSize());
  const subtitleOffsetRef = useRef(readSubtitleOffset());

  // Keep the ref in sync so event handlers always see the latest key
  useEffect(() => { progressKeyRef.current = progressKey; }, [progressKey]);

  useEffect(() => {
    if (!containerRef.current || !videoUrl) return;

    const initialSize = subtitleSizeRef.current;
    const initialOffset = subtitleOffsetRef.current;
    const subtitleConfig = subtitleUrl
      ? {
          url: subtitleUrl,
          type: 'vtt',
          encoding: 'utf-8',
          style: { color: '#fff', fontSize: `${initialSize}px`, bottom: `${initialOffset}px` },
        }
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
      setting: true,
      settings: [
        {
          html: '字幕大小',
          width: 220,
          tooltip: `${initialSize}px`,
          range: [initialSize, SUBTITLE_SIZE_MIN, SUBTITLE_SIZE_MAX, SUBTITLE_SIZE_STEP],
          onChange(item) {
            const v = Number(item.range[0]);
            subtitleSizeRef.current = v;
            writeSubtitleSize(v);
            art.subtitle.style({ fontSize: `${v}px` });
            return `${v}px`;
          },
        },
        {
          html: '字幕位置',
          width: 220,
          tooltip: `${initialOffset}px`,
          range: [initialOffset, SUBTITLE_OFFSET_MIN, SUBTITLE_OFFSET_MAX, SUBTITLE_OFFSET_STEP],
          onChange(item) {
            const v = Number(item.range[0]);
            subtitleOffsetRef.current = v;
            writeSubtitleOffset(v);
            art.subtitle.style({ bottom: `${v}px` });
            return `${v}px`;
          },
        },
      ],
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

  // Patch subtitle dynamically without recreating player.
  // Re-apply the current font size so episode switches don't reset it.
  useEffect(() => {
    const art = artRef.current;
    if (!art || !subtitleUrl) return;
    art.subtitle.switch(subtitleUrl, {
      type: 'vtt',
      encoding: 'utf-8',
      style: {
        color: '#fff',
        fontSize: `${subtitleSizeRef.current}px`,
        bottom: `${subtitleOffsetRef.current}px`,
      },
    });
  }, [subtitleUrl]);

  useEffect(() => {
    const danmuku = artRef.current?.plugins?.artplayerPluginDanmuku;
    if (!danmuku) return;
    // load(list) skips the reset branch (plugin only clears when called with no args).
    // config + load() ensures old danmaku are cleared before the new list is queued.
    danmuku.config({ danmuku: danmakuList || [] });
    danmuku.load();
  }, [danmakuList]);

  return (
    <div style={s.wrapper}>
      <div ref={containerRef} style={s.player} />
    </div>
  );
}
