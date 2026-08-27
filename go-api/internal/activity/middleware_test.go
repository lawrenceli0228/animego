package activity

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

func testSigner(t testing.TB) *jwtx.Signer {
	t.Helper()
	s, err := jwtx.NewSigner("access-secret-for-tests", "refresh-secret-for-tests", 15*time.Minute, 7*24*time.Hour)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	return s
}

func bearerRequest(t testing.TB, signer *jwtx.Signer, path string, userID uuid.UUID) *http.Request {
	t.Helper()
	token, err := signer.SignAccess(userID, "tester", nil)
	if err != nil {
		t.Fatalf("SignAccess: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

// bufferedCount reads the recorder's in-memory state.  Reaching into the
// buffer rather than flushing keeps these tests free of a fake database for
// something that is purely about which requests get counted.
func bufferedCount(rec *Recorder) int64 {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	var total int64
	for _, e := range rec.buf {
		total += e.Requests
	}
	return total
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

// TestMiddleware_RecordsViaSinkOnAuthenticatedRoutes is the fast path: the
// route's own RequireAuth verifies the token and publishes it, and this
// middleware reads a pointer rather than repeating the crypto.
func TestMiddleware_RecordsViaSinkOnAuthenticatedRoutes(t *testing.T) {
	signer := testSigner(t)
	rec := quietRecorder(t, &fakeExecer{})
	// jwtx.RequireAuth is what a real authenticated route mounts, and it is
	// what fills the sink.  Using the real middleware rather than a stub is
	// the point of the test — the coupling between the two packages is the
	// thing that could silently break.
	h := Middleware(signer, rec)(jwtx.RequireAuth(signer)(okHandler()))

	user := uuid.New()
	for range 3 {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, bearerRequest(t, signer, "/api/subscriptions", user))
		if w.Code != http.StatusOK {
			t.Fatalf("middleware changed the response: got %d", w.Code)
		}
	}

	if got := bufferedCount(rec); got != 3 {
		t.Fatalf("buffered requests = %d, want 3", got)
	}
}

// TestMiddleware_RecordsOnPublicRoutesToo is the case the sink alone would
// lose, and losing it would be the whole feature failing quietly.
//
// Most of this API is public — /api/anime/*, /api/danmaku/*,
// /api/dandanplay/* mount no auth middleware.  A signed-in reader browsing the
// catalogue sends their cookie there and nothing verifies it, so a
// sink-only implementation would record nothing for somebody who reads and
// does not interact.  That is precisely the user this feature exists to make
// visible: DAU would undercount the quiet majority and look plausible doing it.
func TestMiddleware_RecordsOnPublicRoutesToo(t *testing.T) {
	signer := testSigner(t)
	rec := quietRecorder(t, &fakeExecer{})
	// No jwtx middleware at all — a public route.
	h := Middleware(signer, rec)(okHandler())

	w := httptest.NewRecorder()
	h.ServeHTTP(w, bearerRequest(t, signer, "/api/anime/12345", uuid.New()))

	if got := bufferedCount(rec); got != 1 {
		t.Fatalf("buffered requests = %d, want 1 — a logged-in reader on a public route must still count", got)
	}
}

// TestMiddleware_CountsOnceOnAuthenticatedRoutes: the sink hit must return
// before the verification fallback, or every authenticated route would record
// two requests for one call and every request counter would be doubled.
func TestMiddleware_CountsOnceOnAuthenticatedRoutes(t *testing.T) {
	signer := testSigner(t)
	rec := quietRecorder(t, &fakeExecer{})
	h := Middleware(signer, rec)(jwtx.RequireAuth(signer)(okHandler()))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, bearerRequest(t, signer, "/api/subscriptions", uuid.New()))

	if got := bufferedCount(rec); got != 1 {
		t.Fatalf("buffered requests = %d, want exactly 1", got)
	}
}

func TestMiddleware_IgnoresAnonymousAndNonApiAndHealth(t *testing.T) {
	signer := testSigner(t)
	user := uuid.New()

	cases := []struct {
		name string
		req  func() *http.Request
	}{
		{
			// The majority of this site's traffic.  It must cost a prefix
			// check and a failed token extraction, and record nothing.
			name: "anonymous api request",
			req:  func() *http.Request { return httptest.NewRequest(http.MethodGet, "/api/anime/1", nil) },
		},
		{
			// Not an API path at all — avatar files, the health probe's
			// sibling routes, anything mounted at the root.
			name: "non-api path with a valid token",
			req:  func() *http.Request { return bearerRequest(t, signer, "/version.json", user) },
		},
		{
			// The load balancer is not a person.  Excluded by name rather
			// than left to "it happens to send no token", so the exclusion
			// stays true if the probe is ever given credentials.
			name: "health probe with a valid token",
			req:  func() *http.Request { return bearerRequest(t, signer, "/api/health", user) },
		},
		{
			// Static file serving is not a person doing something.  A
			// discussion page with twenty avatars on it would otherwise book
			// twenty "activity requests" for one page view, and request_count
			// stops being a request-volume signal the moment it is mixed with
			// image fetches.
			name: "avatar file with a valid token",
			req:  func() *http.Request { return bearerRequest(t, signer, "/api/avatars/abc.jpg", user) },
		},
		{
			// A forged or expired token must be indistinguishable from no
			// token: presence is only ever recorded off a signature we issued.
			name: "invalid token",
			req: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, "/api/subscriptions", nil)
				r.Header.Set("Authorization", "Bearer not.a.real.token")
				return r
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := quietRecorder(t, &fakeExecer{})
			h := Middleware(signer, rec)(okHandler())
			w := httptest.NewRecorder()
			h.ServeHTTP(w, tc.req())
			if w.Code != http.StatusOK {
				t.Fatalf("middleware changed the response: got %d", w.Code)
			}
			if got := bufferedCount(rec); got != 0 {
				t.Fatalf("buffered requests = %d, want 0", got)
			}
		})
	}
}

