// Season/part-aware selection among anime search hits.
//
// Why: picking the site entry for a locally-matched series used to be
// `hits[0]` — an arbitrary row from an unranked ILIKE — which for any
// multi-season franchise attached the wrong season's score, year and
// "view details" link to a correctly-identified anime. Dropping
// 無職転生Ⅲ files rendered 無職転生Ⅱ's badges.
//
// A plain substring score cannot fix that: "无职转生" is contained in
// every season's title, so season 1, 2 and 3 all tie and the first one
// listed wins. Identity needs an explicit signal, so this module reads
// the season and part ordinals out of the titles and treats a mismatch
// as disqualifying — never as a low score that a tie-break could
// override.
//
// This is the browser-side twin of go-api's internal/dandanplay/
// seasonmatch.go. Keep the two in step: they answer the same question
// for the same data, one at import time and one at render time.

/** Season and part ordinals carried by a title. 0 means "not stated". */
export interface SeasonMarker {
  season: number;
  part: number;
}

/**
 * An unstated ordinal reads as 1, so "無職転生" and "無職転生 第1期" are the
 * same entry while "無職転生Ⅲ" is not.
 */
function normalizeMarker(m: SeasonMarker): SeasonMarker {
  return { season: m.season || 1, part: m.part || 1 };
}

/**
 * Keeps the highest stated ordinal from either marker. Folding a
 * candidate's several titles this way means an English title that drops
 * the "Ⅲ" cannot erase the season its native title states.
 */
function mergeMarkers(a: SeasonMarker, b: SeasonMarker): SeasonMarker {
  return {
    season: Math.max(a.season, b.season),
    part: Math.max(a.part, b.part),
  };
}

const CJK_NUMERALS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

const ROMAN_NUMERALS: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9,
};

// Longest-first alternation so "iii" is never clipped to "ii". "i", "v"
// and "x" are deliberately absent — they collide with real words and
// titles ("Hunter x Hunter").
const ROMAN_ALT = "viii|vii|iii|vi|iv|ix|ii";

const SEASON_PATTERNS: RegExp[] = [
  /第\s*([0-9]+|[一二三四五六七八九十])\s*[季期]/, //  第二季 / 第2期
  /season\s*([0-9]+)/, //                            season 2
  /([0-9]+)(?:st|nd|rd|th)\s*season/, //             2nd season
  new RegExp(`\\b(${ROMAN_ALT})\\b`), //             …Ⅲ → …III
];

const PART_PATTERNS: RegExp[] = [
  /第\s*([0-9]+|[一二三四五六七八九十])\s*(?:部分|クール|部)/, // 第2部分 / 第2クール
  new RegExp(`\\b(?:part|cour)\\s*([0-9]+|${ROMAN_ALT})\\b`), //  Part 2 / Cour 2
];

function parseOrdinal(raw: string): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && String(n) === raw.trim()) return n;
  return CJK_NUMERALS[raw] ?? ROMAN_NUMERALS[raw] ?? 0;
}

function firstOrdinal(text: string, patterns: RegExp[]): number {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = parseOrdinal(m[1]);
      if (n > 0) return n;
    }
  }
  return 0;
}

/**
 * Reads the season and part ordinals out of an anime title.
 *
 * NFKC folding is what makes the roman-numeral patterns work uniformly:
 * it turns Ⅲ (U+2162) into "III", full-width digits into ASCII, and the
 * full-width tilde into "~".
 *
 * Part markers are read before season markers so the digit inside
 * "第2クール" cannot be re-read as a season — a cour split does not
 * advance the season number ("無職転生Ⅱ … 第2クール" is season 2, part 2).
 */
export function extractSeasonMarker(title: string): SeasonMarker {
  if (!title) return { season: 0, part: 0 };
  const s = title.normalize("NFKC").toLowerCase();

  const part = firstOrdinal(s, PART_PATTERNS);
  const seasonSrc = PART_PATTERNS.reduce(
    (acc, re) => acc.replace(new RegExp(re.source, "g"), " "),
    s,
  );
  return { season: firstOrdinal(seasonSrc, SEASON_PATTERNS), part };
}

/**
 * Collapses a title for comparison: NFKC, lowercase, drop season/part
 * markers, drop punctuation and whitespace.
 *
 * Dropping the markers is deliberate and load-bearing. The two sides
 * spell the same season differently — dandanplay writes "无职转生Ⅲ" where
 * the site cache writes "无职转生 第三季" — so comparing the text with
 * ordinals left in makes the correct pair look unrelated. Season
 * identity is decided separately, by comparing the extracted ordinals;
 * this fold answers only "same franchise?".
 */
export function foldTitle(s: string): string {
  let out = s.normalize("NFKC").toLowerCase();
  for (const re of [...PART_PATTERNS, ...SEASON_PATTERNS]) {
    out = out.replace(new RegExp(re.source, "g"), " ");
  }
  return out.replace(/[\s[\]【】()《》「」『』,.\-_~!@#$%^&*+=|\\/:;?'"·・、。，．]/g, "");
}

/** A search hit, reduced to what identity resolution needs. */
export interface TitledHit {
  titleChinese?: string;
  titleNative?: string;
  titleRomaji?: string;
  title?: string;
}

function hitTitles(hit: TitledHit): string[] {
  return [hit.titleChinese, hit.titleNative, hit.titleRomaji, hit.title].filter(
    (t): t is string => Boolean(t),
  );
}

function hitMarker(hit: TitledHit): SeasonMarker {
  return hitTitles(hit).reduce(
    (acc, t) => mergeMarkers(acc, extractSeasonMarker(t)),
    { season: 0, part: 0 },
  );
}

/**
 * Scores how well a hit's titles answer `query`, or -1 when the hit is
 * disqualified.
 *
 * 100 — a folded title equals the query exactly.
 *  50 — a folded title contains the query, or vice versa.
 *
 * Folding keeps season markers, so containment cannot smuggle a wrong
 * season past the caller's gate on its own.
 */
export function scoreTitleMatch(hit: TitledHit, query: string): number {
  const q = foldTitle(query);
  if (!q) return -1;
  const folded = hitTitles(hit).map(foldTitle).filter(Boolean);
  if (folded.some((c) => c === q)) return 100;
  if (folded.some((c) => c.includes(q) || q.includes(c))) return 50;
  return -1;
}

/**
 * Returns the hit that is the same anime as `query`, or null when none
 * is.
 *
 * Null is a supported, common outcome. The caller renders an un-enriched
 * card, which is strictly better than the confidently wrong enrichment
 * this replaced: a wrong pick puts another season's rating on the page
 * and links "view details" to the wrong anime.
 */
export function pickBestHit<T extends TitledHit>(
  hits: readonly T[],
  query: string,
): T | null {
  if (!hits.length || !query) return null;
  const want = normalizeMarker(extractSeasonMarker(query));

  let best: T | null = null;
  let bestScore = 0;
  for (const hit of hits) {
    const marker = normalizeMarker(hitMarker(hit));
    if (marker.season !== want.season || marker.part !== want.part) continue;
    const score = scoreTitleMatch(hit, query);
    // Strict > keeps the first hit on a tie, so the result is stable
    // for a stable response order.
    if (score > bestScore) {
      best = hit;
      bestScore = score;
    }
  }
  return best;
}
