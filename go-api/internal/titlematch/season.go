// Package titlematch — season.go
//
// Season/part marker extraction: the hard-gate half of the two-signal split
// described in the package doc.  Everything here is pure string work over a
// single title; nothing in this file knows about databases or upstream APIs.

package titlematch

import (
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// Marker is the (season, part) pair carried by an anime title.
//
// Zero means "not stated".  NEVER compare two Markers with == : compare them
// with SameEntry, which reads an unstated number as 1 so that "無職転生" and
// "無職転生 第1期" are the same entry while "無職転生Ⅲ" is not.
type Marker struct {
	Season int
	Part   int
}

// Normalized reads an unstated season or part as 1, which is what makes an
// untitled first season comparable to an explicitly numbered one.
func (m Marker) Normalized() Marker {
	out := m
	if out.Season == 0 {
		out.Season = 1
	}
	if out.Part == 0 {
		out.Part = 1
	}
	return out
}

// Merge keeps the highest stated number from either marker.  Used to fold an
// entry's several titles into one marker: markers are additive information,
// and absence in one title (an English title that drops the "Ⅲ") must not
// erase a number another title states.
func (m Marker) Merge(other Marker) Marker {
	out := m
	if other.Season > out.Season {
		out.Season = other.Season
	}
	if other.Part > out.Part {
		out.Part = other.Part
	}
	return out
}

// SameEntry reports whether two markers describe the same season and part.
// This is the only correct way to compare Markers — raw == would read an
// unstated season as different from an explicit season 1.
func (m Marker) SameEntry(other Marker) bool {
	return m.Normalized() == other.Normalized()
}

var (
	// 第二季 / 第2期 / 第三季 — CJK ordinal seasons.
	cjkSeasonRe = regexp.MustCompile(`第\s*([0-9]+|[一二三四五六七八九十])\s*[季期]`)
	// season 2 / season2
	enSeasonRe = regexp.MustCompile(`season\s*([0-9]+)`)
	// 2nd season / 3rd season
	enOrdinalSeasonRe = regexp.MustCompile(`([0-9]+)(?:st|nd|rd|th)\s*season`)
	// Bare roman numeral run as a season suffix.  NFKC has already folded
	// Ⅲ (U+2162) to "III" by the time this runs.  Longest-first so "iii"
	// can't be clipped to "ii".  "i", "v" and "x" are deliberately absent:
	// they collide with real words and titles ("Hunter x Hunter").
	romanSeasonRe = regexp.MustCompile(`\b(viii|vii|iii|vi|iv|ix|ii)\b`)

	// 第2部分 / 第二部分 / 第2クール — CJK part-within-season markers.
	cjkPartRe = regexp.MustCompile(`第\s*([0-9]+|[一二三四五六七八九十])\s*(?:部分|クール|部)`)
	// part 2 / part ii / cour 2
	enPartRe = regexp.MustCompile(`\b(?:part|cour)\s*([0-9]+|viii|vii|iii|vi|iv|ix|ii)\b`)
)

// cjkNumerals maps the CJK numerals that realistically appear as season
// or part ordinals.  Beyond 十 the forms get compound and no anime needs
// it, so the map stops there.
var cjkNumerals = map[string]int{
	"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
	"六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
}

// romanNumerals maps the lowercase ASCII roman runs the two roman
// patterns can capture.
var romanNumerals = map[string]int{
	"ii": 2, "iii": 3, "iv": 4, "vi": 6, "vii": 7, "viii": 8, "ix": 9,
}

// parseOrdinal reads one captured ordinal in any of the three notations
// the patterns above can yield.  Returns 0 when unparseable.
func parseOrdinal(s string) int {
	if s == "" {
		return 0
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	if n, ok := cjkNumerals[s]; ok {
		return n
	}
	return romanNumerals[s]
}

// firstOrdinal runs the patterns in order and returns the first ordinal
// any of them yields.
func firstOrdinal(s string, patterns ...*regexp.Regexp) int {
	for _, re := range patterns {
		if m := re.FindStringSubmatch(s); m != nil {
			if n := parseOrdinal(m[1]); n > 0 {
				return n
			}
		}
	}
	return 0
}

// ExtractMarker pulls the season and part ordinals out of a title.
//
// Input is NFKC-folded and lowercased first, which is what makes the
// roman-numeral patterns work uniformly: NFKC turns Ⅲ into "III", full-
// width digits into ASCII, and the fullwidth tilde into "~".
//
// Part markers are read BEFORE season markers strip anything, because
// "第2クール" must count as part 2 and not season 2 — dandanplay and
// AniList both split a long season into cours under the same season
// number ("無職転生Ⅱ … 第2クール" is season 2, part 2).
func ExtractMarker(title string) Marker {
	if title == "" {
		return Marker{}
	}
	s := strings.ToLower(norm.NFKC.String(title))

	part := firstOrdinal(s, cjkPartRe, enPartRe)

	// Remove the part marker before scanning for a season so that the
	// digit inside "第2クール" cannot be re-read as "第2季".
	seasonSrc := cjkPartRe.ReplaceAllString(s, " ")
	seasonSrc = enPartRe.ReplaceAllString(seasonSrc, " ")
	season := firstOrdinal(seasonSrc, cjkSeasonRe, enSeasonRe, enOrdinalSeasonRe, romanSeasonRe)

	return Marker{Season: season, Part: part}
}

// MarkerFor folds every title of ONE entry into a single marker.
//
// Pass all the titles an entry carries (Chinese, native, romaji, English —
// or an AniList native/romaji pair).  Do not pass titles from different
// entries: Merge keeps the highest stated number, so mixing entries would
// invent a season neither of them has.
func MarkerFor(titles ...string) Marker {
	var m Marker
	for _, t := range titles {
		m = m.Merge(ExtractMarker(t))
	}
	return m
}

// SeasonsAgree reports whether two titles state the same season and part.
// It is the season half of the identity question, deliberately separate
// from Similarity — see the package doc for why they must not be combined.
//
// For a caller holding several titles of one entry, fold that side with
// MarkerFor first and compare with SameEntry.
func SeasonsAgree(a, b string) bool {
	return ExtractMarker(a).SameEntry(ExtractMarker(b))
}
