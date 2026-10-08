package people

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

func sp(s string) *string { return &s }
func ip(n int32) *int32   { return &n }

func date(y int, m time.Month, d int) pgtype.Date {
	return pgtype.Date{Time: time.Date(y, m, d, 0, 0, 0, 0, time.UTC), Valid: true}
}

// title is the anime half of a credit row, so each test names only what it
// is about.
type title struct {
	id         int32
	romaji     string
	chinese    string
	start      pgtype.Date
	seasonYear *int32
	popularity *int32
	format     string
}

func voiceRow(t title, characterID int32, order int32, role string, character string) dbgen.ListPersonVoiceRolesRow {
	return dbgen.ListPersonVoiceRolesRow{
		AnimeID:         t.id,
		CharacterID:     characterID,
		Language:        sp("Japanese"),
		PersonFull:      sp("Chiaki Kobayashi"),
		PersonNative:    sp("小林千晃"),
		PersonImage:     sp("https://s4.anilist.co/file/anilistcdn/staff/medium/n133507-a.jpg"),
		Role:            sp(role),
		CharacterOrder:  order,
		CharacterFull:   sp(character),
		CharacterNative: sp(character + "ja"),
		CharacterImage:  sp("https://s4.anilist.co/file/anilistcdn/character/medium/b" + character + ".jpg"),
		TitleRomaji:     sp(t.romaji),
		TitleChinese:    sp(t.chinese),
		CoverImageUrl:   sp("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/" + t.romaji + ".jpg"),
		Format:          sp(t.format),
		SeasonYear:      t.seasonYear,
		StartDate:       t.start,
		Popularity:      t.popularity,
	}
}

func staffRow(t title, role string) dbgen.ListPersonStaffCreditsRow {
	return dbgen.ListPersonStaffCreditsRow{
		AnimeID:       t.id,
		Role:          sp(role),
		PersonFull:    sp("Keiichirou Saitou"),
		PersonNative:  sp("斎藤圭一郎"),
		PersonImage:   sp("https://s4.anilist.co/file/anilistcdn/staff/medium/n134254-b.png"),
		TitleRomaji:   sp(t.romaji),
		TitleChinese:  sp(t.chinese),
		Format:        sp(t.format),
		SeasonYear:    t.seasonYear,
		StartDate:     t.start,
		Popularity:    t.popularity,
		CoverImageUrl: sp("cover-" + t.romaji),
	}
}

var (
	frieren   = title{id: 154587, romaji: "Sousou no Frieren", chinese: "葬送的芙莉莲", start: date(2023, 9, 29), seasonYear: ip(2023), popularity: ip(480000), format: "TV"}
	frieren2  = title{id: 182255, romaji: "Sousou no Frieren 2", chinese: "葬送的芙莉莲 第二季", start: date(2026, 1, 16), seasonYear: ip(2026), popularity: ip(150000), format: "TV"}
	hell      = title{id: 166613, romaji: "Jigokuraku", chinese: "地狱乐", start: date(2023, 4, 1), seasonYear: ip(2023), popularity: ip(300000), format: "TV"}
	hell2     = title{id: 175014, romaji: "Jigokuraku 2", chinese: "地狱乐 第二季", start: date(2026, 1, 11), seasonYear: ip(2026), popularity: ip(90000), format: "TV"}
	mashle    = title{id: 151801, romaji: "Mashle", chinese: "物理魔法使马修", start: date(2023, 4, 8), seasonYear: ip(2023), popularity: ip(350000), format: "TV"}
	upcoming  = title{id: 190001, romaji: "Next Big Thing", popularity: ip(5000), format: "TV"}
	seasonOnl = title{id: 190002, romaji: "Season Only", seasonYear: ip(2026), popularity: ip(1000000), format: "ONA"}
)

// ── Person: where each field comes from ───────────────────────────────────

