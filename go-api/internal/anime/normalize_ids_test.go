package anime

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
)

// TestCharactersFromMedia_CarriesIDs — the node ids AnimeDetailQuery has
// always selected reach the row (0037).  A zero id, which is what a node
// with no id decodes to, becomes NULL rather than a value the column
// CHECK refuses.
func TestCharactersFromMedia_CarriesIDs(t *testing.T) {
	got := CharactersFromMedia(anilist.Media{
		Characters: &anilist.CharacterConnection{Edges: []anilist.CharacterEdge{
			{
				Role: sptr("MAIN"),
				Node: anilist.CharacterNode{ID: 138100, Name: &anilist.PersonName{Full: sptr("Frieren")}},
				VoiceActors: []anilist.VoiceActor{
					{ID: 112215, Name: &anilist.PersonName{Full: sptr("Atsumi Tanezaki")}},
					{ID: 999, Name: &anilist.PersonName{Full: sptr("someone else")}},
				},
			},
			{
				Role: sptr("SUPPORTING"),
				Node: anilist.CharacterNode{Name: &anilist.PersonName{Full: sptr("no id decoded")}},
			},
		}},
	})
	require.Len(t, got, 2)

	require.NotNil(t, got[0].CharacterID)
	assert.Equal(t, int32(138100), *got[0].CharacterID)
	require.NotNil(t, got[0].VoiceActorID)
	assert.Equal(t, int32(112215), *got[0].VoiceActorID, "the first voice actor, matching the name and image columns")

	assert.Nil(t, got[1].CharacterID, "a zero id is NULL, not 0")
	assert.Nil(t, got[1].VoiceActorID, "no voice actors, no id")
}

func TestStaffFromMedia_CarriesIDs(t *testing.T) {
	got := StaffFromMedia(anilist.Media{
		Staff: &anilist.StaffConnection{Edges: []anilist.StaffEdge{
			{Role: sptr("Director"), Node: anilist.StaffNode{ID: 95000, Name: &anilist.PersonName{Full: sptr("Keiichirou Saitou")}}},
			{Role: sptr("Original Creator"), Node: anilist.StaffNode{Name: &anilist.PersonName{Full: sptr("no id")}}},
		}},
	})
	require.Len(t, got, 2)
	require.NotNil(t, got[0].StaffID)
	assert.Equal(t, int32(95000), *got[0].StaffID)
	assert.Nil(t, got[1].StaffID)
}
