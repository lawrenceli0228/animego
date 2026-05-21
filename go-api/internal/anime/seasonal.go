// Package anime — extends with /seasonal endpoint as a composable
// service.  Cache-first (warmed season) path stays identical to the
// pre-P2.1.4 handlers.go behaviour; cold-start path (CountSeasonal == 0)
// calls AniList Seasonal, upserts main rows via NormalizeMainRow, then
// re-reads from anime_cache so enriched fields (title_chinese,
// bangumi_*) flow into the response.
//
// Note: child tables (genres / studios / characters / staff / relations
// / recommendations) are NOT upserted here because /seasonal response
// shape only carries the main 16-column payload — same as the warmed-
// cache path.  The user's eventual /:anilistId detail request triggers
// the full child upsert via detail.go's refetch path.
//
// Express equivalent: server/services/anilist.service.js:238-330
// getSeasonalAnime + server/controllers/anime.controller.js:113-127
// getSeasonal.  The Bangumi enrichment trigger (Express
// enqueueEnrichment) is deferred — /seasonal returns 16 columns only,
// so the post-upsert re-read carries title_chinese already if prior
// enrichment ran; no need to dispatch from here.
package anime

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// seasonalDefaultPerPage is the default page size when the caller omits
// perPage.  Express anime.controller.js:113 reads `perPage = 20` from
// the destructured query object.
const seasonalDefaultPerPage = 20

// seasonalMaxPerPage caps the page size.  Express applies the cap via
// Math.min(perPage, 200) at anime.controller.js:117 — note this is 200,
// NOT 50 like /search.  /seasonal is paginated DB-side; AniList's own
// 50-per-page cap only applies on the cold-start fetch (see
// seasonalAniListMaxPerPage below).
const seasonalMaxPerPage = 200

// seasonalAniListMaxPerPage is AniList's hard cap on a single Seasonal
// page query — AniList docs limit perPage to 50.  Express explicitly
// applies Math.min(perPageNum, 50) before the queryAniList call.  Our
// DB-side cap (seasonalMaxPerPage = 200) and this AniList-side cap are
// independent: a caller asking for perPage=100 gets 100 DB rows on the
// warm path and a 50-row AniList fetch on the cold-start path.
const seasonalAniListMaxPerPage = 50

// seasonalRefetchTimeout bounds the cold-start AniList call.  Longer
// than queryTimeout (5s) because the AniList Seasonal call alone can
// take up to 10s under load (700ms throttle + HTTP); 15s gives us
// comfortable headroom for the upstream HTTP + the N upserts that
// follow.  Mirrors detail.go's refetchTimeout — same rationale.
const seasonalRefetchTimeout = 15 * time.Second

// AniListSeasonaler is the use-site interface SeasonalService consumes
// for the cold-start path.  *anilist.Client satisfies it.  Pass nil to
// NewSeasonalService to disable cold-start so the service degrades
// gracefully to warmed-cache-only behaviour (the pre-P2.1.4 shape).
type AniListSeasonaler interface {
	Seasonal(ctx context.Context, v anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error)
}

// SeasonalDB is the sqlc subset SeasonalService consumes — reader for
// the warm path + writer for the cold-start upsert + bulk read.
// dbgen.Querier satisfies it.  Defined here at the consumer per the
// "accept interfaces, return structs" rule.
type SeasonalDB interface {
	GetSeasonalAnime(ctx context.Context, season *string, seasonYear *int32, limit int32, offset int32) ([]dbgen.GetSeasonalAnimeRow, error)
	CountSeasonal(ctx context.Context, season *string, seasonYear *int32) (int64, error)
	UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error
}

