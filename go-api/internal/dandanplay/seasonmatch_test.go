package dandanplay

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ─── extractSeasonMarker ───────────────────────────────────────────────────

func TestExtractSeasonMarker(t *testing.T) {
	tests := []struct {
		name  string
		title string
		want  seasonMarker
	}{
		// The franchise that produced the live bug.  Every notation the
		// four title columns of anime_cache actually carry for it.
		{"cjk ordinal season", "无职转生 第二季 ～到了异世界就拿出真本事～", seasonMarker{season: 2}},
		{"cjk ordinal season three", "无职转生 第三季 ～到了异世界就拿出真本事～", seasonMarker{season: 3}},
		{"fullwidth roman II", "無職転生Ⅱ ～異世界行ったら本気だす～", seasonMarker{season: 2}},
		{"fullwidth roman III", "無職転生Ⅲ ～異世界行ったら本気だす～", seasonMarker{season: 3}},
		{"ascii roman in romaji", "Mushoku Tensei III: Isekai Ittara Honki Dasu", seasonMarker{season: 3}},
		{"no marker is season zero", "無職転生 ～異世界行ったら本気だす～", seasonMarker{}},

		// Part markers are a SEPARATE axis from season — a cour split
		// does not advance the season number.
		{"cjk part", "无职转生～到了异世界就拿出真本事～ 第2部分", seasonMarker{part: 2}},
		{"japanese cour", "無職転生 ～異世界行ったら本気だす～ 第2クール", seasonMarker{part: 2}},
		{"english part", "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2", seasonMarker{part: 2}},
		{"season and part together", "無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール", seasonMarker{season: 2, part: 2}},
		{"cjk season and part together", "无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分", seasonMarker{season: 2, part: 2}},

		// Other notations seen across the cache.
		{"english season n", "Overlord Season 3", seasonMarker{season: 3}},
		{"english ordinal season", "Attack on Titan 2nd Season", seasonMarker{season: 2}},
		{"japanese 第N期", "アオアシ 第2期", seasonMarker{season: 2}},
		{"arabic cjk season", "某作品 第2季", seasonMarker{season: 2}},
		{"cour keyword", "Some Show Cour 2", seasonMarker{part: 2}},

		// Guards against false positives.
		{"x is not a numeral", "Hunter x Hunter", seasonMarker{}},
		{"bare v is not a numeral", "Gundam V", seasonMarker{}},
		{"roman inside a word is ignored", "Familia Myth II", seasonMarker{season: 2}},
		{"empty", "", seasonMarker{}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, extractSeasonMarker(tc.title))
		})
	}
}

func TestSeasonMarkerNormalizedTreatsUnstatedAsOne(t *testing.T) {
	// "無職転生" and "無職転生 第1期" are the same entry; "無職転生Ⅲ" is not.
	assert.Equal(t, seasonMarker{season: 1, part: 1}, seasonMarker{}.normalized())
	assert.Equal(t, seasonMarker{season: 1, part: 1}, seasonMarker{season: 1}.normalized())
	assert.NotEqual(t, seasonMarker{season: 3}.normalized(), seasonMarker{}.normalized())
}

func TestSeasonMarkerMergeKeepsHighestStated(t *testing.T) {
	// An English title that drops the "Ⅲ" must not erase the season the
	// native title states.
	got := seasonMarker{season: 3}.merge(seasonMarker{})
	assert.Equal(t, seasonMarker{season: 3}, got)
	got = seasonMarker{}.merge(seasonMarker{season: 2, part: 2})
	assert.Equal(t, seasonMarker{season: 2, part: 2}, got)
}

// ─── fixtures ──────────────────────────────────────────────────────────────

func cacheRow(anilistID int32, cn, native, romaji string) dbgen.SearchAnimeCacheForDandanplayRow {
	return dbgen.SearchAnimeCacheForDandanplayRow{
		AnilistID:    anilistID,
		TitleChinese: strPtr(cn),
		TitleNative:  strPtr(native),
		TitleRomaji:  strPtr(romaji),
	}
}

// mushokuRows mirrors what prod's anime_cache actually returns for the
// keyword "无职转生", in the ORDER BY anilist_id order the query now
// guarantees.  Season 2 (146065) came back first under the old heap
// order, which is exactly how it ended up rendered on a season 3 card.
func mushokuRows() []dbgen.SearchAnimeCacheForDandanplayRow {
	return []dbgen.SearchAnimeCacheForDandanplayRow{
		cacheRow(108465, "无职转生～到了异世界就拿出真本事～",
			"無職転生 ～異世界行ったら本気だす～",
			"Mushoku Tensei: Isekai Ittara Honki Dasu"),
		cacheRow(127720, "无职转生～到了异世界就拿出真本事～ 第2部分",
			"無職転生 ～異世界行ったら本気だす～ 第2クール",
			"Mushoku Tensei: Isekai Ittara Honki Dasu Part 2"),
		cacheRow(146065, "无职转生 第二季 ～到了异世界就拿出真本事～",
			"無職転生Ⅱ ～異世界行ったら本気だす～",
			"Mushoku Tensei II: Isekai Ittara Honki Dasu"),
		cacheRow(166873, "无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分",
			"無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール",
			"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2"),
		cacheRow(178789, "无职转生 第三季 ～到了异世界就拿出真本事～",
			"無職転生Ⅲ ～異世界行ったら本気だす～",
			"Mushoku Tensei III: Isekai Ittara Honki Dasu"),
	}
}