func TestBuildPerson_ProfileAndBangumiNameWin(t *testing.T) {
	t.Parallel()

	ident := dbgen.GetPersonIdentityRow{
		HasProfile:         true,
		NameFull:           sp("Chiaki Kobayashi"),
		NameNative:         sp("小林千晃"),
		ImageLarge:         sp("https://s4.anilist.co/file/anilistcdn/staff/large/n133507-profile.jpg"),
		PrimaryOccupations: []string{"Voice Actor"},
		Gender:             sp("Male"),
		BirthYear:          ip(1994),
		BirthMonth:         ip(6),
		BirthDay:           ip(4),
		Age:                ip(32),
		YearsActive:        []int32{2016},
		HomeTown:           sp("Kanagawa Prefecture, Japan"),
		Language:           sp("Japanese"),
		SiteUrl:            sp("https://anilist.co/staff/133507"),
		BgmID:              ip(32265),
		NameCn:             sp("小林千晃"),
	}
	voices := []dbgen.ListPersonVoiceRolesRow{voiceRow(frieren, 184313, 2, "MAIN", "Stark")}

	p, ok := buildPerson(133507, ident, voices, nil)
	require.True(t, ok)

	assert.Equal(t, int32(133507), p.AnilistID)
	assert.Equal(t, "Chiaki Kobayashi", *p.Name.Full)
	assert.Equal(t, "小林千晃", *p.Name.Native)
	assert.Equal(t, "小林千晃", *p.Name.Cn)
	assert.Equal(t, int32(32265), *p.BangumiID)
	assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n133507-profile.jpg", *p.Image,
		"the profile's own large image beats the credit's")
	// A person's alternative names are AniList's list of the pseudonyms they
	// work under, adult work included: not read, not answered.
	raw, err := json.Marshal(p)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "lternative")

	require.NotNil(t, p.Profile)
	assert.Equal(t, []string{"Voice Actor"}, p.Profile.Occupations)
	assert.Equal(t, "Male", *p.Profile.Gender)
	require.NotNil(t, p.Profile.Birth)
	assert.Equal(t, int32(1994), *p.Profile.Birth.Year)
	assert.Equal(t, int32(6), *p.Profile.Birth.Month)
	assert.Equal(t, int32(4), *p.Profile.Birth.Day)
	assert.Nil(t, p.Profile.Death, "no part of the date of death: no date")
	assert.Equal(t, "Kanagawa Prefecture, Japan", *p.Profile.HomeTown)
	assert.Nil(t, p.Profile.BloodType)
	assert.Equal(t, []int32{2016}, p.Profile.YearsActive)
}

func TestBuildPerson_RowlessFallsBackToTheCredits(t *testing.T) {
	t.Parallel()

	// No profile row and no Bangumi match: the identity row is all NULL.
	ident := dbgen.GetPersonIdentityRow{}
	minor := voiceRow(hell, 300, 5, "SUPPORTING", "Minor")
	minor.PersonFull = sp("Old Romanisation")
	minor.PersonImage = sp("https://s4.anilist.co/file/anilistcdn/staff/medium/old.jpg")
	voices := []dbgen.ListPersonVoiceRolesRow{minor, voiceRow(frieren, 184313, 2, "MAIN", "Stark")}

	p, ok := buildPerson(133507, ident, voices, nil)
	require.True(t, ok, "a rowless person credited somewhere still has a page")

	assert.Nil(t, p.Profile)
	assert.Nil(t, p.BangumiID)
	assert.Nil(t, p.Name.Cn)
	// The most popular title's credit names the person.
	assert.Equal(t, "Chiaki Kobayashi", *p.Name.Full)
	assert.Equal(t, "小林千晃", *p.Name.Native)
	assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n133507-a.jpg", *p.Image,
		"the credit's medium image, at the large size")
}

func TestBuildPerson_NameLadderTakesEachFieldWhereItExists(t *testing.T) {
	t.Parallel()

	// A profile with no native name: the native name comes from the credit,
	// the romanised one from the profile.
	ident := dbgen.GetPersonIdentityRow{HasProfile: true, NameFull: sp("Profile Name")}
	staff := []dbgen.ListPersonStaffCreditsRow{staffRow(frieren, "Director")}

	p, ok := buildPerson(134254, ident, nil, staff)
	require.True(t, ok)
	assert.Equal(t, "Profile Name", *p.Name.Full)
	assert.Equal(t, "斎藤圭一郎", *p.Name.Native)
	assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n134254-b.png", *p.Image)
}

