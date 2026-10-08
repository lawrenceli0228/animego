package people

import (
	"cmp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// workColumns is the anime_cache projection every query here selects for a
// title, under the names sqlc gives them.  One constructor reads it, so the
// three row types cannot each make their own Work.
type workColumns struct {
	id            int32
	titleRomaji   *string
	titleEnglish  *string
	titleNative   *string
	titleChinese  *string
	titleHant     *string
	titleHantSeo  *string
	coverImageURL *string
	format        *string
	seasonYear    *int32
	startDate     pgtype.Date
	popularity    *int32
	posterAccent  *string
}

// newWork builds a Work.  Year is the start date's, falling back to the
// season year: AniList stores a full start date only once it is known, and
// a title announced for "2026" has a season year and nothing else.
func newWork(c workColumns) Work {
	w := Work{
		AnilistID:     c.id,
		TitleRomaji:   c.titleRomaji,
		TitleEnglish:  c.titleEnglish,
		TitleNative:   c.titleNative,
		TitleChinese:  c.titleChinese,
		TitleHant:     c.titleHant,
		TitleHantSeo:  c.titleHantSeo,
		CoverImageURL: c.coverImageURL,
		Format:        c.format,
		Year:          c.seasonYear,
		Popularity:    c.popularity,
		PosterAccent:  c.posterAccent,
	}
	if c.startDate.Valid {
		w.startDate = c.startDate.Time
		y := int32(c.startDate.Time.Year())
		w.Year = &y
	}
	return w
}

// compareWorksNewestFirst orders titles the way a timeline reads: a title
// with no year at all first (it is announced, not old -- AniList dates a
// title as soon as it has aired), then by year descending; inside a year,
// dated titles newest first and the ones with only a season year after
// them, more popular first; the id settles anything left.
func compareWorksNewestFirst(a, b Work) int {
	if c := compareYearsNewestFirst(a.Year, b.Year); c != 0 {
		return c
	}
	if c := compareDatesNewestFirst(a.startDate, b.startDate); c != 0 {
		return c
	}
	if c := comparePopularity(a.Popularity, b.Popularity); c != 0 {
		return c
	}
	return cmp.Compare(a.AnilistID, b.AnilistID)
}

// compareWorksEarliestFirst is the order a filmography reads in: by date,
// earliest first, undated titles last.
func compareWorksEarliestFirst(a, b Work) int {
	switch {
	case a.Year == nil && b.Year != nil:
		return 1
	case a.Year != nil && b.Year == nil:
		return -1
	case a.Year != nil && b.Year != nil && *a.Year != *b.Year:
		return cmp.Compare(*a.Year, *b.Year)
	}
	switch {
	case a.startDate.IsZero() && !b.startDate.IsZero():
		return 1
	case !a.startDate.IsZero() && b.startDate.IsZero():
		return -1
	case !a.startDate.Equal(b.startDate):
		return a.startDate.Compare(b.startDate)
	}
	return cmp.Compare(a.AnilistID, b.AnilistID)
}

func compareYearsNewestFirst(a, b *int32) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return -1
	case b == nil:
		return 1
	default:
		return cmp.Compare(*b, *a)
	}
}

func compareDatesNewestFirst(a, b time.Time) int {
	switch {
	case a.IsZero() && b.IsZero():
		return 0
	case a.IsZero():
		return 1
	case b.IsZero():
		return -1
	default:
		return b.Compare(a)
	}
}

// comparePopularity puts the more popular title first, an unknown last.
func comparePopularity(a, b *int32) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	default:
		return cmp.Compare(*b, *a)
	}
}

// sameYear reports whether two years are the same group: both unknown, or
// both the same number.
func sameYear(a, b *int32) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// anilistMediumSegments are the path segments of AniList's CDN that have a
// large twin at the same file name.
var anilistMediumSegments = []string{"/anilistcdn/character/medium/", "/anilistcdn/staff/medium/"}

// largeImage turns an AniList medium portrait into the large one.
//
// The credit rows store AniList's medium image (100x150), which the old
// credit lines were drawn at; these pages draw portraits at up to 230x345,
// AniList's large size, which lives at the same file name under /large/.
// Only that CDN's own paths are rewritten: a Bangumi image (a credit's
// voice can carry one) or anything else passes through untouched.  Blank
// is no image.
func largeImage(url *string) *string {
	if url == nil {
		return nil
	}
	u := strings.TrimSpace(*url)
	if u == "" {
		return nil
	}
	if strings.HasPrefix(u, "https://s4.anilist.co/") {
		for _, seg := range anilistMediumSegments {
			if strings.Contains(u, seg) {
				u = strings.Replace(u, seg, strings.Replace(seg, "/medium/", "/large/", 1), 1)
				break
			}
		}
	}
	return &u
}

// fuzzyDate assembles a FuzzyDate, or nil when no part is known.
func fuzzyDate(year, month, day *int32) *FuzzyDate {
	if year == nil && month == nil && day == nil {
		return nil
	}
	return &FuzzyDate{Year: year, Month: month, Day: day}
}

// text returns s trimmed, or nil when there is nothing in it.
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

// firstText is the first of vals with something in it.
func firstText(vals ...*string) *string {
	for _, v := range vals {
		if t := text(v); t != nil {
			return t
		}
	}
	return nil
}

// alternativeNames is a profile's alternative names without the ones the
// page already shows as a name, without blanks and repeats, in AniList's
// order.  Never nil.
func alternativeNames(alternatives []string, shown Name) []string {
	seen := map[string]bool{}
	for _, n := range []*string{shown.Full, shown.Native, shown.Cn} {
		if n != nil {
			seen[*n] = true
		}
	}
	out := []string{}
	for _, a := range alternatives {
		a = strings.TrimSpace(a)
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, a)
	}
	return out
}
