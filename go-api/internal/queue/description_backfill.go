// description_backfill.go — periodic sweep that fills description_cn on the
// rows the enrichment pipeline is already done with.
//
// P2 taught the V2 / V3 workers to harvest a subject's Chinese summary out of
// the response body they were already holding, which covers every row enriched
// from that point onward.  It does nothing for the ~17k rows enriched before
// the column existed.  Those sit at bangumi_version=3, and the only existing
// re-enrichment entry point (the admin re-enqueue) selects on version 0/1/2, so
// nothing ever looks at them again.  This file is the missing entry point: a
// scan job that finds rows still missing a Chinese description, and a per-row
// worker that fetches the subject and writes that one column.
//
// # Why a dedicated worker instead of re-running V3
//
// V3 writes title_chinese UNCONDITIONALLY — that is the whole point of the
// heal-CN phase, and correct in the context V3 runs in (V2 only chains it when
// the column was left NULL).  It is not correct for a catalogue-wide sweep: a
// meaningful slice of rows got their Chinese title from the dandanplay heal,
// which is the better source for those rows, and re-running V3 across
// everything to collect summaries would overwrite those titles with Bangumi's
// name_cn and regress data we deliberately went and fixed.  So the sweep gets a
// worker that reads a subject and writes description_cn, full stop — no
// title_chinese, no bangumi_version bump, nothing that makes a row look freshly
// enriched when it was not.
//
// # Why this has to run inside the server process
//
// Bangumi's request budget is enforced by a token bucket that lives on the
// *bangumi.Client value (internal/bangumi/client.go: 800ms interval, burst 1).
// The bucket is process-local, so a standalone backfill CLI would not share it
// — it would open a second one and double our true request rate against bgm.tv
// while presenting the same AnimGo/1.0 User-Agent that any rate-limit allowlist
// upstream would be keyed on.  That is the one thing not worth gambling on for
// an optional column.  As a river job in the server, the sweep draws from the
// same bucket as live enrichment and simply divides the allowance, and gets
// retries, backoff and restart-survival for free.
//
// # Why the first backfill and the steady state are the same job
//
// There is no meaningful difference between "9,100 rows have no description
// yet" and "3 rows acquired a trusted binding last week".  Both are answered by
// the same query and want the same treatment, and a one-shot migration tool
// would have to be re-run by hand every time the second case happened.  Running
// one job forever means the backlog drains on its own and then the job quietly
// becomes a no-op that costs one indexed SELECT an hour — and the day a batch
// of rows gets rebound, it picks them up without anybody remembering it exists.
//
// # Why the sweep can finish
//
// The obvious candidate query — "description_cn IS NULL, ordered by id" —
// looks self-advancing but is not. It only retires rows that end up with a
// value, and roughly 37% of subjects carry the untranslated Japanese original,
// which CleanSummary rejects. Those rows stay NULL, stay candidates, and under
// an id ordering they hold the same place at the front of every later pass.
//
// That is a hard ceiling rather than a slow drain, and it has a closed form:
// with batch size B and per-row success rate p, pass k converts B*p^k rows, so
// lifetime writes converge to
//
//	p*B/(1-p)   rows,  EVER
//
// At B=300 and p≈0.6 that is ~450 of the ~9,100 waiting — 5%. Raising B is not
// the escape hatch it looks like either: covering the backlog would need
// B >= N*(1-p)/p ≈ 6,100, two thirds of the catalogue in one pass, 80+ minutes
// of the 800ms bucket, and no batching left to speak of.
//
// So the sweep stamps description_cn_attempted_at on every decided outcome and
// orders candidates by it (migration 0015). A rejected row goes to the back
// instead of holding the front, and the sweep reaches the whole backlog. The
// cooldown that implies is wanted, not merely tolerated: Bangumi summaries are
// community-written over time, so a subject that is Japanese-only today may
// carry Chinese prose next quarter, and the re-check is how that gets picked up.

