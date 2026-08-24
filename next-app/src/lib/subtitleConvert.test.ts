import { describe, expect, test } from "bun:test";

import {
  buildVttFromMkvAssEvents,
  buildVttFromMkvSrtEvents,
  convertAssToVtt,
  convertSrtToVtt,
  msToVttTime,
  stripAssOverrideTags,
} from "./subtitleConvert";

// What `{\an8}` on screen actually meant.
//
// Four places in this repo answered "what does a plaintext renderer do with
// ASS override tags?" and only two of them said "strip":
//
//   convertAssToVtt            ✅  manual .ass pick
//   convertSrtToVtt            ❌  manual .srt pick
//   MKV ASS-track VTT fallback ✅  (its own copy of the regex)
//   MKV SRT-track VTT          ❌  ← the reported bug
//
// The SRT branch is the one a reader hits, because an MKV with only an
// `S_TEXT/UTF8` track reports its output as already-VTT: jassub's gate stays
// shut and artplayer's own SRT reader (which does strip) is skipped too. So
// nothing downstream corrects it.
//
// These tests pin the rule in one place and pin both MKV builders to it.

const AN8_LINE = "{\\an8}而新年的时候";

describe("stripAssOverrideTags", () => {
  test("removes an override block and keeps the text", () => {
    expect(stripAssOverrideTags(AN8_LINE)).toBe("而新年的时候");
  });

  test("removes several blocks in one line", () => {
    expect(stripAssOverrideTags("{\\an8}{\\b1}粗体{\\b0}尾巴")).toBe("粗体尾巴");
  });

  test("turns ASS line breaks into real newlines", () => {
    expect(stripAssOverrideTags("上句\\N下句")).toBe("上句\n下句");
    expect(stripAssOverrideTags("上句\\n下句")).toBe("上句\n下句");
  });

  test("turns the ASS hard space into a space", () => {
    expect(stripAssOverrideTags("间\\h隔")).toBe("间 隔");
  });

  test("★ an override block may not swallow a newline", () => {
    // This is why the class is [^}\r\n] and not [^}]. The permissive version
    // matches from the unclosed brace in cue 1 all the way to the stray one in
    // cue 2 — eating the timestamp between them and leaving a file the VTT
    // parser rejects outright. A cosmetic tag leak would have become "no
    // subtitles at all", which is the worse failure.
    const doc = ["他说 {未闭合", "", "00:00:03.000 --> 00:00:04.000", "世界} 又一次"].join("\n");
    const out = stripAssOverrideTags(doc);
    expect(out).toContain("00:00:03.000 --> 00:00:04.000");
    expect(out).toContain("他说 {未闭合");
  });

  test("leaves the HTML-ish tags SRT and VTT both understand", () => {
    // <i>/<b>/<font> are real markup in these formats, not ASS overrides.
    // Stripping them would silently drop emphasis the author meant to keep.
    expect(stripAssOverrideTags("<i>斜体</i>")).toBe("<i>斜体</i>");
  });

  test("does not trim — callers that work per cue do that themselves", () => {
    // A document-wide trim would eat the structure this is applied to.
    expect(stripAssOverrideTags("  留白  ")).toBe("  留白  ");
  });

  test("tolerates null and undefined rather than throwing", () => {
    expect(stripAssOverrideTags(null as unknown as string)).toBe("");
    expect(stripAssOverrideTags(undefined as unknown as string)).toBe("");
  });
});

describe("convertSrtToVtt", () => {
  test("★ does not leak {\\an8} into the rendered cue", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:03,000",
      AN8_LINE,
      "人们却按照神道教进行参拜",
      "",
    ].join("\n");

    const vtt = convertSrtToVtt(srt);

    expect(vtt).not.toContain("{\\an8}");
    expect(vtt).toContain("而新年的时候");
    expect(vtt).toContain("人们却按照神道教进行参拜");
  });

  test("still swaps the millisecond separator and adds the header", () => {
    const vtt = convertSrtToVtt("1\n00:00:01,500 --> 00:00:03,250\n你好\n");
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.500 --> 00:00:03.250");
  });

  test("strips a BOM rather than emitting it before the header", () => {
    const vtt = convertSrtToVtt("﻿1\n00:00:01,000 --> 00:00:02,000\n你好\n");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).not.toContain("﻿");
  });

  test("a non-string is an empty cue list, not a crash", () => {
    expect(convertSrtToVtt(null as unknown as string)).toBe("WEBVTT\n\n");
  });
});

describe("convertAssToVtt", () => {
  const ASS = [
    "[Script Info]",
    "Title: fixture",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,${AN8_LINE}`,
  ].join("\n");

  test("keeps stripping override tags after the refactor", () => {
    const vtt = convertAssToVtt(ASS);
    expect(vtt).not.toContain("{\\an8}");
    expect(vtt).toContain("而新年的时候");
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.000");
  });

  test("commas inside the Text field survive the field split", () => {
    const ass = [
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello, world, again",
    ].join("\n");
    expect(convertAssToVtt(ass)).toContain("Hello, world, again");
  });
});

describe("MKV track builders", () => {
  test("★ the SRT builder strips override tags — the reported bug", () => {
    // An S_TEXT/UTF8 block payload IS the cue text: no ReadOrder prefix.
    const vtt = buildVttFromMkvSrtEvents([
      { time: 1000, dur: 2000, text: `${AN8_LINE}\n人们却按照神道教进行参拜` },
    ]);
    expect(vtt).not.toContain("{\\an8}");
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.000");
    expect(vtt).toContain("而新年的时候");
  });

  test("the ASS builder skips the ReadOrder prefix and strips too", () => {
    // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    const vtt = buildVttFromMkvAssEvents([
      { time: 0, dur: 1000, text: `0,0,Default,,0,0,0,,${AN8_LINE}` },
    ]);
    expect(vtt).not.toContain("{\\an8}");
    expect(vtt).not.toContain("Default");
    expect(vtt).toContain("而新年的时候");
  });

  test("both drop a cue that was nothing but tags", () => {
    // A `{\pos(...)}`-only drawing event has no text to render; emitting an
    // empty cue would make artplayer flash a blank subtitle box.
    expect(buildVttFromMkvSrtEvents([{ time: 0, dur: 500, text: "{\\pos(10,10)}" }])).toBe(
      "WEBVTT\n\n",
    );
    expect(
      buildVttFromMkvAssEvents([
        { time: 0, dur: 500, text: "0,0,Default,,0,0,0,,{\\pos(10,10)}" },
      ]),
    ).toBe("WEBVTT\n\n");
  });

  test("an empty event list is a valid, empty VTT", () => {
    expect(buildVttFromMkvSrtEvents([])).toBe("WEBVTT\n\n");
    expect(buildVttFromMkvAssEvents([])).toBe("WEBVTT\n\n");
  });
});

describe("msToVttTime", () => {
  test("pads every field, milliseconds to three digits", () => {
    expect(msToVttTime(0)).toBe("00:00:00.000");
    expect(msToVttTime(1500)).toBe("00:00:01.500");
    expect(msToVttTime(3661007)).toBe("01:01:01.007");
  });

  test("clamps a negative timestamp to zero instead of emitting a bad cue", () => {
    expect(msToVttTime(-5)).toBe("00:00:00.000");
  });
});
