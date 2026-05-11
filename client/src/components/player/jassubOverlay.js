/**
 * jassub (libass-wasm) overlay for full ASS subtitle fidelity.
 *
 * Used when the playback session has subtitleType='ass' (typical case:
 * MKV with embedded ASS extracted by mkvSubtitle.worker.js). jassub renders
 * styled subtitles to a WebGL canvas overlaid on art.video — preserving
 * fonts, positioning, colors, and animations that the VTT fallback strips.
 *
 * Canvas placement is explicit (not jassub's default insertAdjacentElement)
 * so we control z-index and avoid getting buried under artplayer's mask /
 * controls / poster layers. We attach the canvas to the artplayer container
 * (`.art-video-player`) with high z-index so it sits above the video but
 * below the UI controls.
 *
 * Assets (~2MB total) are lazy-loaded so the player chunk stays small.
 */

// jassub entry worker is dist/worker/worker.js — has bare imports
// (abslink, lfa-ponyfill, ../wasm/jassub-worker.js, etc.) that can't be
// served as a static file. Use Vite's `?worker&url` to let Vite bundle
// the worker with all its deps and return a usable URL.
//
// WASM + default.woff2 are static binaries served from public/jassub/
// (copied via postinstall) because Vite doesn't reliably expose
// node_modules subpaths with the right Content-Type under COEP — the
// SPA fallback otherwise returns text/html and libass hangs preloading.
const ASSET_BASE = '/jassub';
const wasmUrl = `${ASSET_BASE}/wasm/jassub-worker.wasm`;
const modernWasmUrl = `${ASSET_BASE}/wasm/jassub-worker-modern.wasm`;
const defaultFontUrl = `${ASSET_BASE}/default.woff2`;

let JASSUB = null;
let workerUrl = null;
let loadPromise = null;

function loadAssets() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [mod, w] = await Promise.all([
      import('jassub'),
      import('jassub/dist/worker/worker.js?worker&url'),
    ]);
    JASSUB = mod.default;
    workerUrl = w.default;
  })();
  return loadPromise;
}

function waitForMetadata(video, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.videoWidth && video.videoHeight) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('loadeddata', onMeta);
      reject(new Error('timeout'));
    }, timeoutMs);
    const onMeta = () => {
      if (!video.videoWidth || !video.videoHeight) return; // sometimes the event fires early
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('loadeddata', onMeta);
      resolve();
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('loadeddata', onMeta);
  });
}

// Load a CJK-capable system font as libass's default fallback. ASS files
// reference fonts like '7GYB4TKY' (subsetted Dream Han SC) that nobody has
// installed — libass falls back to its `defaultFont` which is normally
// LiberationSans (Latin only), so every CJK glyph renders as a missing-
// glyph box. We override the default with PingFang SC / Microsoft YaHei /
// Noto CJK depending on what's available locally. Cached after first load
// so subsequent mounts skip the re-scan.
let cjkFontCache = null; // { name, bytes } | 'none'
const CJK_PREFERENCE = [
  'PingFang SC', 'PingFang TC',         // macOS
  'Hiragino Sans',                       // macOS (Japanese)
  'Microsoft YaHei', 'Microsoft JhengHei', // Windows
  'Noto Sans CJK SC', 'Source Han Sans SC', // Linux
  'Yu Gothic',                           // Windows JP
];

