package credits

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
)

func sptr(s string) *string { return &s }

// voice builds one voice role.  notes "" means none.
func voice(id int, full, lang, notes string) anilist.VoiceActorRole {
	r := anilist.VoiceActorRole{VoiceActor: &anilist.VoiceActor{
		ID:         id,
		Name:       &anilist.PersonName{Full: sptr(full), Native: sptr(full + " (native)")},
		Image:      &anilist.Image{Medium: sptr("https://img/" + full)},
		LanguageV2: sptr(lang),
	}}
	if notes != "" {
		r.RoleNotes = sptr(notes)
	}
	return r
}

// character builds one character edge.
func character(id int, name string, roles ...anilist.VoiceActorRole) anilist.CharacterEdge {
	return anilist.CharacterEdge{
		Role:            sptr("MAIN"),
		Node:            anilist.CharacterNode{ID: id, Name: &anilist.PersonName{Full: sptr(name)}},
		VoiceActorRoles: roles,
	}
}

func voiceIDs(cast Cast, characterID int32) []int32 {
	var out []int32
	for _, v := range cast.Voices {
		if v.CharacterID == characterID {
			out = append(out, v.StaffID)
		}
	}
	return out
}

// TestCastFromEdges_PrimaryVoice — which voice lands in the voice_actor_*
// columns: the first Japanese main voice, else the first Japanese voice,
// else none.  No language but Japanese is ever a candidate, wherever
// AniList lists it.
func TestCastFromEdges_PrimaryVoice(t *testing.T) {
	for _, tc := range []struct {
		name  string
		roles []anilist.VoiceActorRole
		want  int // voice actor id, 0 for none
	}{
		{"the Japanese voice even when a dub is listed first",
			[]anilist.VoiceActorRole{voice(1, "Jordan", "English", ""), voice(2, "Kobayashi", "Japanese", "")}, 2},
		{"the main voice over the childhood voice",
			[]anilist.VoiceActorRole{voice(3, "Kiyoto", "Japanese", "Childhood"), voice(2, "Kobayashi", "Japanese", "")}, 2},
		{"a donghua's cast, Chinese first: the Japanese voice",
			[]anilist.VoiceActorRole{voice(5, "Ajie", "Chinese", ""), voice(4, "Kimura", "Japanese", ""), voice(6, "Sim", "Korean", "")}, 4},
		{"the label is read in any case",
			[]anilist.VoiceActorRole{voice(5, "Ajie", "Chinese", ""), voice(4, "Kimura", " japanese ", "")}, 4},
		{"a Japanese voice with notes beats a dub's main voice",
			[]anilist.VoiceActorRole{voice(6, "Sim", "Korean", ""), voice(3, "Kiyoto", "Japanese", "Childhood")}, 3},
		{"only dubs: no voice",
			[]anilist.VoiceActorRole{voice(7, "Smith", "English", ""), voice(5, "Ajie", "Chinese", ""), voice(6, "Sim", "Korean", "")}, 0},
		{"a voice with no language label is not taken for Japanese",
			[]anilist.VoiceActorRole{{VoiceActor: &anilist.VoiceActor{ID: 11, Name: &anilist.PersonName{Full: sptr("Unlabelled")}}}}, 0},
		{"every Japanese voice has notes: the first of them",
			[]anilist.VoiceActorRole{voice(9, "Old", "Japanese", "Old"), voice(3, "Kiyoto", "Japanese", "Childhood")}, 9},
		{"blank notes count as none",
			[]anilist.VoiceActorRole{voice(3, "Kiyoto", "Japanese", "Childhood"), voice(10, "Blank", "Japanese", "   ")}, 10},
		{"unusable roles are skipped",
			[]anilist.VoiceActorRole{{VoiceActor: nil}, {VoiceActor: &anilist.VoiceActor{ID: 0}}, voice(2, "Kobayashi", "Japanese", "")}, 2},
		{"no voice at all", nil, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cast := CastFromEdges([]anilist.CharacterEdge{character(100, "Stark", tc.roles...)})
			require.Len(t, cast.Characters, 1)
			c := cast.Characters[0]
			if tc.want == 0 {
				assert.Nil(t, c.VoiceActorID)
				assert.Nil(t, c.VoiceActorEn)
				assert.Empty(t, cast.Voices)
				return
			}
			require.NotNil(t, c.VoiceActorID)
			assert.Equal(t, int32(tc.want), *c.VoiceActorID)
			require.NotEmpty(t, cast.Voices)
			assert.Equal(t, int32(tc.want), cast.Voices[0].StaffID, "voice 0 is the character row's voice")
			assert.Equal(t, int32(0), cast.Voices[0].DisplayOrder)
		})
	}
}

