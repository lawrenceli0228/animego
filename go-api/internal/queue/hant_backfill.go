// hant_backfill.go — the server-side half of the zh-Hant backfill.
//
// # What it does
//
// One job re-runs the precedence ladder in internal/hant over every row
// of anime_cache and writes back the rows whose resolved (value, source,
// hash) triple differs from what is stored.  It is the same operation as
// `hantbackfill --apply`, minus the flags and the pre-apply backup file,
// and it shares the ladder rather than reimplementing it.
//
// # Why it exists
//
// title_hant's bottom tier is a conversion of title_chinese, and
// description_hant is entirely a conversion of description_cn.  Both
// source columns keep growing -- the Bangumi sweep and the LLM fallback
// fill description_cn for rows that had none, V1/V3 rewrite
// title_chinese -- and nothing converts the new arrivals.  So the
// Traditional columns fall behind from the day the CLI last ran, and the
// only repair was a human with SSH access.  Measured on production the
// drift is small mid-season (~2 rows in five hours) and lumpy at a season
// rollover, when a whole cohort of new anime lands at once.
//
// # Why no backup file
//
// The CLI writes backup-<ts>.json before its first UPDATE because
// --apply is a deliberate act against production by a person who may have
// got the arguments wrong.  This worker is a different risk: it takes no
// input, runs the same ladder over the same vendored files every time, and
// writes only where the stored triple disagrees with what the ladder
// derives -- so its output is a pure function of (datasets, table) and is
// re-derivable by running it again.  Rows at source='manual' are excluded
// here and again in the UPDATE's WHERE clause, so the one thing that is
// NOT re-derivable is the one thing it cannot touch.  A JSON file written
// into the server container would land on an ephemeral filesystem with no
// volume behind it, which is worse than no backup: it looks like one.
//
// # Why the whole table and not a candidate query
//
// Same reason ListAnimeForHantBackfill has no WHERE clause.  A row can be
// behind in three different ways -- the column is NULL, the column holds a
// value derived from an input that has since changed, or the column holds
// a machine conversion that a dataset can now beat -- and only the last
// two need the digest recomputed to detect.  There is no predicate that
// finds them, so the sweep reads everything.  That is affordable at 90-day
// cadence and would not be hourly.

package queue

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/riverqueue/river"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/hant"
)

// hantBackfillInterval is how often the sweep re-fires on its own.
//
// 90 days is chosen against what the job costs rather than against how
// fast drift accumulates: a pass reads every row in anime_cache including
// description_cn and runs s2twp over ~16k synopses, which is minutes of
// CPU and a table-sized read.  Drift is ~2 rows in five hours mid-season,
// so a quarterly pass leaves a few hundred rows waiting at worst -- and
// the admin button exists precisely so nobody has to wait out the quarter
// after a season rollover dumps a cohort in at once.
const hantBackfillInterval = 90 * 24 * time.Hour

// hantBackfillWorkTimeout bounds one whole pass.
//
// An order of magnitude above the measured cost (the CLI's whole-table
// --apply against production is well under a minute) because the point is
// not to be tight, it is to stop a wedged pool holding the queue's only
// worker slot until the process restarts.  River retries the job, and a
// retried whole-table sweep is idempotent.
const hantBackfillWorkTimeout = 30 * time.Minute

// HantBackfillReader is the whole-table read the sweep does.  Declared at
// the use site so a test can stub one method rather than owning the full
// querier surface; dbgen.Queries satisfies it.
type HantBackfillReader interface {
	ListAnimeForHantBackfill(ctx context.Context) ([]dbgen.ListAnimeForHantBackfillRow, error)
}

// HantBackfillDB is everything the sweep touches: the read, plus the two
// batch statements hant.ApplyTitles / hant.ApplyDescriptions write
// through.
type HantBackfillDB interface {
	HantBackfillReader
	hant.Writer
}

// HantBackfillWorker runs one whole-table pass of the zh-Hant ladder.
// Embeds river.WorkerDefaults so only Work has to be overridden.
type HantBackfillWorker struct {
	river.WorkerDefaults[HantBackfillArgs]
	db      HantBackfillDB
	dataDir string
}

// NewHantBackfillWorker constructs the sweep bound to the given DB and
// dataset directory.
//
// The datasets are NOT loaded here.  Loading is ~1.7 MB of JSON plus a
// 53,579-entry conversion table, and holding that resident for the 90
// days between passes to save a few seconds once a quarter is a bad
// trade.  It also means a dataset fixed on disk takes effect on the next
// job rather than on the next deploy.
//
// dataDir empty falls back to hant.DataDirFromEnv(), so a caller that has
// no opinion still gets the env var and its default rather than the
// process's working directory.
func NewHantBackfillWorker(db HantBackfillDB, dataDir string) *HantBackfillWorker {
	if dataDir == "" {
		dataDir = hant.DataDirFromEnv()
	}
	return &HantBackfillWorker{db: db, dataDir: dataDir}
}

