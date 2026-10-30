package anime

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// TestParseTopQuery_Accepts — every parameter optional, AniList's own
// spellings, blank values as absent, surrounding space ignored, and
// parameters /top does not read (a page number, say) left alone.
func TestParseTopQuery_Accepts(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		qs                    string
		year                  *int32
		format, season, genre *string
	}{
		{qs: ""},
		{qs: "year=&format=&season=&genre="},
		{qs: "page=3&perPage=50&sort=popularity"},
		{qs: "year=2024", year: i32(2024)},
		{qs: "year=+2024+", year: i32(2024)},
		{qs: "year=1900", year: i32(1900)},
		{qs: "year=2100", year: i32(2100)},
		{qs: "format=TV", format: sptr("TV")},
		{qs: "format=TV_SHORT", format: sptr("TV_SHORT")},
		{qs: "format=MOVIE", format: sptr("MOVIE")},
		{qs: "format=ONA", format: sptr("ONA")},
		{qs: "format=OVA", format: sptr("OVA")},
		{qs: "format=SPECIAL", format: sptr("SPECIAL")},
		{qs: "genre=Slice%20of%20Life", genre: sptr("Slice of Life")},
		{qs: "genre=Sci-Fi&format=MOVIE", format: sptr("MOVIE"), genre: sptr("Sci-Fi")},
		{qs: "year=2024&season=WINTER", year: i32(2024), season: sptr("WINTER")},
		{qs: "year=2024&season=FALL&format=MOVIE&genre=Drama", year: i32(2024), format: sptr("MOVIE"), season: sptr("FALL"), genre: sptr("Drama")},
		{qs: "year=2024&season=", year: i32(2024)},
	} {
		t.Run(tc.qs, func(t *testing.T) {
			q, apiErr := parseTopQuery(mustParseQuery(t, tc.qs))
			require.Nil(t, apiErr)
			assert.Equal(t, topQuery{year: tc.year, format: tc.format, season: tc.season, genre: tc.genre}, q)
		})
	}
}

// TestParseTopQuery_Refuses — a value that is present but names no
// ranking is a 400, before anything is read: lower case, a format no
// ranking holds, a season without its year, a genre that is not a hub,
// and the names JavaScript objects inherit, which a lookup table written
// carelessly in the other half of this site would have let through.
func TestParseTopQuery_Refuses(t *testing.T) {
	t.Parallel()

	const (
		badYear   = "year must be a year between 1900 and 2100"
		badFormat = "format must be one of TV, TV_SHORT, MOVIE, ONA, OVA or SPECIAL"
		badSeason = "season must be one of WINTER, SPRING, SUMMER or FALL"
		noYear    = "season requires year"
		badGenre  = "genre must be a browsable genre"
	)
	for _, tc := range []struct{ qs, msg string }{
		{"year=abc", badYear},
		{"year=1899", badYear},
		{"year=2101", badYear},
		{"year=2024.0", badYear},
		{"year=-2024", badYear},
		{"year=constructor", badYear},
		{"format=tv", badFormat},
		{"format=Movie", badFormat},
		{"format=MUSIC", badFormat},
		{"format=MANGA", badFormat},
		{"format=constructor", badFormat},
		{"format=__proto__", badFormat},
		{"format=toString", badFormat},
		{"format=hasOwnProperty", badFormat},
		{"season=FALL", noYear},
		{"season=FALL&format=TV", noYear},
		{"season=fall&year=2024", badSeason},
		{"season=AUTUMN&year=2024", badSeason},
		{"season=constructor&year=2024", badSeason},
		{"season=__proto__", badSeason},
		{"genre=Hentai", badGenre},
		{"genre=action", badGenre},
		{"genre=slice-of-life", badGenre},
		{"genre=Isekai", badGenre},
		{"genre=constructor", badGenre},
		{"genre=__proto__", badGenre},
		{"genre=valueOf", badGenre},
	} {
		t.Run(tc.qs, func(t *testing.T) {
			_, apiErr := parseTopQuery(mustParseQuery(t, tc.qs))
			require.NotNil(t, apiErr)
			assert.Equal(t, http.StatusBadRequest, apiErr.Status)
			assert.Equal(t, tc.msg, apiErr.Message)
		})
	}
}

// TestTopQuery_KeyIsCanonical — the cache key is the ranking, not the
// query string: the order parameters arrive in, blank ones and ones /top
// does not read change nothing, and two different rankings never share a
// key.
func TestTopQuery_KeyIsCanonical(t *testing.T) {
	t.Parallel()

	key := func(qs string) string {
		q, apiErr := parseTopQuery(mustParseQuery(t, qs))
		require.Nil(t, apiErr, qs)
		return q.key()
	}
	assert.Equal(t, "y=|f=|s=|g=", key(""))
	assert.Equal(t, key(""), key("year=&genre=&page=4"))
	assert.Equal(t, "y=2024|f=MOVIE|s=FALL|g=Slice of Life", key("year=2024&format=MOVIE&season=FALL&genre=Slice%20of%20Life"))
	assert.Equal(t, key("year=2024&format=MOVIE&season=FALL&genre=Drama"), key("genre=Drama&season=FALL&format=MOVIE&year=2024"))

	distinct := []string{
		"", "year=2024", "year=2025", "format=TV", "format=TV_SHORT", "genre=Drama",
		"year=2024&season=FALL", "year=2024&season=SPRING", "year=2024&format=TV", "year=2024&genre=Drama",
		"format=TV&genre=Drama",
	}
	seen := map[string]string{}
	for _, qs := range distinct {
		k := key(qs)
		if prev, dup := seen[k]; dup {
			t.Fatalf("%q and %q share the key %q", prev, qs, k)
		}
		seen[k] = qs
	}
}

// TestTopQuery_Params — the statement's arguments: the filters as parsed,
// /browse's sort=score floor, and a hundred rows.
func TestTopQuery_Params(t *testing.T) {
	t.Parallel()

	q, apiErr := parseTopQuery(mustParseQuery(t, "year=2024&season=FALL&format=MOVIE&genre=Drama"))
	require.Nil(t, apiErr)
	assert.Equal(t, dbgen.TopAnimeParams{
		MinPopularity: 1000,
		ReleaseYear:   i32(2024),
		Format:        sptr("MOVIE"),
		Season:        sptr("FALL"),
		Genre:         sptr("Drama"),
		RowLimit:      100,
	}, q.params())

	all, apiErr := parseTopQuery(mustParseQuery(t, ""))
	require.Nil(t, apiErr)
	assert.Equal(t, dbgen.TopAnimeParams{MinPopularity: browseScoreMinPopularity, RowLimit: topSize}, all.params())
}

// TestTopFormats_AreEveryAnimeFormatButMusic — the format chips' values,
// and the one no ranking holds.
func TestTopFormats_AreEveryAnimeFormatButMusic(t *testing.T) {
	t.Parallel()

	assert.Len(t, topFormats, 6)
	for _, f := range []string{"TV", "TV_SHORT", "MOVIE", "ONA", "OVA", "SPECIAL"} {
		assert.True(t, topFormats[f], f)
	}
	assert.False(t, topFormats["MUSIC"])
	assert.Len(t, topSeasons, 4)
}
