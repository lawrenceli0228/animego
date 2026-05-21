// Package main is the chi HTTP server entry point for go-api.
//
// P2.0.D scope: middleware chain is now full envelope-aware + /health-
// skipping + CORS-fronted.  Chain order (locked by /plan-eng-review):
//
//	CORS  → RequestID  → RealIP  → RequestLog  → Recoverer  → Timeout
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lawrenceli0228/animego/go-api/internal/anime"
	"github.com/lawrenceli0228/animego/go-api/internal/config"
	"github.com/lawrenceli0228/animego/go-api/internal/db"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpmw"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/torrents"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(1)
	}

	connectCtx, cancelConnect := context.WithTimeout(context.Background(), db.ConnectTimeout)
	pool, err := db.NewPool(connectCtx, cfg.DatabaseURL)
	cancelConnect()
	if err != nil {
		slog.Error("postgres pool init failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	slog.Info("postgres pool ready", "max_conns", db.MaxConns)

	q := dbgen.New(pool)

	// Torrents aggregator: 3-source BT magnet fan-out (animes.garden +
	// acg.rip + nyaa.si) with a per-query 1h cache + partial-failure
	// tolerance.  Constructed once at boot and reused across requests —
	// the underlying *http.Client + *cache.Cache are goroutine-safe.
	torrentsAgg, err := torrents.New(torrents.WithLogger(slog.Default()))
	if err != nil {
		slog.Error("torrents aggregator init failed", "err", err)
		os.Exit(1)
	}
	defer torrentsAgg.Close()

	r := chi.NewRouter()
	r.Use(httpmw.CORS(cfg.ClientOrigin))
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(httpmw.RequestLog(slog.Default()))
	r.Use(httpmw.Recoverer(slog.Default()))
	r.Use(middleware.Timeout(60 * time.Second))

	// Health endpoint pings the DB pool.  Docker healthcheck only
	// requires HTTP 200; RequestLog skips this path to avoid drowning
	// real traffic in 2880 probe lines per pod per day.
	r.Get("/health", healthHandler(pool))

	r.Route("/api/anime", func(r chi.Router) {
		r.Get("/completed-gems", anime.CompletedGems(q))
		r.Get("/seasonal", anime.Seasonal(q))
		r.Get("/yearly-top", anime.YearlyTop(q))
		r.Get("/trending", anime.Trending(q))
		r.Get("/torrents", anime.Torrents(torrentsAgg))
		r.Get("/{anilistId}/watchers", anime.Watchers(q))
	})

	addr := fmt.Sprintf(":%d", cfg.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		slog.Info("go-api starting", "addr", addr, "stage", "P2.1.3")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	slog.Info("shutdown signal received")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}
	slog.Info("server stopped")
}

// healthHandler reports liveness + DB reachability via the httpx envelope.
//
// 200 →  {"data":{"ok":true,"service":"go-api","stage":"P2.1","db":"up"}}
// 503 →  {"error":{"code":"SERVER_ERROR","message":"database unreachable"}}
//
// Field order matches Express: ok, service, stage, db.  Use a struct (not
// map[string]any, which marshals alphabetically) so the byte output matches
// what shadow traffic diff expects.
func healthHandler(pool *pgxpool.Pool) http.HandlerFunc {
	type healthOK struct {
		OK      bool   `json:"ok"`
		Service string `json:"service"`
		Stage   string `json:"stage"`
		DB      string `json:"db"`
	}

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
			OK: true, Service: "go-api", Stage: "P2.1", DB: "up",
		})
	}
}
