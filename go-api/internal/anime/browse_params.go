package anime

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	browseSortPopularity = "popularity"
	browseSortScore      = "score"

	// browseScoreMinPopularity is how many AniList users must track a
	// title before sort=score ranks it.  Popularity is that count; below
	// a thousand, an average score rests on a handful of ratings, and a
	// handful of 9s would head a ranking above everything people watched.
	browseScoreMinPopularity = 1000

	// browseMinYear and browseMaxYear bound every year a browse request
	// can name: the year key and the yearFrom / yearTo bounds alike.
	browseMinYear = 1900
	browseMaxYear = 2100

	// browseMaxStudioBytes bounds the studio key, well past any studio's
	// name: a longer key names no studio, and could only answer an empty
	// listing.
	browseMaxStudioBytes = 200
)

// browsableGenres are the genres a hub page exists for: every AniList
// genre but Hentai, which the listings exclude.  The order is the one the
// genre page's strip shows (FILTER_GENRES in
// next-app/src/lib/contentLabels.ts).  It bounds the genre overview's
// cache to one entry per genre, the genres a related tile may name and
// the genres /browse lists.
var browsableGenres = []string{
	"Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy",
	"Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological",
	"Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
}

func isBrowsableGenre(g string) bool {
	for _, b := range browsableGenres {
		if g == b {
			return true
		}
	}
	return false
}

// browseStatuses are AniList's MediaStatus values.
var browseStatuses = map[string]bool{
	"RELEASING":        true,
	"FINISHED":         true,
	"NOT_YET_RELEASED": true,
	"CANCELLED":        true,
	"HIATUS":           true,
}

// browseQuery is one /browse listing: exactly one key (genre, studio or
// year) and any of the narrowing filters, NULL meaning "not asked".  It
// is also how the genre overview names its rails, so a rail and the
// listing its "see all" link opens are the same statement with the same
// arguments.
type browseQuery struct {
	genre     *string
	studio    *string
	year      *int32
	withGenre *string
	status    *string
	yearFrom  *int32
	yearTo    *int32
	byScore   bool
}

// parseBrowseQuery reads a browse request's query string.  Exactly one of
// genre / studio / year, or it is a 400: a page keyed by nothing would be
// the whole catalogue, and one keyed by two things is a search, which is
// a different endpoint with a different cache story.  The filters are
// optional, and a value that is present but wrong is a 400 rather than
// ignored, so a typo cannot quietly answer a different listing than the
// one asked for.  Blank values count as absent, as they always have for
// the keys.
func parseBrowseQuery(qs url.Values) (browseQuery, *httpx.APIError) {
	get := func(k string) string {
		if v, ok := qs[k]; ok && len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	key, err := parseBrowseKey(get)
	if err != nil {
		return browseQuery{}, err
	}
	return withBrowseFilters(key, get)
}

// parseBrowseKey reads the one thing the listing is keyed by, and refuses
// a key that cannot name a hub.  A genre must be a browsable one: the
// genre page asks for nothing else, and any other genre -- Hentai among
// them -- could only answer an empty listing.  A studio is free text, but
// it must be text Postgres accepts -- valid UTF-8, no NUL: Postgres
// answers anything else with an error, which the client would see as a
// 500.
func parseBrowseKey(get func(string) string) (browseQuery, *httpx.APIError) {
	var q browseQuery
	keys := 0
	if g := get("genre"); g != "" {
		if !isBrowsableGenre(g) {
			return browseQuery{}, browseInvalid("genre must be a browsable genre")
		}
		q.genre = &g
		keys++
	}
	if s := get("studio"); s != "" {
		if len(s) > browseMaxStudioBytes || !utf8.ValidString(s) || strings.ContainsRune(s, 0) {
			return browseQuery{}, browseInvalid(fmt.Sprintf("studio must be valid UTF-8 without NUL, at most %d bytes", browseMaxStudioBytes))
		}
		q.studio = &s
		keys++
	}
	if y := get("year"); y != "" {
		yr, err := parseYearParam("year", y)
		if err != nil {
			return browseQuery{}, err
		}
		q.year = yr
		keys++
	}
	if keys != 1 {
		return browseQuery{}, browseInvalid("exactly one of genre, studio or year is required")
	}
	return q, nil
}

// withBrowseFilters is key narrowed by the optional filters the request
// names.
func withBrowseFilters(key browseQuery, get func(string) string) (browseQuery, *httpx.APIError) {
	q := key
	if w := get("with"); w != "" {
		switch {
		case q.genre == nil:
			return browseQuery{}, browseInvalid("with requires genre")
		case !isBrowsableGenre(w):
			return browseQuery{}, browseInvalid("with must be a browsable genre")
		case w == *q.genre:
			return browseQuery{}, browseInvalid("with must differ from genre")
		}
		q.withGenre = &w
	}
	if s := get("status"); s != "" {
		if !browseStatuses[s] {
			return browseQuery{}, browseInvalid("invalid status")
		}
		q.status = &s
	}
	var err *httpx.APIError
	if q.yearFrom, err = parseYearParam("yearFrom", get("yearFrom")); err != nil {
		return browseQuery{}, err
	}
	if q.yearTo, err = parseYearParam("yearTo", get("yearTo")); err != nil {
		return browseQuery{}, err
	}
	if q.yearFrom != nil && q.yearTo != nil && *q.yearFrom > *q.yearTo {
		return browseQuery{}, browseInvalid("yearFrom must not be after yearTo")
	}
	switch get("sort") {
	case "", browseSortPopularity:
	case browseSortScore:
		q.byScore = true
	default:
		return browseQuery{}, browseInvalid("sort must be popularity or score")
	}
	return q, nil
}

// parseYearParam is the year a parameter names: nil when it is absent, a
// 400 when it is present and not a year in range.
func parseYearParam(name, raw string) (*int32, *httpx.APIError) {
	if raw == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < browseMinYear || n > browseMaxYear {
		return nil, browseInvalid(fmt.Sprintf("%s must be a year between %d and %d", name, browseMinYear, browseMaxYear))
	}
	yr := int32(n)
	return &yr, nil
}

func browseInvalid(msg string) *httpx.APIError {
	return httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msg)
}

// listParams is the page of q at offset, limit rows long.
func (q browseQuery) listParams(offset, limit int32) dbgen.BrowseAnimeParams {
	return dbgen.BrowseAnimeParams{
		Genre:              q.genre,
		WithGenre:          q.withGenre,
		Studio:             q.studio,
		ReleaseYear:        q.year,
		YearFrom:           q.yearFrom,
		YearTo:             q.yearTo,
		Status:             q.status,
		ByScore:            q.byScore,
		ScoreMinPopularity: browseScoreMinPopularity,
		RowOffset:          offset,
		RowLimit:           limit,
	}
}

// countParams is q's total, under the same WHERE as listParams.
func (q browseQuery) countParams() dbgen.CountBrowseAnimeParams {
	return dbgen.CountBrowseAnimeParams{
		Genre:              q.genre,
		WithGenre:          q.withGenre,
		Studio:             q.studio,
		ReleaseYear:        q.year,
		YearFrom:           q.yearFrom,
		YearTo:             q.yearTo,
		Status:             q.status,
		ByScore:            q.byScore,
		ScoreMinPopularity: browseScoreMinPopularity,
	}
}
