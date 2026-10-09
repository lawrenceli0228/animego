// Package community owns the community tab of an anime page (migration
// 0046): reviews and their helpful votes, discussion threads, replies under
// a thread or an activity event, activity likes, and who follows the anime.
//
// Every route lives under /api/anime/{anilistId}/community:
//
//	GET    /                                summary: first page of each list   (optional auth)
//	GET    /reviews                         reviews, most helpful first        (optional auth)
//	GET    /reviews/mine                    the viewer's own review            (auth)
//	GET    /reviews/{reviewId}              one review, body included          (optional auth)
//	POST   /reviews                         write a review                     (auth)
//	PATCH  /reviews/{reviewId}              edit one's own review              (auth)
//	DELETE /reviews/{reviewId}              delete one's own review (soft)     (auth)
//	PUT    /reviews/{reviewId}/helpful      vote 有用                           (auth)
//	DELETE /reviews/{reviewId}/helpful      take the vote back                 (auth)
//	GET    /threads                         threads, busiest first             (optional auth)
//	POST   /threads                         start a thread                     (auth)
//	GET    /threads/{threadId}              a thread with its replies          (optional auth)
//	DELETE /threads/{threadId}              delete one's own thread (soft)     (auth)
//	POST   /threads/{threadId}/replies      reply in a thread                  (auth)
//	GET    /activity                        status events, newest first        (optional auth)
//	GET    /activity/{eventId}              one event with all its replies     (optional auth)
//	POST   /activity/{eventId}/replies      reply to an event                  (auth)
//	PUT    /activity/{eventId}/like         like an event                      (auth)
//	DELETE /activity/{eventId}/like         unlike                             (auth)
//	DELETE /replies/{replyId}               delete one's own reply (soft)      (auth)
//	GET    /watchers                        谁在追: everyone with it on a list (optional auth)
//
// and an admin's removal sits with the other admin routes:
//
//	DELETE /api/admin/community/{reviews|threads|replies}/{id}
//
// Reads are public; a signed-in reader additionally sees their own private
// reviews and their own votes and likes, and stops seeing anyone on either
// side of a block with them.  Writes need a session, are rate limited per
// user (see Limits), and never reach AniList: an anime the catalogue does
// not already hold is a 404 here.
package community

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// queryTimeout bounds every database round trip, the 5s every other handler
// package uses.
const queryTimeout = 5 * time.Second

// DB is the sqlc subset this package uses.  Declared here, at the use site,
// so a fake can stand in for it in tests and so a Queries value that stops
// providing a method fails to compile rather than failing at request time.
type DB interface {
	CommunityAnimeExists(ctx context.Context, anilistID int32) (bool, error)

	QueryAnimeReviews(ctx context.Context, arg dbgen.QueryAnimeReviewsParams) ([]dbgen.QueryAnimeReviewsRow, error)
	CountAnimeReviews(ctx context.Context, anilistID int32, viewerID *uuid.UUID) (int64, error)
	GetAnimeReviewMeta(ctx context.Context, id uuid.UUID) (dbgen.GetAnimeReviewMetaRow, error)
	CreateAnimeReview(ctx context.Context, arg dbgen.CreateAnimeReviewParams) (uuid.UUID, error)
	UpdateAnimeReview(ctx context.Context, arg dbgen.UpdateAnimeReviewParams) (uuid.UUID, error)
	SoftDeleteAnimeReview(ctx context.Context, actorID uuid.UUID, reviewID uuid.UUID) (int64, error)
	AddReviewHelpfulVote(ctx context.Context, reviewID uuid.UUID, userID uuid.UUID) (int64, error)
	RemoveReviewHelpfulVote(ctx context.Context, reviewID uuid.UUID, userID uuid.UUID) (int64, error)

	ListAnimeThreads(ctx context.Context, viewerID *uuid.UUID, anilistID int32, pageOffset int32, pageLimit int32) ([]dbgen.ListAnimeThreadsRow, error)
	CountAnimeThreads(ctx context.Context, anilistID int32, viewerID *uuid.UUID) (int64, error)
	GetAnimeThread(ctx context.Context, threadID uuid.UUID, anilistID int32, viewerID *uuid.UUID) (dbgen.GetAnimeThreadRow, error)
	GetAnimeThreadMeta(ctx context.Context, id uuid.UUID) (dbgen.GetAnimeThreadMetaRow, error)
	CreateAnimeThread(ctx context.Context, anilistID int32, userID uuid.UUID, title string, body string, isSpoiler bool) (uuid.UUID, error)
	SoftDeleteAnimeThread(ctx context.Context, actorID uuid.UUID, threadID uuid.UUID) (int64, error)

	ListThreadReplies(ctx context.Context, threadID uuid.UUID, viewerID *uuid.UUID) ([]dbgen.ListThreadRepliesRow, error)
	ListActivityReplies(ctx context.Context, eventIds []uuid.UUID, viewerID *uuid.UUID, perEventLimit int32) ([]dbgen.ListActivityRepliesRow, error)
	GetCommunityReply(ctx context.Context, id uuid.UUID) (dbgen.GetCommunityReplyRow, error)
	GetCommunityReplyMeta(ctx context.Context, id uuid.UUID) (dbgen.GetCommunityReplyMetaRow, error)
	CreateThreadReply(ctx context.Context, threadID uuid.UUID, parentID *uuid.UUID, userID uuid.UUID, body string, isSpoiler bool) (dbgen.CreateThreadReplyRow, error)
	CreateActivityReply(ctx context.Context, eventID uuid.UUID, userID uuid.UUID, parentID *uuid.UUID, body string) (dbgen.CreateActivityReplyRow, error)
	SoftDeleteCommunityReply(ctx context.Context, actorID uuid.UUID, replyID uuid.UUID) (int64, error)

	QueryAnimeActivity(ctx context.Context, viewerID *uuid.UUID, anilistID int32, eventID *uuid.UUID, pageOffset int32, pageLimit int32) ([]dbgen.QueryAnimeActivityRow, error)
	CountAnimeActivity(ctx context.Context, anilistID int32, viewerID *uuid.UUID) (int64, error)
	GetActivityEventMeta(ctx context.Context, id uuid.UUID) (dbgen.GetActivityEventMetaRow, error)
	AddActivityLike(ctx context.Context, eventID uuid.UUID, userID uuid.UUID) (int64, error)
	RemoveActivityLike(ctx context.Context, eventID uuid.UUID, userID uuid.UUID) (int64, error)

	ListAnimeFollowers(ctx context.Context, anilistID int32, viewerID *uuid.UUID, pageLimit int32) ([]dbgen.ListAnimeFollowersRow, error)
	CountAnimeFollowers(ctx context.Context, anilistID int32, viewerID *uuid.UUID) (dbgen.CountAnimeFollowersRow, error)
	GetViewerSubscriptionStatus(ctx context.Context, userID uuid.UUID, anilistID int32) (string, error)

	UserBlockExists(ctx context.Context, userID uuid.UUID, otherUserID uuid.UUID) (bool, error)
}

