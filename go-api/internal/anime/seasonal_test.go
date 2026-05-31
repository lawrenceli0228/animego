package anime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// -----------------------------------------------------------------------------
// Test doubles.
// -----------------------------------------------------------------------------

// fakeSeasonalDB implements SeasonalDB for the SeasonalService tests.
// Each method is a function-pointer field; unset fields return a clear
// "not set" error so accidental cross-call shows up immediately.  Mutex
// + counters/captures track invocation behaviour for the upsert + re-
// read assertions on the cold-start path.
type fakeSeasonalDB struct {
	mu sync.Mutex

	getSeasonalAnimeFn func(ctx context.Context, season *string, year *int32, limit, offset int32) ([]dbgen.GetSeasonalAnimeRow, error)
	countSeasonalFn    func(ctx context.Context, season *string, year *int32) (int64, error)
	upsertAnimeCacheFn func(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error

	getSeasonalCalls atomic.Int32
	countCalls       atomic.Int32
	upsertCalls      atomic.Int32

	upsertedParams []dbgen.UpsertAnimeCacheParams
}

func (f *fakeSeasonalDB) GetSeasonalAnime(ctx context.Context, season *string, year *int32, limit, offset int32) ([]dbgen.GetSeasonalAnimeRow, error) {
	f.getSeasonalCalls.Add(1)
	if f.getSeasonalAnimeFn == nil {
		return []dbgen.GetSeasonalAnimeRow{}, nil
	}
	return f.getSeasonalAnimeFn(ctx, season, year, limit, offset)
}

func (f *fakeSeasonalDB) CountSeasonal(ctx context.Context, season *string, year *int32) (int64, error) {
	f.countCalls.Add(1)
	if f.countSeasonalFn == nil {
		return 0, nil
	}
	return f.countSeasonalFn(ctx, season, year)
}

func (f *fakeSeasonalDB) UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error {
	f.upsertCalls.Add(1)
	f.mu.Lock()
	f.upsertedParams = append(f.upsertedParams, arg)
	f.mu.Unlock()
	if f.upsertAnimeCacheFn == nil {
		return nil
	}
	return f.upsertAnimeCacheFn(ctx, arg)
}

func (f *fakeSeasonalDB) snapshotUpsertedParams() []dbgen.UpsertAnimeCacheParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]dbgen.UpsertAnimeCacheParams, len(f.upsertedParams))
	copy(dup, f.upsertedParams)
	return dup
}

// fakeSeasonaler implements AniListSeasonaler for the cold-start tests.
// fn pointer controls behaviour; calls counter records invocation count
// so warm-cache tests can assert AniList was NOT touched.  Atomic
// counter is race-detector-safe even if a test ever fires concurrent
// requests.
type fakeSeasonaler struct {
	mu    sync.Mutex
	fn    func(ctx context.Context, v anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error)
	calls atomic.Int32
	last  anilist.SeasonalVars
}

func (f *fakeSeasonaler) Seasonal(ctx context.Context, v anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
	f.calls.Add(1)
	f.mu.Lock()
	f.last = v
	f.mu.Unlock()
	if f.fn == nil {
		return &anilist.SeasonalAnimeResponse{}, nil
	}
	return f.fn(ctx, v)
}

func (f *fakeSeasonaler) callCount() int32 { return f.calls.Load() }

func (f *fakeSeasonaler) lastVars() anilist.SeasonalVars {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.last
}

// seasonalMediaWith builds a minimal anilist.Media with an ID + romaji
// title.  Title pointer is non-nil so NormalizeMainRow doesn't have to
// deal with a nil Title — keeps the upsert path stable.
func seasonalMediaWith(id int) anilist.Media {
	romaji := "Title " + itoa(id)
	return anilist.Media{
		ID:    id,
		Title: &anilist.Title{Romaji: &romaji},
	}
}

// -----------------------------------------------------------------------------
// Warmed-cache (warm) path — DB returns rows + count, AniList is NOT
// touched even when wired.
// -----------------------------------------------------------------------------

