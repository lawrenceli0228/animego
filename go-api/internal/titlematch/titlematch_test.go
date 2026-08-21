// Package titlematch — titlematch_test.go
//
// These are the tests internal/dandanplay/seasonmatch_test.go used to own,
// ported verbatim when the string logic was extracted, plus coverage of the
// API that only exists here.  Callers outside dandanplay depend on this
// package directly, so it carries its own gate.

package titlematch

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─── ExtractMarker ─────────────────────────────────────────────────────────

func TestExtractMarker(t *testing.T) {
	tests := []struct {
		name  string
		title string
		want  Marker
	}{
		// The franchise that produced the live bug.  Every notation the
		// four title columns of anime_cache actually carry for it.
		{"cjk ordinal season", "无职转生 第二季 ～到了异世界就拿出真本事～", Marker{Season: 2}},
		{"cjk ordinal season three", "无职转生 第三季 ～到了异世界就拿出真本事～", Marker{Season: 3}},
		{"fullwidth roman II", "無職転生Ⅱ ～異世界行ったら本気だす～", Marker{Season: 2}},
		{"fullwidth roman III", "無職転生Ⅲ ～異世界行ったら本気だす～", Marker{Season: 3}},
		{"ascii roman in romaji", "Mushoku Tensei III: Isekai Ittara Honki Dasu", Marker{Season: 3}},
		{"no marker is season zero", "無職転生 ～異世界行ったら本気だす～", Marker{}},

		// Part markers are a SEPARATE axis from season — a cour split
		// does not advance the season number.
		{"cjk part", "无职转生～到了异世界就拿出真本事～ 第2部分", Marker{Part: 2}},
		{"japanese cour", "無職転生 ～異世界行ったら本気だす～ 第2クール", Marker{Part: 2}},
		{"english part", "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2", Marker{Part: 2}},
		{"season and part together", "無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール", Marker{Season: 2, Part: 2}},
		{"cjk season and part together", "无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分", Marker{Season: 2, Part: 2}},

		// Other notations seen across the cache.
		{"english season n", "Overlord Season 3", Marker{Season: 3}},
		{"english ordinal season", "Attack on Titan 2nd Season", Marker{Season: 2}},
		{"japanese 第N期", "アオアシ 第2期", Marker{Season: 2}},
		{"arabic cjk season", "某作品 第2季", Marker{Season: 2}},
		{"cour keyword", "Some Show Cour 2", Marker{Part: 2}},

		// Guards against false positives.
		{"x is not a numeral", "Hunter x Hunter", Marker{}},
		{"bare v is not a numeral", "Gundam V", Marker{}},
		{"roman inside a word is ignored", "Familia Myth II", Marker{Season: 2}},
		{"empty", "", Marker{}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, ExtractMarker(tc.title))
		})
	}
}

func TestMarkerNormalizedTreatsUnstatedAsOne(t *testing.T) {
	// "無職転生" and "無職転生 第1期" are the same entry; "無職転生Ⅲ" is not.
	assert.Equal(t, Marker{Season: 1, Part: 1}, Marker{}.Normalized())
	assert.Equal(t, Marker{Season: 1, Part: 1}, Marker{Season: 1}.Normalized())
	assert.NotEqual(t, Marker{Season: 3}.Normalized(), Marker{}.Normalized())
}

func TestMarkerNormalizedIsIdempotent(t *testing.T) {
	// SameEntry normalises both sides on every call, so callers that hand it
	// an already-normalised marker must get the same answer.
	m := Marker{Season: 3, Part: 2}.Normalized()
	assert.Equal(t, m, m.Normalized())
}

func TestMarkerMergeKeepsHighestStated(t *testing.T) {
	// An English title that drops the "Ⅲ" must not erase the season the
	// native title states.
	got := Marker{Season: 3}.Merge(Marker{})
	assert.Equal(t, Marker{Season: 3}, got)
	got = Marker{}.Merge(Marker{Season: 2, Part: 2})
	assert.Equal(t, Marker{Season: 2, Part: 2}, got)
}

// ─── SameEntry / MarkerFor / SeasonsAgree ──────────────────────────────────

