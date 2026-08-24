// Where a playback file's subtitles come from, and what shape they leave in.
//
// THE INVARIANT THIS FILE OWNS
//
//   `ResolvedSubtitleState.url` is ALWAYS a WebVTT document.
//
// VideoPlayer hands that url to artplayer as `{ type: "vtt" }` at all three
// of its switch sites, and artplayer 5.4 dispatches on `t.type || V(t.url)`:
// saying "vtt" means the bytes are used verbatim and artplayer's own SRT and
// ASS readers never run. So anything that is not already VTT has to be
// converted here — nothing downstream will do it.
//
// That invariant used to hold for MKV-extracted subtitles and NOT for sidecar
// files, which were handed over as raw blob URLs of the original .srt / .ass.
// A raw SRT has no `WEBVTT` header, so the browser's TextTrack parser
// rejected the whole file and the reader got no subtitles at all — and since
// sidecar matching prefers .ass first (`SUB_PRIORITY` in useVideoFiles), the
// format most likely to be picked was the one guaranteed to render nothing.
//
// `type` on the way out is the SOURCE format, not the url's format. Its only
// consumer is VideoPlayer's jassub gate (`subtitleType !== "ass"`), which asks
// "is `content` raw ASS that libass can render?" — a different question from
// "what is in the url".

import { convertAssToVtt, convertSrtToVtt } from "@/lib/subtitleConvert";

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
    new URL("../../../../workers/mkvSubtitle.worker.js", import.meta.url),
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

/**
 * An in-flight resolution. Two things produce one: reading a sidecar file,
 * and extracting an MKV's embedded track.
 *
 * Named for what it is rather than for the MKV path that used to be its only
 * producer — the caller's stale-task guard, cancellation and blob ownership
 * apply identically to both, and a sidecar `.srt` arriving under a field
 * called `mkv` would be the kind of name that sends the next reader the wrong
 * way.
 */
export interface SubtitleTask {
  promise: Promise<ExtractedSubtitle | null>;
  cancel: () => void;
}

export type ResolveResult =
  /** Already VTT — nothing to read, nothing to convert. */
  | { kind: "sync"; state: ResolvedSubtitleState }
  | { kind: "none" }
  | { kind: "async"; task: SubtitleTask };

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
 *   { kind: 'sync', state } — a sidecar that is ALREADY VTT; use it as-is
 *   { kind: 'none' }        — nothing to show (non-mkv, no sidecar)
 *   { kind: 'async', task } — has to be read and converted first: a sidecar
 *                             .srt/.ass/.ssa, or an MKV's embedded track
 *
 * The task's promise resolves to:
 *   null — read/extraction failed, timed out, or was cancelled
 *   { url, type, content, isBlob } — isBlob=true means the CALLER owns that
 *     blob url and must revoke it, including when it arrives late and stale
 *
 * cancel() is safe at any point: before the read settles it resolves `null`
 * and creates no blob; after, it is a no-op and the caller's stale-task guard
 * does the revoking.
 *
 * Note what `sync` does NOT cover any more. A sidecar `.srt` or `.ass` used to
 * come back this way, as a raw blob url — which artplayer, told `type: "vtt"`,
 * passed to the browser verbatim. Without a `WEBVTT` header the TextTrack
 * parser rejects the file outright, so those readers saw no subtitles at all
 * rather than badly-styled ones. See the header for the invariant.
 */
export function resolveSubtitle(
  fileItem: PlaybackFileItemLike,
  getSubtitleUrl: (file: File) => string,
): ResolveResult {
  if (fileItem.subtitle) {
    const format = (fileItem.subtitle.type || "").toLowerCase();
    // Already VTT: the file itself satisfies the invariant, so hand over its
    // url directly. Staying synchronous here is not just an optimisation —
    // it avoids a frame where the video plays with no subtitle for the one
    // case that needs no work at all.
    if (format === "vtt" || !NEEDS_CONVERSION.has(format)) {
      return {
        kind: "sync",
        state: {
          url: getSubtitleUrl(fileItem.subtitle.file),
          type: format || fileItem.subtitle.type,
          content: null,
        },
      };
    }
    return {
      kind: "async",
      task: createSidecarTask(fileItem.subtitle.file, format),
    };
  }
  if (!/\.mkv$/i.test(fileItem.fileName)) {
    return { kind: "none" };
  }
  return { kind: "async", task: createMkvExtractionTask(fileItem.file) };
}

/**
 * Sidecar formats that are not VTT and therefore have to be read and
 * converted. Anything outside this set falls through to the synchronous
 * passthrough above, which is the pre-existing behaviour for a file whose
 * extension we do not recognise.
 */
const NEEDS_CONVERSION = new Set(["srt", "ass", "ssa"]);

/**
 * Convert one sidecar subtitle's text to VTT, and say whether libass can use
 * the original.
 *
 * Pure — no File, no Blob, no URL — so the format rules are checkable without
 * a DOM. The raw text is handed back as `assContent` for ASS/SSA precisely
 * because jassub needs the ORIGINAL: the VTT beside it has had every override
 * tag stripped out, which is the whole point of it being the fallback layer.
 */
export function convertSidecarSubtitle(
  text: string,
  format: string,
): { vtt: string; assContent: string | null } {
  const f = (format || "").toLowerCase();
  if (f === "ass" || f === "ssa") {
    return { vtt: convertAssToVtt(text), assContent: text };
  }
  if (f === "srt") {
    return { vtt: convertSrtToVtt(text), assContent: null };
  }
  return { vtt: text, assContent: null };
}

/**
 * Read a sidecar subtitle file and convert it.
 *
 * Shares the task shape with the MKV extractor so the caller needs one
 * cancellation path, one stale-task guard and one blob-ownership rule rather
 * than a special case per source. Cancelling before the read settles resolves
 * `null` and creates no blob; cancelling after it settles is the caller's
 * stale-guard's problem, and that guard already revokes.
 *
 * NEVER REJECTS. A subtitle that cannot be read must not take the episode
 * down with it — the video still plays, just without subtitles.
 */
function createSidecarTask(file: File, format: string): SubtitleTask {
  let cancelled = false;
  let settled = false;
  let resolveFn!: (value: ExtractedSubtitle | null) => void;

  const promise = new Promise<ExtractedSubtitle | null>((resolve) => {
    resolveFn = resolve;
  });

  const finish = (value: ExtractedSubtitle | null) => {
    if (settled) return;
    settled = true;
    resolveFn(value);
  };

  file
    .text()
    .then((text) => {
      if (cancelled) return finish(null);
      const { vtt, assContent } = convertSidecarSubtitle(text, format);
      finish({
        url: URL.createObjectURL(new Blob([vtt], { type: "text/vtt" })),
        type: format,
        content: assContent,
        isBlob: true,
      });
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(
        "[resolveSubtitle] sidecar read failed:",
        err instanceof Error ? err.message : err,
      );
      finish(null);
    });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      finish(null);
    },
  };
}

function createMkvExtractionTask(file: File): SubtitleTask {
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
