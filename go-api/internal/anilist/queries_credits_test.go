package anilist

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// connectionBlocks returns the body of every `field(...) { ... }` in a
// document, matched brace for brace, so an assertion can be made about
// one connection page rather than about the document as a whole.
func connectionBlocks(t *testing.T, doc, field string) []string {
	t.Helper()
	var out []string
	rest := doc
	for {
		at := strings.Index(rest, field+"(")
		if at < 0 {
			return out
		}
		open := strings.Index(rest[at:], "{")
		require.GreaterOrEqual(t, open, 0, "%s( with no selection", field)
		start := at + open
		depth := 0
		end := -1
		for i := start; i < len(rest); i++ {
			switch rest[i] {
			case '{':
				depth++
			case '}':
				depth--
			}
			if depth == 0 {
				end = i
				break
			}
		}
		require.GreaterOrEqual(t, end, 0, "unbalanced braces after %s(", field)
		out = append(out, rest[at:end+1])
		rest = rest[end+1:]
	}
}

// characterDocuments is every document that writes character rows.
func characterDocuments(t *testing.T) map[string]string {
	t.Helper()
	first, err := CharacterPagesQuery(1, MaxCreditPagesPerRequest)
	require.NoError(t, err)
	second, err := CharacterPagesQuery(MaxCreditPagesPerRequest+1, 2*MaxCreditPagesPerRequest)
	require.NoError(t, err)
	return map[string]string{
		"AnimeDetailQuery":          AnimeDetailQuery,
		"CharacterPagesQuery(1-8)":  first,
		"CharacterPagesQuery(9-16)": second,
	}
}

// TestCreditDocuments_SelectNodeIDBeforeVoiceRoles pins the AniList quirk
// that makes this whole feature fragile: an edge whose `node { id }` is
// not selected answers voiceActorRoles (and voiceActors) with an empty
// list and no error.  Drop the id from any characters page and every
// voice actor of every title that page covers silently disappears on the
// next write -- nothing else fails.  So every characters(...) page in
// every document must select the node id, ahead of the voice roles.
func TestCreditDocuments_SelectNodeIDBeforeVoiceRoles(t *testing.T) {
	for name, doc := range characterDocuments(t) {
		blocks := connectionBlocks(t, doc, "characters")
		require.NotEmpty(t, blocks, "%s selects no characters page", name)
		for i, b := range blocks {
			node := strings.Index(b, "node { id")
			roles := strings.Index(b, "voiceActorRoles(")
			require.GreaterOrEqual(t, node, 0, "%s page %d: characters edges must select node { id }", name, i+1)
			require.GreaterOrEqual(t, roles, 0, "%s page %d: characters edges must select voiceActorRoles", name, i+1)
			assert.Less(t, node, roles, "%s page %d: node { id } belongs to the same edge as the voice roles", name, i+1)
		}
	}
}

// TestCreditDocuments_VoiceRolesAreEveryLanguage — the StaffLanguage enum
// has no Chinese, so any language argument at all puts a donghua's cast
// out of reach.  The roles are asked for unfiltered, with the language
// label, the role notes that tell a childhood voice from the main one,
// and both image sizes.
func TestCreditDocuments_VoiceRolesAreEveryLanguage(t *testing.T) {
	const roles = "voiceActorRoles(sort: [RELEVANCE, ID]) { roleNotes dubGroup voiceActor { id name { full native } image { large medium } languageV2 } }"
	for name, doc := range characterDocuments(t) {
		assert.Contains(t, doc, roles, name)
		assert.NotContains(t, doc, "language:", "%s: a language argument filters out every cast the enum cannot name", name)
		assert.NotContains(t, doc, "voiceActors(", "%s: the old field cannot say which voice is the main one", name)
	}
}

