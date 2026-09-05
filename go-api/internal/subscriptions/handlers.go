// Package subscriptions — handlers.go implements the /api/subscriptions
// HTTP handlers: the five ported from
// server/controllers/subscription.controller.js, plus the three per-episode
// watch-mark routes migration 0024 made possible.
//
// All of them run behind jwtx.RequireAuth in production (every route in
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
	"strings"
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

// maxEpisodeNumber mirrors the CHECK on episode_watches.episode
// (migration 0024).  Enforced here so an out-of-range episode is answered
// with a 400 the client can read, instead of reaching the constraint and
// surfacing as a 500 — and so a single request can never ask the database
// to consider an arbitrary episode number.
//
// If the CHECK ever moves, move this with it.  The two are one bound
// stated in two places, and the handler must never be the looser of them.
const maxEpisodeNumber = 5000

// maxEpisodesPerRequest caps the array PUT
// /api/subscriptions/{anilistId}/episodes will consider.
//
// It is derived, not chosen.  Every member must be a distinct-or-repeated
// value in 1..maxEpisodeNumber, so an array longer than maxEpisodeNumber
// cannot say anything an array of that length could not already say — it
// can only repeat.  That makes this the TIGHTEST cap that can never reject
// a request a caller had a reason to send, which is the property a cap
// wants: one that can refuse legitimate work is a bug waiting for the
// first long-runner.
//
// What it buys is a bound on the work one request can ask for: at most
// five thousand rows offered to one INSERT, which is the same blast radius
// migration 0024's CHECK already accepts for a range write.  It moves with
// maxEpisodeNumber by construction rather than by anyone remembering to.
const maxEpisodesPerRequest = maxEpisodeNumber

