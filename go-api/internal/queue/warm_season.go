// warm_season.go — Periodic AniList seasonal cache warm worker.
//
// Replaces the Express server/services/anilist.service.js warmSeasonCache
// + warmCurrentSeason + setInterval block (lines 172-208).  Two jobs are
// enqueued at boot (current + next season) and river's PeriodicJobs
// re-fires the worker every 24 hours so the cache stays warm for the
// rolling current-season + upcoming-season window.
//
// Flow per job (one (season, year) pair):
//
//  1. 5-minute ctx timeout — multi-page fetch + per-page 700ms throttle
//     gives a comfortable budget for the typical 1-2 page season.  Worst
//     case (20 pages * ~11s = 220s) still fits within 300s.
//  2. Page loop:  page=1, perPage=50.  Continue while
//     resp.Page.PageInfo.HasNextPage == true.  Hard cap at
//     warmSeasonMaxPages (20) so a runaway AniList response can't burn
//     the whole budget.
//  3. For each page: NormalizeMainRow + UpsertAnimeCache per Media.
//     Per-row errors logged WarnContext + counted but NOT fatal — the
//     next periodic run picks up rows that missed.
//  4. After all pages upserted: collect anilist_ids,
//     GetTitleChineseByAnilistIDs to filter to bangumi_version=0, and
//     EnqueueV1Many.  Same pattern as /search and /schedule.
//  5. Log summary with pages fetched, rows upserted, rows enqueued.
//
// Retry policy:  AniList transport / GraphQL errors return wrapped so
// river retries per its default policy.  Per-row UpsertAnimeCache errors
// are swallowed (next periodic fire will catch them).  Sanity-cap hit
// (20+ pages) logs a warning and returns nil — runaway response wouldn't
// fix itself across retries.
//
// SCOPE: This worker does NOT touch child tables (anime_studios,
// anime_characters, etc).  Seasonal warm only needs the listing-card
// surface (title, cover, score, episodes); detail-table population
// happens on /anime/:id detail fetches.  Mirrors Express behaviour
// which also limits warmSeasonCache to the main row.

package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// warmSeasonCtxTimeout bounds a single worker invocation.  5 minutes is
// the headroom for a 20-page * (700ms throttle + 10s HTTP) worst case
// (~220s) plus per-page DB upsert latency.  Typical fire completes in
// 1-3s for a 1-2 page season.
const warmSeasonCtxTimeout = 5 * time.Minute

// warmSeasonPerPage matches the Express warmSeasonCache page size.
// AniList accepts up to 50 per page on Page/Media queries.
const warmSeasonPerPage = 50

// warmSeasonMaxPages caps the page loop so a misbehaving AniList
// (HasNextPage=true forever) cannot exhaust the 5-minute budget and
// spin the limiter.  20 pages * 50 per_page = 1000 anime per season,
// well above any real seasonal slate (typical Japanese anime season
// runs 30-60 titles).
const warmSeasonMaxPages = 20

// warmSeasonPeriodicInterval is the cadence river uses to re-fire the
// worker.  24h matches the Express setInterval(24*60*60*1000).
const warmSeasonPeriodicInterval = 24 * time.Hour

// AniListSeasonalFetcher is the small interface WarmSeasonWorker
// consumes from the anilist package.  *anilist.Client satisfies it.
// Defined here at the use-site (Accept interfaces, return structs) so
// tests can supply a stub without dragging the full HTTP client into
// the test setup.
type AniListSeasonalFetcher interface {
	Seasonal(ctx context.Context, v anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error)
}

// WarmSeasonDB is the sqlc subset WarmSeasonWorker uses.  Two methods:
// UpsertAnimeCache (main-row upsert) and GetTitleChineseByAnilistIDs
// (post-upsert bangumi_version filter to decide which IDs need V1
// enrichment).  dbgen.Querier satisfies it.
type WarmSeasonDB interface {
	UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error
	GetTitleChineseByAnilistIDs(ctx context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error)
}

// MainRowNormalizer converts one anilist.Media into the sqlc
// UpsertAnimeCacheParams shape.  Injected (rather than importing
// internal/anime directly) because internal/anime already imports
// internal/queue for the Enqueuer surface — pulling anime back in here
// would create a cycle.  Main.go passes anime.NormalizeMainRow as the
// production normalizer; tests can inject a simpler closure if needed.
type MainRowNormalizer func(m anilist.Media) dbgen.UpsertAnimeCacheParams

// defaultMainRowNormalizer is a tiny built-in normalizer used when the
// constructor receives a nil normalizer.  It populates only AnilistID
// — enough for the worker to upsert a row without touching internal
// /anime.  Production callers MUST pass anime.NormalizeMainRow instead
// (the default emits an under-populated row that won't render usefully
// in the UI).
func defaultMainRowNormalizer(m anilist.Media) dbgen.UpsertAnimeCacheParams {
	return dbgen.UpsertAnimeCacheParams{AnilistID: int32(m.ID)}
}

