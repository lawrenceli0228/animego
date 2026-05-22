// Package subscriptions — handlers.go implements the five /api/subscriptions
// HTTP handlers ported from server/controllers/subscription.controller.js.
//
// All five run behind jwtx.RequireAuth in production (every route in
// routes/subscription.routes.js is wrapped in `router.use(authenticateToken)`).
// Defense-in-depth: each handler also pulls claims via jwtx.ClaimsFrom
// and 401s if missing, so a routing misconfiguration surfaces clearly
// rather than silently leaking other users' data.
//
// Postgres has no separate subscription row id (the composite PK is
// (user_id, anilist_id)); list responses emit `"subscriptionId": null`
// for byte-compat with the Mongo-shaped frontend.  See listItem in
// types.go for the field-level decision.
package subscriptions

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lawrenceli0228/animego/go-api/internal/anime"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// queryTimeout bounds every DB round-trip in this package.  Matches the
// 5s budget used by internal/auth / internal/admin / internal/anime so
// a stalled Postgres surfaces consistently across surfaces.
const queryTimeout = 5 * time.Second

// pgForeignKeyViolation is the Postgres SQLSTATE for a foreign-key
// constraint failure.  The /create path may hit this if the anime_cache
// row is deleted between EnsureCached returning nil and the
// UpsertSubscription INSERT — narrow race, mapped to 404 so the FE
// behaves the same way as the "AniList has no media" case.
const pgForeignKeyViolation = "23503"

// SubscriptionsDB is the sqlc subset this package consumes.  Declared
// at the use-site per "accept interfaces, return structs" so tests can
// substitute a fake without standing up the full dbgen.Querier surface.
type SubscriptionsDB interface {
	ListUserSubscriptions(ctx context.Context, userID uuid.UUID, statusFilter *string) ([]dbgen.ListUserSubscriptionsRow, error)
	GetSubscription(ctx context.Context, userID uuid.UUID, anilistID int32) (dbgen.Subscription, error)
	UpsertSubscription(ctx context.Context, userID uuid.UUID, anilistID int32, status string) (dbgen.Subscription, error)
	UpdateSubscription(ctx context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error)
	DeleteSubscription(ctx context.Context, userID uuid.UUID, anilistID int32) (int64, error)
}

// Handlers carries the deps shared by every /api/subscriptions/* handler.
// Construct once at startup via NewHandlers and register each method on
// the chi router behind jwtx.RequireAuth.
//
// Pool is intentionally exposed even though the current SQL doesn't
// require ad-hoc queries — future per-user analytics workflows might
// compose multi-statement transactions that go through the pool.
//
// Queries is the sqlc subset (SubscriptionsDB above).
// AnimeDB + AnilistClient back anime.EnsureCached for the POST flow.
// Validate is the request-binding validator instance.
type Handlers struct {
	Pool          *pgxpool.Pool
	Queries       SubscriptionsDB
	AnimeDB       anime.EnsureCachedDB
	AnilistClient anime.AniListDetailFetcher
	Validate      *validator.Validate
}

// NewHandlers builds a Handlers bundle with the supplied deps.  Mirrors
// the construction pattern used by internal/admin.NewHandlers — nil
// validator is substituted with a fresh validator.New so callers don't
// need to reach for the validator package directly.
//
// Queries / AnimeDB / AnilistClient must be non-nil; missing wiring
// would crash on the first request, so we fail fast via panic at
// construction so the smoke-test boot path flags the misconfiguration.
func NewHandlers(pool *pgxpool.Pool, queries SubscriptionsDB, animeDB anime.EnsureCachedDB, ac anime.AniListDetailFetcher, validate *validator.Validate) *Handlers {
	if queries == nil {
		panic("subscriptions.NewHandlers: nil SubscriptionsDB")
	}
	if animeDB == nil {
		panic("subscriptions.NewHandlers: nil EnsureCachedDB")
	}
	if ac == nil {
		panic("subscriptions.NewHandlers: nil AniListDetailFetcher")
	}
	if validate == nil {
		validate = validator.New(validator.WithRequiredStructEnabled())
	}
	return &Handlers{
		Pool:          pool,
		Queries:       queries,
		AnimeDB:       animeDB,
		AnilistClient: ac,
		Validate:      validate,
	}
}