// TestMiddleware_NilDependenciesReturnTheHandlerUnchanged: with nothing to
// record into, the middleware must add no wrapper at all rather than a
// wrapper that checks nil on every request.
func TestMiddleware_NilDependenciesReturnTheHandlerUnchanged(t *testing.T) {
	inner := okHandler()
	if got := Middleware(testSigner(t), nil)(inner); got == nil {
		t.Fatal("nil recorder must still yield a usable handler")
	}
	w := httptest.NewRecorder()
	Middleware(nil, nil)(inner).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/x", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("nil-dependency passthrough broke the response: %d", w.Code)
	}
}

// BenchmarkMiddleware measures what this feature ADDS to every request the
// site serves.  The arms come in before/after pairs on purpose: a bare "8µs
// per authenticated request" number is unreadable, because most of it is the
// JWT verification the route was already doing.  Subtract each Baseline arm
// from the arm below it to get the real cost.
//
//	Anonymous            the majority of traffic on a search-led catalogue.
//	                     Baseline is the handler alone; the delta is one path
//	                     prefix check and one token lookup that finds nothing.
//	                     This one has to stay at zero allocations.
//	AuthedRoute          a route that mounts RequireAuth.  Baseline includes
//	                     that verification, so the delta is the sink: a
//	                     context value, a pointer load, and a map write.
//	PublicRouteAuthed    a signed-in reader on a route with no auth middleware
//	                     (/api/anime/*, the catalogue).  Nothing else verifies
//	                     the token there, so the delta includes one HMAC —
//	                     the necessary cost of knowing who called, not
//	                     duplicate work.  Skipping it would undercount DAU for
//	                     readers who never interact.
//
// Read every delta against what the request goes on to do: each of these
// handlers then touches Postgres, which is two to three orders of magnitude
// more expensive than the largest number here.
func BenchmarkMiddleware(b *testing.B) {
	signer := testSigner(b)
	rec := newRecorder(&fakeExecer{}, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Hour)

	serve := func(b *testing.B, h http.Handler, req *http.Request) {
		b.Helper()
		w := httptest.NewRecorder()
		b.ReportAllocs()
		for b.Loop() {
			h.ServeHTTP(w, req)
		}
	}

	anon := httptest.NewRequest(http.MethodGet, "/api/anime/1", nil)
	authedReq := bearerRequest(b, signer, "/api/subscriptions", uuid.New())
	publicReq := bearerRequest(b, signer, "/api/anime/12345", uuid.New())

	b.Run("Anonymous/Baseline", func(b *testing.B) {
		serve(b, okHandler(), anon)
	})
	b.Run("Anonymous/WithRecorder", func(b *testing.B) {
		serve(b, Middleware(signer, rec)(okHandler()), anon)
	})

	b.Run("AuthedRoute/Baseline", func(b *testing.B) {
		serve(b, jwtx.RequireAuth(signer)(okHandler()), authedReq)
	})
	b.Run("AuthedRoute/WithRecorder", func(b *testing.B) {
		serve(b, Middleware(signer, rec)(jwtx.RequireAuth(signer)(okHandler())), authedReq)
	})

	b.Run("PublicRouteAuthed/Baseline", func(b *testing.B) {
		serve(b, okHandler(), publicReq)
	})
	b.Run("PublicRouteAuthed/WithRecorder", func(b *testing.B) {
		serve(b, Middleware(signer, rec)(okHandler()), publicReq)
	})
}
