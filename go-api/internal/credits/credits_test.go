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

func TestPrimaryLanguage(t *testing.T) {
	for _, tc := range []struct {
		country *string
		want    string
	}{
		{sptr("CN"), LanguageChinese},
		{sptr("TW"), LanguageChinese},
		{sptr("cn"), LanguageChinese},
		{sptr(" KR "), LanguageKorean},
		{sptr("JP"), LanguageJapanese},
		{sptr("HK"), LanguageJapanese},
		{sptr(""), LanguageJapanese},
		{nil, LanguageJapanese},
	} {
		assert.Equal(t, tc.want, PrimaryLanguage(tc.country), "%v", tc.country)
	}
}

// TestCastFromEdges_PrimaryVoice — which voice lands in the voice_actor_*
// columns, by the title's country of origin and the role notes.
func TestCastFromEdges_PrimaryVoice(t *testing.T) {
	for _, tc := range []struct {
		name    string
		country *string
		roles   []anilist.VoiceActorRole
		want    int // voice actor id, 0 for none
	}{
		{"japanese title: the Japanese voice even when a dub is listed first", sptr("JP"),
			[]anilist.VoiceActorRole{voice(1, "Jordan", "English", ""), voice(2, "Kobayashi", "Japanese", "")}, 2},
		{"the main voice over the childhood voice", sptr("JP"),
			[]anilist.VoiceActorRole{voice(3, "Kiyoto", "Japanese", "Childhood"), voice(2, "Kobayashi", "Japanese", "")}, 2},
		{"chinese title: the Chinese voice", sptr("CN"),
			[]anilist.VoiceActorRole{voice(4, "Kimura", "Japanese", ""), voice(5, "Ajie", "Chinese", ""), voice(6, "Sim", "Korean", "")}, 5},
		{"taiwanese title: the Chinese voice", sptr("TW"),
			[]anilist.VoiceActorRole{voice(4, "Kimura", "Japanese", ""), voice(5, "Ajie", "chinese", "")}, 5},
		{"korean title: the Korean voice", sptr("KR"),
			[]anilist.VoiceActorRole{voice(4, "Kimura", "Japanese", ""), voice(6, "Sim", "Korean", "")}, 6},
		{"chinese title with only a Japanese cast falls back to Japanese", sptr("CN"),
			[]anilist.VoiceActorRole{voice(7, "Smith", "English", ""), voice(4, "Kimura", "Japanese", "")}, 4},
		{"no Japanese either: any language, main voice first", sptr("CN"),
			[]anilist.VoiceActorRole{voice(8, "Young Smith", "English", "Young"), voice(7, "Smith", "English", "")}, 7},
		{"every voice in the language has notes: the first of them", sptr("JP"),
			[]anilist.VoiceActorRole{voice(9, "Old", "Japanese", "Old"), voice(3, "Kiyoto", "Japanese", "Childhood")}, 9},
		{"blank notes count as none", sptr("JP"),
			[]anilist.VoiceActorRole{voice(3, "Kiyoto", "Japanese", "Childhood"), voice(10, "Blank", "Japanese", "   ")}, 10},
		{"unusable roles are skipped", nil,
			[]anilist.VoiceActorRole{{VoiceActor: nil}, {VoiceActor: &anilist.VoiceActor{ID: 0}}, voice(2, "Kobayashi", "Japanese", "")}, 2},
		{"no voice at all", sptr("JP"), nil, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cast := CastFromEdges([]anilist.CharacterEdge{character(100, "Stark", tc.roles...)}, tc.country)
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
// Stark (Frieren): thirteen roles in ten languages, plus a Chinese dub
// listed after all of them.  The title's language comes first (main
// voice, then the childhood voice), then Chinese, then Korean; the other
// dubs are dropped, and what is left is cut at eight.
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
	cast := CastFromEdges([]anilist.CharacterEdge{stark}, sptr("JP"))

	// Japanese first, then the Chinese dub AniList listed last, then
	// Korean; the European and South-East Asian dubs are not kept at all,
	// so they can no longer push the Chinese voice past the cap.
	assert.Equal(t, []int32{1, 8, 14, 12, 13}, voiceIDs(cast, 100))
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

	// A donghua: Chinese voices first, Japanese next, Korean after; the
	// English dub is dropped.
	wei := character(200, "Wei Wuxian",
		voice(21, "Kimura", "Japanese", ""),
		voice(22, "Ajie", "Chinese", ""),
		voice(23, "Smith", "English", ""),
		voice(24, "Young Ajie", "Chinese", "Childhood"),
		voice(25, "Sim", "Korean", ""),
	)
	cast = CastFromEdges([]anilist.CharacterEdge{wei}, sptr("CN"))
	assert.Equal(t, []int32{22, 24, 21, 25}, voiceIDs(cast, 200))
	c := cast.Characters[0]
	assert.Equal(t, "Ajie", *c.VoiceActorEn)
	assert.Equal(t, "Ajie (native)", *c.VoiceActorJa, "the native-script name, whatever the language")

	// The cap still applies once only kept languages remain.
	many := make([]anilist.VoiceActorRole, 0, 10)
	for i := 1; i <= 10; i++ {
		many = append(many, voice(300+i, fmt.Sprintf("Cast %d", i), "Japanese", "Young"))
	}
	cast = CastFromEdges([]anilist.CharacterEdge{character(300, "Crowd", many...)}, sptr("JP"))
	require.Len(t, cast.Voices, MaxVoicesPerCharacter)

	// A character whose only voice is in another language keeps it as the
	// primary, as before; it is the extra dubs that are dropped.
	solo := character(400, "Solo", voice(41, "Only", "English", ""))
	cast = CastFromEdges([]anilist.CharacterEdge{solo}, sptr("JP"))
	assert.Equal(t, []int32{41}, voiceIDs(cast, 400))
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
	}, sptr("JP"))

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
	}, nil)
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
	cast := CastFromEdges([]anilist.CharacterEdge{edge}, nil)
	assert.Equal(t, "L", *cast.Characters[0].ImageUrl)

	edge.Node.Image = &anilist.Image{Large: sptr("L"), Medium: sptr("M")}
	cast = CastFromEdges([]anilist.CharacterEdge{edge}, nil)
	assert.Equal(t, "M", *cast.Characters[0].ImageUrl)

	edge.Node.Image = nil
	cast = CastFromEdges([]anilist.CharacterEdge{edge}, nil)
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
