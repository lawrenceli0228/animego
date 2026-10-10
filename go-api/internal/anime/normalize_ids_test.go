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
	ja := sptr("Japanese")
	got := CharactersFromMedia(anilist.Media{
		Characters: &anilist.CharacterConnection{Edges: []anilist.CharacterEdge{
			{
				Role: sptr("MAIN"),
				Node: anilist.CharacterNode{ID: 138100, Name: &anilist.PersonName{Full: sptr("Frieren")}},
				VoiceActorRoles: []anilist.VoiceActorRole{
					{VoiceActor: &anilist.VoiceActor{ID: 112215, Name: &anilist.PersonName{Full: sptr("Atsumi Tanezaki")}, LanguageV2: ja}},
					{VoiceActor: &anilist.VoiceActor{ID: 999, Name: &anilist.PersonName{Full: sptr("someone else")}, LanguageV2: ja}},
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
	assert.Equal(t, int32(112215), *got[0].VoiceActorID, "the primary voice actor, matching the name and image columns")

	assert.Nil(t, got[1].CharacterID, "a zero id is NULL, not 0")
	assert.Nil(t, got[1].VoiceActorID, "no voice actors, no id")
}

// TestCastFromMedia_TheJapaneseVoiceWhateverTheCountry — the title's
// country of origin has no say in the voices.  A Chinese production
// whose lead AniList lists with the Chinese cast first carries the
// Japanese voice, and only that one reaches the voice rows; a Korean
// production with no Japanese dub has no voice at all.
func TestCastFromMedia_TheJapaneseVoiceWhateverTheCountry(t *testing.T) {
	cast := CastFromMedia(anilist.Media{
		CountryOfOrigin: sptr("CN"),
		Characters: &anilist.CharacterConnection{Edges: []anilist.CharacterEdge{{
			Role: sptr("MAIN"),
			Node: anilist.CharacterNode{ID: 1, Name: &anilist.PersonName{Full: sptr("Wei Wuxian")}},
			VoiceActorRoles: []anilist.VoiceActorRole{
				{VoiceActor: &anilist.VoiceActor{ID: 11, Name: &anilist.PersonName{Native: sptr("阿杰")}, LanguageV2: sptr("Chinese")}},
				{VoiceActor: &anilist.VoiceActor{ID: 10, Name: &anilist.PersonName{Native: sptr("木村良平")}, LanguageV2: sptr("Japanese")}},
			},
		}}},
	})
	require.Len(t, cast.Characters, 1)
	require.NotNil(t, cast.Characters[0].VoiceActorID)
	assert.Equal(t, int32(10), *cast.Characters[0].VoiceActorID, "the Japanese voice, though the Chinese one is listed first")
	assert.Equal(t, "木村良平", *cast.Characters[0].VoiceActorJa)
	require.Len(t, cast.Voices, 1)
	assert.Equal(t, int32(10), cast.Voices[0].StaffID)

	korean := CastFromMedia(anilist.Media{
		CountryOfOrigin: sptr("KR"),
		Characters: &anilist.CharacterConnection{Edges: []anilist.CharacterEdge{{
			Role: sptr("MAIN"),
			Node: anilist.CharacterNode{ID: 2, Name: &anilist.PersonName{Full: sptr("Sung Jinwoo")}},
			VoiceActorRoles: []anilist.VoiceActorRole{
				{VoiceActor: &anilist.VoiceActor{ID: 20, Name: &anilist.PersonName{Native: sptr("한국성우")}, LanguageV2: sptr("Korean")}},
			},
		}}},
	})
	require.Len(t, korean.Characters, 1)
	assert.Nil(t, korean.Characters[0].VoiceActorID)
	assert.Nil(t, korean.Characters[0].VoiceActorJa)
	assert.Empty(t, korean.Voices)

	assert.Empty(t, CastFromMedia(anilist.Media{}).Characters, "no connection, no rows")
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
