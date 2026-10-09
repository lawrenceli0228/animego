package community

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

type threadRequest struct {
	Title     string `json:"title"`
	Body      string `json:"body"`
	IsSpoiler bool   `json:"isSpoiler"`
}

type replyRequest struct {
	Body      string     `json:"body"`
	IsSpoiler bool       `json:"isSpoiler"`
	ParentID  *uuid.UUID `json:"parentId"`
}

// ListThreads implements GET /threads: busiest conversation first.
func (h *Handlers) ListThreads(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	page, limit := pageParams(r)
	result, err := h.threadPage(ctx, anilistID, viewerID(r), page, limit)
	if err != nil {
		failServer(w, err, "list threads failed")
		return
	}
	httpx.Data(w, http.StatusOK, result)
}

func (h *Handlers) threadPage(ctx context.Context, anilistID int32, viewer *uuid.UUID, page, limit int) (pageDTO[threadSummaryDTO], error) {
	rows, err := h.db.ListAnimeThreads(ctx, viewer, anilistID, pageOffset(page, limit), int32(limit))
	if err != nil {
		return pageDTO[threadSummaryDTO]{}, err
	}
	total, err := h.db.CountAnimeThreads(ctx, anilistID, viewer)
	if err != nil {
		return pageDTO[threadSummaryDTO]{}, err
	}
	items := make([]threadSummaryDTO, 0, len(rows))
	for _, row := range rows {
		items = append(items, toThreadSummary(row, viewer))
	}
	return pageOf(items, total, page, limit), nil
}

// GetThread implements GET /threads/{threadId}: the thread and its replies,
// oldest first.
func (h *Handlers) GetThread(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	threadID, ok := uuidFromPath(w, r, "threadId")
	if !ok {
		return
	}
	viewer := viewerID(r)
	view, err := h.threadView(ctx, anilistID, threadID, viewer)
	if err != nil {
		failLookup(w, err, msgThreadNotFound)
		return
	}
	httpx.Data(w, http.StatusOK, view)
}

func (h *Handlers) threadView(ctx context.Context, anilistID int32, threadID uuid.UUID, viewer *uuid.UUID) (threadViewDTO, error) {
	thread, err := h.db.GetAnimeThread(ctx, threadID, anilistID, viewer)
	if err != nil {
		return threadViewDTO{}, err
	}
	rows, err := h.db.ListThreadReplies(ctx, threadID, viewer)
	if err != nil {
		return threadViewDTO{}, err
	}
	replies := make([]replyDTO, 0, len(rows))
	for _, row := range rows {
		replies = append(replies, toThreadReply(row, viewer))
	}
	return threadViewDTO{Thread: toThread(thread, viewer), Replies: replies}, nil
}

// CreateThread implements POST /threads.  Answers 201 with the new thread
// in its list shape, so the page can put it at the top without a refetch.
func (h *Handlers) CreateThread(w http.ResponseWriter, r *http.Request) {
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
	var req threadRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	title, body, msg := validateThread(req.Title, req.Body)
	if msg != "" {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msg))
		return
	}
	if rateLimited(w, h.limits.threads, claims.UserID) {
		return
	}
	id, err := h.db.CreateAnimeThread(ctx, anilistID, claims.UserID, title, body, req.IsSpoiler)
	if err != nil {
		failServer(w, err, "create thread failed")
		return
	}
	viewer := claims.UserID
	view, err := h.threadView(ctx, anilistID, id, &viewer)
	if err != nil {
		failServer(w, err, "read back thread failed")
		return
	}
	httpx.Data(w, http.StatusCreated, view)
}

// DeleteThread implements DELETE /threads/{threadId}: the author takes their
// thread down (soft), and with it every notification its replies sent.
func (h *Handlers) DeleteThread(w http.ResponseWriter, r *http.Request) {
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
	threadID, ok := uuidFromPath(w, r, "threadId")
	if !ok {
		return
	}
	meta, err := h.db.GetAnimeThreadMeta(ctx, threadID)
	if err != nil {
		failLookup(w, err, msgThreadNotFound)
		return
	}
	if meta.Deleted || meta.AnilistID != anilistID {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgThreadNotFound))
		return
	}
	if meta.UserID != claims.UserID {
		httpx.Fail(w, httpx.NewError(http.StatusForbidden, httpx.CodeForbidden, msgNotYourThread))
		return
	}
	if _, err := h.db.SoftDeleteAnimeThread(ctx, claims.UserID, threadID); err != nil {
		failServer(w, err, "delete thread failed")
		return
	}
	httpx.Data(w, http.StatusOK, deletedDTO{Deleted: true})
}

