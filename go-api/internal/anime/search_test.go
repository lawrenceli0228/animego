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

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// -----------------------------------------------------------------------------
// Test doubles.
// -----------------------------------------------------------------------------

// fakeSearcher implements AniListSearcher for tests.  The fn field is a
// function pointer so each test sets the desired AniList behaviour
// inline; calls counter records invocation count for cache-hit
// assertions (atomic so the race detector stays happy if a test ever
// fires concurrent requests).
type fakeSearcher struct {
	mu    sync.Mutex
	fn    func(ctx context.Context, v anilist.SearchVars) (*anilist.SearchAnimeResponse, error)
	calls atomic.Int32
	last  anilist.SearchVars
}

func (f *fakeSearcher) Search(ctx context.Context, v anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
	f.calls.Add(1)
	f.mu.Lock()
	f.last = v
	f.mu.Unlock()
	if f.fn == nil {
		return &anilist.SearchAnimeResponse{}, nil
	}
	return f.fn(ctx, v)
}

func (f *fakeSearcher) callCount() int32 { return f.calls.Load() }

func (f *fakeSearcher) lastVars() anilist.SearchVars {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.last
}

// searchFakeQuerier extends fakeQuerier with the three Querier methods
// /search consumes (UpsertAnimeCache, GetAnimeByAnilistIDs, and
// GetTitleChineseByAnilistIDs for the V1 enqueue trigger).  Hand-rolled
// rather than mockgen to keep the diff focused and let each test
// override only the methods it needs.
//
// The embedded fakeQuerier (from handlers_test.go) provides default
// "method not set" stubs for all the OTHER Querier methods — so any
// accidental cross-call (e.g. a refactor that has /search query
// /completed-gems by mistake) panics with a clear message.
type searchFakeQuerier struct {
	fakeQuerier

	upsertAnimeCacheFn     func(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error
	getAnimeByAnilistIDsFn func(ctx context.Context, ids []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error)
	getTitleChineseFn      func(ctx context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error)

	mu             sync.Mutex
	upsertedIDs    []int32
	upsertedParams []dbgen.UpsertAnimeCacheParams
	gotReadIDs     []int32
	enqueueLookups int
}

func (f *searchFakeQuerier) UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error {
	f.mu.Lock()
	f.upsertedIDs = append(f.upsertedIDs, arg.AnilistID)
	f.upsertedParams = append(f.upsertedParams, arg)
	f.mu.Unlock()
	if f.upsertAnimeCacheFn == nil {
		return nil
	}
	return f.upsertAnimeCacheFn(ctx, arg)
}

func (f *searchFakeQuerier) GetAnimeByAnilistIDs(ctx context.Context, ids []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
	f.mu.Lock()
	dup := make([]int32, len(ids))
	copy(dup, ids)
	f.gotReadIDs = dup
	f.mu.Unlock()
	if f.getAnimeByAnilistIDsFn == nil {
		return nil, nil
	}
	return f.getAnimeByAnilistIDsFn(ctx, ids)
}

// GetTitleChineseByAnilistIDs is the enqueue-lookup hook.  Default
// behaviour (no fn set) returns an empty slice so the enqueue path
// becomes a noop — tests that don't care about enqueue can leave the
// fn nil.  Tests that DO care set getTitleChineseFn to return the
// bangumi_version values they want filtered.
func (f *searchFakeQuerier) GetTitleChineseByAnilistIDs(ctx context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
	f.mu.Lock()
	f.enqueueLookups++
	f.mu.Unlock()
	if f.getTitleChineseFn == nil {
		return []dbgen.GetTitleChineseByAnilistIDsRow{}, nil
	}
	return f.getTitleChineseFn(ctx, ids)
}

func (f *searchFakeQuerier) snapshotUpserts() (ids []int32, params []dbgen.UpsertAnimeCacheParams) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ids = append(ids, f.upsertedIDs...)
	params = append(params, f.upsertedParams...)
	return ids, params
}

