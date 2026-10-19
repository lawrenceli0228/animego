package anime

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// fakeGenreOverviewDB answers the rails from fakeBrowseDB and the tiles
// from canned rows, recording what each tile query was asked.  Safe for
// the concurrent requests the cache test sends.
type fakeGenreOverviewDB struct {
	mu sync.Mutex
	fakeBrowseDB

	decadeRows  []dbgen.ListGenreDecadeTilesRow
	relatedRows []dbgen.ListGenreRelatedTilesRow
	studioRows  []dbgen.ListGenreStudioTilesRow
	tileErr     error

	decadeArgs struct {
		perTile    int32
		keys       []string
		froms, tos []int32
		genre      string
	}
	relatedArgs struct {
		maxTiles, perTile int32
		genre             string
		candidates        []string
	}
	studioArgs struct {
		maxTiles, perTile int32
		genre             string
	}
	tileCalls int
}

func (f *fakeGenreOverviewDB) BrowseAnime(ctx context.Context, arg dbgen.BrowseAnimeParams) ([]dbgen.BrowseAnimeRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fakeBrowseDB.BrowseAnime(ctx, arg)
}

func (f *fakeGenreOverviewDB) CountBrowseAnime(ctx context.Context, arg dbgen.CountBrowseAnimeParams) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fakeBrowseDB.CountBrowseAnime(ctx, arg)
}

func (f *fakeGenreOverviewDB) ListGenreDecadeTiles(_ context.Context, perTile int32, keys []string, froms, tos []int32, genre string) ([]dbgen.ListGenreDecadeTilesRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tileCalls++
	f.decadeArgs.perTile, f.decadeArgs.keys, f.decadeArgs.froms, f.decadeArgs.tos, f.decadeArgs.genre = perTile, keys, froms, tos, genre
	return f.decadeRows, f.tileErr
}

func (f *fakeGenreOverviewDB) ListGenreRelatedTiles(_ context.Context, maxTiles int32, genre string, candidates []string, perTile int32) ([]dbgen.ListGenreRelatedTilesRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tileCalls++
	f.relatedArgs.maxTiles, f.relatedArgs.genre, f.relatedArgs.candidates, f.relatedArgs.perTile = maxTiles, genre, candidates, perTile
	return f.relatedRows, f.tileErr
}

func (f *fakeGenreOverviewDB) ListGenreStudioTiles(_ context.Context, maxTiles int32, genre string, perTile int32) ([]dbgen.ListGenreStudioTilesRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tileCalls++
	f.studioArgs.maxTiles, f.studioArgs.genre, f.studioArgs.perTile = maxTiles, genre, perTile
	return f.studioRows, f.tileErr
}

func (f *fakeGenreOverviewDB) queries() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.listCalls) + len(f.countCalls) + f.tileCalls
}

func newGenreOverviewCacheT(t *testing.T) *cache.Cache[*GenreOverviewPayload] {
	t.Helper()
	c, err := NewGenreOverviewCache()
	require.NoError(t, err)
	t.Cleanup(c.Close)
	return c
}

// octoberNoon is a fixed clock: noon in Beijing, 19 October 2026.
var octoberNoon = time.Date(2026, 10, 19, 4, 0, 0, 0, time.UTC)

func genreOverviewGet(h http.Handler, query string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/genre-overview?"+query, nil))
	return rec
}

// TestGenreOverview_RefusesWhatIsNotAHub — only the eighteen browsable
// genres, spelled as AniList spells them, and before the cache or the
// database is reached: the cache's key set is whatever passes here.
func TestGenreOverview_RefusesWhatIsNotAHub(t *testing.T) {
	t.Parallel()

	for _, qs := range []string{"", "genre=", "genre=Hentai", "genre=action", "genre=Isekai", "genre=slice-of-life", "studio=MAPPA"} {
		t.Run(qs, func(t *testing.T) {
			db := &fakeGenreOverviewDB{}
			rec := genreOverviewGet(genreOverviewHandler(db, newGenreOverviewCacheT(t), func() time.Time { return octoberNoon }), qs)
			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Equal(t, `{"error":{"code":"VALIDATION_ERROR","message":"genre must be one of the browsable genres"}}`, rec.Body.String())
			assert.Zero(t, db.queries())
		})
	}
}

