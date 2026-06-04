// Package torrents — throttle_test.go
//
// Covers the per-source outbound rate limiter (throttle.go) and the
// runOne integration points that drive it:
//
//   - limiterFor caches one *rate.Limiter per source (same source → same
//     instance; different sources → independent instances)
//   - the zero-value sourceLimiters map is usable without New() (the whole
//     point of the sync.Map design)
//   - default rate/burst apply when WithSourceRate is unset, and an
//     out-of-range burst is clamped so Wait can never deadlock
//   - within the burst, consecutive same-source requests are admitted with
//     ZERO added latency (a single-request-per-source query is never paced)
//   - once the burst is drained, further same-source requests are spaced by
//     the configured interval (the actual throttle)
//   - different sources throttle independently (draining A doesn't pace B)
//   - runOne treats a cancelled ctx during Wait as a source failure: empty
//     slice, no panic, fetcher never invoked, warning logged
//
// All timing tests use WithSourceRate with a fast rate so they assert in
// sub-millisecond windows rather than the half-second the production rate
// implies — the existing aggregator tests deliberately do NOT touch the
// limiter and run on the (instant-for-one-request) defaults.
package torrents

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/time/rate"
)

// ---------------------------------------------------------------------------
// limiterFor: lazy construction, caching, per-source isolation
// ---------------------------------------------------------------------------

// A zero-value Aggregator must be enough to hand out limiters — that is the
// contract that lets New() stay untouched (sync.Map zero value is usable).
func TestLimiterFor_ZeroValueAggregator_UsableWithoutNew(t *testing.T) {
	t.Parallel()

	var a Aggregator // no New(), no initialisation

	lim := a.limiterFor(SourceGarden)
	require.NotNil(t, lim)
	// Default burst applies → the first request is admitted immediately.
	assert.True(t, lim.Allow(), "first request within default burst should be admitted")
}

// Same source → same cached limiter; different sources → different limiters.
func TestLimiterFor_CachesPerSourceAndIsolates(t *testing.T) {
	t.Parallel()

	var a Aggregator

	garden1 := a.limiterFor(SourceGarden)
	garden2 := a.limiterFor(SourceGarden)
	acg := a.limiterFor(SourceAcg)

	assert.Same(t, garden1, garden2, "same source must return the identical cached *rate.Limiter")
	assert.NotSame(t, garden1, acg, "different sources must get independent limiters")
}

// Defaults are applied when WithSourceRate is unset.
func TestLimiterFor_AppliesDefaults(t *testing.T) {
	t.Parallel()

	var a Aggregator
	lim := a.limiterFor(SourceNyaa)

	assert.Equal(t, defaultSourceRate, lim.Limit(), "unset rate should fall back to the package default")
	assert.Equal(t, defaultSourceBurst, lim.Burst(), "unset burst should fall back to the package default")
}

// WithSourceRate overrides take effect; an out-of-range burst is clamped up
// to the default so Wait can never deadlock on a zero/negative bucket.
func TestLimiterFor_WithSourceRate_OverridesAndClampsBurst(t *testing.T) {
	t.Parallel()

	t.Run("override applied", func(t *testing.T) {
		t.Parallel()
		var a Aggregator
		WithSourceRate(rate.Limit(50), 7)(&a)

		lim := a.limiterFor(SourceGarden)
		assert.Equal(t, rate.Limit(50), lim.Limit())
		assert.Equal(t, 7, lim.Burst())
	})

	t.Run("non-positive burst clamps to default", func(t *testing.T) {
		t.Parallel()
		var a Aggregator
		WithSourceRate(rate.Limit(50), 0)(&a) // 0 == "unset" → default burst

		lim := a.limiterFor(SourceGarden)
		assert.Equal(t, defaultSourceBurst, lim.Burst(), "burst<1 must clamp up so NewLimiter admits at least one token")
	})
}

// ---------------------------------------------------------------------------
// Throttle behaviour: burst is free, past-burst is paced
// ---------------------------------------------------------------------------

// Within the burst, consecutive same-source Waits return with ~no latency.
// This is the guarantee that a single (or low-variant) query is never slowed.
func TestThrottle_WithinBurst_NoBlocking(t *testing.T) {
	t.Parallel()

	var a Aggregator
	// Slow steady-state rate but a burst of 3: the first 3 requests should
	// still be instant even though the refill is deliberately glacial.
	WithSourceRate(rate.Every(time.Hour), 3)(&a)
	lim := a.limiterFor(SourceGarden)

	ctx := context.Background()
	start := time.Now()
	for i := 0; i < 3; i++ {
		require.NoError(t, lim.Wait(ctx))
	}
	elapsed := time.Since(start)

	assert.Less(t, elapsed, 20*time.Millisecond,
		"the first burst-worth of requests must pass through with no added latency, got %s", elapsed)
}

