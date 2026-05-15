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

/**
 * Strip codec/bit-depth/resolution tokens whose digits would otherwise be
 * stolen by `parseEpisodeNumber`'s leftmost-digit fallback. The dedicated
 * regex patterns (S04E01 / [01] / 第03話 / etc.) already match on the raw
 * filename, so this scrubbing only kicks in when nothing else matched — at
 * which point we don't want `10bit` → episode 10 or `x265` → episode 265.
 *
 * @param {string} s
 */
function stripTechTokens(s) {
  return s
    .replace(/\b\d{1,2}bit\b/gi, '')        // 8bit, 10bit, 12bit, Hi10P upstream
    .replace(/\bHi10P?\b/gi, '')
    .replace(/\bx26[45]\b/gi, '')            // x264, x265
    .replace(/\bH\.?26[45]\b/gi, '')         // H264, H.264, H265
    .replace(/\b\d{3,4}[Pp]\b/g, '');        // 1080P, 720p, 2160P, etc.
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

  // Fallback: standalone 2-3 digit number, but only AFTER scrubbing codec
  // tokens. Otherwise `[NCOP1][1080P][HEVC-10bit][FLAC].mkv` returns 10
  // (from `10bit`) and a BD extras file silently steals the main lane's
  // ep10 slot.
  const fallback = stripTechTokens(filename).match(/(?:^|\D)(\d{2,3})(?:\D|$)/);
  if (fallback) {
    const num = parseInt(fallback[1], 10);
    if (!RESOLUTIONS.has(num)) return num;
  }

  return null;
}

const TAG_RE = /^(\d{2,4}[Pp]?\b|HEVC|AVC|x26[45]|H\.?26[45]|AAC|FLAC|WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay|CHS|CHT|JPN?|ENG?|BIG5|GB|S\d+E?\d*|\d{1,3}(?:v\d+)?|SP\d*|OVA|OAD|NCOP|NCED|Commentary|Audio\s+Commentary|[A-Z0-9 ]+\d{3,4}[Pp])$/i;
const RANGE_RE = /^\d{1,3}\s*-\s*\d{1,3}$/;
// ANY quality/codec token inside a bracket → bracket is a tag. Catches
// space- or underscore-separated compounds the single-token TAG_RE misses,
// e.g. `AVC 8bit`, `AAC AVC`, `HEVC-10bit 1080p AAC`, `x264_AAC`, `HEVC_FLAC`.
const QUALITY_HINTS = /\b(HEVC|AVC|x26[45]|H\.?26[45]|AAC|FLAC|10bit|8bit|WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay|HDR|DV|TrueHD|DTS)\b/i;

function tryStandardPath(filename) {
  let name = filename
    .replace(VIDEO_EXTS, '')
    .replace(/\[[^\]]*\]/g, '')       // [SubGroup] [1080p]
    .replace(/\([^)]*\)/g, '')        // (xxx)
    .replace(/\b\d{3,4}[Pp]\b/g, '') // 720p, 1080P
    .replace(/\b(HEVC|AVC|x26[45]|H\.?26[45]|AAC|FLAC)\b/gi, '')
    .replace(/\b(WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay)\b/gi, '')
    .trim();

  const dashMatch = name.match(/^(.+?)\s+-\s+\d+/);
  if (dashMatch) return dashMatch[1].trim();

  const epMatch = name.match(/^(.+?)\s*EP?\s*\d+/i);
  if (epMatch) return epMatch[1].trim();

  return name.replace(/\s+\d+\s*$/, '').trim() || null;
}

function tryBracketHeavy(filename) {
  const brackets = [];
  const re = /\[([^\]]+)\]/g;
  let bm;
  while ((bm = re.exec(filename)) !== null) brackets.push(bm[1]);
  if (brackets.length < 3) return null;

  const titleBracket = brackets
    .filter((b) => {
      const t = b.trim();
      if (!t || t.length <= 3) return false;
      if (TAG_RE.test(t)) return false;
      if (RANGE_RE.test(t)) return false;
      if (QUALITY_HINTS.test(t)) return false;
      return true;
    })
    .sort((a, b) => b.length - a.length)[0];

  if (!titleBracket) return null;
  return titleBracket
    .replace(/\s*-\s*\d+\s*$/, '')
    .replace(/\s*EP?\s*\d+\s*$/i, '')
    .replace(/_/g, ' ')
    .trim() || null;
}

/**
 * Decide whether a candidate looks like a real title. Rejects junk left over
 * from malformed bracket pairings (`-HEVC_opus]`), single-token quality
 * leftovers, and anything without at least one letter.
 */
function looksLikeTitle(candidate) {
  if (!candidate) return false;
  if (candidate.length < 4) return false;
  if (/[\[\]]/.test(candidate)) return false;        // residual bracket char
  if (!/\p{L}/u.test(candidate)) return false;       // need at least one letter
  if (TAG_RE.test(candidate)) return false;
  if (QUALITY_HINTS.test(candidate) && !/\s/.test(candidate)) return false;
  return true;
}

