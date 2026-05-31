package social

// followers.go — GET /api/users/:username/followers and
// /api/users/:username/following.  Both are paginated, public (no auth
// required), and emit the standard httpx.Page envelope:
//
//	{ "data": [...], "total": int, "page": int, "hasMore": bool, "nextPage": int|null }
//
// Replaces server/controllers/follow.controller.js paginateFollows.
// Express filtered Follow + populated the username via Mongoose; we
// JOIN users in SQL (see ListFollowers / ListFollowing in social.sql)
// so the response materialises in one query each, with a parallel
// COUNT for total.

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// ListFollowers implements GET /api/users/:username/followers?page=1.
// Per-page size is 20 (Express literal).
func (h *Handlers) ListFollowers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	username := chi.URLParam(r, "username")
	user, err := h.Queries.GetUserIDByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "followers lookup failed"))
		return
	}

	page := parsePage(r)
	offset := int32((page - 1) * listPageSize)

	var (
		rows  []dbgen.ListFollowersRow
		total int64
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		got, err := h.Queries.ListFollowers(gctx, user.ID, listPageSize, offset)
		if err != nil {
			return err
		}
		rows = got
		return nil
	})
	g.Go(func() error {
		got, err := h.Queries.CountFollowers(gctx, user.ID)
		if err != nil {
			return err
		}
		total = got
		return nil
	})
	if err := g.Wait(); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "followers query failed"))
		return
	}

	items := make([]followListItem, len(rows))
	for i, row := range rows {
		items[i] = followListItem{Username: row.Username}
	}
	writeFollowListEnvelope(w, items, total, page)
}

// ListFollowing implements GET /api/users/:username/following?page=1.
// Same shape as ListFollowers but uses the reverse FK direction
// (ListFollowing + CountFollowing).
func (h *Handlers) ListFollowing(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	username := chi.URLParam(r, "username")
	user, err := h.Queries.GetUserIDByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "following lookup failed"))
		return
	}

	page := parsePage(r)
	offset := int32((page - 1) * listPageSize)

	var (
		rows  []dbgen.ListFollowingRow
		total int64
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		got, err := h.Queries.ListFollowing(gctx, user.ID, listPageSize, offset)
		if err != nil {
			return err
		}
		rows = got
		return nil
	})
	g.Go(func() error {
		got, err := h.Queries.CountFollowing(gctx, user.ID)
		if err != nil {
			return err
		}
		total = got
		return nil
	})
	if err := g.Wait(); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "following query failed"))
		return
	}

	items := make([]followListItem, len(rows))
	for i, row := range rows {
		items[i] = followListItem{Username: row.Username}
	}
	writeFollowListEnvelope(w, items, total, page)
}

// writeFollowListEnvelope wraps the paged response in the standard
// httpx.Page envelope.  Computes hasMore + nextPage from total/page.
// Shared by both list endpoints since they emit identical shape.
func writeFollowListEnvelope(w http.ResponseWriter, items []followListItem, total int64, page int) {
	offset := (page - 1) * listPageSize
	hasMore := int64(offset+listPageSize) < total

	pagination := httpx.Pagination{
		Total:   int(total),
		Page:    page,
		HasMore: hasMore,
	}
	if hasMore {
		pagination.NextPage = intPtr(page + 1)
	}

	httpx.Page[followListItem](w, http.StatusOK, items, pagination)
}