func TestBrowsableGenres_AreTheHubs(t *testing.T) {
	t.Parallel()

	assert.Len(t, browsableGenres, 18)
	seen := map[string]bool{}
	for _, g := range browsableGenres {
		assert.False(t, seen[g], "%s listed twice", g)
		seen[g] = true
		assert.True(t, isBrowsableGenre(g))
	}
	assert.False(t, isBrowsableGenre("Hentai"))
	assert.False(t, isBrowsableGenre(""))
}

// TestLoadGenreOverview_RailsAreBrowseListings — each rail is the first
// page of the /browse listing its "see all" link opens: the filters that
// listing's query string parses to, from offset 0, six titles (ten for the
// top list), counted under the same WHERE.
func TestLoadGenreOverview_RailsAreBrowseListings(t *testing.T) {
	t.Parallel()

	db := &fakeGenreOverviewDB{}
	db.totalFor = func(p dbgen.CountBrowseAnimeParams) int64 {
		switch {
		case p.Status != nil:
			return 84
		case p.YearFrom != nil:
			return 1600
		case p.YearTo != nil:
			return 900
		case p.ByScore:
			return 3600
		default:
			return 5241
		}
	}
	got, err := loadGenreOverview(context.Background(), db, "Action", octoberNoon)
	require.NoError(t, err)

	want := map[string]struct {
		query string
		limit int32
		count int64
	}{
		"airing":  {"genre=Action&status=RELEASING", genreRailSize, 84},
		"popular": {"genre=Action", genreRailSize, 5241},
		"recent":  {"genre=Action&yearFrom=2020", genreRailSize, 1600},
		"classic": {"genre=Action&yearTo=2009", genreRailSize, 900},
		"top":     {"genre=Action&sort=score", genreTopSize, 3600},
	}
	order := []string{"airing", "popular", "recent", "classic", "top"}
	require.Len(t, db.listCalls, len(order))
	require.Len(t, db.countCalls, len(order))
	for i, name := range order {
		qs := mustParseQuery(t, want[name].query)
		q, apiErr := parseBrowseQuery(qs)
		require.Nil(t, apiErr)
		assert.Equal(t, q.listParams(0, want[name].limit), db.listCalls[i], "%s rail: /browse?%s", name, want[name].query)
		assert.Equal(t, q.countParams(), db.countCalls[i], "%s count", name)
	}

	assert.Equal(t, want["airing"].count, got.Lists.Airing.Count)
	assert.Equal(t, want["popular"].count, got.Lists.Popular.Count)
	assert.Equal(t, want["recent"].count, got.Lists.Recent.Count)
	assert.Equal(t, want["classic"].count, got.Lists.Classic.Count)
	assert.Equal(t, want["top"].count, got.Lists.Top.Count)
	assert.Equal(t, int64(5241), got.Total, "total is the popular listing's")
	assert.Equal(t, int64(84), got.Airing, "airing is the airing listing's")
	assert.Equal(t, int32(2020), got.RecentFrom)
	assert.Equal(t, "Action", got.Genre)
}

// TestLoadGenreOverview_TileQueriesAreAsked — the tile queries get the
// genre, the decade table, the browsable genres as candidates and the
// sizes, each in its own argument (two of them are int32s side by side).
func TestLoadGenreOverview_TileQueriesAreAsked(t *testing.T) {
	t.Parallel()

	db := &fakeGenreOverviewDB{}
	_, err := loadGenreOverview(context.Background(), db, "Mahou Shoujo", octoberNoon)
	require.NoError(t, err)

	assert.Equal(t, "Mahou Shoujo", db.decadeArgs.genre)
	assert.Equal(t, int32(genreTileCovers), db.decadeArgs.perTile)
	assert.Equal(t, []string{"2020", "2010", "2000", "1990", "1980", "1970", "old"}, db.decadeArgs.keys)
	assert.Equal(t, []int32{2020, 2010, 2000, 1990, 1980, 1970, math.MinInt32}, db.decadeArgs.froms)
	assert.Equal(t, []int32{2029, 2019, 2009, 1999, 1989, 1979, 1969}, db.decadeArgs.tos)

	assert.Equal(t, "Mahou Shoujo", db.relatedArgs.genre)
	assert.Equal(t, browsableGenres, db.relatedArgs.candidates)
	assert.Equal(t, int32(genreMaxTiles), db.relatedArgs.maxTiles)
	assert.Equal(t, int32(genreTileCovers), db.relatedArgs.perTile)

	assert.Equal(t, "Mahou Shoujo", db.studioArgs.genre)
	assert.Equal(t, int32(genreMaxTiles), db.studioArgs.maxTiles)
	assert.Equal(t, int32(genreTileCovers), db.studioArgs.perTile)
}

