package anime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/torrents"
)

// fakeQuerier is a hand-rolled mock of dbgen.Querier.  Each method is a
// function-pointer field; unset fields panic loudly via the embedded
// dbgen.Querier (whose default methods are unimplemented).
//
// Why hand-rolled instead of mockgen: the surface area is small (7
// methods total) and only a subset is exercised per test.  When the
// querier grows beyond ~15 methods we switch to mockgen.
type fakeQuerier struct {
	dbgen.Querier // embed so unimplemented methods panic loud and clear

	getCompletedGemsFn      func(ctx context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error)
	getYearlyTopFn          func(ctx context.Context, year *int32, limit int32) ([]dbgen.GetYearlyTopRow, error)
	getSeasonalAnimeFn      func(ctx context.Context, season *string, year *int32, limit, offset int32) ([]dbgen.GetSeasonalAnimeRow, error)
	countSeasonalFn         func(ctx context.Context, season *string, year *int32) (int64, error)
	getTrendingWithCountsFn func(ctx context.Context, limit int32) ([]dbgen.GetTrendingWithCountsRow, error)
	getWatchersFn           func(ctx context.Context, id int32, limit int32) ([]string, error)
	countWatchersFn         func(ctx context.Context, id int32) (int64, error)
}

func (f *fakeQuerier) GetCompletedGems(ctx context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error) {
	if f.getCompletedGemsFn == nil {
		return nil, errors.New("fakeQuerier: GetCompletedGems not set")
	}
	return f.getCompletedGemsFn(ctx, limit)
}

func (f *fakeQuerier) GetYearlyTop(ctx context.Context, year *int32, limit int32) ([]dbgen.GetYearlyTopRow, error) {
	if f.getYearlyTopFn == nil {
		return nil, errors.New("fakeQuerier: GetYearlyTop not set")
	}
	return f.getYearlyTopFn(ctx, year, limit)
}

func (f *fakeQuerier) GetSeasonalAnime(ctx context.Context, season *string, year *int32, limit, offset int32) ([]dbgen.GetSeasonalAnimeRow, error) {
	if f.getSeasonalAnimeFn == nil {
		return nil, errors.New("fakeQuerier: GetSeasonalAnime not set")
	}
	return f.getSeasonalAnimeFn(ctx, season, year, limit, offset)
}

func (f *fakeQuerier) CountSeasonal(ctx context.Context, season *string, year *int32) (int64, error) {
	if f.countSeasonalFn == nil {
		return 0, errors.New("fakeQuerier: CountSeasonal not set")
	}
	return f.countSeasonalFn(ctx, season, year)
}

func (f *fakeQuerier) GetTrendingWithCounts(ctx context.Context, limit int32) ([]dbgen.GetTrendingWithCountsRow, error) {
	if f.getTrendingWithCountsFn == nil {
		return nil, errors.New("fakeQuerier: GetTrendingWithCounts not set")
	}
	return f.getTrendingWithCountsFn(ctx, limit)
}

func (f *fakeQuerier) GetWatchers(ctx context.Context, id int32, limit int32) ([]string, error) {
	if f.getWatchersFn == nil {
		return nil, errors.New("fakeQuerier: GetWatchers not set")
	}
	return f.getWatchersFn(ctx, id, limit)
}

func (f *fakeQuerier) CountWatchers(ctx context.Context, id int32) (int64, error) {
	if f.countWatchersFn == nil {
		return 0, errors.New("fakeQuerier: CountWatchers not set")
	}
	return f.countWatchersFn(ctx, id)
}

// -----------------------------------------------------------------------------
// CompletedGems — covers the pre-existing handler (regression safety).
// -----------------------------------------------------------------------------

