package admin

// read.go — the three /api/admin/* read handlers:  GetStats,
// ListEnrichment, ListUsers.  Each handler is a method on Handlers
// so the chi router can bind it directly.

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// GetStats implements GET /api/admin/stats — replaces
// server/controllers/admin.controller.js getStats (lines 9-47).
//
// Express pattern:
//   - Promise.all of 10 Mongo countDocuments calls
//   - + getQueueStatus() (in-memory, infallible)
//   - Build the {users, anime, enrichment:{...}, queue, flagged,
//     subscriptions, follows} payload and res.json it.
//
// Go translation:
//   - One dbgen.GetAdminStats call returns all 10 counts in one row.
//   - QueueStatus(ctx) call returns the queue.Stats snapshot.
//   - Reshape the flat sqlc row into the nested response struct.
//
// Failure modes:
//   - GetAdminStats fails  →  500 SERVER_ERROR.
//   - QueueStatus fails  →  log + emit zero-value queue.Stats (the
//     response still ships; matches Express's "queue is always
//     populated" guarantee from the in-memory implementation).
//   - QueueStatus is nil (NewHandlers caller didn't wire it) →
//     same fallback as the error case.
func (h *Handlers) GetStats(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	row, err := h.Queries.GetAdminStats(ctx)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "admin stats query failed"))
		return
	}

	// Queue snapshot is non-fatal — log on error / nil-fn and substitute
	// zero-value QueueSnapshot.  Express's in-memory getQueueStatus
	// cannot fail, so emitting all-zeros keeps the response shape
	// stable when our out-of-process counter source hiccups.
	var qsnap QueueSnapshot
	if h.QueueStatus != nil {
		got, qerr := h.QueueStatus(ctx)
		if qerr != nil {
			slog.WarnContext(ctx, "admin stats: queue status fetch failed; emitting zero counters",
				"err", qerr.Error(),
			)
		} else {
			qsnap = got
		}
	}

	payload := statsData{
		Users: row.TotalUsers,
		Anime: row.TotalAnime,
		Enrichment: statsEnrichment{
			V0:           row.EnrichV0,
			V1:           row.EnrichV1,
			V2:           row.EnrichV2,
			V3:           row.EnrichV3,
			NoCn:         row.NoCn,
			HasCn:        row.HasCn,
			HealCnReal:   row.HealCnReal,
			CnStuck:      row.CnStuck,
			SrcIDMap:     row.SrcIDMap,
			SrcFuzzyHigh: row.SrcFuzzyHigh,
			SrcFuzzyLow:  row.SrcFuzzyLow,
		},
		Queue:         qsnap,
		Flagged:       row.Flagged,
		Subscriptions: row.TotalSubs,
		Follows:       row.TotalFollows,
	}

	httpx.Data(w, http.StatusOK, payload)
}

// ListEnrichment implements GET /api/admin/enrichment?page=&filter=
// &q=&sort=&order= — replaces server/controllers/admin.controller.js
// listEnrichment (lines 50-97).
//
// Filters (Express byte-exact):
//   - needs-review        → admin_flag = 'needs-review'
//   - manually-corrected  → admin_flag = 'manually-corrected'
//   - unenriched          → bangumi_version = 0
//   - no-cn               → bgm_id IS NOT NULL AND title_chinese IS NULL
//   - anything else       → no filter
//
// Search (q):
//   - empty               → no filter
//   - all-digit (strict)  → anilist_id = num
//   - otherwise           → ILIKE on title_romaji / title_chinese / title_native
//
// Sort allow-list:  cachedAt (alias for cached_at), title_chinese,
// title_romaji, bangumi_version, bangumi_score, anilist_id.  Default
// sort is cached_at DESC.
//
// Pagination:  page≥1, limit=30 (hard-coded), skip=(page-1)*30.
//
// The SQL is built dynamically in list_enrichment.go (testable
// separately).  This handler is the thin wrapper that parses query
// params, dispatches the count + page queries in parallel via
// errgroup, then marshals the custom envelope.
func (h *Handlers) ListEnrichment(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	qs := r.URL.Query()
	page := parsePage(qs.Get("page"))
	filter := qs.Get("filter")
	q := qs.Get("q") // trim handled inside buildEnrichmentQueries
	sortField := qs.Get("sort")
	sortOrder := qs.Get("order")

	items, total, err := runEnrichmentList(ctx, h.Pool, enrichmentListParams{
		Page:      page,
		Filter:    filter,
		Query:     q,
		SortField: sortField,
		SortOrder: sortOrder,
	})
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "admin enrichment list failed"))
		return
	}

	skip := (page - 1) * pageSize
	hasMore := int64(skip+pageSize) < total

	writeListEnvelope(w, http.StatusOK, enrichmentListResponse{
		Data:    items,
		HasMore: hasMore,
		Total:   total,
		Page:    page,
	})
}

// ListUsers implements GET /api/admin/users?page=&q= — replaces
// server/controllers/admin.controller.js listUsers (lines 268-317).
//
// Filters:
//   - empty q             → no filter
//   - otherwise           → ILIKE on username / email
//
// Sort: created_at DESC (fixed — Express has no ?sort param on this
// endpoint).
//
// Pagination:  page≥1, limit=30, skip=(page-1)*30.
//
// Two-step fetch:
//  1. Page of users (raw pgxpool) + COUNT(*) of the same filter, run
//     in parallel.
//  2. Batch sub_count + follower_count for the page's user ids via
//     dbgen.GetAdminUserSubFollowCounts.
//
// The maps from (2) merge into each row to produce the final
// userItem slice.
func (h *Handlers) ListUsers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	qs := r.URL.Query()
	page := parsePage(qs.Get("page"))
	q := qs.Get("q")

	items, total, err := runUsersList(ctx, h.Pool, h.Queries, usersListParams{
		Page:  page,
		Query: q,
	})
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "admin users list failed"))
		return
	}

	skip := (page - 1) * pageSize
	hasMore := int64(skip+pageSize) < total

	writeListEnvelope(w, http.StatusOK, userListResponse{
		Data:    items,
		HasMore: hasMore,
		Total:   total,
		Page:    page,
	})
}
