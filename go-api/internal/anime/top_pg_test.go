package anime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// topSeed is one title of the catalogue the ranking tests seed, as plain
// facts, so the expected rankings are worked out in Go (topOracle) rather
// than by the SQL under test.
type topSeed struct {
	id         int32
	format     *string
	season     *string
	seasonYear *int
	start      *time.Time
	score      *int
	pop        *int
	genres     []string
	adult      bool
}

func (s topSeed) has(genre string) bool {
	for _, g := range s.genres {
		if g == genre {
			return true
		}
	}
	return false
}

// ranked is the rule: not adult by the flag or the genre, a score above
// zero, at least the floor of users, not a music video.
func (s topSeed) ranked() bool {
	return !s.adult && !s.has("Hentai") &&
		s.score != nil && *s.score > 0 &&
		s.pop != nil && *s.pop >= browseScoreMinPopularity &&
		(s.format == nil || *s.format != "MUSIC")
}

// releaseYear is the season's year, else the start date's.
func (s topSeed) releaseYear() (int, bool) {
	if s.seasonYear != nil {
		return *s.seasonYear, true
	}
	if s.start != nil {
		return s.start.Year(), true
	}
	return 0, false
}

func (s topSeed) media() anilist.Media {
	m := anilist.Media{
		ID:           int(s.id),
		Title:        &anilist.Title{Romaji: sptr(fmt.Sprintf("Ranked %d", s.id))},
		Format:       s.format,
		Status:       sptr("FINISHED"),
		Genres:       s.genres,
		Popularity:   s.pop,
		AverageScore: s.score,
		Season:       s.season,
		SeasonYear:   s.seasonYear,
		IsAdult:      func() *bool { b := s.adult; return &b }(),
		CoverImage:   &anilist.CoverImage{Large: sptr(fmt.Sprintf("https://img.example/top/%d.jpg", s.id))},
	}
	if s.start != nil {
		m.StartDate = &anilist.FuzzyDate{Year: iptr(s.start.Year()), Month: iptr(int(s.start.Month())), Day: iptr(s.start.Day())}
	}
	return m
}

// The titles placed to trip one rule each.  The excluded ones carry the
// best scores and the most users in the catalogue, in 2023's autumn and in
// genres the filters ask for, so any ranking that let one in would show it
// first.
const (
	topAdult       = 6001
	topHentai      = 6002
	topMusic       = 6003
	topUnpopular   = 6004 // 999 users: one short of the floor
	topUnscored    = 6005
	topZeroScore   = 6006
	topNoFormat    = 6007 // no format at all: ranked, and first
	topAtTheFloor  = 6008 // exactly the floor: ranked
	topTieLowID    = 6010 // 95 and 7000 users, like 6011: the id decides
	topTieHighID   = 6011
	topTieMorePop  = 6012 // 95 too, more users: first of the three
	topFilmByStart = 6013 // no season: its start date's year, 2023
	topNoYear      = 6014 // no year at all: all time only
	topWinterStart = 6015 // WINTER 2022 that began in December 2021: 2022's
)

