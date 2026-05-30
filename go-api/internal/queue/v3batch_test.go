// v3batch_test.go — unit tests for the package-level V3 batch tracker.
//
// Tests exercise Start/RecordProcessed/Snapshot individually and as a
// combined round-trip.  Because the tracker is package-level state,
// tests that mutate it reset it first via V3BatchStart to avoid
// order-dependence.  The race detector (-race) is the authoritative
// guard for concurrent-safety; the ConcurrentWrites test provides
// an explicit concurrent harness.
package queue

import (
	"sync"
	"testing"
)

// TestV3BatchSnapshot_ZeroOnFreshState — V3BatchSnapshot returns (0,0,0)
// before any V3BatchStart call (the zero value of the package-level var).
// This test runs first (alphabetically in the suite) but we can't rely on
// ordering, so we reset first.
func TestV3BatchSnapshot_ZeroAfterStart(t *testing.T) {
	V3BatchStart(0)
	total, processed, healed := V3BatchSnapshot()
	if total != 0 || processed != 0 || healed != 0 {
		t.Errorf("after V3BatchStart(0): got (%d,%d,%d), want (0,0,0)", total, processed, healed)
	}
}

// TestV3BatchStart_SetsTotal — V3BatchStart seeds the total counter and
// resets processed/healed to zero even if they were non-zero.
func TestV3BatchStart_SetsTotal(t *testing.T) {
	// Seed some prior state.
	V3BatchStart(100)
	V3BatchRecordProcessed(true)
	V3BatchRecordProcessed(false)

	// Now start a fresh batch.
	V3BatchStart(42)
	total, processed, healed := V3BatchSnapshot()
	if total != 42 {
		t.Errorf("total=%d, want 42", total)
	}
	if processed != 0 {
		t.Errorf("processed=%d, want 0 after fresh Start", processed)
	}
	if healed != 0 {
		t.Errorf("healed=%d, want 0 after fresh Start", healed)
	}
}

// TestV3BatchRecordProcessed_NotHealed — when healed=false, only the
// processed counter increments; healed stays at 0.
func TestV3BatchRecordProcessed_NotHealed(t *testing.T) {
	V3BatchStart(10)
	V3BatchRecordProcessed(false)
	V3BatchRecordProcessed(false)

	_, processed, healed := V3BatchSnapshot()
	if processed != 2 {
		t.Errorf("processed=%d, want 2", processed)
	}
	if healed != 0 {
		t.Errorf("healed=%d, want 0 (no healing)", healed)
	}
}

// TestV3BatchRecordProcessed_Healed — when healed=true, both processed
// and healed increment.
func TestV3BatchRecordProcessed_Healed(t *testing.T) {
	V3BatchStart(5)
	V3BatchRecordProcessed(true)
	V3BatchRecordProcessed(true)
	V3BatchRecordProcessed(false)

	_, processed, healed := V3BatchSnapshot()
	if processed != 3 {
		t.Errorf("processed=%d, want 3", processed)
	}
	if healed != 2 {
		t.Errorf("healed=%d, want 2", healed)
	}
}

// TestV3BatchRoundTrip — full Express-mirror scenario:
// start a batch of N, record N completions (some healed, some not),
// verify snapshot matches expectations.
func TestV3BatchRoundTrip(t *testing.T) {
	const n = 7
	V3BatchStart(n)

	// 3 healed, 4 not healed.
	for i := 0; i < 3; i++ {
		V3BatchRecordProcessed(true)
	}
	for i := 0; i < 4; i++ {
		V3BatchRecordProcessed(false)
	}

	total, processed, healed := V3BatchSnapshot()
	if total != n {
		t.Errorf("total=%d, want %d", total, n)
	}
	if processed != n {
		t.Errorf("processed=%d, want %d", processed, n)
	}
	if healed != 3 {
		t.Errorf("healed=%d, want 3", healed)
	}
}

// TestV3BatchSnapshot_Idempotent — Snapshot does not mutate state;
// two consecutive calls return the same values.
func TestV3BatchSnapshot_Idempotent(t *testing.T) {
	V3BatchStart(20)
	V3BatchRecordProcessed(true)

	t1, p1, h1 := V3BatchSnapshot()
	t2, p2, h2 := V3BatchSnapshot()
	if t1 != t2 || p1 != p2 || h1 != h2 {
		t.Errorf("Snapshot not idempotent: (%d,%d,%d) vs (%d,%d,%d)", t1, p1, h1, t2, p2, h2)
	}
}

// TestV3Batch_ConcurrentWrites — run a batch of concurrent
// RecordProcessed calls and verify the final counters are exact.
// This test is not t.Parallel so the race detector flags any unguarded
// access against the package-level state.
func TestV3Batch_ConcurrentWrites(t *testing.T) {
	const workers = 50
	const healEvery = 3 // healed when i%3==0

	V3BatchStart(int64(workers))

	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(idx int) {
			defer wg.Done()
			V3BatchRecordProcessed(idx%healEvery == 0)
		}(i)
	}
	wg.Wait()

	// Count expected heals: indices 0,3,6,...,48 → ceil(50/3) = 17
	expectedHealed := int64(0)
	for i := 0; i < workers; i++ {
		if i%healEvery == 0 {
			expectedHealed++
		}
	}

	_, processed, healed := V3BatchSnapshot()
	if processed != workers {
		t.Errorf("processed=%d, want %d", processed, workers)
	}
	if healed != expectedHealed {
		t.Errorf("healed=%d, want %d", healed, expectedHealed)
	}
}
