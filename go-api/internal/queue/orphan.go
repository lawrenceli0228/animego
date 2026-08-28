// orphan.go — boot-time enqueue of all unenriched anime rows.
//
// Express service:188-196 runs this at startup to catch rows that were
// upserted during a previous worker outage:
//
//	const orphans = await AnimeCache.find(
//	  { $or: [{ bangumiVersion: 0 }, { bangumiVersion: { $exists: false } }] },
//	  { anilistId: 1, ... }
//	).lean();
//	if (orphans.length > 0) enqueueEnrichment(orphans);
//
// We do the same: read all bangumi_version=0 rows in one shot, enqueue
// V1 jobs in batches of 100 to avoid huge InsertMany calls and to keep
// the SQL planner from materialising the entire result set in memory at
// once.

package queue

import (
	"context"
	"fmt"
	"log/slog"
)

// orphanBatchSize is the page size used by ScanAndEnqueueOrphans.  100
// keeps the InsertMany payload modest (~3KB JSON per batch) while
// minimising the number of SELECT round-trips — at 100 rows/batch a
// 10k-row backlog drains in 100 reads.
const orphanBatchSize int32 = 100

// OrphanReader is the small sqlc subset needed for the boot scan.
// Defined here at the consumer rather than in dbgen so tests can supply
// a stub without owning the full Querier surface (~20 methods).
type OrphanReader interface {
	ListUnenrichedAnilistIDs(ctx context.Context, limit int32, offset int32) ([]int32, error)
}

// ScanAndEnqueueOrphans queries anime_cache for bangumi_version=0 in
// batches of 100, enqueues V1 jobs for each batch, and returns the
// total count enqueued.
//
// Safe to call multiple times: river has no built-in arg-hash dedupe and
// BangumiV1Args sets no UniqueOpts, so a duplicate V1 job may run twice.
// What makes that safe is the `AND bangumi_version = 0` predicate on
// UpdateBangumiV1 — a duplicate that arrives after the row moved on writes
// 0 rows and the worker logs `stale_skip`.  Cost of duplication is one
// extra Bangumi API call.
//
// It is NOT "the worker only writes when there is a new exact match": the
// id-map branch (bangumi_v1.go) does no search at all and writes
// unconditionally, and it passes nil for title_chinese.  Without the
// version predicate a stale duplicate would null out a Chinese title.
// The predicate is the guarantee; do not remove it on the strength of
// this comment's older claim.
//
// Window size matters here: river's MaxAttempts defaults to 25 (not 3, as
// the bangumi_v{1,2,3} headers claim) and this repo sets no override, so a
// failing job can stay live for well over a week.  "Stale" is not a
// millisecond race.
//
// Logs an INFO event with the total enqueued count when the scan
// completes successfully so operators can correlate boot time with the
// backlog size.
func ScanAndEnqueueOrphans(ctx context.Context, db OrphanReader, e Enqueuer) (int, error) {
	var (
		total  int
		offset int32
	)
	for {
		ids, err := db.ListUnenrichedAnilistIDs(ctx, orphanBatchSize, offset)
		if err != nil {
			return total, fmt.Errorf("queue.ScanAndEnqueueOrphans (offset=%d): %w", offset, err)
		}
		if len(ids) == 0 {
			break
		}
		if err := e.EnqueueV1Many(ctx, ids); err != nil {
			return total, err
		}
		total += len(ids)
		// Short last page → done.  Saves one extra round-trip that
		// would otherwise return an empty slice.
		if int32(len(ids)) < orphanBatchSize {
			break
		}
		offset += orphanBatchSize
	}
	slog.InfoContext(ctx, "queue.orphan-scan complete", "enqueued", total)
	return total, nil
}
