package httpmw

// api_ratelimit.go — global per-IP rate limit for /api/* traffic.
//
// Express applies an apiLimiter middleware to all /api/* in
// server/index.js:55 — 300 req per 15-minute window per IP (the
// default for express-rate-limit).  Without this on the Go side, every
// non-auth endpoint (anime/dandanplay/admin/comments/danmaku/feed/
// subscriptions/users) is unmetered: a single attacker can hammer
// /api/dandanplay/match (which fans out to a rate-limited upstream
// queue and can exhaust goroutines) or /api/anime/torrents (which
// triggers 3 upstream BT scrapes per call).
//
// Design notes:
//
//   - golang.org/x/time/rate is the standard choice.  One rate.Limiter
//     per IP, refilled at `rate` req/sec, with a burst window equal to
//     the per-15min budget.
//   - Map[ip] *rate.Limiter is bounded via a sweeper goroutine
//     (mirrors auth/ratelimit.go's pattern so memory stays flat under
//     attack).
//   - 429 envelope matches Express's authLimiter shape exactly:
//     { error: { code: "TOO_MANY_REQUESTS", message: "Too many requests, please try again later" } }
//     (the message is the English form already in zh.js / en.js
//     errors dictionary).
//   - /health is exempt — load balancers must always be able to probe.
//     Per-handler decisions about which paths to skip ride on
//     chi.Router's Group/With composition (this middleware is mounted
//     on the /api/* subtree, NOT on /health).