// topCatalogue is a hundred and thirty ordinary titles -- more than one
// ranking holds -- with every attribute a ranking reads varied, and the
// titles above.
func topCatalogue() []topSeed {
	formats := []*string{sptr("TV"), sptr("MOVIE"), sptr("ONA"), sptr("OVA"), sptr("SPECIAL"), sptr("TV_SHORT"), nil}
	seasons := []string{"WINTER", "SPRING", "SUMMER", "FALL"}
	genres := []string{"Action", "Drama", "Comedy", "Romance", "Slice of Life"}

	var out []topSeed
	for i := 1; i <= 130; i++ {
		s := topSeed{id: int32(5000 + i), format: formats[i%len(formats)]}
		year := 2020 + i%5
		if s.format != nil && *s.format == "MOVIE" && i%2 == 0 {
			d := time.Date(year, time.Month(1+i%12), 9, 0, 0, 0, 0, time.UTC)
			s.start = &d
		} else {
			season := seasons[i%len(seasons)]
			s.season = &season
			s.seasonYear = iptr(year)
		}
		// 55..94, three or four titles on each score.
		s.score = iptr(55 + (i*7)%40)
		s.pop = iptr(1000 + (i*977)%40000)
		s.genres = []string{genres[i%len(genres)]}
		if i%3 == 0 {
			s.genres = append(s.genres, genres[(i+2)%len(genres)])
		}
		out = append(out, s)
	}

	fall := func(s topSeed) topSeed {
		s.season, s.seasonYear = sptr("FALL"), iptr(2023)
		return s
	}
	tv := sptr("TV")
	return append(out,
		fall(topSeed{id: topAdult, format: tv, score: iptr(99), pop: iptr(90000), genres: []string{"Action", "Drama"}, adult: true}),
		fall(topSeed{id: topHentai, format: tv, score: iptr(99), pop: iptr(90000), genres: []string{"Drama", "Hentai"}}),
		fall(topSeed{id: topMusic, format: sptr("MUSIC"), score: iptr(99), pop: iptr(90000), genres: []string{"Drama"}}),
		fall(topSeed{id: topUnpopular, format: tv, score: iptr(99), pop: iptr(browseScoreMinPopularity - 1), genres: []string{"Drama"}}),
		fall(topSeed{id: topUnscored, format: tv, score: nil, pop: iptr(90000), genres: []string{"Drama"}}),
		fall(topSeed{id: topZeroScore, format: tv, score: iptr(0), pop: iptr(90000), genres: []string{"Drama"}}),
		fall(topSeed{id: topNoFormat, format: nil, score: iptr(97), pop: iptr(5000), genres: []string{"Drama"}}),
		fall(topSeed{id: topAtTheFloor, format: tv, score: iptr(96), pop: iptr(browseScoreMinPopularity), genres: []string{"Drama"}}),
		fall(topSeed{id: topTieLowID, format: tv, score: iptr(95), pop: iptr(7000), genres: []string{"Action"}}),
		fall(topSeed{id: topTieHighID, format: tv, score: iptr(95), pop: iptr(7000), genres: []string{"Action"}}),
		fall(topSeed{id: topTieMorePop, format: tv, score: iptr(95), pop: iptr(8000), genres: []string{"Action"}}),
		topSeed{id: topFilmByStart, format: sptr("MOVIE"), score: iptr(94), pop: iptr(6000), genres: []string{"Drama"},
			start: func() *time.Time { d := time.Date(2023, 8, 9, 0, 0, 0, 0, time.UTC); return &d }()},
		topSeed{id: topNoYear, format: tv, score: iptr(93), pop: iptr(6000), genres: []string{"Comedy"}},
		topSeed{id: topWinterStart, format: tv, score: iptr(92), pop: iptr(6000), genres: []string{"Romance"},
			season: sptr("WINTER"), seasonYear: iptr(2022),
			start: func() *time.Time { d := time.Date(2021, 12, 30, 0, 0, 0, 0, time.UTC); return &d }()},
	)
}

// topOracleQuery is a /top request as the oracle reads it.
type topOracleQuery struct {
	year                  *int
	format, season, genre string
}

// topOracle is what a ranking should hold, in order: the ranked titles
// the filters keep, by score, then users, then id, cut to topSize.
func topOracle(seeds []topSeed, q topOracleQuery) []int32 {
	var keep []topSeed
	for _, s := range seeds {
		if !s.ranked() {
			continue
		}
		if q.year != nil {
			if y, ok := s.releaseYear(); !ok || y != *q.year {
				continue
			}
		}
		if q.format != "" && (s.format == nil || *s.format != q.format) {
			continue
		}
		if q.season != "" && (s.season == nil || *s.season != q.season) {
			continue
		}
		if q.genre != "" && !s.has(q.genre) {
			continue
		}
		keep = append(keep, s)
	}
	sort.Slice(keep, func(i, j int) bool {
		a, b := keep[i], keep[j]
		if *a.score != *b.score {
			return *a.score > *b.score
		}
		if *a.pop != *b.pop {
			return *a.pop > *b.pop
		}
		return a.id < b.id
	})
	if len(keep) > topSize {
		keep = keep[:topSize]
	}
	ids := make([]int32, 0, len(keep))
	for _, s := range keep {
		ids = append(ids, s.id)
	}
	return ids
}

