package admin

// warm_all.go — POST /api/admin/warm-all handler.
//
// Replaces server/controllers/admin.controller.js warmAll (lines 393-403).
// Express semantics:
//
//	const startYear = parseInt(req.query.startYear) || 2014;
//	res.json({ data: { message: `Warming all seasons from ${startYear}. Check server logs.` } });
//	warmAllSeasons(startYear).catch(err =>
//	  console.error('❌ warmAllSeasons error:', err.message)
//	);
//
// Two non-obvious behaviors we preserve byte-exactly:
//
//  1. The response message is ENGLISH, not Chinese.  Don't translate it —
//     the front-end matches the literal string in some places and the
//     shadow-traffic byte-diff would break on translation.
//
//  2. The actual warming runs ASYNCHRONOUSLY after the response.  Express
//     uses `res.json(...); warmAllSeasons(...).catch(...);` which fires
//     and forgets.  In Go we spawn a goroutine with a fresh context
//     (NOT r.Context() — that gets cancelled when the response writer
//     finishes) bounded by a 30-minute hard timeout.  30 minutes covers
//     the worst case of 12 years × 4 seasons = 48 jobs at ~10s each
//     queue dispatch, well within budget; the actual season warming
//     happens in the river worker pool which has its own per-job timeout.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// warmAllDefaultStartYear is the floor applied when startYear is missing,
// empty, non-numeric, or zero.  Matches Express's
// `parseInt(req.query.startYear) || 2014`.  The queue helper applies an
// identical floor server-side as defense-in-depth so a future caller
// that bypasses this handler can't drop below 2014.
const warmAllDefaultStartYear = 2014

// warmAllBackgroundTimeout is the hard ceiling on the background
// enqueue goroutine.  30 minutes is overkill for the typical 48-job
// dispatch (<1 second) but covers the case where river insert hits
// retries or the DB is briefly slow.  We deliberately do NOT make this
// configurable — operators should never have a reason to wait more
// than 30 minutes for warm-all enqueue; if it takes longer something
// is fundamentally broken upstream.
const warmAllBackgroundTimeout = 30 * time.Minute

// warmAllResp is the success body for POST /api/admin/warm-all.  The
// message is interpolated with the resolved startYear (after defaulting)
// so callers see exactly which year the worker pool will start from.
type warmAllResp struct {
	Message string `json:"message"`
}

// WarmAll implements POST /api/admin/warm-all?startYear=N.
//
// Flow:
//  1. Parse startYear query param.  Missing / empty / non-numeric /
//     zero / negative → 2014.
//  2. Respond 200 IMMEDIATELY with the English status message so the
//     admin UI doesn't sit on a 30-minute spinner.
//  3. After response: spawn a goroutine with context.Background() +
//     30-minute timeout to call queue.EnqueueWarmAllSeasons.  Enqueue
//     failures are LOGGED via slog.ErrorContext but never bubble to
//     the client (which has already received 200).
//
// The handler does NOT block on enqueue completion.  This is by design
// — warming hundreds of (season, year) pairs through river is too long
// to keep an HTTP connection open, and the admin caller only needs to
// know "the job is dispatched, check the server logs".
func (h *UserHandlers) WarmAll(w http.ResponseWriter, r *http.Request) {
	startYear := parseWarmAllStartYear(r.URL.Query().Get("startYear"))

	// Respond first.  After this returns, the response has flushed —
	// any work done after the call must not touch w (Go's response
	// writers panic on post-flush writes).
	msg := fmt.Sprintf("Warming all seasons from %d. Check server logs.", startYear)
	httpx.Data(w, http.StatusOK, warmAllResp{Message: msg})

	// Background enqueue.  Fresh context with a 30-minute hard cap
	// because r.Context() is cancelled the moment the response
	// writer finishes — using it would race the enqueue against
	// connection teardown.
	//
	// We use the handler's stored enq (not a global) so tests that
	// inject a fakeEnqueuer can observe the enqueue without spinning
	// up river.  go routine + fresh ctx means the test setup needs to
	// wait on a sync signal — handled in the test fixture by polling
	// the fake's call count with a short timeout.
	enq := h.enq
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), warmAllBackgroundTimeout)
		defer cancel()
		enqueued, err := queue.EnqueueWarmAllSeasons(ctx, enq, startYear)
		if err != nil {
			// ErrWarmAllInProgress is the documented "already running"
			// branch — log at Info rather than Error since this is the
			// expected concurrent-call response (Express logs the same
			// case as a normal info line, not a stack trace).  Other
			// errors land in slog.Error so operators see them in alert
			// dashboards.
			if errors.Is(err, queue.ErrWarmAllInProgress) {
				slog.InfoContext(ctx, "admin warm-all skipped: already running",
					"startYear", startYear)
				return
			}
			slog.ErrorContext(ctx, "admin warm-all enqueue failed",
				"startYear", startYear, "enqueued", enqueued, "err", err)
			return
		}
		slog.InfoContext(ctx, "admin warm-all enqueue complete",
			"startYear", startYear, "enqueued", enqueued)
	}()
}

// parseWarmAllStartYear pulls the startYear value out of the query
// string and applies the same default as Express:  missing / empty /
// non-numeric / non-positive → warmAllDefaultStartYear.  Negative values
// are treated as invalid (Express's `|| 2014` truthiness check rejects
// 0 but accepts negatives — we tighten this to match the queue helper's
// floor at 2014, which is the conservative behavior).
func parseWarmAllStartYear(raw string) int {
	if raw == "" {
		return warmAllDefaultStartYear
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return warmAllDefaultStartYear
	}
	if n <= 0 {
		return warmAllDefaultStartYear
	}
	return n
}
