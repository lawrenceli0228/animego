// Package torrents — aggregator.go
//
// Parallel fan-out + cache + partial-tolerance.  This is the
// orchestrating layer the HTTP handler will call.  It fans out over a
// pluggable Registry of Sources (source.go / registry.go) instead of
// naming the upstreams directly; the concrete fetch logic still lives in
// the FetchXxx functions in garden.go / acgrip.go / nyaa.go, which the
// per-source adapters wrap.
//
// Behaviour port of server/controllers/anime.controller.js:289-325:
//   - The registered upstream sources run concurrently (errgroup; in
//     Express it's Promise.allSettled).
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

// torrentCacheTTL is the per-query result TTL for a NON-EMPTY result.
// Express uses 1h (60 * 60 * 1000ms).  An hour is generous; raw upstream
// RSS feeds rarely change within that window.
const torrentCacheTTL = 1 * time.Hour

// torrentEmptyCacheTTL is the (much shorter) TTL for an EMPTY result —
// every source returned nothing.  An all-source miss is far more often a
// transient upstream hiccup (timeout / rate-limit / one-off schema blip)
// than a genuine "no torrents exist for this query", so pinning it for the
// full hour would blackhole the query long after the sources recover.  A
// short TTL still absorbs a burst of identical empty queries while letting
// a retry re-hit upstream soon.  (Express cached empties for the full hour
// too — this is a deliberate divergence that fixes that latent bug.)
const torrentEmptyCacheTTL = 5 * time.Minute

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

// Aggregator runs the registered upstream sources in parallel with a
// per-source timeout, partial-failure tolerance, and a 1-hour
// per-query cache.  Constructed via New().
//
// All fields are package-private; callers configure via Option
// setters at construction time.  Aggregator is safe for concurrent
// Fetch calls — the underlying *http.Client and *cache.Cache are
// both goroutine-safe, and the Registry is treated as read-only once
// New returns.
type Aggregator struct {
	httpClient *http.Client
	cache      *cache.Cache[[]TorrentItem]
	logger     Logger

	// registry holds the ordered set of Fetchers fanned out to in Fetch.
	// New() populates it with garden, acg, nyaa (in that order); the
	// WithGardenFn / WithAcgFn / WithNyaaFn options override individual
	// entries in place so merge order is preserved.
	registry *Registry

	// emptyCacheTTL is how long an empty (all-sources-missed) result is
	// cached.  Defaults to torrentEmptyCacheTTL; WithEmptyCacheTTL overrides
	// it (test-only, so the short-TTL regression test doesn't wait minutes).
	emptyCacheTTL time.Duration

	// gardenFn / acgFn / nyaaFn / dmhyFn / mikanFn hold the per-source
	// override stubs set by WithGardenFn / WithAcgFn / WithNyaaFn /
	// WithDmhyFn / WithMikanFn.  In production New() also fills them with
	// closures over the real source adapters, then folds them into the
	// registry — so they double as the resolved fetcher for each built-in
	// source.  Tests swap them to control fetch behaviour without an
	// httptest server (and, for dmhy/mikan, to keep the aggregator's own
	// orchestration tests off the network now that those two are in the
	// default registry).
	gardenFn fetchFn
	acgFn    fetchFn
	nyaaFn   fetchFn
	dmhyFn   fetchFn
	mikanFn  fetchFn

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

// WithEmptyCacheTTL overrides how long an empty (all-sources-returned-
// nothing) result stays cached.  Production uses torrentEmptyCacheTTL; this
// is a test-only knob so the short-TTL regression can assert expiry without
// waiting the real window.  Mirrors the WithGardenFn/WithAcgFn/WithNyaaFn
// test-affordance pattern already in this package.
func WithEmptyCacheTTL(d time.Duration) Option {
	return func(a *Aggregator) {
		a.emptyCacheTTL = d
	}
}

// WithGardenFn overrides the garden source with a single-function stub.
// Test-only.  New() folds the stub into the registry under the garden
// Name (preserving its merge position), so aggregator tests can control
// timing, failure, and result content without spinning up an httptest
// server.
func WithGardenFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.gardenFn = f
	}
}

// WithAcgFn overrides the acg.rip source with a single-function stub.
// Test-only.  See WithGardenFn.
func WithAcgFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.acgFn = f
	}
}

// WithNyaaFn overrides the nyaa.si source with a single-function stub.
// Test-only.  See WithGardenFn.
func WithNyaaFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.nyaaFn = f
	}
}

// WithDmhyFn overrides the share.dmhy.org source with a single-function
// stub.  Test-only.  See WithGardenFn.  Because dmhy is in the default
// registry, the aggregator's own orchestration tests use this to keep the
// dmhy slot off the network.
func WithDmhyFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.dmhyFn = f
	}
}

