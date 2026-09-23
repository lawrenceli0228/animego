package anime

// Tests for how the detail endpoint spends the shared AniList budget:
// stale refreshes never queue (DetailNoWait), cold ids queue but are
// remembered when AniList says they do not exist (absent), and
// concurrent requests for one cold id share one upstream call
// (coldFetch).  See the package comment in detail.go for the flow.

import (
	"bytes"
	"context"
	"log"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// coldDB is a DB with no row for any id.
func coldDB() *detailFakeDB {
	return &detailFakeDB{
		getAnimeMainByIDFn: func(context.Context, int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
		},
	}
}

// staleDB holds one row whose only stale trigger is cached_at.
func staleDB(id int32, title string) *detailFakeDB {
	return &detailFakeDB{
		getAnimeMainByIDFn: func(context.Context, int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:        id,
				TitleRomaji:      &title,
				CachedAt:         staleTimestamp(),
				TrailerCheckedAt: freshTimestamp(),
				DetailFetchedAt:  freshTimestamp(),
			}, nil
		},
	}
}

func nullMedia(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
	return &anilist.AnimeDetailResponse{Media: anilist.Media{}}, nil
}

// captureLogs routes the default slog logger into a buffer at Debug
// level for the rest of the test.  Callers must not be t.Parallel: the
// default logger is process-wide.
//
// slog.SetDefault with a non-default handler also redirects the log
// package, and setting the old default back does not undo that -- so the
// log package's writer and flags are restored by hand, or every later
// test in the binary logs into this buffer.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	var mu sync.Mutex
	prev, prevOut, prevFlags := slog.Default(), log.Writer(), log.Flags()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{w: &buf, mu: &mu}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() {
		slog.SetDefault(prev)
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})
	return &buf
}

// waitFor polls cond until it holds or a second passes.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached within 1s")
		}
		time.Sleep(time.Millisecond)
	}
}

type lockedWriter struct {
	w  *bytes.Buffer
	mu *sync.Mutex
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// countLines counts log lines carrying both substrings.
func countLines(buf *bytes.Buffer, a, b string) int {
	n := 0
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, a) && strings.Contains(line, b) {
			n++
		}
	}
	return n
}

// -----------------------------------------------------------------------------
// Stale refresh: never queues.
// -----------------------------------------------------------------------------