// requireClaims pulls the verified access claims from the request
// context, or writes a 401 envelope and returns ok=false when the
// context wasn't populated.  Production wiring runs every handler behind
// jwtx.RequireAuth so the false branch only triggers on a routing bug.
func requireClaims(w http.ResponseWriter, r *http.Request) (*jwtx.AccessClaims, bool) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, "Authentication required"))
		return nil, false
	}
	return claims, true
}

// parseAnilistID extracts the :anilistId path param and validates it as
// a positive int32.  Writes a 400 BAD_REQUEST envelope on parse failure
// and returns ok=false so the caller can early-return without further
// output.  Mirrors admin.parseUserID's shape.
func parseAnilistID(w http.ResponseWriter, r *http.Request) (int32, bool) {
	raw := chi.URLParam(r, "anilistId")
	v, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || v < 1 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidAnimeID))
		return 0, false
	}
	return int32(v), true
}

// ListSubscriptions implements GET /api/subscriptions.
//
// Query: optional ?status=watching|completed|plan_to_watch|dropped.
// Invalid status values are passed through to the SQL filter, which
// returns an empty list — Express never validated the filter, and we
// match that "best-effort empty result" behaviour.
//
// Response: `{ data: [...] }` (NOT paginated — Express returned the
// whole list).  Each item merges anime_cache columns + subscription
// fields via listItem (see types.go).
func (h *Handlers) ListSubscriptions(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	var statusFilter *string
	if s := r.URL.Query().Get("status"); s != "" {
		statusFilter = &s
	}

	rows, err := h.Queries.ListUserSubscriptions(ctx, claims.UserID, statusFilter)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "list subscriptions failed"))
		return
	}

	items := make([]listItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, toListItem(row))
	}

	httpx.Data(w, http.StatusOK, items)
}

// GetSubscriptionByAnilistID implements GET /api/subscriptions/:anilistId.
//
// Flow:
//  1. Auth claims check.
//  2. Parse :anilistId; invalid → 400.
//  3. GetSubscription; pgx.ErrNoRows → 404.
//  4. 200 with the raw Subscription row (sqlc auto-generates camelCase
//     JSON tags so the wire shape matches Express's findOne result).
func (h *Handlers) GetSubscriptionByAnilistID(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	anilistID, ok := parseAnilistID(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	sub, err := h.Queries.GetSubscription(ctx, claims.UserID, anilistID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgSubscriptionNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "get subscription failed"))
		return
	}

	httpx.Data(w, http.StatusOK, sub)
}

// CreateSubscription implements POST /api/subscriptions.
//
// Flow:
//  1. Auth claims check.
//  2. Decode + validate body (anilistId >= 1, status ∈ enum).  Field
//     errors → 400 VALIDATION_ERROR with the mapped message.
//  3. anime.EnsureCached on the anilistId — fills the cache from
//     AniList if it's missing so the subscriptions FK passes.
//     ErrAnilistNotFound → 404 "Anime not found".
//  4. UpsertSubscription.  Returns the canonical post-write Subscription
//     row.  FK violation race (23503) → 404 "Anime not found".
//  5. 201 with `{ data: <Subscription> }`.
func (h *Handlers) CreateSubscription(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	var req createSubscriptionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgInvalidAnimeID))
		return
	}
	if err := h.Validate.Struct(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, validationMessage(err)))
		return
	}

	if err := anime.EnsureCached(ctx, h.AnimeDB, h.AnilistClient, req.AnilistID); err != nil {
		if errors.Is(err, anime.ErrAnilistNotFound) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgAnimeNotFound))
			return
		}
		slog.ErrorContext(ctx, "subscriptions.create: ensure_cached failed",
			"err", err,
			"anilist_id", req.AnilistID,
			"user_id", claims.UserID,
		)
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "ensure cached failed"))
		return
	}

	sub, err := h.Queries.UpsertSubscription(ctx, claims.UserID, req.AnilistID, req.Status)
	if err != nil {
		// FK race: anime_cache row vanished between EnsureCached's
		// upsert and our INSERT.  Map to 404 — from the caller's
		// perspective it's the same condition as "anime doesn't exist".
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgForeignKeyViolation {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgAnimeNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "upsert subscription failed"))
		return
	}

	httpx.Data(w, http.StatusCreated, sub)
}

