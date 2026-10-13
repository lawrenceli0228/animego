// Matroska subtitle scanner: every text subtitle track a .mkv carries, the
// fonts it ships for them, and enough about each track to choose between
// them.
//
// WHY THIS REPLACED THE OLD WORKER BODY
//
// mkvSubtitle.worker.js used to read the whole file into one ArrayBuffer and
// keep only the first ASS track it met (or, failing that, the first SRT).
// Three things followed from that:
//
//   - A release that muxes 简体 and 繁體 (and often English) gave the reader
//     whichever one the muxer happened to write first, with no way to switch.
//     Track names, languages and the default flag were never read at all.
//   - Opening a 2 GB episode asked the browser for 2 GB of memory at once.
//   - Nothing reached the screen until the last byte had been parsed, so the
//     first minutes of an episode played with no subtitles even though their
//     cues sit in the first few megabytes.
//
// This module reads through a `ByteSource` in bounded chunks, reports the
// track list as soon as the Tracks element has been read, reports a partial
// set of cues once a first slice of the file has been scanned, and returns
// every text track at the end. It is pure — no Worker, no File, no DOM — so
// the EBML handling is checkable from `bun test` against hand-built bytes.
//
// WHAT IT DOES NOT DO
//
// Image subtitles (PGS, VobSub, DVB) are listed so the menu can say they
// exist, but their blocks are not collected: there is nothing in the player
// that could draw them. Laced subtitle blocks are not split; muxers do not
// lace subtitles and the old worker did not handle them either.

import { inflate } from "pako";

/** Random access to the bytes of a file. `File.slice` in the worker. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type MkvSubtitleFormat = "ass" | "srt" | "vtt" | "image" | "unknown";

export interface MkvTrackInfo {
  /** Matroska TrackNumber — unique within the file, what blocks refer to. */
  number: number;
  codecId: string;
  format: MkvSubtitleFormat;
  /** False for image formats and codecs this player cannot render. */
  supported: boolean;
  /** TrackName, e.g. "简体中文" / "CHS" / "Signs & Songs". Empty when unset. */
  name: string;
  /** ISO 639-2 Language element ("chi", "jpn"). Null when the file omits it. */
  language: string | null;
  /** LanguageBCP47 / LanguageIETF ("zh-Hans"). Null when the file omits it. */
  languageBcp47: string | null;
  /** FlagDefault. Matroska's default for an absent flag is 1. */
  isDefault: boolean;
  isForced: boolean;
}

export interface MkvSubtitleEvent {
  /** Start, in milliseconds from the start of the file. */
  time: number;
  /** Duration in ms, or null when the block carried none (SimpleBlock). */
  dur: number | null;
  /** Block payload, decompressed and decoded as UTF-8. */
  text: string;
}

export interface MkvTrackData extends MkvTrackInfo {
  /** CodecPrivate as text — the [Script Info]/[V4+ Styles] header for ASS. */
  header: string;
  events: MkvSubtitleEvent[];
}

