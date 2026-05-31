// Package torrents — aggregator.go
//
// Parallel fan-out + cache + partial-tolerance.  This is the
// orchestrating layer the HTTP handler will call; the three
// FetchXxx functions in garden.go / acgrip.go / nyaa.go are leaves.
//
// Behaviour port of server/controllers/anime.controller.js:289-325:
//   - Three upstream fetchers run concurrently (errgroup; in Express
//     it's Promise.allSettled).
//   - One source failing does NOT propagate as a top-level error —
//     the aggregator logs and returns an empty slice for that source
//     so the other two still flow through.  This matches Express's
//     fulfilled-only spread.
//   - Per-source timeout: 8 seconds via ctx.WithTimeout.  Matches
//     Express's AbortSignal.timeout(8000) on each fetch call.
//   - Cache: per-query, 1 hour TTL, max 500 entries.  Cache key is
//     the query string after .trim().toLowerCase() — same
//     normalisation as Express.
//   - Empty query: short-circuit to empty result, no upstream calls
//     and no cache write.  The HTTP handler validates q upstream
//     (required, ≤200 chars); the defensive guard here protects
//     against a misconfigured caller.
package torrents

import (
	"context"
	"net/http"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
)

// torrentCacheTTL is the per-query result TTL.  Express uses 1h
// (60 * 60 * 1000ms).  An hour is generous; raw upstream RSS feeds
// rarely change within that window.
const torrentCacheTTL = 1 * time.Hour

// torrentCacheMax is the maximum number of distinct queries cached
// at once.  Express uses 500.  When the LRU is full ristretto evicts
// the least-recently-used entry; old behaviour evicted the oldest
// inserted entry (FIFO).  TinyLFU is more accurate so this is a
// strict upgrade over the JS Map approach.
const torrentCacheMax = 500

// perSourceTimeout is the per-fetcher abort threshold.  Express
// passes AbortSignal.timeout(8000) to each upstream.  We honour the
// same bound via ctx.WithTimeout on the child context each goroutine
// receives.
const perSourceTimeout = 8 * time.Second

// Logger is the minimal logging interface the package depends on.
// Pass *log.Logger via a small wrapper, *slog.Logger, or a test
// recorder — anything with a Warn(msg, args...) method.  Nil disables
// logging.
//
// The args... is keyword-style: key1, value1, key2, value2, ... which
// lets slog adapters extract structured fields without re-parsing the
// message.
type Logger interface {
	Warn(msg string, args ...any)
}

// fetchFn is the shape of a single upstream fetcher.  Defining it as
// a named type lets the Option setters swap in test stubs without
// caring about the underlying concrete fetcher.
type fetchFn func(ctx context.Context, q string) ([]TorrentItem, error)

// Aggregator runs the three upstream fetchers in parallel with a
// per-source timeout, partial-failure tolerance, and a 1-hour
// per-query cache.  Constructed via New().
//
// All fields are package-private; callers configure via Option
// setters at construction time.  Aggregator is safe for concurrent
// Fetch calls — the underlying *http.Client and *cache.Cache are
// both goroutine-safe.
type Aggregator struct {
	httpClient *http.Client
	cache      *cache.Cache[[]TorrentItem]
	logger     Logger

	// gardenFn / acgFn / nyaaFn are the wrapped fetchers.  In
	// production they close over Aggregator.httpClient + .logger.  In
	// tests they're swapped via WithGardenFn / WithAcgFn / WithNyaaFn
	// to control fetch behaviour without an httptest server.
	gardenFn fetchFn
	acgFn    fetchFn
	nyaaFn   fetchFn

	// ownsCache marks whether New created the cache (and therefore
	// must Close it on Aggregator teardown) versus the caller
	// supplying one via WithCache.  Close() consults this flag.
	ownsCache bool
}

// Option mutates an Aggregator during construction.  See New().
type Option func(*Aggregator)

// WithHTTPClient swaps the underlying *http.Client.  Useful for
// injecting a transport with instrumentation, custom timeouts, or
// httptest recording.  When the production fetchFns are used, this
// client is what they hit upstream with.
//
// The aggregator does NOT set a default Timeout on the client — the
// per-source ctx.WithTimeout below is the authoritative deadline.
// Setting http.Client.Timeout would fire BEFORE the context expires
// and produce a less-informative error.
func WithHTTPClient(c *http.Client) Option {
	return func(a *Aggregator) {
		a.httpClient = c
	}
}

// WithCache supplies a custom *cache.Cache[[]TorrentItem] (different
// TTL, different sizing, shared across components, etc.).  When this
// is used, Close() does NOT close the supplied cache — the caller
// owns its lifecycle.
func WithCache(c *cache.Cache[[]TorrentItem]) Option {
	return func(a *Aggregator) {
		a.cache = c
		a.ownsCache = false
	}
}

// WithLogger sets the optional warning logger.  When nil (the
// default), zero-result and per-source failure warnings are silently
// dropped.  In production wire this to slog so silent-failure
// tripwires are searchable.
func WithLogger(l Logger) Option {
	return func(a *Aggregator) {
		a.logger = l
	}
}

// WithGardenFn replaces the garden fetcher.  Test-only.  Allows
// aggregator tests to control timing, failure, and result content
// without spinning up an httptest server.
func WithGardenFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.gardenFn = f
	}
}

// WithAcgFn replaces the acg.rip fetcher.  Test-only.
func WithAcgFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.acgFn = f
	}
}

// WithNyaaFn replaces the nyaa.si fetcher.  Test-only.
func WithNyaaFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.nyaaFn = f
	}
}

