//go:build integration

// hant_backfill_test.go — the zh-Hant sweep end to end, against a real
// Postgres and a real river client.
//
// The unit tests in internal/queue prove the worker hands the right rows
// to the right statement.  Four things they cannot prove live here, and
// all four are properties of the database rather than of the Go:
//
//  1. The batch UPDATEs actually land — the unnest join, the parallel
//     text[] arrays, and the CHECK constraints on *_hant_source.
//  2. The manual guard in the WHERE clause holds even when the Go layer
//     is bypassed, which is the guard's whole reason to exist ("it
//     survives a bug in the tool").
//  3. UniqueOpts collapses a second enqueue instead of stacking a second
//     whole-table pass.
//  4. GetHantBackfillJobStatus reads the kind and the state list this
//     worker actually produces — that pair is a hand-kept mirror across
//     Go and SQL and nothing else checks it.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/admin"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/hant"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// hantWaitTimeout bounds the wait for the sweep to complete.  Generous:
// it covers loading 1.7 MB of vendored JSON plus a 53,579-entry
// conversion table, on top of river's fetch cooldown.
const hantWaitTimeout = 60 * time.Second

// bootHantQueue starts a river client with only the zh-Hant sweep
// registered, against a truncated database.
//
// Only that worker, on purpose: the other kinds would need their own
// stubs and none of them are what this file is about.  An undeclared
// queue is inert rather than an error, so their jobs simply never fetch.
func bootHantQueue(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *river.Client[pgx.Tx] {
	t.Helper()

	workers := river.NewWorkers()
	queue.AddHantBackfillWorker(workers, dbgen.New(pool), hantVendoredDir(t))

	c, err := queue.Boot(pool, queue.Config{
		Workers: workers,
		Queues: map[string]river.QueueConfig{
			queue.HantBackfillQueueName: {MaxWorkers: 1},
		},
	})
	require.NoError(t, err, "queue.Boot")
	require.NoError(t, c.Start(ctx), "client.Start")
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = c.Stop(stopCtx)
	})
	return c
}

// hantVendoredDir is go-api/data/hant, resolved the same way
// testutil.migrationsDirAbs resolves the migrations directory: from this
// source file's location rather than from the test's working directory.
func hantVendoredDir(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	require.True(t, ok, "runtime.Caller failed")
	// test/integration/hant_backfill_test.go -> test/integration -> test -> go-api
	return filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(self))), "data", "hant")
}