// seedTopCatalogue seeds topCatalogue into a fresh database and returns
// the pool, the database's URI and the seeds.
func seedTopCatalogue(t *testing.T) (*pgxpool.Pool, string, []topSeed) {
	t.Helper()
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	detail, err := NewDetailService(dbgen.New(pool), nil)
	require.NoError(t, err)
	t.Cleanup(detail.Close)

	seeds := topCatalogue()
	for _, s := range seeds {
		require.NoError(t, detail.upsertFromMedia(ctx, s.id, s.media()), "seed %d", s.id)
	}
	// The seeds' facts are what the rows hold: a score of zero stays zero,
	// a missing format stays missing.
	var zero float64
	var format *string
	require.NoError(t, pool.QueryRow(ctx, "SELECT average_score FROM anime_cache WHERE anilist_id = $1", topZeroScore).Scan(&zero))
	require.Zero(t, zero)
	require.NoError(t, pool.QueryRow(ctx, "SELECT format FROM anime_cache WHERE anilist_id = $1", topNoFormat).Scan(&format))
	require.Nil(t, format)

	_, err = pool.Exec(ctx, "ANALYZE anime_cache, anime_genres, anime_studios")
	require.NoError(t, err)
	return pool, uri, seeds
}

// topRanking is one /top response, decoded.
type topRanking struct {
	ids   []int32
	ranks []int
	items []json.RawMessage
}