// TestCreditDocuments_SortOrdersAreTotal — pages are only stitchable when
// the order is total: [ROLE, RELEVANCE, ID] for characters (the order
// AniList's site shows) and [RELEVANCE, ID] for staff.  Every page of
// every document must use the same one, and the page size must be the
// CreditsPerPage the sweep's arithmetic assumes.
func TestCreditDocuments_SortOrdersAreTotal(t *testing.T) {
	perPage := fmt.Sprintf("perPage: %d)", CreditsPerPage)

	for name, doc := range characterDocuments(t) {
		for i, b := range connectionBlocks(t, doc, "characters") {
			assert.Contains(t, b, "characters(sort: [ROLE, RELEVANCE, ID], page: ", "%s page %d", name, i+1)
			assert.Contains(t, b, perPage, "%s page %d", name, i+1)
			assert.Contains(t, b, "pageInfo { hasNextPage }", "%s page %d", name, i+1)
		}
	}

	staffFirst, err := StaffPagesQuery(1, MaxCreditPagesPerRequest)
	require.NoError(t, err)
	for name, doc := range map[string]string{"AnimeDetailQuery": AnimeDetailQuery, "StaffPagesQuery(1-8)": staffFirst} {
		blocks := connectionBlocks(t, doc, "staff")
		require.NotEmpty(t, blocks, name)
		for i, b := range blocks {
			assert.Contains(t, b, "staff(sort: [RELEVANCE, ID], page: ", "%s page %d", name, i+1)
			assert.Contains(t, b, perPage, "%s page %d", name, i+1)
			assert.Contains(t, b, "pageInfo { hasNextPage }", "%s page %d", name, i+1)
			assert.Contains(t, b, "node { id", "%s page %d", name, i+1)
		}
	}
}

// TestCharacterPagesQuery_AliasesEachPage — one alias per page, named by
// the page it fetches, on a single Media, with countryOfOrigin beside
// them (it picks the primary voice).
func TestCharacterPagesQuery_AliasesEachPage(t *testing.T) {
	doc, err := CharacterPagesQuery(1, 8)
	require.NoError(t, err)
	assert.Equal(t, 1, strings.Count(doc, "Media(id: $id, type: ANIME)"), "all pages ride one Media")
	assert.Contains(t, doc, "countryOfOrigin")
	assert.Len(t, connectionBlocks(t, doc, "characters"), 8)
	for page := 1; page <= 8; page++ {
		assert.Contains(t, doc, fmt.Sprintf("p%d: characters(sort: [ROLE, RELEVANCE, ID], page: %d, perPage: 25)", page, page))
	}
	assert.NotContains(t, doc, "p9:")
	assert.NotContains(t, doc, "p0:")

	doc, err = CharacterPagesQuery(9, 16)
	require.NoError(t, err)
	assert.Len(t, connectionBlocks(t, doc, "characters"), 8)
	for page := 9; page <= 16; page++ {
		assert.Contains(t, doc, fmt.Sprintf("p%d: characters(sort: [ROLE, RELEVANCE, ID], page: %d, perPage: 25)", page, page))
	}
	assert.NotContains(t, doc, "p1:", "the second request is numbered by page, not by position")
	assert.NotContains(t, doc, "p8:")
}

// TestStaffPagesQuery_AliasesEachPage is the staff twin.
func TestStaffPagesQuery_AliasesEachPage(t *testing.T) {
	doc, err := StaffPagesQuery(9, 12)
	require.NoError(t, err)
	assert.Len(t, connectionBlocks(t, doc, "staff"), 4)
	for page := 9; page <= 12; page++ {
		assert.Contains(t, doc, fmt.Sprintf("p%d: staff(sort: [RELEVANCE, ID], page: %d, perPage: 25)", page, page))
	}
	assert.NotContains(t, doc, "characters(")
	assert.NotContains(t, doc, "p13:")
}

// TestCreditPagesQuery_RejectsBadRanges — pages are 1-based, a range is
// never empty, and one request carries at most eight.
func TestCreditPagesQuery_RejectsBadRanges(t *testing.T) {
	for _, r := range [][2]int{{0, 1}, {2, 1}, {1, 9}, {9, 17}, {-3, -1}} {
		_, err := CharacterPagesQuery(r[0], r[1])
		assert.ErrorIs(t, err, ErrCreditPageRange, "characters %v", r)
		_, err = StaffPagesQuery(r[0], r[1])
		assert.ErrorIs(t, err, ErrCreditPageRange, "staff %v", r)
	}
	for _, r := range [][2]int{{1, 1}, {1, 8}, {9, 16}, {16, 16}} {
		_, err := CharacterPagesQuery(r[0], r[1])
		assert.NoError(t, err, "characters %v", r)
	}
}
