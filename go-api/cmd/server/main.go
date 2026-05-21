// Package main is the chi HTTP server entry point for go-api.
//
// P2.0.C scope: handler uses httpx.Data / httpx.Fail for envelope output.
// Middleware chain is still chi-default — P2.0.D swaps in the envelope-aware
// Recoverer, CORS, and /health-skipping RequestLog.
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

	"github.com/lawrenceli0228/animego/go-api/internal/config"
	"github.com/lawrenceli0228/animego/go-api/internal/db"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
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

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	// Health endpoint pings the DB pool.  dev.sh and docker healthcheck
	// only require HTTP 200; humans inspecting the body get the envelope.
	r.Get("/health", healthHandler(pool))

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
		slog.Info("go-api starting", "addr", addr, "stage", "P2.0.A")
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
// 200 →  {"data":{"ok":true,"service":"go-api","stage":"P2.0","db":"up"}}
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
			OK: true, Service: "go-api", Stage: "P2.0", DB: "up",
		})
	}
}