// WarmSeasonWorker implements river.Worker[WarmSeasonArgs].  Embeds
// river.WorkerDefaults to inherit the retry / timeout / middleware
// defaults so only Work() needs overriding.
//
// enq is used to dispatch V1 enrichment after each warm.  Pass
// NoopEnqueuer{} (or nil — the constructor substitutes Noop) in unit
// tests that don't want to assert on the V1 chain.
//
// normalize is injected (see MainRowNormalizer doc) to keep this
// package import-cycle-free with internal/anime.
type WarmSeasonWorker struct {
	river.WorkerDefaults[WarmSeasonArgs]
	anilist   AniListSeasonalFetcher
	db        WarmSeasonDB
	enq       Enqueuer
	normalize MainRowNormalizer
}

// NewWarmSeasonWorker constructs a worker bound to the given AniList
// client, DB, and Enqueuer.  anilistClient + db are required; nil
// panics on the first job (intentional — misconfiguration should crash
// loudly, not silently no-op).
//
// enq is OPTIONAL — nil is replaced with NoopEnqueuer{} so the V1
// chain is a safe no-op when the caller hasn't wired river yet (e.g.
// pre-Bind LateBoundEnqueuer).  V1 chain enqueue failure is non-fatal
// (logged + swallowed) so a busted river client cannot block the warm
// from completing.
//
// The normalizer is hard-coded to defaultMainRowNormalizer (id only).
// Production callers MUST use NewWarmSeasonWorkerWithNormalizer to
// inject anime.NormalizeMainRow; this constructor exists for tests
// that don't care about the populated row shape.
func NewWarmSeasonWorker(anilistClient AniListSeasonalFetcher, db WarmSeasonDB, enq Enqueuer) *WarmSeasonWorker {
	return NewWarmSeasonWorkerWithNormalizer(anilistClient, db, enq, nil)
}

// NewWarmSeasonWorkerWithNormalizer is the production constructor that
// accepts a MainRowNormalizer (typically anime.NormalizeMainRow).
// Nil normalizer falls back to defaultMainRowNormalizer.  Nil enq
// falls back to NoopEnqueuer{}.
func NewWarmSeasonWorkerWithNormalizer(
	anilistClient AniListSeasonalFetcher,
	db WarmSeasonDB,
	enq Enqueuer,
	normalize MainRowNormalizer,
) *WarmSeasonWorker {
	if enq == nil {
		enq = NoopEnqueuer{}
	}
	if normalize == nil {
		normalize = defaultMainRowNormalizer
	}
	return &WarmSeasonWorker{
		anilist:   anilistClient,
		db:        db,
		enq:       enq,
		normalize: normalize,
	}
}