// CreateThreadReply implements POST /threads/{threadId}/replies.  The
// thread's author — and, for a reply to a reply, that reply's author — is
// notified in the same statement.
func (h *Handlers) CreateThreadReply(w http.ResponseWriter, r *http.Request) {
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
	threadID, ok := uuidFromPath(w, r, "threadId")
	if !ok {
		return
	}
	req, body, ok := decodeReply(w, r)
	if !ok {
		return
	}
	meta, err := h.db.GetAnimeThreadMeta(ctx, threadID)
	if err != nil {
		failLookup(w, err, msgThreadNotFound)
		return
	}
	if meta.Deleted || meta.AnilistID != anilistID {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgThreadNotFound))
		return
	}
	if h.interactionBlocked(ctx, w, claims.UserID, meta.UserID) {
		return
	}
	if req.ParentID != nil {
		parent, err := h.db.GetCommunityReplyMeta(ctx, *req.ParentID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			failServer(w, err, "parent lookup failed")
			return
		}
		if err != nil || parent.Deleted || parent.ThreadID == nil || *parent.ThreadID != threadID {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgParentNotFound))
			return
		}
		if h.interactionBlocked(ctx, w, claims.UserID, parent.UserID) {
			return
		}
	}
	if rateLimited(w, h.limits.replies, claims.UserID) {
		return
	}
	created, err := h.db.CreateThreadReply(ctx, threadID, req.ParentID, claims.UserID, body, req.IsSpoiler)
	if err != nil {
		// ErrNoRows: the thread was deleted after the check above.
		failLookup(w, err, msgThreadNotFound)
		return
	}
	h.answerWithReply(ctx, w, created.ID, claims.UserID)
}

// answerWithReply reads a reply this request just wrote back in its list
// shape and answers 201 with it.
func (h *Handlers) answerWithReply(ctx context.Context, w http.ResponseWriter, replyID, viewer uuid.UUID) {
	row, err := h.db.GetCommunityReply(ctx, replyID)
	if err != nil {
		failServer(w, err, "read back reply failed")
		return
	}
	httpx.Data(w, http.StatusCreated, toReply(row, &viewer))
}

// DeleteReply implements DELETE /replies/{replyId}: the author takes their
// reply down (soft), and its notifications with it.  Thread and activity
// replies alike.
func (h *Handlers) DeleteReply(w http.ResponseWriter, r *http.Request) {
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
	replyID, ok := uuidFromPath(w, r, "replyId")
	if !ok {
		return
	}
	meta, err := h.db.GetCommunityReplyMeta(ctx, replyID)
	if err != nil {
		failLookup(w, err, msgReplyNotFound)
		return
	}
	if meta.Deleted || meta.AnilistID != anilistID {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgReplyNotFound))
		return
	}
	if meta.UserID != claims.UserID {
		httpx.Fail(w, httpx.NewError(http.StatusForbidden, httpx.CodeForbidden, msgNotYourReply))
		return
	}
	if _, err := h.db.SoftDeleteCommunityReply(ctx, claims.UserID, replyID); err != nil {
		failServer(w, err, "delete reply failed")
		return
	}
	httpx.Data(w, http.StatusOK, deletedDTO{Deleted: true})
}

// decodeReply reads and validates a reply body, answering 400 itself.
func decodeReply(w http.ResponseWriter, r *http.Request) (replyRequest, string, bool) {
	var req replyRequest
	if !decodeJSON(w, r, &req) {
		return replyRequest{}, "", false
	}
	body, msg := validateReply(req.Body)
	if msg != "" {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msg))
		return replyRequest{}, "", false
	}
	return req, body, true
}