func TestSeasonal_WarmedCache_HappyPath(t *testing.T) {
	t.Parallel()

	romaji := "Test Anime"
	dbRows := []dbgen.GetSeasonalAnimeRow{
		{AnilistID: 1, TitleRomaji: &romaji},
		{AnilistID: 2, TitleRomaji: &romaji},
		{AnilistID: 3, TitleRomaji: &romaji},
	}
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return dbRows, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 10, nil
		},
	}
	al := &fakeSeasonaler{}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(0), al.callCount(), "warm path must NOT call AniList")

	var parsed struct {
		Data       []map[string]any `json:"data"`
		Pagination struct {
			Page       int `json:"page"`
			PerPage    int `json:"perPage"`
			Total      int `json:"total"`
			TotalPages int `json:"totalPages"`
		} `json:"pagination"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data, 3)
	assert.Equal(t, 10, parsed.Pagination.Total)
	assert.Equal(t, 1, parsed.Pagination.Page)
	assert.Equal(t, 20, parsed.Pagination.PerPage)
	assert.Equal(t, 1, parsed.Pagination.TotalPages, "ceil(10/20) = 1")
}

func TestSeasonal_Defaults(t *testing.T) {
	t.Parallel()

	var (
		gotSeason *string
		gotYear   *int32
		gotLimit  int32
		gotOffset int32
	)
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, season *string, year *int32, limit, offset int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			gotSeason = season
			gotYear = year
			gotLimit = limit
			gotOffset = offset
			return []dbgen.GetSeasonalAnimeRow{}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 5, nil // > 0 so warm path returns without cold-start
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, gotSeason)
	assert.Equal(t, "WINTER", *gotSeason, "default season")
	require.NotNil(t, gotYear)
	assert.Equal(t, int32(time.Now().UTC().Year()), *gotYear, "default year")
	assert.Equal(t, int32(20), gotLimit, "default perPage")
	assert.Equal(t, int32(0), gotOffset, "default page=1 → offset=0")
}

func TestSeasonal_PageOffsetMath(t *testing.T) {
	t.Parallel()

	var gotOffset int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, offset int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			gotOffset = offset
			return nil, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 100, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?page=3&perPage=15", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(30), gotOffset, "page=3 perPage=15 → offset=30")
}

// -----------------------------------------------------------------------------
// Validation & input parsing.
// -----------------------------------------------------------------------------

func TestSeasonal_InvalidSeason_400(t *testing.T) {
	t.Parallel()

	db := &fakeSeasonalDB{}
	al := &fakeSeasonaler{}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?season=BAD", nil))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), `"VALIDATION_ERROR"`)
	assert.Equal(t, int32(0), al.callCount(), "AniList must NOT be called on validation failure")
	assert.Equal(t, int32(0), db.getSeasonalCalls.Load(), "DB must NOT be queried on validation failure")
}

func TestSeasonal_NegativePage_FallsBackTo1(t *testing.T) {
	t.Parallel()

	var gotOffset int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, offset int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			gotOffset = offset
			return nil, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 5, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?page=-3", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(0), gotOffset, "negative page must clamp to 1 → offset=0")
}

func TestSeasonal_PerPageCappedAt200(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, limit, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			gotLimit = limit
			return nil, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 5, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?perPage=500", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(200), gotLimit, "perPage > 200 must be capped at 200")
}

func TestSeasonal_NonNumericPerPage_FallsBack(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, limit, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			gotLimit = limit
			return nil, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 5, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?perPage=abc", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(20), gotLimit, "non-numeric perPage → default 20")
}

func TestSeasonal_ZeroPerPage_FallsBack(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, limit, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			gotLimit = limit
			return nil, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 5, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?perPage=0", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(20), gotLimit, "perPage=0 must clamp to default 20")
}

// -----------------------------------------------------------------------------
// Cold-start path (CountSeasonal == 0 AND AniList wired).
// -----------------------------------------------------------------------------

func TestSeasonal_ColdStart_WithAniList(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{
		seasonalMediaWith(101),
		seasonalMediaWith(102),
		seasonalMediaWith(103),
		seasonalMediaWith(104),
		seasonalMediaWith(105),
	}
	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return &anilist.SeasonalAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{
						Total: 42, CurrentPage: 1, LastPage: 3, PerPage: 20,
					},
					Media: media,
				},
			}, nil
		},
	}

	// DB sequence: initial GetSeasonalAnime returns empty + CountSeasonal
	// returns 0 (warm-cache miss).  After upserts, the re-read returns
	// the 5 just-written rows.
	var seasonalCalls atomic.Int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			seasonalCalls.Add(1)
			// First call: empty; second call (post-upsert re-read): 5 rows.
			if seasonalCalls.Load() == 1 {
				return []dbgen.GetSeasonalAnimeRow{}, nil
			}
			out := make([]dbgen.GetSeasonalAnimeRow, 0, len(media))
			for _, m := range media {
				id := int32(m.ID)
				out = append(out, dbgen.GetSeasonalAnimeRow{AnilistID: id})
			}
			return out, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?season=WINTER&year=2024", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(1), al.callCount(), "AniList called once on cold-start")
	assert.Equal(t, int32(5), db.upsertCalls.Load(), "UpsertAnimeCache called per AniList Media")
	assert.Equal(t, int32(2), seasonalCalls.Load(), "GetSeasonalAnime called twice — initial + post-upsert re-read")

	// Verify the upsert payloads carry the AniList IDs.
	params := db.snapshotUpsertedParams()
	require.Len(t, params, 5)
	gotIDs := make([]int32, 0, len(params))
	for _, p := range params {
		gotIDs = append(gotIDs, p.AnilistID)
	}
	assert.Equal(t, []int32{101, 102, 103, 104, 105}, gotIDs)

	// Verify response data + total from AniList PageInfo.
	var parsed struct {
		Data       []map[string]any `json:"data"`
		Pagination struct {
			Page       int `json:"page"`
			PerPage    int `json:"perPage"`
			Total      int `json:"total"`
			TotalPages int `json:"totalPages"`
		} `json:"pagination"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data, 5)
	assert.Equal(t, 42, parsed.Pagination.Total, "total comes from AniList PageInfo")
	assert.Equal(t, 1, parsed.Pagination.Page)
	assert.Equal(t, 20, parsed.Pagination.PerPage)
	assert.Equal(t, 3, parsed.Pagination.TotalPages, "ceil(42/20) = 3")
}

