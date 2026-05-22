package auth

// ratelimit_test.go — basics for the fixed-window per-IP token bucket.
// Run with -race; the Allow + Middleware paths share the same lock so
// no data race should ever surface even under heavy parallelism.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRateLimiter_UnderBudget_Allows(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(10, 15*time.Minute)
	t.Cleanup(rl.Stop)

	for i := 0; i < 9; i++ {
		if !rl.Allow("1.2.3.4") {
			t.Fatalf("request %d denied; want allowed", i+1)
		}
	}
}

func TestRateLimiter_OverBudget_Denies(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(10, 15*time.Minute)
	t.Cleanup(rl.Stop)

	// Burn the budget.
	for i := 0; i < 10; i++ {
		if !rl.Allow("1.2.3.4") {
			t.Fatalf("request %d denied; want allowed", i+1)
		}
	}
	// 11th must be denied.
	if rl.Allow("1.2.3.4") {
		t.Fatal("11th request allowed; want denied")
	}
}

func TestRateLimiter_PerIP_Isolated(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(10, 15*time.Minute)
	t.Cleanup(rl.Stop)

	// IP A burns its budget.
	for i := 0; i < 10; i++ {
		rl.Allow("10.0.0.1")
	}
	if rl.Allow("10.0.0.1") {
		t.Fatal("IP A 11th request allowed; want denied")
	}
	// IP B is untouched.
	if !rl.Allow("10.0.0.2") {
		t.Fatal("IP B first request denied; want allowed")
	}
}

func TestRateLimiter_WindowExpiry(t *testing.T) {
	t.Parallel()

	// 50ms window so the test runs quickly.  We sleep 100ms past it
	// to make sure the bucket resets even on a slow CI runner.
	rl := NewRateLimiter(2, 50*time.Millisecond)
	t.Cleanup(rl.Stop)

	if !rl.Allow("9.9.9.9") {
		t.Fatal("first allow denied")
	}
	if !rl.Allow("9.9.9.9") {
		t.Fatal("second allow denied")
	}
	if rl.Allow("9.9.9.9") {
		t.Fatal("third allow within window allowed; want denied")
	}

	time.Sleep(100 * time.Millisecond)

	// Bucket reset — the next call must be allowed.
	if !rl.Allow("9.9.9.9") {
		t.Fatal("post-window allow denied; want allowed")
	}
}

func TestRateLimiter_Middleware_429Envelope(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(2, 15*time.Minute)
	t.Cleanup(rl.Stop)

	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"ok":true}}`))
	})
	h := rl.Middleware()(stub)

	makeReq := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		req.RemoteAddr = "5.6.7.8:1234"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	if rec := makeReq(); rec.Code != http.StatusOK {
		t.Fatalf("req 1 status = %d, want 200", rec.Code)
	}
	if rec := makeReq(); rec.Code != http.StatusOK {
		t.Fatalf("req 2 status = %d, want 200", rec.Code)
	}

	// 3rd req — over budget.
	rec := makeReq()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over-budget status = %d, want 429", rec.Code)
	}
	want := `{"error":{"code":"RATE_LIMITED","message":"请求过于频繁，请稍后再试"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestRateLimiter_XRealIP_Honored(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(1, 15*time.Minute)
	t.Cleanup(rl.Stop)

	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	h := rl.Middleware()(stub)

	// Same RemoteAddr but different X-Real-IP — should be treated as
	// distinct clients.
	r1 := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	r1.RemoteAddr = "127.0.0.1:54321"
	r1.Header.Set("X-Real-IP", "111.111.111.111")
	rec1 := httptest.NewRecorder()
	h.ServeHTTP(rec1, r1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("client A first req status = %d, want 200", rec1.Code)
	}

	r2 := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	r2.RemoteAddr = "127.0.0.1:54321"
	r2.Header.Set("X-Real-IP", "222.222.222.222")
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, r2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("client B first req status = %d, want 200 (X-Real-IP isolation broken)", rec2.Code)
	}

	// Client A's 2nd req — over budget for max=1.
	r3 := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	r3.RemoteAddr = "127.0.0.1:54321"
	r3.Header.Set("X-Real-IP", "111.111.111.111")
	rec3 := httptest.NewRecorder()
	h.ServeHTTP(rec3, r3)
	if rec3.Code != http.StatusTooManyRequests {
		t.Fatalf("client A 2nd req status = %d, want 429", rec3.Code)
	}
}

func TestRateLimiter_ConcurrentAllow_NoRace(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(1000, 15*time.Minute)
	t.Cleanup(rl.Stop)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Each goroutine hits a different IP so the limiter never
			// rejects — pure race-detector exercise on the bucket map.
			ip := "192.168.0." + string(rune('a'+i%26))
			for j := 0; j < 5; j++ {
				rl.Allow(ip)
			}
		}(i)
	}
	wg.Wait()
}

func TestRateLimiter_MaxZero_AlwaysAllows(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(0, 15*time.Minute)
	t.Cleanup(rl.Stop)

	// max=0 disables the limiter — every request passes.
	for i := 0; i < 100; i++ {
		if !rl.Allow("1.1.1.1") {
			t.Fatalf("req %d denied with max=0; want allowed", i+1)
		}
	}
}

func TestRateLimiter_GC_DropsExpiredBuckets(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(5, 30*time.Millisecond)
	t.Cleanup(rl.Stop)

	// Seed two buckets so we can verify the GC sweep removes them.
	rl.Allow("1.1.1.1")
	rl.Allow("2.2.2.2")

	rl.mu.Lock()
	if len(rl.buckets) != 2 {
		rl.mu.Unlock()
		t.Fatalf("pre-gc bucket count = %d, want 2", len(rl.buckets))
	}
	rl.mu.Unlock()

	// Sleep past the window so both buckets are stale.
	time.Sleep(60 * time.Millisecond)

	// Invoke gc directly — the production sweeper would do this on
	// the gcInterval ticker, but we don't want a 5-minute test.
	rl.gc()

	rl.mu.Lock()
	defer rl.mu.Unlock()
	if got := len(rl.buckets); got != 0 {
		t.Errorf("post-gc bucket count = %d, want 0", got)
	}
}

func TestRateLimiter_Stop_Idempotent(t *testing.T) {
	t.Parallel()

	rl := NewRateLimiter(10, 15*time.Minute)
	rl.Stop()
	// Second Stop must not panic (sync.Once).
	rl.Stop()
}

func TestRateLimiter_ClientIP_FallbackToRemoteAddr(t *testing.T) {
	t.Parallel()

	// Smoke test: no X-Real-IP, valid host:port — clientIP returns the
	// host portion only.  Verified indirectly: two requests from the
	// same host:port count as one IP.
	rl := NewRateLimiter(1, 15*time.Minute)
	t.Cleanup(rl.Stop)

	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	h := rl.Middleware()(stub)

	for i := 0; i < 1; i++ {
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		req.RemoteAddr = "203.0.113.7:9999"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("req %d status = %d, want 200", i, rec.Code)
		}
	}
	// 2nd req from same IP (different ephemeral port) should be denied.
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.RemoteAddr = "203.0.113.7:9998"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		body := rec.Body.String()
		// Helpful failure: show body so we know envelope shape.
		if !strings.Contains(body, "RATE_LIMITED") {
			t.Logf("body: %s", body)
		}
		t.Fatalf("status = %d, want 429 (IP host should be stripped from port)", rec.Code)
	}
}