func TestMarkerSameEntry(t *testing.T) {
	tests := []struct {
		name string
		a, b Marker
		want bool
	}{
		{"unstated equals explicit season one", Marker{}, Marker{Season: 1}, true},
		{"unstated equals explicit season and part one", Marker{}, Marker{Season: 1, Part: 1}, true},
		{"season two is not season three", Marker{Season: 2}, Marker{Season: 3}, false},
		{"unstated is not season three", Marker{}, Marker{Season: 3}, false},
		{"part is an independent axis", Marker{Season: 2}, Marker{Season: 2, Part: 2}, false},
		{"same season and part agree", Marker{Season: 2, Part: 2}, Marker{Season: 2, Part: 2}, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, tc.a.SameEntry(tc.b))
			// The relation is symmetric.
			assert.Equal(t, tc.want, tc.b.SameEntry(tc.a))
		})
	}
}

func TestMarkerForFoldsAnEntrysTitles(t *testing.T) {
	// The AniList native/romaji shape a queue-side binding gate holds: the
	// romaji drops the season marker the native title states.
	got := MarkerFor("無職転生Ⅲ ～異世界行ったら本気だす～",
		"Mushoku Tensei: Isekai Ittara Honki Dasu")
	assert.Equal(t, Marker{Season: 3}, got)

	// Season and part can arrive from different titles of the same entry.
	got = MarkerFor("無職転生Ⅱ ～異世界行ったら本気だす～",
		"Mushoku Tensei: Isekai Ittara Honki Dasu Part 2")
	assert.Equal(t, Marker{Season: 2, Part: 2}, got)

	assert.Equal(t, Marker{}, MarkerFor())
	assert.Equal(t, Marker{}, MarkerFor("", ""))
}

func TestSeasonsAgree(t *testing.T) {
	tests := []struct {
		name string
		a, b string
		want bool
	}{
		{"same season across scripts",
			"无职转生 第三季 ～到了异世界就拿出真本事～",
			"Mushoku Tensei III: Isekai Ittara Honki Dasu", true},
		{"season three is not season two",
			"無職転生Ⅲ ～異世界行ったら本気だす～",
			"無職転生Ⅱ ～異世界行ったら本気だす～", false},
		{"unstated reads as season one",
			"無職転生 ～異世界行ったら本気だす～",
			"無職転生 第1期 ～異世界行ったら本気だす～", true},
		{"cour split is not a new season",
			"無職転生Ⅱ ～異世界行ったら本気だす～",
			"無職転生Ⅱ ～異世界行ったら本気だす～ 第2クール", false},
		{"a different show with no marker still agrees on season",
			"紫罗兰永恒花园", "無職転生 ～異世界行ったら本気だす～", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, SeasonsAgree(tc.a, tc.b))
		})
	}
}

// TestSeasonAndSimilarityAreIndependentSignals pins the invariant the whole
// package exists for: similarity alone cannot separate two seasons of one
// franchise, so the marker has to be asked as a second, separate question.
// If this test ever fails because similarity dropped below the floor, the
// gate did not get safer — a normaliser changed underneath it.
func TestSeasonAndSimilarityAreIndependentSignals(t *testing.T) {
	s2 := "無職転生Ⅱ ～異世界行ったら本気だす～"
	s3 := "無職転生Ⅲ ～異世界行ったら本気だす～"

	assert.GreaterOrEqual(t, Similarity(s2, s3), SimilarityFloor,
		"season-blind similarity cannot tell two seasons apart — that is why the marker gate exists")
	assert.False(t, SeasonsAgree(s2, s3),
		"the marker gate must reject what similarity cannot")
}

// ─── Similarity ────────────────────────────────────────────────────────────

func TestSimilarityFloorValue(t *testing.T) {
	// Pinned: lowering it lets unrelated shows through the siteAnime gate,
	// raising it drops legitimate cross-script matches.
	assert.Equal(t, 0.45, SimilarityFloor)
}

func TestSimilarityIsSeasonBlindAndSymmetric(t *testing.T) {
	a := "無職転生Ⅲ ～異世界行ったら本気だす～"
	b := "無職転生 ～異世界行ったら本気だす～"

	assert.Equal(t, Similarity(a, b), Similarity(b, a), "Dice is symmetric")
	assert.Equal(t, 1.0, Similarity(a, a))
	// Season-blind by construction: the marker is stripped before scoring,
	// so a season 3 title scores against its own season 1 far above the
	// floor.  This is the signal that cannot separate seasons.
	assert.GreaterOrEqual(t, Similarity(a, b), SimilarityFloor)
	assert.Less(t, Similarity(a, "紫罗兰永恒花园"), SimilarityFloor)
}

