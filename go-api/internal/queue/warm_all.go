// warm_all.go — bulk seasonal warm dispatch for /admin/warm-all.
//
// Express equivalent: server/services/anilist.service.js
// warmAllSeasons(startYear) — iterates SEASONS x [startYear … cur+1]
// and calls warmSeasonCache(season, year) for each pair sequentially
// (with a 10s cooldown between seasons to stay under AniList rate
// limits).  The Go port fires-and-forgets one WarmSeasonArgs job per
// pair through the river queue; the rate-limit budget is owned by the
// AniList client (anilist.Client.Seasonal already applies its own
// 700ms-per-page throttle and respects ErrRateLimited), and river's
// per-queue worker concurrency (MaxWorkers=1 for the warm_season
// queue in the typical config) serialises dispatch naturally.
//
// SCOPE:
//   - Year range: startYear … currentYear() + 1 (inclusive on both
//     ends).  Express stops at the current season; the Go port covers
//     the upcoming year's seasons too so the admin "warm everything"
//     button warms next year's slate without a follow-up call after
//     the year boundary.
//   - Seasons: WINTER, SPRING, SUMMER, FALL in that fixed order.
//     Matches AniList's canonical enum values (see warm_season.go
//     CurrentSeason / NextSeason).
//   - Total jobs enqueued: 4 * (currentYear + 1 - startYear + 1).
//     With startYear=2014 + currentYear=2026 that's 4 * 14 = 56 jobs.
//
// CONCURRENCY:
//   - A package-level sync.Mutex (via TryLock) protects against a
//     second admin caller firing a second warmAllSeasons before the
//     first finishes enqueuing.  Express used a module-level
//     warmAllRunning bool; we use TryLock for the same "skip if
//     already in flight" semantics but race-detector-safe.
//   - Second concurrent call returns (0, ErrWarmAllInProgress)
//     immediately — fire-and-forget call sites can ignore the error,
//     but the contract is explicit.
//
// FAILURE HANDLING:
//   - One EnqueueWarmSeasonNow error aborts the loop and returns the
//     count of jobs enqueued before the failure (so callers can log
//     partial progress).  River will run the jobs already enqueued;
//     if the queue surface itself is failing the operator wants to
//     know NOW, not after iterating through 50+ doomed inserts.
//   - Context cancellation also aborts the loop with the same
//     partial-count return semantics.
//
// TIMING / LOGS:
//   - One slog.InfoContext at start ("warmAllSeasons start") with the
//     startYear field.  One at end ("warmAllSeasons done") with the
//     total enqueued + duration.  Operators correlate start/end
//     pairs and can spot TryLock-rejected calls in between.

package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// ErrWarmAllInProgress is returned by EnqueueWarmAllSeasons when
// another call is currently iterating.  Fire-and-forget callers may
// ignore this; the admin handler logs it so operators can see when
// concurrent attempts happen.
var ErrWarmAllInProgress = errors.New("queue.EnqueueWarmAllSeasons: another invocation is already in progress")

// warmAllMu serialises EnqueueWarmAllSeasons across the process.
// TryLock so a second caller bails immediately rather than queuing
// behind the first (which would block their HTTP handler for seconds
// while the first finishes inserting 50+ jobs).
var warmAllMu sync.Mutex

// warmAllSeasonList enumerates the four AniList season enum values in
// the order Express iterates.  Hard-coded (rather than derived from
// NextSeason) because the order is part of the AniList API contract —
// re-deriving would risk drift if NextSeason's transition table ever
// changed.
var warmAllSeasonList = [4]string{"WINTER", "SPRING", "SUMMER", "FALL"}

// nowFn is injected so tests can drive year boundaries deterministically.
// Production reads time.Now via the var; tests can swap and restore via
// t.Cleanup when they need a fixed clock.  Default exported as a var
// (not a const) so tests in this package can rebind it.
var nowFn = time.Now

// EnqueueWarmAllSeasons enqueues one WarmSeasonArgs job per (season,
// year) pair from startYear through currentYear+1.  Returns the
// number of jobs successfully enqueued and any underlying error from
// the Enqueuer.  A failure on job N+1 leaves jobs 1..N already
// enqueued (river will still run them).
//
// Returns (0, ErrWarmAllInProgress) when a second concurrent call
// would race the first.  Callers that don't care about the in-flight
// case may ignore the error — `enqueued` is the load-bearing return
// value and is always 0 when ErrWarmAllInProgress is returned.
//
// Safe to call from a goroutine kicked off by an HTTP handler; the
// caller does not wait for the river worker to finish processing the
// queued jobs — once this function returns, the workers handle the
// rest asynchronously.
//
// enq must be non-nil; passing nil panics so misconfiguration crashes
// loudly at boot rather than silently dropping warming jobs on the
// floor.
func EnqueueWarmAllSeasons(ctx context.Context, enq Enqueuer, startYear int) (enqueued int, err error) {
	if enq == nil {
		// Panic intentionally — a nil Enqueuer reaching here means
		// the call site forgot to wire the queue.  The alternative
		// (silent no-op) loses warming jobs without any signal.
		panic("queue.EnqueueWarmAllSeasons: nil Enqueuer")
	}

	// TryLock so a second caller fails immediately with
	// ErrWarmAllInProgress (Express's "warmAllSeasons already running,
	// skipping" branch).  Defer Unlock so a panic in the loop still
	// releases the mutex.
	if !warmAllMu.TryLock() {
		return 0, ErrWarmAllInProgress
	}
	defer warmAllMu.Unlock()

	start := time.Now()
	endYear := nowFn().Year() + 1

	slog.InfoContext(ctx, "warmAllSeasons start",
		"startYear", startYear,
		"endYear", endYear,
	)

	for year := startYear; year <= endYear; year++ {
		for _, season := range warmAllSeasonList {
			if ctxErr := ctx.Err(); ctxErr != nil {
				// Context cancellation aborts the loop.  Return the
				// partial count so the admin endpoint can report
				// "got N of M before the caller gave up".
				slog.WarnContext(ctx, "warmAllSeasons cancelled",
					"enqueued", enqueued,
					"err", ctxErr,
				)
				return enqueued, fmt.Errorf("warmAllSeasons: %w", ctxErr)
			}
			if eErr := enq.EnqueueWarmSeasonNow(ctx, WarmSeasonArgs{
				Season: season,
				Year:   year,
			}); eErr != nil {
				// One bad insert aborts.  River will retry per-job
				// on its own schedule for the jobs already enqueued;
				// the caller decides whether to retry the bulk
				// dispatch.
				return enqueued, fmt.Errorf("warmAllSeasons: enqueue %s %d: %w", season, year, eErr)
			}
			enqueued++
		}
	}

	slog.InfoContext(ctx, "warmAllSeasons done",
		"startYear", startYear,
		"endYear", endYear,
		"enqueued", enqueued,
		"duration", time.Since(start),
	)
	return enqueued, nil
}
