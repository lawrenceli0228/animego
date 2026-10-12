import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflate } from "pako";

import {
  NotMatroskaError,
  scanMatroska,
  trackInfo,
  type ByteSource,
  type MkvScanResult,
} from "./matroska";

// The scanner is exercised against bytes built here, element by element,
// rather than only against muxer output: each case below is a shape real
// releases have (zlib-compressed tracks, fonts in Attachments, clusters of
// unknown size, a track list with no text track) and a muxer would not let a
// test choose them one at a time. One real file from ffmpeg closes the loop
// at the end, so the builder and the parser cannot share a misunderstanding.

// ─── EBML builder ──────────────────────────────────────────────────────────

type Part = Uint8Array | number[] | string;

const enc = new TextEncoder();

function bytes(p: Part): Uint8Array {
  if (typeof p === "string") return enc.encode(p);
  return p instanceof Uint8Array ? p : Uint8Array.from(p);
}

function concat(parts: Part[]): Uint8Array {
  const arrs = parts.map(bytes);
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function idBytes(id: number): number[] {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
}

function sizeBytes(n: number): number[] {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out: number[] = [];
      let v = n;
      for (let i = 0; i < len; i++) {
        out.unshift(v & 0xff);
        v = Math.floor(v / 256);
      }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error("too big");
}

function el(id: number, ...payload: Part[]): Uint8Array {
  const body = concat(payload);
  return concat([idBytes(id), sizeBytes(body.length), body]);
}

/** An element whose size field says "unknown" (one 0xFF byte). */
function elUnknown(id: number, ...payload: Part[]): Uint8Array {
  return concat([idBytes(id), [0xff], concat(payload)]);
}

function uint(n: number): number[] {
  if (n === 0) return [0];
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
}

const ID = {
  EBML: 0x1a45dfa3,
  DOCTYPE: 0x4282,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  FLAG_DEFAULT: 0x88,
  FLAG_FORCED: 0x55aa,
  NAME: 0x536e,
  LANGUAGE: 0x22b59c,
  LANGUAGE_BCP47: 0x22b59d,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  CONTENT_ENCODINGS: 0x6d80,
  CONTENT_ENCODING: 0x6240,
  CONTENT_COMPRESSION: 0x5034,
  CONTENT_COMP_ALGO: 0x4254,
  CONTENT_COMP_SETTINGS: 0x4255,
  ATTACHMENTS: 0x1941a469,
  ATTACHED_FILE: 0x61a7,
  FILE_NAME: 0x466e,
  FILE_MIME_TYPE: 0x4660,
  FILE_DATA: 0x465c,
  CLUSTER: 0x1f43b675,
  CLUSTER_TIMESTAMP: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
  VOID: 0xec,
};

const ebmlHeader = el(ID.EBML, el(ID.DOCTYPE, "matroska"));

interface TrackSpec {
  number: number;
  type?: number;
  codec: string;
  name?: string;
  lang?: string;
  bcp47?: string;
  isDefault?: boolean;
  forced?: boolean;
  priv?: string;
  encodings?: Uint8Array;
}

function track(t: TrackSpec): Uint8Array {
  const parts: Uint8Array[] = [
    el(ID.TRACK_NUMBER, uint(t.number)),
    el(ID.TRACK_TYPE, uint(t.type ?? 17)),
    el(ID.CODEC_ID, t.codec),
  ];
  if (t.name != null) parts.push(el(ID.NAME, t.name));
  if (t.lang != null) parts.push(el(ID.LANGUAGE, t.lang));
  if (t.bcp47 != null) parts.push(el(ID.LANGUAGE_BCP47, t.bcp47));
  if (t.isDefault != null) parts.push(el(ID.FLAG_DEFAULT, uint(t.isDefault ? 1 : 0)));
  if (t.forced != null) parts.push(el(ID.FLAG_FORCED, uint(t.forced ? 1 : 0)));
  if (t.priv != null) parts.push(el(ID.CODEC_PRIVATE, t.priv));
  if (t.encodings) parts.push(t.encodings);
  return el(ID.TRACK_ENTRY, ...parts);
}

/** Block body: track vint, int16 relative timecode, flags, payload. */
function blockBody(trackNum: number, rel: number, payload: Part): Uint8Array {
  const tc = rel < 0 ? rel + 0x10000 : rel;
  return concat([sizeBytes(trackNum), [(tc >> 8) & 0xff, tc & 0xff, 0x80], bytes(payload)]);
}

function simpleBlock(trackNum: number, rel: number, payload: Part): Uint8Array {
  return el(ID.SIMPLE_BLOCK, blockBody(trackNum, rel, payload));
}

function blockGroup(trackNum: number, rel: number, dur: number, payload: Part): Uint8Array {
  return el(
    ID.BLOCK_GROUP,
    el(ID.BLOCK, blockBody(trackNum, rel, payload)),
    el(ID.BLOCK_DURATION, uint(dur)),
  );
}

function cluster(ts: number, ...blocks: Uint8Array[]): Uint8Array {
  return el(ID.CLUSTER, el(ID.CLUSTER_TIMESTAMP, uint(ts)), ...blocks);
}

function mkv(...segmentChildren: Uint8Array[]): Uint8Array {
  return concat([ebmlHeader, el(ID.SEGMENT, ...segmentChildren)]);
}

interface CountingSource extends ByteSource {
  reads: { offset: number; length: number }[];
}

function source(buf: Uint8Array): CountingSource {
  const reads: { offset: number; length: number }[] = [];
  return {
    size: buf.length,
    reads,
    async read(offset, length) {
      reads.push({ offset, length });
      return buf.slice(offset, offset + length);
    },
  };
}

const ASS_HEADER = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize",
  "Style: Default,方正准圆_GBK,48",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
].join("\n");