// SubscriptionsDB is the sqlc subset this package consumes.  Declared
// at the use-site per "accept interfaces, return structs" so tests can
// substitute a fake without standing up the full dbgen.Querier surface.
type SubscriptionsDB interface {
	ListUserSubscriptions(ctx context.Context, userID uuid.UUID, statusFilter *string) ([]dbgen.ListUserSubscriptionsRow, error)
	// GetSubscription returns the subscription row AND the per-episode
	// watched set in one statement (migration 0024).  The two are one fact
	// stated twice, so they are read together — see the query comment.
	GetSubscription(ctx context.Context, userID uuid.UUID, anilistID int32) (dbgen.GetSubscriptionRow, error)
	// MarkEpisodeWatched / UnmarkEpisodeWatched are the two per-episode
	// writes.  Each is a single statement that writes the watch row and
	// recomputes subscriptions.current_episode together, so the derived
	// integer can never disagree with the set it summarises.  Both return
	// the full post-write set so the client reconciles without a refetch,
	// and both return pgx.ErrNoRows when the caller has no subscription for
	// that anime.
	MarkEpisodeWatched(ctx context.Context, userID uuid.UUID, anilistID int32, episode int32) (dbgen.MarkEpisodeWatchedRow, error)
	UnmarkEpisodeWatched(ctx context.Context, userID uuid.UUID, anilistID int32, episode int32) (dbgen.UnmarkEpisodeWatchedRow, error)
	// MarkEpisodesWatched is MarkEpisodeWatched over a set, and it UNIONS:
	// the marks another device made are not this caller's to delete, so the
	// statement can only add.  Same single-statement discipline, same
	// zero-rows-means-no-subscription contract.
	MarkEpisodesWatched(ctx context.Context, userID uuid.UUID, anilistID int32, episodes []int32) (dbgen.MarkEpisodesWatchedRow, error)
	UpsertSubscription(ctx context.Context, userID uuid.UUID, anilistID int32, status string) (dbgen.Subscription, error)
	// InsertSubscriptionIfAbsent backs POST bodies carrying
	// `"ifAbsent": true`.  It differs from UpsertSubscription in exactly
	// one way that matters: on conflict it returns the existing row
	// untouched instead of overwriting `status`.  Click-to-track fires on
	// paths the user did not explicitly ask to re-subscribe on, so an
	// upsert there would silently resurrect dropped/completed titles.
	InsertSubscriptionIfAbsent(ctx context.Context, userID uuid.UUID, anilistID int32, status string) (dbgen.Subscription, error)
	// GetAnimeEpisodeCount reads the authoritative total-episode count
	// used as the upper bound on PATCH.  Nil result = still airing /
	// unknown length = no bound to enforce.  Kept out of the PATCH CTE on
	// purpose — see the query comment in anime_cache.sql.
	GetAnimeEpisodeCount(ctx context.Context, anilistID int32) (*int32, error)
	// UpdateSubscriptionWithActivity is the only PATCH path.  Its CTE
	// writes the watch row for the episode being recorded, re-derives
	// current_episode from the resulting set, AND appends the
	// watch_progress activity event, all in one statement — so neither the
	// derived integer nor the feed can drift from the progress they are
	// supposed to describe.  The plain UpdateSubscription query still
	// exists in dbgen but is deliberately not part of this interface: it
	// writes current_episode directly, which would break the invariant,
	// and it skips the activity write, which would empty the feed with no
	// error.
	UpdateSubscriptionWithActivity(ctx context.Context, arg dbgen.UpdateSubscriptionWithActivityParams) (dbgen.UpdateSubscriptionWithActivityRow, error)
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

// parseEpisode extracts the :episode path param and validates it against
// the same bounds episode_watches.episode carries: 1 <= episode <=
// maxEpisodeNumber.  Writes a 400 BAD_REQUEST envelope and returns
// ok=false on any failure, so a rejected episode never reaches the
// database — the CHECK constraint stays a backstop rather than the error
// path.
//
// ParseInt with bitSize 32 rather than Atoi-then-cast, and the difference
// is not cosmetic: Atoi parses into a platform int, so on a 64-bit build
// "4294967297" parses happily and int32(4294967297) silently wraps to 1.
// That is not a rejected request, it is a request that addresses a
// different row than the one it named.  ParseInt with an explicit bit size
// returns ErrRange instead, and the same reasoning applies to
// parseAnilistID above.
//
// The message deliberately says nothing about which bound was missed and
// echoes none of the input back.
func parseEpisode(w http.ResponseWriter, r *http.Request) (int32, bool) {
	raw := chi.URLParam(r, "episode")
	v, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || v < 1 || v > maxEpisodeNumber {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidEpisodeNumber))
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
//  3. GetSubscription; pgx.ErrNoRows → 200 with null data (not 404). The
//     detail page probes this on every view; a 404 would surface as a failed
//     request in the browser console. The frontend reads data:null as
//     "available / not subscribed".
//  4. 200 with the raw row (sqlc auto-generates camelCase JSON tags so the
//     wire shape matches Express's findOne result), plus watchedEpisodes —
//     the per-episode set, read in the same statement as currentEpisode so
//     the grid and the progress number can never contradict each other.
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
			// Not subscribed: return 200 with null data rather than 404. The
			// detail page probes this on every view; a 404 there shows up as a
			// failed request in the browser console (noisy, looks like a bug).
			// The frontend reads data:null as "available / not subscribed".
			httpx.Data(w, http.StatusOK, nil)
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "get subscription failed"))
		return
	}

	// The SQL already COALESCEs an empty set to '{}', but the contract is
	// that watchedEpisodes is an array and never null, and that promise
	// should not depend on how a driver decodes a zero-length array.
	sub.WatchedEpisodes = nonNilEpisodes(sub.WatchedEpisodes)

	httpx.Data(w, http.StatusOK, sub)
}

