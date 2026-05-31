// 400MB MKV reads ~1-2s + EBML parse ~2-3s on modern hardware, but cold
// browser cache + slow disk + 4K HDR streams can push past 30s. 120s
// gives headroom for ~2GB files without burning forever on truly bad cases.
const MKV_TIMEOUT_MS = 120000;

// Next-app port: legacy SPA built the worker via Vite `?raw` imports +
// pako_inflate.min.js prepended to a Blob URL — Vite-specific and not
// portable to Next. In next-app we use the framework-native
// `new Worker(new URL(...), { type: 'module' })` pattern, and the
// worker itself imports pako via ESM (see workers/mkvSubtitle.worker.js).
// Webpack/Turbopack handles the dependency graph; we don't have to
// hand-roll the blob concat. Path resolves from _services/ →
// next-app/src/workers/.
function createMkvWorker(): Worker {
  return new Worker(
    new URL("../../../workers/mkvSubtitle.worker.js", import.meta.url),
    { type: "module" },
  );
}

export interface ResolvedSubtitleState {
  url: string;
  type: string;
  content: string | null;
}

export interface ExtractedSubtitle {
  url: string;
  type: string;
  content: string | null;
  isBlob: boolean;
}

export interface MkvExtractionTask {
  promise: Promise<ExtractedSubtitle | null>;
  cancel: () => void;
}

export type ResolveResult =
  | { kind: "sync"; state: ResolvedSubtitleState }
  | { kind: "none" }
  | { kind: "mkv"; task: MkvExtractionTask };

export interface PlaybackFileItemLike {
  file: File;
  fileName: string;
  subtitle?: {
    file: File;
    type: string;
  } | null;
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
export function resolveSubtitle(
  fileItem: PlaybackFileItemLike,
  getSubtitleUrl: (file: File) => string,
): ResolveResult {
  if (fileItem.subtitle) {
    return {
      kind: "sync",
      state: {
        url: getSubtitleUrl(fileItem.subtitle.file),
        type: fileItem.subtitle.type,
        content: null,
      },
    };
  }
  if (!/\.mkv$/i.test(fileItem.fileName)) {
    return { kind: "none" };
  }
  return { kind: "mkv", task: createMkvExtractionTask(fileItem.file) };
}

function createMkvExtractionTask(file: File): MkvExtractionTask {
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveFn: (value: ExtractedSubtitle | null) => void;

  const promise = new Promise<ExtractedSubtitle | null>((resolve) => {
    resolveFn = resolve;
  });

  const finish = (value: ExtractedSubtitle | null) => {
    if (settled) return;
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (worker) {
      // Defensive: nullify handlers so a queued message can't fire createObjectURL
      // after we've decided to bail (real worker.terminate has the same race window).
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      worker = null;
    }
    resolveFn(value);
  };

  worker = createMkvWorker();
  timer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn(
      `[mkvSubtitle] timed out after ${MKV_TIMEOUT_MS}ms — file too large or disk too slow`,
    );
    finish(null);
  }, MKV_TIMEOUT_MS);
  worker.onmessage = (e: MessageEvent) => {
    const extracted = e?.data?.result;
    const err = e?.data?.error;
    if (err) {
      // eslint-disable-next-line no-console
      console.warn("[mkvSubtitle] worker reported error:", err);
      return finish(null);
    }
    if (!extracted) return finish(null);
    const vttText =
      extracted.type === "vtt"
        ? extracted.content
        : extracted.vtt || extracted.content;
    const url = URL.createObjectURL(new Blob([vttText], { type: "text/vtt" }));
    finish({
      url,
      type: extracted.type,
      content: extracted.type !== "vtt" ? extracted.content : null,
      isBlob: true,
    });
  };
  worker.onerror = (err: ErrorEvent) => {
    const detail = err?.message
      ? `${err.message} at ${err.filename || "?"}:${err.lineno ?? "?"}`
      : "(no message — likely worker load/lifecycle error)";
    // eslint-disable-next-line no-console
    console.warn("[mkvSubtitle] worker crashed:", detail);
    finish(null);
  };
  worker.postMessage({ file });

  return { promise, cancel: () => finish(null) };
}