func TestBuildPerson_NotCreditedAnywhereIsNotAPage(t *testing.T) {
	t.Parallel()

	ident := dbgen.GetPersonIdentityRow{HasProfile: true, NameFull: sp("Has A Profile"), NameCn: sp("有档案")}
	_, ok := buildPerson(1, ident, nil, nil)
	assert.False(t, ok, "a profile alone is not a page")
}

// ── Person: year grouping ─────────────────────────────────────────────────

func TestGroupVoiceRoles_NewestFirstUndatedOnTop(t *testing.T) {
	t.Parallel()

	roles := []VoiceRole{
		voiceRole(frieren, 184313, 2, "MAIN"),
		voiceRole(frieren2, 184313, 2, "MAIN"),
		voiceRole(upcoming, 1, 0, "MAIN"),
		voiceRole(hell, 2, 0, "MAIN"),
		voiceRole(seasonOnl, 3, 0, "SUPPORTING"),
		voiceRole(hell2, 2, 0, "MAIN"),
		// Two characters on one title: the cast order decides.
		voiceRole(mashle, 9, 7, "SUPPORTING"),
		voiceRole(mashle, 8, 0, "MAIN"),
	}

	years := groupVoiceRoles(roles)

	var got []string
	for _, y := range years {
		label := "nil"
		if y.Year != nil {
			label = itoa(*y.Year)
		}
		for _, r := range y.Roles {
			got = append(got, label+":"+itoa(r.Anime.AnilistID)+"/"+itoa(r.Character.AnilistID))
		}
	}
	assert.Equal(t, []string{
		// No date at all: the top, as an announced title.
		"nil:190001/1",
		// 2026: dated titles newest first, then the one with only a season
		// year (it cannot be placed inside the year, popularity aside).
		"2026:182255/184313",
		"2026:175014/2",
		"2026:190002/3",
		// 2023: Frieren (Sep) before Mashle (Apr 8) before Jigokuraku (Apr 1);
		// within Mashle, cast order.
		"2023:154587/184313",
		"2023:151801/8",
		"2023:151801/9",
		"2023:166613/2",
	}, got)
	require.Len(t, years, 3)
	assert.Nil(t, years[0].Year)
	assert.Equal(t, int32(2026), *years[1].Year)
	assert.Equal(t, int32(2023), *years[2].Year)
}

func TestGroupStaffWorks_RolesStayWithTheirTitle(t *testing.T) {
	t.Parallel()

	credits := []dbgen.ListPersonStaffCreditsRow{
		staffRow(frieren, "Director"),
		staffRow(frieren, "Storyboard (eps 1, 5)"),
		staffRow(hell, "Key Animation (OP)"),
		staffRow(frieren2, "Storyboard (ep 1)"),
	}

	years, count := groupStaffCredits(credits)

	assert.Equal(t, 3, count, "three distinct titles")
	require.Len(t, years, 2)
	assert.Equal(t, int32(2026), *years[0].Year)
	require.Len(t, years[0].Works, 1)
	assert.Equal(t, []string{"Storyboard (ep 1)"}, years[0].Works[0].Roles)
	assert.Equal(t, int32(2023), *years[1].Year)
	require.Len(t, years[1].Works, 2)
	assert.Equal(t, frieren.id, years[1].Works[0].Anime.AnilistID)
	assert.Equal(t, []string{"Director", "Storyboard (eps 1, 5)"}, years[1].Works[0].Roles,
		"one card per title, its roles in credit order")
	assert.Equal(t, hell.id, years[1].Works[1].Anime.AnilistID)
}

// ── Person: representative roles ──────────────────────────────────────────

