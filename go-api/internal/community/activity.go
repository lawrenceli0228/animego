package community

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	// listRepliesPerEvent is how many replies each event in a list carries;
	// replyCount says when there are more, and GET /activity/{id} returns
	// up to singleEventReplies of them.
	listRepliesPerEvent = 20
	singleEventReplies  = 200
)

// ListActivity implements GET /activity: the anime's status events (看完了,
// 在看, 想看, 弃番), newest first, each with its likes and replies.
func (h *Handlers) ListActivity(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	page, limit := pageParams(r)
	result, err := h.activityPage(ctx, anilistID, viewerID(r), page, limit)
	if err != nil {
		failServer(w, err, "list activity failed")
		return
	}
	httpx.Data(w, http.StatusOK, result)
}

func (h *Handlers) activityPage(ctx context.Context, anilistID int32, viewer *uuid.UUID, page, limit int) (pageDTO[activityDTO], error) {
	rows, err := h.db.QueryAnimeActivity(ctx, viewer, anilistID, nil, pageOffset(page, limit), int32(limit))
	if err != nil {
		return pageDTO[activityDTO]{}, err
	}
	total, err := h.db.CountAnimeActivity(ctx, anilistID, viewer)
	if err != nil {
		return pageDTO[activityDTO]{}, err
	}
	items := make([]activityDTO, 0, len(rows))
	for _, row := range rows {
		items = append(items, toActivity(row, anilistID, viewer))
	}
	if err := h.attachReplies(ctx, items, viewer, listRepliesPerEvent); err != nil {
		return pageDTO[activityDTO]{}, err
	}
	return pageOf(items, total, page, limit), nil
}

// attachReplies fills each event's Replies with one query for the page.
func (h *Handlers) attachReplies(ctx context.Context, items []activityDTO, viewer *uuid.UUID, perEvent int32) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(items))
	index := make(map[uuid.UUID]int, len(items))
	for i, item := range items {
		ids[i] = item.ID
		index[item.ID] = i
	}
	rows, err := h.db.ListActivityReplies(ctx, ids, viewer, perEvent)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.ActivityEventID == nil {
			continue
		}
		if i, ok := index[*row.ActivityEventID]; ok {
			items[i].Replies = append(items[i].Replies, toActivityReply(row, viewer))
		}
	}
	return nil
}

// GetActivity implements GET /activity/{eventId}: one event with all its
// replies — where a notification about an older event lands.
func (h *Handlers) GetActivity(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	eventID, ok := uuidFromPath(w, r, "eventId")
	if !ok {
		return
	}
	viewer := viewerID(r)
	rows, err := h.db.QueryAnimeActivity(ctx, viewer, anilistID, &eventID, 0, 1)
	if err != nil {
		failServer(w, err, "activity lookup failed")
		return
	}
	if len(rows) == 0 {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgActivityNotFound))
		return
	}
	items := []activityDTO{toActivity(rows[0], anilistID, viewer)}
	if err := h.attachReplies(ctx, items, viewer, singleEventReplies); err != nil {
		failServer(w, err, "activity replies failed")
		return
	}
	httpx.Data(w, http.StatusOK, items[0])
}

// visibleEvent answers 404 unless eventID is a status event of this anime
// that the user can see (its owner is public, or it is their own).  Returns
// the event's owner.
func (h *Handlers) visibleEvent(ctx context.Context, w http.ResponseWriter, eventID uuid.UUID, anilistID int32, userID uuid.UUID) (uuid.UUID, bool) {
	meta, err := h.db.GetActivityEventMeta(ctx, eventID)
	if err != nil {
		failLookup(w, err, msgActivityNotFound)
		return uuid.Nil, false
	}
	if meta.EventType != "status" || meta.AnilistID != anilistID || (!meta.OwnerIsPublic && meta.UserID != userID) {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgActivityNotFound))
		return uuid.Nil, false
	}
	return meta.UserID, true
}

// CreateActivityReply implements POST /activity/{eventId}/replies.  The
// event's owner is notified in the same statement.
func (h *Handlers) CreateActivityReply(w http.ResponseWriter, r *http.Request) {
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
	eventID, ok := uuidFromPath(w, r, "eventId")
	if !ok {
		return
	}
	req, body, ok := decodeReply(w, r)
	if !ok {
		return
	}
	owner, ok := h.visibleEvent(ctx, w, eventID, anilistID, claims.UserID)
	if !ok {
		return
	}
	if h.interactionBlocked(ctx, w, claims.UserID, owner) {
		return
	}
	if req.ParentID != nil {
		parent, err := h.db.GetCommunityReplyMeta(ctx, *req.ParentID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			failServer(w, err, "parent lookup failed")
			return
		}
		if err != nil || parent.Deleted || parent.ActivityEventID == nil || *parent.ActivityEventID != eventID {
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
	created, err := h.db.CreateActivityReply(ctx, eventID, claims.UserID, req.ParentID, body)
	if err != nil {
		// ErrNoRows: the event went away, or its owner went private, after
		// the check above.
		failLookup(w, err, msgActivityNotFound)
		return
	}
	h.answerWithReply(ctx, w, created.ID, claims.UserID)
}

// LikeActivity implements PUT /activity/{eventId}/like.  Idempotent.
func (h *Handlers) LikeActivity(w http.ResponseWriter, r *http.Request) {
	h.setLike(w, r, true)
}

// UnlikeActivity implements DELETE /activity/{eventId}/like.
func (h *Handlers) UnlikeActivity(w http.ResponseWriter, r *http.Request) {
	h.setLike(w, r, false)
}

func (h *Handlers) setLike(w http.ResponseWriter, r *http.Request, liked bool) {
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
	eventID, ok := uuidFromPath(w, r, "eventId")
	if !ok {
		return
	}
	owner, ok := h.visibleEvent(ctx, w, eventID, anilistID, claims.UserID)
	if !ok {
		return
	}
	if h.interactionBlocked(ctx, w, claims.UserID, owner) {
		return
	}
	if rateLimited(w, h.limits.reactions, claims.UserID) {
		return
	}
	var (
		count int64
		err   error
	)
	if liked {
		count, err = h.db.AddActivityLike(ctx, eventID, claims.UserID)
	} else {
		count, err = h.db.RemoveActivityLike(ctx, eventID, claims.UserID)
	}
	if err != nil {
		failServer(w, err, "activity like failed")
		return
	}
	httpx.Data(w, http.StatusOK, likeDTO{Liked: liked, LikeCount: count})
}
