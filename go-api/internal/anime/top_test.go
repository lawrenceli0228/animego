package anime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"testing/synctest"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// fakeTopDB answers both statements from canned rows and records what it
// was asked.  Every record is taken under mu: the handlers' reads run on
// singleflight's goroutine, not the test's.
type fakeTopDB struct {
	mu sync.Mutex

	rows  []dbgen.TopAnimeRow
	err   error
	calls []dbgen.TopAnimeParams
	// panicWith, when set, is what TopAnime panics with.
	panicWith any

	yearRows  []dbgen.ListTopYearsRow
	yearsErr  error
	yearsArgs []int32

	// gate, when set, holds every statement until it is closed or the
	// read's context ends; held counts the statements that reached it.
	gate chan struct{}
	held int
}

func (f *fakeTopDB) TopAnime(ctx context.Context, arg dbgen.TopAnimeParams) ([]dbgen.TopAnimeRow, error) {
	if f.panicWith != nil {
		panic(f.panicWith)
	}
	if err := f.wait(ctx); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, arg)
	return f.rows, f.err
}

func (f *fakeTopDB) ListTopYears(ctx context.Context, minPopularity int32) ([]dbgen.ListTopYearsRow, error) {
	if err := f.wait(ctx); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.yearsArgs = append(f.yearsArgs, minPopularity)
	return f.yearRows, f.yearsErr
}

func (f *fakeTopDB) wait(ctx context.Context) error {
	if f.gate == nil {
		return nil
	}
	f.mu.Lock()
	f.held++
	f.mu.Unlock()
	select {
	case <-f.gate:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (f *fakeTopDB) heldAtGate() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.held
}

func (f *fakeTopDB) topCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeTopDB) yearCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.yearsArgs)
}

func newTopCacheT(t *testing.T) *cache.Cache[TopList] {
	t.Helper()
	c, err := NewTopCache()
	require.NoError(t, err)
	t.Cleanup(c.Close)
	return c
}

func newTopYearsCacheT(t *testing.T) *cache.Cache[[]TopYear] {
	t.Helper()
	c, err := NewTopYearsCache()
	require.NoError(t, err)
	t.Cleanup(c.Close)
	return c
}

func topGet(h http.Handler, query string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/top?"+query, nil))
	return rec
}

func topYearsGet(h http.Handler) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/top/years", nil))
	return rec
}

// TestTop_ItemIsTheBrowseItemWithItsRank — an item is /browse's item for
// the same row, byte for byte, with "rank" after it; ranks are the
// positions the statement returned the rows in, from 1, no gaps.
func TestTop_ItemIsTheBrowseItemWithItsRank(t *testing.T) {
	t.Parallel()

	db := &fakeTopDB{rows: []dbgen.TopAnimeRow{
		dbgen.TopAnimeRow(seasonalLegacyFullRow()),
		{AnilistID: 7},
	}}
	rec := topGet(Top(db, newTopCacheT(t)), "")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json; charset=utf-8", rec.Header().Get("Content-Type"))

	trim := func(s string) string { return s[:len(s)-1] } // the item's closing brace
	assert.Equal(t, `{"data":[`+
		seasonalLegacyFullJSON+trim(seasonalNullNewFieldsJSON)+`,"rank":1},`+
		seasonalLegacyEmptyJSON+trim(seasonalNullNewFieldsJSON)+`,"rank":2}`+
		`]}`, rec.Body.String())

	browse := browseGet(&fakeBrowseDB{rows: []dbgen.BrowseAnimeRow{dbgen.BrowseAnimeRow(seasonalLegacyFullRow())}, total: 1}, "genre=Drama")
	assert.Contains(t, browse.Body.String(), seasonalLegacyFullJSON+seasonalNullNewFieldsJSON, "the same bytes /browse sends for the row")
}

// TestTopListFromRows_NumbersByPosition — the place is the position, so
// titles the statement ranked on the same score still take one place
// each; an empty ranking is an empty array, not null.
func TestTopListFromRows_NumbersByPosition(t *testing.T) {
	t.Parallel()

	rows := make([]dbgen.TopAnimeRow, 0, topSize)
	for i := range topSize {
		rows = append(rows, dbgen.TopAnimeRow{AnilistID: int32(1000 - i), AverageScore: f64(90)})
	}
	list := topListFromRows(rows)
	require.Len(t, list, topSize)
	for i, it := range list {
		assert.Equal(t, i+1, it.Rank)
		assert.Equal(t, int32(1000-i), it.AnilistID, "in the statement's order")
	}

	assert.NotNil(t, topListFromRows(nil))
	rec := topGet(Top(&fakeTopDB{}, newTopCacheT(t)), "year=1931")
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":[]}`, rec.Body.String())
}

