/**
 * MKV subtitle extractor — runs in a Web Worker.
 * Parses EBML/Matroska structure to find subtitle tracks (ASS/SSA/SRT)
 * and reconstructs the subtitle file from embedded data.
 */

// pako is prepended to this worker's source as a Blob URL (see
// resolveSubtitle.js → createMkvWorker). It exposes self.pako.inflate
// for synchronous zlib decompression — much faster than per-block
// DecompressionStream which incurs ~1-2ms async overhead per call
// (~4s on a 24min episode with 2000+ events).
self.onmessage = async (e) => {
  try {
    const buffer = await e.data.file.arrayBuffer();
    const result = extract(new DataView(buffer));
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};

// EBML element IDs
const SEGMENT          = 0x18538067;
const SEG_INFO         = 0x1549A966;
const TC_SCALE         = 0x2AD7B1;
const TRACKS           = 0x1654AE6B;
const TRACK_ENTRY      = 0xAE;
const TRACK_NUMBER     = 0xD7;
const TRACK_TYPE       = 0x83;
const CODEC_ID         = 0x86;
const CODEC_PRIVATE    = 0x63A2;
const CONTENT_ENCS     = 0x6D80;
const CONTENT_ENC      = 0x6240;
const CONTENT_COMP     = 0x5034;
const CONTENT_COMP_ALGO = 0x4254;
const CLUSTER          = 0x1F43B675;
const CLUSTER_TS       = 0xE7;
const SIMPLE_BLOCK     = 0xA3;
const BLOCK_GROUP      = 0xA0;
const BLOCK            = 0xA1;
const BLOCK_DURATION   = 0x9B;

const MASTERS = new Set([
  0x1A45DFA3, SEGMENT, SEG_INFO, TRACKS, TRACK_ENTRY, CLUSTER, BLOCK_GROUP,
  CONTENT_ENCS, CONTENT_ENC, CONTENT_COMP,
]);

// Matroska ContentCompAlgo:
//   0 = zlib (DEFLATE)   ← SweetSub and others commonly use this
//   1 = bzlib (deprecated, never seen in the wild)
//   2 = lzo1x (deprecated)
//   3 = Header Stripping (algo-specific, can ignore for subtitles)
const COMP_ZLIB = 0;

function readID(dv, pos) {
  if (pos >= dv.byteLength) return null;
  const b = dv.getUint8(pos);
  let len = 1, mask = 0x80;
  while (len <= 4 && !(b & mask)) { len++; mask >>= 1; }
  if (len > 4 || pos + len > dv.byteLength) return null;
  let id = b;
  for (let i = 1; i < len; i++) id = id * 256 + dv.getUint8(pos + i);
  return { id, len };
}

function readSize(dv, pos) {
  if (pos >= dv.byteLength) return null;
  const b = dv.getUint8(pos);
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > dv.byteLength) return null;
  let val = b & (mask - 1);
  let allOnes = mask - 1;
  for (let i = 1; i < len; i++) {
    val = val * 256 + dv.getUint8(pos + i);
    allOnes = allOnes * 256 + 0xFF;
  }
  return { val: val === allOnes ? -1 : val, len };
}

function readUint(dv, pos, size) {
  let v = 0;
  for (let i = 0; i < size && i < 8; i++) v = v * 256 + dv.getUint8(pos + i);
  return v;
}

function readStr(dv, pos, size) {
  return new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + pos, size));
}

