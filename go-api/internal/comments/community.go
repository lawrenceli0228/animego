package comments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/pii"
)

const (
	defaultSummaryPreview = 2
	maxSummaryPreview     = 5
	defaultTrendingLimit  = 6
	maxTrendingLimit      = 12
	defaultWindowHours    = 7 * 24
	minWindowHours        = 24
	maxWindowHours        = 30 * 24
	defaultMetricsDays    = 7
	maxMetricsDays        = 90
)

type commentSummaryPreview struct {
	ID               uuid.UUID          `json:"id"`
	UserID           uuid.UUID          `json:"userId"`
	Username         string             `json:"username"`
	AvatarURL        *string            `json:"avatarUrl"`
	BackdropCoverURL *string            `json:"backdropCoverUrl"`
	Content          string             `json:"content"`
	IsSpoiler        bool               `json:"isSpoiler"`
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

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	var viewerUserID *uuid.UUID
	if claims, ok := jwtx.ClaimsFrom(r.Context()); ok && claims != nil {
		viewerUserID = &claims.UserID
	}
	rows, err := h.Queries.ListEpisodeCommentSummaries(ctx, int32(preview), int32(anilistID), viewerUserID)
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
			Username:         pii.PublicUsername(row.Username),
			AvatarURL:        row.AvatarUrl,
			BackdropCoverURL: row.BackdropCoverUrl,
			Content:          row.Content,
			IsSpoiler:        row.IsSpoiler,
			CreatedAt:        row.CreatedAt,
		})
	}
	httpx.Data(w, http.StatusOK, items)
}

type trendingDiscussionLatest struct {
	ID        uuid.UUID          `json:"id"`
	Username  string             `json:"username"`
	AvatarURL *string            `json:"avatarUrl"`
	Content   string             `json:"content"`
	IsSpoiler bool               `json:"isSpoiler"`
	CreatedAt pgtype.Timestamptz `json:"createdAt"`
}

type trendingDiscussionItem struct {
	AnilistID        int32                    `json:"anilistId"`
	Episode          int32                    `json:"episode"`
	TitleRomaji      *string                  `json:"titleRomaji"`
	TitleEnglish     *string                  `json:"titleEnglish"`
	TitleNative      *string                  `json:"titleNative"`
	TitleChinese     *string                  `json:"titleChinese"`
	TitleHant        *string                  `json:"titleHant"`
	TitleHantSource  *string                  `json:"titleHantSource"`
	TitleHantSeo     *string                  `json:"titleHantSeo"`
	CoverImageURL    *string                  `json:"coverImageUrl"`
	PosterAccent     *string                  `json:"posterAccent"`
	CommentCount     int64                    `json:"commentCount"`
	ParticipantCount int64                    `json:"participantCount"`
	ReactionCount    int64                    `json:"reactionCount"`
	Latest           trendingDiscussionLatest `json:"latest"`
}

// ListTrendingDiscussions implements GET /api/community/discussions/trending.
// It exposes a compact, spoiler-safe discovery list ranked by participation,
// volume, reactions, and recency.  OptionalAuth keeps block policy consistent
// with the episode grid without making the public homepage require a session.
func (h *Handlers) ListTrendingDiscussions(w http.ResponseWriter, r *http.Request) {
	limit := clampIntQuery(r, "limit", defaultTrendingLimit, 1, maxTrendingLimit)
	windowHours := clampIntQuery(r, "windowHours", defaultWindowHours, minWindowHours, maxWindowHours)

	var viewerUserID *uuid.UUID
	if claims, ok := jwtx.ClaimsFrom(r.Context()); ok && claims != nil {
		viewerUserID = &claims.UserID
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	rows, err := h.Queries.ListTrendingDiscussions(ctx, int32(limit), int32(windowHours), viewerUserID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "trending discussions query failed"))
		return
	}
	items := make([]trendingDiscussionItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, trendingDiscussionItem{
			AnilistID:        row.AnilistID,
			Episode:          row.Episode,
			TitleRomaji:      row.TitleRomaji,
			TitleEnglish:     row.TitleEnglish,
			TitleNative:      row.TitleNative,
			TitleChinese:     row.TitleChinese,
			TitleHant:        row.TitleHant,
			TitleHantSource:  row.TitleHantSource,
			TitleHantSeo:     row.TitleHantSeo,
			CoverImageURL:    row.CoverImageUrl,
			PosterAccent:     row.PosterAccent,
			CommentCount:     row.CommentCount,
			ParticipantCount: row.ParticipantCount,
			ReactionCount:    row.ReactionCount,
			Latest: trendingDiscussionLatest{
				ID:        row.LatestCommentID,
				Username:  pii.PublicUsername(row.LatestUsername),
				AvatarURL: row.LatestAvatarUrl,
				Content:   row.LatestContent,
				IsSpoiler: row.LatestIsSpoiler,
				CreatedAt: row.LatestCreatedAt,
			},
		})
	}
	httpx.Data(w, http.StatusOK, items)
}