// TestTop_AsksForTheRanking — the filters reach the statement as parsed,
// with the floor and the length.
func TestTop_AsksForTheRanking(t *testing.T) {
	t.Parallel()

	db := &fakeTopDB{}
	rec := topGet(Top(db, newTopCacheT(t)), "genre=Drama&season=FALL&format=MOVIE&year=2024")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, db.calls, 1)
	assert.Equal(t, dbgen.TopAnimeParams{
		MinPopularity: browseScoreMinPopularity,
		ReleaseYear:   i32(2024),
		Format:        sptr("MOVIE"),
		Season:        sptr("FALL"),
		Genre:         sptr("Drama"),
		RowLimit:      topSize,
	}, db.calls[0])
}

// TestTop_RefusesBeforeReading — a bad parameter is a 400 in the API's
// error envelope, and neither the cache nor the database is reached.
func TestTop_RefusesBeforeReading(t *testing.T) {
	t.Parallel()

	db := &fakeTopDB{}
	h := Top(db, newTopCacheT(t))
	for _, tc := range []struct{ qs, body string }{
		{"format=constructor", `{"error":{"code":"VALIDATION_ERROR","message":"format must be one of TV, TV_SHORT, MOVIE, ONA, OVA or SPECIAL"}}`},
		{"season=FALL", `{"error":{"code":"VALIDATION_ERROR","message":"season requires year"}}`},
		{"genre=__proto__", `{"error":{"code":"VALIDATION_ERROR","message":"genre must be a browsable genre"}}`},
		{"year=99999", `{"error":{"code":"VALIDATION_ERROR","message":"year must be a year between 1900 and 2100"}}`},
	} {
		rec := topGet(h, tc.qs)
		assert.Equal(t, http.StatusBadRequest, rec.Code, tc.qs)
		assert.Equal(t, tc.body, rec.Body.String(), tc.qs)
	}
	assert.Zero(t, db.topCalls())
}

// TestTop_CachedPerRanking — the second request for a ranking is answered
// from the cache with the same bytes, however its query string is
// spelled; another ranking is its own entry; a failed read is a 500 and
// is not cached.
func TestTop_CachedPerRanking(t *testing.T) {
	t.Parallel()

	c := newTopCacheT(t)
	db := &fakeTopDB{rows: []dbgen.TopAnimeRow{{AnilistID: 1}, {AnilistID: 2}}}
	h := Top(db, c)

	first := topGet(h, "year=2024&format=TV")
	require.Equal(t, http.StatusOK, first.Code)
	assert.Equal(t, 1, db.topCalls())
	c.Wait()

	again := topGet(h, "format=TV&year=2024&season=")
	assert.Equal(t, http.StatusOK, again.Code)
	assert.Equal(t, first.Body.String(), again.Body.String())
	assert.Equal(t, 1, db.topCalls(), "a hit reads nothing")

	assert.Equal(t, http.StatusOK, topGet(h, "year=2024").Code)
	assert.Equal(t, 2, db.topCalls(), "another ranking is another entry")
	c.Wait()

	failing := &fakeTopDB{err: errors.New("connection reset")}
	hf := Top(failing, c)
	rec := topGet(hf, "year=2023")
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, `{"error":{"code":"SERVER_ERROR","message":"query failed"}}`, rec.Body.String())
	c.Wait()
	_, cached := c.Get("y=2023|f=|s=|g=")
	assert.False(t, cached, "a failure is not cached: the next request reads again")
	assert.Equal(t, http.StatusOK, topGet(h, "year=2023").Code)
	assert.Equal(t, 3, db.topCalls())
}

// TestTop_ConcurrentMissesShareOneRead — requests for a ranking no one has
// read yet, all in flight at once, cost one read between them and get the
// same bytes.  The read is held at the gate until every request waits on
// it, as in TestGenreOverview_ConcurrentMissesShareOneRead.
func TestTop_ConcurrentMissesShareOneRead(t *testing.T) {
	t.Parallel()

	synctest.Test(t, func(t *testing.T) {
		db := &fakeTopDB{gate: make(chan struct{}), rows: []dbgen.TopAnimeRow{{AnilistID: 5}}}
		h := Top(db, newTopCacheT(t))

		const callers = 8
		recs := make([]*httptest.ResponseRecorder, callers)
		var wg sync.WaitGroup
		for i := range recs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				recs[i] = topGet(h, "year=2024")
			}()
		}
		synctest.Wait()
		assert.Equal(t, 1, db.heldAtGate(), "one read in flight for all %d requests", callers)
		close(db.gate)
		wg.Wait()

		assert.Equal(t, 1, db.topCalls())
		for i, rec := range recs {
			assert.Equal(t, http.StatusOK, rec.Code, "request %d", i)
			assert.Equal(t, recs[0].Body.String(), rec.Body.String(), "request %d", i)
		}
		assert.Contains(t, recs[0].Body.String(), `"rank":1`)
	})
}

