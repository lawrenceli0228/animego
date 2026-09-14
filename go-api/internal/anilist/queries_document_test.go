package anilist

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestDocumentSelectionsMatchTheQueries is the link between the type and
// the facts it claims.
//
// A Document constant is passed by hand at each upsert call site, and it
// asserts something about a GraphQL document the compiler never reads.
// Delete the `trailer { id site }` line from SeasonalAnimeQuery for payload
// reasons and every warm cycle would then write "asked, no trailer" over
// the whole catalogue — authoritatively, with no compile error and no other
// test failing.  Drop the child connections from AnimeDetailQuery and every
// detail fetch would stamp the row as "children fetched" while writing
// none.  This is the test that fails instead.
//
// Keep this table in step with the call sites:
//
//	SeasonalAnimeQuery  → anime/seasonal.coldStart, queue/warm_season  (SeasonalDocument)
//	AnimeDetailQuery    → anime/detail.upsertFromMedia, anime/ensure_cached (DetailDocument)
//	SearchAnimeQuery    → anime/search  (SearchDocument)
func TestDocumentSelectionsMatchTheQueries(t *testing.T) {
	const trailerSelector = "trailer { id site }"
	// One selector per child connection the detail path persists.  All of
	// them must be present for DetailDocument to be honest.
	childSelectors := []string{"studios(", "relations {", "characters(", "staff(", "recommendations("}

	for _, tc := range []struct {
		name  string
		query string
		doc   Document
	}{
		{"SeasonalAnimeQuery", SeasonalAnimeQuery, SeasonalDocument},
		{"AnimeDetailQuery", AnimeDetailQuery, DetailDocument},
		{"SearchAnimeQuery", SearchAnimeQuery, SearchDocument},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gotTrailer := strings.Contains(tc.query, trailerSelector)
			if tc.doc.SelectsTrailer() {
				assert.True(t, gotTrailer,
					"%s is used as a Document that SelectsTrailer, so it must select the field", tc.name)
			} else {
				assert.False(t, gotTrailer,
					"%s selects trailer now; its call sites still pass a Document that does not SelectsTrailer and would discard the answer", tc.name)
			}

			gotChildren := true
			for _, sel := range childSelectors {
				if !strings.Contains(tc.query, sel) {
					gotChildren = false
				}
			}
			if tc.doc.SelectsChildren() {
				assert.True(t, gotChildren,
					"%s is used as a Document that SelectsChildren, so it must select every child connection", tc.name)
			} else {
				assert.False(t, gotChildren,
					"%s selects every child connection now; its call sites still pass a Document that does not SelectsChildren", tc.name)
			}
		})
	}

	// WeeklyScheduleQuery never reaches an upsert; it is here so a future
	// change that starts persisting schedule rows has to pick a Document.
	assert.False(t, strings.Contains(WeeklyScheduleQuery, trailerSelector))
}