// seedHantRow inserts one anime_cache row with the columns the ladder
// reads and writes.
func seedHantRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool,
	anilistID int32, titleNative, titleChinese, descriptionCN, titleHant, titleHantSource *string,
) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (
			anilist_id, title_native, title_chinese, description_cn,
			title_hant, title_hant_source, cached_at
		) VALUES ($1, $2, $3, $4, $5, $6, now())`,
		anilistID, titleNative, titleChinese, descriptionCN, titleHant, titleHantSource,
	)
	require.NoError(t, err, "seed anime_cache %d", anilistID)
}

// hantRow is what the sweep left behind for one anime.
type hantRow struct {
	titleHant, titleHantSource, titleHantHash *string
	descHant, descHantSource, descHantHash    *string
	titleHantSEO                              *string
}

func readHantRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, anilistID int32) hantRow {
	t.Helper()
	var r hantRow
	err := pool.QueryRow(ctx, `
		SELECT title_hant, title_hant_source, title_hant_source_hash,
		       description_hant, description_hant_source, description_hant_source_hash,
		       title_hant_seo
		FROM anime_cache WHERE anilist_id = $1`, anilistID,
	).Scan(&r.titleHant, &r.titleHantSource, &r.titleHantHash,
		&r.descHant, &r.descHantSource, &r.descHantHash, &r.titleHantSEO)
	require.NoError(t, err, "read anime_cache %d", anilistID)
	return r
}

// runHantSweep enqueues one pass through the production enqueuer and
// waits for river to report it completed.
func runHantSweep(t *testing.T, ctx context.Context, c *river.Client[pgx.Tx]) {
	t.Helper()

	sub, cancelSub := c.Subscribe(river.EventKindJobCompleted, river.EventKindJobFailed)
	defer cancelSub()

	inserted, err := queue.NewEnqueuer(c).EnqueueHantBackfillNow(ctx)
	require.NoError(t, err, "EnqueueHantBackfillNow")
	require.True(t, inserted, "the first enqueue must actually insert")

	waitCtx, cancel := context.WithTimeout(ctx, hantWaitTimeout)
	defer cancel()

	select {
	case ev := <-sub:
		require.NotNil(t, ev.Job)
		require.Equal(t, "hant_backfill", ev.Job.Kind)
		require.Equal(t, "completed", string(ev.Job.State),
			"the sweep did not complete; river errors: %v", ev.Job.Errors)
	case <-waitCtx.Done():
		t.Fatalf("timed out after %s waiting for the sweep", hantWaitTimeout)
	}
}

// TestHantBackfillWorkerAgainstPostgres runs the real worker, through the
// real river client, over real rows, and checks what landed in the table.
func TestHantBackfillWorkerAgainstPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	native := "進撃の巨人"
	chinese := "进击的巨人"
	desc := "人类与巨人之间的战斗。"
	handWritten := "一個人手打的標題"
	manual := "manual"

	// 16498 is Attack on Titan: the vendored anilist dataset carries it,
	// so the ladder resolves a human-written Traditional title rather than
	// a machine conversion — which also exercises the SERP whitelist.
	seedHantRow(t, ctx, pool, 16498, &native, &chinese, &desc, nil, nil)
	// A row whose only route is machine conversion.
	onlyChinese := "某个没有数据集条目的标题"
	seedHantRow(t, ctx, pool, 99000001, nil, &onlyChinese, &desc, nil, nil)
	// A row a human decided.  Nothing may touch it.
	seedHantRow(t, ctx, pool, 99000002, &native, &chinese, &desc, &handWritten, &manual)
	// A row with nothing to convert from.
	seedHantRow(t, ctx, pool, 99000003, nil, nil, nil, nil, nil)

	c := bootHantQueue(t, ctx, pool)
	runHantSweep(t, ctx, c)

	t.Run("a dataset row gets a human title and reaches the SERP", func(t *testing.T) {
		got := readHantRow(t, ctx, pool, 16498)
		require.NotNil(t, got.titleHant)
		require.NotNil(t, got.titleHantSource)
		assert.Contains(t, []string{"wikipedia", "anilist"}, *got.titleHantSource,
			"a row the datasets carry must not fall through to opencc")
		require.NotNil(t, got.titleHantHash, "the provenance hash is what makes drift detectable later")
		assert.NotNil(t, got.titleHantSEO,
			"title_hant_seo is NULL, so a dataset-sourced title is being kept out of search results")

		require.NotNil(t, got.descHant)
		require.NotNil(t, got.descHantSource)
		assert.Equal(t, "opencc", *got.descHantSource,
			"no dataset carries a Traditional synopsis; anything else would violate 0022's CHECK")
		assert.NotEqual(t, desc, *got.descHant, "the synopsis was stored unconverted")
	})

	t.Run("a row with no dataset entry falls through to the machine tier", func(t *testing.T) {
		got := readHantRow(t, ctx, pool, 99000001)
		require.NotNil(t, got.titleHantSource)
		assert.Equal(t, "opencc", *got.titleHantSource)
		assert.Nil(t, got.titleHantSEO,
			"a machine-converted title reached title_hant_seo; that is what migration 0022 exists to stop")
	})

	t.Run("the manual row is untouched", func(t *testing.T) {
		got := readHantRow(t, ctx, pool, 99000002)
		require.NotNil(t, got.titleHant)
		assert.Equal(t, handWritten, *got.titleHant, "the sweep overwrote a human decision")
		assert.Nil(t, got.titleHantHash, "a manual row has no input to hash")
		// The description column carries no manual marker, so the sweep is
		// free to fill it — manual protection is per column, not per row.
		assert.NotNil(t, got.descHant)
	})

	t.Run("a row no tier can reach is left alone", func(t *testing.T) {
		got := readHantRow(t, ctx, pool, 99000003)
		assert.Nil(t, got.titleHant)
		assert.Nil(t, got.descHant)
	})

	t.Run("the admin endpoint sees the run that just happened", func(t *testing.T) {
		// Through the handler rather than the query, because the pieces
		// that can disagree are on either side of it: the kind and state
		// literals in the SQL are a hand-kept mirror of HantBackfillArgs,
		// and `lastRunAt` has to survive pgtype's Valid flag on the way
		// out.  Only a completed job on a real river_job row proves both.
		h := admin.NewHantHandlers(dbgen.New(pool), queue.NewEnqueuer(c))
		rec := httptest.NewRecorder()
		h.GetHantStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/hant/stats", nil))
		require.Equal(t, http.StatusOK, rec.Code)
		t.Logf("GET /api/admin/hant/stats after a real sweep -> %s", rec.Body.String())

		var env struct {
			Data admin.HantStatsResp `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))

		assert.False(t, env.Data.Running, "the sweep finished, so nothing should be in flight")
		require.NotNil(t, env.Data.LastRunAt,
			"lastRunAt is null after a completed sweep — the kind or the state literal in GetHantBackfillJobStatus has drifted from HantBackfillArgs")
		assert.WithinDuration(t, time.Now(), *env.Data.LastRunAt, 3*time.Minute)

		assert.Equal(t, int64(4), env.Data.Total)
		assert.Zero(t, env.Data.TitleBehind, "the sweep just converted every row that had a Chinese title")
		assert.Zero(t, env.Data.DescBehind, "the sweep just converted every row that had a Chinese synopsis")
		assert.Equal(t, int64(2), env.Data.SerpEligible,
			"only the dataset-sourced title and the hand-written one may reach search results")
	})

	t.Run("a second pass writes nothing", func(t *testing.T) {
		before := readHantRow(t, ctx, pool, 16498)
		runHantSweep(t, ctx, c)
		after := readHantRow(t, ctx, pool, 16498)
		assert.Equal(t, before, after,
			"the second pass rewrote a row it had already converted; every future pass would rewrite the whole table")
	})
}

