package anime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// genreSeed is one title of the catalogue these tests seed, as plain
// facts, so the expected listings can be worked out in Go (the oracle
// below) instead of by the SQL under test.
type genreSeed struct {
	id      int32
	genres  []string
	season  *int       // AniList's seasonYear
	start   *time.Time // a whole start date
	status  string
	pop     *int
	score   *int
	cover   bool
	adult   bool
	main    []string // main studios
	support []string // studios credited but not main
}

func (s genreSeed) has(genre string) bool {
	for _, g := range s.genres {
		if g == genre {
			return true
		}
	}
	return false
}

func (s genreSeed) madeBy(studio string) bool {
	for _, m := range s.main {
		if m == studio {
			return true
		}
	}
	return false
}

// releaseYear is the season's year, else the start date's.
func (s genreSeed) releaseYear() (int, bool) {
	if s.season != nil {
		return *s.season, true
	}
	if s.start != nil {
		return s.start.Year(), true
	}
	return 0, false
}

// listed: adult titles are out, by the flag and by the genre.
func (s genreSeed) listed() bool { return !s.adult && !s.has("Hentai") }

func (s genreSeed) media() anilist.Media {
	m := anilist.Media{
		ID:           int(s.id),
		Title:        &anilist.Title{Romaji: sptr(fmt.Sprintf("Title %d", s.id))},
		Format:       sptr("TV"),
		Status:       sptr(s.status),
		Genres:       s.genres,
		Popularity:   s.pop,
		AverageScore: s.score,
		IsAdult:      func() *bool { b := s.adult; return &b }(),
	}
	if s.season != nil {
		m.Season = sptr("SPRING")
		m.SeasonYear = s.season
	}
	if s.start != nil {
		m.StartDate = &anilist.FuzzyDate{Year: iptr(s.start.Year()), Month: iptr(int(s.start.Month())), Day: iptr(s.start.Day())}
	}
	if s.cover {
		m.CoverImage = &anilist.CoverImage{Large: sptr(fmt.Sprintf("https://img.example/cover/%d.jpg", s.id)), Color: sptr("#3a7bd5")}
	}
	var edges []anilist.StudioEdge
	for _, st := range s.main {
		edges = append(edges, seasonalStudio(st, true))
	}
	for _, st := range s.support {
		edges = append(edges, seasonalStudio(st, false))
	}
	if len(edges) > 0 {
		m.Studios = seasonalStudios(edges...)
	}
	return m
}

const committee = "Big Committee"

