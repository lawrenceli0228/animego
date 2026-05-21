// Package anime owns the /api/anime/* HTTP handlers.
//
// Each exported function returns a chi-compatible http.HandlerFunc bound
// to the dbgen.Querier (and, for later endpoints, the AniList client +
// caches + enrichment queue).  The Querier interface lets handler tests
// substitute a mock without spinning up Postgres.
//
// Handlers follow the pattern documented in go-api/README.md "Adding a
// new endpoint":  pull a query-level timeout off the request context,
// parse + validate query params, hit the DB through Querier, write the
// httpx envelope.
package anime

import (
	"context"
	"net/http"
	"strconv"
	"time"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// queryTimeout bounds every handler's database round-trip.  Five seconds
// is generous for the kinds of queries P2.1 issues — bulk anime_cache
// reads with a LIMIT clause typically return in <50ms even on the dev
// machine; the budget covers contention spikes and per-test container
// warmup.
//
// Each handler creates a child context derived from the request context
// so that client-disconnect propagates and frees the connection.
const queryTimeout = 5 * time.Second

// CompletedGems implements GET /api/anime/completed-gems — a random
// sample of finished, highly-rated anime with cover art.  Replaces
// server/controllers/anime.controller.js:77-87.
//
// Query parameters:
//
//	limit  default 6, max 20
//
// Response envelope:
//
//	{"data":[{...anime fields...}, ...]}
func CompletedGems(q dbgen.Querier) http.HandlerFunc {
	const (
		defaultLimit = 6
		maxLimit     = 20
	)
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		limit := parseLimit(req.URL.Query().Get("limit"), defaultLimit, maxLimit)

		rows, err := q.GetCompletedGems(ctx, int32(limit))
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		// Express:  res.json({ data });  — flat array envelope, no
		// pagination metadata (random sample has no total / page concept).
		httpx.Data(w, http.StatusOK, rows)
	}
}

// parseLimit parses a query-string limit with a default and maximum.
// Non-numeric, negative, and missing values fall back to def.  Values
// over max are capped at max — matches Express Math.min(... , max).
func parseLimit(s string, def, max int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}
