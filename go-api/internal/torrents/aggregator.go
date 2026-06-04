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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
	"golang.org/x/time/rate"

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

	// gardenFn / acgFn / nyaaFn / dmhyFn / mikanFn / toshoFn hold the
	// per-source override stubs set by WithGardenFn / WithAcgFn /
	// WithNyaaFn / WithDmhyFn / WithMikanFn / WithToshoFn.  In production
	// New() also fills them with closures over the real source adapters,
	// then folds them into the registry — so they double as the resolved
	// fetcher for each built-in source.  Tests swap them to control fetch
	// behaviour without an httptest server (and, for dmhy/mikan/tosho, to
	// keep the aggregator's own orchestration tests off the network now
	// that those are in the default registry).
	gardenFn fetchFn
	acgFn    fetchFn
	nyaaFn   fetchFn
	dmhyFn   fetchFn
	mikanFn  fetchFn
	toshoFn  fetchFn

	// ownsCache marks whether New created the cache (and therefore
	// must Close it on Aggregator teardown) versus the caller
	// supplying one via WithCache.  Close() consults this flag.
	ownsCache bool

	// sourceLimiters holds the per-source outbound rate limiter
	// (*rate.Limiter), keyed by Source.  runOne paces each upstream call
	// through limiterFor(src).Wait so the fan-out (variant expansion +
	// concurrent multi-source queries) can't burst a single source hard
	// enough to earn an IP ban.  See throttle.go.
	//
	// Deliberately a sync.Map whose ZERO VALUE is usable: it needs no
	// initialisation in New(), so this throttle touches only runOne and
	// this one field — the constructor (and the source registration that
	// lives there) stays untouched.  Limiters are built lazily on first
	// request to each source via LoadOrStore (concurrency-safe).
	sourceLimiters sync.Map

	// sourceRate / sourceBurst are optional per-Aggregator overrides for
	// the per-source token bucket, set by WithSourceRate.  Zero means
	// "unset" → limiterFor falls back to defaultSourceRate /
	// defaultSourceBurst.  Keeping the default in the zero value is what
	// lets New() stay untouched.
	sourceRate  rate.Limit
	sourceBurst int
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

