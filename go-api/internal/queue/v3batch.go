// v3batch.go — package-level in-memory V3 batch progress tracker.
//
// Mirrors the module-level counters Express kept in
// server/services/bangumi.service.js:
//
//	let v3BatchTotal = 0;
//	let v3BatchProcessed = 0;
//	let v3BatchHealed = 0;
//
//	function startV3Batch(total) { v3BatchTotal = total; v3BatchProcessed = 0; v3BatchHealed = 0; }
//	function recordV3Processed(healed) { v3BatchProcessed++; if (healed) v3BatchHealed++; }
//
// Go is single-instance (same as the Express server was), so process-local
// in-memory state is an accurate mirror.  The counters reset on process
// restart — acceptable, and matches Express behaviour.
//
// All three exported functions are safe for concurrent use.  The V3 worker
// (bangumi_v3.go) calls V3BatchRecordProcessed on every completed job;
// the admin enrichment handlers (admin/enrichment.go) call V3BatchStart
// after they finish enqueuing a V3 batch.  The queueStatusFn in
// cmd/server/main.go calls V3BatchSnapshot on every /stats poll.
//
// Design note: package-level functions (not a struct) so the
// BangumiV3Worker constructor signature stays unchanged, keeping
// worker_test.go compilable without modification.

package queue

import "sync"

// v3BatchState holds the current batch counters under a mutex.
// The zero value is valid: Total=0 means "no batch active" and the
// frontend already gates the progress animation on total>0.
var v3BatchState struct {
	mu        sync.Mutex
	total     int64
	processed int64
	healed    int64
}

// V3BatchStart resets the batch counters for a fresh heal or re-enrich run.
// Should be called by the admin enrichment handler after it finishes
// dispatching V3 jobs to river, so the worker's increments land on a
// freshly-initialised counter rather than stale counts from a previous run.
func V3BatchStart(total int64) {
	v3BatchState.mu.Lock()
	defer v3BatchState.mu.Unlock()
	v3BatchState.total = total
	v3BatchState.processed = 0
	v3BatchState.healed = 0
}

// V3BatchRecordProcessed bumps the processed counter.  When healed is true
// (the job wrote a non-nil CN title), the healed counter is also bumped.
// Called by the V3 worker after every job that completes — including
// soft-404 jobs where no CN title was written (healed=false), which mirrors
// Express's v3BatchProcessed++ on every iteration regardless of outcome.
func V3BatchRecordProcessed(healed bool) {
	v3BatchState.mu.Lock()
	defer v3BatchState.mu.Unlock()
	v3BatchState.processed++
	if healed {
		v3BatchState.healed++
	}
}

// V3BatchSnapshot returns the current (total, processed, healed) counters.
// All three are zero if no batch has been started since the last process
// start.  Safe to call at any frequency — no side effects.
func V3BatchSnapshot() (total, processed, healed int64) {
	v3BatchState.mu.Lock()
	defer v3BatchState.mu.Unlock()
	return v3BatchState.total, v3BatchState.processed, v3BatchState.healed
}
