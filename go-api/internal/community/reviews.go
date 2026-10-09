package community

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// pgUniqueViolation is the SQLSTATE a second live review trips on
// (anime_reviews_one_live_per_user).
const pgUniqueViolation = "23505"

type reviewRequest struct {
	Summary   string `json:"summary"`
	Body      string `json:"body"`
	IsSpoiler bool   `json:"isSpoiler"`
	IsPrivate bool   `json:"isPrivate"`
}

// ListReviews implements GET /reviews: the visible reviews of one anime,
// most helpful first, then newest.  A spoiler review's body is left out of
// the list (bodyHidden); GET /reviews/{id} returns it.
func (h *Handlers) ListReviews(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	page, limit := pageParams(r)
	result, err := h.reviewPage(ctx, anilistID, viewerID(r), page, limit)
	if err != nil {
		failServer(w, err, "list reviews failed")
		return
	}
	httpx.Data(w, http.StatusOK, result)
}

func (h *Handlers) reviewPage(ctx context.Context, anilistID int32, viewer *uuid.UUID, page, limit int) (pageDTO[reviewDTO], error) {
	rows, err := h.db.QueryAnimeReviews(ctx, dbgen.QueryAnimeReviewsParams{
		ViewerID:   viewer,
		AnilistID:  anilistID,
		PageOffset: pageOffset(page, limit),
		PageLimit:  int32(limit),
	})
	if err != nil {
		return pageDTO[reviewDTO]{}, err
	}
	total, err := h.db.CountAnimeReviews(ctx, anilistID, viewer)
	if err != nil {
		return pageDTO[reviewDTO]{}, err
	}
	items := make([]reviewDTO, 0, len(rows))
	for _, row := range rows {
		items = append(items, toReview(row, viewer, false))
	}
	return pageOf(items, total, page, limit), nil
}

// oneReview reads a single review through the same visibility rules as the
// list, body included.  ErrNoRows when the viewer cannot see it.
func (h *Handlers) oneReview(ctx context.Context, anilistID int32, reviewID uuid.UUID, viewer *uuid.UUID) (reviewDTO, error) {
	rows, err := h.db.QueryAnimeReviews(ctx, dbgen.QueryAnimeReviewsParams{
		ViewerID:  viewer,
		AnilistID: anilistID,
		ReviewID:  &reviewID,
		PageLimit: 1,
	})
	if err != nil {
		return reviewDTO{}, err
	}
	if len(rows) == 0 {
		return reviewDTO{}, pgx.ErrNoRows
	}
	return toReview(rows[0], viewer, true), nil
}

// GetReview implements GET /reviews/{reviewId}.  A private review is a 404
// to everyone but its author, as is a deleted one.
func (h *Handlers) GetReview(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	reviewID, ok := uuidFromPath(w, r, "reviewId")
	if !ok {
		return
	}
	review, err := h.oneReview(ctx, anilistID, reviewID, viewerID(r))
	if err != nil {
		failLookup(w, err, msgReviewNotFound)
		return
	}
	httpx.Data(w, http.StatusOK, review)
}

// MyReview implements GET /reviews/mine: the signed-in user's live review of
// this anime, private or not.  404 when they have not written one — the
// write page uses that to choose between writing and editing.
func (h *Handlers) MyReview(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	viewer := claims.UserID
	rows, err := h.db.QueryAnimeReviews(ctx, dbgen.QueryAnimeReviewsParams{
		ViewerID:  &viewer,
		AnilistID: anilistID,
		AuthorID:  &viewer,
		PageLimit: 1,
	})
	if err != nil {
		failServer(w, err, "my review lookup failed")
		return
	}
	if len(rows) == 0 {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgReviewNotFound))
		return
	}
	httpx.Data(w, http.StatusOK, toReview(rows[0], &viewer, true))
}

// CreateReview implements POST /reviews.  One live review per user per
// anime: a second one is 409, and the page sends the author to edit the one
// they have.  There is no score field, by design.
func (h *Handlers) CreateReview(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	input, ok := decodeReview(w, r)
	if !ok {
		return
	}
	if rateLimited(w, h.limits.reviews, claims.UserID) {
		return
	}
	id, err := h.db.CreateAnimeReview(ctx, dbgen.CreateAnimeReviewParams{
		AnilistID: anilistID,
		UserID:    claims.UserID,
		Summary:   input.Summary,
		Body:      input.Body,
		IsSpoiler: input.IsSpoiler,
		IsPrivate: input.IsPrivate,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			httpx.Fail(w, httpx.NewError(http.StatusConflict, httpx.CodeConflict, msgAlreadyReviewed))
			return
		}
		failServer(w, err, "create review failed")
		return
	}
	viewer := claims.UserID
	review, err := h.oneReview(ctx, anilistID, id, &viewer)
	if err != nil {
		failServer(w, err, "read back review failed")
		return
	}
	httpx.Data(w, http.StatusCreated, review)
}