// MarkEpisodeWatched implements PUT
// /api/subscriptions/{anilistId}/episodes/{episode}.
//
// Flow:
//  1. Auth claims check.  The user id used by the write comes from the
//     verified JWT claims and from nowhere else — there is no path, query
//     or body parameter that can name a user.  That is the whole IDOR
//     story for this endpoint: the statement's first CTE selects the
//     caller's own subscription row, and everything downstream reads its
//     keys from that row.
//  2. Parse :anilistId and :episode, both as bounded positive int32.
//  3. Run the single-statement write.  pgx.ErrNoRows means the caller has
//     no subscription for that anime — 404, same envelope PATCH and DELETE
//     already answer for the same condition.  Nothing was written.
//  4. 200 with the full post-write set so the client reconciles its grid
//     without a follow-up read.
//
// Idempotent: marking an episode that is already marked returns 200 with
// the unchanged set, and leaves the subscription's timestamps alone.
func (h *Handlers) MarkEpisodeWatched(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	anilistID, ok := parseAnilistID(w, r)
	if !ok {
		return
	}
	episode, ok := parseEpisode(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	row, err := h.Queries.MarkEpisodeWatched(ctx, claims.UserID, anilistID, episode)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgSubscriptionNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "mark episode watched failed"))
		return
	}

	httpx.Data(w, http.StatusOK, episodeWatchResp{
		AnilistID:       anilistID,
		WatchedEpisodes: nonNilEpisodes(row.WatchedEpisodes),
		CurrentEpisode:  row.CurrentEpisode,
	})
}

// parseEpisodeList decodes and validates the bulk mark body, writing a 400
// envelope and returning ok=false on any failure.
//
// ALL OR NOTHING, and that is the contract rather than an implementation
// detail.  A body naming ten episodes of which one is out of range writes
// none of them: a partial write the caller cannot see is worse than a 400,
// because the caller's whole reason for batching is that it intends to
// learn from one answer what happened to the set.  The loop therefore
// returns on the first bad member instead of collecting the good ones.
//
// Each member goes through the same strconv.ParseInt(.., 10, 32) that
// parseEpisode uses on the path param, so 0, -1, 5001, 1.5 and 4294967297
// are refused here for exactly the reasons they are refused there — see
// parseEpisode's comment for why the explicit bit size matters.  A member
// that is not a JSON integer at all (a string, a bool, null, an object) is
// the same refusal: ParseInt reads the raw token and none of those parse.
//
// Duplicates are NOT rejected.  A repeated episode is redundant, not
// invalid, and the statement's ON CONFLICT DO NOTHING already collapses it;
// refusing it would make the caller responsible for de-duplicating a set it
// is allowed to describe however it likes.
func parseEpisodeList(w http.ResponseWriter, r *http.Request) ([]int32, bool) {
	var req markEpisodesReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Episodes == nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgInvalidEpisodeList))
		return nil, false
	}
	raw := *req.Episodes
	if len(raw) == 0 || len(raw) > maxEpisodesPerRequest {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgInvalidEpisodeList))
		return nil, false
	}

	episodes := make([]int32, 0, len(raw))
	for _, token := range raw {
		// TrimSpace so that pretty-printed JSON is not a rejection: any
		// padding here is the encoder's formatting, not the caller naming a
		// different episode.  (The path-param route deliberately refuses
		// " 3" — there the whitespace IS the input.)
		v, err := strconv.ParseInt(strings.TrimSpace(string(token)), 10, 32)
		if err != nil || v < 1 || v > maxEpisodeNumber {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgInvalidEpisodeNumber))
			return nil, false
		}
		episodes = append(episodes, int32(v))
	}
	return episodes, true
}

