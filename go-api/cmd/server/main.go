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

	"github.com/lawrenceli0228/animego/go-api/internal/activity"
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
	"github.com/lawrenceli0228/animego/go-api/internal/deepseek"
	"github.com/lawrenceli0228/animego/go-api/internal/email"
	"github.com/lawrenceli0228/animego/go-api/internal/hant"
	"github.com/lawrenceli0228/animego/go-api/internal/httpmw"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/notifications"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/safety"
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

	// DeepSeek client — the LLM translation fallback for description_cn
	// (description_llm_backfill sweep).  Keyed off DEEPSEEK_API_KEY: with
	// no key the workers still register (so leftover jobs can never meet
	// an unknown kind) but the scan runs disabled and the sweep is inert.
	// The interface stays nil rather than holding a keyless client so the
	// disabled posture is decided in exactly one place.
	var llmTranslator queue.DescriptionTranslator
	if key := os.Getenv("DEEPSEEK_API_KEY"); key != "" {
		llmTranslator = deepseek.NewClient(key)
	} else {
		slog.Info("description_llm sweep disabled: DEEPSEEK_API_KEY not set")
	}

	// Enqueuer must exist BEFORE workers are built (V1 worker captures
	// it to chain V2 jobs) but its underlying river client is the
	// OUTPUT of Boot below.  LateBoundEnqueuer breaks the cycle: it
	// no-ops until Bind is called, then forwards to a RealEnqueuer.
	enqueuer := &queue.LateBoundEnqueuer{}

	// River queue boot: real V1+V2+V3 (Bangumi enrichment trilogy) +
	// real WarmSeason worker + the description-backfill sweep.
	// WorkersWithBangumiAndNormalizer takes the AniList client (for
	// warm_season's Seasonal calls) + an injected normalizer
	// (anime.NormalizeMainRow — avoids the queue→anime import cycle).
	// Boot returns the client unstarted.
	//
	// bangumiClient is passed by value-of-pointer to every worker,
	// including the backfill one — deliberately.  Its rate limiter is
	// an in-process token bucket, so the backfill only stays inside the
	// bgm.tv budget while it draws from this same instance.  A standalone
	// backfill CLI would open a second bucket and double the real rate.
	workers := queue.WorkersWithBangumiAndNormalizer(
		bangumiClient,
		anilistClient,
		q,
		enqueuer,
		anime.NormalizeMainRow,
	)
	// LLM translation sweep registers separately so the bundle builder's
	// signature (and its test doubles) stay untouched.  With a nil
	// translator this registers a disabled scan + a defensive no-op row
	// worker — see AddDescriptionLlmWorkers.
	queue.AddDescriptionLlmWorkers(workers, llmTranslator, q, enqueuer)
	// zh-Hant sweep.  Registers separately for the same reason: it shares
	// none of the bundle builder's dependencies and needs one nothing else
	// does — the vendored dataset directory, which the image bakes at
	// /usr/local/share/animego/hant and a checkout has at data/hant.
	// Empty string here means "read HANT_DATA_DIR, default data/hant";
	// docker-compose sets it for the container.
	queue.AddHantBackfillWorker(workers, q, "")
	// Inferred-episode-count sweep.  Registers separately for the same
	// reason as the two above — it needs none of V12DB and V12DB needs
	// none of it — and takes the SAME bangumiClient every other worker
	// holds so its two-requests-per-row draw from the one token bucket
	// rather than opening a second one beside it.
	queue.AddEpisodesBgmWorkers(workers, bangumiClient, q, enqueuer)

	riverClient, err := queue.Boot(pool, queue.Config{
		Workers: workers,
		// Queues: default for V1+V2+warm_season+orphan_scan, bangumi_v3
		// for V3 only, description_backfill for the Chinese-description
		// sweep.  The dedicated V3 queue is what makes the admin
		// /heal-cn/pause endpoint isolate the heal-CN workload — pausing
		// the default queue would also freeze enrichment and seasonal
		// warming.  MaxWorkers=1 across the board matches the
		// conservative serial throttle the workers use to respect
		// Bangumi's 800ms-per-request budget (only one worker per queue).
		Queues: map[string]river.QueueConfig{
			river.QueueDefault:       {MaxWorkers: 1},
			queue.BangumiV3QueueName: {MaxWorkers: 1},
			// Chinese-description backfill: MaxWorkers MUST stay 1.
			// This is a long-running sweep over ~17k existing rows, and
			// its only cost is Bangumi API time — which is metered by a
			// token bucket on the single shared *bangumi.Client above.
			// Extra workers would therefore not drain the backlog any
			// faster; they would just queue up on the same bucket while
			// stealing dispatch slots from on-demand enrichment.  The
			// separate queue is for isolation and pausability, not for
			// parallelism.
			queue.DescriptionBackfillQueueName: {MaxWorkers: 1},
			// LLM translation sweep: 4 workers is the one queue here
			// that genuinely parallelises — its budget is DeepSeek
			// round-trips (seconds each, no shared token bucket), and
			// 4-way keeps a 600-row batch under ~15 minutes without
			// hammering the API.
			queue.DescriptionLlmQueueName: {MaxWorkers: 4},
			// zh-Hant sweep: MaxWorkers MUST stay 1.  One job is the
			// whole table, so a second worker has nothing to do except
			// run a duplicate pass — and HantBackfillArgs is unique
			// across every non-terminal state precisely to stop that.
			// The separate queue is so a pass that reads all ~17.5k rows
			// and issues two dozen 500-row UPDATEs cannot sit in front
			// of the V1/V2 enrichment a page load is waiting on.
			queue.HantBackfillQueueName: {MaxWorkers: 1},
			// Inferred episode counts: MaxWorkers MUST stay 1, for the
			// same reason as the description backfill.  Its cost is two
			// Bangumi requests per row, metered by the token bucket on
			// the single shared *bangumi.Client above, so extra workers
			// would not drain the backlog faster — they would queue on
			// the same bucket while stealing dispatch slots from
			// on-demand enrichment.  The separate queue is for isolation
			// and pausability, not parallelism.
			queue.EpisodesBgmQueueName: {MaxWorkers: 1},
		},
		PeriodicJobs: []*river.PeriodicJob{
			queue.PeriodicWarmSeasonJob(),
			queue.PeriodicOrphanScanJob(),
			queue.PeriodicDescriptionBackfillScanJob(),
			queue.PeriodicDescriptionLlmBackfillScanJob(),
			// Hourly, RunOnStart — river's OSS scheduler recomputes the
			// next run as now+period on every Start, so a deploy would
			// otherwise push the sweep a full hour out every time.
			queue.PeriodicEpisodesBgmScanJob(),
			// 90 days, and deliberately NOT RunOnStart — see the note on
			// PeriodicHantBackfillJob for why this one reads the opposite
			// way round from the two sweeps above it, and for what that
			// costs on a service that deploys more often than quarterly.
			queue.PeriodicHantBackfillJob(),
		},
		Logger: slog.Default(),
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
	slog.Info("river queue ready", "workers", "v1+v2+v3+warm_season+orphan_scan+description_backfill")

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

	// Simplified→Traditional folding for search keywords.
	//
	// 1,262 catalogue rows carry a Traditional title and no Simplified one —
	// Bangumi enrichment is where a Simplified title comes from, and those rows
	// have 9.4% bgm_id coverage against 70.8% for the catalogue, so there was
	// no subject to read one from. A reader typing 进击的巨人 could not reach
	// 進擊的巨人.
	//
	// Measured, not assumed: over the 5,160 rows holding both a Simplified
	// title and an authoritative Traditional one, folding lifts the match rate
	// from 7.4% to 40.7%. The rest is Taiwan and the mainland publishing an
	// anime under genuinely different names (海賊王 / 航海王), which no
	// character table can bridge.
	//
	// Folding closes what it can close without writing anything: the
	// stored titles, and therefore every SEO surface, are untouched. Backfilling
	// a converted title into title_chinese would NOT have that property —
	// migration 0022 built title_hant_seo precisely to keep machine-converted
	// text out of search results, and title_chinese has no such gate because it
	// IS what page titles and JSON-LD read.
	//
	// A failure here is a warning, not a boot failure. Search without folding
	// is what shipped yesterday; refusing to start over a missing dataset would
	// trade a degraded feature for an outage.
	var keywordFolder anime.KeywordFolder
	if conv, cErr := hant.NewConverterFromDir(hant.DataDirFromEnv()); cErr != nil {
		slog.Warn("search: OpenCC table unavailable, Simplified↔Traditional folding disabled",
			"dir", hant.DataDirFromEnv(), "err", cErr)
	} else {
		keywordFolder = conv
	}

	searchSvc, err := anime.NewSearchService(anilistClient, q, enqueuer, keywordFolder)
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

	// Transactional email, in order of preference.  When none is
	// configured (dev without email), NoopSender lets forgot-password
	// still return 200 (privacy/enumeration parity) while logging the
	// skipped send.  Same semantic as Express.
	//
	// The relay is tried first because it is the only path that can
	// send as an address at our own domain, which is what lets SPF,
	// DKIM and DMARC align.  Gmail stays as the fallback so a host
	// that has not been given relay credentials yet keeps sending
	// instead of going quietly dark — the failure this ordering exists
	// to avoid is a half-finished migration in which nobody notices
	// mail stopped, because the handler returns 200 either way.
	var emailSender email.Sender = email.NoopSender{}
	switch relay, relayErr := email.NewRelaySender(
		cfg.SMTPHost, cfg.SMTPUser, cfg.SMTPPassword, cfg.MailFrom,
	); {
	case relayErr == nil:
		emailSender = relay
		slog.Info("email: SMTP relay configured", "host", cfg.SMTPHost, "from", cfg.MailFrom)
	default:
		if gmail, gmailErr := email.NewSMTPSender(cfg.GmailUser, cfg.GmailAppPassword); gmailErr == nil {
			emailSender = gmail
			slog.Warn("email: falling back to Gmail — mail will NOT align with our domain",
				"user", cfg.GmailUser, "relayErr", relayErr)
		} else {
			slog.Warn("email: no sender configured, password-reset emails will be skipped")
		}
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
	// Refresh traffic gets its own, larger bucket. Several open tabs may all
	// discover an expired access token at once; sharing the 10-attempt
	// credential bucket let those harmless refreshes lock the user out of the
	// login form for 15 minutes.
	refreshRateLimitMax := 120
	if v := os.Getenv("AUTH_REFRESH_RATELIMIT_MAX"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			refreshRateLimitMax = n
		}
	}
	refreshRateLimit := auth.NewRateLimiter(refreshRateLimitMax, 15*time.Minute)
	defer refreshRateLimit.Stop()

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
		// if the query errors the other snapshot fields still render.
		//
		// T3 widened this from `GROUP BY kind` to `GROUP BY kind, state`.
		// Phase1/Phase4/V3 keep their exact previous meaning:  ONE number
		// per kind that sums every live state, i.e. "how much work is
		// outstanding".  The description backfill is bucketed by state
		// instead, and that split is the whole point of this change:
		//
		//   retryable does NOT mean "queued".  It means "this job already
		//   FAILED and is sitting in backoff waiting for another try".
		//   Folded into the queued number, a bgm.tv outage looks perfectly
		//   healthy — the depth stays comfortably non-zero and nothing on
		//   the dashboard can tell a real backlog apart from a retry storm.
		//   Split out, `retrying` climbing while `queued` stalls reads
		//   immediately as upstream breakage, and `discarded` climbing
		//   reads as rows we have permanently given up on.
		//
		// 'discarded' is deliberately added to the state filter — it was
		// NOT in the historical whitelist.  It must never reach the
		// Phase1/Phase4/V3 sums (those are outstanding-work gauges and a
		// discarded job is finished, badly, not outstanding), so the loop
		// below drops every terminal state before touching them.
		//
		// Reproduce by hand:
		//   SELECT kind, state, count(*) FROM river_job
		//   WHERE state IN ('available','running','pending','retryable',
		//                   'scheduled','discarded')
		//   GROUP BY kind, state ORDER BY kind, state;
		rows, err := pool.Query(ctx, `
			SELECT kind, state::text, count(*)::bigint
			FROM river_job
			WHERE state IN ('available','running','pending','retryable','scheduled','discarded')
			GROUP BY kind, state
		`)
		if err != nil {
			slog.WarnContext(ctx, "admin: queue depth query failed", "err", err)
		} else {
			// Accumulate into a scratch value, publish into snap only once
			// the whole result set has been read without error.  A mid-stream
			// failure (connection dropped, decode error) makes rows.Next()
			// return false exactly like a clean end-of-results, so writing
			// straight into snap would leave a TRUNCATED aggregate on the
			// dashboard — and truncation only ever shows LESS work than there
			// is, i.e. it reads as "healthy".  This whole panel exists so a
			// failure cannot look like health; half a row set is a failure.
			var depths queueDepths
			for rows.Next() {
				var kind, state string
				var cnt int64
				// A Scan error is fatal to the pgx Rows — it stores the error
				// and closes, so Next() returns false on the following
				// iteration and rows.Err() below reports it.  Breaking here
				// rather than continuing just makes that explicit.
				if err := rows.Scan(&kind, &state, &cnt); err != nil {
					break
				}
				depths.add(kind, state, cnt)
			}
			// Close before Err: pgx populates rows.err during Close (it is
			// where the result reader's own error surfaces), and Close is
			// idempotent — Next() already called it on clean exhaustion.
			// Closing here rather than deferring also hands the pooled
			// connection back before the two heartbeat round-trips below.
			rows.Close()
			if err := rows.Err(); err != nil {
				slog.WarnContext(ctx, "admin: queue depth query truncated; emitting zero counters", "err", err)
			} else {
				depths.publish(&snap)
			}
		}

		// T4 — the two halves of "is the description sweep alive".
		//
		// One heartbeat is not enough:  a sweep with an empty backlog and a
		// sweep whose worker died both write nothing, so "last write" alone
		// cannot tell them apart.  Hence a liveness signal (did the scan
		// run?) plus an activity signal (did it change anything?).
		//
		// Each query soft-fails independently:  a failure logs a warning,
		// leaves its own field nil, and does not touch the other field or
		// the queue depths above.

		// LastScanAt — the real "is it still running" signal.  The periodic
		// description_backfill_scan finalises every hour whether or not it
		// finds candidates, so this advances even when there is no work.
		//
		// NOTE ON RETENTION:  river prunes completed jobs after a retention
		// window (24h by default), so an empty result does NOT mean "never
		// ran" in the historical sense — it means "no scan has completed in
		// at least the retention window".  That is precisely the state worth
		// alerting on, and it is not an error.  nil is a value here.
		//
		// Reproduce by hand:
		//   SELECT max(finalized_at) FROM river_job
		//   WHERE kind = 'description_backfill_scan' AND state = 'completed';
		{
			var lastScan *time.Time
			if err := pool.QueryRow(ctx, `
				SELECT max(finalized_at)
				FROM river_job
				WHERE kind = 'description_backfill_scan'
				  AND state = 'completed'
			`).Scan(&lastScan); err != nil {
				slog.WarnContext(ctx, "admin: description backfill last-scan query failed", "err", err)
			} else {
				snap.DescriptionBackfill.LastScanAt = lastScan
			}
		}

		// LastWriteAt — "did it recently do any actual work".  Every
		// attempted row gets description_cn_attempted_at stamped, hit or
		// miss (DescriptionBackfillWorker.markAttempted, both branches),
		// and the sweep is the ONLY caller of MarkDescriptionCnAttempted —
		// live V2/V3 enrichment writes description_cn without stamping.
		// So this is the sweep's own write heartbeat and cannot be kept
		// artificially fresh by unrelated enrichment traffic.
		//
		// It legitimately FREEZES once the backlog is drained — a stale
		// value here with a fresh LastScanAt means "nothing left to do",
		// which is healthy.  Never read this one as liveness on its own;
		// pair it with descriptionCn.pending (see lib/backfillStatus.ts).
		//
		// COST:  this is a seq scan, not an index probe.  The 0015 index
		// (idx_anime_cache_description_cn_pending) is PARTIAL —
		// `WHERE description_cn IS NULL AND bgm_id IS NOT NULL` — so an
		// unqualified max() cannot use it, and adding that predicate to
		// match would be wrong, not merely narrower: it would exclude every
		// row the sweep SUCCEEDED on, leaving a "last write" that only ever
		// moves on rejections.  A sweep writing nothing but hits would show
		// a frozen heartbeat.  ~17k wide rows is a few tens of ms from
		// shared buffers; if that stops being acceptable the fix is a plain
		// btree on description_cn_attempted_at, not a narrower query.
		//
		// Reproduce by hand:
		//   SELECT max(description_cn_attempted_at) FROM anime_cache;
		{
			var lastWrite *time.Time
			if err := pool.QueryRow(ctx, `
				SELECT max(description_cn_attempted_at) FROM anime_cache
			`).Scan(&lastWrite); err != nil {
				slog.WarnContext(ctx, "admin: description backfill last-write query failed", "err", err)
			} else {
				snap.DescriptionBackfill.LastWriteAt = lastWrite
			}
		}

		// The same two heartbeats for the LLM tier.  They cannot be derived
		// from the Bangumi pair: the two sweeps have separate schedules,
		// separate attempt stamps and separate failure causes, so a fresh
		// Bangumi heartbeat says nothing about whether DeepSeek is
		// answering.  Both soft-fail independently, like every probe above.
		{
			var lastScan *time.Time
			if err := pool.QueryRow(ctx, `
				SELECT max(finalized_at)
				FROM river_job
				WHERE kind = 'description_llm_backfill_scan'
				  AND state = 'completed'
			`).Scan(&lastScan); err != nil {
				slog.WarnContext(ctx, "admin: description llm last-scan query failed", "err", err)
			} else {
				snap.DescriptionLlm.LastScanAt = lastScan
			}
		}

		// LastWriteAt for the LLM tier reads its OWN stamp column, which
		// DescriptionLlmWorker is the only writer of — so, exactly like the
		// Bangumi heartbeat above, it cannot be kept artificially fresh by
		// unrelated traffic, and it legitimately freezes once the backlog
		// drains.  Pair it with descriptionCnLlm.pending before calling it
		// dead (lib/backfillStatus.ts does this for both tiers).
		{
			var lastWrite *time.Time
			if err := pool.QueryRow(ctx, `
				SELECT max(description_cn_llm_attempted_at) FROM anime_cache
			`).Scan(&lastWrite); err != nil {
				slog.WarnContext(ctx, "admin: description llm last-write query failed", "err", err)
			} else {
				snap.DescriptionLlm.LastWriteAt = lastWrite
			}
		}

		return snap, nil
	}
	adminReadHandlers := admin.NewHandlers(pool, q, queueStatusFn, nil)
	adminUserHandlers := admin.NewUserHandlers(q, enqueuer)
	adminEnrichmentHandlers := admin.NewEnrichmentHandlers(pool, q, enqueuer, riverClient)
	adminHantHandlers := admin.NewHantHandlers(q, enqueuer)
	adminActivityHandlers := admin.NewActivityHandlers(q, slog.Default())

	// Presence recording (migration 0025).  The recorder buffers in memory and
	// flushes on a ticker; nothing it does touches the database on a request
	// path.
	//
	// Close is NOT deferred.  It is called explicitly on every shutdown path
	// below, because the graceful-shutdown block ends in os.Exit on failure and
	// a deferred call would be skipped exactly when the process is dying — i.e.
	// exactly when draining is the only thing standing between the last minute
	// of counters and the floor.
	activityRecorder := activity.NewRecorder(pool, slog.Default(), activity.DefaultFlushInterval)
	activityRecorder.Start()
	// A login is the one presence event the recorder's middleware structurally
	// cannot see: nobody holds a valid token at the moment they are logging in.
	authHandlers.SetLoginObserver(activityRecorder)

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
	notificationHandlers := notifications.NewHandlers(q)
	safetyHandlers := safety.NewHandlers(q)
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
	// P11 — presence recording.  Mounted ONCE at the top of the router
	// rather than inside each authenticated route group, so it cannot be
	// forgotten by a route added later and cannot be bypassed by one that
	// skips auth middleware entirely.  That costs a second HMAC verification
	// of the access token per authenticated request — see the note on
	// activity.Middleware for why the context route is not available to a
	// top-level middleware.  It never writes to the response, never blocks on
	// the database, and never fails a request.
	//
	// Registered after the rate limiter on purpose: a throttled request never
	// reached a handler, and counting it as presence would let a burst of
	// rejected calls inflate the request counters.
	r.Use(activity.Middleware(signer, activityRecorder))

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
		r.With(refreshRateLimit.Middleware()).Post("/refresh", authHandlers.Refresh)
		r.With(authRateLimit.Middleware()).Post("/forgot-password", authHandlers.ForgotPassword)
		r.With(authRateLimit.Middleware()).Post("/reset-password/{token}", authHandlers.ResetPassword)
		r.With(jwtx.RequireAuth(signer)).Post("/logout", authHandlers.Logout)
		r.With(jwtx.RequireAuth(signer)).Get("/me", authHandlers.Me)
		r.With(jwtx.RequireAuth(signer)).Patch("/me", authHandlers.UpdateMe)
	})

	// Routing note: every literal segment below shares the subtree with
	// the `/{anilistId}` wildcard on the last line.  chi's radix tree
	// resolves static segments before parametric ones regardless of
	// registration order, so `/episodes` reaches anime.Episodes and not
	// the detail handler with anilistId="episodes".  That is a property
	// of the router rather than of this ordering, and
	// TestEpisodes_RouteDoesNotCollideWithDetail pins it.
	r.Route("/api/anime", func(r chi.Router) {
		r.Get("/completed-gems", anime.CompletedGems(q))
		r.Get("/seasonal", seasonalSvc.Handler())
		r.Get("/yearly-top", anime.YearlyTop(q, yearlyTopCache))
		r.Get("/trending", anime.Trending(q, trendingCache))
		r.Get("/torrents", anime.Torrents(torrentsAgg, q))
		r.Get("/search", searchSvc.Handler())
		r.Get("/schedule", scheduleSvc.Handler())
		r.Get("/episodes", anime.Episodes(q))
		// Batch form of /{anilistId}/episode-offset, for the library backfill.
		// A fixed segment, so it must be registered outside the /{anilistId}
		// group to avoid being read as an id.
		r.Get("/episode-offsets", anime.EpisodeOffsets(q))
		// Catalogue enumeration for next-app's sitemap. Another fixed
		// segment sharing the subtree with /{anilistId}.
		r.Get("/sitemap", anime.SitemapShard(q))
		r.Get("/{anilistId}/watchers", anime.Watchers(q))
		// How many episodes precede this season in its franchise's
		// continuous numbering.  Registered before the bare /{anilistId} for
		// the same reason /watchers is: chi resolves the more specific
		// pattern first, and a two-segment route added after the catch-all
		// would never be reached.
		r.Get("/{anilistId}/episode-offset", anime.EpisodeOffset(q))
		r.Get("/{anilistId}", detailSvc.Handler())
	})

	// P2.4 — subscriptions: 8 endpoints, every route RequireAuth.
	//
	// The last three are the per-episode watch marks (migration 0024).  They
	// live inside this block, behind the same r.Use, on purpose: they are
	// user-scoped writes to a sub-resource of a subscription, and the user
	// id they write with comes from the JWT claims RequireAuth puts on the
	// request context — never from the path or the body.  Registering them
	// anywhere else would put that guarantee one refactor away from being
	// optional.
	//
	// PUT /{anilistId}/episodes (the set) and PUT
	// /{anilistId}/episodes/{episode} (one) differ by segment count, so chi
	// separates them structurally rather than by pattern precedence.
	r.Route("/api/subscriptions", func(r chi.Router) {
		r.Use(jwtx.RequireAuth(signer))
		r.Get("/", subscriptionsHandlers.ListSubscriptions)
		r.Post("/", subscriptionsHandlers.CreateSubscription)
		r.Get("/{anilistId}", subscriptionsHandlers.GetSubscriptionByAnilistID)
		r.Patch("/{anilistId}", subscriptionsHandlers.UpdateSubscription)
		r.Delete("/{anilistId}", subscriptionsHandlers.DeleteSubscription)
		r.Put("/{anilistId}/episodes", subscriptionsHandlers.MarkEpisodesWatched)
		r.Put("/{anilistId}/episodes/{episode}", subscriptionsHandlers.MarkEpisodeWatched)
		r.Delete("/{anilistId}/episodes/{episode}", subscriptionsHandlers.UnmarkEpisodeWatched)
	})

	// P2.4 — users public profile + follows.  GET /:username uses
	// OptionalAuth so anon callers still see the profile (isFollowing
	// is null); follow/unfollow require auth; followers/following lists
	// are public reads.
	r.Route("/api/users", func(r chi.Router) {
		r.With(jwtx.OptionalAuth(signer)).Get("/{username}", socialHandlers.GetProfile)
		r.With(jwtx.RequireAuth(signer)).Post("/{username}/follow", socialHandlers.Follow)
		r.With(jwtx.RequireAuth(signer)).Delete("/{username}/follow", socialHandlers.Unfollow)
		r.With(jwtx.RequireAuth(signer)).Put("/{username}/block", safetyHandlers.Block)
		r.With(jwtx.RequireAuth(signer)).Delete("/{username}/block", safetyHandlers.Unblock)
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
		r.With(jwtx.OptionalAuth(signer)).Get("/summary/{anilistId}", commentsHandlers.ListCommentSummaries)
		r.With(jwtx.OptionalAuth(signer)).Get("/{anilistId}/{episode}", commentsHandlers.ListComments)
		r.With(jwtx.RequireAuth(signer)).Post("/{anilistId}/{episode}", commentsHandlers.AddComment)
	})
	r.With(jwtx.RequireAuth(signer)).Delete("/api/comments/{id}", commentsHandlers.DeleteComment)
	r.With(jwtx.RequireAuth(signer)).Put("/api/comments/{id}/reaction", commentsHandlers.PutCommentReaction)
	r.With(jwtx.RequireAuth(signer)).Delete("/api/comments/{id}/reaction", commentsHandlers.DeleteCommentReaction)

	r.Route("/api/community", func(r chi.Router) {
		r.With(jwtx.OptionalAuth(signer)).Get("/discussions/trending", commentsHandlers.ListTrendingDiscussions)
		r.With(jwtx.OptionalAuth(signer)).Post("/engagement", commentsHandlers.TrackCommunityEngagement)
	})

	r.Route("/api/notifications", func(r chi.Router) {
		r.Use(jwtx.RequireAuth(signer))
		r.Get("/", notificationHandlers.List)
		r.Get("/unread-count", notificationHandlers.UnreadCount)
		r.Post("/read-all", notificationHandlers.MarkAllRead)
		r.Patch("/{id}/read", notificationHandlers.MarkRead)
	})

	r.With(jwtx.RequireAuth(signer)).Get("/api/blocks", safetyHandlers.ListBlocks)
	r.With(jwtx.RequireAuth(signer)).Post("/api/reports", safetyHandlers.CreateReport)

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
		r.Get("/reports", safetyHandlers.ListReports)
		r.Patch("/reports/{id}", safetyHandlers.UpdateReport)
		r.Get("/community-metrics", commentsHandlers.CommunityMetrics)
		// The user-activity panel: DAU/WAU/MAU, the daily trend, retention
		// cohorts and the surface breakdown.  Distinct from
		// /community-metrics, which is one rail's impressions and is
		// aggregate-only by construction.
		r.Get("/activity", adminActivityHandlers.GetActivity)

		// Enrichment writes — static paths first to keep chi happy.
		r.Post("/enrichment/re-enrich", adminEnrichmentHandlers.ReEnrich)
		r.Post("/enrichment/heal-cn", adminEnrichmentHandlers.HealCn)
		r.Post("/enrichment/heal-cn/pause", adminEnrichmentHandlers.PauseHeal)
		r.Post("/enrichment/heal-cn/resume", adminEnrichmentHandlers.ResumeHeal)
		r.Patch("/enrichment/{anilistId}", adminEnrichmentHandlers.UpdateEnrichment)
		r.Post("/enrichment/{anilistId}/reset", adminEnrichmentHandlers.ResetEnrichment)
		r.Post("/enrichment/{anilistId}/flag", adminEnrichmentHandlers.FlagEnrichment)

		// zh-Hant drift monitor: the two counters that say how far the
		// Traditional columns have fallen behind their sources, and the
		// button that catches them up.
		r.Get("/hant/stats", adminHantHandlers.GetHantStats)
		r.Post("/hant/backfill", adminHantHandlers.BackfillHant)

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
	shutdownErr := srv.Shutdown(ctx)

	// Drain the activity buffer AFTER Shutdown, so hits from the requests
	// Shutdown was waiting on are included — and on BOTH paths, because the
	// error branch exits the process and would skip anything deferred.
	//
	// The sum of these two has to fit inside the container's stop grace or the
	// kernel SIGKILLs us mid-drain: 15s here plus the recorder's 3s drain
	// budget is why docker-compose.yml gives go-api stop_grace_period: 30s.
	// Docker's default is 10s, under which the pre-existing 15s shutdown was
	// never reachable either.
	activityRecorder.Close()

	if shutdownErr != nil {
		slog.Error("graceful shutdown failed", "err", shutdownErr)
		os.Exit(1)
	}
	slog.Info("server stopped")
}

