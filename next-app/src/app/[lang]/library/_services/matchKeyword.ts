// The keyword the library sends to /api/dandanplay/match.
//
// When dandanplay has not indexed a file's hash, the keyword is all go-api
// can go on: it gates phase 1's loose accept, searches anime_cache with it,
// and finally asks dandanplay's own search, which knows release groups' names
// for shows ("Nama-Anaru", "Kanotomo"). go-api reads a season only from
// wording like "Season 3", "3rd Season" or "第三季" (internal/titlematch), and
// uses it as a hard gate, so a later season is spelled out here; the parser's
// own "S3" would be ignored and season 1 assumed.

/** Season wording go-api's titlematch already reads, so nothing is added. */
const SEASON_WORDING =
  /第\s*(?:[0-9]+|[一二三四五六七八九十]+)\s*[季期]|season\s*[0-9]+|[0-9]+(?:st|nd|rd|th)\s*season|シーズン\s*[0-9]+|\b(?:ii|iii|iv|vi|vii|viii|ix)\b/i;

/**
 * @param title  the cluster representative's parsed title
 * @param season the season the file name states, if any
 * @returns the keyword, or "" when there is no title to search by
 */
export function buildMatchKeyword(
  title: string | null | undefined,
  season: number | null | undefined,
): string {
  const t = (title ?? "").trim();
  if (!t) return "";
  if (typeof season !== "number" || season < 2) return t;
  if (SEASON_WORDING.test(t)) return t;
  return `${t} Season ${season}`;
}