// genreCatalogue is seventy-odd Action titles with every attribute the
// listings read varied, and a few titles placed to trip one rule each.
func genreCatalogue() []genreSeed {
	ip := func(v int) *int { return &v }
	coGenres := []string{"Fantasy", "Comedy", "Drama", "Adventure", "Sci-Fi", "Romance", "Mecha", "Sports", "Music"}
	// Main studios by how many titles each makes as the first main studio.
	// Iota is also the second main studio of every tenth title, which takes
	// it from last to fifth; Eta and Zeta tie for the last tile, and the
	// name decides.
	studios := []struct {
		name string
		n    int
	}{{"Studio Alpha", 14}, {"Studio Beta", 12}, {"Studio Gamma", 10}, {"Studio Delta", 9},
		{"Studio Epsilon", 8}, {"Studio Zeta", 6}, {"Studio Eta", 6}, {"Studio Theta", 4}, {"Studio Iota", 3}}
	var studioOf []string
	for _, st := range studios {
		for k := 0; k < st.n; k++ {
			studioOf = append(studioOf, st.name)
		}
	}

	var out []genreSeed
	for i := 1; i <= 72; i++ {
		s := genreSeed{id: int32(100 + i), genres: []string{"Action"}, status: "FINISHED", cover: i%10 != 3}
		for k, g := range coGenres {
			if i%(k+2) == 0 {
				s.genres = append(s.genres, g)
			}
		}
		// Mystery ties Mecha at the last related tile; Isekai is common but
		// is not a genre a hub exists for.
		if i%8 == 1 {
			s.genres = append(s.genres, "Mystery")
		}
		if i%3 == 1 {
			s.genres = append(s.genres, "Isekai")
		}

		year := 1962 + (i*7)%68
		switch i {
		case 1:
			year = 1969
		case 2:
			year = 1970
		case 3:
			year = 1979
		case 4:
			year = 2029
		case 5:
			year = 2030 // recent, but in no decade
		case 6:
			year = 2020
		}
		switch {
		case i%13 == 0: // no year at all
		case i%11 == 0: // a film: no season, a start date
			d := time.Date(year, 8, 9, 0, 0, 0, 0, time.UTC)
			s.start = &d
		default:
			s.season = ip(year)
		}

		switch {
		case i%5 == 1:
			s.status = "RELEASING"
		case i%17 == 0:
			s.status = "NOT_YET_RELEASED"
		}

		if i%19 != 0 {
			s.pop = ip((i*373)%4000 + 200)
		}
		if i%9 != 4 {
			s.score = ip(50 + (i*17)%45)
		}
		switch i {
		case 30, 40: // tied on score and popularity: the id decides
			s.score, s.pop = ip(88), ip(3000)
		case 31: // same score, more popular: first of the three
			s.score, s.pop = ip(88), ip(3500)
		case 32: // under the ranking's floor
			s.score, s.pop = ip(88), ip(999)
		case 33: // popular and unscored
			s.score, s.pop = nil, ip(4100)
		case 35: // exactly at the ranking's floor: ranked
			s.score, s.pop = ip(70), ip(browseScoreMinPopularity)
		}

		s.main = []string{studioOf[i-1]}
		if i%10 == 0 && s.main[0] != "Studio Iota" {
			s.main = append(s.main, "Studio Iota") // two main studios
		}
		s.support = []string{committee}
		out = append(out, s)
	}

	// The three below are the most popular titles in the catalogue and are
	// made by the top studios, so a listing, a tile or a cover row that let
	// one in would show it first.
	return append(out,
		// Adult by the flag.
		genreSeed{id: 901, genres: []string{"Action", "Fantasy", "Mystery"}, season: ip(2024), status: "RELEASING",
			pop: ip(9999), score: ip(99), cover: true, adult: true, main: []string{"Studio Alpha"}},
		// Adult by the genre only.
		genreSeed{id: 902, genres: []string{"Action", "Hentai", "Mystery", "Sports"}, season: ip(2024), status: "RELEASING",
			pop: ip(9998), score: ip(98), cover: true, main: []string{"Studio Beta"}},
		// Not Action at all.
		genreSeed{id: 903, genres: []string{"Fantasy"}, season: ip(2024), status: "RELEASING", pop: ip(9000), score: ip(90),
			cover: true, main: []string{"Studio Gamma"}},
		// The most popular Action title, and it has no cover: first in the
		// rails, never a tile's cover.
		genreSeed{id: 904, genres: []string{"Action", "Fantasy"}, season: ip(2023), status: "FINISHED", pop: ip(9500),
			score: ip(85), cover: false, main: []string{"Studio Alpha"}},
	)
}

// oracleQuery is a /browse listing as the oracle reads it.  The oracle
// can combine a genre and a studio, which /browse cannot, to work out a
// studio tile.
type oracleQuery struct {
	genre, with, studio, status string
	year, yearFrom, yearTo      *int
	byScore                     bool
}

func descNullsLast(a, b *int) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	case *a > *b:
		return -1
	case *a < *b:
		return 1
	}
	return 0
}

