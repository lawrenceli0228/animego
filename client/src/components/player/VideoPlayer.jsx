import { useEffect, useRef } from 'react';
import Artplayer from 'artplayer';
import { applyHeatmapPath } from '../../lib/heatmapPath';
import { convertAssToVtt, convertSrtToVtt } from '../../utils/subtitleConvert';

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

// Playback rate selector — selector mode renders a list, far better UX than slider for discrete steps.
const PLAYBACK_RATE_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const PLAYBACK_RATE_DEFAULT = 1.0;
const PLAYBACK_RATE_KEY = 'animego:playbackRate';

// Danmaku visibility toggle — switch type, persisted across sessions.
const DANMAKU_VISIBLE_DEFAULT = true;
const DANMAKU_VISIBLE_KEY = 'animego:danmakuVisible';

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function readNumberPref(key, min, max, fallback) {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    const raw = Number(stored);
    if (!Number.isFinite(raw)) return fallback;
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

function readPlaybackRate() {
  try {
    const raw = Number(localStorage.getItem(PLAYBACK_RATE_KEY));
    if (!Number.isFinite(raw) || raw === 0) return PLAYBACK_RATE_DEFAULT;
    // Snap to nearest known rate so an out-of-list value does not hang the UI.
    return PLAYBACK_RATE_OPTIONS.includes(raw) ? raw : PLAYBACK_RATE_DEFAULT;
  } catch {
    return PLAYBACK_RATE_DEFAULT;
  }
}

function writePlaybackRate(v) {
  try {
    localStorage.setItem(PLAYBACK_RATE_KEY, String(v));
  } catch {
    // ignore
  }
}

function readDanmakuVisible() {
  try {
    const raw = localStorage.getItem(DANMAKU_VISIBLE_KEY);
    if (raw == null) return DANMAKU_VISIBLE_DEFAULT;
    return raw === '1';
  } catch {
    return DANMAKU_VISIBLE_DEFAULT;
  }
}

// Heatmap curve geometry. Plugin's hardcoded yMax=128 keeps peaks subtle, which
// is the look we want at this band size. HeatmapTuner can override via the
// 'animego.heatmapConfig' localStorage key.
const HEATMAP_DEFAULTS = {
  sampling: 7,
  smoothing: 0.35,
  flattening: 0.05,
  scale: 0.011,
  minHeight: 4,
};

function loadHeatmapConfig() {
  try {
    const raw = localStorage.getItem('animego.heatmapConfig');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeDanmakuVisible(v) {
  try {
    localStorage.setItem(DANMAKU_VISIBLE_KEY, v ? '1' : '0');
  } catch {
    // ignore
  }
}

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

export default function VideoPlayer({
  videoUrl,
  danmakuList,
  subtitleUrl,
  onEnded,
  progressKey,
  resumeAt = null,
  onProgressTick,
}) {
  const containerRef = useRef(null);
  const artRef = useRef(null);
  const fileInputRef = useRef(null);
  const userSubtitleBlobRef = useRef(null);
  const progressKeyRef = useRef(progressKey);
  const danmakuListRef = useRef(danmakuList);
  const subtitleSizeRef = useRef(readSubtitleSize());
  const subtitleOffsetRef = useRef(readSubtitleOffset());
  const playbackRateRef = useRef(readPlaybackRate());
  const danmakuVisibleRef = useRef(readDanmakuVisible());
  // P2 in-memory resume — used only when progressKey is absent (unmatched files).
  const resumeAtRef = useRef(resumeAt);
  const onProgressTickRef = useRef(onProgressTick);

  // Keep refs in sync so async init / event handlers always see the latest values.
  useEffect(() => { progressKeyRef.current = progressKey; }, [progressKey]);
  useEffect(() => { danmakuListRef.current = danmakuList; }, [danmakuList]);
  useEffect(() => { resumeAtRef.current = resumeAt; }, [resumeAt]);
  useEffect(() => { onProgressTickRef.current = onProgressTick; }, [onProgressTick]);

  useEffect(() => {
    if (!containerRef.current || !videoUrl) return;

    // Race guard: cleanup must not await but the artplayer init does. Without
    // this flag, a teardown that fires before the dynamic import resolves
    // would leak an Artplayer instance.
    let cancelled = false;
    let art = null;

    const initialSize = subtitleSizeRef.current;
    const initialOffset = subtitleOffsetRef.current;
    const initialRate = playbackRateRef.current;
    const initialDanmakuVisible = danmakuVisibleRef.current;
    const subtitleConfig = subtitleUrl
      ? {
          url: subtitleUrl,
          type: 'vtt',
          encoding: 'utf-8',
          style: { color: '#fff', fontSize: `${initialSize}px`, bottom: `${initialOffset}px` },
        }
      : {};

    (async () => {
      // Dynamic import keeps artplayer-plugin-danmuku out of the entry chunk.
      // The plugin is only fetched the first time a player mounts.
      const { default: artplayerPluginDanmuku } = await import('artplayer-plugin-danmuku');
      if (cancelled) return;

      art = new Artplayer({
        container: containerRef.current,
        url: videoUrl,
        autoSize: true,
        fullscreen: true,
        autoplay: true,
        theme: '#0a84ff',
        volume: 0.8,
        // playbackRate option is a boolean flag in artplayer 5.x — it gates
        // the built-in rate controls. The actual rate is set on the instance
        // after construction (see below). Keeping our custom selector means
        // we don't need artplayer's default rate UI.
        playbackRate: false,
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
          {
            html: '倍速',
            tooltip: `${initialRate}x`,
            selector: PLAYBACK_RATE_OPTIONS.map((rate) => ({
              html: `${rate}x`,
              value: rate,
              default: rate === initialRate,
            })),
            onSelect(item) {
              const v = Number(item.value);
              playbackRateRef.current = v;
              writePlaybackRate(v);
              art.playbackRate = v;
              return `${v}x`;
            },
          },
          {
            html: '弹幕开关',
            tooltip: initialDanmakuVisible ? '开' : '关',
            switch: initialDanmakuVisible,
            onSwitch(item) {
              const next = !item.switch;
              danmakuVisibleRef.current = next;
              writeDanmakuVisible(next);
              const danmuku = art.plugins?.artplayerPluginDanmuku;
              if (next) danmuku?.show?.();
              else danmuku?.hide?.();
              return next;
            },
          },
          {
            html: '加载字幕文件',
            tooltip: '本地 .vtt / .srt / .ass',
            selector: [{ html: '点击选择…', value: 'pick' }],
            onSelect() {
              fileInputRef.current?.click();
              return '点击选择…';
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
            // maxLength caps simultaneously-rendered danmaku so 1k+ comment
            // streams do not stall the compositor.
            maxLength: 60,
            // Disable seek-time backfill: Artplayer's synchronousPlayback batches
            // queued comments on seek which jank-spikes when the queue is large.
            synchronousPlayback: false,
            emitter: false,
            heatmap: {
              ...HEATMAP_DEFAULTS,
              ...(loadHeatmapConfig() || {}),
              opacity: 0.4,
            },
          }),
        ],
      });

      // Apply initial danmaku visibility (plugin defaults to visible).
      if (!initialDanmakuVisible) {
        art.plugins?.artplayerPluginDanmuku?.hide?.();
      }

      // Apply initial playback rate. artplayer.options.playbackRate is a
      // boolean flag, not a value — the actual rate goes on the instance
      // after construction, once the <video> element exists.
      art.on('video:loadedmetadata', () => {
        if (art.playbackRate !== initialRate) art.playbackRate = initialRate;
      });

      if (onEnded) art.on('video:ended', onEnded);

      // Progress memory: restore on canplay, throttle-save on timeupdate
      let restored = false;
      let lastSaveAt = 0;
      art.on('video:canplay', () => {
        if (restored) return;
        restored = true;
        const key = progressKeyRef.current;
        // localStorage path (matched files) takes precedence — richer signal,
        // survives reload. Fall back to in-memory resumeAt only when no key.
        if (key) {
          const saved = readProgress(key);
          if (saved != null && saved > RESTORE_MIN_SECONDS && saved < art.duration - RESTORE_TAIL_MARGIN) {
            art.currentTime = saved;
          }
          return;
        }
        const ra = resumeAtRef.current;
        if (typeof ra === 'number' && ra > RESTORE_MIN_SECONDS && ra < art.duration - RESTORE_TAIL_MARGIN) {
          art.currentTime = ra;
        }
      });
      art.on('video:timeupdate', () => {
        const now = Date.now();
        if (now - lastSaveAt < SAVE_INTERVAL_MS) return;
        lastSaveAt = now;
        const key = progressKeyRef.current;
        if (key && art.currentTime > RESTORE_MIN_SECONDS) writeProgress(key, art.currentTime);
        // P2: also notify the hook so unmatched files can resume across episode switches.
        const tick = onProgressTickRef.current;
        if (tick && art.currentTime > RESTORE_MIN_SECONDS) tick(art.currentTime);
      });

      // Heatmap is always visible (design tuning) — set the attribute so the
      // CSS [data-heatmap-always="1"] rule keeps opacity:1 regardless of hover.
      const playerEl = art.template?.$player;
      if (playerEl) playerEl.setAttribute('data-heatmap-always', '1');

      // Per-episode dynamic yMax override. Plugin's hardcoded yMax=128 squashes
      // peaks to ~8% of band height (max bucket count is typically ~10), so
      // most of the band is empty above the curve. applyHeatmapPath rescales
      // yMax to the actual max so peaks fill the band. setTimeout 0 lets
      // plugin innerHTML resolve before we read svg.viewBox.
      const heatmapOpts = { ...HEATMAP_DEFAULTS, ...(loadHeatmapConfig() || {}) };
      const scheduleHeatmapPathOverride = () => {
        setTimeout(() => applyHeatmapPath(art, heatmapOpts), 0);
      };
      art.on('ready', scheduleHeatmapPathOverride);
      art.on('resize', scheduleHeatmapPathOverride);
      art.on('artplayerPluginDanmuku:loaded', scheduleHeatmapPathOverride);
      art.on('artplayerPluginDanmuku:points', scheduleHeatmapPathOverride);

      if (cancelled) {
        art.destroy(false);
        return;
      }
      artRef.current = art;

      // Expose for HeatmapTuner — dev-only, gated.
      if (import.meta.env.DEV || (typeof localStorage !== 'undefined' && localStorage.getItem('animego.heatmapTuner') === '1')) {
        window.__artInstance = art;
      }

      // The [danmakuList] effect below fires synchronously on render, before
      // this async init resolves — at that point artRef.current is still null
      // so its config/load calls are no-ops. Replay the current list now.
      const danmuku = art.plugins?.artplayerPluginDanmuku;
      danmuku?.config?.({ danmuku: danmakuListRef.current || [] });
      danmuku?.load?.();
    })();

    return () => {
      cancelled = true;
      const inst = artRef.current || art;
      if (!inst) return;
      // Save final position before teardown (episode switch or unmount)
      const key = progressKeyRef.current;
      if (key && inst.currentTime > RESTORE_MIN_SECONDS && inst.currentTime < inst.duration - RESTORE_TAIL_MARGIN) {
        writeProgress(key, inst.currentTime);
      }
      // P2: also flush in-memory tick so the next play() can resume.
      const tick = onProgressTickRef.current;
      if (tick && inst.currentTime > RESTORE_MIN_SECONDS && inst.currentTime < inst.duration - RESTORE_TAIL_MARGIN) {
        tick(inst.currentTime);
      }
      inst.destroy(false);
      artRef.current = null;
      if (typeof window !== 'undefined' && window.__artInstance === inst) {
        window.__artInstance = null;
      }
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

  // Manual subtitle file pick — invoked from artplayer's "加载字幕文件"
  // settings entry. Routes by extension:
  //   .vtt        → load directly
  //   .srt        → swap `,` for `.` in timestamps + add WEBVTT header
  //   .ass / .ssa → convert via subtitleConvert.convertAssToVtt (plain
  //                 text only — typesetting / colors / animations are
  //                 stripped because artplayer's renderer is VTT-only;
  //                 full ASS fidelity needs libass-wasm)
  async function handleSubtitleFilePick(e) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const art = artRef.current;
    if (!art) return;

    const ext = (file.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
    let url;
    try {
      if (ext === 'vtt') {
        url = URL.createObjectURL(file);
      } else if (ext === 'srt') {
        const text = await file.text();
        url = URL.createObjectURL(new Blob([convertSrtToVtt(text)], { type: 'text/vtt' }));
      } else if (ext === 'ass' || ext === 'ssa') {
        const text = await file.text();
        url = URL.createObjectURL(new Blob([convertAssToVtt(text)], { type: 'text/vtt' }));
      } else {
        // Unknown extension — try as VTT, may fail silently if not parseable.
        url = URL.createObjectURL(file);
      }
    } catch (err) {
      console.warn('[VideoPlayer] subtitle file load failed:', err);
      art.notice.show = `字幕加载失败: ${err?.message || err}`;
      return;
    }

    if (userSubtitleBlobRef.current) {
      try { URL.revokeObjectURL(userSubtitleBlobRef.current); } catch { /* ignore */ }
    }
    userSubtitleBlobRef.current = url;

    art.subtitle.switch(url, {
      type: 'vtt',
      encoding: 'utf-8',
      style: {
        color: '#fff',
        fontSize: `${subtitleSizeRef.current}px`,
        bottom: `${subtitleOffsetRef.current}px`,
      },
    });
    art.notice.show = `已加载字幕: ${file.name}`;
  }

  return (
    <div style={s.wrapper}>
      <div ref={containerRef} style={s.player} />
      <input
        ref={fileInputRef}
        type="file"
        accept=".vtt,.srt,.ass,.ssa"
        style={{ display: 'none' }}
        onChange={handleSubtitleFilePick}
        data-testid="video-player-subtitle-file-input"
      />
    </div>
  );
}