func TestSeasonal_ColdStart_AniListNil_NoFallback(t *testing.T) {
	t.Parallel()

	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return []dbgen.GetSeasonalAnimeRow{}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil // warm-cache miss
		},
	}
	svc := NewSeasonalService(db, nil) // AniList NOT wired

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(0), db.upsertCalls.Load(), "no upsert when AniList not wired")

	var parsed struct {
		Data       []map[string]any `json:"data"`
		Pagination struct {
			Total int `json:"total"`
		} `json:"pagination"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Empty(t, parsed.Data, "data must be empty array")
	assert.Equal(t, 0, parsed.Pagination.Total)

	// And the response is `"data":[]` not `"data":null`.
	body := rec.Body.String()
	require.Contains(t, body, `"data":[]`)
}

func TestSeasonal_ColdStart_AniListError_FallsBackToEmpty(t *testing.T) {
	t.Parallel()

	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return nil, &anilist.ErrUpstream{Status: 500, Message: "AniList API error: 500"}
		},
	}
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return []dbgen.GetSeasonalAnimeRow{}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	// AniList upstream error must NOT bubble up as 502 — cold-start
	// failures are soft, the user gets a 200 with empty data so they
	// can retry later.
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(0), db.upsertCalls.Load(), "no upsert when AniList errored")

	var parsed struct {
		Data       []map[string]any `json:"data"`
		Pagination struct {
			Total int `json:"total"`
		} `json:"pagination"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Empty(t, parsed.Data)
	assert.Equal(t, 0, parsed.Pagination.Total)
}

