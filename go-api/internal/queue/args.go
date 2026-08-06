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
)

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