// T-d1: a busy budget serves the stale row at once, logs at Debug (not
// Warn), writes nothing, and caches the answer.  The Debug-not-Warn
// split is also the proof that ErrBudgetBusy survives the APIError wrap.
func TestDetail_Stale_BudgetBusy_ServesStale(t *testing.T) {
	logs := captureLogs(t)

	db := staleDB(424242, "Stale While Busy")
	al := &fakeAniListDetailer{
		noWaitFn: func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return nil, anilist.ErrBudgetBusy
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/424242")

	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"titleRomaji":"Stale While Busy"`)
	assert.Equal(t, int32(0), db.upsertMainCalls.Load())
	assert.Equal(t, 1, countLines(logs, "level=DEBUG", "budget busy, serving stale"))
	assert.Equal(t, 0, countLines(logs, "level=WARN", "anilistId=424242"))

	svc.cache.Wait()
	rec2 := serveDetail(t, svc, "/api/anime/424242")
	require.Equal(t, http.StatusOK, rec2.Code)
	assert.Equal(t, int32(1), db.mainCalls.Load(), "second request served from the in-process cache")
	assert.Equal(t, int32(1), al.noWaitCalls.Load())
}

// T-d2 (regression guard): the stale refresh uses DetailNoWait, never the
// queueing Detail.
func TestDetail_Stale_UsesNoWait(t *testing.T) {
	t.Parallel()

	al := &fakeAniListDetailer{detailFn: nullMedia}
	svc := newDetailServiceWithAniList(t, staleDB(31, "x"), al)

	rec := serveDetail(t, svc, "/api/anime/31")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(1), al.noWaitCalls.Load())
	assert.Equal(t, int32(0), al.detailCalls.Load())
}

// T-d2b: a row that is incomplete rather than old (a listing wrote it,
// nobody fetched its detail) still queues.  Served from a busy budget it
// would be a page without characters, staff or relations, cached for an
// hour.
func TestDetail_Stale_IncompleteRowQueues(t *testing.T) {
	t.Parallel()

	title := "Listed Only"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(context.Context, int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:        39,
				TitleRomaji:      &title,
				CachedAt:         freshTimestamp(),
				TrailerCheckedAt: freshTimestamp(),
				// DetailFetchedAt NULL: only a listing has written it.
			}, nil
		},
	}
	al := &fakeAniListDetailer{
		detailFn: nullMedia,
		noWaitFn: func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return nil, anilist.ErrBudgetBusy
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	serveDetail(t, svc, "/api/anime/39")

	assert.Equal(t, int32(1), al.detailCalls.Load())
	assert.Equal(t, int32(0), al.noWaitCalls.Load())
}

// -----------------------------------------------------------------------------
// Cold id: queues, but remembers "does not exist".
// -----------------------------------------------------------------------------

// T-d3 (regression guard): a cold id has nothing to fall back on, so it
// uses the queueing Detail.
func TestDetail_Cold_UsesQueueingDetail(t *testing.T) {
	t.Parallel()

	al := &fakeAniListDetailer{detailFn: nullMedia}
	svc := newDetailServiceWithAniList(t, coldDB(), al)

	serveDetail(t, svc, "/api/anime/32")

	assert.Equal(t, int32(1), al.detailCalls.Load())
	assert.Equal(t, int32(0), al.noWaitCalls.Load())
}

// T-d4 / T-d5: both ways AniList says "no such media" are remembered.
// The second request still reads the DB (DB first is what lets another
// writer override the negative entry) but does not call AniList.
func TestDetail_Cold_AbsentRemembered(t *testing.T) {
	t.Parallel()

	cases := map[string]func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error){
		"media null": nullMedia,
		"upstream 404": func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return nil, &anilist.ErrUpstream{Status: http.StatusNotFound, Message: "Not Found."}
		},
	}
	for name, fn := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			db := coldDB()
			al := &fakeAniListDetailer{detailFn: fn}
			svc := newDetailServiceWithAniList(t, db, al)

			rec := serveDetail(t, svc, "/api/anime/33")
			require.Equal(t, http.StatusNotFound, rec.Code)
			svc.absent.Wait()

			rec2 := serveDetail(t, svc, "/api/anime/33")
			require.Equal(t, http.StatusNotFound, rec2.Code)
			require.Contains(t, rec2.Body.String(), "番剧不存在")
			assert.Equal(t, int32(1), al.detailCalls.Load(), "second request must not reach AniList")
			assert.Equal(t, int32(2), db.mainCalls.Load(), "DB is still read first")
		})
	}
}

// T-d6 / T-d7: failures that say nothing about the id are not remembered.
func TestDetail_Cold_TransientFailuresNotRemembered(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		err    error
		status int
	}{
		"rate limited": {anilist.ErrRateLimited, http.StatusServiceUnavailable},
		"upstream 502": {&anilist.ErrUpstream{Status: http.StatusBadGateway, Message: "bad"}, http.StatusBadGateway},
		"upstream 521": {&anilist.ErrUpstream{Status: 521, Message: "down"}, http.StatusBadGateway},
		"deadline":     {context.DeadlineExceeded, http.StatusBadGateway},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			al := &fakeAniListDetailer{
				detailFn: func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
					return nil, tc.err
				},
			}
			svc := newDetailServiceWithAniList(t, coldDB(), al)

			for i := 0; i < 2; i++ {
				rec := serveDetail(t, svc, "/api/anime/34")
				require.Equal(t, tc.status, rec.Code)
				svc.absent.Wait()
			}
			assert.Equal(t, int32(2), al.detailCalls.Load(), "each request must ask AniList again")
		})
	}
}

// T-d8: once another writer puts the row in the DB, the negative entry is
// never consulted — DB first means no invalidation is needed.
func TestDetail_Cold_AbsentOverriddenByDBRow(t *testing.T) {
	t.Parallel()

	var haveRow atomic.Bool
	title := "Arrived Later"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(context.Context, int32) (dbgen.GetAnimeMainByIDRow, error) {
			if !haveRow.Load() {
				return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
			}
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:        35,
				TitleRomaji:      &title,
				CachedAt:         freshTimestamp(),
				TrailerCheckedAt: freshTimestamp(),
				DetailFetchedAt:  freshTimestamp(),
			}, nil
		},
	}
	al := &fakeAniListDetailer{detailFn: nullMedia}
	svc := newDetailServiceWithAniList(t, db, al)

	require.Equal(t, http.StatusNotFound, serveDetail(t, svc, "/api/anime/35").Code)
	svc.absent.Wait()

	haveRow.Store(true) // e.g. warm_season upserted it
	rec := serveDetail(t, svc, "/api/anime/35")

	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"titleRomaji":"Arrived Later"`)
	assert.Equal(t, int32(1), al.detailCalls.Load())
}

// T-d9: the negative entry lives as long as a stale row does, then AniList
// is asked again.
func TestDetail_Cold_AbsentExpires(t *testing.T) {
	t.Parallel()

	assert.Equal(t, staleCacheTTL, absentTTL)

	al := &fakeAniListDetailer{detailFn: nullMedia}
	svc := newDetailServiceWithAniList(t, coldDB(), al)
	short, err := cache.New[struct{}](absentCacheConfig(20 * time.Millisecond))
	require.NoError(t, err)
	svc.absent.Close()
	svc.absent = short

	serveDetail(t, svc, "/api/anime/36")
	svc.absent.Wait()
	time.Sleep(60 * time.Millisecond)
	serveDetail(t, svc, "/api/anime/36")

	assert.Equal(t, int32(2), al.detailCalls.Load(), "an expired entry must be asked about again")
}

