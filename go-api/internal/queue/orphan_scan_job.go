// orphan_scan_job.go — Periodic River job that re-runs ScanAndEnqueueOrphans.
//
// ScanAndEnqueueOrphans (orphan.go) is called once at boot to catch
// bangumi_version=0 rows that accumulated during a previous worker
// outage.  Two problems remain:
//
//  1. ~1052 legacy v0 rows on prod never drain unless go-api restarts.
//  2. The enrichment backfill tool resets wrong rows to version=0;
//     without a periodic sweep they won't re-enrich until a manual
//     restart.
//
// This file adds a River periodic job that fires every 1 hour and
// re-runs ScanAndEnqueueOrphans so the backlog drains on its own.
// The boot-time call in main.go is kept (additive); this job is the
// steady-state complement.
//
// Pattern mirrors warm_season.go exactly:
//   - OrphanScanArgs — river.JobArgs, Kind "orphan_scan".
//   - OrphanScanWorker — embeds river.WorkerDefaults[OrphanScanArgs],
//     holds OrphanReader + Enqueuer deps.
//   - NewOrphanScanWorker — constructor, nil enq → NoopEnqueuer{}.
//   - PeriodicOrphanScanJob — 1h fixed interval via river.PeriodicInterval,
//     InsertOpts nil (matches warm-season's no-uniqueness approach).

package queue

import (
	"context"
	"log/slog"
	"time"

	"github.com/riverqueue/river"
)

// orphanScanPeriodicInterval is the cadence river uses to re-fire the
// orphan scan worker.  1 hour catches backlog rows that accumulate
// between boots without hammering the DB (a full scan on 1k rows takes
// <1ms in typical Postgres).
const orphanScanPeriodicInterval = time.Hour

// OrphanScanArgs is the river job payload for the periodic orphan scan.
// No fields are needed — ScanAndEnqueueOrphans reads from the DB
// directly; the job is a pure trigger.
type OrphanScanArgs struct{}

// Kind returns the river job kind for the orphan scan worker.  River
// uses this string to look up the registered worker in the bundle.
func (OrphanScanArgs) Kind() string { return "orphan_scan" }

// Compile-time guard: OrphanScanArgs must satisfy river.JobArgs.
var _ river.JobArgs = (*OrphanScanArgs)(nil)

// OrphanScanWorker implements river.Worker[OrphanScanArgs].  Embeds
// river.WorkerDefaults to inherit the retry / timeout / middleware
// defaults so only Work() needs overriding.
//
// db is the OrphanReader that scans bangumi_version=0 rows.
// enq is the Enqueuer that dispatches V1 jobs for each batch.
// Both are injected at construction time; nil enq is replaced with
// NoopEnqueuer{} (same pattern as WarmSeasonWorker).
type OrphanScanWorker struct {
	river.WorkerDefaults[OrphanScanArgs]
	db  OrphanReader
	enq Enqueuer
}

// NewOrphanScanWorker constructs a worker bound to the given
// OrphanReader and Enqueuer.  db is required; nil db will panic on the
// first ScanAndEnqueueOrphans call (intentional — misconfiguration
// should crash loudly).  Nil enq is replaced with NoopEnqueuer{} so
// the worker is a safe no-op when river isn't wired yet.
func NewOrphanScanWorker(db OrphanReader, enq Enqueuer) *OrphanScanWorker {
	if enq == nil {
		enq = NoopEnqueuer{}
	}
	return &OrphanScanWorker{db: db, enq: enq}
}

// Work is the river dispatch entrypoint.  Calls ScanAndEnqueueOrphans
// and logs the count of enqueued V1 jobs.  Errors from
// ScanAndEnqueueOrphans are returned wrapped so river retries; a
// zero-count scan (no orphans) is a successful no-op.
func (w *OrphanScanWorker) Work(ctx context.Context, _ *river.Job[OrphanScanArgs]) error {
	total, err := ScanAndEnqueueOrphans(ctx, w.db, w.enq)
	if err != nil {
		slog.WarnContext(ctx, "orphan_scan failed", "err", err, "enqueued_before_failure", total)
		return err
	}
	slog.InfoContext(ctx, "orphan_scan done", "enqueued", total)
	return nil
}

// PeriodicOrphanScanJob returns a river PeriodicJob that fires every
// 1 hour to re-enqueue V1 jobs for any bangumi_version=0 rows.  Pass
// the result to queue.Config.PeriodicJobs alongside PeriodicWarmSeasonJob.
//
// InsertOpts is nil (same as PeriodicWarmSeasonJob) — river's periodic
// scheduler inserts only when no pending/running instance of the same
// kind exists, which is sufficient deduplication for a 1-hour sweep.
//
// The boot-time ScanAndEnqueueOrphans call in main.go is NOT replaced
// by this; the two are additive.
func PeriodicOrphanScanJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(orphanScanPeriodicInterval),
		func() (river.JobArgs, *river.InsertOpts) {
			return OrphanScanArgs{}, nil
		},
		nil, // PeriodicJobOpts — defaults are fine; RunOnStart=false
		// because main.go handles the boot scan via ScanAndEnqueueOrphans.
	)
}
