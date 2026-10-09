package community

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// The moderation removals, mounted under /api/admin beside the report
// queue: the same soft delete an author performs, with the admin recorded as
// deleted_by.  They take the id alone — a moderator arrives from a report,
// which knows the item but not necessarily its anime — and answer 404 for
// something already gone, so a second click is harmless.

// AdminRemoveReview implements DELETE /api/admin/community/reviews/{reviewId}.
func (h *Handlers) AdminRemoveReview(w http.ResponseWriter, r *http.Request) {
	h.adminRemove(w, r, "reviewId", msgReviewNotFound, h.db.SoftDeleteAnimeReview)
}

// AdminRemoveThread implements DELETE /api/admin/community/threads/{threadId}.
func (h *Handlers) AdminRemoveThread(w http.ResponseWriter, r *http.Request) {
	h.adminRemove(w, r, "threadId", msgThreadNotFound, h.db.SoftDeleteAnimeThread)
}

// AdminRemoveReply implements DELETE /api/admin/community/replies/{replyId}.
func (h *Handlers) AdminRemoveReply(w http.ResponseWriter, r *http.Request) {
	h.adminRemove(w, r, "replyId", msgReplyNotFound, h.db.SoftDeleteCommunityReply)
}

type softDelete func(ctx context.Context, actorID uuid.UUID, id uuid.UUID) (int64, error)

func (h *Handlers) adminRemove(w http.ResponseWriter, r *http.Request, param, notFound string, remove softDelete) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	id, ok := uuidFromPath(w, r, param)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	removed, err := remove(ctx, claims.UserID, id)
	if err != nil {
		failServer(w, err, "admin removal failed")
		return
	}
	if removed == 0 {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, notFound))
		return
	}
	httpx.Data(w, http.StatusOK, deletedDTO{Deleted: true})
}
