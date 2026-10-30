package anime

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// topSize is the length of a ranking: a Top 100.
const topSize = 100

// topFormats are the AniList MediaFormat values a ranking can be cut to:
// every anime format but MUSIC, which no ranking holds (see top.sql).
var topFormats = map[string]bool{
	"TV":       true,
	"TV_SHORT": true,
	"MOVIE":    true,
	"ONA":      true,
	"OVA":      true,
	"SPECIAL":  true,
}

// topSeasons are AniList's MediaSeason values.
var topSeasons = map[string]bool{
	"WINTER": true,
	"SPRING": true,
	"SUMMER": true,
	"FALL":   true,
}

// topQuery is one ranking: the all-time one, or one year's, cut to any of
// a format, a season of that year and a genre -- NULL meaning "not asked".
type topQuery struct {
	year   *int32
	format *string
	season *string
	genre  *string
}

// parseTopQuery reads a /top request's query string.  Every parameter is
// optional, and a value that is present but wrong is a 400 rather than
// ignored, as on /browse: a typo must not quietly answer a different
// ranking than the one asked for.  The values are AniList's own spellings
// (FALL, MOVIE, Slice of Life), matched exactly against fixed tables, so
// nothing a request sends reaches the statement, or the cache key, without
// being one of them.  Blank values count as absent.
//
// A season is a quarter of one year, so it needs a year: "every autumn
// since 1960" is not a ranking any page shows.
func parseTopQuery(qs url.Values) (topQuery, *httpx.APIError) {
	get := func(k string) string {
		if v, ok := qs[k]; ok && len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	var (
		q   topQuery
		err *httpx.APIError
	)
	if q.year, err = parseYearParam("year", get("year")); err != nil {
		return topQuery{}, err
	}
	if f := get("format"); f != "" {
		if !topFormats[f] {
			return topQuery{}, browseInvalid("format must be one of TV, TV_SHORT, MOVIE, ONA, OVA or SPECIAL")
		}
		q.format = &f
	}
	if s := get("season"); s != "" {
		if !topSeasons[s] {
			return topQuery{}, browseInvalid("season must be one of WINTER, SPRING, SUMMER or FALL")
		}
		if q.year == nil {
			return topQuery{}, browseInvalid("season requires year")
		}
		q.season = &s
	}
	if g := get("genre"); g != "" {
		if !isBrowsableGenre(g) {
			return topQuery{}, browseInvalid("genre must be a browsable genre")
		}
		q.genre = &g
	}
	return q, nil
}

// key is q's cache key.  Every part has been checked against a fixed
// table or parsed as a year, so the key set is bounded by those tables.
func (q topQuery) key() string {
	year := ""
	if q.year != nil {
		year = strconv.Itoa(int(*q.year))
	}
	return fmt.Sprintf("y=%s|f=%s|s=%s|g=%s", year, orEmpty(q.format), orEmpty(q.season), orEmpty(q.genre))
}

// params is q as TopAnime's arguments.
func (q topQuery) params() dbgen.TopAnimeParams {
	return dbgen.TopAnimeParams{
		MinPopularity: browseScoreMinPopularity,
		ReleaseYear:   q.year,
		Format:        q.format,
		Season:        q.season,
		Genre:         q.genre,
		RowLimit:      topSize,
	}
}

func orEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