// TestGenreDecades_TileTheYears — the decades are contiguous and do not
// overlap, newest first, ten years each but the open-ended "old", so
// every release year from the int32 floor to 2029 is in exactly one.
func TestGenreDecades_TileTheYears(t *testing.T) {
	t.Parallel()

	require.Equal(t, "2020", genreDecades[0].key)
	require.Equal(t, "old", genreDecades[len(genreDecades)-1].key)
	assert.Equal(t, int32(2029), genreDecades[0].to)
	for i, d := range genreDecades {
		assert.LessOrEqual(t, d.from, d.to, d.key)
		if d.key != "old" {
			assert.Equal(t, d.from+9, d.to, "%s is ten years", d.key)
		}
		if i > 0 {
			assert.Equal(t, genreDecades[i-1].from-1, d.to, "%s ends the year before %s begins", d.key, genreDecades[i-1].key)
		}
	}
	assert.Equal(t, int32(math.MinInt32), genreDecades[len(genreDecades)-1].from)
}

// TestLoadGenreOverview_RecentFromIsBeijingsYear — the year turns at
// midnight in UTC+8, eight hours before it does in UTC.
func TestLoadGenreOverview_RecentFromIsBeijingsYear(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		now  time.Time
		want int32
	}{
		{"New Year's Eve in Beijing", time.Date(2026, 12, 31, 15, 59, 59, 0, time.UTC), 2020},
		{"New Year's Day in Beijing, still 2026 in UTC", time.Date(2026, 12, 31, 16, 0, 0, 0, time.UTC), 2021},
		{"the clock's own zone does not matter", time.Date(2027, 1, 1, 0, 30, 0, 0, time.FixedZone("UTC+8", 8*60*60)), 2021},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &fakeGenreOverviewDB{}
			got, err := loadGenreOverview(context.Background(), db, "Action", tc.now)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got.RecentFrom)
			require.NotNil(t, db.listCalls[2].YearFrom)
			assert.Equal(t, tc.want, *db.listCalls[2].YearFrom, "the recent rail starts there")
		})
	}
}

func tileRowCover(id int32) *string { return sptr(fmt.Sprintf("https://img.example/%d.jpg", id)) }

func mustParseQuery(t *testing.T, qs string) url.Values {
	t.Helper()
	v, err := url.ParseQuery(qs)
	require.NoError(t, err)
	return v
}

// TestDecadeTiles — newest first whatever order the rows arrive in, a
// decade with no rows left out, and a coverless candidate dropped without
// losing its tile or the tile's count.
func TestDecadeTiles(t *testing.T) {
	t.Parallel()

	accent := sptr("#e4a15d")
	got := decadeTiles([]dbgen.ListGenreDecadeTilesRow{
		{RangeKey: "old", N: 3, AnilistID: 9, CoverImageUrl: tileRowCover(9), PosterAccent: accent},
		{RangeKey: "1990", N: 2, AnilistID: 5, CoverImageUrl: nil},
		{RangeKey: "1990", N: 2, AnilistID: 6, CoverImageUrl: nil},
		{RangeKey: "2020", N: 40, AnilistID: 1, CoverImageUrl: tileRowCover(1), PosterAccent: accent},
		{RangeKey: "2020", N: 40, AnilistID: 2, CoverImageUrl: tileRowCover(2), PosterAccent: nil},
	})

	assert.Equal(t, []GenreDecadeTile{
		{Key: "2020", Count: 40, Covers: []GenreCover{
			{AnilistID: 1, CoverImageUrl: *tileRowCover(1), PosterAccent: accent},
			{AnilistID: 2, CoverImageUrl: *tileRowCover(2)},
		}},
		{Key: "1990", Count: 2, Covers: []GenreCover{}},
		{Key: "old", Count: 3, Covers: []GenreCover{{AnilistID: 9, CoverImageUrl: *tileRowCover(9), PosterAccent: accent}}},
	}, got)

	assert.Equal(t, `[{"key":"1990","count":2,"covers":[]}]`, encodeLikeTheEnvelope(t, got[1:2]),
		"a tile with no cover still has a covers array")
	assert.NotNil(t, decadeTiles(nil))
	assert.Empty(t, decadeTiles(nil))
}