// WithToshoFn overrides the feed.animetosho.org source with a
// single-function stub.  Test-only.  See WithGardenFn.  Because tosho is
// in the default registry, the aggregator's own orchestration tests (and
// the anime handler tests) use this to keep the tosho slot off the
// network.
func WithToshoFn(f fetchFn) Option {
	return func(a *Aggregator) {
		a.toshoFn = f
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
	// garden → acg → nyaa → dmhy → mikan → tosho.  These are the real
	// source adapters, binding a.httpClient + a.logger as they stood AFTER
	// options were applied — so the source structs are the genuine
	// production path, not dead code.  dmhy + mikan + tosho are appended
	// last so the established garden/acg/nyaa ordering (which several tests
	// assert) is unchanged; they share the same *http.Client as the others.
	// tosho carries a.logger (like garden) because its JSON fetch emits the
	// same silent-failure tripwire, and it is the one source advertising
	// Capable (SupportsSeeders + Priority).
	a.registry = NewRegistry(
		gardenSource{client: a.httpClient, logger: a.logger},
		acgSource{client: a.httpClient},
		nyaaSource{client: a.httpClient},
		dmhySource{client: a.httpClient},
		mikanSource{client: a.httpClient},
		animeToshoSource{client: a.httpClient, logger: a.logger},
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
	a.toshoFn = a.resolveSource(SourceTosho, a.toshoFn)

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

	merged, err := a.fanOut(ctx, q)
	if err != nil {
		// fanOut only surfaces an error when the parent ctx was cancelled
		// before any goroutine completed (runOne never returns non-nil).
		// Propagate as-is.
		return nil, err
	}

	// Normalise → dedup → rank → cache.  Shared with FetchForAnime so the
	// single-query and multi-variant paths collapse duplicates and apply the
	// quality-aware TTL identically.
	merged = a.finalise(merged)
	a.cacheResult(key, merged)

	return merged, nil
}

// FetchForAnime is the id-keyed counterpart to Fetch: instead of a single
// caller-supplied keyword it runs the registry fan-out once PER title
// variant and, when anidbID is non-nil, folds in AnimeTosho's complete
// AniDB-id feed (?aid=).  The combined rows are deduped (by infohash, so
// the inevitable overlap between AnimeTosho's keyword hits and its aid
// feed collapses harmlessly) and ranked by seeders exactly like Fetch.
//
// Behaviour:
//
//  1. Variants are trimmed of surrounding whitespace and empties dropped.
//     With no usable variant AND no anidbID there is nothing to search →
//     return [] immediately (no upstream calls, no cache).
//  2. Cache key is the sorted-join of the cleaned variant set plus the
//     optional aid, so a show whose four titles produce the same variant
//     set shares ONE cache entry rather than caching each variant
//     separately.  A hit returns the cached slice as-is.
//  3. Cache miss → fan out the registry over every variant concurrently
//     (errgroup), plus one AnimeTosho aid-feed call when anidbID != nil.
//     Per-variant / per-source failures are absorbed exactly as in Fetch
//     (logged, treated as empty) — only a parent-ctx cancellation surfaces
//     as a top-level error.
//  4. Merge → dedup → rank → cache, sharing finalise + cacheResult with
//     Fetch (same quality-aware TTL: long for a non-empty result, short
//     for an all-source miss).
//
// The per-source outbound throttle (runOne → limiterFor) still paces each
// upstream, so even though this issues variants × sources requests the
// token buckets keep any single source's outbound rate bounded.
func (a *Aggregator) FetchForAnime(ctx context.Context, variants []string, anidbID *int32) ([]TorrentItem, error) {
	clean := cleanVariants(variants)
	if len(clean) == 0 && anidbID == nil {
		// Nothing to search on — neither a keyword variant nor an aid feed.
		return []TorrentItem{}, nil
	}

	key := animeCacheKey(clean, anidbID)
	if cached, hit := a.cache.Get(key); hit {
		return cached, nil
	}

	// Collect every variant's fan-out result plus the optional aid feed into
	// position-indexed slots so the merge order is deterministic regardless
	// of which goroutine finishes first: variants in their (cleaned) order,
	// then the aid feed last.
	results := make([][]TorrentItem, len(clean)+1)

	g, gctx := errgroup.WithContext(ctx)
	for i, v := range clean {
		i, v := i, v
		g.Go(func() error {
			items, err := a.fanOut(gctx, v)
			if err != nil {
				return err
			}
			results[i] = items
			return nil
		})
	}
	if anidbID != nil {
		aid := int(*anidbID)
		g.Go(func() error {
			results[len(clean)] = a.runToshoAniDB(gctx, aid)
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		// Only a parent-ctx cancellation reaches here (fanOut/runToshoAniDB
		// absorb per-source failures).  Propagate as-is.
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

	merged = a.finalise(merged)
	a.cacheResult(key, merged)

	return merged, nil
}

// fanOut runs the registry fan-out for a SINGLE query q: one goroutine per
// registered source (errgroup, per-source 8s timeout + partial-failure
// tolerance via runOne), merged in registration order.  It does NOT dedup,
// rank, or cache — the callers (Fetch for one query, FetchForAnime for many
// variants) own that so a multi-variant result is deduped across variants
// rather than within each.
//
// Returns (nil, ctx.Err()) only when the caller's context is cancelled
// before any goroutine completes — per-source failures are never errors.
func (a *Aggregator) fanOut(ctx context.Context, q string) ([]TorrentItem, error) {
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
	return merged, nil
}

// finalise runs the normalise → dedup → rank pipeline over a merged,
// multi-source (and, for FetchForAnime, multi-variant) slice before it is
// cached/returned.  parseInfohash runs off each row's magnet
// (source-agnostic), so the same torrent surfaced by two sources — or by
// AnimeTosho's keyword search and its aid feed — collapses to a single best
// copy, and the survivors come back ordered by seeders (nil sinks last) →
// date → source priority.  ranks is derived from the registry once and
// threaded through both passes so the per-source tie-break is consistent.
// Both helpers return fresh slices (immutability), so the input is never
// mutated in place.
func (a *Aggregator) finalise(merged []TorrentItem) []TorrentItem {
	ranks := sourceRanks(a.registry)
	return rankItems(dedupByInfohash(merged, ranks), ranks)
}

// cacheResult writes a finalised slice under key with the quality-aware
// TTL: a non-empty result is stable for the full hour; an empty one (every
// source missed) is cached only briefly (emptyCacheTTL) so a transient
// upstream blip doesn't pin the query empty for an hour.  Shared by Fetch
// and FetchForAnime so both paths cache identically.
func (a *Aggregator) cacheResult(key string, merged []TorrentItem) {
	if len(merged) > 0 {
		a.cache.Set(key, merged)
	} else {
		a.cache.SetWithTTL(key, merged, a.emptyCacheTTL)
	}
}

// runToshoAniDB wraps the AnimeTosho aid-feed fetch (FetchAnimeToshoByAniDB)
// with the same per-source timeout + partial-failure tripwire runOne applies
// to a registry source.  It is NOT a registry Fetcher (the aid feed is keyed
// by an integer id, not the query string the Fetcher interface carries), so
// it gets its own thin wrapper here that mirrors runOne's contract: always
// return a non-nil-safe slice (empty on failure) and never panic.  The
// throttle uses SourceTosho's bucket so the aid feed shares the keyword
// source's outbound rate budget.
func (a *Aggregator) runToshoAniDB(parent context.Context, aid int) []TorrentItem {
	ctx, cancel := context.WithTimeout(parent, perSourceTimeout)
	defer cancel()

	if err := a.limiterFor(SourceTosho).Wait(ctx); err != nil {
		if a.logger != nil {
			a.logger.Warn("torrents: tosho aid-feed rate-limit wait aborted", "aid", aid, "error", err.Error())
		}
		return nil
	}

	items, err := FetchAnimeToshoByAniDB(ctx, a.httpClient, aid)
	if err != nil {
		if a.logger != nil {
			a.logger.Warn("torrents: tosho aid-feed failed", "aid", aid, "error", err.Error())
		}
		return nil
	}
	return items
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

	// Per-source outbound throttle (throttle.go).  Wait blocks until this
	// source's token bucket admits the request or ctx is done; with the
	// default burst the first request for a source passes through instantly,
	// so a single-request-per-source query is never paced — only a burst
	// past the bucket depth is.  Wait consumes the per-source ctx budget, so
	// a cancelled/expired ctx makes it return that error; we treat that
	// exactly like any other source failure (log + empty slice) rather than
	// letting it panic or propagate.
	if err := a.limiterFor(src.Name()).Wait(ctx); err != nil {
		if a.logger != nil {
			a.logger.Warn("torrents: source rate-limit wait aborted", "source", string(src.Name()), "error", err.Error())
		}
		return nil
	}

	items, err := src.Fetch(ctx, q)
	if err != nil {
		if a.logger != nil {
			a.logger.Warn("torrents: source failed", "source", string(src.Name()), "error", err.Error())
		}
		return nil
	}
	return items
}

// cleanVariants trims surrounding whitespace from each variant and drops
// empties, preserving input order.  Case-insensitive de-duplication is the
// handler's job (it builds the variant set from the four titles and caps it
// at 4 before calling FetchForAnime); this is the defensive
// trim-and-drop-empty pass so a stray "" or "  " variant never issues a
// pointless fan-out.  Returns a fresh slice; the input is not mutated.
func cleanVariants(variants []string) []string {
	out := make([]string, 0, len(variants))
	for _, v := range variants {
		if t := strings.TrimSpace(v); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// animeCacheKey builds the FetchForAnime cache key from a cleaned variant
// set plus the optional AniDB id.  The variants are lower-cased and SORTED
// before joining so a show whose titles arrive in any order — or whose
// variant set is identical to another request's — collapses to ONE cache
// entry rather than caching per variant or per ordering.  The aid (when
// present) is appended so a keyword-only request and an aid-augmented one
// for the same titles don't collide (the aid feed can add rows the keyword
// search misses).  A leading marker namespaces these keys away from Fetch's
// single-query keys so a one-keyword Fetch and a single-variant
// FetchForAnime never alias.
func animeCacheKey(clean []string, anidbID *int32) string {
	lowered := make([]string, len(clean))
	for i, v := range clean {
		lowered[i] = strings.ToLower(v)
	}
	sort.Strings(lowered)

	key := "anime:" + strings.Join(lowered, "\x00")
	if anidbID != nil {
		key += "|aid=" + strconv.Itoa(int(*anidbID))
	}
	return key
}
