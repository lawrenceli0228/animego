//go:build integration

// queue_registry_test.go — the gate on the background-job configuration.
//
// # WHY THIS IS AN INTEGRATION TEST AND NOT A STARTUP CHECK
//
// The obvious fix for the 2026-09-08 stall is a boot-time assertion that
// every UniqueOpts.ByState contains the four states river requires.  That was
// the plan, and it is wrong twice.
//
// It would misfire.  DescriptionBackfillArgs and DescriptionLlmBackfillArgs
// use UniqueOpts{ByArgs: true} with a nil ByState on purpose, and river's
// validate() returns early on nil — a hand-written gate would reject two
// kinds river is perfectly happy with.
//
// And it would rot into the exact failure it was written to prevent.  Those
// four states are river's PRIVATE constant (insert_opts.go requiredV3states);
// rivertype exports neither it nor anything equal to it.  A hand-copied
// version reports green while river reports an error the moment river adds a
// fifth — an ERROR line, no other symptom, and now a reassuring test on top
// of it.
//
// So the gate runs river's own validate(), against a real Postgres, by
// booting the production configuration and asserting the rows actually land.
package integration

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/obs"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// registryWaitTimeout bounds the poll for an expected river_job row.  Generous
// because RunOnStart inserts happen inside the enqueuer's first tick, not
// synchronously inside Start.
const registryWaitTimeout = 20 * time.Second

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// inertWorkers registers a do-nothing worker for every kind in the registry.
//
// The production bundle is deliberately NOT used here.  Those workers make
// Bangumi, AniList, dandanplay and DeepSeek calls, and this test's job is to
// prove the CONFIGURATION is valid — that the jobs are created — not to run
// them.  TestQueueRegistry_ProductionWorkersCoverEveryKind covers the other
// half: that a real worker exists for each kind.
func inertWorkers() *river.Workers {
	w := river.NewWorkers()
	river.AddWorker(w, &inert[queue.BangumiV1Args]{})
	river.AddWorker(w, &inert[queue.BangumiV2Args]{})
	river.AddWorker(w, &inert[queue.BangumiV3Args]{})
	river.AddWorker(w, &inert[queue.WarmSeasonArgs]{})
	river.AddWorker(w, &inert[queue.OrphanScanArgs]{})
	river.AddWorker(w, &inert[queue.DescriptionBackfillScanArgs]{})
	river.AddWorker(w, &inert[queue.DescriptionBackfillArgs]{})
	river.AddWorker(w, &inert[queue.DescriptionLlmBackfillScanArgs]{})
	river.AddWorker(w, &inert[queue.DescriptionLlmBackfillArgs]{})
	river.AddWorker(w, &inert[queue.EpisodesBgmScanArgs]{})
	river.AddWorker(w, &inert[queue.EpisodesBgmArgs]{})
	river.AddWorker(w, &inert[queue.EpisodeTitlesArgs]{})
	river.AddWorker(w, &inert[queue.BindIdMapArgs]{})
	river.AddWorker(w, &inert[queue.HantBackfillArgs]{})
	river.AddWorker(w, &inert[queue.AnilistRatingsArgs]{})
	river.AddWorker(w, &inert[queue.BangumiRatingsArgs]{})
	return w
}

// inert satisfies river.Worker for any Args type and does nothing.
type inert[T river.JobArgs] struct {
	river.WorkerDefaults[T]
}

func (w *inert[T]) Work(context.Context, *river.Job[T]) error { return nil }

// capturedErrors records the ERROR-level slog lines a client emitted, through
// the same forwarding handler production uses.  river reports background
// failures ONLY through its Logger, so this is the only place a test can see
// them.
type capturedErrors struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (c *capturedErrors) CaptureEvent(event *sentry.Event) *sentry.EventID {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event)
	id := sentry.EventID("test")
	return &id
}

func (c *capturedErrors) messages() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.events))
	for _, e := range c.events {
		out = append(out, e.Message)
	}
	return out
}