// oracleList is what a listing should hold, in order.
func oracleList(seeds []genreSeed, q oracleQuery) []genreSeed {
	var out []genreSeed
	for _, s := range seeds {
		if !s.listed() ||
			(q.genre != "" && !s.has(q.genre)) ||
			(q.with != "" && !s.has(q.with)) ||
			(q.studio != "" && !s.madeBy(q.studio)) ||
			(q.status != "" && s.status != q.status) {
			continue
		}
		y, hasYear := s.releaseYear()
		if (q.year != nil && (!hasYear || y != *q.year)) ||
			(q.yearFrom != nil && (!hasYear || y < *q.yearFrom)) ||
			(q.yearTo != nil && (!hasYear || y > *q.yearTo)) {
			continue
		}
		if q.byScore && (s.score == nil || s.pop == nil || *s.pop < browseScoreMinPopularity) {
			continue
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if q.byScore {
			if c := descNullsLast(a.score, b.score); c != 0 {
				return c < 0
			}
		}
		if c := descNullsLast(a.pop, b.pop); c != 0 {
			return c < 0
		}
		if c := descNullsLast(a.score, b.score); c != 0 {
			return c < 0
		}
		return a.id < b.id
	})
	return out
}

func seedIDs(seeds []genreSeed) []int32 {
	out := make([]int32, 0, len(seeds))
	for _, s := range seeds {
		out = append(out, s.id)
	}
	return out
}

func seedGenreCatalogue(t *testing.T) (*dbgen.Queries, []genreSeed) {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	detail, err := NewDetailService(q, nil)
	require.NoError(t, err)
	t.Cleanup(detail.Close)

	seeds := genreCatalogue()
	for _, s := range seeds {
		require.NoError(t, detail.upsertFromMedia(ctx, s.id, s.media()), "seed %d", s.id)
	}
	// Plan against real statistics, as on the catalogue.
	_, err = pool.Exec(ctx, "ANALYZE anime_cache, anime_genres, anime_studios")
	require.NoError(t, err)
	return q, seeds
}

// browseListing is a whole /browse listing, read page by page.
type browseListing struct {
	ids   []int32
	items []json.RawMessage
	total int
}

