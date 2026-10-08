package profiles

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

var fetchedAt = time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)

func sp(s string) *string { return &s }
func ip(n int) *int       { return &n }
func i32(n int32) *int32  { return &n }

// fullStaff is a person with every field AniList can send.
func fullStaff() anilist.StaffProfile {
	return anilist.StaffProfile{
		ID: 101,
		Name: &anilist.StaffName{
			Full:        sp("Test Person"),
			Native:      sp("試験 人物"),
			Alternative: []*string{sp("T. Person"), sp("Tess")},
		},
		LanguageV2:         sp("Japanese"),
		Image:              &anilist.Image{Large: sp("https://img/large/101.png"), Medium: sp("https://img/medium/101.png")},
		Description:        sp("A voice actor.\n\n~!Plays the twist villain.!~"),
		PrimaryOccupations: []*string{sp("Voice Actor"), sp("Singer")},
		Gender:             sp("Female"),
		DateOfBirth:        &anilist.FuzzyDate{Year: ip(1988), Month: ip(9), Day: ip(27)},
		DateOfDeath:        &anilist.FuzzyDate{Year: ip(2030), Month: ip(1), Day: ip(2)},
		Age:                ip(38),
		YearsActive:        []*int{ip(2009), ip(2031)},
		HomeTown:           sp("Oita, Japan"),
		BloodType:          sp("A"),
		Favourites:         ip(1234),
		SiteURL:            sp("https://anilist.co/staff/101"),
	}
}

// TestPersonRow_EveryField — each AniList field lands in its column, and
// the fetch time is the row's fetched_at.
func TestPersonRow_EveryField(t *testing.T) {
	assert.Equal(t, dbgen.UpsertPersonParams{
		AnilistID:          101,
		NameFull:           sp("Test Person"),
		NameNative:         sp("試験 人物"),
		NameAlternative:    []string{"T. Person", "Tess"},
		Language:           sp("Japanese"),
		ImageLarge:         sp("https://img/large/101.png"),
		ImageMedium:        sp("https://img/medium/101.png"),
		Description:        sp("A voice actor.\n\n~!Plays the twist villain.!~"),
		PrimaryOccupations: []string{"Voice Actor", "Singer"},
		Gender:             sp("Female"),
		BirthYear:          i32(1988),
		BirthMonth:         i32(9),
		BirthDay:           i32(27),
		DeathYear:          i32(2030),
		DeathMonth:         i32(1),
		DeathDay:           i32(2),
		Age:                i32(38),
		YearsActive:        []int32{2009, 2031},
		HomeTown:           sp("Oita, Japan"),
		BloodType:          sp("A"),
		Favourites:         i32(1234),
		SiteUrl:            sp("https://anilist.co/staff/101"),
		FetchedAt:          pgtype.Timestamptz{Time: fetchedAt, Valid: true},
	}, PersonRow(fullStaff(), fetchedAt))
}

// TestPersonRow_NothingStated — a profile that is only an id (AniList
// sends null for everything it does not know) becomes a row of NULLs and
// empty lists, never zeros or nil lists.
func TestPersonRow_NothingStated(t *testing.T) {
	row := PersonRow(anilist.StaffProfile{ID: 7}, fetchedAt)

	assert.Equal(t, int32(7), row.AnilistID)
	assert.Nil(t, row.NameFull)
	assert.Nil(t, row.NameNative)
	assert.NotNil(t, row.NameAlternative, "an empty list, not a NULL the column refuses")
	assert.Empty(t, row.NameAlternative)
	assert.NotNil(t, row.PrimaryOccupations)
	assert.Empty(t, row.PrimaryOccupations)
	assert.NotNil(t, row.YearsActive)
	assert.Empty(t, row.YearsActive)
	assert.Nil(t, row.ImageLarge)
	assert.Nil(t, row.ImageMedium)
	assert.Nil(t, row.Description)
	assert.Nil(t, row.BirthYear)
	assert.Nil(t, row.BirthMonth)
	assert.Nil(t, row.BirthDay)
	assert.Nil(t, row.DeathYear)
	assert.Nil(t, row.Age)
	assert.Nil(t, row.Favourites)
	assert.Nil(t, row.SiteUrl)
	assert.Equal(t, pgtype.Timestamptz{Time: fetchedAt, Valid: true}, row.FetchedAt)
}

