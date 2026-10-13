// Which subtitle files beside a video belong to it.
//
// Used by both entry paths: the drop zone (every file the reader dropped) and
// the library (the video's own folder, listed at play time). It used to pick
// exactly one file per episode — the best by format — so a release shipping
// `.sc.ass` and `.tc.ass` side by side gave the reader whichever sorted
// first, and the library path attached none at all.

export interface SidecarCandidate {
  fileName: string;
  /** Episode number parsed from the file name, when there is one. */
  episode: number | null;
  /** Folder the file sits in, relative to whatever root was picked. */
  dir?: string | null;
  /** "ass" | "ssa" | "srt" | "vtt" — from the extension; null for others. */
  type: string | null;
}

const FORMAT_ORDER: Record<string, number> = { ass: 0, ssa: 1, srt: 2, vtt: 3 };

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** Folder part of a relative path ("a/b/c.mkv" → "a/b"). */
export function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i >= 0 ? relPath.slice(0, i) : "";
}

/**
 * Does `sub` start with the video's name? `Demo - 02.sc.ass` belongs to
 * `Demo - 02.mkv`; `Demo - 02v2.ass` does not, and neither does
 * `Demo - 020.ass` — the name must end or be followed by a separator.
 */
function sharesStem(videoName: string, subName: string): boolean {
  const v = stem(videoName).toLowerCase();
  const s = stem(subName).toLowerCase();
  if (s === v) return true;
  if (!s.startsWith(v)) return false;
  return /^[.\s_\-[(（【]/.test(s.slice(v.length));
}

/**
 * The subtitle files for one video, best first.
 *
 * Files named after the video win outright. Only when there are none does
 * the episode number decide — the drop-zone behaviour this replaces. Either
 * way only the video's folder and the folders directly inside it count when
 * folders are known, so season 2's `- 03.ass` is not attached to season 1's
 * episode 3.
 */
export function matchSidecars<T extends SidecarCandidate>(
  video: { fileName: string; episode: number | null; dir?: string | null },
  subs: T[],
): T[] {
  // The video's folder or a folder directly inside it: releases put their
  // subtitles beside the video, or in `Subs/`, `SC/`, `字幕/`.
  const near = (s: T) =>
    video.dir == null || s.dir == null || s.dir === video.dir || dirOf(s.dir) === video.dir;
  const byName = subs.filter((s) => near(s) && sharesStem(video.fileName, s.fileName));
  const picked = byName.length
    ? byName
    : video.episode != null
      ? subs.filter((s) => near(s) && s.episode === video.episode)
      : [];
  return [...picked].sort(
    (a, b) =>
      (FORMAT_ORDER[a.type ?? ""] ?? 9) - (FORMAT_ORDER[b.type ?? ""] ?? 9) ||
      a.fileName.localeCompare(b.fileName),
  );
}

/**
 * The part of a sidecar's name that describes it, for labelling and for
 * guessing its language: `Demo - 02.sc.ass` → "sc". Reading the whole name
 * would let words in the show's title ("日常") pass for a language tag.
 */
export function sidecarDescriptor(videoName: string, subName: string): string {
  const s = stem(subName);
  if (sharesStem(videoName, subName)) {
    return s.slice(stem(videoName).length).replace(/^[.\s_-]+/, "").trim();
  }
  return s;
}
