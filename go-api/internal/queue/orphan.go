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
// Safe to call multiple times: river has no built-in arg-hash dedupe,
// so a duplicate V1 job may run twice — but the V1 worker itself is
// effectively idempotent (it only writes when there is a new exact
// match), so cost of duplication is one extra Bangumi API call.  Worth
// it for the simplicity of "scan on every boot".
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