// Once the burst is drained, further same-source requests are spaced by the
// configured interval — the actual back-pressure that keeps a source off a
// ban list.  Uses a fast rate (burst 1) so the test asserts in a few ms.
func TestThrottle_PastBurst_PacedByRate(t *testing.T) {
	t.Parallel()

	const interval = 5 * time.Millisecond
	var a Aggregator
	WithSourceRate(rate.Every(interval), 1)(&a) // burst 1: 2nd request must wait ~interval
	lim := a.limiterFor(SourceGarden)

	ctx := context.Background()

	start := time.Now()
	require.NoError(t, lim.Wait(ctx)) // consumes the single burst token instantly
	firstElapsed := time.Since(start)
	assert.Less(t, firstElapsed, interval,
		"first request (burst token) should be instant, got %s", firstElapsed)

	start2 := time.Now()
	require.NoError(t, lim.Wait(ctx)) // must wait for the bucket to refill
	secondElapsed := time.Since(start2)

	// Allow scheduler slop on the lower bound (token buckets can release a
	// hair early); the key assertion is that it was NOT instant.
	assert.GreaterOrEqual(t, secondElapsed, interval/2,
		"second request past the burst must be paced by the refill interval, got %s", secondElapsed)
}

// Draining source A's bucket must not pace source B — the limiters are
// independent, so a hot upstream can't stall a cold one.
func TestThrottle_DifferentSourcesIndependent(t *testing.T) {
	t.Parallel()

	const interval = 50 * time.Millisecond
	var a Aggregator
	WithSourceRate(rate.Every(interval), 1)(&a)

	ctx := context.Background()

	// Drain garden's single token.
	require.NoError(t, a.limiterFor(SourceGarden).Wait(ctx))

	// acg is a different source: its first token is still available, so this
	// must be instant despite garden being drained.
	start := time.Now()
	require.NoError(t, a.limiterFor(SourceAcg).Wait(ctx))
	elapsed := time.Since(start)

	assert.Less(t, elapsed, interval/2,
		"a different source must not be paced by a drained one, got %s", elapsed)
}

// ---------------------------------------------------------------------------
// runOne integration: cancelled ctx during Wait is handled gracefully
// ---------------------------------------------------------------------------

// When the limiter Wait sees an already-cancelled ctx it returns an error;
// runOne must absorb that exactly like any other source failure — empty
// slice, no panic, the fetcher never runs, and a warning is logged.
func TestRunOne_WaitCtxCancelled_GracefulEmptyAndLogged(t *testing.T) {
	t.Parallel()

	log := &testLogger{}
	// Bare struct is sufficient: runOne only touches a.logger + the limiter
	// fields, and this keeps the test fully offline (no registry/network).
	a := &Aggregator{logger: log}

	fetchCalled := false
	src := newFuncSource(SourceGarden, func(_ context.Context, _ string) ([]TorrentItem, error) {
		fetchCalled = true
		return []TorrentItem{stubItem(SourceGarden)}, nil
	})

	// Cancel before runOne so the very first limiter.Wait returns ctx.Err().
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var out []TorrentItem
	require.NotPanics(t, func() {
		out = a.runOne(ctx, src, "naruto")
	})

	assert.Empty(t, out, "a cancelled Wait must yield an empty result, not a partial/garbage slice")
	assert.False(t, fetchCalled, "the fetcher must never run once the throttle Wait has failed")

	_, found := log.findEntry("rate-limit wait aborted")
	assert.True(t, found, "the aborted-Wait warning should be logged for oncall visibility")
}

// Counterpart to the cancel test: a healthy ctx within the burst lets runOne
// fetch normally with no throttle-induced delay — proves the happy path the
// existing aggregator tests rely on is preserved through the new Wait call.
func TestRunOne_WithinBurst_FetchesWithoutDelay(t *testing.T) {
	t.Parallel()

	a := &Aggregator{} // no logger needed; default limiter

	src := newFuncSource(SourceGarden, func(_ context.Context, _ string) ([]TorrentItem, error) {
		return []TorrentItem{stubItem(SourceGarden)}, nil
	})

	start := time.Now()
	out := a.runOne(context.Background(), src, "naruto")
	elapsed := time.Since(start)

	require.Len(t, out, 1)
	assert.Equal(t, SourceGarden, out[0].Source)
	assert.Less(t, elapsed, 20*time.Millisecond,
		"first request within the default burst must not be paced, got %s", elapsed)
}
