// Turn one scanned Matroska text track into what the player consumes: the
// raw ASS document jassub renders, and the WebVTT the plaintext layer under
// it shows (and falls back to when libass cannot load).
//
// Moved here from the worker body for the same reason the VTT builders in
// subtitleConvert were: rules about subtitle text should be checkable from
// `bun test`, not only by playing a file.

import {
  buildVttFromMkvAssEvents,
  buildVttFromMkvSrtEvents,
} from "@/lib/subtitleConvert";
import type { MkvSubtitleEvent, MkvTrackData } from "./matroska";

/**
 * How long a cue with no BlockDuration stays up: until the next cue on the
 * same track starts, capped here. The old worker gave every such cue five
 * seconds, which left a line on screen over the one that replaced it.
 */
const MAX_IMPLICIT_DURATION_MS = 5000;

export interface MkvTrackText {
  /** Full ASS script for jassub; null for SRT/VTT tracks. */
  assContent: string | null;
  vtt: string;
}

interface TimedEvent {
  time: number;
  dur: number;
  text: string;
}

/** Sort by start time and give duration-less cues an end. Pure. */
export function timeEvents(events: MkvSubtitleEvent[]): TimedEvent[] {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.time - b.e.time || a.i - b.i)
    .map(({ e }) => e);
  return sorted.map((e, i) => {
    if (e.dur != null) return { time: e.time, dur: e.dur, text: e.text };
    let next: number | null = null;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].time > e.time) {
        next = sorted[j].time;
        break;
      }
    }
    const gap = next == null ? MAX_IMPLICIT_DURATION_MS : next - e.time;
    return { time: e.time, dur: Math.min(gap, MAX_IMPLICIT_DURATION_MS), text: e.text };
  });
}

function assTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

const EVENTS_FORMAT =
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

/**
 * Rebuild an ASS script from a track's CodecPrivate header and its blocks.
 *
 * A Matroska ASS block is `ReadOrder,Layer,Style,Name,MarginL,MarginR,
 * MarginV,Effect,Text`; a Dialogue line is `Layer,Start,End,Style,…,Text`.
 * Lines are emitted in ReadOrder within a start time, which is the order the
 * author wrote them in and the order libass stacks colliding lines by.
 */
export function buildAssScript(header: string, events: TimedEvent[]): string {
  let script = header.replace(/\r\n/g, "\n");
  if (!script.endsWith("\n")) script += "\n";
  if (!/^\[Events\]/im.test(script)) script += `\n[Events]\n${EVENTS_FORMAT}\n`;

  const lines = events.map((ev) => {
    const text = ev.text;
    const c1 = text.indexOf(",");
    const readOrder = c1 >= 0 ? Number(text.slice(0, c1)) : NaN;
    let layer = "0";
    let rest = `Default,,0,0,0,,${text}`;
    if (c1 >= 0) {
      const afterReadOrder = text.slice(c1 + 1);
      const c2 = afterReadOrder.indexOf(",");
      if (c2 >= 0) {
        layer = afterReadOrder.slice(0, c2) || "0";
        rest = afterReadOrder.slice(c2 + 1);
      }
    }
    return {
      time: ev.time,
      readOrder: Number.isFinite(readOrder) ? readOrder : 0,
      line: `Dialogue: ${layer},${assTime(ev.time)},${assTime(ev.time + ev.dur)},${rest}`,
    };
  });
  lines.sort((a, b) => a.time - b.time || a.readOrder - b.readOrder);
  return script + lines.map((l) => l.line).join("\n") + (lines.length ? "\n" : "");
}

export function buildMkvTrackText(track: MkvTrackData): MkvTrackText {
  const events = timeEvents(track.events);
  if (track.format === "ass") {
    return {
      assContent: buildAssScript(track.header, events),
      vtt: buildVttFromMkvAssEvents(events),
    };
  }
  // S_TEXT/UTF8, S_TEXT/ASCII and S_TEXT/WEBVTT blocks are the cue text
  // itself. WebVTT cue settings ride in BlockAdditions, which are dropped.
  return { assContent: null, vtt: buildVttFromMkvSrtEvents(events) };
}
