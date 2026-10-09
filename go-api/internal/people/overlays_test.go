package people

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
)

// The accepted edits, applied by the two builders: overlay, then Bangumi's
// Chinese name, then AniList, field by field.

func starkIdent() dbgen.GetCharacterIdentityRow {
	return dbgen.GetCharacterIdentityRow{
		HasProfile:      true,
		NameFull:        sp("Stark"),
		NameNative:      sp("シュタルク"),
		NameAlternative: []string{"Starky"},
		ImageLarge:      sp("https://s4.anilist.co/file/anilistcdn/character/large/b184313.jpg"),
		Description:     sp("A warrior."),
		Gender:          sp("Male"),
		BloodType:       sp("A"),
		NameCn:          sp("修塔尔克"),
		BgmID:           ip(89182),
	}
}

func TestBuildCharacter_OverlayWinsFieldByField(t *testing.T) {
	t.Parallel()
	self := overlay.Doc{
		NameCn:      overlay.Of("史塔克"),
		Aliases:     overlay.Of([]string{"休塔尔克", " ", "史塔克", "休塔尔克"}),
		Image:       overlay.Of("https://example.org/api/edit-images/new.jpg"),
		Description: overlay.Of("战士。"),
		Age:         overlay.Of("17"),
		BloodType:   overlay.Cleared[string](),
		Birth:       overlay.Of(overlay.Date{Month: ip(3), Day: ip(2)}),
		Roles:       map[string]string{"182255": "SUPPORTING"},
	}
	c, ok := buildCharacter(184313, starkIdent(), []dbgen.ListCharacterAppearancesRow{
		appearanceRow(frieren, "MAIN"), appearanceRow(frieren2, "MAIN"),
	}, nil, pageOverlays{self: self})
	require.True(t, ok)

	assert.Equal(t, "史塔克", *c.Name.Cn, "the edit wins over Bangumi's name")
	assert.Equal(t, "Stark", *c.Name.Full, "fields the edit leaves alone keep their ladder")
	assert.Equal(t, []string{"休塔尔克"}, c.AlternativeNames,
		"the edit's aliases replace AniList's, without blanks, repeats or the shown names")
	assert.Equal(t, "https://example.org/api/edit-images/new.jpg", *c.Image)
	require.NotNil(t, c.Profile)
	assert.Equal(t, "战士。", *c.Profile.Description)
	assert.Equal(t, "17", *c.Profile.Age)
	assert.Nil(t, c.Profile.BloodType, "a cleared fact is cleared")
	assert.Equal(t, "Male", *c.Profile.Gender)
	assert.Nil(t, c.Profile.Birth.Year)
	assert.Equal(t, int32(2), *c.Profile.Birth.Day)

	require.Len(t, c.Appearances, 2)
	assert.Equal(t, "MAIN", *c.Appearances[0].Role)
	assert.Equal(t, "SUPPORTING", *c.Appearances[1].Role, "a role is edited per title")
	assert.True(t, c.Indexable, "still a lead on the first title, with a Chinese name")
}

func TestBuildCharacter_OverlayDecidesIndexing(t *testing.T) {
	t.Parallel()
	ident := dbgen.GetCharacterIdentityRow{NameFull: sp("Nameless")}
	apps := []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "MAIN")}

	c, _ := buildCharacter(1, ident, apps, nil, pageOverlays{})
	assert.False(t, c.Indexable, "no Chinese name")

	c, _ = buildCharacter(1, ident, apps, nil, pageOverlays{self: overlay.Doc{NameCn: overlay.Of("无名")}})
	assert.True(t, c.Indexable, "an accepted Chinese name makes a lead indexable, as the sitemap reads it")

	c, _ = buildCharacter(1, ident, apps, nil, pageOverlays{self: overlay.Doc{
		NameCn: overlay.Of("无名"), Roles: map[string]string{"154587": "BACKGROUND"},
	}})
	assert.False(t, c.Indexable, "a lead no more")
}

