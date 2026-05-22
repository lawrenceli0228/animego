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
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/admin"
	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/anime"
	"github.com/lawrenceli0228/animego/go-api/internal/auth"
	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	"github.com/lawrenceli0228/animego/go-api/internal/config"
	"github.com/lawrenceli0228/animego/go-api/internal/db"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/email"
	"github.com/lawrenceli0228/animego/go-api/internal/httpmw"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
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

	// AniList GraphQL client — single instance shared by /search +
	// /schedule (and later /:anilistId).  Internal rate limiter is one
	// token per 700ms, burst=1, so concurrent callers serialise on a
	// single sliding window matching Express MIN_INTERVAL.
	anilistClient := anilist.NewClient()

	// Bangumi API client — single instance, 800ms throttle, shared by
	// the V1 enrichment worker (and V2/V3 in P2.1.6 / P2.1.7).
	bangumiClient := bangumi.NewClient()

	// Enqueuer must exist BEFORE workers are built (V1 worker captures
	// it to chain V2 jobs) but its underlying river client is the
	// OUTPUT of Boot below.  LateBoundEnqueuer breaks the cycle: it
	// no-ops until Bind is called, then forwards to a RealEnqueuer.
	enqueuer := &queue.LateBoundEnqueuer{}

	// River queue boot: real V1+V2+V3 (Bangumi enrichment trilogy) +
	// real WarmSeason worker.  WorkersWithBangumiAndNormalizer takes
	// the AniList client (for warm_season's Seasonal calls) + an
	// injected normalizer (anime.NormalizeMainRow — avoids the
	// queue→anime import cycle).  Boot returns the client unstarted.
	riverClient, err := queue.Boot(pool, queue.Config{
		Workers: queue.WorkersWithBangumiAndNormalizer(
			bangumiClient,
			anilistClient,
			q,
			enqueuer,
			anime.NormalizeMainRow,
		),
		// Queues: default for V1+V2+warm_season, bangumi_v3 for V3 only.
		// The dedicated V3 queue is what makes the admin /heal-cn/pause
		// endpoint isolate the heal-CN workload — pausing the default
		// queue would also freeze enrichment and seasonal warming.
		// MaxWorkers=1 on both queues matches the conservative serial
		// throttle the V1/V2/V3 workers use to respect Bangumi's
		// 800ms-per-request budget (only one worker per queue).
		Queues: map[string]river.QueueConfig{
			river.QueueDefault:         {MaxWorkers: 1},
			queue.BangumiV3QueueName:   {MaxWorkers: 1},
		},
		PeriodicJobs: []*river.PeriodicJob{queue.PeriodicWarmSeasonJob()},
		Logger:       slog.Default(),
	})
	if err != nil {
		slog.Error("river queue boot failed", "err", err)
		os.Exit(1)
	}
	enqueuer.Bind(riverClient)
	queueCtx, queueCancel := context.WithCancel(context.Background())
	defer queueCancel()
	if err := riverClient.Start(queueCtx); err != nil {
		slog.Error("river queue start failed", "err", err)
		os.Exit(1)
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := riverClient.Stop(stopCtx); err != nil {
			slog.Warn("river queue stop", "err", err)
		}
	}()
	slog.Info("river queue ready", "workers", "v1+v2+v3+warm_season")

	// Boot-time warm: enqueue current + next season immediately so the
	// dispatch loop has something to chew on as soon as it starts.
	// Periodic 24h re-fire is handled by the PeriodicJob registered
	// above.
	go func() {
		warmCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		curSeason, curYear := queue.CurrentSeason(time.Now())
		if err := enqueuer.EnqueueWarmSeasonNow(warmCtx, queue.WarmSeasonArgs{Season: curSeason, Year: curYear}); err != nil {
			slog.Warn("warm_season boot enqueue (current)", "err", err)
		}
		nextSeason, nextYear := queue.NextSeason(curSeason, curYear)
		if err := enqueuer.EnqueueWarmSeasonNow(warmCtx, queue.WarmSeasonArgs{Season: nextSeason, Year: nextYear}); err != nil {
			slog.Warn("warm_season boot enqueue (next)", "err", err)
		}
		slog.Info("warm_season boot enqueued", "current", curSeason, "next", nextSeason, "year", curYear)
	}()

	searchSvc, err := anime.NewSearchService(anilistClient, q, enqueuer)
	if err != nil {
		slog.Error("search service init failed", "err", err)
		os.Exit(1)
	}
	scheduleSvc, err := anime.NewScheduleService(anilistClient, q, enqueuer)
	if err != nil {
		slog.Error("schedule service init failed", "err", err)
		os.Exit(1)
	}
	detailSvc, err := anime.NewDetailService(q, anilistClient)
	if err != nil {
		slog.Error("detail service init failed", "err", err)
		os.Exit(1)
	}
	seasonalSvc := anime.NewSeasonalService(q, anilistClient)

	// 1h in-memory caches for /trending + /yearly-top (Express had these
	// as Map-based caches; we use ristretto for accurate eviction).
	// /completed-gems is a random sample — Express does NOT cache it
	// (would always return the same rows); we match that.
	trendingCache, err := anime.NewTrendingCache()
	if err != nil {
		slog.Error("trending cache init failed", "err", err)
		os.Exit(1)
	}
	yearlyTopCache, err := anime.NewYearlyTopCache()
	if err != nil {
		slog.Error("yearly-top cache init failed", "err", err)
		os.Exit(1)
	}

	// Boot-time orphan scan: catches anime_cache rows with
	// bangumi_version=0 that were upserted during a previous worker
	// outage.  Runs in a goroutine so server startup is not blocked
	// (river's queue can absorb the inserts in parallel with HTTP serving).
	go func() {
		scanCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		total, err := queue.ScanAndEnqueueOrphans(scanCtx, q, enqueuer)
		if err != nil {
			slog.Warn("orphan scan failed", "err", err, "enqueued_before_failure", total)
			return
		}
		if total > 0 {
			slog.Info("orphan scan enqueued V1 jobs", "count", total)
		}
	}()

	// JWT signer — both secrets required from P2.2 onward.  Fail-fast
	// at boot so misconfigured prod doesn't accept any sign-ins.
	signer, err := jwtx.NewSigner(cfg.JWTSecret, cfg.JWTRefreshSecret, cfg.JWTExpiresIn, cfg.JWTRefreshExpiresIn)
	if err != nil {
		slog.Error("jwt signer init failed", "err", err)
		os.Exit(1)
	}
	isProd := os.Getenv("GO_ENV") == "production"

	// Gmail SMTP sender — when GMAIL_USER/GMAIL_APP_PASSWORD are
	// unset (dev without email), NoopSender lets forgot-password
	// still return 200 (privacy/enumeration parity) while logging
	// the skipped send.  Same semantic as Express.
	var emailSender email.Sender = email.NoopSender{}
	if smtp, err := email.NewSMTPSender(cfg.GmailUser, cfg.GmailAppPassword); err == nil {
		emailSender = smtp
		slog.Info("email: Gmail SMTP configured", "user", cfg.GmailUser)
	} else {
		slog.Warn("email: Gmail SMTP not configured, password-reset emails will be skipped")
	}

	authHandlers := auth.NewHandlers(q, signer, emailSender, cfg.ClientOrigin, cfg.JWTRefreshExpiresIn, isProd)
	authRateLimit := auth.NewRateLimiter(10, 15*time.Minute)
	defer authRateLimit.Stop()

	// Admin handler bundles — P2.3.
	//   read:        /api/admin/{stats,enrichment,users}
	//   enrichment:  /api/admin/enrichment/* writes (re-enrich, heal-cn, reset, flag)
	//   userCRUD:    /api/admin/{users,warm-all} writes
	//
	// QueueStatusFn injects river-derived V3 pause info into the /stats
	// response.  Phase1/Phase4/V3 depth counters are 0 today — the
	// in-memory counters Express maintained were removed when V1/V2/V3
	// moved to river; the next phase can layer a JobList-based depth
	// reading on top without changing the response shape.
	queueStatusFn := func(ctx context.Context) (admin.QueueSnapshot, error) {
		snap := admin.QueueSnapshot{}
		s, err := queue.Status(ctx, riverClient)
		if err != nil {
			return snap, err
		}
		snap.V3Progress = &admin.V3BatchProgress{Paused: s.V3Paused}
		return snap, nil
	}
	adminReadHandlers := admin.NewHandlers(pool, q, queueStatusFn, nil)
	adminUserHandlers := admin.NewUserHandlers(q, enqueuer)
	adminEnrichmentHandlers := admin.NewEnrichmentHandlers(pool, q, enqueuer, riverClient)

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

	// P2.2 auth: 7 endpoints.  Rate-limiter wraps the public flows
	// (register/login/refresh + forgot/reset-password); logout + /me
	// are gated by RequireAuth instead.
	r.Route("/api/auth", func(r chi.Router) {
		r.With(authRateLimit.Middleware()).Post("/register", authHandlers.Register)
		r.With(authRateLimit.Middleware()).Post("/login", authHandlers.Login)
		r.With(authRateLimit.Middleware()).Post("/refresh", authHandlers.Refresh)
		r.With(authRateLimit.Middleware()).Post("/forgot-password", authHandlers.ForgotPassword)
		r.With(authRateLimit.Middleware()).Post("/reset-password/{token}", authHandlers.ResetPassword)
		r.With(jwtx.RequireAuth(signer)).Post("/logout", authHandlers.Logout)
		r.With(jwtx.RequireAuth(signer)).Get("/me", authHandlers.Me)
	})

	r.Route("/api/anime", func(r chi.Router) {
		r.Get("/completed-gems", anime.CompletedGems(q))
		r.Get("/seasonal", seasonalSvc.Handler())
		r.Get("/yearly-top", anime.YearlyTop(q, yearlyTopCache))
		r.Get("/trending", anime.Trending(q, trendingCache))
		r.Get("/torrents", anime.Torrents(torrentsAgg))
		r.Get("/search", searchSvc.Handler())
		r.Get("/schedule", scheduleSvc.Handler())
		r.Get("/{anilistId}/watchers", anime.Watchers(q))
		r.Get("/{anilistId}", detailSvc.Handler())
	})

	// P2.3 admin: 14 endpoints behind RequireAuth + RequireAdmin chain.
	// Express equivalent: server/routes/admin.routes.js with the same
	// `router.use(authenticateToken, adminAuth)` gate.  Order of mounts
	// matters for chi path resolution — more-specific paths
	// (`/enrichment/heal-cn/pause`) must register BEFORE the
	// parameterised variants (`/enrichment/{anilistId}/...`).
	r.Route("/api/admin", func(r chi.Router) {
		r.Use(jwtx.RequireAuth(signer))
		r.Use(jwtx.RequireAdmin())

		// Reads.
		r.Get("/stats", adminReadHandlers.GetStats)
		r.Get("/enrichment", adminReadHandlers.ListEnrichment)
		r.Get("/users", adminReadHandlers.ListUsers)

		// Enrichment writes — static paths first to keep chi happy.
		r.Post("/enrichment/re-enrich", adminEnrichmentHandlers.ReEnrich)
		r.Post("/enrichment/heal-cn", adminEnrichmentHandlers.HealCn)
		r.Post("/enrichment/heal-cn/pause", adminEnrichmentHandlers.PauseHeal)
		r.Post("/enrichment/heal-cn/resume", adminEnrichmentHandlers.ResumeHeal)
		r.Patch("/enrichment/{anilistId}", adminEnrichmentHandlers.UpdateEnrichment)
		r.Post("/enrichment/{anilistId}/reset", adminEnrichmentHandlers.ResetEnrichment)
		r.Post("/enrichment/{anilistId}/flag", adminEnrichmentHandlers.FlagEnrichment)

		// Warm-all (fire-and-forget) + user CRUD.
		r.Post("/warm-all", adminUserHandlers.WarmAll)
		r.Post("/users", adminUserHandlers.CreateUser)
		r.Patch("/users/{userId}", adminUserHandlers.UpdateUser)
		r.Delete("/users/{userId}", adminUserHandlers.DeleteUser)
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
		slog.Info("go-api starting", "addr", addr, "stage", "P2.3")
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
