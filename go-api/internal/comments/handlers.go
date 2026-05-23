package comments

// handlers.go — Handlers struct + constructor + 3 method receivers.
//
// All three endpoints hang off the *Handlers value so dependency wiring
// at the router level lives in one place.  Per-handler timeouts derive
// from the request context so client-disconnects propagate.
//
// Express comparison (server/controllers/comment.controller.js):
//   getComments    →  ListComments
//   addComment     →  AddComment
//   deleteComment  →  DeleteComment
//
// Routing (next phase wires):
//   GET    /api/comments/:anilistId/:episode  → ListComments  (public)
//   POST   /api/comments/:anilistId/:episode  → AddComment    (RequireAuth)
//   DELETE /api/comments/:id                  → DeleteComment (RequireAuth)

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// queryTimeout bounds every DB round-trip in this package.  Matches the
// 5s budget used by internal/admin / internal/auth / internal/social so
// a stalled Postgres surfaces consistently across surfaces.
const queryTimeout = 5 * time.Second

// CommentsDB is the sqlc subset the comment handlers consume.  Defined
// at the use-site per "accept interfaces, return structs" so tests can
// substitute a fake without dragging the full dbgen.Querier surface
// into the test setup.
//
// Five methods cover all three endpoints — the ListEpisodeComments read
// for GET, plus the read/write pair (CreateComment +
// GetCommentParentForValidation) for POST, plus the read/delete pair
// (GetCommentByID + DeleteComment) for DELETE.
type CommentsDB interface {
	ListEpisodeComments(ctx context.Context, anilistID int32, episode int32) ([]dbgen.EpisodeComment, error)
	CreateComment(ctx context.Context, arg dbgen.CreateCommentParams) (dbgen.EpisodeComment, error)
	GetCommentParentForValidation(ctx context.Context, iD uuid.UUID, anilistID int32, episode int32) (uuid.UUID, error)
	GetCommentByID(ctx context.Context, id uuid.UUID) (dbgen.GetCommentByIDRow, error)
	DeleteComment(ctx context.Context, id uuid.UUID) error
}

// Handlers carries the deps shared by every comment handler.  Construct
// once at startup via NewHandlers and register each method on the chi
// router behind the appropriate auth middleware (public for ListComments,
// RequireAuth for AddComment + DeleteComment).
//
// Pool is exposed for callers that may need to grab an ad-hoc tx; the
// current set of handlers only goes through the Queries interface and
// does not consume Pool directly.  Keeping it on the struct mirrors the
// social/admin Handlers shape so the wiring stays consistent.
type Handlers struct {
	Pool    *pgxpool.Pool
	Queries CommentsDB
}

// NewHandlers constructs a Handlers bundle.  pool must be non-nil and
// queries must implement CommentsDB.  Both are required at boot — a nil
// dependency would crash on the first request, so we fail fast with a
// panic here to flag misconfiguration during startup smoke tests rather
// than at request time.
func NewHandlers(pool *pgxpool.Pool, queries CommentsDB) *Handlers {
	if pool == nil {
		panic("comments.NewHandlers: nil Pool")
	}
	if queries == nil {
		panic("comments.NewHandlers: nil CommentsDB")
	}
	return &Handlers{
		Pool:    pool,
		Queries: queries,
	}
}

// addCommentReq is the JSON body shape for POST /api/comments/:anilistId/:episode.
//
// Content is the only required field.  ParentID is a pointer so we can
// distinguish absent (`{}`) from explicit null (`{"parentId":null}`) —
// both are treated as top-level comments.  ReplyToUsername is a free
// string that the frontend uses to render the "@username" prefix; we
// pass it through verbatim (no length validation — the column is text
// with no CHECK).
type addCommentReq struct {
	Content         string     `json:"content"`
	ParentID        *uuid.UUID `json:"parentId"`
	ReplyToUsername *string    `json:"replyToUsername"`
}

// ListComments implements GET /api/comments/:anilistId/:episode.
//
// Public endpoint — no auth required.  Mirrors Express's
// getComments handler: returns a flat list sorted by created_at ASC,
// client builds the parent_id adjacency tree.
//
// Flow:
//  1. Parse + validate :anilistId / :episode path params.
//  2. Call ListEpisodeComments (SQL adds ORDER BY ASC + LIMIT 500).
//  3. Return `{ data: [...] }`.  Empty list emits `"data":[]`.
func (h *Handlers) ListComments(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	anilistID, episode, ok := parseEpisodePath(w, r)
	if !ok {
		return
	}

	rows, err := h.Queries.ListEpisodeComments(ctx, anilistID, episode)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "list comments failed"))
		return
	}

	// ListEpisodeComments returns []EpisodeComment which already has
	// the right camelCase JSON tags (id, anilistId, episode, userId,
	// username, content, parentId, replyToUsername, createdAt, updatedAt).
	// sqlc init's empty slice as `[]EpisodeComment{}` already, but we
	// defensively ensure a non-nil slice so the envelope emits `"data":[]`
	// not `"data":null` on the unlikely off-chance ListEpisodeComments
	// returns nil.
	if rows == nil {
		rows = []dbgen.EpisodeComment{}
	}
	httpx.Data(w, http.StatusOK, rows)
}