func (f *searchFakeQuerier) snapshotReadIDs() []int32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]int32, len(f.gotReadIDs))
	copy(dup, f.gotReadIDs)
	return dup
}

func (f *searchFakeQuerier) snapshotEnqueueLookups() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.enqueueLookups
}

// searchFakeEnqueuer records EnqueueV1Many invocations so tests can
// assert which (and how many) IDs were dispatched.  Function-pointer
// hook lets a test inject an error to exercise the non-fatal log path.
type searchFakeEnqueuer struct {
	mu        sync.Mutex
	enqueueFn func(ctx context.Context, ids []int32) error
	calls     [][]int32
}

func (e *searchFakeEnqueuer) EnqueueV1Many(ctx context.Context, ids []int32) error {
	e.mu.Lock()
	dup := make([]int32, len(ids))
	copy(dup, ids)
	e.calls = append(e.calls, dup)
	fn := e.enqueueFn
	e.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, ids)
}

// EnqueueV2Many is a no-op stub.  /search never dispatches V2 jobs —
// those chain from the V1 worker after a successful Bangumi hit.  Stub
// is needed only to satisfy the queue.Enqueuer interface that grew the
// V2 method in P2.1.7.
func (e *searchFakeEnqueuer) EnqueueV2Many(_ context.Context, _ []queue.BangumiV2Args) error {
	return nil
}

func (e *searchFakeEnqueuer) snapshotCalls() [][]int32 {
	e.mu.Lock()
	defer e.mu.Unlock()
	dup := make([][]int32, len(e.calls))
	for i, c := range e.calls {
		inner := make([]int32, len(c))
		copy(inner, c)
		dup[i] = inner
	}
	return dup
}

// newSearchService builds a SearchService for tests with the given fake
// searcher + querier + enqueuer.  Pass nil for fe to leave enqueue
// disabled (NoopEnqueuer).  t.Cleanup closes the cache so ristretto's
// background goroutines don't leak between parallel tests.
func newSearchService(t *testing.T, fs *fakeSearcher, fq *searchFakeQuerier, fe queue.Enqueuer) *SearchService {
	t.Helper()
	s, err := NewSearchService(fs, fq, fe)
	require.NoError(t, err)
	t.Cleanup(s.Close)
	return s
}

// mediaWith helps tests build minimal anilist.Media entries with only
// the ID populated.  Title pointer is set so NormalizeMainRow doesn't
// have to deal with a nil Title — keeps the upsert path stable.
func mediaWith(id int) anilist.Media {
	romaji := "Title " + itoa(id)
	return anilist.Media{
		ID:    id,
		Title: &anilist.Title{Romaji: &romaji},
	}
}

// itoa is a 3-line strconv.Itoa replacement so tests stay free of
// strconv imports — saves a line of import noise in this file.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// -----------------------------------------------------------------------------
// Validation: both q and genre missing → 400 with Chinese message.
// -----------------------------------------------------------------------------

func TestSearch_MissingBothParams(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{}
	fq := &searchFakeQuerier{}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search", nil))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"VALIDATION_ERROR"`)
	// Chinese message must be byte-exact for Express parity.
	require.Contains(t, body, "请提供搜索关键词或类型")

	assert.Equal(t, int32(0), fs.callCount(), "AniList must not be called on validation failure")
}

func TestSearch_OnlyWhitespaceTreatedAsMissing(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{}
	fq := &searchFakeQuerier{}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=%20%20&genre=%20", nil))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), `"VALIDATION_ERROR"`)
}

// -----------------------------------------------------------------------------
// Defaults / caps for page + perPage.
// -----------------------------------------------------------------------------

func TestSearch_Defaults(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{
						Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20,
					},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=naruto", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	v := fs.lastVars()
	assert.Equal(t, 1, v.Page, "default page = 1")
	assert.Equal(t, 20, v.PerPage, "default perPage = 20")
	require.NotNil(t, v.Search)
	assert.Equal(t, "naruto", *v.Search)
	assert.Nil(t, v.Genre, "genre omitted → nil pointer (omitempty drops it)")
}