// newCapturingLogger returns a logger shaped exactly like production's: JSON
// to a discard sink, wrapped by the Sentry forwarder.
func newCapturingLogger(t *testing.T) (*slog.Logger, *capturedErrors) {
	t.Helper()

	cap := &capturedErrors{}
	base := slog.NewJSONHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(obs.NewSentryErrorHandler(base, obs.Options{
		Capturer: cap,
		// No cap: a test must see every error, not the first twenty.
		RateBurst: -1,
	})), cap
}

// testWriter routes river's log output into the test's own log, so a failure
// carries the river lines that explain it.
type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Logf("river: %s", p)
	return len(p), nil
}

// countJobs returns how many river_job rows exist for a kind, in any state.
//
// Counting the table rather than subscribing to completion events on purpose:
// what this test asserts is that the job was CREATED.  Whether it then ran is
// a different question, and a job that fails still leaves the row that proves
// the enqueuer worked.
func countJobs(t *testing.T, ctx context.Context, pool *pgxpool.Pool, kind string) int {
	t.Helper()

	var n int
	err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = $1`, kind).Scan(&n)
	require.NoError(t, err, "count river_job for kind %q", kind)
	return n
}

// waitForJob polls until a row of the given kind exists, or the timeout
// elapses.  Returns whether it appeared.
func waitForJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, kind string, timeout time.Duration) bool {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if countJobs(t, ctx, pool, kind) > 0 {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(100 * time.Millisecond):
		}
	}
	return countJobs(t, ctx, pool, kind) > 0
}

// waitForAllJobs polls until every kind has a row, and returns the kinds that
// never appeared.  One shared deadline, so N broken kinds cost one timeout.
func waitForAllJobs(t *testing.T, ctx context.Context, pool *pgxpool.Pool, kinds []string, timeout time.Duration) []string {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for {
		var missing []string
		for _, kind := range kinds {
			if countJobs(t, ctx, pool, kind) == 0 {
				missing = append(missing, kind)
			}
		}
		if len(missing) == 0 || time.Now().After(deadline) {
			return missing
		}
		select {
		case <-ctx.Done():
			return missing
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// startClient boots and starts a client, registering a bounded shutdown.
func startClient(t *testing.T, ctx context.Context, pool *pgxpool.Pool, cfg queue.Config) *river.Client[pgx.Tx] {
	t.Helper()

	c, err := queue.Boot(pool, cfg)
	require.NoError(t, err, "queue.Boot must accept the configuration")
	require.NoError(t, c.Start(ctx), "client.Start")
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = c.Stop(stopCtx)
	})
	return c
}

// ---------------------------------------------------------------------------
// The production configuration boots
// ---------------------------------------------------------------------------

// TestQueueRegistry_ProductionConfigStartsAndEnqueues is the end-to-end
// reproduction of the 2026-09-08 incident, run forwards.
//
// It boots river with the queue map and periodic schedule the server ships,
// against a real Postgres, and asserts that every kind declared RunOnStart
// actually produces a river_job row.  On 2026-09-08 two of them did not, and
// the only evidence was one ERROR line.
//
// The assertion is per-kind rather than "some rows exist" deliberately:
// UniqueOpts.validate fails for ONE kind at a time, so an aggregate count
// would have passed on the night of the incident.
func TestQueueRegistry_ProductionConfigStartsAndEnqueues(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	logger, errs := newCapturingLogger(t)
	reg := queue.Default()

	startClient(t, ctx, pool, queue.Config{
		Workers:      inertWorkers(),
		Queues:       reg.QueueConfigs(),
		PeriodicJobs: reg.PeriodicJobs(),
		Logger:       logger,
	})

	var runOnStart []string
	for _, e := range reg.Entries() {
		if e.Periodic != nil && e.Periodic.RunOnStart {
			runOnStart = append(runOnStart, e.Kind())
		}
	}
	require.NotEmpty(t, runOnStart, "the registry must declare boot-fired sweeps")

	// One deadline for the whole set rather than one each: a broken kind must
	// cost the suite a single timeout, not one per kind.
	missing := waitForAllJobs(t, ctx, pool, runOnStart, registryWaitTimeout)
	assert.Empty(t, missing,
		"these kinds declare RunOnStart but river never created a job for them — "+
			"this is the 2026-09-08 failure shape: the service starts, serves "+
			"traffic, and silently stops enqueueing a sweep")

	// The other half of the same guarantee, and the one that would catch a
	// kind this test does not know to look for: river must have nothing to
	// complain about.  The capturer is wired exactly as production wires it.
	assert.Empty(t, errs.messages(),
		"river logged an ERROR while starting the production configuration")
}

// ---------------------------------------------------------------------------
// The incident, reproduced
// ---------------------------------------------------------------------------

// brokenUniqueArgs carries the UniqueOpts that took production down: the set
// river's validate() requires, minus `running`.
//
// This is the mutation as a FIXTURE rather than as a manual edit somebody has
// to remember to run. It cannot rot the way a hand-copied list of required
// states can, because it asserts the CONSEQUENCE (no row, one ERROR) rather
// than the rule.
type brokenUniqueArgs struct{}

func (brokenUniqueArgs) Kind() string { return "registry_test_broken_unique" }

func (brokenUniqueArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue: queue.RatingsQueueName,
		UniqueOpts: river.UniqueOpts{
			ByArgs: true,
			ByState: []rivertype.JobState{
				rivertype.JobStateAvailable,
				rivertype.JobStatePending,
				rivertype.JobStateRetryable,
				// rivertype.JobStateRunning — the removal that caused it.
				rivertype.JobStateScheduled,
			},
		},
	}
}

// healthyUniqueArgs is the same job with the state set put back, so the two
// halves of this test differ in exactly one element.
type healthyUniqueArgs struct{}

func (healthyUniqueArgs) Kind() string { return "registry_test_healthy_unique" }

func (healthyUniqueArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue: queue.RatingsQueueName,
		UniqueOpts: river.UniqueOpts{
			ByArgs: true,
			ByState: []rivertype.JobState{
				rivertype.JobStateAvailable,
				rivertype.JobStatePending,
				rivertype.JobStateRetryable,
				rivertype.JobStateRunning,
				rivertype.JobStateScheduled,
			},
		},
	}
}

// TestQueueRegistry_MissingRunningStateStopsEnqueueingSilently is the
// regression test for the incident itself.
//
// Two periodic jobs, identical but for one JobState. The healthy one produces
// a river_job row. The broken one produces no row at all — and, before the
// Sentry forwarding, no other signal either.
//
// Both halves matter. Without the healthy control the test would pass if the
// harness simply never enqueued anything, which is the failure mode it is
// meant to detect.
func TestQueueRegistry_MissingRunningStateStopsEnqueueingSilently(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	logger, errs := newCapturingLogger(t)

	workers := river.NewWorkers()
	river.AddWorker(workers, &inert[brokenUniqueArgs]{})
	river.AddWorker(workers, &inert[healthyUniqueArgs]{})

	startClient(t, ctx, pool, queue.Config{
		Workers: workers,
		Queues: map[string]river.QueueConfig{
			queue.RatingsQueueName: {MaxWorkers: 1},
		},
		PeriodicJobs: []*river.PeriodicJob{
			river.NewPeriodicJob(
				river.PeriodicInterval(time.Hour),
				func() (river.JobArgs, *river.InsertOpts) { return brokenUniqueArgs{}, nil },
				&river.PeriodicJobOpts{RunOnStart: true},
			),
			river.NewPeriodicJob(
				river.PeriodicInterval(time.Hour),
				func() (river.JobArgs, *river.InsertOpts) { return healthyUniqueArgs{}, nil },
				&river.PeriodicJobOpts{RunOnStart: true},
			),
		},
		Logger: logger,
	})

	// The control: a complete state set enqueues.
	require.True(t, waitForJob(t, ctx, pool, healthyUniqueArgs{}.Kind(), registryWaitTimeout),
		"the healthy control never enqueued — the harness itself is broken, and "+
			"the negative assertion below would be meaningless")

	// The incident: one missing state and the job simply does not exist.
	assert.Zero(t, countJobs(t, ctx, pool, brokenUniqueArgs{}.Kind()),
		"a UniqueOpts.ByState missing `running` must not enqueue — if this row "+
			"exists, river relaxed its requirement and the incident's premise changed")

	// And it is not silent any more.  This is the half that was missing on the
	// night: river reported it, at ERROR, to a logger nothing was reading.
	assert.Contains(t, errs.messages(),
		"maintenance.PeriodicJobEnqueuer: Internal error generating periodic job",
		"the failure must reach the Sentry forwarder; river reports it nowhere else")
}

// ---------------------------------------------------------------------------
// The two other ways a kind can silently not run
// ---------------------------------------------------------------------------

// undeclaredQueueArgs routes to a queue no Config.Queues entry declares.
type undeclaredQueueArgs struct{}

func (undeclaredQueueArgs) Kind() string { return "registry_test_undeclared_queue" }
func (undeclaredQueueArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "registry_test_no_such_queue"}
}

// TestQueueRegistry_UndeclaredQueueNeverRuns records what river actually does
// with a job routed to a queue that has no worker pool: the row is created and
// then nothing ever fetches it.
//
// This is why Registry.validate rejects the configuration instead of leaving
// it to river.  There is no error to observe here — not a log line, not a
// failed insert — only a row that stays `available` forever.  It is the
// quietest failure in this file, and the only defence against it is that the
// registry refuses to be built that way.
func TestQueueRegistry_UndeclaredQueueNeverRuns(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	logger, errs := newCapturingLogger(t)

	workers := river.NewWorkers()
	river.AddWorker(workers, &inert[undeclaredQueueArgs]{})

	c := startClient(t, ctx, pool, queue.Config{
		Workers: workers,
		Queues:  map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 1}},
		Logger:  logger,
	})

	_, err := c.Insert(ctx, undeclaredQueueArgs{}, nil)
	require.NoError(t, err,
		"river accepts the insert — the queue is not validated against Config.Queues")

	require.True(t, waitForJob(t, ctx, pool, undeclaredQueueArgs{}.Kind(), registryWaitTimeout))

	// Give any producer that might pick it up a fair chance to do so.
	time.Sleep(2 * time.Second)

	var state string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT state FROM river_job WHERE kind = $1`, undeclaredQueueArgs{}.Kind(),
	).Scan(&state))
	assert.Equal(t, "available", state,
		"a job on an undeclared queue is never fetched; it sits available forever")
	assert.Empty(t, errs.messages(),
		"and river says nothing about it — which is exactly why the registry "+
			"cross-checks queue names at construction instead")
}