const info = el(ID.INFO, el(ID.TIMESTAMP_SCALE, uint(1_000_000)));
const video = track({ number: 1, type: 1, codec: "V_VP9" });

// ─── Track list ────────────────────────────────────────────────────────────

describe("scanMatroska: track list", () => {
  const file = mkv(
    info,
    el(
      ID.TRACKS,
      video,
      track({ number: 2, codec: "S_TEXT/ASS", name: "简体中文", lang: "chi", bcp47: "zh-Hans", isDefault: true, priv: ASS_HEADER }),
      track({ number: 3, codec: "S_TEXT/ASS", name: "繁體中文", lang: "chi", isDefault: false, priv: ASS_HEADER }),
      track({ number: 4, codec: "S_TEXT/UTF8", name: "Signs", lang: "eng", isDefault: false, forced: true }),
      track({ number: 5, codec: "S_HDMV/PGS", lang: "jpn", isDefault: false }),
      track({ number: 6, codec: "S_TEXT/UTF8" }),
    ),
    cluster(0, simpleBlock(1, 0, [1, 2, 3])),
  );

  test("every subtitle track, with what the menu needs to name it", async () => {
    let early: unknown = null;
    const result = await scanMatroska(source(file), { onTracks: (t) => (early = t) });
    expect(result.tracks.map((t) => [t.number, t.format, t.supported, t.name, t.language, t.languageBcp47, t.isDefault, t.isForced])).toEqual([
      [2, "ass", true, "简体中文", "chi", "zh-Hans", true, false],
      [3, "ass", true, "繁體中文", "chi", null, false, false],
      [4, "srt", true, "Signs", "eng", null, false, true],
      [5, "image", false, "", "jpn", null, false, false],
      // FlagDefault absent means 1 in Matroska; Language absent is reported
      // as unknown rather than the spec's historical "eng", so a nameless
      // track is never labelled English.
      [6, "srt", true, "", null, null, true, false],
    ]);
    expect(early).toEqual(result.tracks.map(trackInfo));
  });

  test("the video track is not listed", async () => {
    const result = await scanMatroska(source(file));
    expect(result.tracks.some((t) => t.number === 1)).toBe(false);
  });
});

// ─── Events ────────────────────────────────────────────────────────────────