package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// descriptionBackfillScanBatchSize is how many candidate rows one scan pass
// turns into jobs.
//
// 300 jobs is about 4 minutes of upstream budget at the client's 800ms
// interval, so a pass costs a small slice of the hour it has before the next
// one and leaves the bucket to live enrichment the rest of the time — the
// right shape for work that has no deadline and shares a rate limit with
// requests a user is waiting on.
//
// Against the ~9,100 rows waiting at first deploy, 300/hour is ~31 passes to
// walk the catalogue once, and that reading is now accurate: attempt stamping
// (migration 0015, and "Why the sweep can finish" above) retires a row whatever
// the outcome, so a pass advances a full 300 rather than only the ones that
// converted.  ~31 hours also lands well inside descriptionBackfillRetryDays, so
// the first walk finishes before any row is due for a re-check.
const descriptionBackfillScanBatchSize int32 = 300

// descriptionBackfillWorkTimeout bounds one subject fetch plus one UPDATE.
//
// Same 15s as v3WorkTimeout, for the same reason: it has to cover Bangumi's
// worst observed latency (up to an 800ms throttle wait in front of a request
// that can itself take ~8s) while still releasing the worker slot promptly when
// upstream is wedged.  This worker does strictly less per job than V3 does, so
// V3's budget is comfortably sufficient here.
const descriptionBackfillWorkTimeout = 15 * time.Second

// descriptionBackfillScanInterval is how often the sweep re-fires.  One hour
// matches PeriodicOrphanScanJob; the scan itself is a single indexed SELECT,
// so the cadence is chosen by how fast we want to spend the shared request
// budget, not by what the database can stand.  It also has to stay well above
// the ~4 minutes a full batch takes to drain, so a pass never lands on a queue
// still working the last one.
const descriptionBackfillScanInterval = time.Hour

// descriptionBackfillRetryDays is how long a decided row sits out before the
// sweep looks at it again.
//
// It serves two purposes at once. Mechanically it is what stops the sweep
// stalling: a row the language gate rejected has to leave the candidate set,
// or it holds its place at the front of every batch forever (migration 0015
// works the arithmetic). Editorially it is a re-check — Bangumi summaries are
// written by its community over time, so a subject carrying only the Japanese
// original today may have Chinese prose in a month or two.
//
// 30 days trades promptness for politeness: the backlog is ~9,100 rows against
// a 300/hour batch, so first-pass coverage completes in well under the cooldown
// and re-checks never compete with rows nobody has tried yet.
const descriptionBackfillRetryDays = 30

// descriptionBackfillRetryAfter builds the interval bound for the candidate
// query. Constructed per call because pgtype.Interval is a mutable struct and
// a shared package-level value could be scribbled on by a caller.
func descriptionBackfillRetryAfter() pgtype.Interval {
	return pgtype.Interval{Days: descriptionBackfillRetryDays, Valid: true}
}

// DescriptionBackfillReader is the sqlc subset the scan worker reads.
//
// Declared at the use-site rather than taken from dbgen.Querier, matching
// OrphanReader: a test stubs one method instead of owning the full querier
// surface.  dbgen.Queries satisfies it.
//
// The returned rows have already passed the trust gate inside the query
// (bgm_id_map cross-validation, or a 'manual' binding), so callers must NOT
// re-check binding confidence in Go — there is exactly one definition of
// trusted, and it is the one in the SQL.
type DescriptionBackfillReader interface {
	ListDescriptionCnCandidates(ctx context.Context, retryAfter pgtype.Interval, rowLimit int32) ([]dbgen.ListDescriptionCnCandidatesRow, error)
}

// DescriptionBackfillEnqueuer is the dispatch surface the scan worker needs:
// one batched insert of per-row backfill jobs.
//
// Narrow on purpose — the scan has no business reaching the V1/V2/V3 chain — so
// any Enqueuer that carries the method satisfies it without the worker having
// to depend on the whole enqueue surface.
type DescriptionBackfillEnqueuer interface {
	EnqueueDescriptionBackfillMany(ctx context.Context, jobs []DescriptionBackfillArgs) error
}

