// Package queue — river job arg types and worker registration.
//
// Three worker kinds map to the 3-phase Bangumi enrichment pipeline that
// Express ran in-memory (server/services/bangumi.service.js).  Phase logic
// itself lives in workers that the enrichment package wires up in P2.1.2;
// this file is just the contracts.
//
// JobArgs interface comes from github.com/riverqueue/river.  Each Args
// type must implement Kind() string and (optionally) InsertOpts() for
// retry policy / queue selection.
package queue

import (
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

// BangumiV1Args — phase 1: search Bangumi by title, write back the
// canonical bgmId + titleChinese (when the search hit is an exact native
// match).  One anilistId per job.
type BangumiV1Args struct {
	AnilistID int `json:"anilistId"`
}

// Kind returns the river job kind for V1 enrichment.  Used by the
// dispatch loop to look up the registered worker.
func (BangumiV1Args) Kind() string { return "bangumi_v1" }

// BangumiV2Args — phase 2: pull subject detail (characters/staff/episodes)
// for a known bgmId.  Enqueued after v1 sets bgmId.
type BangumiV2Args struct {
	AnilistID int `json:"anilistId"`
	BgmID     int `json:"bgmId"`
}

// Kind returns the river job kind for V2 enrichment.
func (BangumiV2Args) Kind() string { return "bangumi_v2" }

// BangumiV3Args — phase 3: heal-CN.  Re-fetches subject and overwrites
// titleChinese / character.nameCn when v1 missed.
type BangumiV3Args struct {
	AnilistID int `json:"anilistId"`
	BgmID     int `json:"bgmId"`
}

// Kind returns the river job kind for V3 enrichment.
func (BangumiV3Args) Kind() string { return "bangumi_v3" }

// InsertOpts routes V3 jobs to the dedicated "bangumi_v3" river queue
// (see BangumiV3QueueName in control.go).  Pinning V3 to its own queue
// is what makes the admin pause/resume endpoint actually pause only V3
// jobs — pausing the default queue would freeze V1 + V2 + warm_season
// too.  River resolves Queue lookup at insert time so the queue MUST
// exist in the Config.Queues map at Boot, otherwise InsertMany fails
// fast with "queue not found".  See cmd/server/main.go for the boot
// wiring that adds the queue.
func (BangumiV3Args) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: BangumiV3QueueName}
}

// WarmSeasonArgs is the job payload for the periodic seasonal warm
// worker.  One job per (season, year) pair — boot enqueues two
// instances (current season + next season) and river's PeriodicJobs
// re-fires every 24h.
//
// Season uses AniList's canonical uppercase values (WINTER / SPRING /
// SUMMER / FALL).  Year is the AniList seasonYear int.  Mirrors
// Express anilist.service.js warmSeasonCache(season, year).
type WarmSeasonArgs struct {
	Season string `json:"season"`
	Year   int    `json:"year"`
}

// Kind returns the river job kind for seasonal cache warming.
func (WarmSeasonArgs) Kind() string { return "warm_season" }

// Compile-time guard that every Args satisfies river.JobArgs.  river's
// validation also enforces this at NewClient time, but failing at compile
// time catches drift the moment a field is renamed.
var (
	_ river.JobArgs = (*BangumiV1Args)(nil)
	_ river.JobArgs = (*BangumiV2Args)(nil)
	_ river.JobArgs = (*BangumiV3Args)(nil)
	_ river.JobArgs = (*WarmSeasonArgs)(nil)
	_ river.JobArgs = (*DescriptionBackfillArgs)(nil)
	_ river.JobArgs = (*DescriptionBackfillScanArgs)(nil)
	_ river.JobArgs = (*DescriptionLlmBackfillArgs)(nil)
	_ river.JobArgs = (*DescriptionLlmBackfillScanArgs)(nil)
	_ river.JobArgs = (*HantBackfillArgs)(nil)
)

// HantBackfillArgs re-runs the zh-Hant precedence ladder over the whole
// of anime_cache and writes back whatever it disagrees with.
//
// No fields.  The work list is the entire table -- the ladder has to
// account for every tier including the rows that reach none of them, and
// --restale has to recompute a digest per row to know whether it drifted,
// so there is no candidate predicate that could narrow it (see
// ListAnimeForHantBackfill).  A payload would only give the dedupe
// something to disagree about.
type HantBackfillArgs struct{}

// Kind returns the river job kind for the zh-Hant sweep.
//
// MUST stay equal to the 'hant_backfill' literal in GetHantBackfillJobStatus
// (internal/db/queries/admin.sql).  sqlc cannot read a Go const, so that
// query is a hand-kept mirror of this string; rename here without renaming
// there and the admin endpoint reports "never run, not running" forever
// while the sweep runs perfectly well.
func (HantBackfillArgs) Kind() string { return "hant_backfill" }