func TestRepresentativeRoles_MainRolesInPopularTitlesFirst(t *testing.T) {
	t.Parallel()

	popularSupporting := title{id: 1, romaji: "Huge Hit", start: date(2024, 1, 1), popularity: ip(900000), format: "TV"}
	roles := []VoiceRole{
		voiceRole(popularSupporting, 50, 4, "SUPPORTING"),
		voiceRole(hell2, 2, 0, "MAIN"),         // Gabimaru again, in a less popular sequel
		voiceRole(frieren2, 184313, 2, "MAIN"), // Stark again
		voiceRole(mashle, 8, 0, "MAIN"),
		voiceRole(hell, 2, 0, "MAIN"),
		voiceRole(frieren, 184313, 2, "MAIN"),
	}

	got := representativeRoles(roles, RepresentativeRoleCount)

	require.Len(t, got, 3)
	// Main roles beat a supporting role in a bigger title; each character
	// appears once, in its most popular title.
	assert.Equal(t, []int32{184313, 8, 2}, []int32{got[0].Character.AnilistID, got[1].Character.AnilistID, got[2].Character.AnilistID})
	assert.Equal(t, []int32{frieren.id, mashle.id, hell.id}, []int32{got[0].Anime.AnilistID, got[1].Anime.AnilistID, got[2].Anime.AnilistID})
}

func TestRepresentativeRoles_FallsBackToSupportingAndOneTitleOnce(t *testing.T) {
	t.Parallel()

	roles := []VoiceRole{
		voiceRole(frieren, 10, 3, "SUPPORTING"),
		voiceRole(frieren, 11, 4, "SUPPORTING"), // a second character in the same title
		voiceRole(hell, 12, 9, "BACKGROUND"),
	}

	got := representativeRoles(roles, RepresentativeRoleCount)

	require.Len(t, got, 2, "one card per title, so two titles give two cards")
	assert.Equal(t, int32(10), got[0].Character.AnilistID, "cast order breaks the tie inside a title")
	assert.Equal(t, int32(12), got[1].Character.AnilistID)
}

// ── Person: indexing ──────────────────────────────────────────────────────

func TestPersonIndexable_Threshold(t *testing.T) {
	t.Parallel()

	cases := []struct {
		voice, staff int
		want         bool
	}{
		{0, 0, false},
		{MinIndexedVoiceWorks - 1, MinIndexedStaffWorks - 1, false},
		{MinIndexedVoiceWorks, 0, true},
		{0, MinIndexedStaffWorks, true},
		{1, MinIndexedStaffWorks - 1, false},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, personIndexable(c.voice, c.staff), "voice=%d staff=%d", c.voice, c.staff)
	}
	assert.Equal(t, 3, MinIndexedVoiceWorks)
	assert.Equal(t, 5, MinIndexedStaffWorks)
}

func TestBuildPerson_CountsDistinctTitles(t *testing.T) {
	t.Parallel()

	voices := []dbgen.ListPersonVoiceRolesRow{
		voiceRow(mashle, 8, 0, "MAIN", "Mash"),
		voiceRow(mashle, 9, 1, "SUPPORTING", "Other"),
		voiceRow(frieren, 184313, 2, "MAIN", "Stark"),
	}
	p, ok := buildPerson(133507, dbgen.GetPersonIdentityRow{}, voices, nil)
	require.True(t, ok)
	assert.Equal(t, 2, p.VoiceWorkCount, "two characters on one title count it once")
	assert.Equal(t, 0, p.StaffWorkCount)
	assert.False(t, p.Indexable)
	assert.Empty(t, p.StaffRoles)
	assert.NotNil(t, p.StaffRoles, "an empty list, not null")
}

// ── Character ─────────────────────────────────────────────────────────────

func appearanceRow(t title, role string) dbgen.ListCharacterAppearancesRow {
	return dbgen.ListCharacterAppearancesRow{
		AnimeID:       t.id,
		Role:          sp(role),
		NameEn:        sp("Stark"),
		NameJa:        sp("シュタルク"),
		ImageUrl:      sp("https://s4.anilist.co/file/anilistcdn/character/medium/b184313-x.jpg"),
		TitleRomaji:   sp(t.romaji),
		TitleChinese:  sp(t.chinese),
		Format:        sp(t.format),
		SeasonYear:    t.seasonYear,
		StartDate:     t.start,
		Popularity:    t.popularity,
		CoverImageUrl: sp("cover-" + t.romaji),
		PosterAccent:  sp("#7caf62"),
	}
}

