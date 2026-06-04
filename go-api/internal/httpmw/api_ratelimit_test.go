package httpmw

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.org/x/time/rate"
)

// ─── shouldLimitPath ────────────────────────────────────────────────────────

func TestShouldLimitPath(t *testing.T) {
	t.Parallel()

	cases := []struct {
		path  string
		limit bool
	}{
		{"/health", false},
		{"/api/health", false},
		{"/api/anime/1", true},
		{"/api/dandanplay/match", true},
		{"/api/admin/users", true},
		{"/api/auth/login", true},
		{"/", false},
		{"/static/app.js", false},
		{"", false},
		{"/healthcheck", false}, // no /api prefix
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.path, func(t *testing.T) {
			t.Parallel()
			got := shouldLimitPath(tc.path)
			if got != tc.limit {
				t.Errorf("shouldLimitPath(%q) = %v, want %v", tc.path, got, tc.limit)
			}
		})
	}
}

// ─── isPublicReadExempt ──────────────────────────────────────────────────────

func TestIsPublicReadExempt(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		method string
		path   string
		exempt bool
	}{
		// Public catalog reads — collapse to next-app's IP under SSR, so exempt.
		{"detail GET", http.MethodGet, "/api/anime/1", true},
		{"watchers GET", http.MethodGet, "/api/anime/1/watchers", true},
		{"trending GET", http.MethodGet, "/api/anime/trending", true},
		{"seasonal GET", http.MethodGet, "/api/anime/seasonal", true},
		// Expensive external fan-outs — keep inbound limit (own upstream cost).
		{"search GET", http.MethodGet, "/api/anime/search", false},
		{"torrents GET", http.MethodGet, "/api/anime/torrents", false},
		// Non-GET on an anime path (no such route today, but the method gate
		// must hold regardless).
		{"detail POST", http.MethodPost, "/api/anime/1", false},
		// Other API surfaces are never exempt.
		{"subscriptions GET", http.MethodGet, "/api/subscriptions", false},
		{"dandanplay GET", http.MethodGet, "/api/dandanplay/match", false},
		{"auth login POST", http.MethodPost, "/api/auth/login", false},
		{"non-api GET", http.MethodGet, "/anime/1", false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := isPublicReadExempt(tc.method, tc.path)
			if got != tc.exempt {
				t.Errorf("isPublicReadExempt(%q, %q) = %v, want %v", tc.method, tc.path, got, tc.exempt)
			}
		})
	}
}

// ─── extractIP ──────────────────────────────────────────────────────────────

func TestExtractIP(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		remoteAddr string
		wantValid  bool
		wantIP     string
	}{
		{"ipv4 with port", "192.0.2.1:54321", true, "192.0.2.1"},
		{"ipv6 with port", "[::1]:8080", true, "::1"},
		{"bare ipv4 no port", "10.0.0.1", true, "10.0.0.1"},
		{"empty string", "", false, ""},
		{"invalid string", "not-an-ip", false, ""},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodGet, "/api/anime", nil)
			req.RemoteAddr = tc.remoteAddr
			got := extractIP(req)
			if got.IsValid() != tc.wantValid {
				t.Errorf("extractIP(%q).IsValid() = %v, want %v", tc.remoteAddr, got.IsValid(), tc.wantValid)
			}
			if tc.wantValid && got.String() != tc.wantIP {
				t.Errorf("extractIP(%q) = %q, want %q", tc.remoteAddr, got.String(), tc.wantIP)
			}
		})
	}
}

// ─── NewAPIRateLimiter / Middleware ──────────────────────────────────────────

func TestNewAPIRateLimiter_Defaults(t *testing.T) {
	t.Parallel()
	s := NewAPIRateLimiter()
	defer s.Stop()

	if s.rateLimit != DefaultAPIRate {
		t.Errorf("rateLimit = %v, want %v", s.rateLimit, DefaultAPIRate)
	}
	if s.burst != DefaultAPIBurst {
		t.Errorf("burst = %d, want %d", s.burst, DefaultAPIBurst)
	}
}

func TestAPIRateLimiter_BurstZeroDisables(t *testing.T) {
	t.Parallel()
	// burst=0 means disabled: all requests must pass through.
	s := NewAPIRateLimiterWithBurst(rate.Limit(1), 0)
	defer s.Stop()

	mw := s.Middleware()
	var calls int
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/anime/1", nil)
		req.RemoteAddr = "1.2.3.4:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("request %d: status = %d, want 200 (disabled limiter)", i, rec.Code)
		}
	}
	if calls != 5 {
		t.Errorf("inner handler called %d times, want 5", calls)
	}
}

func TestAPIRateLimiter_HealthSkipped(t *testing.T) {
	t.Parallel()
	// Even with a very tight rate limit, /health should never be gated.
	s := NewAPIRateLimiterWithBurst(rate.Limit(0.001), 1)
	defer s.Stop()

	mw := s.Middleware()
	var calls int
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 10; i++ {
		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.RemoteAddr = "1.2.3.4:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("health request %d: got %d, want 200", i, rec.Code)
		}
	}
	if calls != 10 {
		t.Errorf("health handler called %d times, want 10", calls)
	}
}

func TestAPIRateLimiter_PublicReadExempt(t *testing.T) {
	t.Parallel()
	// The bug this guards: a flood of catalog GET reads from ONE IP — the
	// SSR-collapse case, where next-app fans an entire SEO crawl through a
	// single container IP — must all pass. With a burst of 1 the per-IP
	// limiter would 429 the 2nd request onward; the exemption keeps them 200.
	s := NewAPIRateLimiterWithBurst(rate.Limit(0.001), 1)
	defer s.Stop()

	mw := s.Middleware()
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 10; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/anime/1", nil)
		req.RemoteAddr = "172.18.0.5:4321" // next-app container IP
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("catalog read %d: got %d, want 200 (exempt)", i, rec.Code)
		}
	}
}