func TestSeasonal_ColdStart_AniListGenericError_FallsBackToEmpty(t *testing.T) {
	t.Parallel()

	// Exercise the default branch of the AniList error switch (neither
	// ErrUpstream nor ErrRateLimited — e.g. a transport / decode failure).
	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return nil, errors.New("transport failure: connection reset")
		},
	}
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return []dbgen.GetSeasonalAnimeRow{}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	require.Equal(t, http.StatusOK, rec.Code, "generic transport error must not 500 — cold-start is soft-fail")
	assert.Equal(t, int32(0), db.upsertCalls.Load())
	require.NotContains(t, rec.Body.String(), "connection reset", "cause must not leak to body")
}

func TestSeasonal_ColdStart_AniListRateLimited_FallsBackToEmpty(t *testing.T) {
	t.Parallel()

	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return nil, anilist.ErrRateLimited
		},
	}
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return []dbgen.GetSeasonalAnimeRow{}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	require.Equal(t, http.StatusOK, rec.Code, "rate-limited AniList must not 502 the response")
	assert.Equal(t, int32(0), db.upsertCalls.Load())
}

func TestSeasonal_ColdStart_PerPageCappedAt50ForAniList(t *testing.T) {
	t.Parallel()

	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return &anilist.SeasonalAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 50},
				},
			}, nil
		},
	}
	var dbLimit int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, limit, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			dbLimit = limit
			return []dbgen.GetSeasonalAnimeRow{}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?perPage=100", nil))

	require.Equal(t, http.StatusOK, rec.Code)

	// Two independent caps:
	//   - DB-side cap is 200 → perPage=100 stays at 100 → limit=100.
	//   - AniList-side cap is 50 → handler must pass perPage=50.
	assert.Equal(t, int32(100), dbLimit, "DB limit must remain 100 (under 200 cap)")
	assert.Equal(t, 50, al.lastVars().PerPage, "AniList perPage must be capped at 50")
}

func TestSeasonal_ColdStart_UpsertError_NonFatal(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{
		seasonalMediaWith(1),
		seasonalMediaWith(2),
		seasonalMediaWith(3),
		seasonalMediaWith(4),
		seasonalMediaWith(5),
	}
	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return &anilist.SeasonalAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 5, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    media,
				},
			}, nil
		},
	}

	// Simulate id=3 failing on upsert.  The remaining 4 should succeed,
	// and the post-upsert re-read returns those 4.
	var seasonalCalls atomic.Int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			seasonalCalls.Add(1)
			if seasonalCalls.Load() == 1 {
				return []dbgen.GetSeasonalAnimeRow{}, nil
			}
			// Post-upsert re-read returns 4 rows (id=3 failed).
			return []dbgen.GetSeasonalAnimeRow{
				{AnilistID: 1},
				{AnilistID: 2},
				{AnilistID: 4},
				{AnilistID: 5},
			}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
		upsertAnimeCacheFn: func(_ context.Context, arg dbgen.UpsertAnimeCacheParams) error {
			if arg.AnilistID == 3 {
				return errors.New("simulated upsert failure for id=3")
			}
			return nil
		},
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	// Per-row upsert failure must NOT fail the request.  All 5 attempts
	// were made — only id=3 failed.
	require.Equal(t, http.StatusOK, rec.Code, "single upsert failure must not fail the request")
	assert.Equal(t, int32(5), db.upsertCalls.Load(), "all 5 upsert attempts made")

	// Re-read sees 4 rows (the ones that succeeded).
	var parsed struct {
		Data []struct {
			AnilistID int32 `json:"anilistId"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data, 4)
}

func TestSeasonal_ColdStart_AniListVarsPassedThrough(t *testing.T) {
	t.Parallel()

	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return &anilist.SeasonalAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20},
				},
			}, nil
		},
	}
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return []dbgen.GetSeasonalAnimeRow{}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?season=SUMMER&year=2025&page=2&perPage=10", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	v := al.lastVars()
	assert.Equal(t, "SUMMER", v.Season)
	assert.Equal(t, 2025, v.SeasonYear)
	assert.Equal(t, 2, v.Page)
	assert.Equal(t, 10, v.PerPage, "AniList perPage matches request (under 50 cap)")
}

// -----------------------------------------------------------------------------
// Envelope shape — byte-level field order + non-null empty arrays.
// -----------------------------------------------------------------------------

func TestSeasonal_EnvelopeShape(t *testing.T) {
	t.Parallel()

	romaji := "Test Anime"
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return []dbgen.GetSeasonalAnimeRow{{AnilistID: 1, TitleRomaji: &romaji}}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 1, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?season=SUMMER&year=2024", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "application/json; charset=utf-8", rec.Header().Get("Content-Type"))
	body := rec.Body.String()

	// Byte-level field order: data comes before pagination.
	dataIdx := strings.Index(body, `"data"`)
	pagIdx := strings.Index(body, `"pagination"`)
	require.Greater(t, dataIdx, -1)
	require.Greater(t, pagIdx, dataIdx, "pagination must come after data in JSON output")

	// Pagination sub-fields appear in declaration order.
	pageIdx := strings.Index(body, `"page"`)
	perPageIdx := strings.Index(body, `"perPage"`)
	totalIdx := strings.Index(body, `"total"`)
	totalPagesIdx := strings.Index(body, `"totalPages"`)
	assert.True(t, pageIdx > pagIdx, "page key comes after pagination key")
	assert.True(t, pageIdx < perPageIdx)
	assert.True(t, perPageIdx < totalIdx)
	assert.True(t, totalIdx < totalPagesIdx)

	// No trailing newline.
	require.False(t, strings.HasSuffix(body, "\n"), "no trailing newline allowed")

	// Structural parse.
	var parsed struct {
		Data       []map[string]any `json:"data"`
		Pagination struct {
			Page       int `json:"page"`
			PerPage    int `json:"perPage"`
			Total      int `json:"total"`
			TotalPages int `json:"totalPages"`
		} `json:"pagination"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &parsed))
	require.Len(t, parsed.Data, 1)
	assert.Equal(t, 1, parsed.Pagination.Page)
	assert.Equal(t, 20, parsed.Pagination.PerPage)
	assert.Equal(t, 1, parsed.Pagination.Total)
	assert.Equal(t, 1, parsed.Pagination.TotalPages)
}

