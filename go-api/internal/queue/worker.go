// worker.go — river client boot + stub workers.
//
// One remaining stub worker (V3) logs + returns nil.  V1 + V2 have
// real implementations in bangumi_v1.go / bangumi_v2.go; callers
// wanting the production wiring should call WorkersWithBangumi
// instead of Workers().  Keeping the V2+V3 stubs available via
// Workers() lets the integration test prove the dispatch loop
// (insert → fetch → run → complete) is wired correctly without
// dragging a Bangumi HTTP client into the smoke suite.
//
// Pattern decision:  Boot returns a non-started client so callers can
// (a) test InsertTx without a running fetcher, or (b) gate Start on
// a feature flag.  Callers MUST defer client.Stop(ctx) and must call
// client.Start(ctx) when ready to process jobs.
package queue

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

// ErrMissingPool signals Boot was called with a nil *pgxpool.Pool.
// river itself would surface this as "missing database driver" once the
// client tried to fetch, but we want the failure at construction time so
// misconfiguration is caught by the server's own healthcheck instead of
// the river log.
var ErrMissingPool = errors.New("queue.Boot: pool is required")

// stubBangumiV2Worker — phase-2 placeholder used ONLY by Workers()
// (the stub-only bundle).  The real BangumiV2Worker lives in
// bangumi_v2.go and is wired by WorkersWithBangumi.  This stub
// remains so the integration smoke test can exercise the dispatch
// loop without dragging in a Bangumi HTTP fake.
type stubBangumiV2Worker struct {
	river.WorkerDefaults[BangumiV2Args]
}

// Work logs the v2 anilistId+bgmId pair and returns nil.
func (w *stubBangumiV2Worker) Work(ctx context.Context, job *river.Job[BangumiV2Args]) error {
	slog.InfoContext(ctx, "queue: bangumi_v2 stub",
		"anilistId", job.Args.AnilistID,
		"bgmId", job.Args.BgmID,
	)
	return nil
}

// stubBangumiV3Worker — phase-3 placeholder (heal-CN).
type stubBangumiV3Worker struct {
	river.WorkerDefaults[BangumiV3Args]
}

// Work logs the v3 heal-CN attempt and returns nil.
func (w *stubBangumiV3Worker) Work(ctx context.Context, job *river.Job[BangumiV3Args]) error {
	slog.InfoContext(ctx, "queue: bangumi_v3 stub",
		"anilistId", job.Args.AnilistID,
		"bgmId", job.Args.BgmID,
	)
	return nil
}

// Workers returns a *river.Workers bundle with the 2 stub workers
// (V2 + V3) registered.  V1 has a real implementation — production
// callers should use WorkersWithBangumi instead.  This bundle is kept
// for the dispatch-loop integration smoke and any future test that
// wants to exercise river plumbing without injecting a bangumi mock.
//
// Returning a new bundle on every call (rather than caching) keeps
// tests independent and lets callers register additional workers
// before passing the bundle into Boot.
func Workers() *river.Workers {
	w := river.NewWorkers()
	river.AddWorker(w, &stubBangumiV2Worker{})
	river.AddWorker(w, &stubBangumiV3Worker{})
	return w
}

// BangumiV12Client merges the small interfaces V1 + V2 workers
// consume from the bangumi package.  *bangumi.Client satisfies all
// three method sets (Search + Subject + Characters), so production
// main.go passes a single *bangumi.Client through WorkersWithBangumi.
type BangumiV12Client interface {
	BangumiSearcher
	BangumiV2Client
}

// V12DB merges the sqlc subsets V1 + V2 workers need.  dbgen.Querier
// satisfies it; tests can supply a single fake that covers both
// surfaces without having to split.
type V12DB interface {
	V1DB
	V2DB
}

// WorkersWithBangumi returns a *river.Workers bundle with the REAL
// BangumiV1Worker + BangumiV2Worker (using the provided bangumi
// client + DB + enqueuer) plus the V3 stub that hasn't been replaced
// yet (P2.1.8 will swap V3).
//
// enq is consumed by V1Worker so it can chain V2 enqueue after a
// successful Bangumi hit.  Pass NoopEnqueuer{} (or nil — V1Worker
// substitutes Noop when nil) in tests that don't want the V2 chain.
//
// Production main.go wires the live bangumi.Client + dbgen.Queries +
// real RealEnqueuer through this constructor.  Tests for the
// dispatch loop alone still use Workers() (V2/V3 stubs only) to
// avoid pulling in a bangumi mock.
func WorkersWithBangumi(bangumiClient BangumiV12Client, db V12DB, enq Enqueuer) *river.Workers {
	w := river.NewWorkers()
	river.AddWorker(w, NewBangumiV1Worker(bangumiClient, db, enq))
	river.AddWorker(w, NewBangumiV2Worker(bangumiClient, db))
	river.AddWorker(w, &stubBangumiV3Worker{})
	return w
}

// Config controls river client tuning.  Anything nil falls back to a
// sensible default (see Boot).  Exposing the *river.Workers directly
// (rather than wrapping it in another constructor func) lets the
// enrichment package re-register workers without learning a new API.
type Config struct {
	// Workers — if nil, Boot calls Workers() to register the V2+V3
	// stubs (V1 has a real worker; use WorkersWithBangumi for prod).
	Workers *river.Workers

	// Queues — if nil, Boot defaults to {river.QueueDefault: {MaxWorkers: 1}}.
	Queues map[string]river.QueueConfig

	// Logger — if nil, Boot uses slog.Default().
	Logger *slog.Logger
}

// Boot constructs a *river.Client[pgx.Tx] attached to pool.  The client
// is NOT started — callers own the lifecycle:
//
//	c, err := queue.Boot(pool, queue.Config{})
//	if err != nil { return err }
//	if err := c.Start(ctx); err != nil { return err }
//	defer c.Stop(ctx)
//
// Returns ErrMissingPool if pool is nil.  Returns a wrapped error if
// river.NewClient rejects the config (e.g. queue name validation).
func Boot(pool *pgxpool.Pool, c Config) (*river.Client[pgx.Tx], error) {
	if pool == nil {
		return nil, ErrMissingPool
	}

	workers := c.Workers
	if workers == nil {
		workers = Workers()
	}

	queues := c.Queues
	if queues == nil {
		queues = map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 1},
		}
	}

	logger := c.Logger
	if logger == nil {
		logger = slog.Default()
	}

	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Queues:  queues,
		Workers: workers,
		Logger:  logger,
	})
	if err != nil {
		return nil, err
	}
	return client, nil
}
