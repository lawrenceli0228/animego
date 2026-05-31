package social

// follow.go — POST + DELETE /api/users/:username/follow.  Both
// endpoints require auth (jwtx.RequireAuth wired upstream); we
// double-check ClaimsFrom defensively in case the middleware was
// misconfigured at the router level.
//
// Replaces server/controllers/follow.controller.js follow + unfollow.
// Express used Mongoose findOneAndUpdate(upsert:true) / findOneAndDelete;
// here we go through dbgen.UpsertFollow (ON CONFLICT DO NOTHING) and
// dbgen.DeleteFollow (Postgres execrows) for the same idempotent
// semantics — re-following or un-following an already-not-followed
// account is a no-op success, not an error.

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// Follow implements POST /api/users/:username/follow.
//
// Flow:
//  1. ClaimsFrom — defensive (route is behind RequireAuth).  Missing
//     claims → 500 SERVER_ERROR (routing bug).
//  2. GetUserIDByUsername — pgx.ErrNoRows → 404 NOT_FOUND.
//  3. Self-follow guard — followee.ID == claims.UserID → 400
//     INVALID_ACTION "Cannot follow yourself".
//  4. UpsertFollow — ON CONFLICT DO NOTHING means re-following is a
//     201 no-op success (Express's findOneAndUpdate({upsert:true}) does
//     the same).
//  5. 201 CREATED with { data: { following: true } }.
func (h *Handlers) Follow(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, httpx.CodeServerError, msgMissingAuthClaims))
		return
	}

	username := chi.URLParam(r, "username")
	followee, err := h.Queries.GetUserIDByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "follow lookup failed"))
		return
	}

	if followee.ID == claims.UserID {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidAction, msgCannotFollowSelf))
		return
	}

	if err := h.Queries.UpsertFollow(ctx, claims.UserID, followee.ID); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "follow insert failed"))
		return
	}

	httpx.Data(w, http.StatusCreated, followToggleResponse{Following: true})
}

// Unfollow implements DELETE /api/users/:username/follow.
//
// Flow:
//  1. ClaimsFrom — defensive.  Missing claims → 500 SERVER_ERROR.
//  2. GetUserIDByUsername — pgx.ErrNoRows → 404 NOT_FOUND.
//  3. DeleteFollow — return value (rowsAffected) is intentionally
//     IGNORED.  Express returns 200 { following: false } whether a
//     row was deleted or not (findOneAndDelete returning null is not
//     an error in the Express flow), so we match.
//  4. 200 OK with { data: { following: false } }.
func (h *Handlers) Unfollow(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, httpx.CodeServerError, msgMissingAuthClaims))
		return
	}

	username := chi.URLParam(r, "username")
	followee, err := h.Queries.GetUserIDByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "unfollow lookup failed"))
		return
	}

	if _, err := h.Queries.DeleteFollow(ctx, claims.UserID, followee.ID); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "follow delete failed"))
		return
	}

	httpx.Data(w, http.StatusOK, followToggleResponse{Following: false})
}
