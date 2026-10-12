// Messages between the player and workers/mkvSubtitle.worker.ts.
//
// One request per file. The worker answers with, in order:
//   tracks    — as soon as the Tracks element is read (milliseconds in), so
//               the subtitle menu can list every track before any cue exists
//   fonts     — font attachments, when the Attachments element is reached
//   progress  — fraction scanned, throttled
//   partial   — every text track built from the first slice of the file, so
//               the opening minutes have subtitles while the rest is read
//   done      — every text track, complete
// or `error` at any point. `partial` is sent at most once and may be skipped
// for a small file that finishes first.

import type { MkvTrackInfo } from "./matroska";

export interface MkvWorkerRequest {
  file: File;
}

export interface MkvWorkerTrack extends MkvTrackInfo {
  /** Full ASS script for libass; null for SRT/VTT tracks. */
  assContent: string | null;
  vtt: string;
  cueCount: number;
}

export interface MkvWorkerFont {
  name: string;
  data: Uint8Array;
}

export type MkvWorkerMessage =
  | { type: "tracks"; tracks: MkvTrackInfo[] }
  | { type: "fonts"; fonts: MkvWorkerFont[] }
  | { type: "progress"; fraction: number }
  | { type: "partial"; tracks: MkvWorkerTrack[] }
  | { type: "done"; tracks: MkvWorkerTrack[] }
  | { type: "error"; message: string; notMatroska: boolean };