// UpdateSubscription implements PATCH /api/subscriptions/:anilistId.
//
// Flow:
//  1. Auth claims check.
//  2. Parse :anilistId.
//  3. Parse body via parseUpdateBody so we can distinguish
//     `{"score":null}` (clear) from `{}` (no change).
//  4. Validate the parsed struct.
//  5. Build UpdateSubscriptionParams with the ScoreSet flag set IFF the
//     "score" key was present in the body.
//  6. Run UpdateSubscription; pgx.ErrNoRows → 404 (matches Express's
//     findOneAndUpdate returning null).
//  7. 200 with the post-update Subscription row.
//
// Express's empty-body behaviour: returns the existing row unchanged.
// Our SQL's COALESCE pattern handles this naturally — every field stays
// untouched when its parameter is nil and ScoreSet=false.
func (h *Handlers) UpdateSubscription(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	anilistID, ok := parseAnilistID(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	req, err := parseUpdateBody(r)
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgInvalidRequestBody))
		return
	}
	if err := h.Validate.Struct(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, validationMessage(err)))
		return
	}

	params := dbgen.UpdateSubscriptionParams{
		Status:         req.Status,
		CurrentEpisode: req.CurrentEpisode,
		ScoreSet:       req.scorePresent,
		Score:          clampScore(req.Score),
		UserID:         claims.UserID,
		AnilistID:      anilistID,
	}

	sub, err := h.Queries.UpdateSubscription(ctx, params)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgSubscriptionNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "update subscription failed"))
		return
	}

	httpx.Data(w, http.StatusOK, sub)
}

// DeleteSubscription implements DELETE /api/subscriptions/:anilistId.
//
// Flow:
//  1. Auth claims check.
//  2. Parse :anilistId.
//  3. DeleteSubscription returns the affected-row count; 0 → 404.
//  4. 200 with `{ data: { message: "Deleted" } }`.  The English string
//     matches the FE i18n contract (zh.js maps "Deleted" → 已删除).
func (h *Handlers) DeleteSubscription(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	anilistID, ok := parseAnilistID(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	affected, err := h.Queries.DeleteSubscription(ctx, claims.UserID, anilistID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "delete subscription failed"))
		return
	}
	if affected == 0 {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgSubscriptionNotFound))
		return
	}

	httpx.Data(w, http.StatusOK, deleteResp{Message: msgDeletedSuccessMessage})
}

// parseUpdateBody decodes the PATCH body into updateSubscriptionReq AND
// detects whether the "score" key was present in the raw JSON.
//
// We pre-pass the body into map[string]json.RawMessage so we can
// distinguish `{}` (score absent — keep the existing column) from
// `{"score":null}` (score present + null — clear the column).  After
// the pre-pass we re-encode and unmarshal into the typed struct so the
// validator can run over the populated fields.
//
// An empty body is valid (Express returns the row unchanged for an
// empty patch); decoded as an empty raw map, no fields populated,
// scorePresent stays false.
func parseUpdateBody(r *http.Request) (updateSubscriptionReq, error) {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&raw); err != nil {
		// An entirely missing body (Content-Length: 0) is not an error
		// — Express's express-validator treats it as an empty object.
		// json.Decode returns io.EOF for empty input, which we treat
		// as the empty-patch case rather than 400-ing.  Genuine syntax
		// errors (e.g. `{garbage`) still surface here.
		if errors.Is(err, io.EOF) {
			return updateSubscriptionReq{}, nil
		}
		return updateSubscriptionReq{}, err
	}
	// Explicit JSON `null` body decodes to a nil map without error —
	// treat as empty patch.
	if raw == nil {
		return updateSubscriptionReq{}, nil
	}

	var req updateSubscriptionReq

	if v, ok := raw["status"]; ok && len(v) > 0 && string(v) != "null" {
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return updateSubscriptionReq{}, err
		}
		req.Status = &s
	}
	if v, ok := raw["currentEpisode"]; ok && len(v) > 0 && string(v) != "null" {
		var n int32
		if err := json.Unmarshal(v, &n); err != nil {
			return updateSubscriptionReq{}, err
		}
		req.CurrentEpisode = &n
	}
	if v, ok := raw["score"]; ok {
		req.scorePresent = true
		if string(v) != "null" && len(v) > 0 {
			var n int32
			if err := json.Unmarshal(v, &n); err != nil {
				return updateSubscriptionReq{}, err
			}
			req.Score = &n
		}
		// score=null leaves req.Score nil but scorePresent=true.
	}
	return req, nil
}