// TestRelatedAndStudioTiles_KeepTheRanking — the rows arrive ranked, and
// grouping keeps that order and each tile's candidate order.
func TestRelatedAndStudioTiles_KeepTheRanking(t *testing.T) {
	t.Parallel()

	related := relatedTiles([]dbgen.ListGenreRelatedTilesRow{
		{Related: "Fantasy", N: 30, AnilistID: 3, CoverImageUrl: tileRowCover(3)},
		{Related: "Fantasy", N: 30, AnilistID: 1, CoverImageUrl: tileRowCover(1)},
		{Related: "Adventure", N: 30, AnilistID: 2, CoverImageUrl: tileRowCover(2)},
		{Related: "Comedy", N: 4, AnilistID: 7, CoverImageUrl: nil},
	})
	require.Len(t, related, 3)
	assert.Equal(t, []string{"Fantasy", "Adventure", "Comedy"}, []string{related[0].Genre, related[1].Genre, related[2].Genre})
	assert.Equal(t, []int32{3, 1}, []int32{related[0].Covers[0].AnilistID, related[0].Covers[1].AnilistID})
	assert.Equal(t, int64(4), related[2].Count)
	assert.Empty(t, related[2].Covers)

	studios := studioTiles([]dbgen.ListGenreStudioTilesRow{
		{Studio: "Toei Animation", N: 300, AnilistID: 11, CoverImageUrl: tileRowCover(11)},
		{Studio: "Sunrise", N: 200, AnilistID: 12, CoverImageUrl: tileRowCover(12)},
	})
	assert.Equal(t, []GenreStudioTile{
		{Studio: "Toei Animation", Count: 300, Covers: []GenreCover{{AnilistID: 11, CoverImageUrl: *tileRowCover(11)}}},
		{Studio: "Sunrise", Count: 200, Covers: []GenreCover{{AnilistID: 12, CoverImageUrl: *tileRowCover(12)}}},
	}, studios)
}

// TestGenreOverview_WireShape — the whole body of a genre with nothing in
// it: every key present, every list an array, the envelope httpx.Data's.
func TestGenreOverview_WireShape(t *testing.T) {
	t.Parallel()

	db := &fakeGenreOverviewDB{}
	rec := genreOverviewGet(genreOverviewHandler(db, newGenreOverviewCacheT(t), func() time.Time { return octoberNoon }), "genre=Thriller")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":{"genre":"Thriller","total":0,"airing":0,"recentFrom":2020,"lists":{`+
		`"airing":{"count":0,"items":[]},"popular":{"count":0,"items":[]},"recent":{"count":0,"items":[]},`+
		`"classic":{"count":0,"items":[]},"top":{"count":0,"items":[]}},`+
		`"decades":[],"related":[],"studios":[]}}`, rec.Body.String())
}

