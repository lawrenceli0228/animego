// worker.go — river client boot + stub workers.
//
// The 3 stub workers below log + return nil.  Real enrichment logic
// lands in P2.1.2 (the bangumi package) by re-registering replacement
// workers before Boot.  Keeping stubs here lets the integration test
// prove the dispatch loop (insert → fetch → run → complete) is wired
// correctly before any phase logic exists.
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

// stubBangumiV1Worker is the placeholder phase-1 worker.  It implements
// river.Worker[BangumiV1Args] by embedding river.WorkerDefaults — that
// embed wires up the retry/timeout/middleware defaults so we only have
// to override Work.
type stubBangumiV1Worker struct {
	river.WorkerDefaults[BangumiV1Args]
}

// Work is the V1 stub.  Logs at info level and returns nil so river
// marks the job completed.  Real implementation will call the Bangumi
// search API; see P2.1.2.
func (w *stubBangumiV1Worker) Work(ctx context.Context, job *river.Job[BangumiV1Args]) error {
	slog.InfoContext(ctx, "queue: bangumi_v1 stub", "anilistId", job.Args.AnilistID)
	return nil
}

// stubBangumiV2Worker — phase-2 placeholder.
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

// Workers returns a *river.Workers bundle with the 3 stub workers
// registered.  P2.1.2 enrichment code will call river.AddWorker with
// concrete implementations on a fresh bundle from river.NewWorkers().
//
// Returning a new bundle on every call (rather than caching) keeps
// tests independent and lets callers register additional workers
// before passing the bundle into Boot.
func Workers() *river.Workers {
	w := river.NewWorkers()
	river.AddWorker(w, &stubBangumiV1Worker{})
	river.AddWorker(w, &stubBangumiV2Worker{})
	river.AddWorker(w, &stubBangumiV3Worker{})
	return w
}

// Config controls river client tuning.  Anything nil falls back to a
// sensible default (see Boot).  Exposing the *river.Workers directly
// (rather than wrapping it in another constructor func) lets the
// enrichment package re-register workers without learning a new API.
type Config struct {
	// Workers — if nil, Boot calls Workers() to register the 3 stubs.
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