func TestBuildCharacter_OverlayGivesAProfileToARowlessCharacter(t *testing.T) {
	t.Parallel()
	apps := []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "MAIN")}
	c, _ := buildCharacter(1, dbgen.GetCharacterIdentityRow{}, apps, nil, pageOverlays{})
	assert.Nil(t, c.Profile)

	c, _ = buildCharacter(1, dbgen.GetCharacterIdentityRow{}, apps, nil, pageOverlays{self: overlay.Doc{Gender: overlay.Of("Female")}})
	require.NotNil(t, c.Profile)
	assert.Equal(t, "Female", *c.Profile.Gender)
	assert.Nil(t, c.Profile.Description)
}

func TestBuildCharacter_VoiceEdits(t *testing.T) {
	t.Parallel()
	voices := []dbgen.ListCharacterVoicesRow{
		characterVoiceRow(frieren, 133507, 0, "Japanese", nil, "Chiaki Kobayashi"),
		characterVoiceRow(frieren, 115100, 1, "Japanese", sp("Childhood"), "Arisa Kiyoto"),
		characterVoiceRow(frieren, 391018, 2, "Korean", nil, "Sin-U Kim"),
	}
	self := overlay.Doc{Voices: []overlay.VoiceOp{
		// The main voice's line rewritten, the childhood voice given to
		// someone else, the Korean voice removed, and a Chinese voice added.
		{Key: "133507|Japanese|", PersonID: 133507, Line: sp("日配 · 主役")},
		{Key: "115100|Japanese|Childhood", PersonID: 777},
		{Key: "391018|Korean|", Remove: true},
		{Key: overlay.AddedVoiceKey(888), PersonID: 888, Line: sp("中配")},
		// An added voice nobody can show is left out.
		{Key: overlay.AddedVoiceKey(999), PersonID: 999},
	}}
	ov := pageOverlays{
		self: self,
		refs: map[int32]PersonRef{
			777: {AnilistID: 777, Name: Name{Full: sp("Replacement")}},
			888: {AnilistID: 888, Name: Name{Full: sp("Chinese Voice")}},
		},
		people: map[int32]overlay.Doc{
			133507: {NameCn: overlay.Of("小林千晃（改）"), Image: overlay.Of("https://example.org/api/edit-images/k.jpg")},
			888:    {NameCn: overlay.Of("中文声优")},
		},
	}
	c, ok := buildCharacter(184313, starkIdent(), []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "MAIN")}, voices, ov)
	require.True(t, ok)
	require.Len(t, c.Voices, 3)

	assert.Equal(t, "133507|Japanese|", c.Voices[0].Key)
	assert.Equal(t, "日配 · 主役", *c.Voices[0].Line)
	assert.Equal(t, "小林千晃（改）", *c.Voices[0].Person.Name.Cn, "the person's own edit applies on the character page")
	assert.Equal(t, "https://example.org/api/edit-images/k.jpg", *c.Voices[0].Person.Image)

	assert.Equal(t, "115100|Japanese|Childhood", c.Voices[1].Key, "the row keeps the credit's key after an edit")
	assert.Equal(t, int32(777), c.Voices[1].Person.AnilistID)
	assert.Equal(t, "Childhood", *c.Voices[1].RoleNotes)
	assert.Nil(t, c.Voices[1].Line)

	assert.Equal(t, overlay.AddedVoiceKey(888), c.Voices[2].Key)
	assert.Equal(t, "中文声优", *c.Voices[2].Person.Name.Cn)
	assert.Equal(t, "中配", *c.Voices[2].Line)
	assert.Nil(t, c.Voices[2].Language)
}

func TestBuildCharacter_ReplacementNobodyCreditsKeepsTheCredit(t *testing.T) {
	t.Parallel()
	voices := []dbgen.ListCharacterVoicesRow{characterVoiceRow(frieren, 133507, 0, "Japanese", nil, "Chiaki Kobayashi")}
	ov := pageOverlays{self: overlay.Doc{Voices: []overlay.VoiceOp{{Key: "133507|Japanese|", PersonID: 4242}}}}
	c, _ := buildCharacter(184313, starkIdent(), []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "MAIN")}, voices, ov)
	require.Len(t, c.Voices, 1)
	assert.Equal(t, int32(133507), c.Voices[0].Person.AnilistID)
}