export interface MkvFont {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface MkvScanResult {
  tracks: MkvTrackData[];
  fonts: MkvFont[];
  /** True when the whole file was walked; false if the scan stopped early. */
  complete: boolean;
}

export interface MkvScanOptions {
  /** Bytes read per I/O. Bounds memory; 8 MB by default. */
  chunkSize?: number;
  /**
   * Report a partial result once this many bytes have been scanned (or
   * `partialAfterMs` has passed, whichever comes first). Exactly one partial
   * report is made, so the player swaps subtitles at most twice per episode.
   */
  partialAfterBytes?: number;
  partialAfterMs?: number;
  onTracks?: (tracks: MkvTrackInfo[]) => void;
  onFonts?: (fonts: MkvFont[]) => void;
  onPartial?: (result: MkvScanResult) => void;
  /** Fraction scanned, 0..1. Called at most once per cluster. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class NotMatroskaError extends Error {
  constructor() {
    super("not a Matroska file");
    this.name = "NotMatroskaError";
  }
}

// ─── Element IDs ───────────────────────────────────────────────────────────
// Written with their length marker bits, the way they appear on disk and in
// the Matroska specification.

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const FLAG_DEFAULT = 0x88;
const FLAG_FORCED = 0x55aa;
const TRACK_NAME = 0x536e;
const LANGUAGE = 0x22b59c;
const LANGUAGE_BCP47 = 0x22b59d;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const CONTENT_ENCODINGS = 0x6d80;
const CONTENT_ENCODING = 0x6240;
const CONTENT_COMPRESSION = 0x5034;
const CONTENT_COMP_ALGO = 0x4254;
const CONTENT_COMP_SETTINGS = 0x4255;
const ATTACHMENTS = 0x1941a469;
const ATTACHED_FILE = 0x61a7;
const FILE_NAME = 0x466e;
const FILE_MIME_TYPE = 0x4660;
const FILE_DATA = 0x465c;
const CUES = 0x1c53bb6b;
const CHAPTERS = 0x1043a770;
const TAGS = 0x1254c367;
const CLUSTER = 0x1f43b675;
const CLUSTER_TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;

const TRACK_TYPE_SUBTITLE = 17;

/** Segment children. One of these ends a Cluster whose size is unknown. */
const LEVEL1 = new Set([SEEK_HEAD, INFO, TRACKS, CUES, CHAPTERS, TAGS, ATTACHMENTS, CLUSTER]);

// ContentCompAlgo. An absent algo element means 0 (zlib).
const COMP_ZLIB = 0;
const COMP_HEADER_STRIPPING = 3;


const DEFAULT_CHUNK = 8 * 1024 * 1024;
const DEFAULT_PARTIAL_BYTES = 48 * 1024 * 1024;
const DEFAULT_PARTIAL_MS = 1500;

export function subtitleFormatOf(codecId: string): MkvSubtitleFormat {
  switch (codecId) {
    case "S_TEXT/ASS":
    case "S_TEXT/SSA":
    case "S_ASS":
    case "S_SSA":
      return "ass";
    case "S_TEXT/UTF8":
    case "S_TEXT/ASCII":
      return "srt";
    case "S_TEXT/WEBVTT":
      return "vtt";
    case "S_HDMV/PGS":
    case "S_VOBSUB":
    case "S_DVBSUB":
    case "S_IMAGE/BMP":
      return "image";
    default:
      return "unknown";
  }
}

// ─── Variable-length integers ──────────────────────────────────────────────

interface Vint {
  value: number;
  length: number;
  /** All value bits set: the "unknown size" marker. */
  unknown: boolean;
}

/** An element ID: 1–4 bytes, marker bits kept. */
function readId(buf: Uint8Array, off: number): Vint | null {
  if (off >= buf.length) return null;
  const first = buf[off];
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 4 || off + length > buf.length) return null;
  let value = first;
  for (let i = 1; i < length; i++) value = value * 256 + buf[off + i];
  return { value, length, unknown: false };
}

/** A data size or track number: 1–8 bytes, marker bits removed. */
function readVint(buf: Uint8Array, off: number): Vint | null {
  if (off >= buf.length) return null;
  const first = buf[off];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || off + length > buf.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = buf[off + i];
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

function readUint(buf: Uint8Array, off: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size && i < 8; i++) v = v * 256 + buf[off + i];
  return v;
}

const utf8 = new TextDecoder("utf-8");

function readString(buf: Uint8Array, off: number, size: number): string {
  return utf8.decode(buf.subarray(off, off + size)).replace(/\0+$/, "");
}

interface ElementHeader {
  id: number;
  dataStart: number;
  /** -1 when the size is unknown. */
  size: number;
}

/** Walk the children of an element already held in memory. */
function* children(
  buf: Uint8Array,
  from: number,
  to: number,
): Generator<{ id: number; start: number; size: number }> {
  let pos = from;
  while (pos < to) {
    const id = readId(buf, pos);
    if (!id) return;
    const size = readVint(buf, pos + id.length);
    if (!size) return;
    const start = pos + id.length + size.length;
    const len = size.unknown ? to - start : Math.min(size.value, to - start);
    yield { id: id.value, start, size: len };
    pos = start + len;
  }
}

// ─── Buffered reader ───────────────────────────────────────────────────────

class ChunkReader {
  private start = 0;
  private buf: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly src: ByteSource,
    private readonly chunk: number,
  ) {}

  get size(): number {
    return this.src.size;
  }

  private has(pos: number, n: number): boolean {
    return pos >= this.start && pos + n <= this.start + this.buf.length;
  }

  /**
   * Make [pos, pos+n) addressable, reading a fresh chunk from `pos` if it is
   * not already in the window. Returns how many of the n bytes exist (fewer
   * at the end of the file).
   */
  async ensure(pos: number, n: number): Promise<number> {
    const avail = Math.max(0, Math.min(n, this.src.size - pos));
    if (avail === 0 || this.has(pos, avail)) return avail;
    const len = Math.min(Math.max(avail, this.chunk), this.src.size - pos);
    this.buf = await this.src.read(pos, len);
    this.start = pos;
    return Math.min(avail, this.buf.length);
  }

