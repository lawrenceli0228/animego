// worker.go — river client boot + stub workers.
//
// All three production workers (V1, V2, V3) now have real
// implementations in bangumi_v1.go / bangumi_v2.go / bangumi_v3.go.
// Callers wanting the production wiring should call
// WorkersWithBangumi instead of Workers().  Workers() now registers
// only the V2 stub — kept around so the integration smoke test can
// exercise the dispatch loop (insert → fetch → run → complete)
// without dragging a Bangumi HTTP client into the smoke suite.  V3
// has no stub anymore because the smoke suite swapped to using
// WorkersWithBangumi with a NotFound-returning bangumi double, which
// drives the real V3 worker down its terminal "bump version=3"
// branch.
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
// remains so the integration smoke test (and any future test that
// only needs the dispatch loop) can exercise river plumbing without
// dragging in a Bangumi HTTP fake.
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

// Workers returns a *river.Workers bundle with only the V2 stub
// worker registered.  V1 + V3 have real implementations — production
// callers should use WorkersWithBangumi instead.  This bundle is
// kept for backward compatibility and for any future test that wants
// to exercise river plumbing without injecting a bangumi mock; V3
// stub was removed when the real V3 worker landed (smoke tests now
// drive the real V3 worker via WorkersWithBangumi + a NotFound bangumi
// double instead).
//
// Returning a new bundle on every call (rather than caching) keeps
// tests independent and lets callers register additional workers
// before passing the bundle into Boot.
func Workers() *river.Workers {
	w := river.NewWorkers()
	river.AddWorker(w, &stubBangumiV2Worker{})
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

// V12DB merges the sqlc subsets V1 + V2 + V3 workers need.
// dbgen.Querier satisfies it; tests can supply a single fake that
// covers all three surfaces without having to split.  The name keeps
// "V12" for historical reasons even though V3 is now a member —
// "V123DB" is uglier and this is an internal type whose surface
// doesn't leak into the API.
type V12DB interface {
	V1DB
	V2DB
	V3DB
}

// WorkersWithBangumi returns a *river.Workers bundle with all three
// REAL bangumi workers (V1 + V2 + V3) wired against the provided
// bangumi client + DB + enqueuer.  Production main.go calls this
// with the live *bangumi.Client + *dbgen.Queries + a *RealEnqueuer
// (or *LateBoundEnqueuer that gets Bound after Boot).
//
// enq is consumed by V1Worker (chains V2 after a Bangumi search hit)
// AND by V2Worker (chains V3 after a V2 update with no Chinese title).
// Pass NoopEnqueuer{} (or nil — each worker substitutes Noop when
// nil) in tests that don't want the V1→V2 or V2→V3 chains.  V3 is
// terminal — does not consume the enqueuer.
//
// Tests that only need the dispatch loop (without injecting a
// bangumi mock) can still use Workers() — that bundle now contains
// only the V2 stub since V1 + V3 have real implementations.
func WorkersWithBangumi(bangumiClient BangumiV12Client, db V12DB, enq Enqueuer) *river.Workers {
	w := river.NewWorkers()
	river.AddWorker(w, NewBangumiV1Worker(bangumiClient, db, enq))
	river.AddWorker(w, NewBangumiV2Worker(bangumiClient, db, enq))
	river.AddWorker(w, NewBangumiV3Worker(bangumiClient, db))
	return w
}

// Config controls river client tuning.  Anything nil falls back to a
// sensible default (see Boot).  Exposing the *river.Workers directly
// (rather than wrapping it in another constructor func) lets the
// enrichment package re-register workers without learning a new API.
type Config struct {
	// Workers — if nil, Boot calls Workers() to register the V2 stub
	// only (V1 + V3 have real workers; use WorkersWithBangumi for
	// the full production wiring).
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
