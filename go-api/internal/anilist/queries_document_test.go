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
	childSelectors := []string{"studios {", "relations {", "characters(", "staff(", "recommendations("}

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

// TestMediaFactsQuerySelectsExactlyTheFourFacts pins the sweep document
// to the four columns 0034 taught the upsert to write, and to nothing
// the sweep could overwrite across the catalogue by accident.  The
// selection is the contract: queue/anime_facts.go reads these four and
// only these four off the Media it gets back.
func TestMediaFactsQuerySelectsExactlyTheFourFacts(t *testing.T) {
	for _, sel := range []string{"id", "startDate { year month day }", "endDate   { year month day }", "duration", "source", "id_in: $ids"} {
		assert.Contains(t, MediaFactsQuery, sel)
	}
	for _, forbidden := range []string{"title", "coverImage", "description", "averageScore", "episodes", "status", "genres", "trailer", "studios", "characters"} {
		assert.NotContains(t, MediaFactsQuery, forbidden,
			"MediaFactsQuery must not select %q: the sweep would write it over every row with no second source to restore from", forbidden)
	}
}

// TestEveryUpsertingDocumentSelectsTheScalarBlock — the 0036 scalars are
// written by UpsertAnimeCache without a "did the document select this"
// flag, which is only honest if every document that reaches the upsert
// selects them.  Drop isAdult from SeasonalAnimeQuery and every warm
// cycle would write false over a row the detail path had marked adult;
// this is the test that fails instead.
func TestEveryUpsertingDocumentSelectsTheScalarBlock(t *testing.T) {
	block := []string{"popularity", "favourites", "idMal", "isAdult", "countryOfOrigin", "nextAiringEpisode { airingAt episode }"}
	for _, tc := range []struct {
		name  string
		query string
	}{
		{"SearchAnimeQuery", SearchAnimeQuery},
		{"SeasonalAnimeQuery", SeasonalAnimeQuery},
		{"AnimeDetailQuery", AnimeDetailQuery},
		{"MediaFactsQuery", MediaFactsQuery},
	} {
		for _, sel := range block {
			assert.Contains(t, tc.query, sel, "%s must select %q", tc.name, sel)
		}
	}
	// synonyms is a child table written only by the two documents that
	// select it; the listing documents leave the table alone.
	assert.Contains(t, AnimeDetailQuery, "synonyms")
	assert.Contains(t, MediaFactsQuery, "synonyms")
	assert.NotContains(t, SearchAnimeQuery, "synonyms")
	assert.NotContains(t, SeasonalAnimeQuery, "synonyms")
}

// TestDetailDocumentAsksForTheWholeFirstPage — 25 is AniList's cap on a
// nested connection page (pageInfo.perPage tops out there whatever is
// asked).  The port asked for 8 characters and 10 staff, and more than
// half the catalogue sat exactly at those caps; a person page needs
// the whole first page.  Both selections also carry the node id, which
// 0037 stores.
func TestDetailDocumentAsksForTheWholeFirstPage(t *testing.T) {
	assert.Contains(t, AnimeDetailQuery, "characters(sort: ROLE, page: 1, perPage: 25)")
	assert.Contains(t, AnimeDetailQuery, "staff(sort: RELEVANCE, page: 1, perPage: 25)")
	assert.Contains(t, AnimeDetailQuery, "voiceActors(language: JAPANESE) { id")
	assert.Contains(t, AnimeDetailQuery, "edges { role node { id name { full native } image { medium } }")
}

// TestTagsAndLinksAreSelectedWhereTheyAreWritten — the two lists 0038
// added are written by the detail path and the facts sweep, so both of
// their documents must select them; the listing documents write neither
// table and must not carry the payload.
func TestTagsAndLinksAreSelectedWhereTheyAreWritten(t *testing.T) {
	for _, sel := range []string{"tags { name rank isMediaSpoiler }", "externalLinks { site url type }"} {
		assert.Contains(t, AnimeDetailQuery, sel)
		assert.Contains(t, MediaFactsQuery, sel)
		assert.NotContains(t, SearchAnimeQuery, sel)
		assert.NotContains(t, SeasonalAnimeQuery, sel)
	}
	// Every studio, with its id and role -- not only the main ones.
	assert.Contains(t, AnimeDetailQuery, "studios { edges { isMain node { id name } } }")
	assert.NotContains(t, AnimeDetailQuery, "isMain: true")
}
