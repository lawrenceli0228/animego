//go:build integration

// id_map_bind_worker_test.go — the bgm_bind_idmap sweep WORKER
// (internal/queue/bgm_bind_idmap.go) driven against a real Postgres.
//
// The query it calls is one statement and can be reasoned about by reading
// it.  The worker around it cannot: it decides whether to write at all (an
// env kill switch), it decides what a failure means (return nil, not an
// error), and it makes the bind and the V2 dispatch one transaction.  Those
// three decisions are invisible in SQL and each of them fails silently when
// it regresses, so they are what this file pins.
//
// # What breaks if each property regresses
//
//	kill switch      A flag that gates writes against production but is only
//	                 consulted by a boolean helper nobody wired to the write
//	                 is worse than no flag: it reads as OFF on the dashboard
//	                 while the sweep binds the whole catalogue.  So the two
//	                 disabled cases assert on the ROWS, not on the helper.
//
//	rollback         The reason EnqueueV2ManyTx exists at all.  A row that is
//	                 bound but not queued stops matching `bgm_id IS NULL`, so
//	                 it leaves this sweep's candidate set forever and no other
//	                 producer looks at a version-3 row again — its Chinese
//	                 title and score are then lost permanently and silently.
//	                 "Work returned without panicking" does not prove this;
//	                 only reading the rows back afterwards does.
//
//	Work returns nil A periodic sweep that returns an error hands the job to
//	                 river's retry policy — 25 attempts, attempt⁴ backoff,
//	                 roughly 20 days for the last one — while the next
//	                 scheduled fire is 6 hours away and is the better retry.
//
//	drained set      A second pass over already-bound rows must enqueue
//	                 nothing.  If it did, every 6-hour fire would re-dispatch
//	                 the same subjects at Bangumi's 800ms bucket forever.
//
// # Hermeticity, and why it needs the whole slate
//
// BindBgmIdsFromIdMap takes no anime id: its candidate set is every
// anime_cache row with `bgm_id IS NULL` that has a bgm_id_map entry, capped
// at a batch of 200.  Distinctive fixture ids therefore scope the ASSERTIONS
// but not the WORK — one stray unbound row with a map entry anywhere in the
// database would be bound by the Work call below and would arrive at the stub
// enqueuer as an extra pair, turning "exactly these pairs" and "no enqueue
// call at all" into claims about the neighbours instead of the worker.
//
// So this test starts from the package's own clean-slate primitive
// (testutil.TruncateAll, the same one resetState uses) rather than trusting
// that the container happens to be empty.  That is safe here for the reason
// it is safe in the other tests that call it: the container is per-package
// and the DB-touching tests in it are sequential, each seeding what it needs.
// With bgm_id_map holding nothing but this file's fixtures, the sweep cannot
// reach a row this file did not create — which is what makes the negative
// assertions ("nothing was bound", "the enqueuer was never called") mean
// something.
package integration

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

const (
	// bindWorkerEnv restates the kill switch's name because the constant that
	// holds it in package queue is unexported.  A rename there fails loudly
	// here rather than quietly: the enabled subtests would set a variable
	// nothing reads, the sweep would stay OFF, and their "these rows are now
	// bound" assertions would fail.
	bindWorkerEnv = "BGM_BIND_IDMAP_SWEEP_ENABLED"

	// bindWorkerIDFloor is the low end of the fixture id space.  Every row and
	// map entry this file writes sits above it, so a single predicate
	// separates "what this test made" from anything else, and the fixtures
	// cannot collide with a real AniList id.
	bindWorkerIDFloor = 9900000
)

// bindWorkerStubEnqueuer stands in for the river enqueuer.
//
// It satisfies queue's bindIdMapV2Enqueuer structurally.  That interface is
// unexported, so its NAME is unreachable from this package — but its single
// method is exported, and Go's interface satisfaction is structural, so a
// type declared here can still be handed to the exported constructor.  That
// is exactly why the worker declares the interface at its use site: a test
// double costs no river client and no river schema.
type bindWorkerStubEnqueuer struct {
	// err is what EnqueueV2ManyTx returns — the injected failure.
	err error

	// calls counts invocations.  Zero is the assertion for both "the sweep
	// was disabled" and "there was nothing left to bind"; those two cases are
	// only distinguishable from the rows.
	calls int

	// jobs accumulates every job handed over, so the happy path can assert on
	// the PAIRS rather than on a count.  A count would still pass if the
	// worker paired every row with the first row's bgm_id.
	jobs []queue.BangumiV2Args

	// boundInTx is how many fixture rows carried a bgm_id when read back
	// through the caller's own transaction, and txErr is that read's error.
	boundInTx int
	txErr     error
}

