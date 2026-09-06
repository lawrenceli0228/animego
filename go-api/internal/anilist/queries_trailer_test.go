package anilist

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestTrailerSelectionMatchesTheQueries is the link between the type and the
// fact it claims.
//
// TrailerSelected is passed by hand at each upsert call site, and it asserts
// something about a GraphQL document the compiler never reads.  Delete the
// `trailer { id site }` line from SeasonalAnimeQuery for payload reasons and
// every warm cycle would then write "asked, no trailer" over the whole
// catalogue — authoritatively, with no compile error and no other test
// failing.  This is the test that fails instead.
//
// Keep this table in step with the call sites:
//
//	SeasonalAnimeQuery  → anime/seasonal.coldStart, queue/warm_season
//	AnimeDetailQuery    → anime/detail.upsertFromMedia, anime/ensure_cached
//	SearchAnimeQuery    → anime/search  (TrailerNotSelected)
func TestTrailerSelectionMatchesTheQueries(t *testing.T) {
	const selector = "trailer { id site }"

	for _, tc := range []struct {
		name     string
		query    string
		selected bool
	}{
		{"SeasonalAnimeQuery", SeasonalAnimeQuery, true},
		{"AnimeDetailQuery", AnimeDetailQuery, true},
		{"SearchAnimeQuery", SearchAnimeQuery, false},
		{"WeeklyScheduleQuery", WeeklyScheduleQuery, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := strings.Contains(tc.query, selector)
			if tc.selected {
				assert.True(t, got,
					"%s is used with anilist.TrailerSelected, so it must select the field",
					tc.name)
				return
			}
			assert.False(t, got,
				"%s selects trailer now; its call sites still pass TrailerNotSelected and would discard the answer",
				tc.name)
		})
	}
}