  /** The window as a buffer plus the offset `pos` maps to inside it. */
  at(pos: number): { buf: Uint8Array; off: number } {
    return { buf: this.buf, off: pos - this.start };
  }

  /** Copy [pos, pos+n) out of the window; the window is reused. */
  copy(pos: number, n: number): Uint8Array {
    const off = pos - this.start;
    return this.buf.slice(off, off + n);
  }

  async header(pos: number, limit: number): Promise<ElementHeader | null> {
    const avail = await this.ensure(pos, Math.min(12, limit - pos));
    if (avail < 2) return null;
    const { buf, off } = this.at(pos);
    const view = buf.subarray(off, off + avail);
    const id = readId(view, 0);
    if (!id) return null;
    const size = readVint(view, id.length);
    if (!size) return null;
    return {
      id: id.value,
      dataStart: pos + id.length + size.length,
      size: size.unknown ? -1 : size.value,
    };
  }
}

// ─── Track parsing ─────────────────────────────────────────────────────────

interface TrackState extends MkvTrackData {
  compAlgo: number | null;
  stripped: Uint8Array | null;
}

function parseCompression(
  buf: Uint8Array,
  from: number,
  to: number,
): { algo: number | null; settings: Uint8Array | null } {
  let algo: number | null = null;
  let settings: Uint8Array | null = null;
  for (const enc of children(buf, from, to)) {
    if (enc.id !== CONTENT_ENCODING) continue;
    for (const part of children(buf, enc.start, enc.start + enc.size)) {
      if (part.id !== CONTENT_COMPRESSION) continue;
      algo = COMP_ZLIB;
      for (const c of children(buf, part.start, part.start + part.size)) {
        if (c.id === CONTENT_COMP_ALGO) algo = readUint(buf, c.start, c.size);
        else if (c.id === CONTENT_COMP_SETTINGS) {
          settings = buf.slice(c.start, c.start + c.size);
        }
      }
    }
  }
  return { algo, settings };
}

function parseTrackEntry(buf: Uint8Array, from: number, to: number): TrackState | null {
  let number = 0;
  let type = 0;
  let codecId = "";
  let header = "";
  let name = "";
  let language: string | null = null;
  let languageBcp47: string | null = null;
  let isDefault = true;
  let isForced = false;
  let compAlgo: number | null = null;
  let stripped: Uint8Array | null = null;
  for (const el of children(buf, from, to)) {
    switch (el.id) {
      case TRACK_NUMBER:
        number = readUint(buf, el.start, el.size);
        break;
      case TRACK_TYPE:
        type = readUint(buf, el.start, el.size);
        break;
      case CODEC_ID:
        codecId = readString(buf, el.start, el.size);
        break;
      case CODEC_PRIVATE:
        header = readString(buf, el.start, el.size);
        break;
      case TRACK_NAME:
        name = readString(buf, el.start, el.size).trim();
        break;
      case LANGUAGE:
        language = readString(buf, el.start, el.size).trim() || null;
        break;
      case LANGUAGE_BCP47:
        languageBcp47 = readString(buf, el.start, el.size).trim() || null;
        break;
      case FLAG_DEFAULT:
        isDefault = readUint(buf, el.start, el.size) !== 0;
        break;
      case FLAG_FORCED:
        isForced = readUint(buf, el.start, el.size) !== 0;
        break;
      case CONTENT_ENCODINGS: {
        const c = parseCompression(buf, el.start, el.start + el.size);
        compAlgo = c.algo;
        stripped = c.settings;
        break;
      }
    }
  }
  if (type !== TRACK_TYPE_SUBTITLE || !number) return null;
  const format = subtitleFormatOf(codecId);
  return {
    number,
    codecId,
    format,
    supported: format === "ass" || format === "srt" || format === "vtt",
    name,
    language,
    languageBcp47,
    isDefault,
    isForced,
    header,
    events: [],
    compAlgo,
    stripped,
  };
}

const FONT_EXT = /\.(ttf|otf|ttc|otc|woff2?)$/i;
const FONT_MIME = /(font|truetype|opentype|sfnt)/i;

