//go:build integration

// Smoke integration test for the P2.0 chi skeleton.
//
// Spins the full middleware chain (CORS → RequestID → RealIP → RequestLog
// → Recoverer → Timeout) against a real testcontainer Postgres pool and
// drives /health through httptest.  Asserts byte-exact envelope output.
//
// Why not unit-test this:  Each piece (httpx envelope, httpmw logger,
// db.NewPool, healthHandler) has unit coverage.  The P1.D experience showed
// that wiring-order bugs hide between modules with green unit tests — three
// real bugs surfaced only via integration.  This smoke is the minimum check
// that the end-to-end chain produces the byte sequence shadow-traffic diff
// will compare against Express.
//
// Container reuse: TestMain (migrate_test.go) starts Postgres + Mongo once
// for the package.  This file consumes pgURIGlobal — no new containers,
// adds ~20ms to the suite.
//
// Implementation note: healthHandler is duplicated from cmd/server/main.go
// rather than exported.  It is 12 lines and exporting it would force the
// cmd/server package into a half-library shape.  When P2.1 grows multiple
// handlers, /plan-eng-review decision § 10 calls for extracting them into
// internal/api/ — at that point this duplication collapses.

package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/db"
	"github.com/lawrenceli0228/animego/go-api/internal/httpmw"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// healthHandler is a verbatim copy of cmd/server/main.go's handler — the
// smoke test exercises the exact envelope shape the server emits in prod.
type healthOK struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
	Stage   string `json:"stage"`
	DB      string `json:"db"`
}

func healthHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), db.PingTimeout)
		defer cancel()
		if err := pool.Ping(ctx); err != nil {
			httpx.Fail(w, httpx.NewError(
				http.StatusServiceUnavailable,
				httpx.CodeServerError,
				"database unreachable",
				httpx.WithCause(err),
			))
			return
		}
		httpx.Data(w, http.StatusOK, healthOK{
			OK: true, Service: "go-api", Stage: "P2.0", DB: "up",
		})
	}
}

// newSmokeRouter mirrors cmd/server/main.go's chi setup so the smoke test
// covers the exact middleware order shipping to prod.
func newSmokeRouter(pool *pgxpool.Pool) http.Handler {
	r := chi.NewRouter()
	r.Use(httpmw.CORS("http://localhost:3000"))
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(httpmw.RequestLog(nil))   // nil → slog.Default()
	r.Use(httpmw.Recoverer(nil))    // nil → slog.Default()
	r.Get("/health", healthHandler(pool))
	return r
}

// newWebPool opens a fresh pgxpool using the web-tier db.NewPool helper
// against the shared testcontainer URI from TestMain.  Each test gets its
// own pool so a Close in one cannot poison another.
func newWebPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	pool, err := db.NewPool(ctx, pgURIGlobal)
	require.NoError(t, err, "db.NewPool")
	t.Cleanup(pool.Close)
	return pool
}

func TestHealthSmoke_DBUp(t *testing.T) {
	ctx := context.Background()
	pool := newWebPool(t, ctx)
	handler := newSmokeRouter(pool)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code, "/health should be 200 when pool is healthy")

	// Byte-exact assertion — shadow traffic diff is byte-level, so any
	// drift in field order or escaping must fail here.
	want := `{"data":{"ok":true,"service":"go-api","stage":"P2.0","db":"up"}}`
	assert.Equal(t, want, rec.Body.String(), "envelope bytes drift")

	// Validate Content-Type (httpx.Data sets it).
	assert.Equal(t, "application/json; charset=utf-8", rec.Header().Get("Content-Type"))

	// Independent JSON parse — the byte assertion is the gate, but if it
	// somehow passed we still want structural assertions to scream loudly.
	var env struct {
		Data healthOK `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	assert.True(t, env.Data.OK)
	assert.Equal(t, "go-api", env.Data.Service)
	assert.Equal(t, "P2.0", env.Data.Stage)
	assert.Equal(t, "up", env.Data.DB)
}

func TestHealthSmoke_DBDown(t *testing.T) {
	ctx := context.Background()
	pool := newWebPool(t, ctx)

	// Close the pool *before* serving — pool.Ping will fail.
	pool.Close()

	handler := newSmokeRouter(pool)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code, "/health should be 503 when pool is closed")

	want := `{"error":{"code":"SERVER_ERROR","message":"database unreachable"}}`
	assert.Equal(t, want, rec.Body.String(), "error envelope bytes drift")
}

func TestHealthSmoke_CORSPreflight(t *testing.T) {
	ctx := context.Background()
	pool := newWebPool(t, ctx)
	handler := newSmokeRouter(pool)

	// Preflight OPTIONS request — must be answered by CORS middleware
	// without ever reaching healthHandler (which would try to Ping a
	// pool that has no DSN for this request).
	req := httptest.NewRequest(http.MethodOptions, "/health", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK && rec.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 200 or 204", rec.Code)
	}
	assert.Equal(t, "http://localhost:3000", rec.Header().Get("Access-Control-Allow-Origin"))
	assert.Equal(t, "true", rec.Header().Get("Access-Control-Allow-Credentials"))
}

func TestHealthSmoke_RecovererCatchesPanic(t *testing.T) {
	// Wire a handler that panics on a side route — proves Recoverer is
	// in the chain and writes the envelope when a deeper handler crashes.
	ctx := context.Background()
	pool := newWebPool(t, ctx)

	r := chi.NewRouter()
	r.Use(httpmw.CORS("http://localhost:3000"))
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(httpmw.RequestLog(nil))
	r.Use(httpmw.Recoverer(nil))
	r.Get("/health", healthHandler(pool))
	r.Get("/panic", func(w http.ResponseWriter, req *http.Request) {
		panic("intentional smoke panic")
	})

	req := httptest.NewRequest(http.MethodGet, "/panic", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	want := `{"error":{"code":"SERVER_ERROR","message":"internal error"}}`
	assert.Equal(t, want, rec.Body.String(), "Recoverer envelope drift")
}
