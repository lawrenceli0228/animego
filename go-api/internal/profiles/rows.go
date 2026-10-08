// Package profiles turns AniList's profiles of people (Staff) and
// characters into the rows the people and characters tables hold
// (migration 0044), and writes them.
//
// The one writer is the profiles sweep (internal/queue/profiles.go).  The
// rules live here rather than in the queue package for the reason
// internal/credits exists: they are what a row means, and whatever reads
// these tables later -- a person page, a character page -- has to agree
// with them about what a NULL, an empty list or a missing year says.
//
// The rules, in one place:
//
//   - AniList's profiles are user-edited.  A blank string is an absence;
//     names and short fields are trimmed; list entries are trimmed, and
//     nulls, blanks and repeats dropped, in AniList's order.
//   - The description is stored as it comes -- AniList's markdown, spoiler
//     markers (~!...!~) and surrounding whitespace included -- unless there
//     is nothing in it.
//   - A FuzzyDate is kept part by part.  A part that is not a calendar
//     value (month 13, day 0, year 0) is dropped on its own; the columns'
//     CHECKs restate these rules, and one refused row would fail the
//     batch's whole transaction.
//   - yearsActive is positional ([first] or [first, last]), so it is kept
//     up to the first entry that is not a year rather than filtered.
//   - Lists are never nil: the columns are NOT NULL '{}'.
package profiles

import (
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// PersonRow projects one AniList Staff profile onto a people row, fetched
// at fetchedAt.
func PersonRow(s anilist.StaffProfile, fetchedAt time.Time) dbgen.UpsertPersonParams {
	var full, native *string
	var alternative []*string
	if s.Name != nil {
		full, native, alternative = s.Name.Full, s.Name.Native, s.Name.Alternative
	}
	large, medium := imageURLs(s.Image)
	birthYear, birthMonth, birthDay := dateParts(s.DateOfBirth)
	deathYear, deathMonth, deathDay := dateParts(s.DateOfDeath)
	return dbgen.UpsertPersonParams{
		AnilistID:          int32(s.ID),
		NameFull:           text(full),
		NameNative:         text(native),
		NameAlternative:    texts(alternative),
		Language:           text(s.LanguageV2),
		ImageLarge:         large,
		ImageMedium:        medium,
		Description:        description(s.Description),
		PrimaryOccupations: texts(s.PrimaryOccupations),
		Gender:             text(s.Gender),
		BirthYear:          birthYear,
		BirthMonth:         birthMonth,
		BirthDay:           birthDay,
		DeathYear:          deathYear,
		DeathMonth:         deathMonth,
		DeathDay:           deathDay,
		Age:                positive(s.Age),
		YearsActive:        yearsActive(s.YearsActive),
		HomeTown:           text(s.HomeTown),
		BloodType:          text(s.BloodType),
		Favourites:         number(s.Favourites),
		SiteUrl:            text(s.SiteURL),
		FetchedAt:          pgtype.Timestamptz{Time: fetchedAt, Valid: true},
	}
}

// CharacterRow projects one AniList Character profile onto a characters
// row, fetched at fetchedAt.
func CharacterRow(c anilist.CharacterProfile, fetchedAt time.Time) dbgen.UpsertCharacterParams {
	var full, native *string
	var alternative, spoiler []*string
	if c.Name != nil {
		full, native = c.Name.Full, c.Name.Native
		alternative, spoiler = c.Name.Alternative, c.Name.AlternativeSpoiler
	}
	large, medium := imageURLs(c.Image)
	birthYear, birthMonth, birthDay := dateParts(c.DateOfBirth)
	return dbgen.UpsertCharacterParams{
		AnilistID:              int32(c.ID),
		NameFull:               text(full),
		NameNative:             text(native),
		NameAlternative:        texts(alternative),
		NameAlternativeSpoiler: texts(spoiler),
		ImageLarge:             large,
		ImageMedium:            medium,
		Description:            description(c.Description),
		Gender:                 text(c.Gender),
		BirthYear:              birthYear,
		BirthMonth:             birthMonth,
		BirthDay:               birthDay,
		Age:                    text(c.Age),
		BloodType:              text(c.BloodType),
		Favourites:             number(c.Favourites),
		SiteUrl:                text(c.SiteURL),
		FetchedAt:              pgtype.Timestamptz{Time: fetchedAt, Valid: true},
	}
}

// text trims a short field; blank is an absence.
func text(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

// description keeps a description exactly as AniList sent it, unless there
// is nothing in it.
func description(s *string) *string {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	d := *s
	return &d
}

// texts cleans a list of short fields: trimmed, with nulls, blanks and
// repeats dropped, in AniList's order.  Never nil.
func texts(in []*string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, s := range in {
		t := text(s)
		if t == nil {
			continue
		}
		if _, dup := seen[*t]; dup {
			continue
		}
		seen[*t] = struct{}{}
		out = append(out, *t)
	}
	return out
}

// imageURLs reads an image object's two sizes.
func imageURLs(img *anilist.Image) (large, medium *string) {
	if img == nil {
		return nil, nil
	}
	return text(img.Large), text(img.Medium)
}

// dateParts splits a FuzzyDate into its three columns, dropping any part
// that is not a calendar value on its own: a year that is not positive, a
// month outside 1-12, a day outside 1-31.  The columns' CHECKs say the
// same for months and days.
func dateParts(d *anilist.FuzzyDate) (year, month, day *int32) {
	if d == nil {
		return nil, nil, nil
	}
	return inRange(d.Year, 1, maxInt32), inRange(d.Month, 1, 12), inRange(d.Day, 1, 31)
}

// yearsActive keeps AniList's [first] or [first, last] up to the first
// entry that is not a year.  Skipping a bad first year instead would move
// the last year into the first place and turn "until 2014" into "since
// 2014".  Never nil.
func yearsActive(in []*int) []int32 {
	out := make([]int32, 0, len(in))
	for _, y := range in {
		v := inRange(y, 1, maxInt32)
		if v == nil {
			break
		}
		out = append(out, *v)
	}
	return out
}

// positive narrows a figure that only means something above zero.
func positive(n *int) *int32 { return inRange(n, 1, maxInt32) }

// number narrows a count, where zero is a real answer.
func number(n *int) *int32 { return inRange(n, 0, maxInt32) }

const maxInt32 = 1<<31 - 1

// inRange narrows n to an int32 when lo <= n <= hi, and to nil otherwise.
func inRange(n *int, lo, hi int) *int32 {
	if n == nil || *n < lo || *n > hi {
		return nil
	}
	v := int32(*n)
	return &v
}