func topRead(t *testing.T, h http.Handler, query string) topRanking {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/top?"+query, nil))
	require.Equal(t, http.StatusOK, rec.Code, "%s: %s", query, rec.Body.String())
	var env struct {
		Data []json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	out := topRanking{ids: []int32{}, ranks: []int{}}
	for _, raw := range env.Data {
		var it struct {
			AnilistID int32 `json:"anilistId"`
			Rank      int   `json:"rank"`
		}
		require.NoError(t, json.Unmarshal(raw, &it))
		out.ids = append(out.ids, it.AnilistID)
		out.ranks = append(out.ranks, it.Rank)
		out.items = append(out.items, raw)
	}
	return out
}

// TestTop_PG_Rankings — every filter, alone and together, over a real
// Postgres against the oracle: which titles, in which order, numbered
// 1..n with no gaps, never more than a hundred, and never one of the
// titles the rule leaves out.
func TestTop_PG_Rankings(t *testing.T) {
	pool, _, seeds := seedTopCatalogue(t)
	c, err := NewTopCache()
	require.NoError(t, err)
	t.Cleanup(c.Close)
	h := Top(dbgen.New(pool), c)

	y := func(v int) *int { return &v }
	cases := []struct {
		qs string
		q  topOracleQuery
	}{
		{"", topOracleQuery{}},
		{"year=2020", topOracleQuery{year: y(2020)}},
		{"year=2021", topOracleQuery{year: y(2021)}},
		{"year=2022", topOracleQuery{year: y(2022)}},
		{"year=2023", topOracleQuery{year: y(2023)}},
		{"year=2024", topOracleQuery{year: y(2024)}},
		{"year=1990", topOracleQuery{year: y(1990)}},
		{"format=TV", topOracleQuery{format: "TV"}},
		{"format=MOVIE", topOracleQuery{format: "MOVIE"}},
		{"format=TV_SHORT", topOracleQuery{format: "TV_SHORT"}},
		{"format=SPECIAL", topOracleQuery{format: "SPECIAL"}},
		{"genre=Drama", topOracleQuery{genre: "Drama"}},
		{"genre=Slice%20of%20Life", topOracleQuery{genre: "Slice of Life"}},
		{"year=2023&season=FALL", topOracleQuery{year: y(2023), season: "FALL"}},
		{"year=2022&season=WINTER", topOracleQuery{year: y(2022), season: "WINTER"}},
		{"year=2021&season=WINTER", topOracleQuery{year: y(2021), season: "WINTER"}},
		{"year=2023&format=MOVIE", topOracleQuery{year: y(2023), format: "MOVIE"}},
		{"year=2023&format=TV&genre=Drama", topOracleQuery{year: y(2023), format: "TV", genre: "Drama"}},
		{"year=2023&season=FALL&format=TV&genre=Action", topOracleQuery{year: y(2023), season: "FALL", format: "TV", genre: "Action"}},
		{"format=MOVIE&genre=Comedy", topOracleQuery{format: "MOVIE", genre: "Comedy"}},
	}
	excluded := []int32{topAdult, topHentai, topMusic, topUnpopular, topUnscored, topZeroScore}
	for _, tc := range cases {
		t.Run(tc.qs, func(t *testing.T) {
			got := topRead(t, h, tc.qs)
			want := topOracle(seeds, tc.q)
			assert.Equal(t, want, got.ids)
			for i, r := range got.ranks {
				require.Equal(t, i+1, r, "rank %d", i)
			}
			assert.LessOrEqual(t, len(got.ids), topSize)
			for _, id := range excluded {
				assert.NotContains(t, got.ids, id)
			}
		})
	}

	t.Run("all time: the hundred best, the ties settled, the edge titles in", func(t *testing.T) {
		got := topRead(t, h, "")
		require.Len(t, got.ids, topSize, "more titles are ranked than the page holds")
		assert.Equal(t, []int32{topNoFormat, topAtTheFloor, topTieMorePop, topTieLowID, topTieHighID}, got.ids[:5])
		assert.Contains(t, got.ids, int32(topNoYear), "a title with no year is still in the all-time ranking")
		assert.JSONEq(t, `null`, string(field(t, got.items[0], "format")), "the format-less title, as it is")
		assert.JSONEq(t, `1`, string(field(t, got.items[0], "rank")))
		assert.JSONEq(t, `97`, string(field(t, got.items[0], "averageScore")))
	})

	t.Run("the year is the season's, else the start date's", func(t *testing.T) {
		assert.Contains(t, topRead(t, h, "year=2023").ids, int32(topFilmByStart))
		assert.NotContains(t, topRead(t, h, "year=2023&season=FALL").ids, int32(topFilmByStart), "no season: in no quarter")
		assert.Contains(t, topRead(t, h, "year=2022").ids, int32(topWinterStart))
		assert.NotContains(t, topRead(t, h, "year=2021").ids, int32(topWinterStart))
		for _, y := range []string{"2020", "2021", "2022", "2023", "2024"} {
			assert.NotContains(t, topRead(t, h, "year="+y).ids, int32(topNoYear), y)
		}
	})

	t.Run("a filter re-cuts the ranking and renumbers it", func(t *testing.T) {
		drama := topRead(t, h, "year=2023&genre=Drama")
		require.NotEmpty(t, drama.ids)
		assert.Equal(t, int32(topNoFormat), drama.ids[0])
		assert.Equal(t, 1, drama.ranks[0])
		action := topRead(t, h, "year=2023&genre=Action")
		require.GreaterOrEqual(t, len(action.ids), 3)
		assert.Equal(t, []int32{topTieMorePop, topTieLowID, topTieHighID}, action.ids[:3])
		assert.Equal(t, []int{1, 2, 3}, action.ranks[:3])
	})
}

// field is one key of a JSON object.
func field(t *testing.T, raw json.RawMessage, key string) json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &m))
	v, ok := m[key]
	require.True(t, ok, "no %q in %s", key, raw)
	return v
}