func TestCompletedGems_DefaultLimit(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	q := &fakeQuerier{
		getCompletedGemsFn: func(_ context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error) {
			gotLimit = limit
			return []dbgen.GetCompletedGemsRow{}, nil
		},
	}

	rec := httptest.NewRecorder()
	CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems", nil))

	if gotLimit != 6 {
		t.Errorf("default limit = %d, want 6", gotLimit)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != `{"data":[]}` {
		t.Errorf("body = %q, want %q", got, `{"data":[]}`)
	}
}

func TestCompletedGems_LimitCappedAt20(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	q := &fakeQuerier{
		getCompletedGemsFn: func(_ context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error) {
			gotLimit = limit
			return nil, nil
		},
	}

	rec := httptest.NewRecorder()
	CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems?limit=50", nil))

	if gotLimit != 20 {
		t.Errorf("limit = %d, want 20 (cap)", gotLimit)
	}
}

func TestCompletedGems_LimitParsing(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		query     string
		wantLimit int32
	}{
		{"explicit 5", "?limit=5", 5},
		{"explicit 1", "?limit=1", 1},
		{"max cap 20", "?limit=20", 20},
		{"over max → 20", "?limit=999", 20},
		{"non-numeric → default", "?limit=abc", 6},
		{"negative → default", "?limit=-3", 6},
		{"zero → default", "?limit=0", 6},
		{"empty → default", "?limit=", 6},
		{"missing → default", "", 6},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var gotLimit int32
			q := &fakeQuerier{
				getCompletedGemsFn: func(_ context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error) {
					gotLimit = limit
					return nil, nil
				},
			}
			rec := httptest.NewRecorder()
			CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems"+tc.query, nil))

			if gotLimit != tc.wantLimit {
				t.Errorf("limit = %d, want %d", gotLimit, tc.wantLimit)
			}
		})
	}
}

func TestCompletedGems_DBError(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getCompletedGemsFn: func(_ context.Context, _ int32) ([]dbgen.GetCompletedGemsRow, error) {
			return nil, errors.New("simulated postgres failure")
		},
	}

	rec := httptest.NewRecorder()
	CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"SERVER_ERROR"`)
	require.NotContains(t, body, "simulated postgres failure", "body must not leak cause")
}

func TestCompletedGems_Envelope(t *testing.T) {
	t.Parallel()

	score := 78.0
	bgmScore := 7.6
	cover := "https://s4.anilist.co/file/.../bxXXX.jpg"
	colorless := (*string)(nil)
	episodes := int32(12)
	season := "FALL"
	year := int32(2024)
	status := "FINISHED"
	format := "TV"
	desc := "test description"
	romaji := "Test Title Romaji"

	q := &fakeQuerier{
		getCompletedGemsFn: func(_ context.Context, _ int32) ([]dbgen.GetCompletedGemsRow, error) {
			return []dbgen.GetCompletedGemsRow{
				{
					AnilistID:       12345,
					TitleRomaji:     &romaji,
					CoverImageUrl:   &cover,
					CoverImageColor: colorless,
					AverageScore:    &score,
					BangumiScore:    &bgmScore,
					Episodes:        &episodes,
					Season:          &season,
					SeasonYear:      &year,
					Status:          &status,
					Format:          &format,
					Description:     &desc,
				},
			}, nil
		},
	}

	rec := httptest.NewRecorder()
	CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems?limit=1", nil))

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d", rec.Code)
	}
	want := []string{
		`{"data":[`,
		`"anilistId":12345`,
		`"titleRomaji":"Test Title Romaji"`,
		`"coverImageColor":null`,
		`"averageScore":78`,
		`"bangumiScore":7.6`,
		`"episodes":12`,
		`"season":"FALL"`,
		`"status":"FINISHED"`,
	}
	body := rec.Body.String()
	for _, frag := range want {
		if !strings.Contains(body, frag) {
			t.Errorf("body missing fragment %q\nfull: %s", frag, body)
		}
	}
}

// -----------------------------------------------------------------------------
// Seasonal tests moved to seasonal_test.go after the SeasonalService
// extraction in P2.1.4.  Direct unit tests for the warm + cold-start
// paths live there alongside the AniList fake.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// YearlyTop — DB called with hard 20, slice in handler.
// -----------------------------------------------------------------------------

func TestYearlyTop_QueriesYear20_SlicesToLimit(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	q := &fakeQuerier{
		getYearlyTopFn: func(_ context.Context, _ *int32, limit int32) ([]dbgen.GetYearlyTopRow, error) {
			gotLimit = limit
			// Return 20 rows.
			rows := make([]dbgen.GetYearlyTopRow, 20)
			for i := 0; i < 20; i++ {
				rows[i].AnilistID = int32(i + 1)
			}
			return rows, nil
		},
	}

	rec := httptest.NewRecorder()
	YearlyTop(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/yearly-top?limit=5", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(20), gotLimit, "DB always called with 20")

	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.LessOrEqual(t, len(parsed.Data), 5, "response sliced to client limit")
	assert.Equal(t, 5, len(parsed.Data), "exactly 5 returned when 20 available")
}

func TestYearlyTop_DefaultYearIsCurrent(t *testing.T) {
	t.Parallel()

	var gotYear *int32
	q := &fakeQuerier{
		getYearlyTopFn: func(_ context.Context, year *int32, _ int32) ([]dbgen.GetYearlyTopRow, error) {
			gotYear = year
			return nil, nil
		},
	}

	rec := httptest.NewRecorder()
	YearlyTop(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/yearly-top", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, gotYear)
	assert.Equal(t, int32(time.Now().UTC().Year()), *gotYear)
}

func TestYearlyTop_DefaultLimit(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getYearlyTopFn: func(_ context.Context, _ *int32, _ int32) ([]dbgen.GetYearlyTopRow, error) {
			// Return 12 rows; default limit is 10.
			rows := make([]dbgen.GetYearlyTopRow, 12)
			for i := 0; i < 12; i++ {
				rows[i].AnilistID = int32(i + 1)
			}
			return rows, nil
		},
	}

	rec := httptest.NewRecorder()
	YearlyTop(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/yearly-top", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Equal(t, 10, len(parsed.Data), "default limit slices to 10")
}

func TestYearlyTop_DBError(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getYearlyTopFn: func(_ context.Context, _ *int32, _ int32) ([]dbgen.GetYearlyTopRow, error) {
			return nil, errors.New("boom")
		},
	}

	rec := httptest.NewRecorder()
	YearlyTop(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/yearly-top", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

// -----------------------------------------------------------------------------
// Trending — rank injection + slicing.
// -----------------------------------------------------------------------------

func TestTrending_RankAndWatcherCount(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getTrendingWithCountsFn: func(_ context.Context, _ int32) ([]dbgen.GetTrendingWithCountsRow, error) {
			return []dbgen.GetTrendingWithCountsRow{
				{AnilistID: 100, WatcherCount: 50},
				{AnilistID: 200, WatcherCount: 30},
				{AnilistID: 300, WatcherCount: 10},
			}, nil
		},
	}

	rec := httptest.NewRecorder()
	Trending(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/trending", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Data []struct {
			Rank         int   `json:"rank"`
			WatcherCount int64 `json:"watcherCount"`
			AnilistID    int32 `json:"anilistId"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data, 3)
	assert.Equal(t, 1, parsed.Data[0].Rank)
	assert.Equal(t, int64(50), parsed.Data[0].WatcherCount)
	assert.Equal(t, int32(100), parsed.Data[0].AnilistID)
	assert.Equal(t, 2, parsed.Data[1].Rank)
	assert.Equal(t, 3, parsed.Data[2].Rank)
}

