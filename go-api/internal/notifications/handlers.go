// Package notifications implements the authenticated in-app notification inbox.
package notifications

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/pii"
)

const (
	queryTimeout = 5 * time.Second
	defaultLimit = 20
	maxLimit     = 50
)

type DB interface {
	CountUnreadNotifications(ctx context.Context, userID uuid.UUID) (int64, error)
	ListNotifications(ctx context.Context, userID uuid.UUID, pageLimit int32) ([]dbgen.ListNotificationsRow, error)
	MarkNotificationRead(ctx context.Context, notificationID uuid.UUID, userID uuid.UUID) (dbgen.Notification, error)
	MarkAllNotificationsRead(ctx context.Context, userID uuid.UUID) (int64, error)
}

type Handlers struct{ db DB }

func NewHandlers(db DB) *Handlers {
	if db == nil {
		panic("notifications.NewHandlers: nil DB")
	}
	return &Handlers{db: db}
}

type unreadResponse struct {
	UnreadCount int64 `json:"unreadCount"`
}

func claims(w http.ResponseWriter, r *http.Request) (*jwtx.AccessClaims, bool) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, "Authentication required"))
		return nil, false
	}
	return claims, true
}

func (h *Handlers) UnreadCount(w http.ResponseWriter, r *http.Request) {
	claims, ok := claims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	count, err := h.db.CountUnreadNotifications(ctx, claims.UserID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "notification count failed"))
		return
	}
	httpx.Data(w, http.StatusOK, unreadResponse{UnreadCount: count})
}

type actorResponse struct {
	Username  string  `json:"username"`
	AvatarURL *string `json:"avatarUrl"`
}

type animeResponse struct {
	AnilistID     int32   `json:"anilistId"`
	Title         string  `json:"title"`
	TitleChinese  *string `json:"titleChinese"`
	CoverImageURL *string `json:"coverImageUrl"`
}

type itemResponse struct {
	ID        uuid.UUID          `json:"id"`
	Type      string             `json:"type"`
	Actor     actorResponse      `json:"actor"`
	Anime     *animeResponse     `json:"anime"`
	Episode   *int32             `json:"episode"`
	CommentID *uuid.UUID         `json:"commentId"`
	Excerpt   *string            `json:"excerpt"`
	IsSpoiler bool               `json:"isSpoiler"`
	CreatedAt pgtype.Timestamptz `json:"createdAt"`
	ReadAt    pgtype.Timestamptz `json:"readAt"`
}

type listResponse struct {
	Items       []itemResponse `json:"items"`
	UnreadCount int64          `json:"unreadCount"`
}

func (h *Handlers) List(w http.ResponseWriter, r *http.Request) {
	claims, ok := claims(w, r)
	if !ok {
		return
	}
	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	var rows []dbgen.ListNotificationsRow
	var unread int64
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		var err error
		rows, err = h.db.ListNotifications(gctx, claims.UserID, int32(limit))
		return err
	})
	g.Go(func() error {
		var err error
		unread, err = h.db.CountUnreadNotifications(gctx, claims.UserID)
		return err
	})
	if err := g.Wait(); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "notification list failed"))
		return
	}

	items := make([]itemResponse, 0, len(rows))
	for _, row := range rows {
		item := itemResponse{
			ID:        row.ID,
			Type:      notificationType(row.NotificationType),
			Actor:     actorResponse{Username: pii.PublicUsername(row.ActorUsername), AvatarURL: row.ActorAvatarUrl},
			Episode:   row.Episode,
			CommentID: row.CommentID,
			Excerpt:   row.CommentContent,
			IsSpoiler: row.CommentIsSpoiler,
			CreatedAt: row.CreatedAt,
			ReadAt:    row.ReadAt,
		}
		if row.AnilistID != nil {
			title := "Anime #" + strconv.FormatInt(int64(*row.AnilistID), 10)
			if row.TitleRomaji != nil && *row.TitleRomaji != "" {
				title = *row.TitleRomaji
			}
			item.Anime = &animeResponse{
				AnilistID:     *row.AnilistID,
				Title:         title,
				TitleChinese:  row.TitleChinese,
				CoverImageURL: row.CoverImageUrl,
			}
		}
		items = append(items, item)
	}
	httpx.Data(w, http.StatusOK, listResponse{Items: items, UnreadCount: unread})
}

func notificationType(dbType string) string {
	switch dbType {
	case "reply":
		return "comment_reply"
	case "reaction":
		return "comment_reaction"
	default:
		return "follow"
	}
}

func (h *Handlers) MarkRead(w http.ResponseWriter, r *http.Request) {
	claims, ok := claims(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "Invalid notification ID"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	row, err := h.db.MarkNotificationRead(ctx, id, claims.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "Notification not found"))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "mark notification read failed"))
		return
	}
	httpx.Data(w, http.StatusOK, struct {
		ID     uuid.UUID          `json:"id"`
		ReadAt pgtype.Timestamptz `json:"readAt"`
	}{ID: row.ID, ReadAt: row.ReadAt})
}

func (h *Handlers) MarkAllRead(w http.ResponseWriter, r *http.Request) {
	claims, ok := claims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	updated, err := h.db.MarkAllNotificationsRead(ctx, claims.UserID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "mark notifications read failed"))
		return
	}
	httpx.Data(w, http.StatusOK, struct {
		Updated int64 `json:"updated"`
	}{Updated: updated})
}