function fmtASS(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function fmtVTT(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ms2 = Math.floor(ms % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms2).padStart(3, '0')}`;
}

/** Build VTT from parsed events, stripping ASS override tags */
function buildVttFromEvents(sortedEvents) {
  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < sortedEvents.length; i++) {
    const ev = sortedEvents[i];
    // MKV ASS block: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    // Extract the Text field (after 8th comma)
    let text = ev.text;
    let commas = 0;
    for (let j = 0; j < text.length; j++) {
      if (text[j] === ',') { commas++; if (commas === 8) { text = text.substring(j + 1); break; } }
    }
    // Strip ASS override tags like {\an8}, {\b1}, {\c&H...&}
    text = text.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').trim();
    if (!text) continue;
    vtt += `${fmtVTT(ev.time)} --> ${fmtVTT(ev.time + ev.dur)}\n${text}\n\n`;
  }
  return vtt;
}

function extract(dv) {
  const fileEnd = dv.byteLength;
  let tcScale = 1000000; // nanoseconds per timestamp unit, default 1ms
  const subTracks = [];   // { num, codecId, header, compAlgo (null|0) }
  const events = [];      // { trackNum, time, dur, raw: Uint8Array, text?: string }
  let clusterTs = 0;

  function scan(from, to) {
    let pos = from;
    while (pos < to) {
      const idR = readID(dv, pos);
      if (!idR) break;
      pos += idR.len;
      const szR = readSize(dv, pos);
      if (!szR) break;
      pos += szR.len;
      const elSize = szR.val === -1 ? (to - pos) : szR.val;
      const elEnd = Math.min(pos + elSize, to);

      switch (idR.id) {
        case TC_SCALE:
          tcScale = readUint(dv, pos, elSize);
          break;
        case TRACK_ENTRY:
          parseTrack(pos, elEnd);
          pos = elEnd;
          continue;
        case CLUSTER:
          clusterTs = 0;
          scan(pos, elEnd);
          pos = elEnd;
          continue;
        case CLUSTER_TS:
          clusterTs = readUint(dv, pos, elSize);
          break;
        case SIMPLE_BLOCK:
          parseBlock(pos, elSize, null);
          break;
        case BLOCK_GROUP:
          parseBG(pos, elEnd);
          pos = elEnd;
          continue;
        default:
          if (MASTERS.has(idR.id)) { scan(pos, elEnd); pos = elEnd; continue; }
      }
      pos = elEnd;
    }
  }

  function parseTrack(from, to) {
    let num = 0, type = 0, codecId = '', header = '';
    let compAlgo = null;
    let pos = from;
    while (pos < to) {
      const idR = readID(dv, pos);
      if (!idR) break;
      pos += idR.len;
      const szR = readSize(dv, pos);
      if (!szR) break;
      pos += szR.len;
      const sz = szR.val;
      if (idR.id === TRACK_NUMBER) num = readUint(dv, pos, sz);
      else if (idR.id === TRACK_TYPE) type = readUint(dv, pos, sz);
      else if (idR.id === CODEC_ID) codecId = readStr(dv, pos, sz).replace(/\0/g, '');
      else if (idR.id === CODEC_PRIVATE) header = readStr(dv, pos, sz);
      else if (idR.id === CONTENT_ENCS) {
        // Walk ContentEncodings → ContentEncoding → ContentCompression →
        // ContentCompAlgo to find the compression algorithm. SweetSub and
        // similar fansub groups commonly zlib-compress subtitle tracks
        // (saves ~70% on text-heavy ASS); a worker that doesn't decompress
        // produces garbage cues and libass renders empty.
        compAlgo = readNestedCompAlgo(pos, pos + sz);
      } else if (MASTERS.has(idR.id)) {
        // unknown master container — skip
      }
      pos += sz;
    }
    if (type === 17) subTracks.push({ num, codecId, header, compAlgo });
  }

  function readNestedCompAlgo(from, to) {
    let pos = from;
    let algo = null;
    while (pos < to) {
      const idR = readID(dv, pos);
      if (!idR) break;
      pos += idR.len;
      const szR = readSize(dv, pos);
      if (!szR) break;
      pos += szR.len;
      const sz = szR.val;
      if (idR.id === CONTENT_COMP_ALGO) algo = readUint(dv, pos, sz);
      else if (MASTERS.has(idR.id)) {
        const nested = readNestedCompAlgo(pos, pos + sz);
        if (nested != null) algo = nested;
      }
      pos += sz;
    }
    return algo;
  }

  function parseBG(from, to) {
    let bPos = 0, bSize = 0, dur = null;
    let pos = from;
    while (pos < to) {
      const idR = readID(dv, pos);
      if (!idR) break;
      pos += idR.len;
      const szR = readSize(dv, pos);
      if (!szR) break;
      pos += szR.len;
      if (idR.id === BLOCK) { bPos = pos; bSize = szR.val; }
      else if (idR.id === BLOCK_DURATION) dur = readUint(dv, pos, szR.val);
      pos += szR.val;
    }
    if (bPos) parseBlock(bPos, bSize, dur);
  }

  function parseBlock(pos, size, dur) {
    const tnR = readSize(dv, pos);
    if (!tnR) return;
    const trackNum = tnR.val;
    if (!subTracks.some(t => t.num === trackNum)) return;

    pos += tnR.len;
    const timecode = dv.getInt16(pos);
    pos += 3; // 2 bytes timecode + 1 byte flags

    const textLen = size - tnR.len - 3;
    if (textLen <= 0) return;

    // Defer text decode — for compressed tracks we need to inflate the raw
    // bytes first. Always capture the slice as Uint8Array; we decode (and
    // decompress if needed) in a post-scan async pass.
    const raw = new Uint8Array(dv.buffer, dv.byteOffset + pos, textLen);
    const timeMs = (clusterTs + timecode) * tcScale / 1000000;
    const durMs = dur != null ? dur * tcScale / 1000000 : 5000;

    events.push({ trackNum, time: timeMs, dur: durMs, raw });
  }

  scan(0, fileEnd);
  if (!subTracks.length) return null;

  // Post-scan: decode each event's raw bytes into text. Some MKVs use
  // Matroska ContentEncoding zlib compression (default algo when only
  // ContentEncoding header is present, no explicit algo element — common
  // in SweetSub releases). Sniff the zlib header on raw bytes:
  //   0x78 0x01 / 0x78 0x9C / 0x78 0xDA / 0x78 0x5E = zlib stream
  // Anything else is treated as plaintext UTF-8. pako.inflate is sync,
  // so the whole post-scan stays in one tick — ~500ms for 2000 events
  // vs ~4s with the previous per-event DecompressionStream.
  const decoder = new TextDecoder();
  const ZLIB_FLAGS = new Set([0x01, 0x5E, 0x9C, 0xDA]);
  const isZlib = (b) => b.length >= 2 && b[0] === 0x78 && ZLIB_FLAGS.has(b[1]);
  for (const ev of events) {
    let bytes = ev.raw;
    if (isZlib(bytes)) {
      try {
        bytes = self.pako.inflate(bytes);
      } catch (err) {
        // Bad block — skip; other events may still decode cleanly.
        ev.text = '';
        continue;
      }
    }
    ev.text = decoder.decode(bytes);
  }

  // Prefer ASS/SSA
  const assTrack = subTracks.find(t => t.codecId === 'S_TEXT/ASS' || t.codecId === 'S_TEXT/SSA');
  if (assTrack) {
    let ass = assTrack.header;
    const sorted = events.filter(e => e.trackNum === assTrack.num).sort((a, b) => a.time - b.time);
    for (const ev of sorted) {
      const start = fmtASS(ev.time);
      const end = fmtASS(ev.time + ev.dur);
      // MKV ASS block: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      // ASS Dialogue:  Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      const comma = ev.text.indexOf(',');
      if (comma >= 0) {
        const afterRO = ev.text.substring(comma + 1); // Layer,Style,...,Text
        const comma2 = afterRO.indexOf(',');
        if (comma2 >= 0) {
          const layer = afterRO.substring(0, comma2);
          const rest = afterRO.substring(comma2 + 1); // Style,...,Text
          ass += `Dialogue: ${layer},${start},${end},${rest}\n`;
        } else {
          ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,${ev.text}\n`;
        }
      } else {
        ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,${ev.text}\n`;
      }
    }
    // Also build a VTT fallback (plain text, no ASS styling) for Artplayer native subtitle
    const vtt = buildVttFromEvents(sorted);
    return { type: 'ass', content: ass, vtt };
  }

  // Fallback: SRT → VTT
  const srtTrack = subTracks.find(t => t.codecId === 'S_TEXT/UTF8');
  if (srtTrack) {
    let vtt = 'WEBVTT\n\n';
    const sorted = events.filter(e => e.trackNum === srtTrack.num).sort((a, b) => a.time - b.time);
    for (const ev of sorted) {
      vtt += `${fmtVTT(ev.time)} --> ${fmtVTT(ev.time + ev.dur)}\n${ev.text}\n\n`;
    }
    return { type: 'vtt', content: vtt };
  }

  return null;
}