async function loadCjkFallback() {
  if (cjkFontCache === 'none') return null;
  if (cjkFontCache) return cjkFontCache;
  if (typeof window.queryLocalFonts !== 'function') {
    cjkFontCache = 'none';
    return null;
  }
  try {
    const perm = await navigator.permissions.query({ name: 'local-fonts' });
    if (perm.state !== 'granted') {
      cjkFontCache = 'none';
      return null;
    }
    const all = await window.queryLocalFonts();
    for (const name of CJK_PREFERENCE) {
      const match = all.find((f) => f.family === name && /regular/i.test(f.style));
      if (!match) continue;
      const blob = await match.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      cjkFontCache = { name, bytes };
      return cjkFontCache;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[jassub] CJK fallback load failed:', err);
  }
  cjkFontCache = 'none';
  return null;
}

function findArtContainer(video) {
  // Climb to the nearest .art-video-player wrapper. Falls back to immediate
  // parent so we never throw — worst case canvas mounts somewhere reasonable.
  let el = video?.parentElement;
  while (el && !el.classList?.contains('art-video-player')) {
    el = el.parentElement;
  }
  return el || video?.parentElement || null;
}

/**
 * @param {{ video: HTMLVideoElement, subContent: string, fonts?: Uint8Array[] }} opts
 * @returns {Promise<{ instance: import('jassub').default, canvas: HTMLCanvasElement } | null>}
 */
export async function mountJassub({ video, subContent, fonts }) {
  try {
    await loadAssets();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[jassub] asset load failed, falling back to VTT plaintext:', err);
    return null;
  }
  if (!JASSUB || !video || !subContent) return null;

  // jassub spawns emscripten pthread workers that need SharedArrayBuffer.
  // SAB is only exposed when the page is cross-origin isolated (COOP +
  // COEP set by the server). Without it the worker init hangs silently,
  // so we'd rather fall back to VTT than freeze and confuse the user.
  if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
    // eslint-disable-next-line no-console
    console.warn('[jassub] page is not cross-origin isolated (no SharedArrayBuffer access). Falling back to VTT plaintext. Server must send Cross-Origin-Opener-Policy: same-origin + Cross-Origin-Embedder-Policy: credentialless (or require-corp).');
    return null;
  }

  // Wait for video metadata before reading videoWidth. If we hand jassub a
  // video with width=0, its _getElementBoundingBox returns NaN dimensions
  // and the WebGL renderer initializes with garbage state — instance.ready
  // never resolves, no errors fire, just silent breakage.
  if (!video.videoWidth) {
    try {
      await waitForMetadata(video, 5000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[jassub] video metadata not ready in 5s, using VTT fallback:', err.message);
      return null;
    }
  }

  const container = findArtContainer(video);
  if (!container) {
    // eslint-disable-next-line no-console
    console.warn('[jassub] no art-video-player container; falling back to VTT');
    return null;
  }
  // Container must be positioned for our absolute canvas to anchor to it.
  const cs = getComputedStyle(container);
  if (cs.position === 'static') container.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.className = 'JASSUB jassub-overlay';
  // Pre-set the internal buffer to the video's intrinsic dimensions BEFORE
  // JASSUB calls transferControlToOffscreen. Default canvas buffer is
  // 300x150 — transferControlToOffscreen snapshots that and the main thread
  // can no longer change it. Without this, jassub renders at 300x150 then
  // CSS stretches the buffer to fill the player, producing tiny + blurry
  // subtitles ("目を / あわせちゃ..." floating mid-screen).
  // jassub's resize() will later refine via renderer._resizeCanvas (which
  // does work post-transfer because OffscreenCanvas resize is allowed from
  // the worker), but only if the initial ResizeObserver fires with non-
  // zero dimensions — which doesn't always happen during artplayer init.
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  canvas.width = vw;
  canvas.height = vh;
  canvas.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    'width:100%',
    'height:100%',
    'pointer-events:none',
    // Sits above .art-video (z auto/0) and below .art-bottom controls (z:20+).
    'z-index:10',
  ].join(';');
  container.appendChild(canvas);

  // Resolve a CJK-capable fallback before constructing JASSUB. Falls back
  // to null if local-fonts permission is denied — in that case CJK glyphs
  // will render as tofu, but Latin/Sign typesetting still works.
  //
  // We DON'T pre-register the ASS [V4+ Styles] font names against the
  // same CJK bytes (tempting since it would silence the per-event
  // `JASSUB: fontselect:` console.debug spam): libass crashes inside the
  // wasm with `null function` when multiple availableFonts keys point at
  // the same Uint8Array. The default-font fallback path is what we have
  // and it works; users can mute the verbose log via DevTools filter.
  const cjk = await loadCjkFallback();
  const availableFonts = { 'liberation sans': defaultFontUrl };
  let defaultFont = 'liberation sans';
  const seedFonts = [...(fonts ?? [])];
  if (cjk) {
    availableFonts[cjk.name.toLowerCase()] = cjk.bytes;
    defaultFont = cjk.name.toLowerCase();
    seedFonts.push(cjk.bytes);
  }

  try {
    const instance = new JASSUB({
      video,
      canvas,
      subContent,
      workerUrl,
      wasmUrl,
      modernWasmUrl,
      // Pre-load CJK font bytes into libass's font pool so it can use them
      // for glyph fallback when the ASS-referenced fonts (7GYB4TKY etc)
      // aren't present.
      fonts: seedFonts,
      availableFonts,
      // libass's defaultFont is what it uses when the requested family
      // can't be resolved. We point it at PingFang SC (or whichever CJK
      // font we loaded) so missing-font fallback produces CJK glyphs
      // instead of LiberationSans tofu.
      defaultFont,
      // 'local' lets libass walk system fonts via queryLocalFonts(). macOS
      // ships PingFang SC, Windows has Microsoft YaHei, Linux has Noto CJK
      // — any of those resolve the CJK glyphs the ASS asks for (Dream Han
      // SC etc, which are licensed fonts no one has installed). Chrome
      // shows a one-time permission prompt; if denied, libass falls back
      // to LiberationSans (Latin only) and CJK renders as missing-glyph
      // placeholders.
      //
      // Earlier attempts with 'local' hung the worker, but that was
      // because workerUrl pointed at the WASM loader (wrong file) — the
      // abslink RPC channel wasn't set up. Now that the entry worker
      // resolves correctly, queryFonts is safe.
      queryFonts: 'local',
    });

    // Watchdog: if .ready doesn't resolve in 10s, the worker likely hung
    // on WASM init or font lookup. Flag it so the user/dev sees something.
    const readyWatchdog = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn('[jassub] renderer.ready still pending after 10s — worker likely stuck on WASM/font init');
    }, 10000);

    // Once the renderer is ready, force an initial paint so a video paused
    // at mount time renders the active subtitle line. RVFC alone only fires
    // on new frames.
    instance.ready
      .then(async () => {
        clearTimeout(readyWatchdog);
        try {
          await instance.manualRender({
            mediaTime: video.currentTime || 0,
            expectedDisplayTime: performance.now(),
            width: video.videoWidth || 1920,
            height: video.videoHeight || 1080,
          });
        } catch {
          // manualRender failures are non-fatal — RVFC will repaint on play
        }
      })
      .catch((err) => {
        clearTimeout(readyWatchdog);
        // eslint-disable-next-line no-console
        console.warn('[jassub] renderer init failed:', err);
      });

    return { instance, canvas };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[jassub] constructor threw, falling back to VTT plaintext:', err);
    canvas.remove();
    return null;
  }
}

export async function destroyJassub(handle) {
  if (!handle) return;
  // Backward compat: callers may have stored the raw instance (older code).
  const instance = handle.instance ?? handle;
  const canvas = handle.canvas ?? null;
  try {
    await instance?.destroy?.();
  } catch {
    // Already destroyed or worker terminated — ignore.
  }
  if (canvas?.parentNode) canvas.remove();
}
