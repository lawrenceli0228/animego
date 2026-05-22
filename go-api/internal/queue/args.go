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
)