// TestTop_ALeavingReaderDoesNotStopTheRead — a request that goes away
// while it waits is answered with nothing, not a 500; the read runs to the
// end without it and is cached for the next request.
func TestTop_ALeavingReaderDoesNotStopTheRead(t *testing.T) {
	t.Parallel()

	synctest.Test(t, func(t *testing.T) {
		c := newTopCacheT(t)
		db := &fakeTopDB{gate: make(chan struct{}), rows: []dbgen.TopAnimeRow{{AnilistID: 5}}}
		h := Top(db, c)

		ctx, leave := context.WithCancel(context.Background())
		gone := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			defer close(done)
			h.ServeHTTP(gone, httptest.NewRequest(http.MethodGet, "/api/anime/top?year=2024", nil).WithContext(ctx))
		}()
		synctest.Wait()
		leave()
		<-done
		assert.Empty(t, gone.Header(), "no answer at all, not even a status")
		assert.Zero(t, gone.Body.Len())

		close(db.gate)
		synctest.Wait()
		assert.Equal(t, 1, db.topCalls(), "the read ran")
		c.Wait()
		next := topGet(h, "year=2024")
		assert.Equal(t, http.StatusOK, next.Code)
		assert.Equal(t, 1, db.topCalls(), "and was kept: the next request reads nothing")
	})
}

// TestTop_PanicIsA500NotACrash — the read runs on singleflight's
// goroutine, beyond httpmw.Recoverer.
func TestTop_PanicIsA500NotACrash(t *testing.T) {
	t.Parallel()

	c := newTopCacheT(t)
	rec := topGet(Top(&fakeTopDB{panicWith: "a row the mapping did not expect"}, c), "year=2024")
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, `{"error":{"code":"SERVER_ERROR","message":"query failed"}}`, rec.Body.String())
	c.Wait()
	_, cached := c.Get("y=2024|f=|s=|g=")
	assert.False(t, cached)
}

// TestTopYears_NewestFirstInRange — the years in the statement's order,
// with their counts, asked with /browse's floor; a year /top would refuse
// is left out rather than offered as a page that could only 400.
func TestTopYears_NewestFirstInRange(t *testing.T) {
	t.Parallel()

	db := &fakeTopDB{yearRows: []dbgen.ListTopYearsRow{
		{ReleaseYear: 2101, N: 1},
		{ReleaseYear: 2026, N: 339},
		{ReleaseYear: 2025, N: 412},
		{ReleaseYear: 1963, N: 2},
		{ReleaseYear: 1899, N: 1},
	}}
	rec := topYearsGet(TopYears(db, newTopYearsCacheT(t)))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":[{"year":2026,"count":339},{"year":2025,"count":412},{"year":1963,"count":2}]}`, rec.Body.String())
	assert.Equal(t, []int32{browseScoreMinPopularity}, db.yearsArgs)

	empty := topYearsGet(TopYears(&fakeTopDB{}, newTopYearsCacheT(t)))
	assert.Equal(t, `{"data":[]}`, empty.Body.String())
}

// TestTopYears_Cached — one read per TTL; a failure is a 500 and is not
// kept.
func TestTopYears_Cached(t *testing.T) {
	t.Parallel()

	c := newTopYearsCacheT(t)
	db := &fakeTopDB{yearRows: []dbgen.ListTopYearsRow{{ReleaseYear: 2026, N: 3}}}
	h := TopYears(db, c)
	first := topYearsGet(h)
	require.Equal(t, http.StatusOK, first.Code)
	c.Wait()
	second := topYearsGet(h)
	assert.Equal(t, first.Body.String(), second.Body.String())
	assert.Equal(t, 1, db.yearCalls(), "a hit reads nothing")

	fc := newTopYearsCacheT(t)
	failing := &fakeTopDB{yearsErr: errors.New("timeout")}
	rec := topYearsGet(TopYears(failing, fc))
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, `{"error":{"code":"SERVER_ERROR","message":"query failed"}}`, rec.Body.String())
	fc.Wait()
	_, cached := fc.Get(topYearsKey)
	assert.False(t, cached)
}