// EnqueueV2ManyTx records the call and reads the fixtures back through the
// transaction it was handed.
//
// That read is the load-bearing part.  Nothing outside the transaction can
// see the bind yet, so a non-zero boundInTx proves two things at once: the
// UPDATE really ran, and the tx passed to the enqueuer is the same one that
// ran it.  Without it the rollback subtest would pass just as happily against
// fixtures that were never bindable in the first place — the classic shape of
// a test that is green for a reason it does not name.
func (s *bindWorkerStubEnqueuer) EnqueueV2ManyTx(ctx context.Context, tx pgx.Tx, jobs []queue.BangumiV2Args) error {
	s.calls++
	s.jobs = append(s.jobs, jobs...)
	s.txErr = tx.QueryRow(ctx, `
		SELECT count(*) FROM anime_cache
		WHERE anilist_id >= $1 AND bgm_id IS NOT NULL`,
		bindWorkerIDFloor).Scan(&s.boundInTx)
	return s.err
}

// bindWorkerSeed creates unbound anime_cache rows plus the id-map entries that
// make them bindable, and registers their removal.
//
// bangumi_version is 3 deliberately: that is the state migration 0004 records
// for everything enriched under the pre-Go pipeline, and it is the whole
// reason this sweep exists — UpdateBangumiV1 is guarded on version 0, so no
// other producer will ever look at these rows again.
//
// The pairs are expressed as BangumiV2Args because the fixture list is also
// the expected dispatch: what goes into the database is what must come out of
// the enqueuer.
func bindWorkerSeed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pairs []queue.BangumiV2Args) {
	t.Helper()
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM bgm_id_map WHERE anilist_id >= $1`, bindWorkerIDFloor)
		_, _ = pool.Exec(bg, `DELETE FROM anime_cache WHERE anilist_id >= $1`, bindWorkerIDFloor)
	})
	for _, p := range pairs {
		require.GreaterOrEqual(t, p.AnilistID, bindWorkerIDFloor,
			"fixtures must live above the floor or cleanup and the read-back predicate miss them")
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, title_romaji, bgm_id, bangumi_version)
			VALUES ($1, 'Bind Sweep Fixture', NULL, 3)`, p.AnilistID)
		require.NoError(t, err, "seed anime_cache %d", p.AnilistID)
		_, err = pool.Exec(ctx, `
			INSERT INTO bgm_id_map (anilist_id, bgm_id, source)
			VALUES ($1, $2, 'test')`, p.AnilistID, p.BgmID)
		require.NoError(t, err, "seed bgm_id_map %d", p.AnilistID)
	}
}