function parseAttachments(buf: Uint8Array, from: number, to: number): MkvFont[] {
  const fonts: MkvFont[] = [];
  for (const file of children(buf, from, to)) {
    if (file.id !== ATTACHED_FILE) continue;
    let name = "";
    let mimeType = "";
    let data: Uint8Array | null = null;
    for (const el of children(buf, file.start, file.start + file.size)) {
      if (el.id === FILE_NAME) name = readString(buf, el.start, el.size);
      else if (el.id === FILE_MIME_TYPE) mimeType = readString(buf, el.start, el.size);
      else if (el.id === FILE_DATA) data = buf.slice(el.start, el.start + el.size);
    }
    if (data && (FONT_EXT.test(name) || FONT_MIME.test(mimeType))) {
      fonts.push({ name, mimeType, data });
    }
  }
  return fonts;
}

// ─── Block payloads ────────────────────────────────────────────────────────

/** zlib stream header: CMF 0x78 and one of the four standard FLG bytes. */
function looksZlib(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0x78 && (b[1] === 0x01 || b[1] === 0x5e || b[1] === 0x9c || b[1] === 0xda);
}

function decodePayload(track: TrackState, raw: Uint8Array): string {
  let bytes = raw;
  if (track.compAlgo === COMP_HEADER_STRIPPING && track.stripped) {
    const joined = new Uint8Array(track.stripped.length + raw.length);
    joined.set(track.stripped, 0);
    joined.set(raw, track.stripped.length);
    bytes = joined;
  } else if (looksZlib(raw)) {
    // Sniffed rather than gated on compAlgo: it also covers files whose
    // ContentEncodings the muxer wrote without an algo element — the case the
    // old worker was written for. Plain text cannot start with 0x78 0x9C:
    // 0x9C is not a UTF-8 lead byte.
    try {
      bytes = inflate(raw);
    } catch {
      return "";
    }
  }
  return utf8.decode(bytes);
}

function snapshot(tracks: TrackState[], fonts: MkvFont[], complete: boolean): MkvScanResult {
  return {
    tracks: tracks.map((t) => ({ ...trackInfo(t), header: t.header, events: t.events.slice() })),
    fonts: fonts.slice(),
    complete,
  };
}

/** A track's description without its header or cues. */
export function trackInfo(t: MkvTrackInfo): MkvTrackInfo {
  return {
    number: t.number,
    codecId: t.codecId,
    format: t.format,
    supported: t.supported,
    name: t.name,
    language: t.language,
    languageBcp47: t.languageBcp47,
    isDefault: t.isDefault,
    isForced: t.isForced,
  };
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("scan aborted");
    err.name = "AbortError";
    throw err;
  }
}

// ─── Scan ──────────────────────────────────────────────────────────────────