// Handlers carries the dependencies every route shares.
type Handlers struct {
	db     DB
	limits *writeLimits
}

// NewHandlers wires the package.  A nil DB panics at boot rather than on the
// first request.  Call Stop at shutdown to end the rate limiters' sweepers.
func NewHandlers(db DB, limits Limits) *Handlers {
	if db == nil {
		panic("community.NewHandlers: nil DB")
	}
	return &Handlers{db: db, limits: newWriteLimits(limits)}
}

// Stop ends the background sweepers of the per-user rate limiters.
func (h *Handlers) Stop() { h.limits.stop() }

// Mount registers the tab's routes on the /api/anime router, under
// /{anilistId}/community.  Reads take the session when there is one
// (OptionalAuth) so a reader sees their own private review and votes;
// writes require it.
func (h *Handlers) Mount(r chi.Router, signer *jwtx.Signer) {
	optional := jwtx.OptionalAuth(signer)
	required := jwtx.RequireAuth(signer)
	r.Route("/{anilistId}/community", func(r chi.Router) {
		r.With(optional).Get("/", h.Summary)

		r.With(optional).Get("/reviews", h.ListReviews)
		// "mine" is a literal segment; chi tries it before {reviewId}.
		r.With(required).Get("/reviews/mine", h.MyReview)
		r.With(optional).Get("/reviews/{reviewId}", h.GetReview)
		r.With(required).Post("/reviews", h.CreateReview)
		r.With(required).Patch("/reviews/{reviewId}", h.UpdateReview)
		r.With(required).Delete("/reviews/{reviewId}", h.DeleteReview)
		r.With(required).Put("/reviews/{reviewId}/helpful", h.VoteHelpful)
		r.With(required).Delete("/reviews/{reviewId}/helpful", h.UnvoteHelpful)

		r.With(optional).Get("/threads", h.ListThreads)
		r.With(required).Post("/threads", h.CreateThread)
		r.With(optional).Get("/threads/{threadId}", h.GetThread)
		r.With(required).Delete("/threads/{threadId}", h.DeleteThread)
		r.With(required).Post("/threads/{threadId}/replies", h.CreateThreadReply)

		r.With(optional).Get("/activity", h.ListActivity)
		r.With(optional).Get("/activity/{eventId}", h.GetActivity)
		r.With(required).Post("/activity/{eventId}/replies", h.CreateActivityReply)
		r.With(required).Put("/activity/{eventId}/like", h.LikeActivity)
		r.With(required).Delete("/activity/{eventId}/like", h.UnlikeActivity)

		r.With(required).Delete("/replies/{replyId}", h.DeleteReply)

		r.With(optional).Get("/watchers", h.ListWatchers)
	})
}

