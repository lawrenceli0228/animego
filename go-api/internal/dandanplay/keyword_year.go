// Package dandanplay — a release year at the end of a /match keyword.
//
// The library sends the title its parser read from the file name, and a
// release that tags the year ("Hunter x Hunter 2011 S01E05", "… 2026
// S01E11") keeps it: the year is what tells a remake from its original.
// anime_cache titles do not carry the year, and the tokenised ILIKE requires
// every keyword token, so the year is taken off before searching and used
// instead to prefer the entry that premiered that year.

package dandanplay

import (
	"regexp"
	"strconv"
	"strings"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// trailingYearRe matches a 19xx/20xx year as the last word of a keyword
// that has a title before it.
var trailingYearRe = regexp.MustCompile(`^(.*\S)\s+((?:19|20)[0-9]{2})$`)

// splitTrailingYear returns the keyword without a trailing year, and the
// year (0 when there is none).
func splitTrailingYear(keyword string) (string, int32) {
	k := strings.TrimSpace(keyword)
	m := trailingYearRe.FindStringSubmatch(k)
	if m == nil {
		return k, 0
	}
	year, err := strconv.Atoi(m[2])
	if err != nil {
		return k, 0
	}
	return m[1], int32(year)
}

// preferYear keeps the rows that premiered in year when any did, and all
// rows otherwise: a WEB release tags the year it came out, which need not
// be the year AniList files the show under.
func preferYear(rows []dbgen.SearchAnimeCacheForDandanplayRow, year int32) []dbgen.SearchAnimeCacheForDandanplayRow {
	if year == 0 {
		return rows
	}
	kept := make([]dbgen.SearchAnimeCacheForDandanplayRow, 0, len(rows))
	for _, r := range rows {
		if r.SeasonYear != nil && *r.SeasonYear == year {
			kept = append(kept, r)
		}
	}
	if len(kept) == 0 {
		return rows
	}
	return kept
}