// TestTopCaches_AreSizedInEntries — both caches count entries, with small
// explicit counters rather than the defaults' millions; the ranking cache
// keeps what fits and no more than MaxCost however many keys arrive.
func TestTopCaches_AreSizedInEntries(t *testing.T) {
	t.Parallel()

	assert.Equal(t, cache.Config{NumCounters: 640, MaxCost: 64, IgnoreInternalCost: true, DefaultTTL: topTTL}, topCacheConfig())
	assert.Equal(t, cache.Config{NumCounters: 10, MaxCost: 2, IgnoreInternalCost: true, DefaultTTL: topTTL}, topYearsCacheConfig())

	c := newTopCacheT(t)
	keys := make([]string, topCacheEntries/2)
	for i := range keys {
		keys[i] = "y=" + strconv.Itoa(1960+i) + "|f=|s=|g="
		require.True(t, c.Set(keys[i], TopList{{Rank: 1}}), keys[i])
	}
	c.Wait()
	for _, k := range keys {
		_, ok := c.Get(k)
		assert.True(t, ok, "%s was not kept", k)
	}
	for i := range 20 * topCacheEntries {
		c.Set("other "+strconv.Itoa(i), TopList{})
	}
	c.Wait()
	kept := 0
	for i := range 20 * topCacheEntries {
		if _, ok := c.Get("other " + strconv.Itoa(i)); ok {
			kept++
		}
	}
	assert.LessOrEqual(t, kept, topCacheEntries, "bounded at MaxCost entries")

	yc := newTopYearsCacheT(t)
	require.True(t, yc.Set(topYearsKey, []TopYear{{Year: 2026, Count: 1}}))
	yc.Wait()
	got, ok := yc.Get(topYearsKey)
	require.True(t, ok)
	assert.Equal(t, []TopYear{{Year: 2026, Count: 1}}, got)
}

// TestTop_RoutesDoNotCollideWithDetail — /top and /top/years are fixed
// segments in the subtree /{anilistId} and /{anilistId}/... also match.
func TestTop_RoutesDoNotCollideWithDetail(t *testing.T) {
	t.Parallel()

	var detailHits []string
	db := &fakeTopDB{rows: []dbgen.TopAnimeRow{{AnilistID: 9}}, yearRows: []dbgen.ListTopYearsRow{{ReleaseYear: 2024, N: 1}}}
	r := chi.NewRouter()
	r.Route("/api/anime", func(r chi.Router) {
		r.Get("/top", Top(db, newTopCacheT(t)))
		r.Get("/top/years", TopYears(db, newTopYearsCacheT(t)))
		r.Get("/{anilistId}/watchers", func(w http.ResponseWriter, req *http.Request) {
			detailHits = append(detailHits, chi.URLParam(req, "anilistId")+"/watchers")
		})
		r.Get("/{anilistId}", func(w http.ResponseWriter, req *http.Request) {
			detailHits = append(detailHits, chi.URLParam(req, "anilistId"))
		})
	})

	rec := topGet(r, "year=2024")
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"anilistId":9`)
	years := topYearsGet(r)
	assert.Equal(t, http.StatusOK, years.Code)
	assert.Equal(t, `{"data":[{"year":2024,"count":1}]}`, years.Body.String())
	assert.Empty(t, detailHits)
}

// argsDBTX records the arguments each statement reached the connection
// with.
type argsDBTX struct {
	dbgen.DBTX
	got [][]any
}

func (a *argsDBTX) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	a.got = append(a.got, args)
	return pgconn.CommandTag{}, nil
}

func (a *argsDBTX) Query(_ context.Context, _ string, args ...any) (pgx.Rows, error) {
	a.got = append(a.got, args)
	return nil, errors.New("not a database")
}

func (a *argsDBTX) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	a.got = append(a.got, args)
	return nil
}

// TestPlanEachTime_LeadsWithTheExecMode — every statement reaches the
// connection with pgx's unnamed-statement mode in front of its own
// arguments, which follow unchanged.
func TestPlanEachTime_LeadsWithTheExecMode(t *testing.T) {
	t.Parallel()

	inner := &argsDBTX{}
	p := planEachTime{inner}
	_, _ = p.Exec(context.Background(), "x", 1, "a")
	_, _ = p.Query(context.Background(), "x")
	_ = p.QueryRow(context.Background(), "x", nil)
	assert.Equal(t, [][]any{
		{pgx.QueryExecModeCacheDescribe, 1, "a"},
		{pgx.QueryExecModeCacheDescribe},
		{pgx.QueryExecModeCacheDescribe, nil},
	}, inner.got)

	_, err := NewTopDB(inner).TopAnime(context.Background(), topQuery{}.params())
	require.Error(t, err)
	require.Len(t, inner.got, 4)
	assert.Equal(t, []any{pgx.QueryExecModeCacheDescribe, int32(browseScoreMinPopularity),
		(*int32)(nil), (*string)(nil), (*string)(nil), (*string)(nil), int32(topSize)}, inner.got[3],
		"TopAnime's own arguments, in order, behind the mode")
}