// UpdateReview implements PATCH /reviews/{reviewId}: the author rewrites
// their review — summary, body and both flags, all of them every time.
func (h *Handlers) UpdateReview(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	reviewID, ok := uuidFromPath(w, r, "reviewId")
	if !ok {
		return
	}
	if !h.ownReview(ctx, w, reviewID, anilistID, claims.UserID) {
		return
	}
	input, ok := decodeReview(w, r)
	if !ok {
		return
	}
	if rateLimited(w, h.limits.reviews, claims.UserID) {
		return
	}
	if _, err := h.db.UpdateAnimeReview(ctx, dbgen.UpdateAnimeReviewParams{
		Summary:   input.Summary,
		Body:      input.Body,
		IsSpoiler: input.IsSpoiler,
		IsPrivate: input.IsPrivate,
		ReviewID:  reviewID,
		UserID:    claims.UserID,
	}); err != nil {
		// ErrNoRows: deleted between the ownership check and the write.
		failLookup(w, err, msgReviewNotFound)
		return
	}
	viewer := claims.UserID
	review, err := h.oneReview(ctx, anilistID, reviewID, &viewer)
	if err != nil {
		failServer(w, err, "read back review failed")
		return
	}
	httpx.Data(w, http.StatusOK, review)
}

// DeleteReview implements DELETE /reviews/{reviewId}: the author takes their
// review down.  Soft — the row stays, deleted_at and deleted_by set — so a
// report filed against it still points at something.
func (h *Handlers) DeleteReview(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	reviewID, ok := uuidFromPath(w, r, "reviewId")
	if !ok {
		return
	}
	if !h.ownReview(ctx, w, reviewID, anilistID, claims.UserID) {
		return
	}
	if _, err := h.db.SoftDeleteAnimeReview(ctx, claims.UserID, reviewID); err != nil {
		failServer(w, err, "delete review failed")
		return
	}
	httpx.Data(w, http.StatusOK, deletedDTO{Deleted: true})
}

// ownReview answers 404 for a review that is gone, belongs to another anime,
// or is someone else's private review (it does not exist for them), and 403
// for someone else's public one.  Reports whether the caller may go on.
func (h *Handlers) ownReview(ctx context.Context, w http.ResponseWriter, reviewID uuid.UUID, anilistID int32, userID uuid.UUID) bool {
	meta, err := h.db.GetAnimeReviewMeta(ctx, reviewID)
	if err != nil {
		failLookup(w, err, msgReviewNotFound)
		return false
	}
	if meta.Deleted || meta.AnilistID != anilistID || (meta.IsPrivate && meta.UserID != userID) {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgReviewNotFound))
		return false
	}
	if meta.UserID != userID {
		httpx.Fail(w, httpx.NewError(http.StatusForbidden, httpx.CodeForbidden, msgNotYourReview))
		return false
	}
	return true
}

// VoteHelpful implements PUT /reviews/{reviewId}/helpful.  Idempotent; not on
// one's own review, not on one the voter cannot see, not across a block.
func (h *Handlers) VoteHelpful(w http.ResponseWriter, r *http.Request) {
	h.setHelpful(w, r, true)
}

// UnvoteHelpful implements DELETE /reviews/{reviewId}/helpful.
func (h *Handlers) UnvoteHelpful(w http.ResponseWriter, r *http.Request) {
	h.setHelpful(w, r, false)
}

func (h *Handlers) setHelpful(w http.ResponseWriter, r *http.Request, voted bool) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	reviewID, ok := uuidFromPath(w, r, "reviewId")
	if !ok {
		return
	}
	meta, err := h.db.GetAnimeReviewMeta(ctx, reviewID)
	if err != nil {
		failLookup(w, err, msgReviewNotFound)
		return
	}
	if meta.Deleted || meta.AnilistID != anilistID || (meta.IsPrivate && meta.UserID != claims.UserID) {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgReviewNotFound))
		return
	}
	if meta.UserID == claims.UserID {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidAction, msgOwnReview))
		return
	}
	if h.interactionBlocked(ctx, w, claims.UserID, meta.UserID) {
		return
	}
	if rateLimited(w, h.limits.reactions, claims.UserID) {
		return
	}
	var count int64
	if voted {
		count, err = h.db.AddReviewHelpfulVote(ctx, reviewID, claims.UserID)
	} else {
		count, err = h.db.RemoveReviewHelpfulVote(ctx, reviewID, claims.UserID)
	}
	if err != nil {
		failServer(w, err, "helpful vote failed")
		return
	}
	httpx.Data(w, http.StatusOK, voteDTO{Voted: voted, HelpfulCount: count})
}

// decodeReview reads and validates a review body, answering 400 itself.
func decodeReview(w http.ResponseWriter, r *http.Request) (reviewInput, bool) {
	var req reviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgInvalidBody))
		return reviewInput{}, false
	}
	input, msg := validateReview(req.Summary, req.Body, req.IsSpoiler, req.IsPrivate)
	if msg != "" {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msg))
		return reviewInput{}, false
	}
	return input, true
}