func TestSeasonal_TotalPages_RoundUp(t *testing.T) {
	t.Parallel()

	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return nil, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 21, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?perPage=10", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Pagination struct {
			TotalPages int `json:"totalPages"`
		} `json:"pagination"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Equal(t, 3, parsed.Pagination.TotalPages, "21 / 10 rounds up to 3")
}

func TestSeasonal_EmptyResults_NonNullArray(t *testing.T) {
	t.Parallel()

	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return nil, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"data":[]`, "empty result must serialise as [] not null")
}

// -----------------------------------------------------------------------------
// DB error handling — warm-path failures map to 500.
// -----------------------------------------------------------------------------

func TestSeasonal_DBError_500(t *testing.T) {
	t.Parallel()

	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			return nil, errors.New("simulated postgres failure")
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
	require.NotContains(t, rec.Body.String(), "simulated postgres failure", "cause must not leak to client")
}

func TestSeasonal_PostColdStart_ReReadError_500(t *testing.T) {
	t.Parallel()

	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return &anilist.SeasonalAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 1, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    []anilist.Media{seasonalMediaWith(1)},
				},
			}, nil
		},
	}

	// Initial call returns empty (warm miss); post-upsert re-read errors.
	var seasonalCalls atomic.Int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			seasonalCalls.Add(1)
			if seasonalCalls.Load() == 1 {
				return []dbgen.GetSeasonalAnimeRow{}, nil
			}
			return nil, errors.New("re-read postgres failure")
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

// -----------------------------------------------------------------------------
// Compile-time guard: fakeSeasonalDB satisfies SeasonalDB; fakeSeasonaler
// satisfies AniListSeasonaler.
// -----------------------------------------------------------------------------

var _ SeasonalDB = (*fakeSeasonalDB)(nil)
var _ AniListSeasonaler = (*fakeSeasonaler)(nil)
