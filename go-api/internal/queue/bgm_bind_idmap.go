// bgm_bind_idmap.go — periodic sweep that binds the vendored AniList→Bangumi
// id map onto rows that carry no bgm_id.
//
// # The gap this fills
//
// The V1 worker already consults this map first and trusts it without a search
// (bangumi_v1.go step 0), so for a row entering the pipeline the map's answer
// is applied automatically.  What has no entry point is a row that was ALREADY
// past V1 when the map gained its entry: UpdateBangumiV1 is guarded on
// `bangumi_version = 0`, and the rows this sweep is for sit at version 3, the
// bulk state migration 0004 records for everything enriched under the pre-Go
// pipeline.  Nothing looks at a version-3 row again, so a correct answer sat
// unreachable in a table we already trust.
//
// That shape — an enrichment producer that runs at most once per anime, and a
// source of truth that improves afterwards — is the same one that stranded
// episode titles (see episode_titles_releasing.go) and Chinese descriptions
// (description_backfill.go).  It is tracked in TODOS.md as the version
// ratchet; this file is the third patch over it rather than a fix for it.
//
// # Why the map is trusted with no second signal
//
// Measured on production before this sweep was written: of the bound rows that
// also have a map entry, 3,769 were bound by the pre-Go pipeline with no
// bgm_match_source recorded — an entirely separate process — and the map
// agrees with all 3,769.  Zero disagreements against an independent producer
// is the evidence.  V1 trusting the same table unconditionally is the
// precedent.  The refusals that DO matter are structural rather than
// evidential, and live in the query: a subject another row already holds, and
// a subject two unbound rows both claim.
//
// # Why the bind and the enqueue share a transaction
//
// A binding with no enrichment behind it is worse than no binding: the row
// gains a bgm_id, which removes it from this sweep's candidate set forever,
// and nothing else will ever fetch its Chinese title or score.  So the V2
// dispatch goes through EnqueueV2ManyTx on the same transaction as the bind.
// Either the row is bound and queued, or it is neither and stays a candidate.
//
// # Why there is no attempt bookkeeping
//
// Migrations 0015 and 0023 both had to add attempt/outcome columns because
// their sweeps decided candidacy on "the value is still missing", so a row
// that could never produce a value held the front of every batch forever.
// Neither ingredient is present here.  A bound row stops matching
// `bgm_id IS NULL`, and a row the query refuses is excluded before the LIMIT
// applies — so refusals never consume a batch slot, and once the bindable set
// is drained every subsequent run is one cheap query that returns nothing.
package queue

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

const (
	// BindIdMapQueueName is the sweep's own river queue.  A dedicated queue
	// is what lets river's runtime pause apply to this alone — the same
	// mechanism the admin surface uses to freeze heal-CN — and a pause needs
	// no deploy, unlike the env flag below.
	//
	// It also carries a correctness role: BindBgmIdsFromIdMap's "no bound row
	// holds this subject" check and its UPDATE are one statement, but two
	// concurrent statements could still each pass it for the same subject.
	// Registering this queue at MaxWorkers 1 makes that unreachable.
	BindIdMapQueueName = "bgm_bind_idmap"

	// bindIdMapEnabledEnv gates the sweep at WORK time, not at registration.
	// Gating registration would leave already-enqueued jobs to run anyway, so
	// the flag would not describe the running system.
	bindIdMapEnabledEnv = "BGM_BIND_IDMAP_SWEEP_ENABLED"

	// bindIdMapInterval is how often the sweep fires.  The work is one SQL
	// statement plus an insert; the cost that matters is downstream, where
	// each bound row becomes a V2 job against Bangumi's 800ms bucket.
	bindIdMapInterval = 6 * time.Hour

	// bindIdMapBatch caps one pass.  At 800ms per Bangumi call a full batch
	// is ~3 minutes of V2 work, which shares the bucket with user-facing
	// traffic, so the batch is sized to be absorbed rather than noticed.
	bindIdMapBatch = 200

	// bindIdMapTimeout bounds the transaction.  Generous for two statements;
	// it exists so a stuck pass cannot hold the queue's single slot open.
	bindIdMapTimeout = 2 * time.Minute
)

// BindIdMapArgs is the river job payload.  The sweep takes no parameters:
// the candidate set is entirely a function of the two tables.
type BindIdMapArgs struct{}

// Kind implements river.JobArgs.
func (BindIdMapArgs) Kind() string { return "bgm_bind_idmap" }

// InsertOpts pins the job to the sweep's own queue.
func (BindIdMapArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: BindIdMapQueueName}
}