// DescriptionBackfillWriter is the single method the per-row worker writes
// through.  The trust gate lives in the UpdateDescriptionCn WHERE clause and a
// zero-row update is an expected outcome, not an error — see persistDescriptionCn
// in bangumi_v2.go, which this interface is deliberately shaped to satisfy so
// the sweep reuses that helper rather than growing a second copy of the
// clean-then-write logic.
type DescriptionBackfillWriter interface {
	UpdateDescriptionCn(ctx context.Context, descriptionCn *string, anilistID int32, bgmID *int32) error
	// MarkDescriptionCnAttempted stamps the row as tried so it leaves the
	// candidate set even when no text was stored. Without it the sweep cannot
	// get past the rows the language gate rejects — see migration 0015.
	MarkDescriptionCnAttempted(ctx context.Context, anilistID int32) error
}

// DescriptionBackfillScanWorker turns candidate rows into per-row jobs.  Embeds
// river.WorkerDefaults so only Work has to be overridden.
type DescriptionBackfillScanWorker struct {
	river.WorkerDefaults[DescriptionBackfillScanArgs]
	db  DescriptionBackfillReader
	enq DescriptionBackfillEnqueuer
}

// NewDescriptionBackfillScanWorker constructs a scan worker bound to the given
// reader and enqueuer.  Both are required; nil panics on the first job, which
// is intentional — a sweep that silently enqueues nothing looks identical to a
// finished backfill, so misconfiguration has to crash rather than no-op.  The
// panic is contained: river recovers worker panics, marks the job errored and
// retries it, so this is loud rather than fatal.
//
// This DIVERGES from NewOrphanScanWorker, which substitutes NoopEnqueuer{} for
// a nil enqueuer — and therefore from the blanket "each worker substitutes
// Noop when nil" line in WorkersWithBangumi's doc comment, which does not hold
// for this worker.  The divergence is deliberate: an orphan scan that no-ops
// is caught by the next boot's direct ScanAndEnqueueOrphans call, this one has
// no such backstop.  Construction stays safe either way so main.go can build
// the bundle before the LateBoundEnqueuer is bound.
func NewDescriptionBackfillScanWorker(db DescriptionBackfillReader, enq DescriptionBackfillEnqueuer) *DescriptionBackfillScanWorker {
	return &DescriptionBackfillScanWorker{db: db, enq: enq}
}

// Work reads one batch of candidates and enqueues a job per row.
//
// No cursor is kept: the candidate query filters on description_cn IS NULL and
// orders by anilist_id, so rows that get written drop out and the next pass
// resumes further along on its own (with the caveat in the file header about
// rows that can never be written).
//
// A read or enqueue failure is returned so river retries the scan — re-running
// it is harmless, since the query is a pure read and DescriptionBackfillArgs
// deduplicates by payload.  Finding nothing is a success: it is what the steady
// state looks like once the backlog is gone.
func (w *DescriptionBackfillScanWorker) Work(ctx context.Context, _ *river.Job[DescriptionBackfillScanArgs]) error {
	rows, err := w.db.ListDescriptionCnCandidates(ctx, descriptionBackfillRetryAfter(), descriptionBackfillScanBatchSize)
	if err != nil {
		return fmt.Errorf("description_backfill_scan list (limit=%d): %w", descriptionBackfillScanBatchSize, err)
	}
	if len(rows) == 0 {
		slog.InfoContext(ctx, "description_backfill_scan idle", "candidates", 0)
		return nil
	}

	// The query already filters bgm_id IS NOT NULL, so a nil here would mean
	// the query and this loop have drifted apart.  Skip rather than
	// dereference: one silently dropped row beats a panic that takes the
	// worker down, and the count surfaces the drift in the log line below.
	jobs := make([]DescriptionBackfillArgs, 0, len(rows))
	skippedNoBgmID := 0
	for _, row := range rows {
		if row.BgmID == nil {
			skippedNoBgmID++
			continue
		}
		jobs = append(jobs, DescriptionBackfillArgs{
			AnilistID: int(row.AnilistID),
			BgmID:     int(*row.BgmID),
		})
	}

	if len(jobs) == 0 {
		slog.WarnContext(ctx, "description_backfill_scan no usable rows",
			"candidates", len(rows),
			"skippedNoBgmId", skippedNoBgmID)
		return nil
	}

	if err := w.enq.EnqueueDescriptionBackfillMany(ctx, jobs); err != nil {
		return fmt.Errorf("description_backfill_scan enqueue (n=%d): %w", len(jobs), err)
	}

	// "submitted", not "enqueued": UniqueOpts{ByArgs} means a row already
	// queued (or completed within river's 24h retention) is skipped, so this
	// count is what we handed the enqueuer, not what was inserted.  The
	// distinction matters — during the stall described in the file header,
	// every pass submits a full batch and inserts none of it, and a line
	// reading "enqueued=300" would make a dead sweep look healthy.  The true
	// insert count is on RealEnqueuer's debug line; coverage is only ever
	// countable in the database.
	slog.InfoContext(ctx, "description_backfill_scan done",
		"candidates", len(rows),
		"submitted", len(jobs),
		"skippedNoBgmId", skippedNoBgmID)
	return nil
}

