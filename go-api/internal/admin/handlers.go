package admin

// handlers.go — Handlers struct + constructor + shared helpers.
//
// The three read handlers (GetStats / ListEnrichment / ListUsers) hang
// off this struct.  Write handlers added by later phases will share
// the same struct so dependency wiring at the router level stays in
// one place.
//
// All DB round-trips are bounded by queryTimeout (5s).  Errors that
// escape a handler are routed through httpx.Fail with a generic 500
// SERVER_ERROR envelope — the cause chain is preserved internally
// for log/slog but never leaked to the client.

import (
	"context"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// queryTimeout bounds every DB round-trip in this package.  Matches
// the 5s budget used by internal/auth + internal/anime so a stalled
// admin DB doesn't tie up goroutines for longer than other surfaces.
const queryTimeout = 5 * time.Second

// pageSize is the hard-coded items-per-page for both list endpoints.
// Express uses literal 30 (see admin.controller.js:53 + :271); we
// match exactly so byte-level pagination state survives the cutover.
const pageSize = 30

// QueueStatusFn is the injected queue-sampling surface.  Defined here
// as a function type rather than a *river.Client dependency so the
// handler package stays free of the river import (and so tests can
// pass a stub returning the desired QueueSnapshot / error in one line).
//
// Production wiring (main.go, future phase) composes the snapshot from
// internal/queue.Status (river pause flag) + river.Client.JobList depth
// counts.  Until that wiring exists, the boot path may inject a fn
// that returns the zero-value QueueSnapshot so /api/admin/stats still
// emits the byte-correct envelope shape.
//
// The function MAY fail (e.g. river-backed query against Postgres
// chokes mid-request).  GetStats handles that gracefully: it logs
// the error and substitutes a zero-value QueueSnapshot in the response
// so the rest of the payload still ships.  Express's getQueueStatus
// is in-memory and infallible — the Go side widens the contract but
// the JSON shape stays identical (zero snapshot → all-zero counters +
// null v3Progress).
type QueueStatusFn func(ctx context.Context) (QueueSnapshot, error)

// adminQuerier is the sqlc subset the read handlers consume.  Defined
// here (where it's used) per "accept interfaces, return structs" so
// tests can substitute a fakeAdminQuerier without depending on the
// full dbgen.Querier surface.
//
// Only two methods are needed for P2.3.2:
//   - GetAdminStats for the stats endpoint.
//   - GetAdminUserSubFollowCounts for the listUsers batch counts step.
//
// Write endpoints in later phases will add to this surface (or the
// caller will pass the full dbgen.Querier — the interface widens
// without breaking existing callers).
type adminQuerier interface {
	GetAdminStats(ctx context.Context) (dbgen.GetAdminStatsRow, error)
	GetAdminUserSubFollowCounts(ctx context.Context, dollar_1 []uuid.UUID) ([]dbgen.GetAdminUserSubFollowCountsRow, error)
}

// Handlers carries the deps shared by every /api/admin/* read handler.
// Construct once at startup via NewHandlers and register each method
// on the chi router.
//
// Pool is the raw pgxpool.Pool — required by ListEnrichment +
// ListUsers because their SQL needs dynamic ORDER BY + filter
// composition that sqlc cannot express without an explosion of
// query variants.  The static aggregates (GetAdminStats +
// GetAdminUserSubFollowCounts) go through Queries.
//
// QueueStatus is injected as a function so the handler package
// doesn't import river.  Pass a wrapper around riverhealth /
// river.Client.JobList in production; tests can stub directly.
//
// Validate is a *validator.Validate ready to use.  Currently neither
// of the three read endpoints declares struct validation (all input
// arrives via query string and is parsed manually) — kept on the
// struct so the write handlers added in later phases can reuse it
// without reconstructing.
type Handlers struct {
	Pool        *pgxpool.Pool
	Queries     adminQuerier
	QueueStatus QueueStatusFn
	Validate    *validator.Validate
}

// NewHandlers constructs a Handlers bundle.  pool must be non-nil;
// queries must implement the adminQuerier subset; queueStatus may be
// nil — when it is, GetStats emits a zero-value queue.Stats (same
// fallback as a returning-error queueStatus).
//
// validate may also be nil — NewHandlers substitutes a default
// validator.New(WithRequiredStructEnabled) so callers don't need to
// reach for the validator package directly.
func NewHandlers(pool *pgxpool.Pool, queries adminQuerier, queueStatus QueueStatusFn, validate *validator.Validate) *Handlers {
	if validate == nil {
		validate = validator.New(validator.WithRequiredStructEnabled())
	}
	return &Handlers{
		Pool:        pool,
		Queries:     queries,
		QueueStatus: queueStatus,
		Validate:    validate,
	}
}