export function parseAnimeKeyword(filename) {
  if (!filename) return null;
  const standard = tryStandardPath(filename);
  if (looksLikeTitle(standard)) return standard;
  return tryBracketHeavy(filename) || standard || null;
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

// Order is significant: parseEpisodeKind walks this list in declaration order
// and short-circuits on the first match. Specific BD-extra patterns must come
// before generic ones (e.g. NCOP wins over SP because `NCOP01` contains a
// digit that would otherwise trip the bare-digit fallback path into 'main').
const KIND_PATTERNS = {
  commentary: /(?:\bAudio\s+Commentary\b|\bCommentary\b|解[说說]|オーディオコメンタリー)/i,
  // Credit-less OP/ED — BDRip staple. NC=Non-Credit, sometimes written NC OP / Creditless OP.
  ncop:       /\b(?:NC\s*OP\d*|Creditless\s+OP)\b/i,
  nced:       /\b(?:NC\s*ED\d*|Creditless\s+ED)\b/i,
  // BD/DVD menu animations — DBD-Raws ships these in `[menu]` brackets.
  // Must rank above `bonus` so `BD Menu` resolves to 'menu' (more specific).
  menu:       /(?:\bBD\s+Menu\b|\bDVD\s+Menu\b|\bmenu\b)/i,
  // BD bonus disc / Japanese 特典 / Extra
  bonus:      /(?:\bBonus\b|\bExtra\b|\bDisc\s+\d|特典)/i,
  trailer:    /(?:\bTrailer\b|\bTeaser\b)/i,
  interview:  /(?:\bInterview\b|\bCast\s+Talk\b|访谈|訪談)/i,
  wp:         /(?:\bWP\d*\b|\bWeb\s+Preview\b)/i,
  // Commercial bumper — require trailing digit/`s` (length) so plain "CM"
  // in a fansub-group acronym never trips this.
  cm:         /\bCM\s*\d/i,
  movie:      /(?:\bMovie\b|劇場版|剧场版)/i,
  sp:         /\b(?:SP\d*|OAD\d*)\b/i,
  ova:        /\bOVA\d*\b/i,
  pv:         /(?:\bPV\d*\b|预告|預告)/i,
};

/**
 * 从文件名推断集类型。
 *
 * 识别规则按 KIND_PATTERNS 声明顺序匹配,首个命中即返回。
 * 优先级原则: 更具体 / 更"必排除于正片反推"的 kind 排前。
 *
 * 'main' 是兜底——文件名含任意数字且无任何特征 token 时返回。
 *
 * @param {string} filename
 * @returns {'main'|'sp'|'ova'|'movie'|'pv'|'commentary'|'ncop'|'nced'|'bonus'|'trailer'|'interview'|'wp'|'cm'|'menu'|'unknown'}
 */
export function parseEpisodeKind(filename) {
  if (!filename) return 'unknown';

  for (const [kind, pattern] of Object.entries(KIND_PATTERNS)) {
    if (pattern.test(filename)) {
      return /** @type {ReturnType<typeof parseEpisodeKind>} */ (kind);
    }
  }

  // 含数字则视为正片,否则无法判断
  if (/\d/.test(filename)) return 'main';
  return 'unknown';
}

const GROUP_RE = /^\[([^\]]{1,30})\]/;
// `\b` falls over inside `_AVC_` (underscore is `\w`) — use explicit
// non-alphanumeric lookarounds so `[1080P_AVC_AAC]` style fansub tags still
// surface the resolution. Underscore counts as a separator here.
const RESOLUTION_RE = /(?<![A-Za-z0-9])(2160[Pp]|4[Kk]|1080[Pp]|720[Pp]|480[Pp])(?![A-Za-z0-9])/;

// ─── 季号解析 ────────────────────────────────────────────────────────────────

const CN_NUM_DIGIT = { 零:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };

/** Convert a Chinese numeral string like "四" / "十" / "十二" to Number, or NaN. */
function chineseToInt(s) {
  if (!s) return NaN;
  if (s === '十') return 10;
  // 十X → 10 + X
  if (s.length === 2 && s[0] === '十') {
    const d = CN_NUM_DIGIT[s[1]];
    return d == null ? NaN : 10 + d;
  }
  // X十 / X十Y → X*10 (+ Y)
  if (s.length >= 2 && s[1] === '十') {
    const tens = CN_NUM_DIGIT[s[0]];
    const ones = s.length === 3 ? CN_NUM_DIGIT[s[2]] : 0;
    if (tens == null || ones == null) return NaN;
    return tens * 10 + ones;
  }
  // Single character: 一..九
  if (s.length === 1) {
    const d = CN_NUM_DIGIT[s];
    return d == null ? NaN : d;
  }
  return NaN;
}

const ROMAN_TO_INT = { I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7, VIII:8, IX:9, X:10 };