func characterVoiceRow(t title, staffID int32, order int32, lang string, notes *string, full string) dbgen.ListCharacterVoicesRow {
	return dbgen.ListCharacterVoicesRow{
		AnimeID:      t.id,
		StaffID:      staffID,
		Language:     sp(lang),
		RoleNotes:    notes,
		DisplayOrder: order,
		NameFull:     sp(full),
		NameNative:   sp(full + " native"),
		ImageUrl:     sp("https://s4.anilist.co/file/anilistcdn/staff/medium/n" + itoa(staffID) + ".jpg"),
		Popularity:   t.popularity,
	}
}

func TestBuildCharacter_VoicesAcrossLanguagesWithNotes(t *testing.T) {
	t.Parallel()

	ident := dbgen.GetCharacterIdentityRow{HasProfile: true, NameFull: sp("Stark"), NameNative: sp("シュタルク"), NameCn: sp("修塔尔克"), BgmID: ip(89182)}
	appearances := []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren2, "MAIN"), appearanceRow(frieren, "MAIN")}
	voices := []dbgen.ListCharacterVoicesRow{
		// Frieren as stored: Japanese main, Japanese childhood, Korean young, Korean main.
		characterVoiceRow(frieren, 133507, 0, "Japanese", nil, "Chiaki Kobayashi"),
		characterVoiceRow(frieren, 115100, 1, "Japanese", sp("Childhood"), "Arisa Kiyoto"),
		characterVoiceRow(frieren, 139151, 2, "Korean", sp("Young"), "Sae-Byeok Lee"),
		characterVoiceRow(frieren, 391018, 3, "Korean", nil, "Sin-U Kim"),
		// The sequel repeats the main Japanese voice: listed once.
		characterVoiceRow(frieren2, 133507, 0, "Japanese", nil, "Chiaki Kobayashi"),
	}
	voices[0].NameCn = sp("小林千晃")
	voices[0].ImageLarge = sp("https://s4.anilist.co/file/anilistcdn/staff/large/n133507-profile.jpg")

	c, ok := buildCharacter(184313, ident, appearances, voices)
	require.True(t, ok)

	var got []string
	for _, v := range c.Voices {
		note := ""
		if v.RoleNotes != nil {
			note = "/" + *v.RoleNotes
		}
		got = append(got, *v.Language+":"+itoa(v.Person.AnilistID)+note)
	}
	assert.Equal(t, []string{
		"Japanese:133507",
		"Japanese:115100/Childhood",
		"Korean:391018",
		"Korean:139151/Young",
	}, got, "the original language first; in each language the main voice before the noted ones")

	kobayashi := c.Voices[0].Person
	assert.Equal(t, "小林千晃", *kobayashi.Name.Cn)
	assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n133507-profile.jpg", *kobayashi.Image)
	assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n115100.jpg", *c.Voices[1].Person.Image,
		"no profile: the credit's image at the large size")

	// Earliest first.
	require.Len(t, c.Appearances, 2)
	assert.Equal(t, frieren.id, c.Appearances[0].Anime.AnilistID)
	assert.Equal(t, frieren2.id, c.Appearances[1].Anime.AnilistID)
	assert.Equal(t, "MAIN", *c.Appearances[0].Role)
	assert.True(t, c.Indexable, "a lead with a Chinese name")
}

