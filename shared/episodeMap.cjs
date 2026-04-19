/**
 * Build a map of {requestedEpisodeNumber -> {dandanEpisodeId, title}} against
 * dandanplay's episode list. Used by both server (match controller) and client
 * (manual anime picker) to keep continuation-season mapping consistent.
 *
 * Three-level match fallback (applied per requested episode):
 *   1. pure numeric episodeNumber  (e.g. S1 "1"..."12")
 *   2. OVA/Special prefix          (e.g. "O1", "S1")
 *   3. index-based on pure-numeric-only entries — for continuation seasons
 *      where dandanplay numbers episodes as 25..35 instead of 1..11. Specials
 *      (C1/C2/C3 openings/endings) are filtered out so index lookups land on
 *      the real episode.
 */
function buildEpisodeMap(dandanEpisodes, requestedEpisodes) {
  const map = {};
  if (!Array.isArray(dandanEpisodes) || dandanEpisodes.length === 0) return map;

  for (const epNum of requestedEpisodes) {
    const match = dandanEpisodes.find(e => e.number === epNum);
    if (match) {
      map[epNum] = { dandanEpisodeId: match.dandanEpisodeId, title: match.title };
    }
  }

  for (const epNum of requestedEpisodes) {
    if (map[epNum]) continue;
    const ovaMatch = dandanEpisodes.find(e => {
      const raw = e.rawEpisodeNumber;
      if (!raw) return false;
      const m = raw.match(/^[OS](\d+)$/i);
      return m && parseInt(m[1], 10) === epNum;
    });
    if (ovaMatch) {
      map[epNum] = { dandanEpisodeId: ovaMatch.dandanEpisodeId, title: ovaMatch.title };
    }
  }

  // Level 3: index-based fallback on regular episodes only.
  // Filter out specials (C1/C2/C3 openings/endings, O/S OVA/Special prefixes)
  // so index N - 1 lands on the Nth actual episode for continuation seasons.
  const regulars = dandanEpisodes.filter(e => /^\d+$/.test(String(e.rawEpisodeNumber || '')));
  const pool = regulars.length > 0 ? regulars : dandanEpisodes;

  for (const epNum of requestedEpisodes) {
    if (map[epNum]) continue;
    const byIndex = pool[epNum - 1];
    if (byIndex) {
      map[epNum] = { dandanEpisodeId: byIndex.dandanEpisodeId, title: byIndex.title };
    }
  }

  return map;
}

module.exports = { buildEpisodeMap };