// ─── pickCacheRow ──────────────────────────────────────────────────────────

func TestPickCacheRowSelectsTheRequestedSeason(t *testing.T) {
	// The live regression: a season 3 drop rendered season 2's score,
	// year, episode count and "view details" link.
	rows := mushokuRows()

	got := pickCacheRow(rows, "无职转生Ⅲ ～到了异世界就拿出真本事～")
	require.NotNil(t, got)
	assert.Equal(t, int32(178789), got.AnilistID)
}

func TestPickCacheRowSeasonAndPartAreIndependentAxes(t *testing.T) {
	rows := mushokuRows()

	tests := []struct {
		name  string
		query string
		want  int32
	}{
		{"season 1", "无职转生～到了异世界就拿出真本事～", 108465},
		{"season 1 part 2", "无职转生～到了异世界就拿出真本事～ 第2部分", 127720},
		{"season 2", "无职转生Ⅱ ～到了异世界就拿出真本事～", 146065},
		{"season 2 part 2", "无职转生Ⅱ ～到了异世界就拿出真本事～ 第二部分", 166873},
		{"season 3", "无职转生Ⅲ ～到了异世界就拿出真本事～", 178789},
		// A romaji query must land on the same entry as its CN twin.
		{"romaji season 3", "Mushoku Tensei III: Isekai Ittara Honki Dasu", 178789},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := pickCacheRow(rows, tc.query)
			require.NotNil(t, got, "expected a pick for %q", tc.query)
			assert.Equal(t, tc.want, got.AnilistID)
		})
	}
}

func TestPickCacheRowReturnsNilRatherThanAWrongSeason(t *testing.T) {
	// Season 4 doesn't exist in the cache.  Returning nil leaves the card
	// un-enriched; returning any of the five rows would put a wrong score
	// and a wrong details link on a correctly matched anime.
	got := pickCacheRow(mushokuRows(), "无职转生Ⅳ ～到了异世界就拿出真本事～")
	assert.Nil(t, got)
}

func TestPickCacheRowRejectsUnrelatedTitlesBelowTheFloor(t *testing.T) {
	// Same (unstated) season marker as row 108465, so only the
	// similarity floor can reject this.
	got := pickCacheRow(mushokuRows(), "紫罗兰永恒花园")
	assert.Nil(t, got)
}

func TestPickCacheRowHandlesEmptyInputs(t *testing.T) {
	assert.Nil(t, pickCacheRow(nil, "无职转生Ⅲ"))
	assert.Nil(t, pickCacheRow(mushokuRows(), ""))
}

func TestPickCacheRowSingleSeasonShowStillEnriches(t *testing.T) {
	// The guard must not cost us enrichment on the common case: one
	// season, no markers anywhere.
	rows := []dbgen.SearchAnimeCacheForDandanplayRow{
		cacheRow(21827, "紫罗兰永恒花园", "ヴァイオレット・エヴァーガーデン", "Violet Evergarden"),
	}
	got := pickCacheRow(rows, "紫罗兰永恒花园")
	require.NotNil(t, got)
	assert.Equal(t, int32(21827), got.AnilistID)
}

// ─── rankCacheRows ─────────────────────────────────────────────────────────

func TestRankCacheRowsDropsContradictorySeasons(t *testing.T) {
	// Phase 2 walks this slice and accepts the first candidate whose
	// episodes resolve — and every season of a franchise resolves
	// episodes 1..n.  So anything left in the slice is a candidate the
	// loop may pick, which is why wrong seasons are dropped, not ranked.
	got := rankCacheRows(mushokuRows(), "无职转生Ⅲ ～到了异世界就拿出真本事～")
	require.Len(t, got, 1)
	assert.Equal(t, int32(178789), got[0].AnilistID)
}

func TestRankCacheRowsIsDeterministicAndPreservesUnrankableInput(t *testing.T) {
	rows := mushokuRows()

	// Empty query → caller's order, untouched.
	assert.Equal(t, rows, rankCacheRows(rows, ""))

	// Same input twice → same output.
	a := rankCacheRows(rows, "无职转生 第二季 ～到了异世界就拿出真本事～")
	b := rankCacheRows(rows, "无职转生 第二季 ～到了异世界就拿出真本事～")
	assert.Equal(t, a, b)
	require.NotEmpty(t, a)
	assert.Equal(t, int32(146065), a[0].AnilistID)
}