func TestSearch_PerPageCappedAt50(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 50},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x&perPage=100", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 50, fs.lastVars().PerPage, "perPage > 50 must be capped at 50")
}

func TestSearch_NegativePageFallsBack(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x&page=-1", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, fs.lastVars().Page, "negative page must clamp to 1")
}

func TestSearch_ZeroPerPageFallsBack(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x&perPage=0", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 20, fs.lastVars().PerPage, "perPage=0 clamps to default 20")
}

func TestSearch_DeadlineExceeded_504(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return nil, context.DeadlineExceeded
		},
	}
	fq := &searchFakeQuerier{}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))

	require.Equal(t, http.StatusGatewayTimeout, rec.Code, "deadline exceeded must map to 504")
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

func TestSearch_NonNumericPagePerPageFallsBack(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x&page=abc&perPage=xyz", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	v := fs.lastVars()
	assert.Equal(t, 1, v.Page, "non-numeric page → default 1")
	assert.Equal(t, 20, v.PerPage, "non-numeric perPage → default 20")
}

// -----------------------------------------------------------------------------
// Upstream / DB error handling.
// -----------------------------------------------------------------------------

func TestSearch_AniListUpstreamError_502(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return nil, &anilist.ErrUpstream{Status: 500, Message: "AniList API error: 500"}
		},
	}
	fq := &searchFakeQuerier{}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=naruto", nil))

	// Choice rationale: *ErrUpstream → 502 (we made the upstream call;
	// the upstream failed).  Documented in writeError godoc.
	require.Equal(t, http.StatusBadGateway, rec.Code)
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

func TestSearch_AniListRateLimited_502(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return nil, anilist.ErrRateLimited
		},
	}
	fq := &searchFakeQuerier{}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))

	require.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestSearch_DBReadError_500(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 1, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    []anilist.Media{mediaWith(1)},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, errors.New("simulated postgres failure")
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
	require.NotContains(t, rec.Body.String(), "simulated postgres failure", "cause must not leak")
}

// -----------------------------------------------------------------------------
// Cache behaviour.
// -----------------------------------------------------------------------------

func TestSearch_CacheHit_NoAniListCall(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	// First call populates the cache.
	rec1 := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec1, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=naruto&page=1&perPage=20", nil))
	require.Equal(t, http.StatusOK, rec1.Code)

	// ristretto writes are async — wait so the second request sees the
	// hot entry.
	svc.cache.Wait()

	// Second call should short-circuit and NOT touch AniList.
	rec2 := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=naruto&page=1&perPage=20", nil))
	require.Equal(t, http.StatusOK, rec2.Code)

	assert.Equal(t, int32(1), fs.callCount(), "second identical request must hit cache, not AniList")
}

func TestSearch_DifferentParams_DifferentCacheKey(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=a", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	svc.cache.Wait()

	rec = httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=b", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	assert.Equal(t, int32(2), fs.callCount(), "different q should produce different cache keys")
}

// -----------------------------------------------------------------------------
// Upsert + re-read orchestration.
// -----------------------------------------------------------------------------

func TestSearch_UpsertCalledPerMedia(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{mediaWith(11), mediaWith(22), mediaWith(33)}
	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 3, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    media,
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	gotIDs, _ := fq.snapshotUpserts()
	assert.Equal(t, []int32{11, 22, 33}, gotIDs, "upsert called once per media in order")
}

func TestSearch_UpsertErrorSkippedNotFailed(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{mediaWith(1), mediaWith(2), mediaWith(3)}
	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 3, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    media,
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		upsertAnimeCacheFn: func(_ context.Context, arg dbgen.UpsertAnimeCacheParams) error {
			if arg.AnilistID == 2 {
				return errors.New("upsert id=2 failed")
			}
			return nil
		},
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))

	require.Equal(t, http.StatusOK, rec.Code, "single upsert failure must not fail the request")
	// The re-read must still get all three IDs — handler's job is to
	// continue past per-row failures.
	assert.Equal(t, []int32{1, 2, 3}, fq.snapshotReadIDs())
}

