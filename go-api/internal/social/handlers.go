package social

// handlers.go — Handlers struct + constructor + shared helpers.
//
// All five social endpoints hang off the *Handlers value so dependency
// wiring at the router level lives in one place.  Per-handler timeouts
// derive from the request context so client-disconnects propagate.

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// queryTimeout bounds every DB round-trip in this package.  Matches
// the 5s budget used elsewhere in the codebase (internal/admin,
// internal/anime, internal/auth) so a stalled Postgres can't tie up
// goroutines longer than other surfaces.
const queryTimeout = 5 * time.Second

// listPageSize is the hard-coded items-per-page for the followers /
// following list endpoints.  Matches Express's literal `limit = 20`
// in server/controllers/follow.controller.js paginateFollows.  Same
// value drives /api/feed (server/controllers/profile.controller.js
// getFeed).
const listPageSize = 20

// User-facing English messages.  The frontend i18n layer (zh.js) maps
// each English string to a 中文 translation keyed on the English text —
// see /tmp/i18n-contract.md.
const (
	msgUserNotFound      = "User not found"
	msgCannotFollowSelf  = "Cannot follow yourself"
	msgMissingAuthClaims = "missing auth claims"
)

// SocialDB is the sqlc subset the social handlers consume.  Defined
// at the use-site per "accept interfaces, return structs" so tests can
// substitute a fake without dragging the full dbgen.Querier surface
// into the test setup.
//
// Eleven methods cover all five endpoints — the lookup helper
// GetUserIDByUsername is shared by every handler that takes a username
// path param, plus the per-endpoint reads / writes below.
type SocialDB interface {
	GetUserIDByUsername(ctx context.Context, username string) (dbgen.GetUserIDByUsernameRow, error)

	// Profile
	GetProfileCounts(ctx context.Context, userID uuid.UUID) (dbgen.GetProfileCountsRow, error)
	ListProfileWatching(ctx context.Context, userID uuid.UUID) ([]dbgen.ListProfileWatchingRow, error)
	FollowExists(ctx context.Context, followerID, followeeID uuid.UUID) (bool, error)

	// Follow CRUD
	UpsertFollow(ctx context.Context, followerID, followeeID uuid.UUID) error
	DeleteFollow(ctx context.Context, followerID, followeeID uuid.UUID) (int64, error)

	// Followers / following
	ListFollowers(ctx context.Context, followeeID uuid.UUID, limit, offset int32) ([]dbgen.ListFollowersRow, error)
	CountFollowers(ctx context.Context, followeeID uuid.UUID) (int64, error)
	ListFollowing(ctx context.Context, followerID uuid.UUID, limit, offset int32) ([]dbgen.ListFollowingRow, error)
	CountFollowing(ctx context.Context, followerID uuid.UUID) (int64, error)

	// Feed
	ListFeedFolloweeIDs(ctx context.Context, followerID uuid.UUID) ([]uuid.UUID, error)
	ListFeedActivities(ctx context.Context, followeeIDs []uuid.UUID, limit, offset int32) ([]dbgen.ListFeedActivitiesRow, error)
	CountFeedActivities(ctx context.Context, followeeIDs []uuid.UUID) (int64, error)
}

// Handlers carries the deps shared by every social handler.  Construct
// once at startup via NewHandlers and register each method on the chi
// router behind the appropriate auth middleware (OptionalAuth for the
// public profile, RequireAuth for follow / unfollow / feed).
//
// Pool is exposed for callers that may need to grab an ad-hoc tx; the
// current set of handlers only goes through the Queries interface and
// does not consume Pool directly.  Keeping it on the struct mirrors
// the admin.Handlers shape so the wiring stays consistent.
type Handlers struct {
	Pool    *pgxpool.Pool
	Queries SocialDB
}

// NewHandlers constructs a Handlers bundle.  pool must be non-nil and
// queries must implement SocialDB.  Both are required at boot — a nil
// dependency would crash on the first request, so we fail fast with a
// panic to flag misconfiguration during startup smoke tests rather
// than at request time.
func NewHandlers(pool *pgxpool.Pool, queries SocialDB) *Handlers {
	if pool == nil {
		panic("social.NewHandlers: nil Pool")
	}
	if queries == nil {
		panic("social.NewHandlers: nil SocialDB")
	}
	return &Handlers{
		Pool:    pool,
		Queries: queries,
	}
}

// parsePage parses the ?page= query param with the same semantics as
// Express's `Math.max(1, parseInt(req.query.page, 10) || 1)`:
//
//	empty / non-numeric / NaN → 1
//	<1                         → 1
//	otherwise                  → the parsed int
//
// We deliberately don't error on garbage — Express clamped silently
// and we match for byte-level diff parity at cutover.
func parsePage(r *http.Request) int {
	s := r.URL.Query().Get("page")
	if s == "" {
		return 1
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return 1
	}
	return n
}

// intPtr returns &n.  Convenience for assigning hasMore-derived
// NextPage values into the response envelope.
func intPtr(n int) *int { return &n }