// TestCastFromEdges_VoiceOrderAndCap — the shape measured on AniList for
// Stark (Frieren) when the roles are asked for in every language:
// thirteen roles in ten languages, plus a Chinese dub listed after all of
// them.  Only the two Japanese voices are kept, the main voice first and
// the childhood voice after it.
func TestCastFromEdges_VoiceOrderAndCap(t *testing.T) {
	stark := character(100, "Stark",
		voice(1, "Kobayashi", "Japanese", ""),
		voice(2, "Cruz", "English", ""),
		voice(3, "Miagusuku", "Portuguese", ""),
		voice(4, "Martinez", "Spanish", ""),
		voice(5, "Schachter", "German", ""),
		voice(6, "Blanc", "French", ""),
		voice(7, "Marteddu", "Italian", ""),
		voice(8, "Kiyoto", "Japanese", "Childhood"),
		voice(9, "Boonsittilers", "Thai", ""),
		voice(10, "Karbowski", "English", "Young"),
		voice(11, "Bayhaqi", "Indonesian", ""),
		voice(12, "Lee", "Korean", "Young"),
		voice(13, "Kim", "Korean", ""),
		voice(14, "Zhang", "Chinese", ""),
	)
	cast := CastFromEdges([]anilist.CharacterEdge{stark})

	assert.Equal(t, []int32{1, 8}, voiceIDs(cast, 100))
	for i, v := range cast.Voices {
		assert.Equal(t, int32(i), v.DisplayOrder)
	}
	child := cast.Voices[1]
	require.NotNil(t, child.RoleNotes)
	assert.Equal(t, "Childhood", *child.RoleNotes)
	assert.Equal(t, "Japanese", *child.Language)
	assert.Nil(t, cast.Voices[0].RoleNotes)
	assert.Equal(t, "Kobayashi", *cast.Voices[0].NameFull)
	assert.Equal(t, "Kobayashi (native)", *cast.Voices[0].NameNative)
	assert.Equal(t, "https://img/Kobayashi", *cast.Voices[0].ImageUrl)

	// The main voice moves ahead of a noted one AniList listed first; the
	// rest keep AniList's order.
	conan := character(150, "Kogorou",
		voice(51, "Koyama", "Japanese", "eps 553-"),
		voice(52, "Kamiya", "Japanese", ""),
		voice(53, "Yanada", "Japanese", "Young"),
	)
	cast = CastFromEdges([]anilist.CharacterEdge{conan})
	assert.Equal(t, []int32{52, 51, 53}, voiceIDs(cast, 150))
	assert.Equal(t, "eps 553-", *cast.Voices[1].RoleNotes)

	// The cap applies to Japanese voices alone.
	many := make([]anilist.VoiceActorRole, 0, 10)
	for i := 1; i <= 10; i++ {
		many = append(many, voice(300+i, fmt.Sprintf("Cast %d", i), "Japanese", "Young"))
	}
	cast = CastFromEdges([]anilist.CharacterEdge{character(300, "Crowd", many...)})
	require.Len(t, cast.Voices, MaxVoicesPerCharacter)
}

// TestCastFromEdges_StoresJapaneseVoicesOnly — the guard behind the
// document's language filter.  AniList answering every language anyway
// stores none of the dubs: not as voice rows, not on the character row,
// and not as a primary of last resort.  A character voiced only in other
// languages has no voice at all.
func TestCastFromEdges_StoresJapaneseVoicesOnly(t *testing.T) {
	cast := CastFromEdges([]anilist.CharacterEdge{
		// A donghua's lead as AniList lists it: the Chinese cast first.
		character(200, "Wei Wuxian",
			voice(22, "Ajie", "Chinese", ""),
			voice(23, "Smith", "English", ""),
			voice(21, "Kimura", "Japanese", ""),
			voice(24, "Young Ajie", "Chinese", "Childhood"),
			voice(25, "Sim", "Korean", ""),
		),
		// A Korean production with no Japanese dub.
		character(300, "Jinwoo", voice(31, "Taek", "Korean", ""), voice(32, "Reed", "English", "")),
		character(400, "Solo", voice(41, "Only", "English", "")),
	})

	require.Len(t, cast.Characters, 3)
	wei := cast.Characters[0]
	require.NotNil(t, wei.VoiceActorID)
	assert.Equal(t, int32(21), *wei.VoiceActorID)
	assert.Equal(t, "Kimura", *wei.VoiceActorEn)
	assert.Equal(t, "Kimura (native)", *wei.VoiceActorJa)
	assert.Equal(t, []int32{21}, voiceIDs(cast, 200))

	for _, c := range cast.Characters[1:] {
		assert.Nil(t, c.VoiceActorID, "%s", *c.NameEn)
		assert.Nil(t, c.VoiceActorEn)
		assert.Nil(t, c.VoiceActorJa)
		assert.Nil(t, c.VoiceActorImageUrl)
	}
	assert.Empty(t, voiceIDs(cast, 300))
	assert.Empty(t, voiceIDs(cast, 400))

	require.Len(t, cast.Voices, 1)
	for _, v := range cast.Voices {
		require.NotNil(t, v.Language)
		assert.Equal(t, LanguageJapanese, *v.Language)
	}
}