// WithMikanFn overrides the mikanani.me source with a single-function
// stub.  Test-only.  See WithGardenFn.  Because mikan is in the default
// registry, the aggregator's own orchestration tests use this to keep the
// mikan slot off the network.
func WithMikanFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.mikanFn = f
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
		httpClient:    &http.Client{},
		ownsCache:     true,
		emptyCacheTTL: torrentEmptyCacheTTL,
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

	// Build the default fan-out registry in the canonical merge order:
	// garden → acg → nyaa → dmhy → mikan.  These are the real source
	// adapters, binding a.httpClient + a.logger as they stood AFTER
	// options were applied — so the source structs are the genuine
	// production path, not dead code.  dmhy + mikan are appended last so
	// the established garden/acg/nyaa ordering (which several tests assert)
	// is unchanged; they share the same *http.Client as the others.
	a.registry = NewRegistry(
		gardenSource{client: a.httpClient, logger: a.logger},
		acgSource{client: a.httpClient},
		nyaaSource{client: a.httpClient},
		dmhySource{client: a.httpClient},
		mikanSource{client: a.httpClient},
	)

	// Apply any per-source override stubs (WithGardenFn / WithAcgFn /
	// WithNyaaFn) by swapping the matching source IN PLACE, so an override
	// keeps its merge position.  The gardenFn / acgFn / nyaaFn fields are
	// also normalised to the resolved fetcher (override stub or the
	// adapter's Fetch) so the field-introspection tests still see them
	// non-nil and pointing at what actually runs.
	a.gardenFn = a.resolveSource(SourceGarden, a.gardenFn)
	a.acgFn = a.resolveSource(SourceAcg, a.acgFn)
	a.nyaaFn = a.resolveSource(SourceNyaa, a.nyaaFn)
	a.dmhyFn = a.resolveSource(SourceDmhy, a.dmhyFn)
	a.mikanFn = a.resolveSource(SourceMikan, a.mikanFn)

	return a, nil
}

// resolveSource reconciles a per-source override stub with the registry:
//   - override != nil → replace the registry entry named name with a
//     funcSource wrapping the stub (preserving position) and return the
//     stub as the resolved fn.
//   - override == nil → look up the default source already in the
//     registry under name and return its Fetch as the resolved fn.
//
// The returned fn is stored back on the matching gardenFn / acgFn /
// nyaaFn field so it always reflects the fetcher that actually runs.
func (a *Aggregator) resolveSource(name Source, override fetchFn) fetchFn {
	if override != nil {
		a.registry.replaceByName(newFuncSource(name, override))
		return override
	}
	for _, s := range a.registry.Sources() {
		if s.Name() == name {
			return s.Fetch
		}
	}
	return nil
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

// Fetch returns aggregated torrents from every registered source for q.
//
// Behaviour:
//
//  1. Trim + lowercase q.  Empty → return [] immediately, no cache,
//     no upstream calls.
//  2. Cache hit → return the cached slice as-is.
//  3. Cache miss → kick off one goroutine per registered source via
//     errgroup.WithContext, each with its own 8s ctx.WithTimeout.
//     Per-source errors are logged via the optional Logger and
//     converted to an empty slice for that source.  errgroup is used
//     purely for goroutine lifetime management — its own error channel
//     is never returned (we don't propagate per-source errors up).
//  4. Merge in registration order (garden, acg, nyaa by default).
//     Cache the merged slice — a non-empty result for the full 1h TTL,
//     an empty one only briefly (emptyCacheTTL) so a transient
//     all-source miss isn't pinned for an hour after the sources recover.
//
// Returns (nil, ctx.Err()) only when the caller's context is cancelled
// before any goroutine completes — partial failures are never errors.
func (a *Aggregator) Fetch(ctx context.Context, q string) ([]TorrentItem, error) {
	key := strings.ToLower(strings.TrimSpace(q))
	if key == "" {
		// Defensive — the HTTP handler validates q upstream and
		// rejects empty queries with a 400.  This guard just stops a
		// misconfigured caller from triggering upstream calls for
		// nothing.
		return []TorrentItem{}, nil
	}

	if cached, hit := a.cache.Get(key); hit {
		return cached, nil
	}

	sources := a.registry.Sources()

	// errgroup.WithContext gives each goroutine a derived context that
	// is cancelled the moment any goroutine returns an error.  We never
	// return non-nil from a goroutine (per-source errors are absorbed
	// below) so the group context survives until all sources finish.
	// That preserves Express's Promise.allSettled "wait for everyone"
	// semantics.
	g, gctx := errgroup.WithContext(ctx)

	// results is indexed by source position so the merge below stays in
	// registration order regardless of which goroutine finishes first.
	results := make([][]TorrentItem, len(sources))

	for i, src := range sources {
		i, src := i, src // capture per iteration for the goroutine closure
		g.Go(func() error {
			results[i] = a.runOne(gctx, src, q)
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		// runOne never returns non-nil, so g.Wait() can only surface
		// here if the parent ctx was cancelled.  Propagate as-is.
		return nil, err
	}

	total := 0
	for _, r := range results {
		total += len(r)
	}
	merged := make([]TorrentItem, 0, total)
	for _, r := range results {
		merged = append(merged, r...)
	}

	// Quality-aware TTL: a non-empty result is stable for the full hour;
	// an empty one (every source missed) is cached only briefly so a
	// transient upstream blip doesn't pin the query empty for an hour.
	if len(merged) > 0 {
		a.cache.Set(key, merged)
	} else {
		a.cache.SetWithTTL(key, merged, a.emptyCacheTTL)
	}

	return merged, nil
}

// runOne wraps a single Fetcher with the per-source 8s timeout and the
// partial-failure tripwire.  Always returns a non-nil slice (possibly
// empty) so the caller can append unconditionally.
//
// The fetcher's Name is used purely for logging — it tags the warning
// with which upstream failed so an oncall grep can pinpoint the cause.
func (a *Aggregator) runOne(parent context.Context, src Fetcher, q string) []TorrentItem {
	ctx, cancel := context.WithTimeout(parent, perSourceTimeout)
	defer cancel()

	items, err := src.Fetch(ctx, q)
	if err != nil {
		if a.logger != nil {
			a.logger.Warn("torrents: source failed", "source", string(src.Name()), "error", err.Error())
		}
		return nil
	}
	return items
}