// TestGenreOverview_ItemsAreBrowseItems — a rail's items are /browse's,
// byte for byte: the same rows through the same mapping.
func TestGenreOverview_ItemsAreBrowseItems(t *testing.T) {
	t.Parallel()

	row := dbgen.BrowseAnimeRow(seasonalLegacyFullRow())
	row.RelationsKnown = true
	db := &fakeGenreOverviewDB{}
	db.rows = []dbgen.BrowseAnimeRow{row}
	db.total = 1

	rec := genreOverviewGet(genreOverviewHandler(db, newGenreOverviewCacheT(t), func() time.Time { return octoberNoon }), "genre=Drama")
	require.Equal(t, http.StatusOK, rec.Code)
	item := seasonalLegacyFullJSON + `,"studio":null,"nextAiringAt":null,"nextAiringEpisode":null,"popularity":null,` +
		`"favourites":null,"source":null,"startDate":null,"duration":null,"isSequel":false}`
	assert.Contains(t, rec.Body.String(), `"popular":{"count":1,"items":[`+item+`]}`)

	browse := browseGet(&fakeBrowseDB{rows: []dbgen.BrowseAnimeRow{row}, total: 1}, "genre=Drama&perPage=6")
	assert.Equal(t, `{"data":[`+item+`],"pagination":{"page":1,"perPage":6,"total":1,"totalPages":1}}`, browse.Body.String())
}

// TestGenreOverview_CachedPerGenre — the second request for a genre is
// answered from the cache with the same bytes, another genre is its own
// entry, and a failed read is not cached.
func TestGenreOverview_CachedPerGenre(t *testing.T) {
	t.Parallel()

	c := newGenreOverviewCacheT(t)
	db := &fakeGenreOverviewDB{}
	db.total = 3
	h := genreOverviewHandler(db, c, func() time.Time { return octoberNoon })

	first := genreOverviewGet(h, "genre=Action")
	require.Equal(t, http.StatusOK, first.Code)
	perMiss := db.queries()
	assert.Equal(t, 13, perMiss, "five rails at two statements each, and three tile rows")
	c.Wait()

	second := genreOverviewGet(h, "genre=Action")
	assert.Equal(t, http.StatusOK, second.Code)
	assert.Equal(t, first.Body.String(), second.Body.String())
	assert.Equal(t, perMiss, db.queries(), "a hit reads nothing")

	other := genreOverviewGet(h, "genre=Fantasy")
	assert.Equal(t, http.StatusOK, other.Code)
	assert.Equal(t, 2*perMiss, db.queries(), "another genre is another entry")
	assert.Contains(t, other.Body.String(), `"genre":"Fantasy"`)
	c.Wait()

	failing := &fakeGenreOverviewDB{tileErr: errors.New("connection reset")}
	hf := genreOverviewHandler(failing, c, func() time.Time { return octoberNoon })
	rec := genreOverviewGet(hf, "genre=Comedy")
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, `{"error":{"code":"SERVER_ERROR","message":"query failed"}}`, rec.Body.String())
	c.Wait()
	_, cached := c.Get("Comedy")
	assert.False(t, cached, "a failure is not cached: the next request reads again")
	assert.Equal(t, http.StatusOK, genreOverviewGet(h, "genre=Comedy").Code)
}

func TestGenreOverview_RailErrorIs500(t *testing.T) {
	t.Parallel()

	db := &fakeGenreOverviewDB{}
	db.err = errors.New("timeout")
	rec := genreOverviewGet(genreOverviewHandler(db, newGenreOverviewCacheT(t), time.Now), "genre=Action")
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Zero(t, db.tileCalls, "the first failure ends the read")
}

// TestGenreOverview_RouteDoesNotCollideWithDetail — /genre-overview is a
// fixed segment in the subtree /{anilistId} also matches, as /episodes is.
func TestGenreOverview_RouteDoesNotCollideWithDetail(t *testing.T) {
	t.Parallel()

	var detailHits []string
	r := chi.NewRouter()
	r.Route("/api/anime", func(r chi.Router) {
		r.Get("/genre-overview", genreOverviewHandler(&fakeGenreOverviewDB{}, newGenreOverviewCacheT(t), time.Now))
		r.Get("/{anilistId}", func(w http.ResponseWriter, req *http.Request) {
			detailHits = append(detailHits, chi.URLParam(req, "anilistId"))
		})
	})

	rec := genreOverviewGet(r, "genre=Action")
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"genre":"Action"`)
	assert.Empty(t, detailHits)
}
