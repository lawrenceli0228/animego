// Package torrents — throttle.go
//
// Per-source outbound rate limiting for the fan-out aggregator.
//
// Why this exists.  A single user query already fans out one request per
// registered source (garden / acg / nyaa / dmhy / mikan).  Two forces
// amplify that fan-out into something an upstream can read as abuse and
// answer with an IP ban:
//
//   - Variant expansion: a query can expand into several title variants,
//     each issued against every source.
//   - Multi-source bursts: several concurrent queries land at once and
//     every source sees the sum of all of them simultaneously.
//
// The aggregator's per-source ctx.WithTimeout (perSourceTimeout) bounds
// how long one request may run, but it does nothing about how MANY
// requests hit a source per second.  This file adds that missing bound: a
// token-bucket limiter PER SOURCE, so each upstream sees a smooth,
// bounded outbound rate regardless of how the fan-out above stacks up.
//
// Design mirrors internal/anilist/client.go's throttle (golang.org/x/time/rate
// token bucket + limiter.Wait(ctx)), with one deliberate difference: the
// magnet sources are not policed nearly as strictly as AniList's 90 req/min
// cap, so the default here is looser (a few req/s with a small burst)
// instead of AniList's 700ms / burst-1.  A single in-flight request per
// source per query must pass through with ZERO added latency — only
// genuine bursts are paced.
//
// Ownership note: the limiter container is a sync.Map field on Aggregator
// whose ZERO VALUE is ready to use.  That is intentional — it means New()
// needs no initialisation for it, so this feature touches only runOne and
// one struct field, leaving the constructor (and the source registration
// that happens there) untouched.
package torrents

import (
	"golang.org/x/time/rate"
)

// defaultSourceRate is the steady-state token refill rate applied to EACH
// source independently.  At ~2 tokens/second a source's bucket replenishes
// one allowance every 500ms once drained.
//
// This is deliberately looser than anilist's 700ms / burst-1: the magnet
// RSS sources do not advertise (and are not observed to enforce) anything
// like AniList's documented 90 req/min ceiling, so policing them that
// tightly would needlessly serialise legitimate variant fan-out.  ~2 req/s
// still smooths a runaway burst enough to keep us off an upstream's ban
// radar.  Tunable here, the same way perSourceTimeout lives as a constant.
const defaultSourceRate rate.Limit = 2

// defaultSourceBurst is the bucket depth — the number of requests a single
// source will admit instantly before the steady-state rate starts pacing
// them.  3 is chosen so the common case (one in-flight request per source
// for a single query, occasionally two or three when a query expands into
// a couple of title variants) passes through with no added latency, while
// a sustained flood past the burst is throttled to defaultSourceRate.
//
// Burst MUST be >= 1 or NewLimiter would admit nothing and Wait would block
// forever; limiterFor clamps it defensively.
const defaultSourceBurst = 3

// limiterFor returns the *rate.Limiter governing outbound requests to src,
// lazily constructing it on first use and caching it in the Aggregator's
// sourceLimiters map so every later request to the same source shares one
// bucket.
//
// Concurrency: sourceLimiters is a sync.Map, so concurrent runOne
// goroutines (the fan-out fires all sources at once) can race to create the
// same source's limiter safely.  LoadOrStore guarantees exactly one limiter
// per source wins — a redundant *rate.Limiter built by a losing racer is
// simply discarded, never observed by Wait.
//
// The rate/burst come from the per-Aggregator overrides (sourceRate /
// sourceBurst) when set via WithSourceRate, else from the package defaults.
// Reading zero-valued fields here is what lets New() stay untouched: an
// Aggregator built without WithSourceRate has sourceRate == 0 /
// sourceBurst == 0 and transparently falls back to the constants below.
func (a *Aggregator) limiterFor(src Source) *rate.Limiter {
	if existing, ok := a.sourceLimiters.Load(src); ok {
		return existing.(*rate.Limiter)
	}

	r := a.sourceRate
	if r <= 0 {
		r = defaultSourceRate
	}
	burst := a.sourceBurst
	if burst < 1 {
		burst = defaultSourceBurst
	}

	// LoadOrStore so two goroutines creating the limiter for the same
	// source converge on a single shared bucket; the loser's freshly-built
	// limiter is dropped.
	actual, _ := a.sourceLimiters.LoadOrStore(src, rate.NewLimiter(r, burst))
	return actual.(*rate.Limiter)
}

// WithSourceRate overrides the per-source outbound rate limit.  Optional —
// production runs on the package defaults (defaultSourceRate /
// defaultSourceBurst).  Provided so the rate can be tuned (e.g. tightened
// for a flaky upstream) or, in tests, sped up so rate-limit behaviour can be
// asserted in microseconds instead of the half-second the production rate
// implies.
//
// r is tokens per second (rate.Limit); pass rate.Every(d) at the call site
// if you prefer to think in intervals.  burst is the bucket depth; values
// < 1 are clamped up to the default by limiterFor so a misconfigured caller
// can never deadlock Wait.  A burst of 0 passed here is treated as "unset"
// and falls back to the default — pass an explicit positive burst to take
// effect.
//
// Mirrors the WithEmptyCacheTTL / WithGardenFn affordance pattern already in
// this package: it sets struct fields that New() applies through its
// existing option loop, so the constructor body itself is unchanged.
func WithSourceRate(r rate.Limit, burst int) Option {
	return func(a *Aggregator) {
		a.sourceRate = r
		a.sourceBurst = burst
	}
}