// queueDepths accumulates the `GROUP BY kind, state` aggregate over
// river_job that backs the /api/admin/stats `queue` object.
//
// Package-level (rather than six locals inside queueStatusFn's closure)
// for one reason: the bucketing rules below are the part of the admin
// panel that must not lie, and a closure inside main() cannot be tested.
// See main_test.go — every case there is a way the old single-number
// gauge would have reported a broken sweep as a healthy one.
type queueDepths struct {
	phase1, phase4, v3                   int64
	bfQueued, bfRetrying, bfDiscarded    int64
	llmQueued, llmRetrying, llmDiscarded int64
}

// add folds one aggregate row into the accumulator.
//
// Two different models live here on purpose:
//
//	description_backfill — split by river state.  `retryable` does NOT
//	mean queued; it means the job already FAILED and is in backoff.
//	Folded into the queued number a bgm.tv outage looks perfectly
//	healthy, because the depth stays non-zero and nothing distinguishes
//	a real backlog from a retry storm.  `discarded` means retries are
//	exhausted — rows nobody will pick up again without a manual
//	re-enqueue, which a depth gauge can never surface.
//
//	bangumi_v1/v2/v3 — one "outstanding work" number per kind, exactly
//	as before this change.  Terminal states are dropped by name rather
//	than left to the SQL WHERE clause, because that clause is what just
//	changed: 'discarded' had to be added to it for the split above, and
//	without this guard it would have quietly inflated the legacy gauges
//	with dead work.  All three terminal states are listed, not just the
//	one currently selected, so widening the filter again stays safe.
//
// Unknown kinds (description_backfill_scan, warm_season, orphan_scan)
// are counted nowhere — deliberate: the scan job's health is reported by
// the LastScanAt heartbeat, not by a depth number.
func (d *queueDepths) add(kind, state string, cnt int64) {
	if kind == "description_llm_backfill" {
		// Same three-way split and the same default-folds-forward stance
		// as the Bangumi sweep below.  Retrying matters MORE here: a
		// DeepSeek 429, an expired key or an exhausted balance all land
		// as retryable, and this counter is the only place that shows up
		// before the credit runs out entirely.
		switch state {
		case "retryable":
			d.llmRetrying += cnt
		case "discarded":
			d.llmDiscarded += cnt
		default: // available / running / pending / scheduled
			d.llmQueued += cnt
		}
		return
	}
	if kind == "description_backfill" {
		// `default` rather than an explicit available/running/pending/
		// scheduled list, on purpose.  If somebody widens the WHERE clause
		// with a new LIVE state, default folds it into queued (over-reports
		// work — loud, someone investigates); an explicit list would
		// silently drop it (under-reports — reads as healthy, nobody
		// looks).  When in doubt this panel errs toward looking worse.
		switch state {
		case "retryable":
			d.bfRetrying += cnt
		case "discarded":
			d.bfDiscarded += cnt
		default: // available / running / pending / scheduled
			d.bfQueued += cnt
		}
		return
	}
	switch state {
	case "discarded", "cancelled", "completed":
		return
	}
	switch kind {
	case "bangumi_v1":
		d.phase1 += cnt
	case "bangumi_v2":
		d.phase4 += cnt
	case "bangumi_v3":
		d.v3 += cnt
	}
}

// publish copies the accumulated depths onto the snapshot.
//
// Separate from add so the caller can withhold a partially-read result
// set: an aggregate truncated by a mid-stream error under-reports, and
// under-reporting is precisely the failure that reads as health.
func (d *queueDepths) publish(snap *admin.QueueSnapshot) {
	snap.Phase1 = d.phase1
	snap.Phase4 = d.phase4
	snap.V3 = d.v3
	snap.DescriptionBackfill.Queued = d.bfQueued
	snap.DescriptionBackfill.Retrying = d.bfRetrying
	snap.DescriptionBackfill.Discarded = d.bfDiscarded
	snap.DescriptionLlm.Queued = d.llmQueued
	snap.DescriptionLlm.Retrying = d.llmRetrying
	snap.DescriptionLlm.Discarded = d.llmDiscarded
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