// TestPersonRow_CleansWhatAniListUsersTyped — AniList's profiles are
// user-edited.  Blank strings are absences, list entries are trimmed and
// de-duplicated with nulls and blanks dropped, and a list keeps AniList's
// order.
func TestPersonRow_CleansWhatAniListUsersTyped(t *testing.T) {
	s := anilist.StaffProfile{
		ID: 8,
		Name: &anilist.StaffName{
			Full:        sp("  Spaced Name "),
			Native:      sp("   "),
			Alternative: []*string{nil, sp(""), sp(" Alias "), sp("Alias"), sp("Other"), sp("  ")},
		},
		LanguageV2:         sp(""),
		Image:              &anilist.Image{Medium: sp(" https://img/medium/8.png ")},
		PrimaryOccupations: []*string{sp("Animator"), nil, sp("Animator"), sp(" Director ")},
		Gender:             sp(" "),
		HomeTown:           sp("\t"),
		BloodType:          sp(" B "),
	}
	row := PersonRow(s, fetchedAt)

	assert.Equal(t, "Spaced Name", *row.NameFull)
	assert.Nil(t, row.NameNative, "whitespace is no name")
	assert.Equal(t, []string{"Alias", "Other"}, row.NameAlternative)
	assert.Nil(t, row.Language)
	assert.Nil(t, row.ImageLarge)
	assert.Equal(t, "https://img/medium/8.png", *row.ImageMedium)
	assert.Equal(t, []string{"Animator", "Director"}, row.PrimaryOccupations)
	assert.Nil(t, row.Gender)
	assert.Nil(t, row.HomeTown)
	assert.Equal(t, "B", *row.BloodType)
}

// TestRows_DescriptionIsStoredRaw — the description is AniList's markdown
// byte for byte, spoiler markers and surrounding whitespace included:
// rendering it is the reader's business.  Only a description with nothing
// in it is an absence.
func TestRows_DescriptionIsStoredRaw(t *testing.T) {
	raw := "\n__Born:__ somewhere  \n\n~!The reveal.!~ \n"
	assert.Equal(t, raw, *PersonRow(anilist.StaffProfile{ID: 1, Description: sp(raw)}, fetchedAt).Description)
	assert.Equal(t, raw, *CharacterRow(anilist.CharacterProfile{ID: 1, Description: sp(raw)}, fetchedAt).Description)

	assert.Nil(t, PersonRow(anilist.StaffProfile{ID: 1, Description: sp(" \n ")}, fetchedAt).Description)
	assert.Nil(t, CharacterRow(anilist.CharacterProfile{ID: 1, Description: sp("")}, fetchedAt).Description)
}

// TestRows_DatesKeepWhatAniListKnows — a FuzzyDate is kept part by part:
// a birthday with no year is the common case and is kept as a month and a
// day.  A part that is not a calendar value is dropped on its own; the
// columns' CHECKs would refuse it, and one refused row fails its whole
// batch.
func TestRows_DatesKeepWhatAniListKnows(t *testing.T) {
	for name, tc := range map[string]struct {
		date           *anilist.FuzzyDate
		year, mon, day *int32
	}{
		"no date":               {date: nil},
		"all null":              {date: &anilist.FuzzyDate{}},
		"birthday without year": {date: &anilist.FuzzyDate{Month: ip(12), Day: ip(24)}, mon: i32(12), day: i32(24)},
		"year only":             {date: &anilist.FuzzyDate{Year: ip(1975)}, year: i32(1975)},
		"month 13":              {date: &anilist.FuzzyDate{Year: ip(1990), Month: ip(13), Day: ip(1)}, year: i32(1990), day: i32(1)},
		"month 0, day 0":        {date: &anilist.FuzzyDate{Year: ip(1990), Month: ip(0), Day: ip(0)}, year: i32(1990)},
		"day 32":                {date: &anilist.FuzzyDate{Month: ip(1), Day: ip(32)}, mon: i32(1)},
		"year 0":                {date: &anilist.FuzzyDate{Year: ip(0), Month: ip(5), Day: ip(5)}, mon: i32(5), day: i32(5)},
		"negative year":         {date: &anilist.FuzzyDate{Year: ip(-20)}},
	} {
		t.Run(name, func(t *testing.T) {
			p := PersonRow(anilist.StaffProfile{ID: 1, DateOfBirth: tc.date, DateOfDeath: tc.date}, fetchedAt)
			assert.Equal(t, tc.year, p.BirthYear)
			assert.Equal(t, tc.mon, p.BirthMonth)
			assert.Equal(t, tc.day, p.BirthDay)
			assert.Equal(t, tc.year, p.DeathYear)
			assert.Equal(t, tc.mon, p.DeathMonth)
			assert.Equal(t, tc.day, p.DeathDay)

			c := CharacterRow(anilist.CharacterProfile{ID: 1, DateOfBirth: tc.date}, fetchedAt)
			assert.Equal(t, tc.year, c.BirthYear)
			assert.Equal(t, tc.mon, c.BirthMonth)
			assert.Equal(t, tc.day, c.BirthDay)
		})
	}
}