func TestTrending_LimitSlicing(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getTrendingWithCountsFn: func(_ context.Context, _ int32) ([]dbgen.GetTrendingWithCountsRow, error) {
			rows := make([]dbgen.GetTrendingWithCountsRow, 20)
			for i := 0; i < 20; i++ {
				rows[i] = dbgen.GetTrendingWithCountsRow{
					AnilistID:    int32(i + 1),
					WatcherCount: int64(100 - i),
				}
			}
			return rows, nil
		},
	}

	rec := httptest.NewRecorder()
	Trending(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/trending?limit=5", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Len(t, parsed.Data, 5)
}

func TestTrending_LimitCappedAt20(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getTrendingWithCountsFn: func(_ context.Context, _ int32) ([]dbgen.GetTrendingWithCountsRow, error) {
			rows := make([]dbgen.GetTrendingWithCountsRow, 20)
			for i := 0; i < 20; i++ {
				rows[i] = dbgen.GetTrendingWithCountsRow{
					AnilistID:    int32(i + 1),
					WatcherCount: int64(100 - i),
				}
			}
			return rows, nil
		},
	}

	rec := httptest.NewRecorder()
	Trending(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/trending?limit=999", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Len(t, parsed.Data, 20, "limit capped at 20")
}

func TestTrending_DBError(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getTrendingWithCountsFn: func(_ context.Context, _ int32) ([]dbgen.GetTrendingWithCountsRow, error) {
			return nil, errors.New("boom")
		},
	}

	rec := httptest.NewRecorder()
	Trending(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/trending", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestTrending_FieldOrder_RankFirst(t *testing.T) {
	t.Parallel()

	// Verify that "rank" appears in the JSON output before "anilistId"
	// — Express emits {rank, watcherCount, ...animeFields} so the order
	// of struct fields matters for byte parity.
	q := &fakeQuerier{
		getTrendingWithCountsFn: func(_ context.Context, _ int32) ([]dbgen.GetTrendingWithCountsRow, error) {
			return []dbgen.GetTrendingWithCountsRow{
				{AnilistID: 1, WatcherCount: 5},
			}, nil
		},
	}

	rec := httptest.NewRecorder()
	Trending(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/trending", nil))

	body := rec.Body.String()
	rankIdx := strings.Index(body, `"rank"`)
	watcherIdx := strings.Index(body, `"watcherCount"`)
	anilistIdx := strings.Index(body, `"anilistId"`)
	require.Greater(t, rankIdx, -1)
	require.Greater(t, watcherIdx, -1)
	require.Greater(t, anilistIdx, -1)
	assert.True(t, rankIdx < watcherIdx, "rank should come before watcherCount")
	assert.True(t, watcherIdx < anilistIdx, "watcherCount should come before anilistId")
}

// -----------------------------------------------------------------------------
// Watchers — chi URL param parsing + parallel queries.
// -----------------------------------------------------------------------------

// watchersRouter wraps the handler in a chi router so chi.URLParam can
// resolve {anilistId}.  Without this, calling the handler directly via
// httptest would see an empty string for the param.
func watchersRouter(q dbgen.Querier) http.Handler {
	r := chi.NewRouter()
	r.Get("/api/anime/{anilistId}/watchers", Watchers(q))
	return r
}

func TestWatchers_InvalidID(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{}
	rec := httptest.NewRecorder()
	watchersRouter(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/abc/watchers", nil))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), `"VALIDATION_ERROR"`)
	require.Contains(t, rec.Body.String(), "无效的番剧 ID")
}

func TestWatchers_EnvelopeShape(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getWatchersFn: func(_ context.Context, _ int32, _ int32) ([]string, error) {
			return []string{"alice", "bob"}, nil
		},
		countWatchersFn: func(_ context.Context, _ int32) (int64, error) {
			return 2, nil
		},
	}

	rec := httptest.NewRecorder()
	watchersRouter(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/42/watchers", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()

	// Structural assertion.
	var parsed struct {
		Data []struct {
			Username string `json:"username"`
		} `json:"data"`
		Total int64 `json:"total"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &parsed))
	require.Len(t, parsed.Data, 2)
	assert.Equal(t, "alice", parsed.Data[0].Username)
	assert.Equal(t, "bob", parsed.Data[1].Username)
	assert.Equal(t, int64(2), parsed.Total)

	// Field order: data before total.
	dataIdx := strings.Index(body, `"data"`)
	totalIdx := strings.Index(body, `"total"`)
	require.Greater(t, dataIdx, -1)
	require.Greater(t, totalIdx, dataIdx, "data must come before total")
}

func TestWatchers_LimitCap20(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	q := &fakeQuerier{
		getWatchersFn: func(_ context.Context, _ int32, limit int32) ([]string, error) {
			gotLimit = limit
			return nil, nil
		},
		countWatchersFn: func(_ context.Context, _ int32) (int64, error) {
			return 0, nil
		},
	}

	rec := httptest.NewRecorder()
	watchersRouter(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/42/watchers?limit=99", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(20), gotLimit, "limit should be capped at 20")
}

func TestWatchers_DefaultLimit(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	q := &fakeQuerier{
		getWatchersFn: func(_ context.Context, _ int32, limit int32) ([]string, error) {
			gotLimit = limit
			return nil, nil
		},
		countWatchersFn: func(_ context.Context, _ int32) (int64, error) {
			return 0, nil
		},
	}

	rec := httptest.NewRecorder()
	watchersRouter(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/42/watchers", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(5), gotLimit, "default limit should be 5")
}

func TestWatchers_DBError(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getWatchersFn: func(_ context.Context, _ int32, _ int32) ([]string, error) {
			return nil, errors.New("boom")
		},
		countWatchersFn: func(_ context.Context, _ int32) (int64, error) {
			return 0, nil
		},
	}

	rec := httptest.NewRecorder()
	watchersRouter(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/42/watchers", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestWatchers_AnilistIDPassedThrough(t *testing.T) {
	t.Parallel()

	var gotID int32
	q := &fakeQuerier{
		getWatchersFn: func(_ context.Context, id int32, _ int32) ([]string, error) {
			gotID = id
			return nil, nil
		},
		countWatchersFn: func(_ context.Context, _ int32) (int64, error) {
			return 0, nil
		},
	}

	rec := httptest.NewRecorder()
	watchersRouter(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/12345/watchers", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(12345), gotID)
}

// -----------------------------------------------------------------------------
// Torrents — query validation + happy path via a stub aggregator.
// -----------------------------------------------------------------------------

// newStubAggregator returns a torrents.Aggregator wired with all-static
// stub fetchers via the test-only With{Garden,Acg,Nyaa}Fn options.  The
// caller controls each source's payload independently.
func newStubAggregator(t *testing.T, garden, acg, nyaa []torrents.TorrentItem) *torrents.Aggregator {
	t.Helper()
	a, err := torrents.New(
		torrents.WithGardenFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return garden, nil }),
		torrents.WithAcgFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return acg, nil }),
		torrents.WithNyaaFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return nyaa, nil }),
	)
	require.NoError(t, err)
	t.Cleanup(a.Close)
	return a
}

func TestTorrents_MissingQuery(t *testing.T) {
	t.Parallel()

	agg := newStubAggregator(t, nil, nil, nil)
	rec := httptest.NewRecorder()
	Torrents(agg).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/torrents", nil))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "Missing query")
	require.Contains(t, rec.Body.String(), `"VALIDATION_ERROR"`)
}

func TestTorrents_QueryTooLong(t *testing.T) {
	t.Parallel()

	agg := newStubAggregator(t, nil, nil, nil)
	rec := httptest.NewRecorder()
	longQ := strings.Repeat("a", 201)
	rec = httptest.NewRecorder()
	Torrents(agg).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/torrents?q="+longQ, nil))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "Query too long")
	require.Contains(t, rec.Body.String(), `"VALIDATION_ERROR"`)
}

func TestTorrents_HappyPath(t *testing.T) {
	t.Parallel()

	gardenTitle := "Anime A [garden]"
	acgTitle := "Anime B [acg]"
	gardenMagnet := "magnet:?xt=urn:btih:GARDEN"
	acgMagnet := "magnet:?xt=urn:btih:ACG"
	agg := newStubAggregator(t,
		[]torrents.TorrentItem{
			{Title: gardenTitle, Magnet: gardenMagnet, Size: "1 GB", Source: torrents.SourceGarden},
		},
		[]torrents.TorrentItem{
			{Title: acgTitle, Magnet: acgMagnet, Size: "500 MB", Source: torrents.SourceAcg},
		},
		nil, // nyaa empty
	)

	rec := httptest.NewRecorder()
	Torrents(agg).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/torrents?q=naruto", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	require.True(t, strings.HasPrefix(body, `{"data":[`), "envelope should start with {\"data\":[")

	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &parsed))
	require.Len(t, parsed.Data, 2)
	assert.Equal(t, gardenTitle, parsed.Data[0]["title"])
	assert.Equal(t, "garden", parsed.Data[0]["source"])
	assert.Equal(t, acgTitle, parsed.Data[1]["title"])
	assert.Equal(t, "acg", parsed.Data[1]["source"])
}

func TestTorrents_EmptyResults(t *testing.T) {
	t.Parallel()

	agg := newStubAggregator(t, nil, nil, nil)
	rec := httptest.NewRecorder()
	Torrents(agg).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/torrents?q=zzzz", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	// Empty array, not null.
	assert.Equal(t, `{"data":[]}`, rec.Body.String())
}

// -----------------------------------------------------------------------------
// parseLimit / parseYear / validSeason — direct unit coverage.
// -----------------------------------------------------------------------------

func TestParseLimit_Table(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in       string
		def, max int
		want     int
	}{
		{"", 6, 20, 6},
		{"5", 6, 20, 5},
		{"50", 6, 20, 20},
		{"-1", 6, 20, 6},
		{"abc", 6, 20, 6},
	}
	for _, tc := range cases {
		got := parseLimit(tc.in, tc.def, tc.max)
		if got != tc.want {
			t.Errorf("parseLimit(%q, %d, %d) = %d, want %d", tc.in, tc.def, tc.max, got, tc.want)
		}
	}
}

func TestParseYear_Table(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC().Year()
	cases := []struct {
		in   string
		want int
	}{
		{"", now},
		{"2024", 2024},
		{"abc", now},
		{"1800", now},  // out of range
		{"3001", now},  // out of range
		{"-2024", now}, // out of range
	}
	for _, tc := range cases {
		got := parseYear(tc.in)
		if got != tc.want {
			t.Errorf("parseYear(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestValidSeason_Table(t *testing.T) {
	t.Parallel()

	good := []string{"WINTER", "SPRING", "SUMMER", "FALL"}
	bad := []string{"", "winter", "Winter", "FOO", "AUTUMN"}
	for _, s := range good {
		if !validSeason(s) {
			t.Errorf("validSeason(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if validSeason(s) {
			t.Errorf("validSeason(%q) = true, want false", s)
		}
	}
}

// Compile-time sanity: ensure the fakeQuerier satisfies dbgen.Querier
// for all methods we exercise.  If the interface grows in P2.1.4 and we
// don't update the mock, this assertion gives an actionable error.
var _ dbgen.Querier = (*fakeQuerier)(nil)

// fmt import is used in some test branches as Sprintf — leave the
// import live even if a future refactor drops it.
var _ = fmt.Sprintf