import (
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// APIRateLimit defaults — 300 req per 15 minutes per IP ≈ 1 req / 3s
// sustained, 20 req burst.  Matches express-rate-limit defaults and
// gives normal callers ~10x headroom over what the SPA produces in
// active use (typical anime listing page: ~6 API calls/second on cold
// hit, then ~1 / 10s ambient).
//
// DefaultAPIRate and DefaultAPIBurst are exported so main.go can read
// them when constructing the limiter with an env-driven burst override.
const (
	// The Next.js RSC home render alone fires ~8 server-side /api fetches
	// (trending, schedule, seasonal, rankings, activity, continue-watching,
	// auth/me, ...), and a language-toggle router.refresh re-runs all of
	// them. With next-app now forwarding X-Real-IP the budget is per real
	// user, so size it for a few full renders rather than the old shared
	// next-app-container bucket: 1/sec sustained with a 60-token burst.
	DefaultAPIRate  = rate.Limit(1.0) // 1 token per second (sustained)
	DefaultAPIBurst = 60              // ~7 full RSC renders before throttling

	defaultAPISweepInterval = 5 * time.Minute
	defaultAPIIPMaxIdle     = 30 * time.Minute
)

// apiLimiterStore is a typed wrapper over the per-IP limiter map.
// The mutex protects map access; rate.Limiter is itself goroutine-safe.
type apiLimiterStore struct {
	mu       sync.Mutex
	limiters map[netip.Addr]*ipLimiter

	rateLimit rate.Limit
	burst     int

	sweepInterval time.Duration
	ipMaxIdle     time.Duration
	stopCh        chan struct{}
	stopOnce      sync.Once
}

// ipLimiter wraps the token bucket plus a last-seen timestamp so the
// sweeper can drop idle entries.  Mirrors auth/ratelimit.go.
type ipLimiter struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// NewAPIRateLimiter constructs the store with the Express-parity
// 300/15min defaults.  Caller must defer Stop() to halt the sweeper.
func NewAPIRateLimiter() *apiLimiterStore {
	return NewAPIRateLimiterWithBurst(DefaultAPIRate, DefaultAPIBurst)
}

// NewAPIRateLimiterWithBurst constructs the store with explicit token-bucket
// parameters.  Exported so main.go can wire env-driven overrides for CI.
// Pass rate=0 or burst=0 to disable limiting (all requests pass through).
func NewAPIRateLimiterWithBurst(r rate.Limit, burst int) *apiLimiterStore {
	s := &apiLimiterStore{
		limiters:      make(map[netip.Addr]*ipLimiter),
		rateLimit:     r,
		burst:         burst,
		sweepInterval: defaultAPISweepInterval,
		ipMaxIdle:     defaultAPIIPMaxIdle,
		stopCh:        make(chan struct{}),
	}
	go s.sweep()
	return s
}

// Middleware returns a chi/http middleware that enforces the per-IP
// limit on /api/* paths.  Mount globally — the handler skips itself
// for /health endpoints so load balancers can always probe.
//
// Path filter:
//   - /health           → skip (LB healthcheck, no /api prefix)
//   - /api/health       → skip (same handler at /api/health alias)
//   - /api/* (else)     → rate limit
//   - everything else   → skip (no app paths outside /api at this
//                         layer; SPA + static is Next.js's domain)
//
// Failure mode: when the bucket is empty, emit 429 with the canonical
// English message so the frontend's i18n key
// "Too many requests, please try again later" hits zh.js's translation.
func (s *apiLimiterStore) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Disabled limiter (burst=0) passes all requests through.
			if s.burst <= 0 {
				next.ServeHTTP(w, r)
				return
			}
			if !shouldLimitPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			ip := extractIP(r)
			if !ip.IsValid() {
				// Couldn't parse — fail open rather than 429 every
				// request.  Logged at the upstream RealIP middleware.
				next.ServeHTTP(w, r)
				return
			}
			lim := s.limiterFor(ip)
			if !lim.Allow() {
				httpx.Fail(w, httpx.NewError(
					http.StatusTooManyRequests,
					httpx.CodeTooManyRequests,
					"Too many requests, please try again later",
				))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// shouldLimitPath returns false for the two healthcheck paths and any
// non-/api/* route.  Kept as a free function so the test suite can
// assert the exact skip semantics without instantiating a limiter.
func shouldLimitPath(p string) bool {
	if p == "/health" || p == "/api/health" {
		return false
	}
	return strings.HasPrefix(p, "/api/")
}

// limiterFor returns the per-IP limiter, creating one on first sight.
// Last-seen is bumped every call so the sweeper keeps active IPs.
func (s *apiLimiterStore) limiterFor(ip netip.Addr) *rate.Limiter {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry, ok := s.limiters[ip]; ok {
		entry.lastSeen = time.Now()
		return entry.limiter
	}
	entry := &ipLimiter{
		limiter:  rate.NewLimiter(s.rateLimit, s.burst),
		lastSeen: time.Now(),
	}
	s.limiters[ip] = entry
	return entry.limiter
}

// sweep removes limiters whose last request was more than ipMaxIdle
// ago.  Bounds memory under attack — an attacker rotating through
// 1M source IPs would otherwise leak 1M *rate.Limiter (~100MB).
func (s *apiLimiterStore) sweep() {
	t := time.NewTicker(s.sweepInterval)
	defer t.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case now := <-t.C:
			cutoff := now.Add(-s.ipMaxIdle)
			s.mu.Lock()
			for ip, entry := range s.limiters {
				if entry.lastSeen.Before(cutoff) {
					delete(s.limiters, ip)
				}
			}
			s.mu.Unlock()
		}
	}
}

// Stop halts the sweeper goroutine.  Idempotent — sync.Once-guarded
// so defers in main.go can call without ordering anxiety.
func (s *apiLimiterStore) Stop() {
	s.stopOnce.Do(func() { close(s.stopCh) })
}

// extractIP pulls the request IP.  middleware.RealIP rewrites
// r.RemoteAddr to the X-Forwarded-For / X-Real-IP head before this
// middleware runs, so a simple netip.ParseAddrPort suffices.  Falls
// back to ParseAddr if RemoteAddr lacks a port (some test harnesses
// pass bare IPs).
func extractIP(r *http.Request) netip.Addr {
	if r.RemoteAddr == "" {
		return netip.Addr{}
	}
	// RemoteAddr can be "1.2.3.4:5678" OR a bare IPv6 in brackets.
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		// IPv6 with port has ']' before the colon; check.
		if !strings.HasPrefix(host, "[") || strings.Contains(host[:i], "]") {
			host = host[:i]
		}
	}
	host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return addr
}