// Prevents: a second press stacking a second whole-table pass.
//
// The client is deliberately NOT started, so nothing drains the queue and
// both inserts are evaluated against a job sitting in `available`.  That
// is the state an operator actually double-clicks in.
func TestHantBackfillEnqueueIsDedupedWhileInFlight(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	workers := river.NewWorkers()
	queue.AddHantBackfillWorker(workers, dbgen.New(pool), hantVendoredDir(t))
	c, err := queue.Boot(pool, queue.Config{
		Workers: workers,
		Queues:  map[string]river.QueueConfig{queue.HantBackfillQueueName: {MaxWorkers: 1}},
	})
	require.NoError(t, err)

	enq := queue.NewEnqueuer(c)

	first, err := enq.EnqueueHantBackfillNow(ctx)
	require.NoError(t, err)
	assert.True(t, first, "the first press must schedule a sweep")

	second, err := enq.EnqueueHantBackfillNow(ctx)
	require.NoError(t, err, "a duplicate must be reported, not errored")
	assert.False(t, second, "the second press scheduled a second whole-table pass")

	var n int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM river_job WHERE kind = 'hant_backfill'`).Scan(&n))
	assert.Equal(t, 1, n, "river_job holds %d hant_backfill rows, want 1", n)

	// And the endpoint's flag agrees with the dedupe that just happened.
	status, err := dbgen.New(pool).GetHantBackfillJobStatus(ctx)
	require.NoError(t, err)
	assert.True(t, status.Running,
		"the pending job is invisible to GetHantBackfillJobStatus, so the panel would say idle while the button silently no-ops")
	assert.False(t, status.LastRunAt.Valid, "nothing has completed yet")
}

// Prevents: the UPDATE's manual guard being trusted to the Go layer.
//
// internal/hant refuses to propose anything for a manual row, but that
// check lives in Go and a future caller of these statements will not have
// read it.  The guard in the WHERE clause is the one that survives a bug
// in the tool, so it is asserted by going around the tool entirely and
// handing the statement a manual row on purpose.
func TestHantApplyStatementsRefuseManualRows(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	handWritten := "一個人手打的標題"
	handWrittenDesc := "一段人手打的簡介。"
	manual := "manual"
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (
			anilist_id, title_hant, title_hant_source,
			description_hant, description_hant_source, cached_at
		) VALUES (99000010, $1, 'manual', $2, 'manual', now())`,
		handWritten, handWrittenDesc)
	require.NoError(t, err)

	ids := []int32{99000010}
	rows, err := q.ApplyHantTitleBatch(ctx, ids,
		[]string{"機器產生的標題"}, []string{"opencc"}, []string{hant.SourceHash("机器产生的标题")})
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows, "the manual guard let a title write through")

	rows, err = q.ApplyHantDescriptionBatch(ctx, ids,
		[]string{"機器產生的簡介。"}, []string{"opencc"}, []string{hant.SourceHash("机器产生的简介。")})
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows, "the manual guard let a description write through")

	got := readHantRow(t, ctx, pool, 99000010)
	require.NotNil(t, got.titleHant)
	require.NotNil(t, got.descHant)
	assert.Equal(t, handWritten, *got.titleHant)
	assert.Equal(t, handWrittenDesc, *got.descHant)
	assert.Equal(t, manual, *got.titleHantSource)
}
