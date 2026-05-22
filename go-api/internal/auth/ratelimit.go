package auth

// ratelimit.go — in-memory fixed-window rate limiter (10 req / 15 min
// per client IP).
//
// Express uses express-rate-limit with the same parameters
// (server/middleware/rateLimiter.js authLimiter).  We replicate the same
// window via a per-IP counter map with a goroutine-safe Allow + a
// periodic sweeper that GCs idle buckets.  Memory is bounded by the
// number of unique IPs observed within a single window — fine for our
// scale (one VPS, low six-figure unique IPs/day worst case).
//
// Wire scope: register / login / refresh.  Logout + /me are protected by
// jwtx.RequireAuth so they're not exposed to anonymous request floods.

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"
)

// Default rate-limit parameters.  Exported so route wiring can choose
// to instantiate the limiter with custom values in tests.
const (
	// DefaultRateLimitMax is the request budget per IP per window
	// (matches Express authLimiter max=10).
	DefaultRateLimitMax = 10

	// DefaultRateLimitWindow is the fixed window length per IP
	// (matches Express authLimiter windowMs=15min).
	DefaultRateLimitWindow = 15 * time.Minute

	// gcInterval is how often the sweeper goroutine runs to drop
	// stale buckets.  Long enough to be cheap, short enough that the
	// map doesn't grow unboundedly between sweeps.
	gcInterval = 5 * time.Minute
)

// Rate-limit envelope — pre-marshaled at init so the middleware's hot
// path doesn't allocate.  Bytes match the httpx.Fail output byte-for-byte
// (no HTML escaping, no trailing newline, key order
// error→{code,message}).
var rateLimitedBody = mustMarshalRateLimitEnvelope()

const (
	codeRateLimited = "RATE_LIMITED"
	msgRateLimited  = "请求过于频繁，请稍后再试"
)

func mustMarshalRateLimitEnvelope() []byte {
	type body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	type envelope struct {
		Error body `json:"error"`
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(envelope{Error: body{Code: codeRateLimited, Message: msgRateLimited}}); err != nil {
		// Compile-time-stable input — cannot fail in practice.
		panic(err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// RateLimiter is a fixed-window per-IP counter.  Thread-safe.  GC runs
// every gcInterval to drop buckets whose resetAt is in the past — bounds
// memory at the cost of one extra goroutine per limiter.
//
// Construct with NewRateLimiter; never zero-value (mu would still be
// usable but buckets nil and Allow would panic on map access).
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	max     int
	window  time.Duration

	// stopCh signals the GC goroutine to exit.  Closed by Stop.
	stopCh chan struct{}
	// stopOnce guards Stop so callers can defer rl.Stop() safely.
	stopOnce sync.Once
}

// bucket tracks one IP's request count + window expiry.
type bucket struct {
	count   int
	resetAt time.Time
}

// NewRateLimiter creates a limiter with the given budget + window and
// starts its GC goroutine.  Pass max=0 to disable rate limiting
// (Allow always returns true).
func NewRateLimiter(max int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		buckets: make(map[string]*bucket),
		max:     max,
		window:  window,
		stopCh:  make(chan struct{}),
	}
	go rl.gcLoop()
	return rl
}

// Stop tears down the GC goroutine.  Safe to call multiple times.
// Tests should call Stop in t.Cleanup so the goroutine exits promptly.
func (rl *RateLimiter) Stop() {
	rl.stopOnce.Do(func() { close(rl.stopCh) })
}

// gcLoop is the background sweeper.  Walks the bucket map every
// gcInterval and removes entries whose resetAt has already elapsed.
func (rl *RateLimiter) gcLoop() {
	ticker := time.NewTicker(gcInterval)
	defer ticker.Stop()
	for {
		select {
		case <-rl.stopCh:
			return
		case <-ticker.C:
			rl.gc()
		}
	}
}

// gc drops expired buckets.  Holds the lock for the full sweep so
// concurrent Allow calls block — sweeps are short (O(unique IPs)).
func (rl *RateLimiter) gc() {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	for ip, b := range rl.buckets {
		if now.After(b.resetAt) {
			delete(rl.buckets, ip)
		}
	}
}

// Allow records one request from ip and returns true if within budget,
// false if rate-limited.  Window resets per-IP when the bucket's resetAt
// is in the past — fixed window, not sliding.
//
// Empty ip ("") is treated as a valid key — callers should normalize
// before calling (Middleware does this via clientIP).
func (rl *RateLimiter) Allow(ip string) bool {
	if rl.max <= 0 {
		return true
	}
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[ip]
	if !ok || now.After(b.resetAt) {
		rl.buckets[ip] = &bucket{count: 1, resetAt: now.Add(rl.window)}
		return true
	}
	if b.count >= rl.max {
		return false
	}
	b.count++
	return true
}

// Middleware wraps a handler with the rate limiter.  Reads the client
// IP from X-Real-IP (if set by upstream proxy) or r.RemoteAddr.
// Returns 429 + the canonical RATE_LIMITED envelope on rate-limit.
//
// Usage:
//
//	r.With(limiter.Middleware()).Post("/api/auth/login", h.Login)
func (rl *RateLimiter) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			if !rl.Allow(ip) {
				writeRateLimited(w)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// clientIP extracts the request's client IP for rate limiting.  Trusts
// X-Real-IP if present (set by upstream nginx) and falls back to
// r.RemoteAddr with the port stripped.  Returns the raw string if
// stripping fails (e.g. unix socket) — better to over-limit than to
// blow up on malformed input.
func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// writeRateLimited emits the 429 envelope.  Content-Type matches
// internal/httpx exactly so the response is indistinguishable from a
// httpx.Fail call from the client's perspective.
func writeRateLimited(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusTooManyRequests)
	if _, err := w.Write(rateLimitedBody); err != nil {
		slog.Warn("auth: write 429 envelope", "err", err)
	}
}