func TestBuildCharacter_RowlessAndIndexing(t *testing.T) {
	t.Parallel()

	appearances := []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "SUPPORTING")}
	c, ok := buildCharacter(184313, dbgen.GetCharacterIdentityRow{}, appearances, nil)
	require.True(t, ok, "credited somewhere, so a page, profile or not")
	assert.Nil(t, c.Profile)
	assert.Equal(t, "Stark", *c.Name.Full)
	assert.Equal(t, "シュタルク", *c.Name.Native)
	assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/character/large/b184313-x.jpg", *c.Image)
	assert.Empty(t, c.Voices)
	assert.NotNil(t, c.Voices)
	assert.False(t, c.Indexable, "no Chinese name and no lead role")

	_, ok = buildCharacter(1, dbgen.GetCharacterIdentityRow{HasProfile: true}, nil, nil)
	assert.False(t, ok, "listed on no title: no page")
}

func TestCharacterIndexable(t *testing.T) {
	t.Parallel()

	main := []Appearance{{Role: sp("SUPPORTING")}, {Role: sp("MAIN")}}
	supporting := []Appearance{{Role: sp("SUPPORTING")}}
	assert.True(t, characterIndexable(Name{Cn: sp("修塔尔克")}, main))
	assert.False(t, characterIndexable(Name{Cn: sp("修塔尔克")}, supporting))
	assert.False(t, characterIndexable(Name{Full: sp("Stark")}, main))
}

func TestBuildCharacter_ProfileFields(t *testing.T) {
	t.Parallel()

	ident := dbgen.GetCharacterIdentityRow{
		HasProfile:      true,
		NameFull:        sp("Aura"),
		NameNative:      sp("アウラ"),
		NameAlternative: []string{"Aura the Guillotine", "Aura"},
		ImageLarge:      sp("https://s4.anilist.co/file/anilistcdn/character/large/aura.png"),
		Description:     sp("Aura is ~!killed later!~."),
		Gender:          sp("Female"),
		Age:             sp("500+"),
		BirthMonth:      ip(3),
		BirthDay:        ip(14),
	}
	c, ok := buildCharacter(219110, ident, []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "SUPPORTING")}, nil)
	require.True(t, ok)
	require.NotNil(t, c.Profile)
	assert.Equal(t, "Aura is ~!killed later!~.", *c.Profile.Description, "markup is the page's to render")
	assert.Equal(t, "500+", *c.Profile.Age)
	require.NotNil(t, c.Profile.Birth)
	assert.Nil(t, c.Profile.Birth.Year)
	assert.Equal(t, int32(3), *c.Profile.Birth.Month)
	assert.Equal(t, []string{"Aura the Guillotine"}, c.AlternativeNames)
	assert.Equal(t, "Aura", *c.Name.Full, "the profile's name")

	raw, err := json.Marshal(c)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "Spoiler", "spoiler aliases are never part of the answer")
}

// ── Images ────────────────────────────────────────────────────────────────

func TestLargeImage(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"https://s4.anilist.co/file/anilistcdn/character/medium/b1-x.png": "https://s4.anilist.co/file/anilistcdn/character/large/b1-x.png",
		"https://s4.anilist.co/file/anilistcdn/staff/medium/n2-y.jpg":     "https://s4.anilist.co/file/anilistcdn/staff/large/n2-y.jpg",
		"https://s4.anilist.co/file/anilistcdn/staff/large/n2-y.jpg":      "https://s4.anilist.co/file/anilistcdn/staff/large/n2-y.jpg",
		"https://lain.bgm.tv/pic/crt/m/ab/cd.jpg?r=1":                     "https://lain.bgm.tv/pic/crt/m/ab/cd.jpg?r=1",
		"https://example.com/anilistcdn/staff/medium/z.jpg":               "https://example.com/anilistcdn/staff/medium/z.jpg",
	}
	for in, want := range cases {
		assert.Equal(t, want, *largeImage(sp(in)), in)
	}
	assert.Nil(t, largeImage(nil))
	assert.Nil(t, largeImage(sp("  ")))
}

// ── helpers ───────────────────────────────────────────────────────────────

func voiceRole(t title, characterID int32, order int32, role string) VoiceRole {
	return voiceRoleFromRow(voiceRow(t, characterID, order, role, "c"+itoa(characterID)))
}

func itoa(n int32) string {
	b, _ := json.Marshal(n)
	return string(b)
}