func TestSearch_ReReadByIDs(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{mediaWith(100), mediaWith(200), mediaWith(300)}
	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 3, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    media,
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, ids []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			rows := make([]dbgen.GetAnimeByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, dbgen.GetAnimeByAnilistIDsRow{AnilistID: id})
			}
			return rows, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := fq.snapshotReadIDs()
	assert.Equal(t, []int32{100, 200, 300}, got, "re-read receives AniList IDs []int32")

	// Sanity-check the response data carries those IDs.
	var parsed struct {
		Data []struct {
			AnilistID int32 `json:"anilistId"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data, 3)
	assert.Equal(t, int32(100), parsed.Data[0].AnilistID)
	assert.Equal(t, int32(200), parsed.Data[1].AnilistID)
	assert.Equal(t, int32(300), parsed.Data[2].AnilistID)
}

// -----------------------------------------------------------------------------
// Envelope shape: byte-level field order, pagination math.
// -----------------------------------------------------------------------------

func TestSearch_EnvelopeShape(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{
						Total:       42,
						CurrentPage: 1,
						LastPage:    3,
						PerPage:     20,
					},
					Media: []anilist.Media{mediaWith(1)},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return []dbgen.GetAnimeByAnilistIDsRow{{AnilistID: 1}}, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=naruto", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "application/json; charset=utf-8", rec.Header().Get("Content-Type"))

	body := rec.Body.String()

	// Byte-level field order: data must come before pagination.
	dataIdx := strings.Index(body, `"data"`)
	pagIdx := strings.Index(body, `"pagination"`)
	require.Greater(t, dataIdx, -1)
	require.Greater(t, pagIdx, dataIdx, "pagination must come after data in JSON output")

	// Field order within pagination block.
	pageIdx := strings.Index(body, `"page"`)
	perPageIdx := strings.Index(body, `"perPage"`)
	totalIdx := strings.Index(body, `"total"`)
	totalPagesIdx := strings.Index(body, `"totalPages"`)
	assert.True(t, pageIdx > pagIdx, "page comes after pagination key")
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
	assert.Equal(t, 42, parsed.Pagination.Total)
	assert.Equal(t, 3, parsed.Pagination.TotalPages)
}

func TestSearch_TotalPages_RoundUp(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 21, CurrentPage: 1, LastPage: 3, PerPage: 10},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x&perPage=10", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Pagination struct {
			TotalPages int `json:"totalPages"`
			Total      int `json:"total"`
		} `json:"pagination"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Equal(t, 21, parsed.Pagination.Total)
	assert.Equal(t, 3, parsed.Pagination.TotalPages, "21 / 10 rounds up to 3")
}

func TestSearch_EmptyResultsNonNullArray(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=zzzz", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"data":[]`, "empty result must serialise as [] not null")
}

func TestSearch_GenreOnlyQuery(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 0, CurrentPage: 1, LastPage: 0, PerPage: 20},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?genre=Action", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	v := fs.lastVars()
	assert.Nil(t, v.Search, "search must be nil when only genre provided")
	require.NotNil(t, v.Genre)
	assert.Equal(t, "Action", *v.Genre)
}

// Compile-time guard: ensure searchFakeQuerier satisfies dbgen.Querier
// (via the embedded fakeQuerier providing the other methods).
var _ dbgen.Querier = (*searchFakeQuerier)(nil)

// -----------------------------------------------------------------------------
// V1 enrichment enqueue trigger.
//
// /search post-upsert path queries bangumi_version for the result IDs
// and dispatches V1 jobs for any row still at 0.  These tests cover:
//   - happy path (mixed versions → only the 0-rows enqueued)
//   - all-enriched skip (no enqueue when every row is already ≥1)
//   - non-fatal enqueue error (response still 200, no second attempt)
//   - cache hit short-circuits before reaching the enqueue lookup
// -----------------------------------------------------------------------------

