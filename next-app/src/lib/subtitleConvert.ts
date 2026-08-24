// @ts-nocheck
//
// Subtitle format converters — produce WebVTT output that artplayer's
// built-in renderer can consume.
//
// TWO CONSUMERS, AND THAT IS WHY THE RULE LIVES HERE
//
//   VideoPlayer  — the manual "load subtitle file" pick (.srt / .ass / .ssa)
//   mkvSubtitle.worker — the VTT it builds from an MKV's embedded track
//
// Both have to answer the same question: what does a plaintext renderer do
// with ASS override tags? The answer was previously written four times and
// only two of them said "strip". See `stripAssOverrideTags`.
//
// Limitations:
//   - ASS → VTT is plain-text only. ASS inline tags ({\an8}, {\b1}, \fad,
//     karaoke \k) are stripped — artplayer's VTT engine has no way to
//     express ASS typesetting / animations. Full-fidelity rendering needs
//     libass-wasm (jassub), which mounts over this layer when the source is
//     ASS *and* we have its raw content.
//   - SRT → VTT is a timestamp comma→period swap, plus the same tag strip:
//     a great many SRT files in the wild are ASS conversions that kept their
//     override tags.
//
// P6.6 port note: ts-nocheck'd because the legacy module already uses
// pragmatic JSDoc + raw string parsing without TS types. Pure functions —
// no DOM, no imports — which is also what lets the worker import them.

const ASS_TIME_RE = /(\d+):(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)/;

/**
 * ASS override blocks — `{\an8}`, `{\b1}`, `{\c&H00FF00&}`, `{\fad(200,200)}`.
 *
 * `[^}\r\n]` and NOT `[^}]` is load-bearing. This regex is applied to whole
 * documents, not just to one cue's text, and ASS override blocks never span
 * lines. With the permissive class, an unclosed `{` in one cue and a stray
 * `}` several cues later would match across everything between them and
 * swallow the intervening timestamps — turning a cosmetic tag leak into a
 * subtitle file that no longer parses.
 */
const ASS_OVERRIDE_BLOCK_RE = /\{[^}\r\n]*\}/g;

/**
 * The one rule: what a PLAINTEXT renderer should do with ASS markup.
 *
 * Strips override blocks, turns ASS's `\N` (hard break) and `\n` (soft break)
 * into real newlines, and `\h` (hard space) into a space. Deliberately does
 * NOT trim — callers that operate per-cue do that themselves, and a trim
 * applied to a whole document would eat its structure.
 *
 * HTML-ish inline tags that SRT genuinely supports (`<i>`, `<b>`, `<font>`)
 * are left alone: WebVTT understands them, and stripping them would lose
 * emphasis the author meant to keep.
 *
 * Worth knowing: artplayer 5.4's own SRT reader already does this
 * (`.replace(/\{[\s\S]*?\}/g,"")`), but only on the path where it is handed
 * an SRT and told so. Everything here hands it a Blob labelled `type: "vtt"`,
 * which skips artplayer's converters entirely — so this is the only place the
 * strip can happen.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAssOverrideTags(text) {
  return (text || '')
    .replace(ASS_OVERRIDE_BLOCK_RE, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ');
}

/**
 * VTT timestamp `HH:MM:SS.mmm` from milliseconds.
 *
 * Lives here rather than in the worker because both MKV builders below need
 * it and they moved out of the worker to become testable.
 *
 * @param {number} ms
 * @returns {string}
 */