/**
 * 从文件名推断季号。规则按优先级匹配,首个命中即返回。
 *
 * 覆盖:
 *  - S04E01 / S2 / S04                          (拉丁缩写)
 *  - Season 4                                    (英文全拼)
 *  - 4th / 4th Season / 1st Cour                 (英文序数)
 *  - 第4季 / 第4期 / 第4部                       (中文阿拉伯)
 *  - 第四季 / 第十二期 / 第十部                  (中文数字)
 *  - II / III / IV / V .. X 在明显的季尾位置     (罗马数字,最低优先级,需紧贴 ] / ) / 】 / 末尾 / " - ")
 *
 * @param {string|null|undefined} filename
 * @returns {number|null}
 */
export function parseSeason(filename) {
  if (!filename) return null;
  const s = String(filename).normalize('NFKC');

  // 1. S04E01 — 最强信号
  let m = s.match(/\bS(\d{1,2})E\d{1,3}\b/i);
  if (m) return parseInt(m[1], 10);

  // 2. Season 4
  m = s.match(/\bSeason\s+(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);

  // 3. 英文序数: 4th / 4th Season / 1st Cour
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (m) return parseInt(m[1], 10);

  // 4. 裸 S2 / S04 — 注意排除 S04E01(已被规则 1 吃掉)和 SP/SS/STAR 这种带后续字母的
  m = s.match(/\bS(\d{1,2})(?![A-Za-z\d])/);
  if (m) return parseInt(m[1], 10);

  // 5. 中文阿拉伯: 第4季 / 第4期 / 第4部
  m = s.match(/第\s*(\d{1,2})\s*[季期部]/);
  if (m) return parseInt(m[1], 10);

  // 6. 中文数字: 第四季 / 第十二期
  m = s.match(/第\s*((?:十)?[零一二三四五六七八九]|[一二三四五六七八九]?十(?:[零一二三四五六七八九])?)\s*[季期部]/);
  if (m) {
    const n = chineseToInt(m[1]);
    if (!Number.isNaN(n)) return n;
  }

  // 7. 罗马数字 — 仅当处于明显的季尾位置(后跟右括号 / 末尾 / " - "),
  //    且前面是开括号或空白,降低误伤"title 内含罗马"(如 FF VII Remake)的概率。
  m = s.match(/(?:^|\s|\[|【|\()(II|III|IV|V|VI|VII|VIII|IX|X)(?=\s*[\]\)】]|\s+-\s|$)/);
  if (m) return ROMAN_TO_INT[m[1]];

  return null;
}

// ─── 绝对集号(总集号)解析 ──────────────────────────────────────────────────

/**
 * 从文件名提取繁中/简中字幕组的"总集号"标记。
 *
 * 覆盖:
 *  - `[總第67]` (繁体) / `[总第67]` (简体)
 *  - 可带空白: `總第 67`
 *
 * 返回 null 表示文件名里没有这类总集号标记 — 不代表"没有总集号",
 * 调用方需配合 metadata (TMDB / Bangumi 每季集数表) 自行反推。
 *
 * @param {string|null|undefined} filename
 * @returns {number|null}
 */
export function parseAbsoluteEpisode(filename) {
  if (!filename) return null;
  const s = String(filename).normalize('NFKC');
  const m = s.match(/(?:總第|总第)\s*(\d{1,4})/);
  return m ? parseInt(m[1], 10) : null;
}

const RESOLUTION_LABEL_MAP = {
  '4k': '2160p',
};

/**
 * 从文件名解析剧集完整元数据,内部复用现有 parseEpisodeNumber / parseAnimeKeyword /
 * parseSeason / parseAbsoluteEpisode。
 *
 * `season` 表示这一集**所在季**(从文件名 4th / S2 / 第N季 / 罗马数字推断,null 表示未识别)。
 * `episodeAlt` 是繁中字幕组的"总集号" (`總第N`) — 跨季全局递增。
 * `number` 是文件名表面的集号 (本季内的 01..N),与 `episodeAlt` 互不冲突,可同时存在。
 *
 * @param {string} filename
 * @returns {{ title: string|null, number: number|null, kind: 'main'|'sp'|'ova'|'movie'|'pv'|'commentary'|'ncop'|'nced'|'bonus'|'trailer'|'interview'|'wp'|'cm'|'unknown', group: string|null, resolution: '480p'|'720p'|'1080p'|'2160p'|null, season: number|null, episodeAlt: number|null }}
 */
export function parseEpisodeMeta(filename) {
  if (!filename) {
    return { title: null, number: null, kind: 'unknown', group: null, resolution: null, season: null, episodeAlt: null };
  }

  const title      = parseAnimeKeyword(filename);
  const number     = parseEpisodeNumber(filename);
  const kind       = parseEpisodeKind(filename);
  const season     = parseSeason(filename);
  const episodeAlt = parseAbsoluteEpisode(filename);

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

  return { title, number, kind, group, resolution, season, episodeAlt };
}