export async function scanMatroska(
  src: ByteSource,
  opts: MkvScanOptions = {},
): Promise<MkvScanResult> {
  const now = opts.now ?? (() => Date.now());
  const r = new ChunkReader(src, opts.chunkSize ?? DEFAULT_CHUNK);
  const partialAfterBytes = opts.partialAfterBytes ?? DEFAULT_PARTIAL_BYTES;
  const partialAfterMs = opts.partialAfterMs ?? DEFAULT_PARTIAL_MS;
  const started = now();

  const ebml = await r.header(0, src.size);
  if (!ebml || ebml.id !== EBML || ebml.size < 0) throw new NotMatroskaError();
  const seg = await r.header(ebml.dataStart + ebml.size, src.size);
  if (!seg || seg.id !== SEGMENT) throw new NotMatroskaError();
  const segEnd = seg.size < 0 ? src.size : Math.min(seg.dataStart + seg.size, src.size);

  let timestampScale = 1_000_000; // ns per tick; 1 ms
  let tracks: TrackState[] = [];
  const byNumber = new Map<number, TrackState>();
  const fonts: MkvFont[] = [];
  let tracksSeen = false;
  let partialSent = false;

  /** Load a whole element into the window and hand back a view of it. */
  const load = async (h: ElementHeader, end: number) => {
    const size = (h.size < 0 ? end : Math.min(h.dataStart + h.size, end)) - h.dataStart;
    const avail = await r.ensure(h.dataStart, size);
    const { buf, off } = r.at(h.dataStart);
    return { buf, from: off, to: off + avail };
  };

  const ms = (ticks: number) => (ticks * timestampScale) / 1_000_000;

  const takeBlock = async (pos: number, size: number, clusterTs: number, dur: number | null) => {
    const head = await r.ensure(pos, Math.min(size, 12));
    let { buf, off } = r.at(pos);
    const tn = readVint(buf.subarray(off, off + head), 0);
    if (!tn) return;
    const track = byNumber.get(tn.value);
    if (!track || !track.supported) return;
    if (head < tn.length + 3) return;
    const rel = (buf[off + tn.length] << 8) | buf[off + tn.length + 1];
    const timecode = rel >= 0x8000 ? rel - 0x10000 : rel;
    const payloadStart = pos + tn.length + 3;
    const payloadLen = size - tn.length - 3;
    if (payloadLen <= 0) return;
    const got = await r.ensure(payloadStart, payloadLen);
    ({ buf, off } = r.at(payloadStart));
    const text = decodePayload(track, buf.subarray(off, off + got));
    track.events.push({
      time: ms(clusterTs + timecode),
      dur: dur == null ? null : ms(dur),
      text,
    });
  };

  const scanCluster = async (h: ElementHeader): Promise<number> => {
    const known = h.size >= 0;
    const end = known ? Math.min(h.dataStart + h.size, segEnd) : segEnd;
    let pos = h.dataStart;
    let clusterTs = 0;
    while (pos < end) {
      const c = await r.header(pos, end);
      if (!c) return end;
      if (!known && LEVEL1.has(c.id)) return pos;
      const cEnd = c.size < 0 ? end : Math.min(c.dataStart + c.size, end);
      if (c.id === CLUSTER_TIMESTAMP) {
        const n = await r.ensure(c.dataStart, c.size);
        const { buf, off } = r.at(c.dataStart);
        clusterTs = readUint(buf, off, n);
      } else if (c.id === SIMPLE_BLOCK) {
        await takeBlock(c.dataStart, cEnd - c.dataStart, clusterTs, null);
      } else if (c.id === BLOCK_GROUP) {
        let blockPos = -1;
        let blockSize = 0;
        let dur: number | null = null;
        let p = c.dataStart;
        while (p < cEnd) {
          const g = await r.header(p, cEnd);
          if (!g || g.size < 0) break;
          if (g.id === BLOCK) {
            blockPos = g.dataStart;
            blockSize = Math.min(g.size, cEnd - g.dataStart);
          } else if (g.id === BLOCK_DURATION) {
            const n = await r.ensure(g.dataStart, g.size);
            const { buf, off } = r.at(g.dataStart);
            dur = readUint(buf, off, n);
          }
          p = g.dataStart + g.size;
        }
        if (blockPos >= 0) await takeBlock(blockPos, blockSize, clusterTs, dur);
      }
      pos = cEnd;
    }
    return end;
  };

  let pos = seg.dataStart;
  while (pos < segEnd) {
    abortIfNeeded(opts.signal);
    const h = await r.header(pos, segEnd);
    if (!h) break;
    const end = h.size < 0 ? segEnd : Math.min(h.dataStart + h.size, segEnd);

    if (h.id === CLUSTER) {
      // A file with no text track has nothing more to give once its track
      // list is known: stop instead of reading gigabytes of video.
      if (tracksSeen && !tracks.some((t) => t.supported)) {
        return { ...snapshot(tracks, fonts, true) };
      }
      pos = await scanCluster(h);
      opts.onProgress?.(Math.min(1, pos / segEnd));
      if (
        !partialSent &&
        tracksSeen &&
        (pos - seg.dataStart >= partialAfterBytes || now() - started >= partialAfterMs)
      ) {
        partialSent = true;
        opts.onPartial?.(snapshot(tracks, fonts, false));
      }
      continue;
    }

    if (h.id === INFO) {
      const { buf, from, to } = await load(h, end);
      for (const el of children(buf, from, to)) {
        if (el.id === TIMESTAMP_SCALE) timestampScale = readUint(buf, el.start, el.size) || 1_000_000;
      }
    } else if (h.id === TRACKS) {
      const { buf, from, to } = await load(h, end);
      tracks = [];
      for (const el of children(buf, from, to)) {
        if (el.id !== TRACK_ENTRY) continue;
        const t = parseTrackEntry(buf, el.start, el.start + el.size);
        if (t) tracks.push(t);
      }
      byNumber.clear();
      for (const t of tracks) byNumber.set(t.number, t);
      tracksSeen = true;
      opts.onTracks?.(tracks.map(trackInfo));
    } else if (h.id === ATTACHMENTS) {
      const { buf, from, to } = await load(h, end);
      const found = parseAttachments(buf, from, to);
      if (found.length) {
        fonts.push(...found);
        opts.onFonts?.(fonts.slice());
      }
    }
    pos = end;
  }

  opts.onProgress?.(1);
  return snapshot(tracks, fonts, true);
}