// Work is the river dispatch entrypoint.  See package doc for the
// 5-step flow.  Returns nil on success / sanity-cap hit / empty
// season; a wrapped error for transient AniList failures (river
// retries).
func (w *WarmSeasonWorker) Work(ctx context.Context, job *river.Job[WarmSeasonArgs]) error {
	season := job.Args.Season
	year := job.Args.Year

	// Bound the whole multi-page fetch.  5-minute timeout sits above
	// the AniList client's per-request 10s timeout, so a stuck HTTP
	// call still gets canceled from above eventually.
	ctx, cancel := context.WithTimeout(ctx, warmSeasonCtxTimeout)
	defer cancel()

	upsertedIDs := make([]int32, 0, warmSeasonPerPage)
	pages := 0
	upsertOK := 0
	upsertFail := 0

	for page := 1; page <= warmSeasonMaxPages; page++ {
		resp, err := w.anilist.Seasonal(ctx, anilist.SeasonalVars{
			Page:       page,
			PerPage:    warmSeasonPerPage,
			Season:     season,
			SeasonYear: year,
		})
		if err != nil {
			// Transient — return wrapped so river retries.  AniList
			// upstream errors and rate-limit failures both flow through
			// here; classification happens at the handler layer not the
			// worker.
			var upstream *anilist.ErrUpstream
			switch {
			case errors.Is(err, anilist.ErrRateLimited):
				slog.WarnContext(ctx, "warm_season anilist rate_limited",
					"season", season, "year", year, "page", page)
			case errors.As(err, &upstream):
				slog.WarnContext(ctx, "warm_season anilist upstream",
					"season", season, "year", year, "page", page,
					"status", upstream.Status, "msg", upstream.Message)
			default:
				slog.WarnContext(ctx, "warm_season anilist transport",
					"season", season, "year", year, "page", page, "err", err)
			}
			return fmt.Errorf("warm_season anilist %s %d page %d: %w", season, year, page, err)
		}

		pages++

		// Per-row upsert.  Errors are logged + counted, NOT fatal —
		// keep going so a single bad row can't block the rest of the
		// season; next periodic run picks up the misses.
		for _, m := range resp.Page.Media {
			params := w.normalize(m)
			if uErr := w.db.UpsertAnimeCache(ctx, params); uErr != nil {
				upsertFail++
				slog.WarnContext(ctx, "warm_season upsert row error",
					"season", season, "year", year,
					"anilistId", m.ID, "err", uErr)
				continue
			}
			upsertOK++
			upsertedIDs = append(upsertedIDs, int32(m.ID))
		}

		if !resp.Page.PageInfo.HasNextPage {
			break
		}

		if page == warmSeasonMaxPages {
			// Sanity-cap hit.  Log a warning and exit with nil — a
			// runaway HasNextPage=true wouldn't fix itself across
			// retries, so swallow and let the next periodic fire try
			// again with fresh AniList state.
			slog.WarnContext(ctx, "warm_season page cap reached",
				"season", season, "year", year,
				"maxPages", warmSeasonMaxPages,
				"pages", pages, "upserted", upsertOK)
		}
	}

	// V1 enrichment trigger — query bangumi_version for the just-warmed
	// IDs and enqueue the ones still at 0.  Same pattern as /search and
	// /schedule.  Failure is non-fatal — the row data has already
	// landed; missing the enqueue just means titleChinese stays null
	// until the next miss.
	enqueued := 0
	if len(upsertedIDs) > 0 {
		versRows, vErr := w.db.GetTitleChineseByAnilistIDs(ctx, upsertedIDs)
		if vErr != nil {
			slog.WarnContext(ctx, "warm_season enqueue lookup failed",
				"season", season, "year", year, "err", vErr)
		} else {
			toEnqueue := make([]int32, 0, len(versRows))
			for _, r := range versRows {
				if r.BangumiVersion == 0 {
					toEnqueue = append(toEnqueue, r.AnilistID)
				}
			}
			if len(toEnqueue) > 0 {
				if eErr := w.enq.EnqueueV1Many(ctx, toEnqueue); eErr != nil {
					slog.WarnContext(ctx, "warm_season enqueue v1 failed",
						"season", season, "year", year,
						"count", len(toEnqueue), "err", eErr)
				} else {
					enqueued = len(toEnqueue)
				}
			}
		}
	}

	slog.InfoContext(ctx, "warm_season done",
		"season", season, "year", year,
		"pages", pages,
		"upserted", upsertOK,
		"upsertFailed", upsertFail,
		"enqueued", enqueued,
	)
	return nil
}

// CurrentSeason returns the season + year for the given moment.  Pure
// function (no time.Now() dependency) so tests can drive boundary cases
// without injection.
//
// Q1 (Jan-Mar) → WINTER, Q2 (Apr-Jun) → SPRING, Q3 (Jul-Sep) → SUMMER,
// Q4 (Oct-Dec) → FALL.  Matches Express anilist.service.js
// getCurrentSeasonInfo() (lines 173-179).
func CurrentSeason(t time.Time) (season string, year int) {
	month := int(t.Month())
	year = t.Year()
	switch {
	case month <= 3:
		return "WINTER", year
	case month <= 6:
		return "SPRING", year
	case month <= 9:
		return "SUMMER", year
	default:
		return "FALL", year
	}
}

// NextSeason returns the season+year that follows the given pair.
// FALL → WINTER rolls the year forward (Express setInterval logic);
// every other transition keeps the same year.  Unknown input is
// returned as-is (defensive — should never happen in production since
// CurrentSeason only emits the four canonical values).
func NextSeason(season string, year int) (string, int) {
	switch season {
	case "WINTER":
		return "SPRING", year
	case "SPRING":
		return "SUMMER", year
	case "SUMMER":
		return "FALL", year
	case "FALL":
		return "WINTER", year + 1
	}
	return season, year
}

// PeriodicWarmSeasonJob returns a river PeriodicJob that fires every
// 24h to re-enqueue WarmSeasonArgs for the current season.  Each fire
// re-computes the pair at constructor time, so year rollovers
// (FALL 2025 → WINTER 2026) handle themselves without restart.
//
// Pass the result to queue.Config.PeriodicJobs.  Boot-time initial
// runs are NOT covered by this — call Enqueuer.EnqueueWarmSeasonNow
// at boot for the initial current + next season pair.
//
// Schedule: 24h fixed interval (river.PeriodicInterval).  No cron
// alignment needed — warm cache freshness has hours of slack.
func PeriodicWarmSeasonJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(warmSeasonPeriodicInterval),
		func() (river.JobArgs, *river.InsertOpts) {
			cur, year := CurrentSeason(time.Now())
			return WarmSeasonArgs{Season: cur, Year: year}, nil
		},
		nil, // PeriodicJobOpts — defaults are fine; RunOnStart=false
		// because main.go handles the boot pair via EnqueueWarmSeasonNow.
	)
}