// unregisteredArgs has no worker registered for its kind.
type unregisteredArgs struct{}

func (unregisteredArgs) Kind() string { return "registry_test_unregistered" }
func (unregisteredArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: river.QueueDefault}
}

// TestQueueRegistry_UnregisteredKindIsRejectedAtInsert pins the one failure in
// this family river catches loudly: a kind with no worker.
//
// Worth knowing which path this covers.  client.Insert validates against the
// workers bundle and returns UnknownJobKindError.  The PERIODIC path does not
// — insertParamsFromConfigArgsAndOptions never consults the bundle — so a
// scheduled kind with no worker is inserted happily and only fails when a
// producer tries to run it.  That is why worker coverage is asserted
// separately against the production bundle rather than trusted to river.
func TestQueueRegistry_UnregisteredKindIsRejectedAtInsert(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	logger, _ := newCapturingLogger(t)

	workers := river.NewWorkers()
	river.AddWorker(workers, &inert[queue.BangumiV1Args]{})

	c := startClient(t, ctx, pool, queue.Config{
		Workers: workers,
		Queues:  map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 1}},
		Logger:  logger,
	})

	_, err := c.Insert(ctx, unregisteredArgs{}, nil)
	require.Error(t, err, "river must refuse a kind it has no worker for")

	var unknown *river.UnknownJobKindError
	require.ErrorAs(t, err, &unknown)
	assert.Equal(t, unregisteredArgs{}.Kind(), unknown.Kind)
	assert.Zero(t, countJobs(t, ctx, pool, unregisteredArgs{}.Kind()),
		"a refused insert must leave no row")
}