// New constructs an Aggregator with sensible production defaults:
//
//   - 1-hour TTL cache sized to 500 entries
//   - No HTTP client timeout (per-source ctx.WithTimeout is authoritative)
//   - No logger (use WithLogger to enable)
//   - Production fetchers (FetchGarden, FetchAcgRip, FetchNyaa)
//
// Returns an error only if the underlying cache fails to initialise
// (negative ristretto sizing — should never happen with the constants
// here, but the error is surfaced for completeness).
func New(opts ...Option) (*Aggregator, error) {
	a := &Aggregator{
		httpClient: &http.Client{},
		ownsCache:  true,
	}

	// Default cache.  Numeric inputs chosen to match Express's
	// torrentCache: 500 entries, 1h TTL.  ristretto recommends
	// NumCounters ~ 10x expected items.
	c, err := cache.New[[]TorrentItem](cache.Config{
		NumCounters: int64(torrentCacheMax) * 10,
		MaxCost:     int64(torrentCacheMax),
		DefaultTTL:  torrentCacheTTL,
	})
	if err != nil {
		return nil, err
	}
	a.cache = c

	// Apply options before binding the default fetchers so a caller
	// who supplies a WithHTTPClient option gets that client baked
	// into the closures.
	for _, opt := range opts {
		opt(a)
	}

	// Wire production fetchers, but only if the caller didn't supply
	// test stubs.  Closures capture a.httpClient + a.logger as they
	// stood AFTER options were applied.
	if a.gardenFn == nil {
		a.gardenFn = func(ctx context.Context, q string) ([]TorrentItem, error) {
			return FetchGarden(ctx, a.httpClient, a.logger, q)
		}
	}
	if a.acgFn == nil {
		a.acgFn = func(ctx context.Context, q string) ([]TorrentItem, error) {
			return FetchAcgRip(ctx, a.httpClient, q)
		}
	}
	if a.nyaaFn == nil {
		a.nyaaFn = func(ctx context.Context, q string) ([]TorrentItem, error) {
			return FetchNyaa(ctx, a.httpClient, q)
		}
	}

	return a, nil
}

// Close releases the underlying ristretto cache.  Safe to call
// multiple times.  Only closes the cache if Aggregator created it
// (i.e. WithCache wasn't used); a caller-supplied cache is left
// alone.
func (a *Aggregator) Close() {
	if a.ownsCache && a.cache != nil {
		a.cache.Close()
	}
}

// Fetch returns aggregated torrents from all three sources for q.
//
// Behaviour:
//
//	1. Trim + lowercase q.  Empty → return [] immediately, no cache,
//	   no upstream calls.
//	2. Cache hit → return the cached slice as-is.
//	3. Cache miss → kick off three goroutines via errgroup.WithContext,
//	   each with its own 8s ctx.WithTimeout.  Per-source errors are
//	   logged via the optional Logger and converted to an empty slice
//	   for that source.  errgroup is used purely for goroutine
//	   lifetime management — its own error channel is never returned
//	   (we don't propagate per-source errors up).
//	4. Merge in deterministic order: garden, acg, nyaa.  Cache the
//	   merged slice.
//
// Returns (nil, ctx.Err()) only when the caller's context is cancelled
// before any goroutine completes — partial failures are never errors.
func (a *Aggregator) Fetch(ctx context.Context, q string) ([]TorrentItem, error) {
	key := strings.ToLower(strings.TrimSpace(q))
	if key == "" {
		// Defensive — the HTTP handler validates q upstream and
		// rejects empty queries with a 400.  This guard just stops a
		// misconfigured caller from triggering three upstream calls
		// for nothing.
		return []TorrentItem{}, nil
	}

	if cached, hit := a.cache.Get(key); hit {
		return cached, nil
	}

	// errgroup.WithContext gives each goroutine a derived context that
	// is cancelled the moment any goroutine returns an error.  We never
	// return non-nil from a goroutine (per-source errors are absorbed
	// below) so the group context survives until all three finish.
	// That preserves Express's Promise.allSettled "wait for everyone"
	// semantics.
	g, gctx := errgroup.WithContext(ctx)

	var (
		gardenResults []TorrentItem
		acgResults    []TorrentItem
		nyaaResults   []TorrentItem
	)

	g.Go(func() error {
		gardenResults = a.runOne(gctx, "garden", a.gardenFn, q)
		return nil
	})
	g.Go(func() error {
		acgResults = a.runOne(gctx, "acg", a.acgFn, q)
		return nil
	})
	g.Go(func() error {
		nyaaResults = a.runOne(gctx, "nyaa", a.nyaaFn, q)
		return nil
	})

	if err := g.Wait(); err != nil {
		// runOne never returns non-nil, so g.Wait() can only surface
		// here if the parent ctx was cancelled.  Propagate as-is.
		return nil, err
	}

	merged := make([]TorrentItem, 0, len(gardenResults)+len(acgResults)+len(nyaaResults))
	merged = append(merged, gardenResults...)
	merged = append(merged, acgResults...)
	merged = append(merged, nyaaResults...)

	a.cache.Set(key, merged)

	return merged, nil
}

// runOne wraps a single fetchFn with the per-source 8s timeout and the
// partial-failure tripwire.  Always returns a non-nil slice (possibly
// empty) so the caller can append unconditionally.
//
// The source parameter is purely for logging — it tags the warning
// with which upstream failed so an oncall grep can pinpoint the cause.
func (a *Aggregator) runOne(parent context.Context, source string, fn fetchFn, q string) []TorrentItem {
	ctx, cancel := context.WithTimeout(parent, perSourceTimeout)
	defer cancel()

	items, err := fn(ctx, q)
	if err != nil {
		if a.logger != nil {
			a.logger.Warn("torrents: source failed", "source", source, "error", err.Error())
		}
		return nil
	}
	return items
}
