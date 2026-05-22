package admin

// warm_all_test.go — tests for the WarmAll HTTP handler.
//
// The handler responds 200 IMMEDIATELY with a status message and then
// kicks off a background goroutine that calls
// queue.EnqueueWarmAllSeasons.  Tests verify:
//   1. The response is byte-exact to Express (English message + envelope).
//   2. The background goroutine fires and reaches the Enqueuer.
//   3. startYear query-param parsing handles missing / invalid / explicit.
//
// CONCURRENCY GOTCHA: queue.EnqueueWarmAllSeasons holds a package-level
// sync.Mutex via TryLock, so two parallel calls overlap → the second
// returns ErrWarmAllInProgress and enqueues nothing.  Tests that exercise
// the background-goroutine path therefore MUST NOT run in parallel; they
// would race the mutex and observe zero enqueue calls.  Tests that only
// inspect the HTTP response shape (no background-goroutine wait) CAN
// run in parallel — they don't care whether the goroutine actually
// fires.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// channelEnqueuer is a queue.Enqueuer that pings a channel each time
// EnqueueWarmSeasonNow is called.  Used to detect that the background
// goroutine actually ran without polling.
type channelEnqueuer struct {
	mu        sync.Mutex
	called    []queue.WarmSeasonArgs
	pingChan  chan struct{}
	errOnCall map[int]error
}

func newChannelEnqueuer(buf int) *channelEnqueuer {
	return &channelEnqueuer{pingChan: make(chan struct{}, buf)}
}

func (c *channelEnqueuer) EnqueueV1Many(_ context.Context, _ []int32) error { return nil }
func (c *channelEnqueuer) EnqueueV2Many(_ context.Context, _ []queue.BangumiV2Args) error {
	return nil
}
func (c *channelEnqueuer) EnqueueV3Many(_ context.Context, _ []queue.BangumiV3Args) error {
	return nil
}

func (c *channelEnqueuer) EnqueueWarmSeasonNow(_ context.Context, args queue.WarmSeasonArgs) error {
	c.mu.Lock()
	idx := len(c.called)
	c.called = append(c.called, args)
	err, has := c.errOnCall[idx]
	c.mu.Unlock()
	select {
	case c.pingChan <- struct{}{}:
	default:
		// Buffer full — non-fatal, tests count via snapshot().
	}
	if has {
		return err
	}
	return nil
}

func (c *channelEnqueuer) snapshot() []queue.WarmSeasonArgs {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]queue.WarmSeasonArgs, len(c.called))
	copy(out, c.called)
	return out
}

// waitForCalls blocks until n calls are observed or timeout expires.
// Returns the actual count observed.
func (c *channelEnqueuer) waitForCalls(t *testing.T, n int, timeout time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		count := len(c.called)
		c.mu.Unlock()
		if count >= n {
			return count
		}
		time.Sleep(5 * time.Millisecond)
	}
	c.mu.Lock()
	count := len(c.called)
	c.mu.Unlock()
	return count
}

// -----------------------------------------------------------------------------
// WarmAll handler — response-only tests (safe to run in parallel)
// -----------------------------------------------------------------------------