func TestBestSimilarityTakesTheMaxOverCandidates(t *testing.T) {
	titles := []string{
		"无职转生～到了异世界就拿出真本事～",
		"無職転生 ～異世界行ったら本気だす～",
		"Mushoku Tensei: Isekai Ittara Honki Dasu",
	}

	// A romaji query must not be dragged down by the CJK titles it cannot
	// possibly overlap — that is why this is a max, not an average.
	romaji := BestSimilarity("Mushoku Tensei: Isekai Ittara Honki Dasu", titles...)
	assert.Equal(t, 1.0, romaji)

	assert.Equal(t, 0.0, BestSimilarity("紫罗兰永恒花园"))
	assert.Less(t, BestSimilarity("紫罗兰永恒花园", titles...), SimilarityFloor)
}

// ─── MatchesQuery ──────────────────────────────────────────────────────────

func TestMatchesQuery(t *testing.T) {
	mushoku := []string{
		"无职转生～到了异世界就拿出真本事～",
		"無職転生 ～異世界行ったら本気だす～",
		"Mushoku Tensei: Isekai Ittara Honki Dasu",
	}

	t.Run("full title clears the similarity floor", func(t *testing.T) {
		ok, sim := MatchesQuery("无职转生～到了异世界就拿出真本事～", mushoku...)
		assert.True(t, ok)
		assert.GreaterOrEqual(t, sim, SimilarityFloor)
	})

	t.Run("bare franchise keyword passes on containment", func(t *testing.T) {
		// Sørensen-Dice punishes the length mismatch hard, so this scores
		// below the floor and can only pass via containment — the shape a
		// folder name actually produces.
		ok, sim := MatchesQuery("无职转生", mushoku...)
		assert.True(t, ok)
		assert.Less(t, sim, SimilarityFloor,
			"if this now clears the floor the containment branch is untested")
	})

	t.Run("unrelated show fails both ways", func(t *testing.T) {
		ok, sim := MatchesQuery("紫罗兰永恒花园", mushoku...)
		assert.False(t, ok)
		assert.Less(t, sim, SimilarityFloor)
	})

	t.Run("no candidates", func(t *testing.T) {
		ok, sim := MatchesQuery("无职转生")
		assert.False(t, ok)
		assert.Equal(t, 0.0, sim)
	})

	t.Run("does not gate on season itself", func(t *testing.T) {
		// MatchesQuery answers "same show?", never "same season?".  Callers
		// run the marker gate separately; collapsing the two here is the
		// regression this package is shaped to prevent.
		ok, _ := MatchesQuery("无职转生Ⅲ ～到了异世界就拿出真本事～", mushoku...)
		require.True(t, ok, "a season 3 query still names the same show")
		assert.False(t, SeasonsAgree("无职转生Ⅲ ～到了异世界就拿出真本事～", mushoku[0]),
			"the season gate is what rejects it, and it is a separate call")
	})
}

// ─── LooseNormalize / LooselyMatchesKeyword ────────────────────────────────

func TestLooseNormalizeKeepsSeasonMarkers(t *testing.T) {
	// The whole reason containment is safe: unlike the similarity
	// normaliser, this one leaves the season marker in the string, so two
	// seasons of one franchise never collapse to the same value.
	s2 := LooseNormalize("無職転生Ⅱ ～異世界行ったら本気だす～")
	s3 := LooseNormalize("無職転生Ⅲ ～異世界行ったら本気だす～")
	assert.NotEqual(t, s2, s3)
	assert.NotContains(t, s2, s3)
	assert.NotContains(t, s3, s2)

	assert.Equal(t, "", LooseNormalize(""))
	assert.Equal(t, "abc", LooseNormalize("[A] B.c!"))
}

func TestLooselyMatchesKeyword(t *testing.T) {
	tests := []struct {
		name           string
		title, keyword string
		want           bool
	}{
		{"keyword contained in title", "无职转生～到了异世界就拿出真本事～", "无职转生", true},
		{"title contained in keyword", "无职转生", "无职转生～到了异世界就拿出真本事～", true},
		{"punctuation and case are ignored", "[Sub] Violet Evergarden!", "violet evergarden", true},
		{"unrelated", "紫罗兰永恒花园", "无职转生", false},
		{"empty title", "", "无职转生", false},
		{"empty keyword", "无职转生", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, LooselyMatchesKeyword(tc.title, tc.keyword))
		})
	}
}

func TestLooselyMatchesKeywordCannotSmuggleAWrongSeason(t *testing.T) {
	// Containment is an escape hatch for length mismatch, not for season
	// mismatch: the markers survive normalisation, so neither string
	// contains the other.
	assert.False(t, LooselyMatchesKeyword(
		"無職転生Ⅱ ～異世界行ったら本気だす～",
		"無職転生Ⅲ ～異世界行ったら本気だす～"))
}
