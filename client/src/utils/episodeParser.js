const VIDEO_EXTS = /\.(mkv|mp4|avi|webm|flv|rmvb|mov|wmv|ts|m4v)$/i;
const SUBTITLE_EXTS = /\.(ass|ssa|srt|vtt)$/i;

const RESOLUTIONS = new Set([360, 480, 720, 1080, 1440, 2160, 4320]);

export function isVideoFile(fileName) {
  return VIDEO_EXTS.test(fileName);
}

export function isSubtitleFile(fileName) {
  return SUBTITLE_EXTS.test(fileName);
}

export function getSubtitleType(fileName) {
  const m = fileName.match(/\.(ass|ssa|srt|vtt)$/i);
  return m ? m[1].toLowerCase() : null;
}

export function parseEpisodeNumber(filename) {
  const patterns = [
    /S\d+E(\d+)/i,                  // S01E03
    /EP?\s*(\d+)/i,                 // EP03, E03, EP 03
    /第(\d+)[話话集]/,               // 第03話, 第3集
    /\s-\s(\d+)\s/,                 // " - 03 "
    /\[(\d+)(?:v\d+)?\]/,          // [03], [03v2]
  ];

  for (const re of patterns) {
    const m = filename.match(re);
    if (m) {
      const num = parseInt(m[1], 10);
      if (RESOLUTIONS.has(num)) continue;
      return num;
    }
  }

  // Fallback: standalone 2-3 digit number
  const fallback = filename.match(/(?:^|\D)(\d{2,3})(?:\D|$)/);
  if (fallback) {
    const num = parseInt(fallback[1], 10);
    if (!RESOLUTIONS.has(num)) return num;
  }

  return null;
}

export function parseAnimeKeyword(filename) {
  if (!filename) return null;

  // For bracket-heavy filenames like [Group][Title][Ep][Quality][Lang].ext
  // Only use this path when text outside brackets is minimal (< 5 chars)
  const textOutside = filename.replace(VIDEO_EXTS, '').replace(/\[[^\]]*\]/g, '').trim();
  if (textOutside.length < 5) {
    const TAG_RE = /^(\d{2,4}[Pp]?\b|HEVC|AVC|x26[45]|H\.?26[45]|AAC|FLAC|WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay|CHS|CHT|JPN?|ENG?|BIG5|GB|S\d+E?\d*|\d{1,3}(?:v\d+)?|SP\d*|OVA|OAD|NCOP|NCED|[A-Z0-9 ]+\d{3,4}[Pp])$/i;
    const brackets = [];
    const re = /\[([^\]]+)\]/g;
    let bm;
    while ((bm = re.exec(filename)) !== null) brackets.push(bm[1]);

    if (brackets.length >= 3) {
      const titleBracket = brackets
        .filter(b => !TAG_RE.test(b.trim()) && b.length > 3)
        .sort((a, b) => b.length - a.length)[0];
      if (titleBracket) {
        return titleBracket
          .replace(/\s*-\s*\d+\s*$/, '')
          .replace(/\s*EP?\s*\d+\s*$/i, '')
          .trim() || null;
      }
    }
  }

  // Standard format: strip brackets and clean up
  let name = filename
    .replace(VIDEO_EXTS, '')
    .replace(/\[[^\]]*\]/g, '')       // [SubGroup] [1080p]
    .replace(/\([^)]*\)/g, '')        // (xxx)
    .replace(/\b\d{3,4}[Pp]\b/g, '') // 720p, 1080P
    .replace(/\b(HEVC|AVC|x26[45]|H\.?26[45]|AAC|FLAC)\b/gi, '')
    .replace(/\b(WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay)\b/gi, '')
    .trim();

  // " - 03" format: take part before separator
  const dashMatch = name.match(/^(.+?)\s+-\s+\d+/);
  if (dashMatch) return dashMatch[1].trim();

  // EP03 format: take part before EP
  const epMatch = name.match(/^(.+?)\s*EP?\s*\d+/i);
  if (epMatch) return epMatch[1].trim();

  return name.replace(/\s+\d+\s*$/, '').trim() || null;
}

/**
 * dandanplay comment format -> ArtPlayer danmuku format
 * dandanplay mode: 1=scroll, 4=bottom, 5=top
 * ArtPlayer mode:  0=scroll, 1=top,    2=bottom
 */
const MODE_MAP = { 1: 0, 4: 2, 5: 1 };

export function dandanToArtplayer(raw) {
  const parts = raw.p.split(',');
  const time = parseFloat(parts[0]);
  const type = parseInt(parts[1], 10);
  const color = parseInt(parts[2], 10);

  return {
    text: raw.m,
    time,
    mode: MODE_MAP[type] ?? 0,
    color: '#' + color.toString(16).padStart(6, '0'),
  };
}