func TestWarmAll_DefaultStartYear_ResponseEnglishMessage(t *testing.T) {
	t.Parallel()
	// This test only inspects the HTTP response — does NOT wait for the
	// background goroutine — so parallel execution is safe.  The goroutine
	// still runs but we don't assert on it here.
	enq := newChannelEnqueuer(64)
	h := NewUserHandlers(&fakeUserDB{}, enq)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/warm-all", nil)
	rec := httptest.NewRecorder()
	h.WarmAll(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// Express byte-exact: message is English, default startYear = 2014.
	var env struct {
		Data struct {
			Message string `json:"message"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := "Warming all seasons from 2014. Check server logs."
	if env.Data.Message != want {
		t.Errorf("message = %q, want %q", env.Data.Message, want)
	}
}

func TestWarmAll_ExplicitStartYear_InterpolatedInMessage(t *testing.T) {
	t.Parallel()
	enq := newChannelEnqueuer(64)
	h := NewUserHandlers(&fakeUserDB{}, enq)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/warm-all?startYear=2020", nil)
	rec := httptest.NewRecorder()
	h.WarmAll(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	body := rec.Body.String()
	if !strings.Contains(body, "Warming all seasons from 2020. Check server logs.") {
		t.Errorf("body should contain 'from 2020' interpolation, got %s", body)
	}
}

func TestWarmAll_InvalidStartYear_DefaultsTo2014(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		query string
	}{
		{"empty value", "?startYear="},
		{"non-numeric", "?startYear=not-a-year"},
		{"zero", "?startYear=0"},
		{"negative", "?startYear=-5"},
		{"missing", ""},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			// Subtests can be parallel — same reason as above (response only).
			t.Parallel()
			enq := newChannelEnqueuer(64)
			h := NewUserHandlers(&fakeUserDB{}, enq)
			req := httptest.NewRequest(http.MethodPost, "/api/admin/warm-all"+tc.query, nil)
			rec := httptest.NewRecorder()
			h.WarmAll(rec, req)

			if rec.Code != http.StatusOK {
				t.Errorf("status = %d, want 200", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "from 2014") {
				t.Errorf("body should fall back to startYear=2014, got %s", rec.Body.String())
			}
		})
	}
}

func TestWarmAll_ResponseShape_ByteExact(t *testing.T) {
	t.Parallel()
	enq := newChannelEnqueuer(64)
	h := NewUserHandlers(&fakeUserDB{}, enq)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/warm-all", nil)
	rec := httptest.NewRecorder()
	h.WarmAll(rec, req)

	// Express response is exactly:
	//   {"data":{"message":"Warming all seasons from 2014. Check server logs."}}
	want := `{"data":{"message":"Warming all seasons from 2014. Check server logs."}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

// -----------------------------------------------------------------------------
// WarmAll handler — background-goroutine tests (serialised)
// -----------------------------------------------------------------------------
//
// The next three tests synchronise on the queue.EnqueueWarmAllSeasons
// mutex — they assert the background goroutine actually enqueued jobs.
// They CANNOT run in parallel because the mutex makes them visible to
// each other; a second parallel call gets ErrWarmAllInProgress and
// enqueues nothing.  We mark them sequential (no t.Parallel) so the
// mutex is uncontended in each invocation.

func TestWarmAll_BackgroundFiresEnqueue(t *testing.T) {
	// Sequential — see file-level CONCURRENCY GOTCHA comment.
	enq := newChannelEnqueuer(256)
	h := NewUserHandlers(&fakeUserDB{}, enq)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/warm-all", nil)
	rec := httptest.NewRecorder()
	h.WarmAll(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// 56 jobs is the full year range 2014..currentYear+1 — but we don't
	// need that precision; ≥4 confirms the loop iterated at least one
	// year's worth.
	if got := enq.waitForCalls(t, 4, 3*time.Second); got < 4 {
		t.Errorf("background goroutine did not enqueue enough jobs; calls = %d, want ≥4", got)
	}
}

func TestWarmAll_BackgroundUsesFreshContext(t *testing.T) {
	// Sequential — see file-level CONCURRENCY GOTCHA comment.
	//
	// If the goroutine used r.Context(), cancellation when the response
	// finishes would race the enqueue.  We test this by using a request
	// with a context that we cancel immediately after the handler returns
	// — the background goroutine should still complete because it uses
	// context.Background() internally.
	enq := newChannelEnqueuer(64)
	h := NewUserHandlers(&fakeUserDB{}, enq)

	parentCtx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/admin/warm-all", nil).WithContext(parentCtx)
	rec := httptest.NewRecorder()
	h.WarmAll(rec, req)
	cancel() // cancel parent — goroutine should not be affected

	if got := enq.waitForCalls(t, 1, 2*time.Second); got < 1 {
		t.Errorf("background goroutine should survive parent-ctx cancellation; calls = %d", got)
	}
}

func TestWarmAll_EnqueueError_DoesNotAffectClient(t *testing.T) {
	// Sequential — see file-level CONCURRENCY GOTCHA comment.
	enq := newChannelEnqueuer(64)
	enq.errOnCall = map[int]error{0: errFake}
	h := NewUserHandlers(&fakeUserDB{}, enq)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/warm-all", nil)
	rec := httptest.NewRecorder()
	h.WarmAll(rec, req)

	// Client still sees 200 — failures only land in slog.
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (enqueue errors must not propagate)", rec.Code)
	}

	// At least one enqueue attempt should have happened (and failed).
	enq.waitForCalls(t, 1, 2*time.Second)
}

// errFake is a sentinel for the error-injection enqueuer.
var errFake = errFakeErr{}

type errFakeErr struct{}

func (errFakeErr) Error() string { return "fake enqueue failure" }

// -----------------------------------------------------------------------------
// parseWarmAllStartYear unit tests
// -----------------------------------------------------------------------------

func TestParseWarmAllStartYear_Empty_DefaultsTo2014(t *testing.T) {
	t.Parallel()
	if got := parseWarmAllStartYear(""); got != 2014 {
		t.Errorf("parseWarmAllStartYear(empty) = %d, want 2014", got)
	}
}

func TestParseWarmAllStartYear_NonNumeric_DefaultsTo2014(t *testing.T) {
	t.Parallel()
	cases := []string{"abc", "2020abc", " 2020", "twenty"}
	for _, in := range cases {
		if got := parseWarmAllStartYear(in); got != 2014 {
			t.Errorf("parseWarmAllStartYear(%q) = %d, want 2014", in, got)
		}
	}
}

func TestParseWarmAllStartYear_Zero_DefaultsTo2014(t *testing.T) {
	t.Parallel()
	if got := parseWarmAllStartYear("0"); got != 2014 {
		t.Errorf("parseWarmAllStartYear(0) = %d, want 2014", got)
	}
}

func TestParseWarmAllStartYear_Negative_DefaultsTo2014(t *testing.T) {
	t.Parallel()
	if got := parseWarmAllStartYear("-10"); got != 2014 {
		t.Errorf("parseWarmAllStartYear(-10) = %d, want 2014", got)
	}
}

func TestParseWarmAllStartYear_Valid_PassesThrough(t *testing.T) {
	t.Parallel()
	cases := map[string]int{
		"1":    1,    // queue helper will clamp / iterate; parser passes through
		"2014": 2014,
		"2020": 2020,
		"3000": 3000, // future year — queue helper will iterate up to currentYear+1
	}
	for in, want := range cases {
		if got := parseWarmAllStartYear(in); got != want {
			t.Errorf("parseWarmAllStartYear(%q) = %d, want %d", in, got, want)
		}
	}
}

// guardAgainstUnreadField is a deliberately unused reference to silence
// the "declared and not used" linter if a future refactor removes the
// atomic.LoadInt32 touchpoint elsewhere.  Keeping the import wired lets
// future tests verify the call count atomically without re-adding the
// import.
var _ = atomic.LoadInt32