// TestCastFromEdges_Dedupes — a character listed twice is kept at its
// first position and the positions are renumbered; a person voicing one
// character twice is one voice row, the primary's.
func TestCastFromEdges_Dedupes(t *testing.T) {
	cast := CastFromEdges([]anilist.CharacterEdge{
		character(1, "A", voice(10, "X", "Japanese", "Childhood"), voice(10, "X", "Japanese", ""), voice(11, "Y", "Japanese", "")),
		character(2, "B"),
		character(1, "A again"),
		character(3, "C"),
	})

	require.Len(t, cast.Characters, 3)
	assert.Equal(t, "A", *cast.Characters[0].NameEn)
	assert.Equal(t, "C", *cast.Characters[2].NameEn)
	for i, c := range cast.Characters {
		assert.Equal(t, int32(i), c.DisplayOrder)
	}
	assert.Equal(t, []int32{10, 11}, voiceIDs(cast, 1))
	assert.Nil(t, cast.Voices[0].RoleNotes, "the kept entry for X is the main voice, not the childhood one")
}

// TestCastFromEdges_IDlessNode — a node without an id (the decode default
// 0) still becomes a row with its primary voice, but cannot key a voice
// row, and is never merged with another id-less node.
func TestCastFromEdges_IDlessNode(t *testing.T) {
	cast := CastFromEdges([]anilist.CharacterEdge{
		character(0, "nameless", voice(10, "X", "Japanese", "")),
		character(0, "nameless too"),
	})
	require.Len(t, cast.Characters, 2)
	assert.Nil(t, cast.Characters[0].CharacterID)
	require.NotNil(t, cast.Characters[0].VoiceActorID)
	assert.Equal(t, int32(10), *cast.Characters[0].VoiceActorID)
	assert.Empty(t, cast.Voices)
}

// TestCastFromEdges_Images — medium is what every credit row has stored;
// large is the fallback when AniList sent only that.
func TestCastFromEdges_Images(t *testing.T) {
	edge := character(1, "A")
	edge.Node.Image = &anilist.Image{Large: sptr("L"), Medium: sptr("")}
	cast := CastFromEdges([]anilist.CharacterEdge{edge})
	assert.Equal(t, "L", *cast.Characters[0].ImageUrl)

	edge.Node.Image = &anilist.Image{Large: sptr("L"), Medium: sptr("M")}
	cast = CastFromEdges([]anilist.CharacterEdge{edge})
	assert.Equal(t, "M", *cast.Characters[0].ImageUrl)

	edge.Node.Image = nil
	cast = CastFromEdges([]anilist.CharacterEdge{edge})
	assert.Nil(t, cast.Characters[0].ImageUrl)
}

// TestStaffFromEdges — a person appears once per role: a repeated (person,
// role) pair is dropped, the same person in another role is kept, an
// empty role is a role of its own, and positions are renumbered.
func TestStaffFromEdges(t *testing.T) {
	staffEdge := func(id int, role *string) anilist.StaffEdge {
		return anilist.StaffEdge{Role: role, Node: anilist.StaffNode{ID: id, Name: &anilist.PersonName{Full: sptr("P")}}}
	}
	got := StaffFromEdges([]anilist.StaffEdge{
		staffEdge(1, sptr("Director")),
		staffEdge(1, sptr("Storyboard (ep 1)")),
		staffEdge(1, sptr("Director")),
		staffEdge(2, nil),
		staffEdge(2, nil),
		staffEdge(2, sptr("")),
		staffEdge(0, sptr("Director")),
		staffEdge(0, sptr("Director")),
	})
	require.Len(t, got, 6)
	assert.Equal(t, "Storyboard (ep 1)", *got[1].Role)
	assert.Nil(t, got[2].Role)
	assert.Equal(t, "", *got[3].Role)
	assert.Nil(t, got[4].StaffID, "id-less edges are never merged")
	assert.Nil(t, got[5].StaffID)
	for i, s := range got {
		assert.Equal(t, int32(i), s.DisplayOrder)
	}
	assert.Empty(t, StaffFromEdges(nil))
}
