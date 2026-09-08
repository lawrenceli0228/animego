// registry_default.go — the production declarations.
//
// This is the file to edit when adding a background job.  Everything river
// needs to run it is here: the queue it rides, the worker count for that
// queue and why it is that number, and the schedule.  cmd/server/main.go
// reads this and does not restate any of it.
//
// The prose that used to sit in main.go's Queues literal is preserved, mostly
// verbatim, because it is the only record of why several of these numbers are
// 1.  Two claims in it were false on HEAD and were corrected in the commit
// before this one rather than moved.
package queue

import (
	"time"

	"github.com/riverqueue/river"
)

// defaultRegistry is the production declaration set.  Built at package init
// so a malformed registry stops the process at start rather than at the first
// insert — and stops the test binary too, which is where it will actually be
// caught.
var defaultRegistry = mustRegistry(NewRegistry(productionQueues, productionEntries))

// Default returns the production registry.
func Default() *Registry { return defaultRegistry }

// mustRegistry panics on a construction error.  Reserved for the package-level
// var above: a registry that does not validate is a programming error with no
// runtime recovery, and river would go on to run some subset of the intended
// jobs while reporting nothing.
func mustRegistry(r *Registry, err error) *Registry {
	if err != nil {
		panic(err)
	}
	return r
}

// productionQueues declares every river queue and its worker count.
//
// Note what MaxWorkers is and is not.  It bounds workers inside THIS process.
// cmd/bgmbackfill and cmd/hantbackfill are separate processes that write some
// of the same tables, so none of these reasons can be read as "only one
// writer exists" — they are all phrased as what the slot buys inside the
// server.
var productionQueues = map[string]Concurrency{
	// The default queue carries four workloads at once: V1, V2,
	// warm_season and orphan_scan.  That is why it is the one queue the
	// admin pause surface refuses to touch (see Registry.PausableNames).
	//
	// One slot because V1 and V2 both spend the shared Bangumi token
	// bucket, so a second worker would not go faster — it would take turns
	// on the same 800ms allowance while doubling the dispatch churn.
	river.QueueDefault: FixedConcurrency(1,
		"V1/V2 spend the shared 800ms Bangumi bucket; extra slots queue on it rather than beat it"),

	// V3 gets its own queue so the admin heal-CN pause isolates that
	// workload.  Pausing default would freeze enrichment and seasonal
	// warming with it.
	BangumiV3QueueName: FixedConcurrency(1,
		"heal-CN draws the same shared Bangumi bucket as V1/V2"),

	// Chinese-description backfill.  A long-running sweep over ~17k rows
	// whose only cost is Bangumi API time, metered by a token bucket on the
	// single shared *bangumi.Client.  Extra workers would therefore not
	// drain the backlog any faster; they would queue on the same bucket
	// while stealing dispatch slots from on-demand enrichment.  The
	// separate queue is for isolation and pausability, not parallelism.
	DescriptionBackfillQueueName: FixedConcurrency(1,
		"the backlog is bucket-bound, not worker-bound; extra slots only steal dispatch from live enrichment"),

	// LLM translation.  The one queue here that genuinely parallelises: its
	// budget is DeepSeek round-trips (seconds each, no shared token
	// bucket), and 4-way keeps a 600-row batch under ~15 minutes without
	// hammering the API.  Tunable because raising it costs only DeepSeek
	// concurrency — nothing else depends on the number.
	DescriptionLlmQueueName: TunableConcurrency(4,
		"DeepSeek round-trips are the budget and they parallelise; raising this costs API concurrency and nothing else"),

	// zh-Hant sweep.  One job is the whole table, so a second worker has
	// nothing to do except run a duplicate pass — and HantBackfillArgs is
	// unique across every non-terminal state precisely to stop that.  The
	// separate queue is so a pass that reads all ~17.5k rows and issues two
	// dozen 500-row UPDATEs cannot sit in front of the V1/V2 enrichment a
	// page load is waiting on.
	HantBackfillQueueName: FixedConcurrency(1,
		"one job is the whole table; a second slot could only run a duplicate pass"),

	// Inferred episode counts.  Two Bangumi requests per row, metered by
	// the same shared token bucket, so the same argument as the description
	// backfill applies unchanged.
	EpisodesBgmQueueName: FixedConcurrency(1,
		"two bucket-metered requests per row; extra slots steal dispatch from live enrichment without going faster"),

	// Airing episode titles.  One pass is one job that walks its whole
	// candidate list inline, and every row costs a token from the
	// dandanplay bucket that user-facing /match draws on.  A second
	// concurrent pass would not go faster -- the bucket is the constraint,
	// not the worker count -- it would only take twice as many tokens away
	// from the request path.
	EpisodeTitlesQueueName: FixedConcurrency(1,
		"the dandanplay bucket is shared with user-facing /match; a second pass only takes tokens from it"),

	// Binding.  MaxWorkers 1 is load-bearing rather than polite here.
	// BindBgmIdsFromIdMap refuses a subject some bound row already holds,
	// but that check and its UPDATE are one statement: two concurrent
	// passes could each pass it for the same subject and both bind, and
	// anime_cache.bgm_id has no unique index to catch it.  A single slot is
	// what makes that race unreachable BETWEEN JOBS IN THIS PROCESS, and it
	// is why every writer of anime_cache.bgm_id shares this queue.
	//
	// Be precise about what it buys, because the obvious reading is wrong
	// in two directions.
	//
	// It is not a guarantee against a second process: cmd/bgmbackfill and
	// cmd/hantbackfill write some of the same tables without going through
	// river at all.  id_map_binds.go deliberately ships without an --apply
	// flag, and that absence — not this slot count — is what keeps the
	// binding path single-writer today.
	//
	// And it is not the reason "one subject, one row" holds, because that
	// does not hold: measured 2026-09-03, 541 subjects are already held by
	// two or more rows (1,161 rows in total), some of them legitimately —
	// Bangumi sometimes covers with one subject what AniList splits into
	// two seasons.  What the slot buys is that this sweep cannot make that
	// number larger.  TODOS.md carries what it would take to make the
	// database enforce the invariant instead; the blocker there is
	// adjudicating those 1,161 rows, not writing the migration.
	BgmBindQueueName: FixedConcurrency(1,
		"keeps this sweep from adding to the 541 subjects already multi-held; in-process only"),

	// Rating refresh, both kinds on one queue.  They are the same feature
	// and are turned off for the same reasons, so a single pause is the
	// control an operator wants.
	//
	// One slot, which replaced an earlier 2 chosen so a four-minute Bangumi
	// pass would not sit in front of a thirty-second AniList one.  The cost
	// is small at this cadence: with anilistRatingsBatch at 500 the AniList
	// pass is ~21s and the Bangumi pass ~4 minutes, so serialising them
	// spends about five minutes of one slot per hour.
	RatingsQueueName: FixedConcurrency(1,
		"two passes of the same kind cannot overlap, which is what keeps a relaxed-uniqueness future safe"),
}

