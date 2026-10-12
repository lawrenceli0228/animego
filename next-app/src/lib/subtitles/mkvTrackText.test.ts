import { describe, expect, test } from "bun:test";

import type { MkvTrackData } from "./matroska";
import { buildAssScript, buildMkvTrackText, timeEvents } from "./mkvTrackText";

function track(over: Partial<MkvTrackData>): MkvTrackData {
  return {
    number: 2,
    codecId: "S_TEXT/ASS",
    format: "ass",
    supported: true,
    name: "",
    language: null,
    languageBcp47: null,
    isDefault: true,
    isForced: false,
    header: "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    events: [],
    ...over,
  };
}

describe("timeEvents", () => {
  test("a cue with no duration lasts until the next cue, at most 5 s", () => {
    const out = timeEvents([
      { time: 1000, dur: null, text: "a" },
      { time: 2500, dur: null, text: "b" },
      { time: 20_000, dur: null, text: "c" },
    ]);
    expect(out.map((e) => e.dur)).toEqual([1500, 5000, 5000]);
  });

  test("sorted by start; a stated duration is kept", () => {
    const out = timeEvents([
      { time: 3000, dur: 800, text: "late" },
      { time: 1000, dur: 9000, text: "early" },
    ]);
    expect(out.map((e) => [e.text, e.dur])).toEqual([
      ["early", 9000],
      ["late", 800],
    ]);
  });
});

describe("buildAssScript", () => {
  test("blocks become Dialogue lines, in ReadOrder within a start time", () => {
    const script = buildAssScript(track({}).header, [
      { time: 1000, dur: 1000, text: "1,0,Default,,0,0,0,,second" },
      { time: 1000, dur: 1000, text: "0,1,Sign,,0,0,0,,first" },
      { time: 61_230, dur: 500, text: "2,0,Default,,0,0,0,,{\\an8}top" },
    ]);
    expect(script.split("\n").filter((l) => l.startsWith("Dialogue"))).toEqual([
      "Dialogue: 1,0:00:01.00,0:00:02.00,Sign,,0,0,0,,first",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,second",
      "Dialogue: 0,0:01:01.23,0:01:01.73,Default,,0,0,0,,{\\an8}top",
    ]);
  });

  test("a header with no [Events] section gets one", () => {
    const script = buildAssScript("[Script Info]\nTitle: x", [{ time: 0, dur: 1000, text: "0,0,Default,,0,0,0,,hi" }]);
    expect(script).toContain("[Events]\nFormat: Layer, Start, End,");
    expect(script.trimEnd().endsWith("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,hi")).toBe(true);
  });
});

describe("buildMkvTrackText", () => {
  test("ASS track: raw script for libass and a plaintext VTT beside it", () => {
    const out = buildMkvTrackText(
      track({ events: [{ time: 500, dur: 1500, text: "0,0,Default,,0,0,0,,{\\c&H00FFFF&}黄色" }] }),
    );
    expect(out.assContent).toContain("Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,{\\c&H00FFFF&}黄色");
    expect(out.vtt).toBe("WEBVTT\n\n00:00:00.500 --> 00:00:02.000\n黄色\n\n");
  });

  test("SRT track: VTT only, override tags stripped", () => {
    const out = buildMkvTrackText(
      track({ format: "srt", codecId: "S_TEXT/UTF8", header: "", events: [{ time: 0, dur: null, text: "{\\an8}顶部" }] }),
    );
    expect(out.assContent).toBeNull();
    expect(out.vtt).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n顶部\n\n");
  });
});