// bindWorkerBoundPairs reads back which fixture rows now carry a bgm_id.
// Returning pairs rather than a count is what lets the happy path assert that
// each row got ITS OWN subject.
func bindWorkerBoundPairs(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []queue.BangumiV2Args {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT anilist_id, bgm_id FROM anime_cache
		WHERE anilist_id >= $1 AND bgm_id IS NOT NULL
		ORDER BY anilist_id`, bindWorkerIDFloor)
	require.NoError(t, err, "read back bound fixtures")
	defer rows.Close()

	out := []queue.BangumiV2Args{}
	for rows.Next() {
		var p queue.BangumiV2Args
		require.NoError(t, rows.Scan(&p.AnilistID, &p.BgmID))
		out = append(out, p)
	}
	require.NoError(t, rows.Err())
	return out
}

// bindWorkerRun builds the worker and runs exactly one pass.  The job value is
// empty because BindIdMapArgs carries no payload and Work never reads the job:
// the candidate set is entirely a function of the two tables.
func bindWorkerRun(t *testing.T, ctx context.Context, pool *pgxpool.Pool, stub *bindWorkerStubEnqueuer) error {
	t.Helper()
	w := queue.NewBindIdMapWorker(pool, dbgen.New(pool), stub)
	return w.Work(ctx, &river.Job[queue.BindIdMapArgs]{})
}

func TestBindIdMapWorker(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)

	// See the file header: the sweep is catalogue-wide, so scoping it means
	// owning the whole slate, not just picking unusual ids.
	testutil.TruncateAll(t, ctx, pool)

	// The kill switch gates the WRITE, not just a helper.
	//
	// Both disabled values are asserted against the rows for the same reason:
	// the failure this guards against is a flag that is read somewhere and
	// wired nowhere.  "yes-please" is the fail-closed half — a typo in a
	// variable that gates production writes must not be read as ON, and
	// ParseBool rejects everything outside its small vocabulary.
	//
	// The empty string stands in for "unset": bindIdMapSweepEnabled reads it
	// with os.Getenv, which cannot tell the two apart, and t.Setenv restores
	// whatever the developer's shell had — including an inherited "1", which
	// would otherwise make this subtest silently untestable.
	for _, value := range []struct{ name, env string }{
		{"unset", ""},
		{"unparseable", "yes-please"},
	} {
		t.Run("kill switch "+value.name+" binds nothing", func(t *testing.T) {
			pairs := []queue.BangumiV2Args{
				{AnilistID: 9900101, BgmID: 9900901},
				{AnilistID: 9900102, BgmID: 9900902},
			}
			bindWorkerSeed(t, ctx, pool, pairs)
			t.Setenv(bindWorkerEnv, value.env)

			stub := &bindWorkerStubEnqueuer{}
			require.NoError(t, bindWorkerRun(t, ctx, pool, stub))

			assert.Empty(t, bindWorkerBoundPairs(t, ctx, pool),
				"bindable candidates existed and the switch was off; a bind here means the flag gates nothing")
			assert.Zero(t, stub.calls,
				"a disabled sweep must not reach the enqueuer either — the V2 jobs would run against Bangumi regardless of the flag")
		})
	}

	// THE one this file is for: the bind and the dispatch are one unit.
	t.Run("an enqueue failure rolls the bind back", func(t *testing.T) {
		pairs := []queue.BangumiV2Args{
			{AnilistID: 9900201, BgmID: 9900801},
			{AnilistID: 9900202, BgmID: 9900802},
		}
		bindWorkerSeed(t, ctx, pool, pairs)
		t.Setenv(bindWorkerEnv, "1")

		stub := &bindWorkerStubEnqueuer{err: errors.New("river InsertManyTx failed")}
		err := bindWorkerRun(t, ctx, pool, stub)

		// Property 4 lives on this path: a failed pass is logged and swallowed
		// so the next 6-hour fire retries it, instead of river's 25 attempts
		// with attempt⁴ backoff stretching the last one out to ~20 days.
		require.NoError(t, err,
			"a failed pass must not return an error — river's retry policy is the wrong shape for a periodic sweep")

		// Without these two, "the rows are still NULL" would also be true of a
		// test whose fixtures were never bindable, or whose worker never got
		// as far as the enqueuer.  They make the rollback assertion mean what
		// it says.
		require.Equal(t, 1, stub.calls, "the enqueuer must actually have been reached")
		require.NoError(t, stub.txErr,
			"the enqueuer must be handed a LIVE transaction — the one that did the bind, not a committed handle")
		require.Equal(t, len(pairs), stub.boundInTx,
			"the bind must already be written inside the transaction the enqueuer was handed")

		assert.Empty(t, bindWorkerBoundPairs(t, ctx, pool),
			"a bound-but-not-enqueued row leaves the candidate set (bgm_id IS NULL) forever and is never enriched")
	})

	t.Run("a pass binds candidates and dispatches exactly them", func(t *testing.T) {
		pairs := []queue.BangumiV2Args{
			{AnilistID: 9900301, BgmID: 9900701},
			{AnilistID: 9900302, BgmID: 9900702},
			{AnilistID: 9900303, BgmID: 9900703},
		}
		bindWorkerSeed(t, ctx, pool, pairs)
		t.Setenv(bindWorkerEnv, "1")

		stub := &bindWorkerStubEnqueuer{}
		require.NoError(t, bindWorkerRun(t, ctx, pool, stub))

		assert.ElementsMatch(t, pairs, bindWorkerBoundPairs(t, ctx, pool),
			"every candidate must carry the subject the map named for IT")

		// One statement, so one enqueue call — and the pairs, not the count,
		// because a worker that dispatched three jobs all carrying the first
		// row's bgm_id would satisfy a count and would enrich two rows with
		// another show's Chinese title and score.
		assert.Equal(t, 1, stub.calls, "one batch is one dispatch")
		assert.ElementsMatch(t, pairs, stub.jobs,
			"exactly one V2 job per bound row, carrying that row's own {anilistId, bgmId}")
	})

	t.Run("a second pass over a drained set is a no-op", func(t *testing.T) {
		pairs := []queue.BangumiV2Args{
			{AnilistID: 9900401, BgmID: 9900601},
			{AnilistID: 9900402, BgmID: 9900602},
		}
		bindWorkerSeed(t, ctx, pool, pairs)
		t.Setenv(bindWorkerEnv, "1")

		// Draining the set through a real pass rather than asserting against
		// an empty database is the point: it pins the claim that lets this
		// sweep skip attempt bookkeeping — a bound row stops matching
		// `bgm_id IS NULL`, so it never returns to the front of a batch.  A
		// regression here would re-dispatch the same subjects at every fire,
		// forever, against Bangumi's 800ms bucket.
		stub := &bindWorkerStubEnqueuer{}
		require.NoError(t, bindWorkerRun(t, ctx, pool, stub))
		require.Equal(t, 1, stub.calls, "the first pass must have had something to bind")
		require.Len(t, bindWorkerBoundPairs(t, ctx, pool), len(pairs))

		require.NoError(t, bindWorkerRun(t, ctx, pool, stub),
			"an empty pass is a success, not a failure")
		assert.Equal(t, 1, stub.calls,
			"nothing was bindable, so nothing may be enqueued — bindBatch returns before it reaches the enqueuer")
		assert.ElementsMatch(t, pairs, bindWorkerBoundPairs(t, ctx, pool),
			"the second pass must not have disturbed what the first one bound")
	})
}
