// Reads a local .mkv off the main thread and reports its text subtitle
// tracks and font attachments. The parsing lives in lib/subtitles/matroska.ts
// and the text building in lib/subtitles/mkvTrackText.ts, both pure and
// tested; this file only connects them to a File and to postMessage. The
// message sequence is described in lib/subtitles/workerProtocol.ts.
//
// The file is read in slices (File.slice), never as one ArrayBuffer: a 2 GB
// episode used to cost 2 GB of memory for as long as the parse ran.

import {
  NotMatroskaError,
  scanMatroska,
  trackInfo,
  type ByteSource,
  type MkvScanResult,
} from "@/lib/subtitles/matroska";
import { buildMkvTrackText } from "@/lib/subtitles/mkvTrackText";
import type { MkvWorkerMessage, MkvWorkerRequest, MkvWorkerTrack } from "@/lib/subtitles/workerProtocol";

const PROGRESS_EVERY_MS = 250;

function post(msg: MkvWorkerMessage, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function fileSource(file: File): ByteSource {
  return {
    size: file.size,
    async read(offset, length) {
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
  };
}

function build(result: MkvScanResult): MkvWorkerTrack[] {
  return result.tracks.map((track) => {
    if (!track.supported) return { ...trackInfo(track), assContent: null, vtt: "", cueCount: 0 };
    const text = buildMkvTrackText(track);
    return { ...trackInfo(track), assContent: text.assContent, vtt: text.vtt, cueCount: track.events.length };
  });
}

self.onmessage = async (e: MessageEvent<MkvWorkerRequest>) => {
  const file = e.data?.file;
  if (!file) return;
  let lastProgress = 0;
  try {
    const result = await scanMatroska(fileSource(file), {
      onTracks: (tracks) => post({ type: "tracks", tracks }),
      onFonts: (fonts) => {
        const copies = fonts.map((f) => ({ name: f.name, data: f.data.slice() }));
        post({ type: "fonts", fonts: copies }, copies.map((f) => f.data.buffer));
      },
      onProgress: (fraction) => {
        const now = Date.now();
        if (now - lastProgress < PROGRESS_EVERY_MS && fraction < 1) return;
        lastProgress = now;
        post({ type: "progress", fraction });
      },
      onPartial: (partial) => post({ type: "partial", tracks: build(partial) }),
    });
    post({ type: "done", tracks: build(result) });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      notMatroska: err instanceof NotMatroskaError,
    });
  }
};