// bindIdMapV2Enqueuer is the single method the sweep needs from the enqueuer,
// declared at the use site so a test can supply a stub without standing up a
// river client.  *LateBoundEnqueuer (production) and *RealEnqueuer satisfy it.
//
// It is deliberately NOT part of the shared Enqueuer interface: no other
// caller wants a transactional enqueue, and widening that interface would
// force a method onto every existing implementation and test double for the
// benefit of one worker.
type bindIdMapV2Enqueuer interface {
	EnqueueV2ManyTx(ctx context.Context, tx pgx.Tx, jobs []BangumiV2Args) error
}

// BindIdMapWorker binds map answers onto unbound rows and dispatches their
// enrichment.
type BindIdMapWorker struct {
	river.WorkerDefaults[BindIdMapArgs]
	pool *pgxpool.Pool
	q    *dbgen.Queries
	enq  bindIdMapV2Enqueuer
}

// NewBindIdMapWorker constructs the sweep worker.
func NewBindIdMapWorker(pool *pgxpool.Pool, q *dbgen.Queries, enq bindIdMapV2Enqueuer) *BindIdMapWorker {
	return &BindIdMapWorker{pool: pool, q: q, enq: enq}
}

// Work runs one pass.
//
// Returning an error hands the job to river's retry policy, whose default is
// 25 attempts with attempt⁴ backoff — roughly 20 days for the last one.  That
// is the wrong shape for a periodic sweep, which gets a fresh job every
// interval anyway, so a failed pass logs and returns nil: the next fire is a
// better retry than river's.
func (w *BindIdMapWorker) Work(ctx context.Context, job *river.Job[BindIdMapArgs]) error {
	if !bindIdMapSweepEnabled() {
		slog.DebugContext(ctx, "bgm_bind_idmap sweep disabled", "env", bindIdMapEnabledEnv)
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, bindIdMapTimeout)
	defer cancel()

	bound, err := w.bindBatch(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "bgm_bind_idmap sweep failed", "err", err)
		return nil
	}
	if len(bound) == 0 {
		slog.DebugContext(ctx, "bgm_bind_idmap sweep: nothing bindable")
		return nil
	}
	slog.InfoContext(ctx, "bgm_bind_idmap sweep done",
		"bound", len(bound), "batch", bindIdMapBatch)
	return nil
}

// bindBatch is the transactional unit: bind up to one batch, and enqueue the
// V2 follow-up for exactly the rows that were bound.  A failure at either step
// rolls back both, leaving every row a candidate for the next pass.
func (w *BindIdMapWorker) bindBatch(ctx context.Context) ([]dbgen.BindBgmIdsFromIdMapRow, error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	bound, err := w.q.WithTx(tx).BindBgmIdsFromIdMap(ctx, bindIdMapBatch)
	if err != nil {
		return nil, fmt.Errorf("bind: %w", err)
	}
	if len(bound) == 0 {
		return nil, nil
	}

	jobs := make([]BangumiV2Args, len(bound))
	for i, b := range bound {
		jobs[i] = BangumiV2Args{AnilistID: int(b.AnilistID), BgmID: int(b.BgmID)}
	}
	if err := w.enq.EnqueueV2ManyTx(ctx, tx, jobs); err != nil {
		return nil, fmt.Errorf("enqueue v2 (n=%d): %w", len(jobs), err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return bound, nil
}

// bindIdMapSweepEnabled reads the kill switch.  Anything unparseable is OFF:
// a typo in a variable that gates writes against production should fail closed.
func bindIdMapSweepEnabled() bool {
	v := os.Getenv(bindIdMapEnabledEnv)
	if v == "" {
		return false
	}
	on, err := strconv.ParseBool(v)
	return err == nil && on
}

// PeriodicBindIdMapJob returns the river PeriodicJob for the sweep.
//
// RunOnStart is true because river's open-source pilot does not persist
// periodic schedules — nextRunAt is recomputed at every Start — so a service
// that deploys more often than the interval would otherwise never sweep.
// Firing on boot is safe here for the same reason the sweep needs no attempt
// bookkeeping: a pass that has nothing left to bind is one query returning
// zero rows.
func PeriodicBindIdMapJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(bindIdMapInterval),
		func() (river.JobArgs, *river.InsertOpts) {
			return BindIdMapArgs{}, nil
		},
		&river.PeriodicJobOpts{RunOnStart: true},
	)
}

// AddBindIdMapWorker registers the sweep on an existing bundle.
func AddBindIdMapWorker(w *river.Workers, pool *pgxpool.Pool, q *dbgen.Queries, enq bindIdMapV2Enqueuer) {
	river.AddWorker(w, NewBindIdMapWorker(pool, q, enq))
}

// Compile-time guards: the worker must satisfy river.Worker for its args, and
// the production enqueuers must satisfy the narrow use-site interface.
var (
	_ river.Worker[BindIdMapArgs] = (*BindIdMapWorker)(nil)
	_ bindIdMapV2Enqueuer         = (*LateBoundEnqueuer)(nil)
	_ bindIdMapV2Enqueuer         = (*RealEnqueuer)(nil)
)