export function msToVttTime(ms) {
  const clamped = ms > 0 ? ms : 0;
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor((clamped % 3600000) / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const milli = Math.floor(clamped % 1000);
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`
  );
}

/**
 * ASS time `H:MM:SS.cs` → VTT time `HH:MM:SS.mmm`. Returns a safe default
 * on parse failure rather than throwing — a single bad cue should not
 * abort the entire conversion.
 *
 * @param {string} t
 * @returns {string}
 */
function assTimeToVtt(t) {
  const m = ASS_TIME_RE.exec((t || '').trim());
  if (!m) return '00:00:00.000';
  const h = m[1].padStart(2, '0');
  const mn = m[2].padStart(2, '0');
  const [whole, frac = ''] = m[3].split('.');
  const ms = (frac + '000').slice(0, 3);
  return `${h}:${mn}:${whole.padStart(2, '0')}.${ms}`;
}

/**
 * Strip ASS inline override tags from a Dialogue Text field. Converts
 * `\N` / `\n` line breaks to real newlines (VTT supports them in cues).
 * `\h` is the ASS hard-space escape — translate to a regular space.
 *
 * @param {string} text
 */
function stripAssTags(text) {
  return stripAssOverrideTags(text).trim();
}

/**
 * Convert an ASS / SSA text string into a WebVTT string. Returns
 * `'WEBVTT\n\n'` (a valid empty cue list) if no Dialogue lines are found.
 *
 * @param {string} assText
 * @returns {string}
 */
export function convertAssToVtt(assText) {
  if (typeof assText !== 'string') return 'WEBVTT\n\n';
  // Strip BOM
  let src = assText.charCodeAt(0) === 0xFEFF ? assText.slice(1) : assText;

  const lines = src.split(/\r?\n/);
  /** @type {string[] | null} */
  let format = null;
  let inEvents = false;
  /** @type {{ start: string, end: string, text: string }[]} */
  const cues = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      inEvents = line.toLowerCase() === '[events]';
      continue;
    }
    if (!inEvents) continue;

    if (line.toLowerCase().startsWith('format:')) {
      format = line.slice(7).split(',').map((s) => s.trim());
      continue;
    }
    if (!line.toLowerCase().startsWith('dialogue:')) continue;
    if (!format) continue;

    // Dialogue: layer, start, end, style, name, mL, mR, mV, effect, text
    // The Text field is the LAST one and may contain commas; split only
    // up to format.length - 1 times so commas in Text survive.
    const valuesPart = line.slice(9).trim();
    const fields = [];
    let remaining = valuesPart;
    for (let i = 0; i < format.length - 1; i += 1) {
      const idx = remaining.indexOf(',');
      if (idx < 0) {
        fields.push(remaining);
        remaining = '';
        break;
      }
      fields.push(remaining.slice(0, idx).trim());
      remaining = remaining.slice(idx + 1);
    }
    fields.push(remaining); // Text — keep verbatim, do not trim leading whitespace meant for indent

    /** @type {Record<string, string>} */
    const row = {};
    for (let i = 0; i < format.length; i += 1) {
      row[format[i]] = fields[i] ?? '';
    }
    const start = row.Start || row.start;
    const end = row.End || row.end;
    const textRaw = row.Text || row.text;
    if (!start || !end) continue;
    const text = stripAssTags(textRaw);
    if (!text) continue;

    cues.push({
      start: assTimeToVtt(start),
      end: assTimeToVtt(end),
      text,
    });
  }

  // Cues might be authored out-of-order; VTT consumers tolerate it but
  // sorting keeps the output deterministic.
  cues.sort((a, b) => a.start.localeCompare(b.start));

  let out = 'WEBVTT\n\n';
  for (const c of cues) {
    out += `${c.start} --> ${c.end}\n${c.text}\n\n`;
  }
  return out;
}

/**
 * Convert SRT text into WebVTT. The two formats are nearly identical —
 * the only structural difference is the milliseconds separator
 * (SRT: `,`, VTT: `.`) and the required `WEBVTT` header.
 *
 * @param {string} srtText
 * @returns {string}
 */
export function convertSrtToVtt(srtText) {
  if (typeof srtText !== 'string') return 'WEBVTT\n\n';
  let src = srtText.charCodeAt(0) === 0xFEFF ? srtText.slice(1) : srtText;
  const swapped = src.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2',
  );
  // Applied to the whole document rather than per cue, which is safe only
  // because `ASS_OVERRIDE_BLOCK_RE` cannot cross a newline — see its comment.
  // An SRT carrying `{\an8}` is not exotic: it is what most ASS→SRT
  // converters emit, and it is the shape that put the literal tag on screen.
  return `WEBVTT\n\n${stripAssOverrideTags(swapped)}`;
}

/**
 * Build VTT cues from an MKV **ASS/SSA** track's blocks.
 *
 * Moved out of `mkvSubtitle.worker.js`: the worker's job is EBML parsing,
 * which needs real Matroska bytes to exercise, and keeping the text handling
 * in there meant this rule could only be verified by playing a file. Pure
 * function, so it is checkable from `bun test`.
 *
 * Each event's `text` is a raw MKV ASS block:
 *   ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
 * so the Text field starts after the 8th comma.
 *
 * @param {{ time: number, dur: number, text: string }[]} events sorted by time
 * @returns {string}
 */
export function buildVttFromMkvAssEvents(events) {
  let vtt = 'WEBVTT\n\n';
  for (const ev of events || []) {
    let text = ev?.text || '';
    let commas = 0;
    for (let j = 0; j < text.length; j += 1) {
      if (text[j] === ',') {
        commas += 1;
        if (commas === 8) {
          text = text.substring(j + 1);
          break;
        }
      }
    }
    text = stripAssOverrideTags(text).trim();
    if (!text) continue;
    vtt += `${msToVttTime(ev.time)} --> ${msToVttTime(ev.time + ev.dur)}\n${text}\n\n`;
  }
  return vtt;
}

/**
 * Build VTT cues from an MKV **SRT** (`S_TEXT/UTF8`) track's blocks.
 *
 * Unlike the ASS blocks above, an `S_TEXT/UTF8` block payload IS the cue
 * text — there is no ReadOrder prefix to skip.
 *
 * This is where the reported bug lived. The ASS builder stripped override
 * tags and this one did not, so an MKV whose only subtitle track is SRT
 * rendered `{\an8}` as literal text — and because that branch reports its
 * output as already-VTT, jassub never mounts to correct it and artplayer's
 * own SRT reader never runs either. Same rule as its sibling, now literally
 * the same function.
 *
 * @param {{ time: number, dur: number, text: string }[]} events sorted by time
 * @returns {string}
 */
export function buildVttFromMkvSrtEvents(events) {
  let vtt = 'WEBVTT\n\n';
  for (const ev of events || []) {
    const text = stripAssOverrideTags(ev?.text || '').trim();
    if (!text) continue;
    vtt += `${msToVttTime(ev.time)} --> ${msToVttTime(ev.time + ev.dur)}\n${text}\n\n`;
  }
  return vtt;
}