// SeasonalService composes the sqlc reader + optional AniList client
// into one /api/anime/seasonal handler.  Built once at startup via
// NewSeasonalService and reused across requests.
//
// The anilist field is OPTIONAL — nil disables the cold-start path so
// the service degrades gracefully to warmed-cache-only behaviour.  This
// split exists so a misconfigured deployment without AniList credentials
// still serves cached rows correctly, and so tests can exercise the
// cache-only branch without a fake upstream.
type SeasonalService struct {
	db      SeasonalDB
	anilist AniListSeasonaler // nil disables cold-start
}

// NewSeasonalService builds a SeasonalService.  Pass nil for
// anilistClient to disable the AniList cold-start path — when the
// warmed-cache lookup returns zero rows, the response is empty data
// + zero total instead of an upstream fetch.  Pass a concrete
// *anilist.Client to enable cold-start.
func NewSeasonalService(db SeasonalDB, anilistClient AniListSeasonaler) *SeasonalService {
	return &SeasonalService{db: db, anilist: anilistClient}
}

// Handler returns the chi-compatible http.HandlerFunc for
// GET /api/anime/seasonal.
//
// Query parameters:
//
//	season   default WINTER, must be one of WINTER/SPRING/SUMMER/FALL
//	year     default <current>, range 1900..3000
//	page     default 1, min 1
//	perPage  default 20, max 200
//
// Response envelope:
//
//	{"data":[...], "pagination":{"page":1,"perPage":20,"total":N,"totalPages":M}}
//
// Cold-start (warmed-cache miss + AniList wired): fetches the page from
// AniList, upserts main rows into anime_cache, then re-reads via
// GetSeasonalAnime so enriched fields land in the response.  Total in
// pagination comes from the AniList PageInfo (NOT a fresh CountSeasonal
// — Express uses the AniList total directly in cold-start, see
// services/anilist.service.js:307-326).
func (s *SeasonalService) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		qs := req.URL.Query()

		// Season: default WINTER, must be one of the four canonical values.
		season := qs.Get("season")
		if season == "" {
			season = "WINTER"
		}
		if !validSeason(season) {
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				"invalid season",
			))
			return
		}

		// Year: default current, sanity range 1900..3000.  See parseYear.
		year := parseYear(qs.Get("year"))

		// Page: default 1, min 1.
		page := parseIntDefault(qs.Get("page"), 1)
		if page < 1 {
			page = 1
		}

		// PerPage: default 20, capped at 200 (Express's Math.min(perPage, 200)).
		perPage := parseIntDefault(qs.Get("perPage"), seasonalDefaultPerPage)
		if perPage < 1 {
			perPage = seasonalDefaultPerPage
		}
		if perPage > seasonalMaxPerPage {
			perPage = seasonalMaxPerPage
		}

		rows, total, err := s.fetchSeasonal(req.Context(), season, year, page, perPage)
		if err != nil {
			s.writeError(w, err)
			return
		}

		totalPages := 0
		if perPage > 0 {
			totalPages = int(math.Ceil(float64(total) / float64(perPage)))
		}

		// Ensure rows is never nil so an empty result serialises as [].
		if rows == nil {
			rows = []dbgen.GetSeasonalAnimeRow{}
		}

		writeSeasonalEnvelope(w, http.StatusOK, seasonalResponse{
			Data: rows,
			Pagination: seasonalPagination{
				Page:       page,
				PerPage:    perPage,
				Total:      total,
				TotalPages: totalPages,
			},
		})
	}
}