// DescriptionBackfillWorker fills description_cn for one row.  Embeds
// river.WorkerDefaults so only Work has to be overridden.
//
// bangumi reuses BangumiSubjector from bangumi_v2.go — *bangumi.Client
// satisfies it, and sharing the declaration keeps one test double good for V2,
// V3 and this worker alike.
type DescriptionBackfillWorker struct {
	river.WorkerDefaults[DescriptionBackfillArgs]
	bangumi BangumiSubjector
	db      DescriptionBackfillWriter
}

// NewDescriptionBackfillWorker constructs a worker bound to the given bangumi
// client and writer.  Both are required; nil panics on the first job, the same
// deliberate loud-failure stance NewBangumiV3Worker takes.
func NewDescriptionBackfillWorker(bangumiClient BangumiSubjector, db DescriptionBackfillWriter) *DescriptionBackfillWorker {
	return &DescriptionBackfillWorker{bangumi: bangumiClient, db: db}
}

// Work fetches the subject and hands its summary to persistDescriptionCn.
//
// This worker writes description_cn and nothing else — no title_chinese, no
// bangumi_version.  See the file header for why touching either would regress
// rows whose Chinese title came from the dandanplay heal.
//
// Outcomes:
//   - ErrNotFound — Bangumi has no subject under this id.  Return nil: the
//     binding is stale or the subject was deleted, and no number of retries
//     changes that.  Same permanent-skip stance V2 takes on a 404'd subject;
//     unlike V3 there is no version to bump on the way out, because this sweep
//     deliberately owns no enrichment state.
//   - Any other fetch error (network, 5xx, decode) — wrapped and returned so
//     river retries under its normal policy.
//   - Summary present but not usable Chinese — persistDescriptionCn logs at
//     debug and writes nothing.  Roughly four in ten rows land here; that is
//     the language gate doing its job, not a failure, and warn-level logging
//     would bury everything else in the sweep.
//   - Write failure — persistDescriptionCn warns and swallows.  Retrying the
//     job would only re-spend an upstream request on an optional column.
func (w *DescriptionBackfillWorker) Work(ctx context.Context, job *river.Job[DescriptionBackfillArgs]) error {
	anilistID := int32(job.Args.AnilistID)
	bgmID := job.Args.BgmID

	// Bound fetch + UPDATE together so a wedged upstream cannot hold a worker
	// slot indefinitely while the rest of the sweep queues up behind it.
	ctx, cancel := context.WithTimeout(ctx, descriptionBackfillWorkTimeout)
	defer cancel()

	subj, err := w.bangumi.Subject(ctx, bgmID)
	if errors.Is(err, bangumi.ErrNotFound) {
		// A decided outcome: Bangumi has no such subject, and asking again
		// tomorrow will not change that. Stamp it so the sweep stops
		// reconsidering it every pass.
		w.markAttempted(ctx, anilistID)
		slog.InfoContext(ctx, "description_backfill not_found",
			"anilistId", anilistID,
			"bgmId", bgmID)
		return nil
	}
	if err != nil {
		// Deliberately NOT stamped. A timeout or 5xx says nothing about this
		// row, and stamping would push it behind a 30-day cooldown for what is
		// really a transient upstream problem. Let river retry instead.
		return fmt.Errorf("description_backfill subject %d (bgmId=%d): %w", anilistID, bgmID, err)
	}

	sent := persistDescriptionCn(ctx, w.db, "description_backfill", subj, anilistID, bgmID)

	// Stamp on both outcomes. Storing text removes the row from the candidate
	// set on its own (description_cn stops being NULL), but a rejected summary
	// does not — and that residue is exactly what stalls the sweep if it keeps
	// its place in the queue. See migration 0015 for the arithmetic.
	w.markAttempted(ctx, anilistID)

	// Debug, not info: the sweep runs a few thousand of these and the useful
	// operator signal is the per-batch line from the scan worker plus the
	// actual column count in the database — persistDescriptionCn's own doc is
	// explicit that coverage must be measured with SQL, never counted from log
	// lines, because the trust gate in the UPDATE can still match zero rows.
	slog.DebugContext(ctx, "description_backfill done",
		"anilistId", anilistID,
		"bgmId", bgmID,
		"descriptionCnSent", sent)
	return nil
}