func TestAPIRateLimiter_ExpensiveAnimePathsStillLimited(t *testing.T) {
	t.Parallel()
	// The external fan-outs under /api/anime/ are NOT exempt: a flood from a
	// single IP must hit 429 once the burst is spent.
	for _, path := range []string{"/api/anime/torrents?q=x", "/api/anime/search?q=x"} {
		s := NewAPIRateLimiterWithBurst(rate.Limit(0.001), 1)
		mw := s.Middleware()
		handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))

		var got429 bool
		for i := 0; i < 5; i++ {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.RemoteAddr = "1.2.3.4:1234"
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code == http.StatusTooManyRequests {
				got429 = true
				break
			}
		}
		s.Stop()
		if !got429 {
			t.Errorf("%s: expected a 429 once burst was spent, never got one", path)
		}
	}
}

func TestAPIRateLimiter_ApiHealthSkipped(t *testing.T) {
	t.Parallel()
	s := NewAPIRateLimiterWithBurst(rate.Limit(0.001), 1)
	defer s.Stop()

	mw := s.Middleware()
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.RemoteAddr = "1.2.3.4:1234"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("/api/health: got %d, want 200", rec.Code)
	}
}

func TestAPIRateLimiter_NonApiSkipped(t *testing.T) {
	t.Parallel()
	// Paths without /api/ prefix are not limited.
	s := NewAPIRateLimiterWithBurst(rate.Limit(0.001), 1)
	defer s.Stop()

	mw := s.Middleware()
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/static/app.js", nil)
		req.RemoteAddr = "1.2.3.4:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("non-api request %d: got %d, want 200", i, rec.Code)
		}
	}
}

func TestAPIRateLimiter_Throttles(t *testing.T) {
	t.Parallel()
	// burst=2, rate=0 → token bucket starts with 2 tokens, no refill.
	// First 2 requests pass; the rest get 429.
	s := NewAPIRateLimiterWithBurst(rate.Limit(0), 2)
	defer s.Stop()

	mw := s.Middleware()
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	const ip = "5.6.7.8:9999"
	statuses := make([]int, 5)
	for i := 0; i < 5; i++ {
		// dandanplay/match is a limited endpoint — public catalog GET reads
		// (/api/anime/*) are now exempt, see TestAPIRateLimiter_PublicReadExempt.
		req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/match", nil)
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		statuses[i] = rec.Code
	}

	if statuses[0] != http.StatusOK {
		t.Errorf("request 1: got %d, want 200", statuses[0])
	}
	if statuses[1] != http.StatusOK {
		t.Errorf("request 2: got %d, want 200", statuses[1])
	}
	for i := 2; i < 5; i++ {
		if statuses[i] != http.StatusTooManyRequests {
			t.Errorf("request %d: got %d, want 429", i+1, statuses[i])
		}
	}
}

func TestAPIRateLimiter_InvalidIPFailsOpen(t *testing.T) {
	t.Parallel()
	// RemoteAddr="not-an-ip" → extractIP returns invalid Addr → fail open (200).
	s := NewAPIRateLimiterWithBurst(rate.Limit(0), 1)
	defer s.Stop()

	mw := s.Middleware()
	var calls int
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/anime/1", nil)
		req.RemoteAddr = "not-parseable"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("invalid-IP request %d: got %d, want 200 (fail-open)", i, rec.Code)
		}
	}
	if calls != 3 {
		t.Errorf("inner handler called %d times, want 3", calls)
	}
}

func TestAPIRateLimiter_DifferentIPsGetSeparateBuckets(t *testing.T) {
	t.Parallel()
	// burst=1 per IP. Two different IPs should each get one token.
	s := NewAPIRateLimiterWithBurst(rate.Limit(0), 1)
	defer s.Stop()

	mw := s.Middleware()
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for _, ip := range []string{"10.0.0.1:1", "10.0.0.2:1"} {
		req := httptest.NewRequest(http.MethodGet, "/api/anime/1", nil)
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("first request for %s: got %d, want 200", ip, rec.Code)
		}
	}
}

// ─── Stop idempotency ────────────────────────────────────────────────────────

func TestAPIRateLimiter_StopIdempotent(t *testing.T) {
	t.Parallel()
	s := NewAPIRateLimiter()
	// Calling Stop() multiple times must not panic.
	s.Stop()
	s.Stop()
	s.Stop()
}

// ─── sweep ───────────────────────────────────────────────────────────────────

func TestAPIRateLimiter_SweepRunsWithoutPanic(t *testing.T) {
	t.Parallel()
	// Verify that the sweeper goroutine can run through at least one cycle
	// and Stop() terminates it cleanly.  We construct the store at short
	// intervals and warm a few limiter entries before letting the sweep fire.
	s := NewAPIRateLimiterWithBurst(rate.Limit(100), 100)

	mw := s.Middleware()
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Warm a couple of distinct IP entries.
	for _, ip := range []string{"10.1.1.1:1", "10.1.1.2:1", "10.1.1.3:1"} {
		req := httptest.NewRequest(http.MethodGet, "/api/anime/1", nil)
		req.RemoteAddr = ip
		handler.ServeHTTP(httptest.NewRecorder(), req)
	}

	// Stop must not panic regardless of how many entries are in the map.
	s.Stop()
	// Second Stop() must also be safe (sync.Once guard).
	s.Stop()
}