// fetchSeasonal is the inner data-flow method.  Cache-first; cold-start
// opt-in via s.anilist != nil and CountSeasonal == 0.  Returns DB rows
// + total count.  Errors flow back as *APIError so the handler maps
// them to the right status via writeError.
//
// Warm path (CountSeasonal > 0):
//   - errgroup parallel GetSeasonalAnime + CountSeasonal, 5s timeout
//   - DB errors → 500 SERVER_ERROR.
//
// Cold-start path (CountSeasonal == 0 AND s.anilist != nil):
//   - 15s child context for the AniList call + upserts (the 5s warm
//     timeout is too tight for a 700ms throttle + HTTP + N upserts).
//   - AniList Seasonal with perPage capped at 50 (AniList limit).
//   - Per-Media: NormalizeMainRow → UpsertAnimeCache.  Per-row errors
//     are logged at warn level and skipped — the response still proceeds
//     so the user sees partial data instead of a 500.
//   - Re-read via GetSeasonalAnime so any enriched (title_chinese,
//     bangumi_*) fields flow back.  Total comes from AniList PageInfo,
//     NOT a fresh CountSeasonal — Express semantics.
//   - AniList upstream errors → log warn and return empty (200, not 502).
//     Cold-start is an enhancement on the warm path; an unreachable
//     upstream shouldn't break the endpoint for users.
//
// Empty cold-start (s.anilist == nil AND total == 0): return empty data
// + zero total.  No 404 — Express returns 200 with empty data for an
// unwarmed season too.
func (s *SeasonalService) fetchSeasonal(
	parentCtx context.Context,
	season string,
	year, page, perPage int,
) ([]dbgen.GetSeasonalAnimeRow, int, error) {
	// Warm path uses the standard 5s query timeout — same budget every
	// other DB-only handler uses (see handlers.go const queryTimeout).
	warmCtx, warmCancel := context.WithTimeout(parentCtx, queryTimeout)
	defer warmCancel()

	offset := int32((page - 1) * perPage)
	limit := int32(perPage)
	yearI32 := int32(year)

	var (
		rows  []dbgen.GetSeasonalAnimeRow
		total int64
	)
	g, gctx := errgroup.WithContext(warmCtx)
	g.Go(func() error {
		var err error
		rows, err = s.db.GetSeasonalAnime(gctx, &season, &yearI32, limit, offset)
		return err
	})
	g.Go(func() error {
		var err error
		total, err = s.db.CountSeasonal(gctx, &season, &yearI32)
		return err
	})
	if err := g.Wait(); err != nil {
		return nil, 0, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
	}

	// Warm path hit — return the cached rows + count.
	if total > 0 {
		return rows, int(total), nil
	}

	// Cold-start path is opt-in; without an AniList client we just
	// return the empty result the DB gave us (matches Express when
	// AniList is unreachable AND nothing is cached).
	if s.anilist == nil {
		return rows, 0, nil
	}

	// Cold-start: fetch from AniList, upsert, re-read.  Uses a fresh
	// 15s context derived from the REQUEST context (not warmCtx, which
	// is about to be cancelled) so the cold-start path has its own
	// budget independent of the warm-path deadline.
	return s.coldStart(parentCtx, season, year, page, perPage)
}