// PeriodicDescriptionBackfillScanJob returns the river PeriodicJob that fires
// the sweep every hour.  Pass it to queue.Config.PeriodicJobs alongside
// PeriodicOrphanScanJob and PeriodicWarmSeasonJob.
//
// InsertOpts is nil in the tuple: DescriptionBackfillScanArgs.InsertOpts()
// already pins the job to DescriptionBackfillQueueName, and that is all this
// job needs.  Note that river's periodic enqueuer does NOT check for an
// existing pending or running instance before inserting — it inserts every
// time the schedule elapses, full stop — so if the backfill queue ever wedges,
// scan jobs will stack up behind it.  That is tolerated rather than fixed: a
// stacked scan is one indexed SELECT whose rows are then deduplicated by
// UniqueOpts{ByArgs} on the per-row jobs, and it matches what
// PeriodicOrphanScanJob and PeriodicWarmSeasonJob already do.
//
// Do NOT "fix" it by adding UniqueOpts here without setting ByState
// explicitly: river's default unique states include `completed`, and completed
// jobs stay in river_job for 24h, so a naive UniqueOpts would block the hourly
// cadence for a full day after every successful scan.
//
// RunOnStart is TRUE, which is where this departs from PeriodicOrphanScanJob.
// That job can leave it false because main.go calls ScanAndEnqueueOrphans
// directly at boot, so every restart still produces one immediate scan; this
// job has no such companion call.  River schedules a periodic job's first run a
// full interval after Start, so with RunOnStart=false every deploy would push
// the next sweep an hour out — and on a day with several deploys the backfill
// could make no progress at all, which is exactly the failure mode that left
// ~1,052 orphan rows stranded before the orphan periodic job existed.  Firing
// on start also means a release can be verified immediately instead of an hour
// later.  The cost is one extra batch per boot, and UniqueOpts{ByArgs} on
// DescriptionBackfillArgs collapses it against anything still queued.
func PeriodicDescriptionBackfillScanJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(descriptionBackfillScanInterval),
		func() (river.JobArgs, *river.InsertOpts) {
			return DescriptionBackfillScanArgs{}, nil
		},
		&river.PeriodicJobOpts{RunOnStart: true},
	)
}

// Compile-time guards: both workers must satisfy river.Worker for their args.
var (
	_ river.Worker[DescriptionBackfillScanArgs] = (*DescriptionBackfillScanWorker)(nil)
	_ river.Worker[DescriptionBackfillArgs]     = (*DescriptionBackfillWorker)(nil)
)

// markAttempted records that this row has been considered, so the sweep can
// move past it. Failures are logged rather than returned: the stamp is
// bookkeeping, and failing the job over it would re-spend an upstream request
// on a row already handled. A row that misses its stamp simply gets picked up
// again on a later pass, which is the safe direction to fail in.
func (w *DescriptionBackfillWorker) markAttempted(ctx context.Context, anilistID int32) {
	if err := w.db.MarkDescriptionCnAttempted(ctx, anilistID); err != nil {
		slog.WarnContext(ctx, "description_backfill attempt stamp failed",
			"anilistId", anilistID,
			"err", err)
	}
}