// MountAdmin registers the moderation removals on the /api/admin router,
// which already sits behind RequireAuth and RequireAdmin.
func (h *Handlers) MountAdmin(r chi.Router) {
	r.Delete("/community/reviews/{reviewId}", h.AdminRemoveReview)
	r.Delete("/community/threads/{threadId}", h.AdminRemoveThread)
	r.Delete("/community/replies/{replyId}", h.AdminRemoveReply)
}

// ---------------------------------------------------------------------------
// request plumbing shared by every handler
// ---------------------------------------------------------------------------

// viewerID is the signed-in reader's id, or nil for an anonymous one.
func viewerID(r *http.Request) *uuid.UUID {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		return nil
	}
	id := claims.UserID
	return &id
}

// requireClaims re-checks what RequireAuth already enforced, so a routing
// mistake that drops the middleware answers 401 instead of writing as nobody.
func requireClaims(w http.ResponseWriter, r *http.Request) (*jwtx.AccessClaims, bool) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, msgLoginAgain))
		return nil, false
	}
	return claims, true
}

// animeFromPath parses {anilistId} and confirms the catalogue holds it.  It
// writes the 400 or 404 itself and reports false, so a caller just returns.
// The lookup reads anime_cache only — this package never fetches AniList.
func (h *Handlers) animeFromPath(ctx context.Context, w http.ResponseWriter, r *http.Request) (int32, bool) {
	raw := chi.URLParam(r, "anilistId")
	id, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || id < 1 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return 0, false
	}
	present, err := h.db.CommunityAnimeExists(ctx, int32(id))
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "anime lookup failed"))
		return 0, false
	}
	if !present {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgAnimeNotFound))
		return 0, false
	}
	return int32(id), true
}

// uuidFromPath parses a uuid route parameter, answering 400 when it is not one.
func uuidFromPath(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return uuid.Nil, false
	}
	return id, true
}

// failLookup turns a meta lookup error into the response: ErrNoRows is the
// 404 for that kind of thing, anything else a 500.
func failLookup(w http.ResponseWriter, err error, notFound string) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, notFound))
		return
	}
	httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "lookup failed"))
}

// failServer is the 500 every unexpected database error becomes.
func failServer(w http.ResponseWriter, err error, what string) {
	httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, what))
}

// interactionBlocked answers 403 when the actor and the owner of what they
// are acting on are on either side of a block.  Acting on one's own thing is
// never blocked.  Reports whether it wrote a response.
func (h *Handlers) interactionBlocked(ctx context.Context, w http.ResponseWriter, actor, owner uuid.UUID) bool {
	if actor == owner {
		return false
	}
	blocked, err := h.db.UserBlockExists(ctx, actor, owner)
	if err != nil {
		failServer(w, err, "block lookup failed")
		return true
	}
	if blocked {
		httpx.Fail(w, httpx.NewError(http.StatusForbidden, httpx.CodeForbidden, msgInteractionUnavailable))
		return true
	}
	return false
}

// rateLimited answers 429 when the user has spent the action's budget.
func rateLimited(w http.ResponseWriter, limiter allower, userID uuid.UUID) bool {
	if limiter.Allow(userID.String()) {
		return false
	}
	httpx.Fail(w, httpx.NewError(http.StatusTooManyRequests, httpx.CodeTooManyRequests, msgTooManyRequests))
	return true
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

const (
	defaultPageSize = 10
	maxPageSize     = 30
	// maxPageOffset keeps the OFFSET (and its int32 conversion) sane; past
	// it a request is a crawler, and gets an empty page rather than a 500.
	maxPageOffset = 100_000
)

// pageParams reads ?page= (1-based) and ?limit= with the defaults above.
func pageParams(r *http.Request) (page, limit int) {
	page = positiveInt(r.URL.Query().Get("page"), 1)
	limit = positiveInt(r.URL.Query().Get("limit"), defaultPageSize)
	if limit > maxPageSize {
		limit = maxPageSize
	}
	return page, limit
}

func positiveInt(raw string, fallback int) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return fallback
	}
	return n
}

// pageOffset is (page-1)*limit, clamped by division so the product cannot
// overflow on a hostile ?page=.
func pageOffset(page, limit int) int32 {
	if page < 2 || limit < 1 {
		return 0
	}
	if page-1 > maxPageOffset/limit {
		return maxPageOffset
	}
	return int32((page - 1) * limit)
}

// pageOf assembles the paged envelope every list answers with.
func pageOf[T any](items []T, total int64, page, limit int) pageDTO[T] {
	if items == nil {
		items = []T{}
	}
	hasMore := int64(page)*int64(limit) < total
	var next *int
	if hasMore {
		n := page + 1
		next = &n
	}
	return pageDTO[T]{Items: items, Total: total, Page: page, HasMore: hasMore, NextPage: next}
}