// coldStart runs the AniList → upsert → re-read pipeline.  Called only
// when the warmed-cache miss (CountSeasonal returned 0) AND the AniList
// client is wired.  Returns the rows + total from the upsert+re-read
// flow.
//
// AniList errors are NOT fatal: log warn and return empty so the user
// gets a 200 with an empty array instead of a 502.  Express's cold-
// start branch (services/anilist.service.js:307-326) catches upstream
// errors at the controller layer and returns the same empty shape; we
// keep that observable behaviour byte-exact.
func (s *SeasonalService) coldStart(
	parentCtx context.Context,
	season string,
	year, page, perPage int,
) ([]dbgen.GetSeasonalAnimeRow, int, error) {
	ctx, cancel := context.WithTimeout(parentCtx, seasonalRefetchTimeout)
	defer cancel()

	// AniList caps perPage at 50.  Express applies Math.min(perPageNum, 50)
	// before the queryAniList call; keep that byte-exact.
	anilistPerPage := perPage
	if anilistPerPage > seasonalAniListMaxPerPage {
		anilistPerPage = seasonalAniListMaxPerPage
	}

	resp, err := s.anilist.Seasonal(ctx, anilist.SeasonalVars{
		Page:       page,
		PerPage:    anilistPerPage,
		Season:     season,
		SeasonYear: year,
	})
	if err != nil {
		// AniList upstream errors are soft-failures here: log warn and
		// return empty.  Differentiate ErrUpstream / ErrRateLimited /
		// other only in the log message so ops can grep on the cause
		// without exposing it in the response body.
		var upErr *anilist.ErrUpstream
		switch {
		case errors.As(err, &upErr):
			slog.WarnContext(ctx, "anime/seasonal: AniList upstream error, returning empty",
				"season", season, "year", year, "status", upErr.Status, "err", err)
		case errors.Is(err, anilist.ErrRateLimited):
			slog.WarnContext(ctx, "anime/seasonal: AniList rate limited, returning empty",
				"season", season, "year", year)
		default:
			slog.WarnContext(ctx, "anime/seasonal: AniList call failed, returning empty",
				"season", season, "year", year, "err", err)
		}
		return []dbgen.GetSeasonalAnimeRow{}, 0, nil
	}

	// Upsert each Media into anime_cache.  Per-row failures are logged
	// and skipped — failing the entire request on one bad row would
	// degrade UX worse than a partial result (the next /seasonal
	// request will retry the failed upsert via this same cold path
	// because no enriched rows exist yet).
	for _, m := range resp.Page.Media {
		args := NormalizeMainRow(m)
		if upErr := s.db.UpsertAnimeCache(ctx, args); upErr != nil {
			slog.WarnContext(ctx, "anime/seasonal: upsert failed",
				"anilist_id", args.AnilistID, "err", upErr)
		}
	}

	// Re-read via GetSeasonalAnime (same query, same params) so
	// enriched fields populated by prior Bangumi runs flow into the
	// response.  Avoids row-type juggling between
	// GetSeasonalAnimeRow and GetAnimeByAnilistIDsRow — both have the
	// same 16-column shape, but using the seasonal query keeps the
	// response struct field type identical between warm + cold paths.
	yearI32 := int32(year)
	offset := int32((page - 1) * perPage)
	limit := int32(perPage)
	rows, readErr := s.db.GetSeasonalAnime(ctx, &season, &yearI32, limit, offset)
	if readErr != nil {
		return nil, 0, httpx.WrapError(readErr, http.StatusInternalServerError, httpx.CodeServerError, "post-cold-start read failed")
	}
	if rows == nil {
		rows = []dbgen.GetSeasonalAnimeRow{}
	}

	// Total comes from AniList's PageInfo, NOT a fresh CountSeasonal.
	// Express semantics: services/anilist.service.js:316 returns
	// data.Page.pageInfo verbatim as the cold-start pagination.
	total := resp.Page.PageInfo.Total

	return rows, total, nil
}

// writeError maps fetchSeasonal errors to the appropriate httpx
// envelope.  *APIError flows through Fail unchanged; bare errors land
// as 500 SERVER_ERROR via WrapError so the cause is logged but not
// leaked to the client.
func (s *SeasonalService) writeError(w http.ResponseWriter, err error) {
	if apiErr, ok := httpx.IsAPIError(err); ok {
		httpx.Fail(w, apiErr)
		return
	}
	httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
}

// writeSeasonalEnvelope writes a {"data":[...], "pagination":{...}}
// envelope with HTML escaping off and no trailing newline.  Mirrors the
// writeMultiKeyEnvelope helper in handlers.go and the writeSearchEnvelope
// helper in search.go — duplicated here on purpose so /seasonal stays
// self-contained and a future refactor of one envelope helper doesn't
// accidentally break a peer endpoint's byte shape.
func writeSeasonalEnvelope(w http.ResponseWriter, status int, v seasonalResponse) {
	// Reuse writeMultiKeyEnvelope from handlers.go — same byte shape,
	// same charset, same HTML-escape-off behaviour.  Defined as a
	// named function here so a future migration off the shared helper
	// only touches this one call site.
	writeMultiKeyEnvelope(w, status, v)
}
