// Package dandanplay — season/part-aware ranking of anime_cache rows.
//
// Why this exists: the /match siteAnime fallback searches anime_cache by
// title with a tokenised ILIKE, then has to choose among the hits.  It
// used to take rows[0] — an arbitrary heap-order row — which for any
// multi-season franchise silently attached the WRONG season's score,
// year, episode count and anilistId to a correctly-matched anime.  The
// live symptom: dropping 無職転生Ⅲ files rendered 無職転生Ⅱ's badges and a
// "view details" link to season 2.
//
// Similarity alone cannot fix that.  bangumi.NormalizeTitle deliberately
// STRIPS season markers ("ⅱ", "第2期", "part2", …) so that the enrichment
// worker can bind "アオアシ 第2期" to "アオアシ" — which makes every season
// of a franchise normalise to the same string and score ~identically.
// So ranking here is two independent signals:
//
//	similarity — season-blind, answers "same franchise?"
//	marker     — explicit season/part numbers, answers "same entry?"
//
// The marker is a hard gate, not a weight: a season-3 query must never
// resolve to a season-2 row no matter how similar the titles read.

package dandanplay

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// siteAnimeSimFloor is the minimum season-blind title similarity a cache
// row needs before it may be accepted as siteAnime enrichment — unless
// it clears the containment rule in rowMatchesQuery instead.  The
// season/part gate is what rejects wrong entries; this is a secondary
// net for rows that pass the gate but describe a different show.
const siteAnimeSimFloor = 0.45

// seasonMarker is the (season, part) pair carried by an anime title.
// Zero means "not stated"; callers compare via normalized(), which reads
// an unstated marker as 1 so "無職転生" and "無職転生 第1期" are the same
// entry while "無職転生Ⅲ" is not.
type seasonMarker struct {
	season int
	part   int
}

func (m seasonMarker) normalized() seasonMarker {
	out := m
	if out.season == 0 {
		out.season = 1
	}
	if out.part == 0 {
		out.part = 1
	}
	return out
}

// merge keeps the highest stated number from either marker.  Used to fold
// a candidate's several titles into one marker: markers are additive
// information, and absence in one title (an English title that drops the
// "Ⅲ") must not erase a number another title states.
func (m seasonMarker) merge(other seasonMarker) seasonMarker {
	out := m
	if other.season > out.season {
		out.season = other.season
	}
	if other.part > out.part {
		out.part = other.part
	}
	return out
}

var (
	// 第二季 / 第2期 / 第三季 — CJK ordinal seasons.
	cjkSeasonRe = regexp.MustCompile(`第\s*([0-9]+|[一二三四五六七八九十])\s*[季期]`)
	// season 2 / season2
	enSeasonRe = regexp.MustCompile(`season\s*([0-9]+)`)
	// 2nd season / 3rd season
	enOrdinalSeasonRe = regexp.MustCompile(`([0-9]+)(?:st|nd|rd|th)\s*season`)
	// Bare roman numeral run as a season suffix.  NFKC has already folded
	// Ⅲ (U+2162) to "III" by the time this runs.  Longest-first so "iii"
	// can't be clipped to "ii".  "i", "v" and "x" are deliberately absent:
	// they collide with real words and titles ("Hunter x Hunter").
	romanSeasonRe = regexp.MustCompile(`\b(viii|vii|iii|vi|iv|ix|ii)\b`)

	// 第2部分 / 第二部分 / 第2クール — CJK part-within-season markers.
	cjkPartRe = regexp.MustCompile(`第\s*([0-9]+|[一二三四五六七八九十])\s*(?:部分|クール|部)`)
	// part 2 / part ii / cour 2
	enPartRe = regexp.MustCompile(`\b(?:part|cour)\s*([0-9]+|viii|vii|iii|vi|iv|ix|ii)\b`)
)

// cjkNumerals maps the CJK numerals that realistically appear as season
// or part ordinals.  Beyond 十 the forms get compound and no anime needs
// it, so the map stops there.
var cjkNumerals = map[string]int{
	"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
	"六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
}

// romanNumerals maps the lowercase ASCII roman runs the two roman
// patterns can capture.
var romanNumerals = map[string]int{
	"ii": 2, "iii": 3, "iv": 4, "vi": 6, "vii": 7, "viii": 8, "ix": 9,
}

