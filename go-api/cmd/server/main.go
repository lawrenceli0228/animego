// Package main is the chi HTTP server entry point for go-api.
//
// P2.0.D scope: middleware chain is now full envelope-aware + /health-
// skipping + CORS-fronted.  Chain order (locked by /plan-eng-review;
// P10 observability lane added Sentry after Recoverer):
//
//	CORS  → RequestID  → RealIP  → RequestLog  → Recoverer  → Sentry  → Timeout
//
// Sentry sits AFTER Recoverer so the project's envelope-aware recoverer
// catches the panic first (and writes the JSON 500 envelope clients
// expect), then Repanic:true re-panics so sentryhttp captures the stack
// for reporting.  Empty SENTRY_DSN is a supported no-op (dev/staging
// default); no manual guard needed — sentry-go silently drops events
// when Dsn:"".
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/admin"
	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/anime"
	"github.com/lawrenceli0228/animego/go-api/internal/auth"
	"github.com/lawrenceli0228/animego/go-api/internal/avatars"
	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	"github.com/lawrenceli0228/animego/go-api/internal/bgmidmap"
	"github.com/lawrenceli0228/animego/go-api/internal/comments"
	"github.com/lawrenceli0228/animego/go-api/internal/config"
	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
	"github.com/lawrenceli0228/animego/go-api/internal/danmaku"
	"github.com/lawrenceli0228/animego/go-api/internal/db"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/email"
	"github.com/lawrenceli0228/animego/go-api/internal/httpmw"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/social"
	"github.com/lawrenceli0228/animego/go-api/internal/subscriptions"
	"github.com/lawrenceli0228/animego/go-api/internal/torrents"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Sentry init — P10 observability lane.  Empty SENTRY_DSN is the
	// intended no-op for dev/staging (sentry-go drops events silently
	// when Dsn:"").  Tracing is off by default; only error capture +
	// panic reporting are enabled for now.  Init returns an error only
	// for malformed DSN — log and continue so a typo can't crash boot.
	if err := sentry.Init(sentry.ClientOptions{
		Dsn:              os.Getenv("SENTRY_DSN"),
		EnableTracing:    false,
		TracesSampleRate: 0.0,
		Release:          os.Getenv("GIT_SHA"),
		Environment:      os.Getenv("APP_ENV"),
		ServerName:       "go-api",
		AttachStacktrace: true,
	}); err != nil {
		slog.Warn("sentry init failed", "err", err)
	}
	defer sentry.Flush(2 * time.Second)

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
			river.QueueDefault:       {MaxWorkers: 1},
			queue.BangumiV3QueueName: {MaxWorkers: 1},
		},
		PeriodicJobs: []*river.PeriodicJob{queue.PeriodicWarmSeasonJob(), queue.PeriodicOrphanScanJob()},
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
	slog.Info("river queue ready", "workers", "v1+v2+v3+warm_season+orphan_scan")

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

	// Boot-time setup, off the critical path so HTTP serving starts
	// immediately. Order matters: seed the AniList->Bangumi id map BEFORE
	// the orphan scan enqueues V1 jobs, so those jobs can bind mapped
	// titles authoritatively instead of falling to the fuzzy scorer.
	go func() {
		// Seed the vendored id map (internal/bgmidmap embed → bgm_id_map).
		// Idempotent full-replace; failure is non-fatal — the V1 worker just
		// degrades to the search + scorer path for everything.
		seedCtx, seedCancel := context.WithTimeout(context.Background(), 60*time.Second)
		if n, err := bgmidmap.Seed(seedCtx, pool); err != nil {
			slog.Warn("bgm_id_map seed failed", "err", err)
		} else {
			slog.Info("bgm_id_map seeded", "entries", n)
		}
		seedCancel()

		// Orphan scan: catches anime_cache rows with bangumi_version=0 that
		// were upserted during a previous worker outage.  river's queue can
		// absorb the inserts in parallel with HTTP serving.
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

	authHandlers := auth.NewHandlers(q, signer, emailSender, cfg.ClientOrigin, cfg.JWTExpiresIn, cfg.JWTRefreshExpiresIn, isProd)
	avatarDir := os.Getenv("AVATAR_DIR")
	if avatarDir == "" {
		avatarDir = "/data/avatars"
	}
	authHandlers.SetAvatarDir(avatarDir)
	authRateLimitMax := 10
	if v := os.Getenv("AUTH_RATELIMIT_MAX"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			authRateLimitMax = n
		}
	}
	authRateLimit := auth.NewRateLimiter(authRateLimitMax, 15*time.Minute)
	defer authRateLimit.Stop()

	// Admin handler bundles — P2.3.
	//   read:        /api/admin/{stats,enrichment,users}
	//   enrichment:  /api/admin/enrichment/* writes (re-enrich, heal-cn, reset, flag)
	//   userCRUD:    /api/admin/{users,warm-all} writes
	//
	// QueueStatusFn assembles the /stats `queue` field: per-kind river_job
	// depth counts (Phase1/Phase4/V3), the V3 batch progress
	// (total/processed/healed from the in-memory tracker that the heal-cn /
	// re-enrich-v2 endpoints seed and the V3 worker increments), and the
	// river-persisted V3 pause flag.
	queueStatusFn := func(ctx context.Context) (admin.QueueSnapshot, error) {
		snap := admin.QueueSnapshot{}

		// V3 paused flag — survives process restart (river_queue.paused_at).
		// Also attach the in-memory batch counters so the frontend's
		// striped-progress animation activates when a batch is running.
		{
			total, processed, healed := queue.V3BatchSnapshot()
			prog := &admin.V3BatchProgress{
				Total:     total,
				Processed: processed,
				Healed:    healed,
			}
			if s, err := queue.Status(ctx, riverClient); err == nil {
				prog.Paused = s.V3Paused
			} else {
				slog.WarnContext(ctx, "admin: queue.Status failed", "err", err)
			}
			snap.V3Progress = prog
		}

		// G5 — depth counters by river job kind.  Express tracked these
		// via in-memory Map sizes in bangumi.service.js; river persists
		// the state in river_job, so a one-shot aggregate replaces the
		// counter bookkeeping the in-memory model needed.  Soft-fail —
		// if the query errors we still return the paused flag.
		rows, err := pool.Query(ctx, `
			SELECT kind, count(*)::bigint
			FROM river_job
			WHERE state IN ('available','running','pending','retryable','scheduled')
			GROUP BY kind
		`)
		if err != nil {
			slog.WarnContext(ctx, "admin: queue depth query failed", "err", err)
			return snap, nil
		}
		defer rows.Close()
		for rows.Next() {
			var kind string
			var cnt int64
			if err := rows.Scan(&kind, &cnt); err != nil {
				continue
			}
			switch kind {
			case "bangumi_v1":
				snap.Phase1 = cnt
			case "bangumi_v2":
				snap.Phase4 = cnt
			case "bangumi_v3":
				snap.V3 = cnt
			}
		}
		return snap, nil
	}
	adminReadHandlers := admin.NewHandlers(pool, q, queueStatusFn, nil)
	adminUserHandlers := admin.NewUserHandlers(q, enqueuer)
	adminEnrichmentHandlers := admin.NewEnrichmentHandlers(pool, q, enqueuer, riverClient)

	// P2.4 — subscriptions + social.  Subscriptions handler depends on
	// anime.EnsureCached for the FK pre-fill (POST /api/subscriptions
	// requires the anime_cache row to exist; if missing, EnsureCached
	// triggers a one-shot AniList Detail fetch + upsert).  Social
	// handlers are pure DB readers/writers — no external deps.
	subscriptionsHandlers := subscriptions.NewHandlers(pool, q, q, anilistClient, nil)
	socialHandlers := social.NewHandlers(pool, q)

	// P2.5 — comments + danmaku HTTP handlers.  Both are simple
	// pool+queries handlers (no external service deps).  Comments POST
	// is the only auth-gated write; danmaku writes go through socket.io
	// (P2.8), so only the read endpoint lives here.
	commentsHandlers := comments.NewHandlers(pool, q)
	danmakuHandlers := danmaku.NewHandlers(pool, q)

	// P2.6 — dandanplay 3-phase match.  Independent rate limiter
	// (800ms, separate from Bangumi's 800ms) so admin enrichment
	// queues don't starve user-triggered /match calls.  X-AppId /
	// X-AppSecret read from env; absent values mean public-tier
	// requests (stricter dandanplay limits, but the API still
	// responds).
	dandanClient, err := dandanplay.NewClient(
		dandanplay.WithCredentials(os.Getenv("DANDANPLAY_APP_ID"), os.Getenv("DANDANPLAY_APP_SECRET")),
	)
	if err != nil {
		slog.Error("dandanplay client init failed", "err", err)
		os.Exit(1)
	}
	defer dandanClient.Close()
	dandanplayHandlers := dandanplay.NewHandlers(q, dandanClient, bangumiClient)

	// G4 — global per-IP rate limiter for /api/*.  Express applied
	// apiLimiter (300/15min) across the whole /api/* tree; Go has only
	// the strict 10/15min auth limiter so far, leaving anime/dandanplay
	// /admin/comments/etc unmetered.  This middleware skips itself for
	// /health + /api/health (see shouldLimitPath in api_ratelimit.go)
	// so LB probes are never throttled.
	// API_RATELIMIT_BURST=0 disables the limiter (used in CI/e2e).
	apiRateLimitBurst := httpmw.DefaultAPIBurst
	if v := os.Getenv("API_RATELIMIT_BURST"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			apiRateLimitBurst = n
		}
	}
	apiRateLimit := httpmw.NewAPIRateLimiterWithBurst(httpmw.DefaultAPIRate, apiRateLimitBurst)
	defer apiRateLimit.Stop()

	r := chi.NewRouter()
	r.Use(httpmw.CORS(cfg.ClientOrigin))
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(httpmw.RequestLog(slog.Default()))
	r.Use(httpmw.Recoverer(slog.Default()))
	// P10 — Sentry panic capture.  Repanic:true means sentryhttp
	// re-throws after Hub.Recover so the project's Recoverer (above)
	// remains the surface that turns the panic into the canonical
	// SERVER_ERROR JSON envelope.  Order matters: Recoverer must be
	// outer (registered first) so it catches the re-panic emitted here.
	r.Use(sentryhttp.New(sentryhttp.Options{Repanic: true}).Handle)
	r.Use(middleware.Timeout(60 * time.Second))
	// G2 — 1 MiB request body cap.  Without this a single 1GB POST
	// to /api/auth/register or /api/comments would allocate the full
	// buffer in RAM before validation rejects it.  The cap surfaces
	// downstream as a JSON decode error → 400 "Invalid request body".
	r.Use(httpmw.MaxBodyBytes(httpmw.DefaultMaxBodyBytes))
	// G4 wiring (see comment above).
	r.Use(apiRateLimit.Middleware())

	// G3 — chi defaults emit plain-text "404 page not found" / "405
	// Method Not Allowed" for unmatched routes.  Frontend retry logic
	// branches on error.code === "NOT_FOUND" — emit the byte-exact
	// Express envelope so that path keeps working.
	r.NotFound(httpmw.NotFound)
	r.MethodNotAllowed(httpmw.MethodNotAllowed)

	// Health endpoint pings the DB pool.  Docker healthcheck only
	// requires HTTP 200; RequestLog skips this path to avoid drowning
	// real traffic in 2880 probe lines per pod per day.  G1: register
	// at BOTH /health and /api/health so existing nginx upstream probes
	// (currently pointed at Express's /api/health) survive cutover.
	r.Get("/health", healthHandler(pool))
	r.Get("/api/health", healthHandler(pool))
	// Public avatar files (member-pass photos), served from the volume with
	// long immutable cache; the stored URL's ?v= busts CF on change.
	r.Get("/api/avatars/{name}", avatars.ServeAvatar(avatarDir))

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
		r.With(jwtx.RequireAuth(signer)).Patch("/me", authHandlers.UpdateMe)
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

	// P2.4 — subscriptions: 5 endpoints, every route RequireAuth.
	r.Route("/api/subscriptions", func(r chi.Router) {
		r.Use(jwtx.RequireAuth(signer))
		r.Get("/", subscriptionsHandlers.ListSubscriptions)
		r.Post("/", subscriptionsHandlers.CreateSubscription)
		r.Get("/{anilistId}", subscriptionsHandlers.GetSubscriptionByAnilistID)
		r.Patch("/{anilistId}", subscriptionsHandlers.UpdateSubscription)
		r.Delete("/{anilistId}", subscriptionsHandlers.DeleteSubscription)
	})

	// P2.4 — users public profile + follows.  GET /:username uses
	// OptionalAuth so anon callers still see the profile (isFollowing
	// is null); follow/unfollow require auth; followers/following lists
	// are public reads.
	r.Route("/api/users", func(r chi.Router) {
		r.With(jwtx.OptionalAuth(signer)).Get("/{username}", socialHandlers.GetProfile)
		r.With(jwtx.RequireAuth(signer)).Post("/{username}/follow", socialHandlers.Follow)
		r.With(jwtx.RequireAuth(signer)).Delete("/{username}/follow", socialHandlers.Unfollow)
		r.Get("/{username}/followers", socialHandlers.ListFollowers)
		r.Get("/{username}/following", socialHandlers.ListFollowing)
	})

	// P2.4 — activity feed of followed users.  Requires auth.
	r.With(jwtx.RequireAuth(signer)).Get("/api/feed", socialHandlers.GetFeed)

	// P2.5 — episode comments (3 endpoints).  List is public; add +
	// delete require auth.  delete has an own-row check inside the
	// handler so RequireAuth alone is enough (no admin role needed).
	//
	// Routing note: GET/POST take a 2-segment path
	// `/{anilistId}/{episode}`, DELETE takes a 1-segment `/{id}`.  Chi's
	// RadixTree treats these as distinct depths, but registering them
	// in the SAME r.Route block sometimes makes chi pin the first
	// param name (`anilistId`) into the radix node and then refuse the
	// later `{id}` registration silently.  Mount DELETE at the parent
	// scope so the two route shapes live in separate trees.
	r.Route("/api/comments", func(r chi.Router) {
		r.Get("/{anilistId}/{episode}", commentsHandlers.ListComments)
		r.With(jwtx.RequireAuth(signer)).Post("/{anilistId}/{episode}", commentsHandlers.AddComment)
	})
	r.With(jwtx.RequireAuth(signer)).Delete("/api/comments/{id}", commentsHandlers.DeleteComment)

	// P2.5 — historical danmaku list (1 endpoint).  Public read.
	// Writes go through socket.io (P2.8, ws-server).
	r.Get("/api/danmaku/{anilistId}/{episode}", danmakuHandlers.GetDanmaku)

	// P2.6 — dandanplay 4 endpoints.  All public (no user-scoped
	// state); IP-level rate limiting protects against abuse.
	r.Route("/api/dandanplay", func(r chi.Router) {
		r.Post("/match", dandanplayHandlers.Match)
		r.Get("/search", dandanplayHandlers.Search)
		r.Get("/comments/{episodeId}", dandanplayHandlers.GetComments)
		r.Get("/episodes/{animeId}", dandanplayHandlers.GetEpisodes)
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
		r.Post("/users/{userId}/password", adminUserHandlers.SetUserPassword)
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
		slog.Info("go-api starting", "addr", addr, "stage", "P2.6")
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