// MarkEpisodesWatched implements PUT
// /api/subscriptions/{anilistId}/episodes — the bulk sibling of the
// single-episode PUT one segment deeper.
//
// It exists because the library reconciler pushes a SET.  Marking N
// episodes one request at a time would make a first sync of a two-cour
// series fifty requests behind one page mount, at a per-IP rate limiter
// that would rightly start refusing them.
//
// Flow, and every step is the single-episode route's step:
//  1. Auth claims check.  The user id comes from the verified JWT and from
//     nowhere else — no path, query or BODY field can name a user, and the
//     statement's first CTE selects the caller's own subscription row.
//  2. Parse :anilistId, then the body, both all-or-nothing.
//  3. Upper-bound guard against anime_cache.episodes, on the MAXIMUM
//     member.  This route is where §4 decision 4 earns its keep: the
//     reconciler's episodes come from a LOCAL binding, and a binding that
//     points at the wrong show — or at one cour of a split season — is the
//     population the bound exists to catch.  Checking the maximum is
//     sufficient because it dominates every other member; and it is the
//     same check, and the same 400, that PATCH has always answered, which
//     is what keeps the client's attempt ceiling meaningful after the
//     reconciler stops sending PATCH.
//  4. Run the single-statement union.  pgx.ErrNoRows means the caller has
//     no subscription for that anime — 404, nothing written.
//  5. 200 with the full post-write set, same body as both per-episode
//     routes, so a client reconciles its grid from one response.
//
// Idempotent: re-sending a set that is already stored returns 200 with the
// unchanged set and leaves both timestamps alone.
func (h *Handlers) MarkEpisodesWatched(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	anilistID, ok := parseAnilistID(w, r)
	if !ok {
		return
	}
	episodes, ok := parseEpisodeList(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	highest := episodes[0]
	for _, e := range episodes[1:] {
		if e > highest {
			highest = e
		}
	}
	if !h.checkEpisodeUpperBound(ctx, w, anilistID, &highest) {
		return
	}

	row, err := h.Queries.MarkEpisodesWatched(ctx, claims.UserID, anilistID, episodes)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgSubscriptionNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "mark episodes watched failed"))
		return
	}

	httpx.Data(w, http.StatusOK, episodeWatchResp{
		AnilistID:       anilistID,
		WatchedEpisodes: nonNilEpisodes(row.WatchedEpisodes),
		CurrentEpisode:  row.CurrentEpisode,
	})
}

// UnmarkEpisodeWatched implements DELETE
// /api/subscriptions/{anilistId}/episodes/{episode}.
//
// Same flow, same auth boundary, same response shape as
// MarkEpisodeWatched.  Two differences worth naming:
//
//   - Unmarking an episode that was never marked is a 200, not a 404.  The
//     caller asked for a state and got it; requiring it to know the
//     current set before it may act on it would make every click a
//     read-then-write.
//   - This is the ONLY write in the whole system that can move
//     current_episode DOWN, and that is deliberate.  The value is derived
//     from the set, so it falls exactly when the set's maximum falls, and
//     removing a mark is the only thing that does that.  A PATCH cannot
//     lower it whatever it sends.  See the query comment.
func (h *Handlers) UnmarkEpisodeWatched(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	anilistID, ok := parseAnilistID(w, r)
	if !ok {
		return
	}
	episode, ok := parseEpisode(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	row, err := h.Queries.UnmarkEpisodeWatched(ctx, claims.UserID, anilistID, episode)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgSubscriptionNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "unmark episode watched failed"))
		return
	}

	httpx.Data(w, http.StatusOK, episodeWatchResp{
		AnilistID:       anilistID,
		WatchedEpisodes: nonNilEpisodes(row.WatchedEpisodes),
		CurrentEpisode:  row.CurrentEpisode,
	})
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
//  4. Write.  `"ifAbsent": true` routes to InsertSubscriptionIfAbsent
//     (existing row returned untouched — status is human-only, §4
//     decision 3); anything else keeps the historical
//     UpsertSubscription.  Both return the canonical post-write
//     Subscription row.  FK violation race (23503) → 404 "Anime not
//     found".
//  5. 201 with `{ data: <Subscription> }`.
//
// Both branches answer 201, including the ifAbsent case where nothing was
// inserted.  200-on-existing would be more RESTful but would force every
// call site to branch on the status code for no behavioural gain — the
// body is the same shape either way, and the caller that cares about
// "did this already exist" can compare createdAt.
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

	var sub dbgen.Subscription
	var err error
	if req.IfAbsent {
		sub, err = h.Queries.InsertSubscriptionIfAbsent(ctx, claims.UserID, req.AnilistID, req.Status)
	} else {
		sub, err = h.Queries.UpsertSubscription(ctx, claims.UserID, req.AnilistID, req.Status)
	}
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
//  5. Upper-bound guard: when currentEpisode is supplied, reject
//     anything past anime_cache.episodes with 400 (see
//     checkEpisodeUpperBound).
//  6. Build UpdateSubscriptionWithActivityParams with the ScoreSet flag
//     set IFF the "score" key was present in the body, and Monotonic
//     from the body (default false).
//  7. Run UpdateSubscriptionWithActivity; pgx.ErrNoRows → 404 (matches
//     Express's findOneAndUpdate returning null).
//  8. 200 with the post-update subscription row.
//
// Express's empty-body behaviour: returns the existing row unchanged.
// Our SQL's COALESCE pattern handles this naturally — every field stays
// untouched when its parameter is nil and ScoreSet=false.
//
// What `currentEpisode` means here changed with migration 0024, and the
// name did not.  It is now the episode to RECORD, not a new value for the
// column: the statement writes one watch row and re-derives
// current_episode as COALESCE(MAX(episode), 0) over the set.  Three
// consequences worth knowing at the call site — all of them intended, all
// of them explained in the query comment:
//
//   - A smaller number cannot lower progress.  Lowering is unmarking, via
//     UnmarkEpisodeWatched.
//   - currentEpisode = 0 is not a reset.  Zero is not an episode, so it
//     records nothing and therefore moves nothing.
//   - An episode outside 1..maxEpisodeNumber records nothing and moves
//     nothing, rather than 500-ing on the CHECK.
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

	if !h.checkEpisodeUpperBound(ctx, w, anilistID, req.CurrentEpisode) {
		return
	}

	// Concrete row type, not `any`: the response shape of PATCH is part of
	// the FE contract, so it has to be something the compiler can check.
	// Widening the CTE's RETURNING list should break here, not silently
	// reshape the JSON.
	sub, err := h.Queries.UpdateSubscriptionWithActivity(ctx, dbgen.UpdateSubscriptionWithActivityParams{
		Status:         req.Status,
		CurrentEpisode: req.CurrentEpisode,
		Monotonic:      req.Monotonic,
		ScoreSet:       req.scorePresent,
		Score:          clampScore(req.Score),
		UserID:         claims.UserID,
		AnilistID:      anilistID,
	})
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

