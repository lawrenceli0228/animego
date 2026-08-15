package comments

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

const (
	defaultSummaryPreview = 2
	maxSummaryPreview     = 5
)

type commentCommunityDB interface {
	ListEpisodeCommentSummaries(ctx context.Context, previewLimit int32, anilistID int32) ([]dbgen.ListEpisodeCommentSummariesRow, error)
	UpsertCommentReactionWithNotification(ctx context.Context, commentID uuid.UUID, userID uuid.UUID) (dbgen.UpsertCommentReactionWithNotificationRow, error)
	DeleteCommentReaction(ctx context.Context, commentID uuid.UUID, userID uuid.UUID) (dbgen.DeleteCommentReactionRow, error)
}

type commentSummaryPreview struct {
	ID               uuid.UUID          `json:"id"`
	UserID           uuid.UUID          `json:"userId"`
	Username         string             `json:"username"`
	AvatarURL        *string            `json:"avatarUrl"`
	BackdropCoverURL *string            `json:"backdropCoverUrl"`
	Content          string             `json:"content"`
	CreatedAt        pgtype.Timestamptz `json:"createdAt"`
}

type episodeCommentSummary struct {
	Episode int32                   `json:"episode"`
	Count   int64                   `json:"count"`
	Latest  []commentSummaryPreview `json:"latest"`
}

// ListCommentSummaries implements GET /api/comments/summary/:anilistId.
// It returns one compact row per episode, with a full count (replies included)
// and up to five newest top-level comments for the episode-grid preview.
func (h *Handlers) ListCommentSummaries(w http.ResponseWriter, r *http.Request) {
	rawID := chi.URLParam(r, "anilistId")
	anilistID, err := strconv.ParseInt(rawID, 10, 32)
	if err != nil || anilistID < 1 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return
	}

	preview := defaultSummaryPreview
	if raw := r.URL.Query().Get("preview"); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr == nil {
			preview = parsed
		}
	}
	if preview < 1 {
		preview = 1
	}
	if preview > maxSummaryPreview {
		preview = maxSummaryPreview
	}

	db, ok := h.Queries.(commentCommunityDB)
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, httpx.CodeServerError, "community queries unavailable"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	rows, err := db.ListEpisodeCommentSummaries(ctx, int32(preview), int32(anilistID))
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "comment summary query failed"))
		return
	}

	items := make([]episodeCommentSummary, 0)
	index := make(map[int32]int)
	for _, row := range rows {
		i, exists := index[row.Episode]
		if !exists {
			i = len(items)
			index[row.Episode] = i
			items = append(items, episodeCommentSummary{
				Episode: row.Episode,
				Count:   row.CommentCount,
				Latest:  []commentSummaryPreview{},
			})
		}
		items[i].Latest = append(items[i].Latest, commentSummaryPreview{
			ID:               row.ID,
			UserID:           row.UserID,
			Username:         row.Username,
			AvatarURL:        row.AvatarUrl,
			BackdropCoverURL: row.BackdropCoverUrl,
			Content:          row.Content,
			CreatedAt:        row.CreatedAt,
		})
	}
	httpx.Data(w, http.StatusOK, items)
}

type commentReactionResponse struct {
	Reacted bool  `json:"reacted"`
	Count   int64 `json:"count"`
}

func (h *Handlers) PutCommentReaction(w http.ResponseWriter, r *http.Request) {
	h.setCommentReaction(w, r, true)
}

func (h *Handlers) DeleteCommentReaction(w http.ResponseWriter, r *http.Request) {
	h.setCommentReaction(w, r, false)
}

func (h *Handlers) setCommentReaction(w http.ResponseWriter, r *http.Request, reacted bool) {
	commentID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return
	}
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, msgLoginAgain))
		return
	}
	db, ok := h.Queries.(commentCommunityDB)
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, httpx.CodeServerError, "community queries unavailable"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	if _, err := h.Queries.GetCommentByID(ctx, commentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgCommentNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "comment lookup failed"))
		return
	}

	var response commentReactionResponse
	if reacted {
		row, err := db.UpsertCommentReactionWithNotification(ctx, commentID, claims.UserID)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "comment reaction failed"))
			return
		}
		response = commentReactionResponse{Reacted: row.Reacted, Count: row.ReactionCount}
	} else {
		row, err := db.DeleteCommentReaction(ctx, commentID, claims.UserID)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "delete comment reaction failed"))
			return
		}
		response = commentReactionResponse{Reacted: false, Count: row.ReactionCount}
	}
	httpx.Data(w, http.StatusOK, response)
}