func TestBuildPerson_OverlayAndCharacterOverlays(t *testing.T) {
	t.Parallel()
	ident := dbgen.GetPersonIdentityRow{
		HasProfile:         true,
		NameFull:           sp("Chiaki Kobayashi"),
		NameNative:         sp("小林千晃"),
		PrimaryOccupations: []string{"Voice Actor"},
		HomeTown:           sp("Kanagawa, Japan"),
		NameCn:             sp("小林千晃"),
	}
	voices := []dbgen.ListPersonVoiceRolesRow{
		voiceRow(frieren, 184313, 2, "MAIN", "Stark"),
		voiceRow(hell, 200000, 0, "MAIN", "Gabimaru"),
	}
	ov := pageOverlays{
		self: overlay.Doc{
			NameFull:    overlay.Of("Kobayashi Chiaki"),
			Occupations: overlay.Of([]string{"Voice Actor", "Singer"}),
			HomeTown:    overlay.Of("神奈川县"),
		},
		characters: map[int32]overlay.Doc{
			184313: {NameCn: overlay.Of("史塔克"), Roles: map[string]string{"154587": "SUPPORTING"}},
		},
	}
	p, ok := buildPerson(133507, ident, voices, nil, ov)
	require.True(t, ok)
	assert.Equal(t, "Kobayashi Chiaki", *p.Name.Full)
	assert.Equal(t, "小林千晃", *p.Name.Cn)
	assert.Equal(t, []string{"Voice Actor", "Singer"}, p.Profile.Occupations)
	assert.Equal(t, "神奈川县", *p.Profile.HomeTown)

	var stark VoiceRole
	for _, y := range p.VoiceRoles {
		for _, r := range y.Roles {
			if r.Character.AnilistID == 184313 {
				stark = r
			}
		}
	}
	assert.Equal(t, "史塔克", *stark.Character.Name.Cn, "the character's edit reaches the person page")
	assert.Equal(t, "SUPPORTING", *stark.Role)
	assert.Equal(t, int32(200000), p.RepresentativeRoles[0].Character.AnilistID,
		"the lead ranks first now that Stark supports")
	assert.Equal(t, 2, p.VoiceWorkCount, "an edit never changes what is counted")
}

func TestPersonRefFromRow(t *testing.T) {
	t.Parallel()
	ref := personRefFromRow(dbgen.ListPersonRefsRow{
		AnilistID:    95185,
		CreditFull:   sp("Credit Name"),
		CreditNative: sp("クレジット"),
		NameCn:       sp("中文名"),
		CreditImage:  sp("https://s4.anilist.co/file/anilistcdn/staff/medium/n95185.jpg"),
	})
	assert.Equal(t, "Credit Name", *ref.Name.Full)
	assert.Equal(t, "中文名", *ref.Name.Cn)
	assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n95185.jpg", *ref.Image)
}

func TestDecodeOverlays_SkipsAnUnreadableDocument(t *testing.T) {
	t.Parallel()
	people, characters := decodeOverlays([]dbgen.ListEntityOverlaysRow{
		{Kind: "person", EntityID: 1, Data: []byte(`{"nameCn":"甲"}`)},
		{Kind: "character", EntityID: 2, Data: []byte(`{"nameCn":5}`)},
		{Kind: "character", EntityID: 3, Data: []byte(`{"nameCn":"丙"}`)},
	})
	assert.Equal(t, "甲", *people[1].NameCn.Value)
	_, bad := characters[2]
	assert.False(t, bad)
	assert.Equal(t, "丙", *characters[3].NameCn.Value)
}

func TestVoicePeople(t *testing.T) {
	t.Parallel()
	rows := []dbgen.ListCharacterVoicesRow{
		characterVoiceRow(frieren, 1, 0, "Japanese", nil, "a"),
		characterVoiceRow(frieren2, 1, 0, "Japanese", nil, "a"),
		characterVoiceRow(frieren, 2, 1, "Japanese", nil, "b"),
	}
	self := overlay.Doc{Voices: []overlay.VoiceOp{
		{Key: "2|Japanese|", PersonID: 3},
		{Key: overlay.AddedVoiceKey(4), PersonID: 4},
		{Key: overlay.AddedVoiceKey(5), Remove: true},
		{Key: overlay.AddedVoiceKey(1), PersonID: 1},
	}}
	all, uncredited := voicePeople(rows, self)
	assert.Equal(t, []int32{1, 2, 3, 4}, all)
	assert.Equal(t, []int32{3, 4}, uncredited)
}