// productionEntries declares every job kind.
//
// Order is the order river receives the periodic jobs in, and it matches the
// order the old main.go literal used so a diff of the two reads cleanly.
var productionEntries = []Entry{
	// --- default queue: the enrichment pipeline and the two boot scans ---

	// V1/V2/V3 are chained by their workers, never scheduled.
	{Args: BangumiV1Args{}, Queue: river.QueueDefault},
	{Args: BangumiV2Args{}, Queue: river.QueueDefault},
	{Args: BangumiV3Args{}, Queue: BangumiV3QueueName},

	// warm_season: RunOnStart is false because main.go enqueues the
	// current AND next season by hand at boot, which this single-payload
	// schedule cannot express.  The payload is built at firing time so a
	// long-lived process rolls onto the new season instead of warming last
	// quarter forever.
	{
		Args:  WarmSeasonArgs{},
		Queue: river.QueueDefault,
		Periodic: &PeriodicSpec{
			Interval: warmSeasonPeriodicInterval,
			Args: func() river.JobArgs {
				cur, year := CurrentSeason(time.Now())
				return WarmSeasonArgs{Season: cur, Year: year}
			},
		},
	},

	// orphan_scan: RunOnStart false for the same reason — main.go runs the
	// boot scan itself via ScanAndEnqueueOrphans.
	{
		Args:     OrphanScanArgs{},
		Queue:    river.QueueDefault,
		Periodic: &PeriodicSpec{Interval: orphanScanPeriodicInterval},
	},

	// --- description backfill: a scan that fans out to per-row jobs ---

	{
		Args:     DescriptionBackfillScanArgs{},
		Queue:    DescriptionBackfillQueueName,
		Periodic: &PeriodicSpec{Interval: descriptionBackfillScanInterval, RunOnStart: true},
	},
	{Args: DescriptionBackfillArgs{}, Queue: DescriptionBackfillQueueName},

	// --- LLM translation: same shape, different budget ---

	{
		Args:     DescriptionLlmBackfillScanArgs{},
		Queue:    DescriptionLlmQueueName,
		Periodic: &PeriodicSpec{Interval: descriptionLlmScanInterval, RunOnStart: true},
	},
	{Args: DescriptionLlmBackfillArgs{}, Queue: DescriptionLlmQueueName},

	// --- inferred episode counts ---

	{
		Args:     EpisodesBgmScanArgs{},
		Queue:    EpisodesBgmQueueName,
		Periodic: &PeriodicSpec{Interval: episodesBgmScanInterval, RunOnStart: true},
	},
	{Args: EpisodesBgmArgs{}, Queue: EpisodesBgmQueueName},

	// --- airing episode titles ---

	{
		Args:     EpisodeTitlesArgs{},
		Queue:    EpisodeTitlesQueueName,
		Periodic: &PeriodicSpec{Interval: episodeTitlesInterval, RunOnStart: true},
	},

	// --- bgm_id binding ---

	{
		Args:     BindIdMapArgs{},
		Queue:    BgmBindQueueName,
		Periodic: &PeriodicSpec{Interval: bindIdMapInterval, RunOnStart: true},
	},

	// --- zh-Hant sweep ---

	// Quarterly, and deliberately NOT RunOnStart: one pass is the whole
	// table, so firing it on every deploy would be the expensive mistake.
	// The cost of that choice is real — a service that deploys more often
	// than once a quarter may never reach the interval — and it is accepted
	// because the admin button exists to run it on demand.
	{
		Args:     HantBackfillArgs{},
		Queue:    HantBackfillQueueName,
		Periodic: &PeriodicSpec{Interval: hantBackfillInterval},
	},

	// --- rating refresh ---

	// Hourly and RunOnStart, for the reason the sweeps above give: river's
	// OSS scheduler recomputes nextRunAt at every Start, so without it a
	// service that deploys more often than the interval never sweeps.  The
	// read stamp is what makes firing on boot free.
	{
		Args:     AnilistRatingsArgs{},
		Queue:    RatingsQueueName,
		Periodic: &PeriodicSpec{Interval: ratingsInterval, RunOnStart: true},
	},
	{
		Args:     BangumiRatingsArgs{},
		Queue:    RatingsQueueName,
		Periodic: &PeriodicSpec{Interval: ratingsInterval, RunOnStart: true},
	},
}
