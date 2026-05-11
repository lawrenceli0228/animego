import mkvWorkerSrc from '../workers/mkvSubtitle.worker.js?raw';
// pako_inflate.min.js attaches to self.pako (UMD detects worker global).
// Prepended to the worker source so the worker can call
// self.pako.inflate(bytes) synchronously — replaces a per-event
// DecompressionStream loop that was ~4s/episode on 2000+ events.
import pakoInflateSrc from 'pako/dist/pako_inflate.min.js?raw';

// 400MB MKV reads ~1-2s + EBML parse ~2-3s on modern hardware, but cold
// browser cache + slow disk + 4K HDR streams can push past 30s. 120s
// gives headroom for ~2GB files without burning forever on truly bad cases.
const MKV_TIMEOUT_MS = 120000;

// Blob-URL worker factory. Bypasses Vite's worker pipeline entirely:
//   1. ?raw imports inline the worker source + pako inflate as strings
//   2. We concat them into a Blob and createObjectURL → guaranteed
//      same-origin, immune to COEP/CORP enforcement quirks that broke
//      `new Worker(new URL(...))` and `?worker` imports
//
// Trade-off: ~29KB inlined (5KB worker + 24KB pako) into the main
// resolveSubtitle.js chunk. That chunk is already lazy-loaded from the
// player route so the player-only audience pays.
function createMkvWorker() {
  // pako prepended so the worker's self.pako.inflate is defined before
  // the worker body executes.
  const blob = new Blob([pakoInflateSrc, '\n', mkvWorkerSrc], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  // Classic (non-module) worker — mkvSubtitle.worker.js has no import/export
  // syntax so it works either way; classic avoids the cross-origin module
  // script CSP check that broke the import-based variants. The blob URL is
  // revoked when the worker terminates (finish() in createMkvExtractionTask
  // already terminates on settle), so we don't leak.
  const w = new Worker(blobUrl);
  w.__blobUrl = blobUrl;
  return w;
}

/**
 * Decide subtitle source for a playback file.
 *
 * Returns one of:
 *   { kind: 'sync', state: { url, type, content } } — external subtitle, apply immediately
 *   { kind: 'none' } — no subtitle (non-mkv with no external attachment)
 *   { kind: 'mkv', task: { promise, cancel } } — needs async worker extraction
 *
 * The mkv task's promise resolves to:
 *   null — extraction failed / timed out / canceled
 *   { url, type, content, isBlob } — extracted; isBlob=true means caller owns
 *     the blob URL and must revoke when done
 *
 * cancel() terminates the pending worker. No-op once the promise has settled.
 */
export function resolveSubtitle(fileItem, getSubtitleUrl) {
  if (fileItem.subtitle) {
    return {
      kind: 'sync',
      state: {
        url: getSubtitleUrl(fileItem.subtitle.file),
        type: fileItem.subtitle.type,
        content: null,
      },
    };
  }
  if (!/\.mkv$/i.test(fileItem.fileName)) {
    return { kind: 'none' };
  }
  return { kind: 'mkv', task: createMkvExtractionTask(fileItem.file) };
}

function createMkvExtractionTask(file) {
  let worker = null;
  let timer = null;
  let settled = false;
  let resolveFn;

  const promise = new Promise((resolve) => { resolveFn = resolve; });

  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (worker) {
      // Defensive: nullify handlers so a queued message can't fire createObjectURL
      // after we've decided to bail (real worker.terminate has the same race window).
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.terminate(); } catch { /* already gone */ }
      // Revoke the blob URL allocated by createMkvWorker so we don't leak
      // one Object URL per playback session.
      if (worker.__blobUrl) {
        try { URL.revokeObjectURL(worker.__blobUrl); } catch { /* gone */ }
      }
      worker = null;
    }
    resolveFn(value);
  };

  worker = createMkvWorker();
  timer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn(`[mkvSubtitle] timed out after ${MKV_TIMEOUT_MS}ms — file too large or disk too slow`);
    finish(null);
  }, MKV_TIMEOUT_MS);
  worker.onmessage = (e) => {
    const extracted = e?.data?.result;
    const err = e?.data?.error;
    if (err) {
      // eslint-disable-next-line no-console
      console.warn('[mkvSubtitle] worker reported error:', err);
      return finish(null);
    }
    if (!extracted) return finish(null);
    const vttText = extracted.type === 'vtt'
      ? extracted.content
      : (extracted.vtt || extracted.content);
    const url = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt' }));
    finish({
      url,
      type: extracted.type,
      content: extracted.type !== 'vtt' ? extracted.content : null,
      isBlob: true,
    });
  };
  worker.onerror = (err) => {
    const detail = err?.message
      ? `${err.message} at ${err.filename || '?'}:${err.lineno ?? '?'}`
      : '(no message — likely worker load/lifecycle error)';
    // eslint-disable-next-line no-console
    console.warn('[mkvSubtitle] worker crashed:', detail);
    finish(null);
  };
  worker.postMessage({ file });

  return { promise, cancel: () => finish(null) };
}