type communityEngagementRequest struct {
	EventType string `json:"eventType"`
	Source    string `json:"source"`
	AnilistID int32  `json:"anilistId"`
	Episode   int32  `json:"episode"`
}

// TrackCommunityEngagement implements POST /api/community/engagement.  It
// increments a daily aggregate only; no per-user or anonymous browsing record
// is retained.  Authentication is captured as a boolean segment, never an ID.
func (h *Handlers) TrackCommunityEngagement(w http.ResponseWriter, r *http.Request) {
	var req communityEngagementRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validCommunityEngagement(req) {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Invalid community engagement event"))
		return
	}
	_, authenticated := jwtx.ClaimsFrom(r.Context())
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	if _, err := h.Queries.TrackCommunityEngagement(ctx, req.EventType, req.Source, req.AnilistID, req.Episode, authenticated); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "community engagement write failed"))
		return
	}
	httpx.Data(w, http.StatusAccepted, map[string]bool{"tracked": true})
}

type communityMetricsResponse struct {
	Days        int     `json:"days"`
	Impressions int64   `json:"impressions"`
	Opens       int64   `json:"opens"`
	OpenRate    float64 `json:"openRate"`
}

// CommunityMetrics implements the admin-only GET
// /api/admin/community-metrics.  Auth/admin checks stay in router middleware.
func (h *Handlers) CommunityMetrics(w http.ResponseWriter, r *http.Request) {
	days := clampIntQuery(r, "days", defaultMetricsDays, 1, maxMetricsDays)
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	row, err := h.Queries.GetCommunityEngagementSummary(ctx, int32(days))
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "community metrics query failed"))
		return
	}
	openRate := 0.0
	if row.ImpressionCount > 0 {
		openRate = float64(row.OpenCount) / float64(row.ImpressionCount)
	}
	httpx.Data(w, http.StatusOK, communityMetricsResponse{
		Days:        days,
		Impressions: row.ImpressionCount,
		Opens:       row.OpenCount,
		OpenRate:    openRate,
	})
}

func clampIntQuery(r *http.Request, key string, fallback, minValue, maxValue int) int {
	value := fallback
	if raw := r.URL.Query().Get(key); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			value = parsed
		}
	}
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func validCommunityEngagement(req communityEngagementRequest) bool {
	if req.Source != "home" && req.Source != "seasonal" {
		return false
	}
	switch req.EventType {
	case "hot_discussions_impression":
		return req.AnilistID == 0 && req.Episode == 0
	case "discussion_open":
		return req.AnilistID > 0 && req.Episode > 0
	default:
		return false
	}
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
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	comment, err := h.Queries.GetCommentByID(ctx, commentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgCommentNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "comment lookup failed"))
		return
	}
	// UserBlockExists is symmetric, so this one lookup rejects the reaction
	// whether the comment's author blocked the reactor or vice versa.
	blocked, err := h.Queries.UserBlockExists(ctx, claims.UserID, comment.UserID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "block lookup failed"))
		return
	}
	if blocked {
		httpx.Fail(w, httpx.NewError(http.StatusForbidden, httpx.CodeForbidden, "Interaction unavailable"))
		return
	}

	var response commentReactionResponse
	if reacted {
		row, err := h.Queries.UpsertCommentReactionWithNotification(ctx, commentID, claims.UserID)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "comment reaction failed"))
			return
		}
		response = commentReactionResponse{Reacted: row.Reacted, Count: row.ReactionCount}
	} else {
		row, err := h.Queries.DeleteCommentReaction(ctx, commentID, claims.UserID)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "delete comment reaction failed"))
			return
		}
		response = commentReactionResponse{Reacted: false, Count: row.ReactionCount}
	}
	httpx.Data(w, http.StatusOK, response)
}