// AddComment implements POST /api/comments/:anilistId/:episode.
//
// Auth required (production wiring uses RequireAuth).  Defense-in-depth:
// we re-check ClaimsFrom and 401 if missing so a routing misconfiguration
// surfaces clearly rather than silently leaking other users' data.
//
// Validation order matches Express byte-for-byte:
//  1. Path params (400 BAD_REQUEST `Invalid params`).
//  2. Auth claims (401 UNAUTHORIZED `Please log in again`).
//  3. Content present + non-empty after trim (400 VALIDATION_ERROR
//     `Content is required`).
//  4. Content rune count <= 500 (400 VALIDATION_ERROR `Content too long`).
//  5. ParentID, if provided, must exist on the same (anilistId, episode)
//     thread (400 VALIDATION_ERROR `Parent comment not found`).
//
// Then CreateComment writes the row and we return 201 CREATED with the
// full Postgres row wrapped in `{ data: <row> }`.
func (h *Handlers) AddComment(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	anilistID, episode, ok := parseEpisodePath(w, r)
	if !ok {
		return
	}

	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, msgLoginAgain))
		return
	}

	var req addCommentReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// A malformed body short-circuits before the per-field checks.
		// Express's express-validator skips its rules when JSON parse
		// fails, and the controller's first guard (`!content`) fires
		// with a 400 VALIDATION_ERROR.  We mirror that with the same
		// message + code so the FE flow doesn't have to learn a new
		// error path.
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgContentRequired))
		return
	}

	// Trim before length-check — Express does
	// `content.trim().length > 500` so leading/trailing whitespace
	// doesn't eat the budget.
	trimmed := strings.TrimSpace(req.Content)
	if trimmed == "" {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgContentRequired))
		return
	}
	if contentRuneCount(trimmed) > maxContentRunes {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgContentTooLong))
		return
	}

	// Validate parent_id ownership / same-episode invariant.  The SQL
	// query enforces `parent_id = $1 AND anilist_id = $2 AND episode = $3`
	// so a reply that targets a comment from a different episode (or
	// fabricated id) returns ErrNoRows → 400.
	if req.ParentID != nil {
		_, err := h.Queries.GetCommentParentForValidation(ctx, *req.ParentID, anilistID, episode)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgParentNotFound))
				return
			}
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "parent lookup failed"))
			return
		}
	}

	row, err := h.Queries.CreateComment(ctx, dbgen.CreateCommentParams{
		AnilistID:       anilistID,
		Episode:         episode,
		UserID:          claims.UserID,
		Username:        claims.Username,
		Content:         trimmed,
		ParentID:        req.ParentID,
		ReplyToUsername: req.ReplyToUsername,
	})
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "create comment failed"))
		return
	}

	httpx.Data(w, http.StatusCreated, row)
}

// deleteCommentResp is the success body for DELETE /api/comments/:id.
// Matches Express: `{ data: { success: true } }`.
type deleteCommentResp struct {
	Success bool `json:"success"`
}

// DeleteComment implements DELETE /api/comments/:id.
//
// Auth required (production wiring uses RequireAuth).  Defense-in-depth:
// we re-check ClaimsFrom and 401 if missing so a routing misconfiguration
// surfaces clearly rather than silently allowing any caller to delete.
//
// Flow:
//  1. Parse :id path param as UUID (400 BAD_REQUEST `Invalid params`).
//  2. Auth claims (401 UNAUTHORIZED `Please log in again`).
//  3. GetCommentByID — ErrNoRows → 404 NOT_FOUND `Comment not found`.
//  4. Ownership check — row.UserID != claims.UserID → 403 FORBIDDEN
//     `Not your comment`.
//  5. DeleteComment — ON DELETE CASCADE removes any reply children
//     automatically (Express's deleteOne() left them dangling, which is
//     a bug the Postgres FK definition fixes for free).
//  6. 200 OK with `{ data: { success: true } }`.
func (h *Handlers) DeleteComment(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	raw := chi.URLParam(r, "id")
	commentID, err := uuid.Parse(raw)
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return
	}

	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, msgLoginAgain))
		return
	}

	row, err := h.Queries.GetCommentByID(ctx, commentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgCommentNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "comment lookup failed"))
		return
	}

	if row.UserID != claims.UserID {
		httpx.Fail(w, httpx.NewError(http.StatusForbidden, httpx.CodeForbidden, msgNotYourComment))
		return
	}

	if err := h.Queries.DeleteComment(ctx, commentID); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "delete comment failed"))
		return
	}

	httpx.Data(w, http.StatusOK, deleteCommentResp{Success: true})
}

// parseEpisodePath extracts :anilistId / :episode from the chi route
// and validates them as positive int32 values.  Writes a 400 envelope
// on parse failure and returns ok=false so the caller can early-return
// without writing additional output.
//
// Both fields must be >= 1.  Express only checked `parseInt(…)` (which
// returns NaN for non-numeric input but would happily accept 0 or
// negative); we tighten to >= 1 because the FK constraint on
// anilist_id → anime_cache(anilist_id) treats 0 as a non-existent row
// and we want the friendly "Invalid params" 400 over a confusing FK
// violation.
func parseEpisodePath(w http.ResponseWriter, r *http.Request) (int32, int32, bool) {
	anilistRaw := chi.URLParam(r, "anilistId")
	episodeRaw := chi.URLParam(r, "episode")

	anilistID, err := strconv.ParseInt(anilistRaw, 10, 32)
	if err != nil || anilistID < 1 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return 0, 0, false
	}
	episode, err := strconv.ParseInt(episodeRaw, 10, 32)
	if err != nil || episode < 1 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return 0, 0, false
	}
	return int32(anilistID), int32(episode), true
}