func browseAll(t *testing.T, h http.Handler, query string, perPage int) browseListing {
	t.Helper()
	out := browseListing{ids: []int32{}}
	for page := 1; ; page++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
			fmt.Sprintf("/api/anime/browse?%s&page=%d&perPage=%d", query, page, perPage), nil))
		require.Equal(t, http.StatusOK, rec.Code, "%s: %s", query, rec.Body.String())
		var env struct {
			Data       []json.RawMessage  `json:"data"`
			Pagination seasonalPagination `json:"pagination"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
		for _, raw := range env.Data {
			var it struct {
				AnilistID int32 `json:"anilistId"`
			}
			require.NoError(t, json.Unmarshal(raw, &it))
			out.ids = append(out.ids, it.AnilistID)
			out.items = append(out.items, raw)
		}
		if page == 1 {
			out.total = env.Pagination.Total
		}
		require.Equal(t, out.total, env.Pagination.Total, "%s: the total does not move between pages", query)
		if page >= env.Pagination.TotalPages {
			return out
		}
	}
}

// TestBrowse_PG_Filters — every filter and both orders over a real
// Postgres, against the oracle: which titles, in which order, and a total
// that counts exactly them, read across pages small enough that the order
// has to be total for nothing to repeat or go missing.
func TestBrowse_PG_Filters(t *testing.T) {
	q, seeds := seedGenreCatalogue(t)
	h := Browse(q)
	y := func(v int) *int { return &v }

	for _, tc := range []struct {
		query string
		want  oracleQuery
	}{
		{"genre=Action", oracleQuery{genre: "Action"}},
		{"genre=Action&sort=score", oracleQuery{genre: "Action", byScore: true}},
		{"genre=Action&status=RELEASING", oracleQuery{genre: "Action", status: "RELEASING"}},
		{"genre=Action&status=NOT_YET_RELEASED", oracleQuery{genre: "Action", status: "NOT_YET_RELEASED"}},
		{"genre=Action&with=Fantasy", oracleQuery{genre: "Action", with: "Fantasy"}},
		{"genre=Action&with=Mystery&sort=score", oracleQuery{genre: "Action", with: "Mystery", byScore: true}},
		{"genre=Action&with=Fantasy&status=FINISHED&yearTo=2009&sort=score",
			oracleQuery{genre: "Action", with: "Fantasy", status: "FINISHED", yearTo: y(2009), byScore: true}},
		{"genre=Action&yearFrom=1990&yearTo=1999", oracleQuery{genre: "Action", yearFrom: y(1990), yearTo: y(1999)}},
		{"genre=Action&yearFrom=2001&yearTo=2001", oracleQuery{genre: "Action", yearFrom: y(2001), yearTo: y(2001)}},
		{"genre=Action&yearTo=1969", oracleQuery{genre: "Action", yearTo: y(1969)}},
		{"genre=Action&yearFrom=2020", oracleQuery{genre: "Action", yearFrom: y(2020)}},
		{"genre=Action&yearFrom=2020&yearTo=2029", oracleQuery{genre: "Action", yearFrom: y(2020), yearTo: y(2029)}},
		{"genre=Fantasy", oracleQuery{genre: "Fantasy"}},
		{"studio=Studio%20Alpha&sort=score", oracleQuery{studio: "Studio Alpha", byScore: true}},
		{"studio=Studio%20Iota&status=RELEASING", oracleQuery{studio: "Studio Iota", status: "RELEASING"}},
		{"year=2024&sort=score", oracleQuery{year: y(2024), byScore: true}},
		{"year=1990&yearFrom=1991", oracleQuery{year: y(1990), yearFrom: y(1991)}},
	} {
		t.Run(tc.query, func(t *testing.T) {
			want := seedIDs(oracleList(seeds, tc.want))
			got := browseAll(t, h, tc.query, 7)
			assert.Equal(t, want, got.ids)
			assert.Equal(t, len(want), got.total, "the total counts what the listing lists")
		})
	}

	popular := browseAll(t, h, "genre=Action", 50).ids
	ranked := browseAll(t, h, "genre=Action&sort=score", 50).ids
	indexOf := func(ids []int32, id int32) int {
		for i, v := range ids {
			if v == id {
				return i
			}
		}
		return -1
	}

	t.Run("adult titles are never listed", func(t *testing.T) {
		for _, id := range []int32{901, 902} {
			assert.Equal(t, -1, indexOf(popular, id))
			assert.Equal(t, -1, indexOf(ranked, id))
		}
		assert.Equal(t, int32(904), popular[0], "the most popular listed title leads, cover or not")
	})

	t.Run("a title with no year is listed until a year bound is set", func(t *testing.T) {
		bounded := browseAll(t, h, "genre=Action&yearFrom=1900", 50).ids
		for _, id := range []int32{113, 126, 139, 152, 165} {
			assert.NotEqual(t, -1, indexOf(popular, id), "%d unbounded", id)
			assert.Equal(t, -1, indexOf(bounded, id), "%d with a bound", id)
		}
		assert.Len(t, bounded, len(popular)-5)
	})

	t.Run("a film with no season is placed by its start date", func(t *testing.T) {
		// 111 is a film from 1962 + 77%68 = 1971.
		seventies := browseAll(t, h, "genre=Action&yearFrom=1970&yearTo=1979", 50).ids
		assert.NotEqual(t, -1, indexOf(seventies, 111))
	})

	t.Run("the ranking: score, then popularity, then id, above the floor", func(t *testing.T) {
		i131, i130, i140 := indexOf(ranked, 131), indexOf(ranked, 130), indexOf(ranked, 140)
		require.NotEqual(t, -1, i130)
		assert.Less(t, i131, i130, "same score, more popular")
		assert.Equal(t, i130+1, i140, "same score and popularity: by id")
		assert.Equal(t, -1, indexOf(ranked, 132), "under the popularity floor")
		assert.NotEqual(t, -1, indexOf(ranked, 135), "at the floor")
		assert.Equal(t, -1, indexOf(ranked, 133), "no score")
		assert.NotEqual(t, -1, indexOf(popular, 132))
		assert.NotEqual(t, -1, indexOf(popular, 133))
	})
}