// checkEpisodeUpperBound rejects a currentEpisode past the authoritative
// anime_cache.episodes count, writing a 400 envelope and returning false.
// Returns true (proceed) when there is nothing to check.
//
// It costs one extra round-trip, but only on the progress-writing path —
// status-only and score-only patches skip it entirely.  Three deliberate
// pass-through cases:
//
//	currentEpisode absent   nothing to bound.
//	episodes IS NULL        still airing / unknown length.  §4 decision 4
//	                        says no bound, not "bound at 0".
//	pgx.ErrNoRows           the title isn't cached, so the FK on
//	                        subscriptions means there is no row to update
//	                        either — let the PATCH answer its own 404
//	                        rather than inventing a 400 here.
//
// Rejecting rather than clamping is the point: an episode past the end is
// evidence the client bound the wrong title, and a clamp would store that
// as plausible-looking progress.  The TOCTOU window against the enrichment
// worker (the only writer of anime_cache.episodes) is accepted — losing
// that race costs one spurious 400 the client retries past.
func (h *Handlers) checkEpisodeUpperBound(ctx context.Context, w http.ResponseWriter, anilistID int32, currentEpisode *int32) bool {
	if currentEpisode == nil {
		return true
	}
	total, err := h.Queries.GetAnimeEpisodeCount(ctx, anilistID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return true
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "episode count lookup failed"))
		return false
	}
	if total != nil && *currentEpisode > *total {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, msgEpisodeExceedsTotal))
		return false
	}
	return true
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
	// No presence flag for monotonic: absent, null, and false are all the
	// same instruction ("apply the caller's value verbatim"), so the zero
	// value already encodes it.  That is what keeps the detail page's ±
	// buttons — which never send the key — behaving exactly as before.
	if v, ok := raw["monotonic"]; ok && len(v) > 0 && string(v) != "null" {
		var b bool
		if err := json.Unmarshal(v, &b); err != nil {
			return updateSubscriptionReq{}, err
		}
		req.Monotonic = b
	}
	return req, nil
}