func TestSearch_EnqueuesUnenriched(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{mediaWith(10), mediaWith(20), mediaWith(30)}
	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 3, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    media,
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, ids []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			out := make([]dbgen.GetAnimeByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				out = append(out, dbgen.GetAnimeByAnilistIDsRow{AnilistID: id})
			}
			return out, nil
		},
		// versions: [0, 1, 0] — IDs 10 and 30 still unenriched.
		getTitleChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				ver := int32(0)
				if id == 20 {
					ver = 1
				}
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID:      id,
					BangumiVersion: ver,
				})
			}
			return rows, nil
		},
	}
	fe := &searchFakeEnqueuer{}
	svc := newSearchService(t, fs, fq, fe)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	calls := fe.snapshotCalls()
	require.Len(t, calls, 1, "exactly one EnqueueV1Many call expected")
	assert.ElementsMatch(t, []int32{10, 30}, calls[0],
		"only bangumi_version=0 IDs should be enqueued")
}

func TestSearch_NoEnqueueWhenAllEnriched(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{mediaWith(1), mediaWith(2)}
	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 2, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    media,
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
		getTitleChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID:      id,
					BangumiVersion: 1, // all already enriched
				})
			}
			return rows, nil
		},
	}
	fe := &searchFakeEnqueuer{}
	svc := newSearchService(t, fs, fq, fe)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, fe.snapshotCalls(),
		"no enqueue call expected when every row is already enriched")
}

func TestSearch_EnqueueErrorIsNonFatal(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{mediaWith(1)}
	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 1, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    media,
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
		getTitleChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID:      id,
					BangumiVersion: 0,
				})
			}
			return rows, nil
		},
	}
	fe := &searchFakeEnqueuer{
		enqueueFn: func(_ context.Context, _ []int32) error {
			return errors.New("simulated river outage")
		},
	}
	svc := newSearchService(t, fs, fq, fe)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))

	require.Equal(t, http.StatusOK, rec.Code, "enqueue failure must not fail the search request")
	// One attempt was made — we don't retry inside the handler.
	require.Len(t, fe.snapshotCalls(), 1, "enqueue attempted once even when it errors")
}

func TestSearch_EnqueueNotCalledOnCacheHit(t *testing.T) {
	t.Parallel()

	media := []anilist.Media{mediaWith(1)}
	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 1, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    media,
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
		getTitleChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			rows := make([]dbgen.GetTitleChineseByAnilistIDsRow, 0, len(ids))
			for _, id := range ids {
				rows = append(rows, dbgen.GetTitleChineseByAnilistIDsRow{
					AnilistID:      id,
					BangumiVersion: 0,
				})
			}
			return rows, nil
		},
	}
	fe := &searchFakeEnqueuer{}
	svc := newSearchService(t, fs, fq, fe)

	// First call populates cache + triggers one enqueue.
	rec1 := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec1, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=cached", nil))
	require.Equal(t, http.StatusOK, rec1.Code)
	require.Len(t, fe.snapshotCalls(), 1, "first call enqueues")
	require.Equal(t, 1, fq.snapshotEnqueueLookups(), "first call hits the enqueue lookup")

	// ristretto writes are async — wait so the second call sees the hot entry.
	svc.cache.Wait()

	// Second identical call should be served from cache: NO AniList,
	// NO upsert, NO enqueue lookup, NO enqueue dispatch.
	rec2 := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=cached", nil))
	require.Equal(t, http.StatusOK, rec2.Code)
	assert.Len(t, fe.snapshotCalls(), 1, "cache hit must NOT dispatch a second enqueue")
	assert.Equal(t, 1, fq.snapshotEnqueueLookups(), "cache hit must NOT issue a second enqueue lookup")
	assert.Equal(t, int32(1), fs.callCount(), "cache hit must NOT call AniList again")
}