describe("scanMatroska: events", () => {
  test("times from cluster + relative timecode, scaled; durations from BlockGroup", async () => {
    const file = mkv(
      el(ID.INFO, el(ID.TIMESTAMP_SCALE, uint(500_000))), // 0.5 ms per tick
      el(ID.TRACKS, video, track({ number: 2, codec: "S_TEXT/UTF8" })),
      cluster(
        2000, // 1000 ms
        simpleBlock(1, 0, [0, 0, 0]),
        blockGroup(2, 400, 3000, "第一句"), // +200 ms, lasts 1500 ms
        simpleBlock(2, -200, "早于簇时间"), // -100 ms, no duration
      ),
    );
    const result = await scanMatroska(source(file));
    expect(result.tracks[0].events).toEqual([
      { time: 1200, dur: 1500, text: "第一句" },
      { time: 900, dur: null, text: "早于簇时间" },
    ]);
  });

  test("blocks of unsupported and unknown tracks are not collected", async () => {
    const file = mkv(
      info,
      el(ID.TRACKS, track({ number: 5, codec: "S_HDMV/PGS" }), track({ number: 2, codec: "S_TEXT/UTF8" })),
      cluster(0, simpleBlock(5, 0, [9, 9, 9]), simpleBlock(7, 0, "stray"), blockGroup(2, 0, 10, "kept")),
    );
    const result = await scanMatroska(source(file));
    expect(result.tracks.find((t) => t.number === 5)?.events).toEqual([]);
    expect(result.tracks.find((t) => t.number === 2)?.events.map((e) => e.text)).toEqual(["kept"]);
  });

  test("zlib-compressed track is inflated", async () => {
    const zlib = el(ID.CONTENT_ENCODINGS, el(ID.CONTENT_ENCODING, el(ID.CONTENT_COMPRESSION, el(ID.CONTENT_COMP_ALGO, uint(0)))));
    const line = "0,0,Default,,0,0,0,,压缩的字幕行";
    const file = mkv(
      info,
      el(ID.TRACKS, track({ number: 2, codec: "S_TEXT/ASS", priv: ASS_HEADER, encodings: zlib })),
      cluster(0, blockGroup(2, 0, 1000, deflate(enc.encode(line)))),
    );
    const result = await scanMatroska(source(file));
    expect(result.tracks[0].events[0].text).toBe(line);
  });

  test("ContentCompression with no algo element still inflates (zlib is the default)", async () => {
    const zlib = el(ID.CONTENT_ENCODINGS, el(ID.CONTENT_ENCODING, el(ID.CONTENT_COMPRESSION)));
    const file = mkv(
      info,
      el(ID.TRACKS, track({ number: 2, codec: "S_TEXT/UTF8", encodings: zlib })),
      cluster(0, blockGroup(2, 0, 1000, deflate(enc.encode("默认算法")))),
    );
    const result = await scanMatroska(source(file));
    expect(result.tracks[0].events[0].text).toBe("默认算法");
  });

  test("header stripping puts the stripped bytes back", async () => {
    const strip = el(
      ID.CONTENT_ENCODINGS,
      el(ID.CONTENT_ENCODING, el(ID.CONTENT_COMPRESSION, el(ID.CONTENT_COMP_ALGO, uint(3)), el(ID.CONTENT_COMP_SETTINGS, "0,0,Default,"))),
    );
    const file = mkv(
      info,
      el(ID.TRACKS, track({ number: 2, codec: "S_TEXT/ASS", priv: ASS_HEADER, encodings: strip })),
      cluster(0, blockGroup(2, 0, 1000, ",0,0,0,,剥离头")),
    );
    const result = await scanMatroska(source(file));
    expect(result.tracks[0].events[0].text).toBe("0,0,Default,,0,0,0,,剥离头");
  });

  test("a cluster of unknown size ends where the next cluster begins", async () => {
    const file = mkv(
      info,
      el(ID.TRACKS, track({ number: 2, codec: "S_TEXT/UTF8" })),
      elUnknown(ID.CLUSTER, el(ID.CLUSTER_TIMESTAMP, uint(0)), blockGroup(2, 0, 100, "a")),
      cluster(5000, blockGroup(2, 0, 100, "b")),
    );
    const result = await scanMatroska(source(file));
    expect(result.tracks[0].events.map((e) => [e.time, e.text])).toEqual([
      [0, "a"],
      [5000, "b"],
    ]);
  });

  test("Void elements and unknown children are skipped", async () => {
    const file = mkv(
      el(ID.VOID, [0, 0, 0, 0]),
      info,
      el(ID.TRACKS, track({ number: 2, codec: "S_TEXT/UTF8" })),
      cluster(0, el(ID.VOID, [0, 0]), blockGroup(2, 0, 100, "ok")),
    );
    const result = await scanMatroska(source(file));
    expect(result.tracks[0].events.map((e) => e.text)).toEqual(["ok"]);
  });
});

// ─── Fonts ─────────────────────────────────────────────────────────────────

describe("scanMatroska: attachments", () => {
  test("font attachments are returned, other attachments are not", async () => {
    const attached = (name: string, mime: string, data: Part) =>
      el(ID.ATTACHED_FILE, el(ID.FILE_NAME, name), el(ID.FILE_MIME_TYPE, mime), el(ID.FILE_DATA, data));
    let early: unknown = null;
    const file = mkv(
      info,
      el(ID.TRACKS, track({ number: 2, codec: "S_TEXT/ASS", priv: ASS_HEADER })),
      el(
        ID.ATTACHMENTS,
        attached("FZZYJW.TTF", "application/x-truetype-font", [1, 2, 3]),
        attached("cover.jpg", "image/jpeg", [4, 5]),
        attached("SourceHanSans.otf", "application/octet-stream", [6]),
        attached("emoji.woff2", "font/woff2", [7]),
      ),
      cluster(0, blockGroup(2, 0, 10, "0,0,Default,,0,0,0,,x")),
    );
    const result = await scanMatroska(source(file), { onFonts: (f) => (early = f) });
    expect(result.fonts.map((f) => [f.name, Array.from(f.data)])).toEqual([
      ["FZZYJW.TTF", [1, 2, 3]],
      ["SourceHanSans.otf", [6]],
      ["emoji.woff2", [7]],
    ]);
    expect(early).toEqual(result.fonts);
  });
});