// T-d10: the negative cache really holds 1e4 ids.  Without
// IgnoreInternalCost ristretto admits ~MaxCost/57 of them and drops the
// rest while Set still reports success.
func TestDetail_AbsentCacheHoldsItsCapacity(t *testing.T) {
	t.Parallel()

	c, err := cache.New[struct{}](absentCacheConfig(time.Hour))
	require.NoError(t, err)
	t.Cleanup(c.Close)

	const n = 10_000
	for i := 0; i < n; i++ {
		c.Set(strconv.Itoa(i), struct{}{})
		if i%1000 == 999 {
			c.Wait()
		}
	}
	c.Wait()

	hits := 0
	for i := 0; i < n; i++ {
		if _, ok := c.Get(strconv.Itoa(i)); ok {
			hits++
		}
	}
	assert.GreaterOrEqual(t, hits, n*99/100, "hits=%d", hits)
}

// -----------------------------------------------------------------------------
// Cold id: one upstream call per burst.
// -----------------------------------------------------------------------------

// T-d12: twenty concurrent requests for one cold id cost one AniList call.
func TestDetail_Cold_ConcurrentRequestsShareOneCall(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	al := &fakeAniListDetailer{
		detailFn: func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			<-release
			return &anilist.AnimeDetailResponse{Media: anilist.Media{}}, nil
		},
	}
	db := coldDB()
	svc := newDetailServiceWithAniList(t, db, al)

	const n = 20
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = serveDetail(t, svc, "/api/anime/37").Code
		}(i)
	}
	// Every request has read the DB; from there to joining the flight is
	// a cache lookup.  The sleep covers that step, not goroutine start-up.
	waitFor(t, func() bool { return db.mainCalls.Load() == n })
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()

	for i, c := range codes {
		assert.Equal(t, http.StatusNotFound, c, "request %d", i)
	}
	assert.Equal(t, int32(1), al.detailCalls.Load())
}

// T-d13: the request that started the shared call going away does not
// fail the others waiting on it.
func TestDetail_Cold_LeaderCancelDoesNotFailFollowers(t *testing.T) {
	t.Parallel()

	entered := make(chan struct{})
	var enteredOnce sync.Once
	release := make(chan struct{})
	al := &fakeAniListDetailer{
		detailFn: func(ctx context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			// Once: if the flight were not shared, a second one would
			// arrive here, and detailCalls below is what should catch it.
			enteredOnce.Do(func() { close(entered) })
			select {
			case <-release:
				// 503, not a 404: a 404 would be remembered, and a
				// follower that missed the flight would then get the
				// same answer from absent and pass without joining.
				return nil, anilist.ErrRateLimited
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	svc := newDetailServiceWithAniList(t, coldDB(), al)

	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderErr := make(chan error, 1)
	go func() {
		_, err := svc.fetchCold(leaderCtx, 38)
		leaderErr <- err
	}()
	<-entered

	followerErr := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := svc.fetchCold(ctx, 38)
		followerErr <- err
	}()
	// Joining is a cache lookup away and not observable from here, so
	// this is a sleep.  The flight cannot end before close(release), so
	// only a follower later than all of this could miss it -- and since
	// a 503 is not remembered, it would then start a second flight,
	// which detailCalls == 1 below rejects.
	time.Sleep(20 * time.Millisecond)

	cancelLeader()
	require.Error(t, <-leaderErr)
	close(release)

	err := <-followerErr
	apiErr, ok := httpx.IsAPIError(err)
	require.True(t, ok, "err=%v", err)
	assert.Equal(t, http.StatusServiceUnavailable, apiErr.Status, "follower gets the real answer, not the leader's cancellation (502)")
	assert.Equal(t, int32(1), al.detailCalls.Load())
}

// T-d14: a panic inside the shared cold fetch answers 500.  DoChan runs
// the fetch on its own goroutine and re-panics there, beyond
// httpmw.Recoverer, so without the recover in fetchCold this test binary
// would die rather than fail.
func TestDetail_Cold_PanicIsA500NotACrash(t *testing.T) {
	t.Parallel()

	al := &fakeAniListDetailer{
		detailFn: func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			panic("normalize met a shape it did not expect")
		},
	}
	svc := newDetailServiceWithAniList(t, coldDB(), al)

	rec := serveDetail(t, svc, "/api/anime/40")

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	svc.absent.Wait()
	_, remembered := svc.absent.Get("40")
	assert.False(t, remembered, "a panic says nothing about the id")
}

// T-d15: a request whose budget the DB read already spent does not start
// a detached fetch that would hold a limiter reservation for nobody.
func TestDetail_Cold_SpentBudgetStartsNoFetch(t *testing.T) {
	t.Parallel()

	al := &fakeAniListDetailer{detailFn: nullMedia}
	svc := newDetailServiceWithAniList(t, coldDB(), al)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := svc.fetchCold(ctx, 41)

	apiErr, ok := httpx.IsAPIError(err)
	require.True(t, ok, "err=%v", err)
	assert.Equal(t, http.StatusBadGateway, apiErr.Status)
	time.Sleep(20 * time.Millisecond) // a flight, had one started, runs async
	assert.Equal(t, int32(0), al.detailCalls.Load())
}
