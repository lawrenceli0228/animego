// @ts-check
//
// Subtitle format converters — produce WebVTT output that artplayer's
// built-in renderer can consume. Used by the user-pick subtitle flow when
// the local file is not already VTT.
//
// Limitations:
//   - ASS → VTT is plain-text only. ASS inline tags ({\an8}, {\b1}, \fad,
//     karaoke \k) are stripped — artplayer's VTT engine has no way to
//     express ASS typesetting / animations. Full-fidelity rendering needs
//     libass-wasm (jassub), tracked separately.
//   - SRT → VTT is a near-trivial timestamp comma→period swap.

const ASS_TIME_RE = /(\d+):(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)/;

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
  let out = (text || '');
  // Remove {...} blocks (override tags). Greedy-not-greedy doesn't matter
  // because braces in ASS are never legitimately nested.
  out = out.replace(/\{[^}]*\}/g, '');
  out = out.replace(/\\[Nn]/g, '\n');
  out = out.replace(/\\h/g, ' ');
  return out.trim();
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
  return `WEBVTT\n\n${swapped}`;
}