// ---------------------------------------------------------------------------
// The accepted tradeoff
// ---------------------------------------------------------------------------

// TestQueueRegistry_OrphanRunningRowSuppressesTheNextEnqueue pins the cost the
// production state sets knowingly pay, because it is the cost somebody will
// try to remove again.
//
// A deploy kills the process without changing a row that says `running`.
// river reclaims it only through its rescuer, an hour later by default, and
// for that hour the corpse is indistinguishable from a live pass — so the next
// boot's RunOnStart insert suppresses itself against it.  Measured on prod
// 2026-09-08: both ratings sweeps sat in `running` for 59 minutes producing
// nothing, which is also exactly what a caught-up sweep looks like.
//
// Taking `running` out of the state set is the obvious fix and it is the
// change that caused the outage — see
// TestQueueRegistry_MissingRunningStateStopsEnqueueingSilently, which is the
// other half of this pair. The two together say: this window is real, and this
// is not how you close it. TODOS.md carries what would.
func TestQueueRegistry_OrphanRunningRowSuppressesTheNextEnqueue(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	logger, errs := newCapturingLogger(t)

	workers := river.NewWorkers()
	river.AddWorker(workers, &inert[healthyUniqueArgs]{})

	// Boot once so the row exists, then leave it stranded in `running` the way
	// a killed process does.
	c := startClient(t, ctx, pool, queue.Config{
		Workers:      workers,
		Queues:       map[string]river.QueueConfig{queue.RatingsQueueName: {MaxWorkers: 1}},
		PeriodicJobs: []*river.PeriodicJob{healthyPeriodicJob()},
		Logger:       logger,
	})
	require.True(t, waitForJob(t, ctx, pool, healthyUniqueArgs{}.Kind(), registryWaitTimeout))

	stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
	require.NoError(t, c.Stop(stopCtx))
	stopCancel()

	// The corpse: exactly what `docker kill` mid-pass leaves behind.  Clearing
	// finalized_at as well as setting the state is not cosmetic -- river's
	// `finalized_or_finalized_at_null` CHECK rejects a non-terminal row that
	// still carries one, so a half-written corpse would fail here rather than
	// reproduce anything.
	_, err := pool.Exec(ctx,
		`UPDATE river_job
		    SET state = 'running', attempted_at = now(), finalized_at = NULL
		  WHERE kind = $1`,
		healthyUniqueArgs{}.Kind())
	require.NoError(t, err)
	require.Equal(t, 1, countJobs(t, ctx, pool, healthyUniqueArgs{}.Kind()))

	// Second boot, as a deploy would.
	logger2, errs2 := newCapturingLogger(t)
	startClient(t, ctx, pool, queue.Config{
		// The same bundle: river's producer only ever fetches `available`
		// rows, so a registered worker cannot reach the corpse.  An empty
		// bundle is not an option -- river refuses to Start without one.
		Workers: workers,
		Queues:  map[string]river.QueueConfig{queue.RatingsQueueName: {MaxWorkers: 1}},
		PeriodicJobs: []*river.PeriodicJob{
			river.NewPeriodicJob(
				river.PeriodicInterval(time.Hour),
				func() (river.JobArgs, *river.InsertOpts) { return healthyUniqueArgs{}, nil },
				&river.PeriodicJobOpts{RunOnStart: true},
			),
		},
		Logger: logger2,
	})

	time.Sleep(4 * time.Second)

	assert.Equal(t, 1, countJobs(t, ctx, pool, healthyUniqueArgs{}.Kind()),
		"the orphaned `running` row suppresses the boot enqueue — this is the "+
			"accepted one-hour window, not a bug to fix by dropping `running`")

	// And critically: this suppression is NOT reported. That is what made the
	// window invisible on prod, and it is why the fix belongs elsewhere.
	assert.Empty(t, errs.messages())
	assert.Empty(t, errs2.messages(),
		"a suppressed enqueue is silent by design in river; nothing here can "+
			"tell it apart from a caught-up sweep")
}

// healthyPeriodicJob is the schedule used by both halves of the orphan test.
func healthyPeriodicJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(time.Hour),
		func() (river.JobArgs, *river.InsertOpts) { return healthyUniqueArgs{}, nil },
		&river.PeriodicJobOpts{RunOnStart: true},
	)
}