// ─── Reading ───────────────────────────────────────────────────────────────

function fileWithClusters(n: number, videoBytes: number): Uint8Array {
  const clusters: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    clusters.push(
      cluster(i * 1000, simpleBlock(1, 0, new Uint8Array(videoBytes)), blockGroup(2, 0, 500, `cue ${i}`)),
    );
  }
  return mkv(info, el(ID.TRACKS, video, track({ number: 2, codec: "S_TEXT/UTF8" })), ...clusters);
}

const texts = (r: MkvScanResult) => r.tracks[0].events.map((e) => e.text);

describe("scanMatroska: reading in chunks", () => {
  test("the result does not depend on the chunk size", async () => {
    const file = fileWithClusters(20, 3000);
    const whole = await scanMatroska(source(file), { chunkSize: file.length });
    for (const chunkSize of [7, 64, 1000, 4096]) {
      const chunked = await scanMatroska(source(file), { chunkSize });
      expect(texts(chunked)).toEqual(texts(whole));
    }
    expect(texts(whole)).toHaveLength(20);
  });

  test("memory is bounded by the chunk size, not the file size", async () => {
    const file = fileWithClusters(40, 50_000); // ~2 MB
    const src = source(file);
    await scanMatroska(src, { chunkSize: 64 * 1024 });
    const largest = Math.max(...src.reads.map((r) => r.length));
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(file.length).toBeGreaterThan(30 * largest);
  });

  test("a file with no text track stops after its track list", async () => {
    const clusters = Array.from({ length: 30 }, (_, i) => cluster(i * 1000, simpleBlock(1, 0, new Uint8Array(10_000))));
    const file = mkv(info, el(ID.TRACKS, video, track({ number: 5, codec: "S_HDMV/PGS" })), ...clusters);
    const src = source(file);
    const result = await scanMatroska(src, { chunkSize: 4096 });
    expect(result.tracks.map((t) => t.format)).toEqual(["image"]);
    const furthest = Math.max(...src.reads.map((r) => r.offset));
    expect(furthest).toBeLessThan(file.length / 10);
  });

  test("one partial report, after the first slice, with the cues scanned so far", async () => {
    const file = fileWithClusters(10, 1000);
    const partials: MkvScanResult[] = [];
    const final = await scanMatroska(source(file), {
      partialAfterBytes: 3000,
      partialAfterMs: 1e9,
      onPartial: (r) => partials.push(r),
    });
    expect(partials).toHaveLength(1);
    expect(partials[0].complete).toBe(false);
    const got = texts(partials[0]);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(10);
    expect(texts(final).slice(0, got.length)).toEqual(got);
    expect(final.complete).toBe(true);
  });

  test("the partial report also fires on time, for a slow disk", async () => {
    const file = fileWithClusters(5, 100);
    let clock = 0;
    const partials: MkvScanResult[] = [];
    await scanMatroska(source(file), {
      partialAfterBytes: 1e12,
      partialAfterMs: 1000,
      now: () => (clock += 600),
      onPartial: (r) => partials.push(r),
    });
    expect(partials).toHaveLength(1);
  });

  test("an aborted scan rejects with AbortError", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(scanMatroska(source(fileWithClusters(3, 10)), { signal: ctrl.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("a file that is not Matroska is rejected", async () => {
    await expect(scanMatroska(source(enc.encode("....ftypisom")))).rejects.toBeInstanceOf(NotMatroskaError);
  });
});

// ─── A real file ───────────────────────────────────────────────────────────

describe("scanMatroska: ffmpeg output", () => {
  // three-tracks.mkv: 3 s of VP9 plus 简体 ASS (default), 繁體 ASS and an
  // English SRT, and one attachment declared as a TrueType font. Built with
  // ffmpeg from text written for this test.
  const file = new Uint8Array(readFileSync(join(import.meta.dir, "__fixtures__", "three-tracks.mkv")));

  test("finds all three tracks, their names, languages and default flags", async () => {
    const result = await scanMatroska(source(file), { chunkSize: 512 });
    expect(result.tracks.map((t) => [t.format, t.name, t.language, t.isDefault])).toEqual([
      ["ass", "简体中文", "chi", true],
      ["ass", "繁體中文", "chi", false],
      ["srt", "English", "eng", false],
    ]);
    expect(result.tracks[0].header).toContain("[V4+ Styles]");
    expect(result.tracks[0].events[0].text).toContain("简体字幕：第一句");
    expect(result.tracks[1].events[0].text).toContain("繁體字幕：第一句");
    expect(result.tracks[2].events[0].text).toBe("English subtitle: line one");
    expect(result.fonts.map((f) => f.name)).toEqual(["fake.ttf"]);
  });
});