// TestPersonRow_YearsActiveIsPositional — AniList's yearsActive is [first]
// or [first, last], so a value that is not a year ends the list rather
// than being skipped: skipping it would move a last year into the first
// place and turn "until 2014" into "since 2014".
func TestPersonRow_YearsActiveIsPositional(t *testing.T) {
	for name, tc := range map[string]struct {
		in   []*int
		want []int32
	}{
		"none":            {in: nil, want: []int32{}},
		"still active":    {in: []*int{ip(2009)}, want: []int32{2009}},
		"retired":         {in: []*int{ip(1998), ip(2014)}, want: []int32{1998, 2014}},
		"null last year":  {in: []*int{ip(2009), nil}, want: []int32{2009}},
		"null first year": {in: []*int{nil, ip(2014)}, want: []int32{}},
		"zero first year": {in: []*int{ip(0), ip(2014)}, want: []int32{}},
		"zero only":       {in: []*int{ip(0)}, want: []int32{}},
		"negative last":   {in: []*int{ip(2001), ip(-1)}, want: []int32{2001}},
	} {
		t.Run(name, func(t *testing.T) {
			got := PersonRow(anilist.StaffProfile{ID: 1, YearsActive: tc.in}, fetchedAt).YearsActive
			assert.Equal(t, tc.want, got)
		})
	}
}

// TestPersonRow_AgeIsAPositiveNumber — AniList's Staff.age is a number
// computed from the birth date; nothing real is zero or negative.
func TestPersonRow_AgeIsAPositiveNumber(t *testing.T) {
	assert.Nil(t, PersonRow(anilist.StaffProfile{ID: 1, Age: ip(0)}, fetchedAt).Age)
	assert.Nil(t, PersonRow(anilist.StaffProfile{ID: 1, Age: ip(-3)}, fetchedAt).Age)
	assert.Equal(t, i32(81), PersonRow(anilist.StaffProfile{ID: 1, Age: ip(81)}, fetchedAt).Age)
	assert.Equal(t, i32(0), PersonRow(anilist.StaffProfile{ID: 1, Favourites: ip(0)}, fetchedAt).Favourites,
		"zero favourites is a count, kept")
}

// TestCharacterRow_EveryField is TestPersonRow_EveryField for characters.
func TestCharacterRow_EveryField(t *testing.T) {
	c := anilist.CharacterProfile{
		ID: 201,
		Name: &anilist.CharacterName{
			Full:               sp("Test Hero"),
			Native:             sp("テスト"),
			Alternative:        []*string{sp("The Hero"), nil},
			AlternativeSpoiler: []*string{sp("The Demon King"), sp(" The Demon King ")},
		},
		Image:       &anilist.Image{Large: sp("https://img/large/201.png"), Medium: sp("https://img/medium/201.png")},
		Description: sp("__Height:__ 160 cm\n~!Was the king all along.!~"),
		Gender:      sp("Male"),
		DateOfBirth: &anilist.FuzzyDate{Month: ip(12), Day: ip(24)},
		Age:         sp(" 16-17 "),
		BloodType:   sp("O"),
		Favourites:  ip(42),
		SiteURL:     sp("https://anilist.co/character/201"),
	}
	assert.Equal(t, dbgen.UpsertCharacterParams{
		AnilistID:              201,
		NameFull:               sp("Test Hero"),
		NameNative:             sp("テスト"),
		NameAlternative:        []string{"The Hero"},
		NameAlternativeSpoiler: []string{"The Demon King"},
		ImageLarge:             sp("https://img/large/201.png"),
		ImageMedium:            sp("https://img/medium/201.png"),
		Description:            sp("__Height:__ 160 cm\n~!Was the king all along.!~"),
		Gender:                 sp("Male"),
		BirthMonth:             i32(12),
		BirthDay:               i32(24),
		Age:                    sp("16-17"),
		BloodType:              sp("O"),
		Favourites:             i32(42),
		SiteUrl:                sp("https://anilist.co/character/201"),
		FetchedAt:              pgtype.Timestamptz{Time: fetchedAt, Valid: true},
	}, CharacterRow(c, fetchedAt))
}

// TestCharacterRow_NothingStated is TestPersonRow_NothingStated for
// characters; a blank age is no age.
func TestCharacterRow_NothingStated(t *testing.T) {
	row := CharacterRow(anilist.CharacterProfile{ID: 9, Age: sp("  ")}, fetchedAt)

	assert.Equal(t, int32(9), row.AnilistID)
	assert.Nil(t, row.NameFull)
	assert.NotNil(t, row.NameAlternative)
	assert.Empty(t, row.NameAlternative)
	assert.NotNil(t, row.NameAlternativeSpoiler)
	assert.Empty(t, row.NameAlternativeSpoiler)
	assert.Nil(t, row.Age)
	assert.Nil(t, row.ImageMedium)
	assert.Nil(t, row.BirthMonth)
	assert.Nil(t, row.Favourites)
}