// TestTopYears_PG — the years with a ranking, newest first, each with how
// many titles it ranks (all of them, not the hundred a page shows), by
// the same rule as /top: the excluded titles count nowhere, a title with
// no year counts in no year.
func TestTopYears_PG(t *testing.T) {
	pool, _, seeds := seedTopCatalogue(t)
	c, err := NewTopYearsCache()
	require.NoError(t, err)
	t.Cleanup(c.Close)

	rec := httptest.NewRecorder()
	TopYears(dbgen.New(pool), c).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/top/years", nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var env struct {
		Data []TopYear `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))

	counts := map[int]int64{}
	for _, s := range seeds {
		if y, ok := s.releaseYear(); ok && s.ranked() {
			counts[y]++
		}
	}
	var want []TopYear
	for y, n := range counts {
		want = append(want, TopYear{Year: int32(y), Count: n})
	}
	sort.Slice(want, func(i, j int) bool { return want[i].Year > want[j].Year })
	assert.Equal(t, want, env.Data)
	require.NotEmpty(t, env.Data)
	assert.Equal(t, int32(2024), env.Data[0].Year)

	// Each year's count is the length of its ranking while it fits a page.
	tc, err := NewTopCache()
	require.NoError(t, err)
	t.Cleanup(tc.Close)
	h := Top(dbgen.New(pool), tc)
	for _, yr := range env.Data {
		got := topRead(t, h, fmt.Sprintf("year=%d", yr.Year))
		assert.Equal(t, min(int(yr.Count), topSize), len(got.ids), "year %d", yr.Year)
	}
}

// recordingDBTX remembers the last statement it was asked to query, with
// its arguments as they reached the connection.
type recordingDBTX struct {
	dbgen.DBTX
	sql  string
	args []any
}

func (r *recordingDBTX) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	r.sql, r.args = sql, args
	return r.DBTX.Query(ctx, sql, args...)
}

// TestTop_PG_PlannedForTheirArguments — TopAnime, the way NewTopDB runs
// it, is planned for each request's own arguments and never with a
// generic plan, the property TestBrowse_PG_PlannedForTheirArguments holds
// for BrowseAnime by another route.  Prepared and cached, auto mode moves
// TopAnime to a generic plan from its sixth execution (see NewTopDB); run
// as an unnamed statement there is no prepared statement for it to move:
// after a dozen requests none exists, and the plan a year's ranking runs
// on reads that year off the release-year index.  A plan cache belongs to
// one session, so every request goes through one fresh connection.
func TestTop_PG_PlannedForTheirArguments(t *testing.T) {
	_, uri, _ := seedTopCatalogue(t)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, uri)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	c, err := NewTopCache()
	require.NoError(t, err)
	t.Cleanup(c.Close)
	rec := &recordingDBTX{DBTX: conn}
	h := Top(NewTopDB(rec), c)

	// Every filter, alone and together, well past the fifth execution,
	// where auto mode first weighs a generic plan.  Each is its own cache
	// key, so each reaches the statement.
	requests := []string{
		"",
		"year=2022&season=WINTER",
		"format=MOVIE",
		"genre=Drama",
		"year=2023&format=TV&genre=Action",
		"year=2021&season=SPRING&format=ONA",
		"genre=Comedy&format=TV_SHORT",
		"year=2024",
		"year=2020&genre=Romance",
		"year=2023&season=FALL&format=TV&genre=Drama",
		"format=SPECIAL",
		"year=2023",
	}
	for _, qs := range requests {
		topRead(t, h, qs)
	}

	var prepared int
	require.NoError(t, conn.QueryRow(ctx,
		"SELECT count(*) FROM pg_prepared_statements WHERE statement LIKE $1",
		"-- name: TopAnime :%").Scan(&prepared))
	assert.Zero(t, prepared, "TopAnime was prepared: a generic plan can take it over")

	// The last request, year=2023, explained exactly as it ran.
	require.Contains(t, rec.sql, "-- name: TopAnime :many")
	require.NotEmpty(t, rec.args)
	assert.Equal(t, pgx.QueryExecModeCacheDescribe, rec.args[0], "run as an unnamed statement")
	rows, err := conn.Query(ctx, "EXPLAIN "+rec.sql, rec.args...)
	require.NoError(t, err)
	plan, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	text := strings.Join(plan, "\n")
	assert.Contains(t, text, "anime_cache_release_year_idx", "a year's ranking reads the year off its index:\n%s", text)
	assert.Contains(t, text, "= 2023)", "planned for the year asked for, not for a parameter:\n%s", text)
}