// hantBackfillUniqueStates is the set of states in which an existing job
// suppresses a new one: every non-terminal state, and nothing else.
//
// Spelled out rather than left to river's default because the default
// INCLUDES `completed`, and river keeps completed rows for 24h.  With the
// default, an operator who watched a sweep finish and then pressed the
// admin button again -- because the report showed rows the run could not
// take, or because they had just fixed a dataset -- would get a cheerful
// "enqueued" and no job, for a full day, with nothing anywhere saying why.
//
// available/pending/running/scheduled are required by river
// (UniqueOpts.validate); retryable is added on purpose: a job in backoff
// after a failed attempt is still this sweep in flight, and letting a
// second one in beside it would put two whole-table passes on the same
// queue.
var hantBackfillUniqueStates = []rivertype.JobState{
	rivertype.JobStateAvailable,
	rivertype.JobStatePending,
	rivertype.JobStateRetryable,
	rivertype.JobStateRunning,
	rivertype.JobStateScheduled,
}

// InsertOpts pins the sweep to its own queue and collapses a second
// enqueue into the one already in flight.
//
// The queue matters because one pass reads all ~17.5k rows and can write
// ~12k of them; on the default queue that would sit in front of the V1/V2
// enrichment a page load is waiting on.
//
// ByArgs with an empty struct means "one hant_backfill at a time", which
// is the whole intent: the periodic schedule and the admin button feed the
// same job, and two concurrent whole-table passes would race each other's
// UPDATEs for no gain.
func (HantBackfillArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue: HantBackfillQueueName,
		UniqueOpts: river.UniqueOpts{
			ByArgs:  true,
			ByState: hantBackfillUniqueStates,
		},
	}
}

// DescriptionBackfillArgs harvests one row's Chinese description from the
// Bangumi subject it is already bound to.
//
// Separate from BangumiV3Args even though both fetch the same endpoint,
// because V3 overwrites title_chinese unconditionally — that is its job, it
// is the heal-CN phase. Rows whose Chinese title came from dandanplay would
// have it replaced by Bangumi's name_cn if the sweep reused V3, so the sweep
// gets a worker that touches description_cn and nothing else.
type DescriptionBackfillArgs struct {
	AnilistID int `json:"anilistId"`
	BgmID     int `json:"bgmId"`
}

// Kind returns the river job kind for the description backfill worker.
func (DescriptionBackfillArgs) Kind() string { return "description_backfill" }

// InsertOpts pins the job to its own queue and deduplicates by payload.
//
// ByArgs matters because the scan re-runs on a fixed interval while the
// previous batch may still be draining: without it every pass would re-enqueue
// rows already queued, and a slow upstream would compound the duplication
// every hour.
func (DescriptionBackfillArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:      DescriptionBackfillQueueName,
		UniqueOpts: river.UniqueOpts{ByArgs: true},
	}
}

// DescriptionLlmBackfillArgs translates one row's English synopsis into
// Chinese via the LLM fallback tier.
//
// Deliberately carries ONLY the anilist_id: the source text is re-read at
// work time (GetDescriptionForLlmTranslate) so the payload stays small,
// ByArgs dedupe stays cheap, and the worker sees the CURRENT row state —
// including a description_cn that the Bangumi channel landed between scan
// and work, in which case it stands down instead of spending tokens.
type DescriptionLlmBackfillArgs struct {
	AnilistID int `json:"anilistId"`
}

// Kind returns the river job kind for the LLM translation worker.
func (DescriptionLlmBackfillArgs) Kind() string { return "description_llm_backfill" }

// InsertOpts pins the job to the LLM queue and deduplicates by payload —
// same reasoning as DescriptionBackfillArgs: the scan re-fires hourly while
// a batch may still be draining.
func (DescriptionLlmBackfillArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:      DescriptionLlmQueueName,
		UniqueOpts: river.UniqueOpts{ByArgs: true},
	}
}

// DescriptionLlmBackfillScanArgs is the periodic trigger for the LLM sweep.
// No fields — the worker reads its work list from the database.  Rides the
// LLM queue so pausing that queue stops the sweep being fed as well as
// drained, mirroring DescriptionBackfillScanArgs.
type DescriptionLlmBackfillScanArgs struct{}

// Kind returns the river job kind for the periodic LLM backfill scan.
func (DescriptionLlmBackfillScanArgs) Kind() string { return "description_llm_backfill_scan" }

// InsertOpts pins the scan to the LLM queue. See the type comment.
func (DescriptionLlmBackfillScanArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: DescriptionLlmQueueName}
}

// DescriptionBackfillScanArgs is the periodic trigger that finds rows still
// missing a Chinese description and enqueues one job per row. No fields — the
// worker reads its work list from the database.
//
// Runs on the backfill queue rather than the default one so that pausing the
// sweep stops it being fed as well as stops it draining; otherwise a paused
// sweep would keep accumulating queued rows.
type DescriptionBackfillScanArgs struct{}

// Kind returns the river job kind for the periodic backfill scan.
func (DescriptionBackfillScanArgs) Kind() string { return "description_backfill_scan" }

// InsertOpts pins the scan to the backfill queue. See the type comment.
func (DescriptionBackfillScanArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: DescriptionBackfillQueueName}
}
