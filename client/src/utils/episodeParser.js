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

// ─── P1 新增:集类型与完整元数据解析 ───────────────────────────────────────────

const KIND_PATTERNS = {
  sp:    /\b(?:SP\d*|OAD\d*)\b/i,
  ova:   /\bOVA\d*\b/i,
  movie: /(?:\bMovie\b|劇場版|剧场版)/i,
  pv:    /(?:\bPV\d*\b|预告|預告)/i,
};

/**
 * 从文件名推断集类型。
 *
 * 识别规则:
 * - SP\d* / OAD\d*  → 'sp'
 * - OVA\d*          → 'ova'
 * - Movie / 劇場版 / 剧场版 → 'movie'
 * - PV\d* / 预告 / 預告     → 'pv'
 * - 有集号或常规文件名       → 'main'
 * - 无以上特征且无数字       → 'unknown'
 *
 * @param {string} filename
 * @returns {'main'|'sp'|'ova'|'movie'|'pv'|'unknown'}
 */
export function parseEpisodeKind(filename) {
  if (!filename) return 'unknown';

  if (KIND_PATTERNS.sp.test(filename))    return 'sp';
  if (KIND_PATTERNS.ova.test(filename))   return 'ova';
  if (KIND_PATTERNS.movie.test(filename)) return 'movie';
  if (KIND_PATTERNS.pv.test(filename))    return 'pv';

  // 含数字则视为正片,否则无法判断
  if (/\d/.test(filename)) return 'main';
  return 'unknown';
}

const GROUP_RE = /^\[([^\]]{1,30})\]/;
const RESOLUTION_RE = /\b(2160[Pp]|4[Kk]|1080[Pp]|720[Pp]|480[Pp])\b/i;

const RESOLUTION_LABEL_MAP = {
  '4k': '2160p',
};

/**
 * 从文件名解析剧集完整元数据,内部复用现有 parseEpisodeNumber / parseAnimeKeyword。
 *
 * @param {string} filename
 * @returns {{ title: string|null, number: number|null, kind: 'main'|'sp'|'ova'|'movie'|'pv'|'unknown', group: string|null, resolution: '480p'|'720p'|'1080p'|'2160p'|null }}
 */
export function parseEpisodeMeta(filename) {
  if (!filename) {
    return { title: null, number: null, kind: 'unknown', group: null, resolution: null };
  }

  const title      = parseAnimeKeyword(filename);
  const number     = parseEpisodeNumber(filename);
  const kind       = parseEpisodeKind(filename);

  const groupMatch = filename.match(GROUP_RE);
  const group      = groupMatch ? groupMatch[1].trim() : null;

  const resMatch   = filename.match(RESOLUTION_RE);
  let resolution   = null;
  if (resMatch) {
    const raw = resMatch[1].toLowerCase().replace(/\s/g, '');
    resolution = RESOLUTION_LABEL_MAP[raw] ?? raw.replace('p', 'p');
    // 归一化为带小写 p 的标准标签
    if (!resolution.endsWith('p')) resolution = resolution + 'p';
    // 只接受四档
    if (!['480p', '720p', '1080p', '2160p'].includes(resolution)) resolution = null;
  }

  return { title, number, kind, group, resolution };
}