// parseOrdinal reads one captured ordinal in any of the three notations
// the patterns above can yield.  Returns 0 when unparseable.
func parseOrdinal(s string) int {
	if s == "" {
		return 0
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	if n, ok := cjkNumerals[s]; ok {
		return n
	}
	return romanNumerals[s]
}

// firstOrdinal runs the patterns in order and returns the first ordinal
// any of them yields.
func firstOrdinal(s string, patterns ...*regexp.Regexp) int {
	for _, re := range patterns {
		if m := re.FindStringSubmatch(s); m != nil {
			if n := parseOrdinal(m[1]); n > 0 {
				return n
			}
		}
	}
	return 0
}

// extractSeasonMarker pulls the season and part ordinals out of a title.
//
// Input is NFKC-folded and lowercased first, which is what makes the
// roman-numeral patterns work uniformly: NFKC turns Ⅲ into "III", full-
// width digits into ASCII, and the fullwidth tilde into "~".
//
// Part markers are read BEFORE season markers strip anything, because
// "第2クール" must count as part 2 and not season 2 — dandanplay and
// AniList both split a long season into cours under the same season
// number ("無職転生Ⅱ … 第2クール" is season 2, part 2).
func extractSeasonMarker(title string) seasonMarker {
	if title == "" {
		return seasonMarker{}
	}
	s := strings.ToLower(norm.NFKC.String(title))

	part := firstOrdinal(s, cjkPartRe, enPartRe)

	// Remove the part marker before scanning for a season so that the
	// digit inside "第2クール" cannot be re-read as "第2季".
	seasonSrc := cjkPartRe.ReplaceAllString(s, " ")
	seasonSrc = enPartRe.ReplaceAllString(seasonSrc, " ")
	season := firstOrdinal(seasonSrc, cjkSeasonRe, enSeasonRe, enOrdinalSeasonRe, romanSeasonRe)

	return seasonMarker{season: season, part: part}
}

// cacheRowTitles lists the four title columns of a cache row, skipping
// the nil/empty ones.
func cacheRowTitles(row *dbgen.SearchAnimeCacheForDandanplayRow) []string {
	out := make([]string, 0, 4)
	for _, p := range []*string{row.TitleChinese, row.TitleNative, row.TitleRomaji, row.TitleEnglish} {
		if p != nil && *p != "" {
			out = append(out, *p)
		}
	}
	return out
}

// rowMarker folds every title of a row into a single marker.
func rowMarker(row *dbgen.SearchAnimeCacheForDandanplayRow) seasonMarker {
	var m seasonMarker
	for _, t := range cacheRowTitles(row) {
		m = m.merge(extractSeasonMarker(t))
	}
	return m
}

// rowSimilarity is the best season-blind similarity between the query and
// any of the row's titles.  A row carries titles in up to four scripts
// and the query is in exactly one, so max-over-titles is the only fair
// reading; the non-matching scripts score near zero and would drag an
// average down below any usable floor.
func rowSimilarity(row *dbgen.SearchAnimeCacheForDandanplayRow, query string) float64 {
	best := 0.0
	for _, t := range cacheRowTitles(row) {
		if s := bangumi.TitleSimilarity(query, t); s > best {
			best = s
		}
	}
	return best
}

// rowMatchesQuery reports whether a row that already cleared the
// season/part gate is a plausible answer for query, plus its similarity
// for ranking.
//
// Two ways to pass, because Sørensen–Dice punishes length mismatch hard:
// a bare franchise keyword ("无职转生", which is all a folder name gives
// us) scores ~0.33 against the full title "无职转生～到了异世界就拿出真本
// 事～" even though it is unambiguously the same show — and it is the
// very substring the ILIKE matched to produce this row.  So containment
// is an alternative pass, using the same rule as Phase 1's accept gate.
//
// TitleLooselyMatchesKeyword normalises with dandanplay.NormalizeTitle,
// which (unlike bangumi.NormalizeTitle) keeps season markers intact — so
// containment cannot smuggle a wrong season past the gate either.
func rowMatchesQuery(row *dbgen.SearchAnimeCacheForDandanplayRow, query string) (bool, float64) {
	sim := rowSimilarity(row, query)
	if sim >= siteAnimeSimFloor {
		return true, sim
	}
	for _, t := range cacheRowTitles(row) {
		if TitleLooselyMatchesKeyword(t, query) {
			return true, sim
		}
	}
	return false, sim
}

// rankCacheRows orders rows by descending confidence that they are the
// entry `query` names.  Rows whose season/part disagrees with the query
// are dropped entirely rather than ranked last — a wrong-season row is
// never an acceptable answer, so leaving it in the list would only give
// a caller that walks the slice (Phase 2) a chance to pick it.
//
// Ties break on ascending anilist_id so the result is deterministic.
// An empty query returns rows unchanged: with nothing to rank against,
// preserving the caller's order beats inventing one.
func rankCacheRows(rows []dbgen.SearchAnimeCacheForDandanplayRow, query string) []dbgen.SearchAnimeCacheForDandanplayRow {
	if query == "" || len(rows) < 2 {
		return rows
	}
	want := extractSeasonMarker(query).normalized()

	type scored struct {
		row dbgen.SearchAnimeCacheForDandanplayRow
		sim float64
	}
	kept := make([]scored, 0, len(rows))
	for i := range rows {
		row := rows[i]
		if rowMarker(&row).normalized() != want {
			continue
		}
		ok, sim := rowMatchesQuery(&row, query)
		if !ok {
			continue
		}
		kept = append(kept, scored{row: row, sim: sim})
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].sim != kept[j].sim {
			return kept[i].sim > kept[j].sim
		}
		return kept[i].row.AnilistID < kept[j].row.AnilistID
	})
	out := make([]dbgen.SearchAnimeCacheForDandanplayRow, 0, len(kept))
	for _, k := range kept {
		out = append(out, k.row)
	}
	return out
}

// pickCacheRow returns the single row that best answers `query`, or nil
// when nothing clears both the season/part gate and the similarity floor.
//
// Returning nil is a supported, common outcome: the caller renders an
// un-enriched result, which is strictly better than the confidently wrong
// enrichment this function replaced.
func pickCacheRow(rows []dbgen.SearchAnimeCacheForDandanplayRow, query string) *dbgen.SearchAnimeCacheForDandanplayRow {
	if len(rows) == 0 || query == "" {
		return nil
	}
	want := extractSeasonMarker(query).normalized()

	var best *dbgen.SearchAnimeCacheForDandanplayRow
	bestSim := 0.0
	for i := range rows {
		row := rows[i]
		if rowMarker(&row).normalized() != want {
			continue
		}
		ok, sim := rowMatchesQuery(&row, query)
		if !ok {
			continue
		}
		// Strict > keeps the lowest anilist_id on a tie, matching
		// rankCacheRows' ordering.
		if best == nil || sim > bestSim {
			picked := row
			best = &picked
			bestSim = sim
		}
	}
	return best
}