// Work loads the datasets, classifies every row, and writes the
// disagreements.
//
// Errors are returned rather than swallowed, so river retries: every
// failure mode here (datasets unreadable, pool exhausted, a statement
// deadlocking) is either transient or a deploy problem an operator has to
// see, and re-running the pass is harmless because the writes are
// idempotent.
//
// A pass that writes nothing is the expected steady state, not a
// failure — it means the Traditional columns are level with their
// sources.
func (w *HantBackfillWorker) Work(ctx context.Context, _ *river.Job[HantBackfillArgs]) error {
	// Bound the whole pass, not each statement: a partial pass is a whole
	// number of 500-row batches (see hant.ApplyTitles), and the next run
	// picks up whatever this one did not reach.
	ctx, cancel := context.WithTimeout(ctx, hantBackfillWorkTimeout)
	defer cancel()

	start := time.Now()

	res, err := hant.NewResolverFromDir(w.dataDir)
	if err != nil {
		return fmt.Errorf("hant_backfill load datasets (%s): %w", w.dataDir, err)
	}
	stats := res.LoadStats()
	// Logged every pass because a truncated dataset file still parses: a
	// JSON array with 40 records instead of 8,492 is valid JSON, and the
	// pass that consumes it demotes thousands of rows from the anilist
	// tier to opencc — a mass rewrite of the one column that must not
	// carry machine conversions into search results.  These four numbers
	// are the only place that is visible before the writes happen.
	slog.InfoContext(ctx, "hant_backfill datasets loaded",
		"dir", w.dataDir,
		"anilistRecords", stats.AnilistRecords,
		"cgroupKeys", stats.CgroupKeys,
		"cgroupKeysDroppedAmbiguous", stats.CgroupDropped,
		"simplifiedRunes", stats.SimplifiedRunes)

	dbRows, err := w.db.ListAnimeForHantBackfill(ctx)
	if err != nil {
		return fmt.Errorf("hant_backfill list rows: %w", err)
	}

	// limit 0: the sweep always takes the whole table.  --limit is a
	// smoke-run affordance for an operator at a shell, and a worker that
	// quietly processed a prefix would leave the tail permanently behind.
	results := hant.ClassifyAll(res, hant.RowsFromDB(dbRows, 0))
	titles, descs := hant.Writable(results, false)

	if len(titles) == 0 && len(descs) == 0 {
		slog.InfoContext(ctx, "hant_backfill idle",
			"rows", len(results),
			"duration", time.Since(start))
		return nil
	}

	titlesWritten, err := hant.ApplyTitles(ctx, w.db, titles)
	if err != nil {
		return fmt.Errorf("hant_backfill title_hant: %w", err)
	}
	descsWritten, err := hant.ApplyDescriptions(ctx, w.db, descs)
	if err != nil {
		return fmt.Errorf("hant_backfill description_hant: %w", err)
	}

	// Offered and written are both reported because they can legitimately
	// differ: the UPDATE's manual guard skips a row hand-promoted to
	// source='manual' between the classification and the write.  Logging
	// only the offered count would hide the guard doing its job; logging
	// only the written count would hide that it fired at all.
	slog.InfoContext(ctx, "hant_backfill done",
		"rows", len(results),
		"titlesOffered", len(titles),
		"titlesWritten", titlesWritten,
		"descriptionsOffered", len(descs),
		"descriptionsWritten", descsWritten,
		"duration", time.Since(start))
	return nil
}

// PeriodicHantBackfillJob returns the river PeriodicJob that fires the
// sweep every 90 days.  Pass it to queue.Config.PeriodicJobs alongside
// PeriodicDescriptionBackfillScanJob and friends.
//
// InsertOpts is nil in the tuple: HantBackfillArgs.InsertOpts() already
// pins the queue and the uniqueness, and that is all this job needs.
//
// RunOnStart is FALSE, which is where this departs from
// PeriodicDescriptionBackfillScanJob — and the departure is the point.
// That job fires hourly, so RunOnStart=false meant a service deploying
// several times a day never swept at all.  This one fires quarterly, so
// the same flag reads the other way round: RunOnStart=true would not be
// "quarterly, plus a nudge at boot", it would be "every deploy", and a
// 90-day interval that in practice never elapses is not an interval.
// The cost is not hypothetical either — a pass reads every row in
// anime_cache including description_cn and runs s2twp over ~16k
// synopses, in front of the request path on the coldest container.
//
// Nor is this job left without a trigger the way the description sweep
// was.  POST /api/admin/hant/backfill enqueues it on demand, and
// GET /api/admin/hant/stats reports titleBehind / descBehind so a human
// can see when it is worth pressing.  That is the same argument
// PeriodicOrphanScanJob makes for RunOnStart=false: it can afford a
// delayed first fire because main.go calls ScanAndEnqueueOrphans at boot.
//
// KNOWN LIMIT, recorded so nobody reads the interval as a promise: river's
// open-source pilot does not persist periodic schedules
// (riverpilot.StandardPilot.PeriodicJobGetAll returns nil), so nextRunAt
// is recomputed as now+90d at every Start.  On a service that deploys more
// often than quarterly the timer never elapses, and the admin button is
// the real trigger.  The periodic fire is the backstop for a process that
// does stay up — not the day-to-day path.
func PeriodicHantBackfillJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(hantBackfillInterval),
		func() (river.JobArgs, *river.InsertOpts) {
			return HantBackfillArgs{}, nil
		},
		nil, // PeriodicJobOpts — defaults are fine; RunOnStart=false, see above
	)
}

// AddHantBackfillWorker registers the sweep on an existing bundle.
//
// Separate from WorkersWithBangumi (the same shape as
// AddDescriptionLlmWorkers) so that function's signature, its call sites
// and its test doubles stay untouched: this worker shares none of the
// dependencies in V12DB and needs one — the dataset directory — that no
// other worker has any use for.
func AddHantBackfillWorker(w *river.Workers, db HantBackfillDB, dataDir string) {
	river.AddWorker(w, NewHantBackfillWorker(db, dataDir))
}

// Compile-time guard: the worker must satisfy river.Worker for its args.
var _ river.Worker[HantBackfillArgs] = (*HantBackfillWorker)(nil)
