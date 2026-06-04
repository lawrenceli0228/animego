// Package anime — /:anilistId detail endpoint.
//
// Composition: 7-query DB assembly (main row + 6 child arrays) + relations
// enrichment lookup + 1-hour ristretto cache.  No AniList fetch in this
// milestone — the cache row is returned as-is when present, 404 when not.
// Stale detection + AniList re-fetch + Bangumi enrichment enqueue land in
// P2.1.6 once the worker substitution shape is settled.
//
// Express equivalent: server/controllers/detail.controller.js:5-30 +
// server/services/anilist.service.js:361-398 (cache-hit branch only).
//
// Wiring into chi lives in cmd/api/main.go (NOT touched here — main.go is
// owned by the wiring step that follows /detail landing).
package anime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/sync/errgroup"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// detailCacheTTL mirrors the Express DETAIL_CACHE_TTL of 1 hour.  Each
// /:anilistId response is cached under the integer ID stringified — same
// key shape Express used for AnimeCache.findOne(anilistId).
const detailCacheTTL = 1 * time.Hour

// staleCacheTTL is the cached_at age threshold that flips a DB-read row
// into "stale, re-fetch from AniList".  Set to 24h to match Express's
// original CACHE_TTL_MS.
//
// History: this was briefly 1h (to align with the ristretto window), but
// the /:anilistId endpoint is NOT low-volume — SEO crawlers (Bingbot,
// Ahrefs, Googlebot, ...) walk the full catalog, thousands of distinct
// pages per crawl.  At 1h, every crawled page older than an hour fired a
// synchronous, blocking AniList re-fetch; a full-catalog sweep produced
// thousands of live AniList calls, blew AniList's per-IP rate limit, and
// turned cold (not-yet-cached) anime into user-facing 502→500s.  24h cuts
// re-fetch frequency ~24x so a crawl mostly serves straight from the DB
// row without touching AniList at all.  Freshness loss is negligible:
// AniList metadata for an existing title rarely changes within a day, and
// the scheduled cache-warm worker refreshes hot titles independently.
const staleCacheTTL = 24 * time.Hour

// refetchTimeout bounds the AniList round-trip + upsert path.  Longer
// than queryTimeout (5s) because the AniList call alone can take up to
// 10s under load; 15s gives us comfortable headroom for the upstream
// HTTP + the ten DB writes that follow.
const refetchTimeout = 15 * time.Second

// AnimeDetail is the full /:anilistId response payload.
//
// Field order matches the prompt spec exactly: anilistId, titleRomaji,
// titleEnglish, titleNative, titleChinese, coverImageUrl, ... — Express's
// res.json({data: anime}) serialises the mongoose document in declaration
// order, and the AnimeCache.js schema lists fields in this order.  Encoding
// here is encoding/json + go struct declaration order, so the wire bytes
// land in the same sequence.
//
// All nullable cache columns use pointer types; empty slices serialise as
// `[]` (not `null`) because the service initialises them before encode.
type AnimeDetail struct {
	AnilistID                   int32                  `json:"anilistId"`
	TitleRomaji                 *string                `json:"titleRomaji"`
	TitleEnglish                *string                `json:"titleEnglish"`
	TitleNative                 *string                `json:"titleNative"`
	TitleChinese                *string                `json:"titleChinese"`
	CoverImageUrl               *string                `json:"coverImageUrl"`
	CoverImageColor             *string                `json:"coverImageColor"`
	PosterAccent                *string                `json:"posterAccent"`
	PosterAccentRgb             *string                `json:"posterAccentRgb"`
	PosterAccentContrastOnBlack *float64               `json:"posterAccentContrastOnBlack"`
	BannerImageUrl              *string                `json:"bannerImageUrl"`
	Description                 *string                `json:"description"`
	Episodes                    *int32                 `json:"episodes"`
	Status                      *string                `json:"status"`
	Season                      *string                `json:"season"`
	SeasonYear                  *int32                 `json:"seasonYear"`
	AverageScore                *float64               `json:"averageScore"`
	Format                      *string                `json:"format"`
	Duration                    *int32                 `json:"duration"`
	Source                      *string                `json:"source"`
	StartDate                   pgtype.Date            `json:"startDate"`
	Genres                      []string               `json:"genres"`
	Studios                     []string               `json:"studios"`
	Relations                   []DetailRelation       `json:"relations"`
	Characters                  []DetailCharacter      `json:"characters"`
	Staff                       []DetailStaff          `json:"staff"`
	Recommendations             []DetailRecommendation  `json:"recommendations"`
	EpisodeTitles               []DetailEpisodeTitle    `json:"episodeTitles"`
	BgmID                       *int32                 `json:"bgmId"`
	BangumiScore                *float64               `json:"bangumiScore"`
	BangumiVotes                *int32                 `json:"bangumiVotes"`
	BangumiVersion              int32                  `json:"bangumiVersion"`
	CachedAt                    pgtype.Timestamptz     `json:"cachedAt"`
}

// DetailRelation is one entry in AnimeDetail.Relations.  Enriched at
// assembly time: titleChinese + coverImageUrl backfilled from
// anime_cache lookup so a parent's relations carry the same display
// metadata the standalone /:anilistId rows would.
//
// Note: anime_relations table itself has NO title_chinese column, so the
// relation row's titleChinese is always nil; it is sourced entirely from
// the enrichment map.  coverImageUrl in anime_relations CAN be non-null
// (AniList's relation edges sometimes carry their own cover); we keep
// that value when present and only fall back to enrichment when nil.
type DetailRelation struct {
	AnilistID                   int32    `json:"anilistId"`
	RelationType                *string  `json:"relationType"`
	Title                       *string  `json:"title"`
	TitleChinese                *string  `json:"titleChinese"`
	CoverImageUrl               *string  `json:"coverImageUrl"`
	CoverImageColor             *string  `json:"coverImageColor"`
	PosterAccent                *string  `json:"posterAccent"`
	PosterAccentRgb             *string  `json:"posterAccentRgb"`
	PosterAccentContrastOnBlack *float64 `json:"posterAccentContrastOnBlack"`
	Format                      *string  `json:"format"`
}

// DetailCharacter mirrors the anime_characters table; nameCn /
// voiceActorImageUrl / voiceActorCn remain nil until Phase 4 enrichment
// runs.  Order matches the sqlc-generated GetAnimeCharactersByIDRow.
type DetailCharacter struct {
	NameEn             *string `json:"nameEn"`
	NameJa             *string `json:"nameJa"`
	NameCn             *string `json:"nameCn"`
	ImageUrl           *string `json:"imageUrl"`
	Role               *string `json:"role"`
	VoiceActorEn       *string `json:"voiceActorEn"`
	VoiceActorJa       *string `json:"voiceActorJa"`
	VoiceActorCn       *string `json:"voiceActorCn"`
	VoiceActorImageUrl *string `json:"voiceActorImageUrl"`
}

// DetailStaff mirrors the anime_staff table.  Order matches the
// sqlc-generated GetAnimeStaffByIDRow.
type DetailStaff struct {
	NameEn   *string `json:"nameEn"`
	NameJa   *string `json:"nameJa"`
	ImageUrl *string `json:"imageUrl"`
	Role     *string `json:"role"`
}

// DetailRecommendation mirrors the anime_recommendations table.  Order
// matches the sqlc-generated GetAnimeRecommendationsByIDRow.
type DetailRecommendation struct {
	AnilistID                   int32    `json:"anilistId"`
	Title                       *string  `json:"title"`
	CoverImageUrl               *string  `json:"coverImageUrl"`
	CoverImageColor             *string  `json:"coverImageColor"`
	PosterAccent                *string  `json:"posterAccent"`
	PosterAccentRgb             *string  `json:"posterAccentRgb"`
	PosterAccentContrastOnBlack *float64 `json:"posterAccentContrastOnBlack"`
	AverageScore                *float64 `json:"averageScore"`
}

// DetailEpisodeTitle mirrors the anime_episode_titles table.  Matches
// Express episodeTitles array shape: {episode, name, nameCn}.
type DetailEpisodeTitle struct {
	Episode int32   `json:"episode"`
	Name    *string `json:"name"`
	NameCn  *string `json:"nameCn"`
}

// DetailReader is the read-only slice of DetailDB.  Eight queries — one
// main row, six child arrays, plus the relations enrichment lookup.
type DetailReader interface {
	GetAnimeMainByID(ctx context.Context, anilistID int32) (dbgen.GetAnimeMainByIDRow, error)
	GetAnimeGenresByID(ctx context.Context, animeID int32) ([]string, error)
	GetAnimeStudiosByID(ctx context.Context, animeID int32) ([]string, error)
	GetAnimeRelationsByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeRelationsByIDRow, error)
	GetAnimeCharactersByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeCharactersByIDRow, error)
	GetAnimeStaffByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeStaffByIDRow, error)
	GetAnimeRecommendationsByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeRecommendationsByIDRow, error)
	GetAnimeEpisodeTitlesByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeEpisodeTitlesByIDRow, error)
	GetRelationEnrichmentByIDs(ctx context.Context, ids []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error)
}

// DetailWriter is the upsert slice of DetailDB.  Used only by the
// AniList re-fetch path: main row upsert + six child-table Delete+Insert
// pairs.  Defined as a separate interface so consumers that only need to
// READ (e.g. a hypothetical /api/anime/:anilistId/preview endpoint that
// never re-fetches) can depend on the narrower DetailReader alone.
type DetailWriter interface {
	UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error

	DeleteAnimeGenres(ctx context.Context, animeID int32) error
	InsertAnimeGenre(ctx context.Context, animeID int32, genre string) error

	DeleteAnimeStudios(ctx context.Context, animeID int32) error
	InsertAnimeStudio(ctx context.Context, animeID int32, studio string) error

	DeleteAnimeRelations(ctx context.Context, animeID int32) error
	InsertAnimeRelation(ctx context.Context, arg dbgen.InsertAnimeRelationParams) error

	DeleteAnimeCharacters(ctx context.Context, animeID int32) error
	InsertAnimeCharacter(ctx context.Context, arg dbgen.InsertAnimeCharacterParams) error

	DeleteAnimeStaff(ctx context.Context, animeID int32) error
	InsertAnimeStaffMember(ctx context.Context, arg dbgen.InsertAnimeStaffMemberParams) error

	DeleteAnimeRecommendations(ctx context.Context, animeID int32) error
	InsertAnimeRecommendation(ctx context.Context, arg dbgen.InsertAnimeRecommendationParams) error
}

// DetailDB is the merged reader+writer interface DetailService consumes.
// *dbgen.Queries satisfies this — and the test suite injects a fake
// implementation so the handler can run without Postgres.  Composing
// from DetailReader+DetailWriter keeps each surface independently
// testable without dragging in the full Querier (~30 methods).
type DetailDB interface {
	DetailReader
	DetailWriter
}

// AniListDetailer is the narrow slice of *anilist.Client used by the
// re-fetch path.  Defined at the consumer side so tests can substitute
// a canned response without spinning up an httptest server.  Pass nil
// to NewDetailService to disable the re-fetch path entirely (cache-only
// behaviour, matching the pre-P2.1.6 service shape).
type AniListDetailer interface {
	Detail(ctx context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error)
}

// DetailService composes the DB + ristretto cache + (optional) AniList
// client into one /:anilistId handler.  Built once at startup via
// NewDetailService and reused across requests.
//
// The anilist field is OPTIONAL — nil disables the re-fetch path so the
// service degrades gracefully to cache-only behaviour (the pre-P2.1.6
// shape).  This split exists so a misconfigured deployment without
// AniList credentials still serves cached rows correctly, and so tests
// can exercise the cache-only branch without a fake upstream.
type DetailService struct {
	db      DetailDB
	cache   *cache.Cache[*AnimeDetail]
	anilist AniListDetailer
}

// NewDetailService builds a DetailService with a 1-hour ristretto cache.
// Pass nil for anilistClient to disable the AniList re-fetch path —
// stale rows and cache-miss-on-unknown-ID then return as-is or 404
// respectively, matching the pre-P2.1.6 service.  Pass a concrete
// *anilist.Client to enable re-fetch.
//
// Returns an error only when ristretto rejects the configuration — in
// practice the zero Config{} with DefaultTTL set is always accepted.
// Callers should close the cache at shutdown via DetailService.Close to
// release ristretto's background goroutines.
func NewDetailService(db DetailDB, anilistClient AniListDetailer) (*DetailService, error) {
	c, err := cache.New[*AnimeDetail](cache.Config{DefaultTTL: detailCacheTTL})
	if err != nil {
		return nil, fmt.Errorf("anime/detail: build cache: %w", err)
	}
	return &DetailService{db: db, cache: c, anilist: anilistClient}, nil
}

// Close releases the underlying ristretto cache.  Safe to call multiple
// times — ristretto's Close is idempotent and the wrapper is too.
func (s *DetailService) Close() {
	if s.cache != nil {
		s.cache.Close()
	}
}

// Handler returns the chi-compatible http.HandlerFunc for
// GET /api/anime/:anilistId.
//
// Path parameter:
//
//	anilistId  must parse as a positive int; on parse fail or non-positive
//	           returns 400 VALIDATION_ERROR with the Chinese message
//	           "无效的番剧 ID".
//
// Response envelope:
//
//	{"data":{...anime detail fields with enriched relations...}}
//
// On cache miss the row is read from anime_cache + child tables; if the
// main row is missing the handler returns 404 NOT_FOUND with the Chinese
// message "番剧不存在".  Stale detection + AniList re-fetch are deferred
// to P2.1.6 — see the TODO inside fetchDetail.
func (s *DetailService) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		raw := chi.URLParam(req, "anilistId")
		id, err := strconv.Atoi(raw)
		if err != nil || id <= 0 {
			// Express: if (isNaN(anilistId)) return 400 with the
			// Chinese message.  We additionally reject zero/negative
			// because Postgres anilist_id is a positive int.
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				"无效的番剧 ID",
			))
			return
		}

		detail, err := s.fetchDetail(ctx, int32(id))
		if err != nil {
			s.writeError(w, err)
			return
		}

		httpx.Data(w, http.StatusOK, detail)
	}
}

// fetchDetail is the inner data-flow method: cache → DB main → 6 child
// arrays in parallel → relations enrichment → optional AniList re-fetch
// when stale → cache → return.  Separated from Handler so the HTTP
// envelope owns input parsing while fetchDetail owns the orchestration.
//
// On cache hit the cached *AnimeDetail is returned without touching the
// DB — the stale check runs ONLY on cache miss, not cache hit, to keep
// hot-path latency sub-millisecond.  Ristretto's 1h TTL is already the
// authoritative freshness signal for that path.
//
// On cache miss the main row is read first (because pgx.ErrNoRows must
// map to either 404 or a re-fetch before any child queries run — those
// would return empty slices and mask the missing parent).
//
//   - pgx.ErrNoRows + anilist client wired  → re-fetch from AniList
//   - pgx.ErrNoRows + anilist nil           → 404 NOT_FOUND
//   - main row present                       → read 6 child arrays in
//     parallel, then check isStale; if stale and anilist wired, re-fetch
//     and return the post-write read.  If re-fetch fails, the in-flight
//     stale rows still get returned so the client sees data over no data.
func (s *DetailService) fetchDetail(ctx context.Context, anilistID int32) (*AnimeDetail, error) {
	key := strconv.FormatInt(int64(anilistID), 10)
	if hit, ok := s.cache.Get(key); ok && hit != nil {
		return hit, nil
	}

	main, err := s.db.GetAnimeMainByID(ctx, anilistID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Not cached — try the AniList re-fetch path if wired.
			// Without the client, return the stable 404 signal so
			// frontend clients can present a clean missing-page state.
			if s.anilist != nil {
				return s.refetchFromAniList(ctx, anilistID)
			}
			return nil, httpx.NewError(
				http.StatusNotFound,
				httpx.CodeNotFound,
				"番剧不存在",
			)
		}
		return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
	}

	// Six independent child reads run in parallel.
	genres, studios, relations, characters, staffRows, recommendations, episodeTitles, err := s.fetchChildren(ctx, anilistID)
	if err != nil {
		return nil, err
	}

	// Stale check — runs only on cache miss.  When stale and the
	// AniList client is wired, re-fetch + upsert + re-read.  If the
	// re-fetch fails (upstream 502, rate limit, network), fall through
	// to return the stale rows so the client sees data over an error.
	if s.anilist != nil && isStale(main, studios, characters, relations) {
		slog.InfoContext(ctx, "anime/detail: stale, re-fetching from AniList", "anilistId", anilistID)
		if det, refetchErr := s.refetchFromAniList(ctx, anilistID); refetchErr == nil {
			return det, nil
		} else {
			slog.WarnContext(ctx, "anime/detail: AniList re-fetch failed, returning stale", "anilistId", anilistID, "err", refetchErr)
			// Graceful degradation: serve the stale rows we ALREADY read.
			// Do NOT touch the DB again on `ctx` here — a failed re-fetch can
			// leave the request context deadline-exhausted, so enrichRelations
			// (or any query) on it fails with "context deadline exceeded" and
			// 500s the page. That dead-context query was the cause of the
			// Internal Server Errors during AniList upstream slowness.
			//
			// Relation titleChinese/cover backfill is a best-effort nicety;
			// skip it via the no-DB converter rather than 500. Cache the stale
			// result so a herd of stale requests during an AniList outage
			// doesn't each repeat the (blocking, ~5s) re-fetch attempt and
			// pile up on the worker pool.
			stale := assembleDetail(
				main, genres, studios,
				convertRelationsToDetailRelations(relations),
				characters, staffRows, recommendations, episodeTitles,
			)
			s.cache.Set(key, stale)
			return stale, nil
		}
	}

	// Relations enrichment — backfill titleChinese + coverImageUrl from
	// anime_cache so the parent's relations[] carries the same display
	// metadata a standalone /:relationId fetch would.  Skipped entirely
	// when relations is empty (the IN(...) query is cheap but skipping
	// keeps the cache-miss path mechanical).
	enrichedRelations, err := s.enrichRelations(ctx, relations)
	if err != nil {
		return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
	}

	detail := assembleDetail(main, genres, studios, enrichedRelations, characters, staffRows, recommendations, episodeTitles)

	// Populate cache.  Set is best-effort — ristretto may reject under
	// contention but the next request will re-read from DB without
	// failing the current response.
	if ok := s.cache.Set(key, detail); !ok {
		slog.Debug("anime/detail: cache set rejected", "anilistId", anilistID)
	}

	return detail, nil
}

// fetchChildren reads the six child arrays in parallel via errgroup.
// Extracted from fetchDetail so the re-fetch path can reuse the same
// orchestration without duplicating the goroutine wiring.  Returned in
// the same order as assembleDetail consumes them.
//
// Errors flow back wrapped as a 500 APIError so callers can return them
// straight to the writeError mapper.
func (s *DetailService) fetchChildren(ctx context.Context, anilistID int32) (
	genres []string,
	studios []string,
	relations []dbgen.GetAnimeRelationsByIDRow,
	characters []dbgen.GetAnimeCharactersByIDRow,
	staffRows []dbgen.GetAnimeStaffByIDRow,
	recommendations []dbgen.GetAnimeRecommendationsByIDRow,
	episodeTitles []dbgen.GetAnimeEpisodeTitlesByIDRow,
	err error,
) {
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		var e error
		genres, e = s.db.GetAnimeGenresByID(gctx, anilistID)
		return e
	})
	g.Go(func() error {
		var e error
		studios, e = s.db.GetAnimeStudiosByID(gctx, anilistID)
		return e
	})
	g.Go(func() error {
		var e error
		relations, e = s.db.GetAnimeRelationsByID(gctx, anilistID)
		return e
	})
	g.Go(func() error {
		var e error
		characters, e = s.db.GetAnimeCharactersByID(gctx, anilistID)
		return e
	})
	g.Go(func() error {
		var e error
		staffRows, e = s.db.GetAnimeStaffByID(gctx, anilistID)
		return e
	})
	g.Go(func() error {
		var e error
		recommendations, e = s.db.GetAnimeRecommendationsByID(gctx, anilistID)
		return e
	})
	g.Go(func() error {
		var e error
		episodeTitles, e = s.db.GetAnimeEpisodeTitlesByID(gctx, anilistID)
		return e
	})
	if waitErr := g.Wait(); waitErr != nil {
		err = httpx.WrapError(waitErr, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
		return
	}
	return
}

// isStale returns true when the cached main row + child arrays signal
// the AniList row has gone stale.  Matches Express anilist.service.js
// lines 365-370:
//
//	- cached_at older than staleCacheTTL  (24h in Express, 1h here — see
//	                                       const docstring above)
//	- Studios array empty (Mongo "undefined" → Postgres "no rows")
//	- Characters array empty
//	- First character row has nil role
//	- First relation row has nil cover_image_url
//
// All five conditions are independent — any one trips the re-fetch.
// The order is cheapest-first: cached_at age is a single time.Since,
// the slice-length checks are O(1), and the field-presence probes only
// touch the first element each.
func isStale(
	main dbgen.GetAnimeMainByIDRow,
	studios []string,
	characters []dbgen.GetAnimeCharactersByIDRow,
	relations []dbgen.GetAnimeRelationsByIDRow,
) bool {
	if main.CachedAt.Valid && time.Since(main.CachedAt.Time) >= staleCacheTTL {
		return true
	}
	if len(studios) == 0 {
		return true
	}
	if len(characters) == 0 {
		return true
	}
	if characters[0].Role == nil {
		return true
	}
	if len(relations) > 0 && relations[0].CoverImageUrl == nil {
		return true
	}
	return false
}

// refetchFromAniList runs the full AniList Detail → normalize → upsert
// (main + 6 child tables) → re-read pipeline.  Used by two callers:
// (a) pgx.ErrNoRows on initial DB read (truly missing record), and
// (b) stale-flag fired after cache miss.
//
// The upsert path is intentionally non-transactional for P2.1.6 — the
// DetailDB surface is just sqlc's Querier so wrapping in pgx.Tx would
// require threading a pool reference through DetailService.  The
// observable failure mode is "partial child rows on next read", and the
// stale-detection sweep on the very next request re-runs this whole
// pipeline, so consistency converges within one extra round-trip.
//
// Uses a per-call context with refetchTimeout (15s) so a slow upstream
// doesn't hold the request-level context (5s queryTimeout) hostage — the
// request would have failed long before the upsert completed otherwise.
func (s *DetailService) refetchFromAniList(parentCtx context.Context, anilistID int32) (*AnimeDetail, error) {
	ctx, cancel := context.WithTimeout(parentCtx, refetchTimeout)
	defer cancel()

	resp, err := s.anilist.Detail(ctx, anilist.DetailVars{ID: int(anilistID)})
	if err != nil {
		// Differentiate upstream errors from "AniList says this ID
		// doesn't exist".  Express maps both to 404 with the same
		// Chinese message; preserve that behaviour for the missing-ID
		// path (ErrUpstream{Status: 404}) and surface other failures as
		// 502 BAD_GATEWAY so observability can distinguish.
		var upErr *anilist.ErrUpstream
		if errors.As(err, &upErr) && upErr.Status == http.StatusNotFound {
			return nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "番剧不存在")
		}
		return nil, httpx.WrapError(err, http.StatusBadGateway, httpx.CodeServerError, "AniList upstream error")
	}
	// resp.Media.ID == 0 means AniList responded with `Media: null`
	// which the anilist client surfaces as a populated zero-value
	// Media struct.  Treat as 404 to match Express's "番剧不存在".
	if resp == nil || resp.Media.ID == 0 {
		return nil, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "番剧不存在")
	}

	media := resp.Media
	if err := s.upsertFromMedia(ctx, anilistID, media); err != nil {
		return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "upsert failed")
	}

	// Bust the in-process cache so a concurrent reader doesn't return
	// the pre-refetch (stale) entry.  Then re-read from DB to pick up
	// any enrichment columns (title_chinese, bgm_*) that the upsert did
	// NOT overwrite on conflict.
	s.cache.Delete(strconv.FormatInt(int64(anilistID), 10))

	main, err := s.db.GetAnimeMainByID(ctx, anilistID)
	if err != nil {
		// Should never happen — we just wrote this row.  Surface as
		// 500 so the failure is visible in logs.
		return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "post-refetch read failed")
	}
	genres, studios, relations, characters, staffRows, recommendations, episodeTitles, err := s.fetchChildren(ctx, anilistID)
	if err != nil {
		return nil, err
	}
	enrichedRelations, enrichErr := s.enrichRelations(ctx, relations)
	if enrichErr != nil {
		// Soft-fail: log but proceed with un-enriched relations so the
		// re-fetched data still lands in front of the user.
		slog.WarnContext(ctx, "anime/detail: post-refetch enrichment failed", "anilistId", anilistID, "err", enrichErr)
		enrichedRelations = convertRelationsToDetailRelations(relations)
	}

	detail := assembleDetail(main, genres, studios, enrichedRelations, characters, staffRows, recommendations, episodeTitles)
	if ok := s.cache.Set(strconv.FormatInt(int64(anilistID), 10), detail); !ok {
		slog.Debug("anime/detail: cache set rejected post-refetch", "anilistId", anilistID)
	}
	return detail, nil
}

// upsertFromMedia writes one Media into anime_cache + the six child
// tables.  Sequential, non-transactional — the trade-off documented in
// refetchFromAniList's docstring.  Each child table follows the
// Delete+Insert pattern (anime_cache main row uses ON CONFLICT instead).
//
// Errors from any step short-circuit the rest; subsequent calls will
// observe the partial state via isStale and re-fetch.  This is the same
// failure tolerance Express had — its mongoose findOneAndUpdate could
// also leave the document partially written on connection drops.
func (s *DetailService) upsertFromMedia(ctx context.Context, anilistID int32, m anilist.Media) error {
	// 1) Main row — ON CONFLICT preserves Bangumi columns.
	if err := s.db.UpsertAnimeCache(ctx, NormalizeMainRow(m)); err != nil {
		return fmt.Errorf("upsert main: %w", err)
	}

	// 2) Genres — Delete + Insert.  Plain string column, no accent
	// fields, no display order.
	if err := s.db.DeleteAnimeGenres(ctx, anilistID); err != nil {
		return fmt.Errorf("delete genres: %w", err)
	}
	for _, g := range Genres(m) {
		if err := s.db.InsertAnimeGenre(ctx, anilistID, g); err != nil {
			return fmt.Errorf("insert genre %q: %w", g, err)
		}
	}

	// 3) Studios — Delete + Insert.
	if err := s.db.DeleteAnimeStudios(ctx, anilistID); err != nil {
		return fmt.Errorf("delete studios: %w", err)
	}
	for _, st := range StudiosFromMedia(m) {
		if err := s.db.InsertAnimeStudio(ctx, anilistID, st); err != nil {
			return fmt.Errorf("insert studio %q: %w", st, err)
		}
	}

	// 4) Relations — Delete + Insert.  Each row carries accent fields
	// computed from the relation's cover colour.
	if err := s.db.DeleteAnimeRelations(ctx, anilistID); err != nil {
		return fmt.Errorf("delete relations: %w", err)
	}
	for _, r := range RelationsFromMedia(m) {
		if err := s.db.InsertAnimeRelation(ctx, dbgen.InsertAnimeRelationParams{
			AnimeID:                     anilistID,
			AnilistID:                   r.AnilistID,
			RelationType:                r.RelationType,
			Title:                       r.Title,
			CoverImageUrl:               r.CoverImageUrl,
			CoverImageColor:             r.CoverImageColor,
			PosterAccent:                r.PosterAccent,
			PosterAccentRgb:             r.PosterAccentRgb,
			PosterAccentContrastOnBlack: r.PosterAccentContrastOnBlack,
			Format:                      r.Format,
		}); err != nil {
			return fmt.Errorf("insert relation %d: %w", r.AnilistID, err)
		}
	}

	// 5) Characters — Delete + Insert.  display_order is the slice
	// index (set inside CharactersFromMedia).
	if err := s.db.DeleteAnimeCharacters(ctx, anilistID); err != nil {
		return fmt.Errorf("delete characters: %w", err)
	}
	for _, c := range CharactersFromMedia(m) {
		if err := s.db.InsertAnimeCharacter(ctx, dbgen.InsertAnimeCharacterParams{
			AnimeID:            anilistID,
			DisplayOrder:       c.DisplayOrder,
			NameEn:             c.NameEn,
			NameJa:             c.NameJa,
			NameCn:             c.NameCn,
			ImageUrl:           c.ImageUrl,
			Role:               c.Role,
			VoiceActorEn:       c.VoiceActorEn,
			VoiceActorJa:       c.VoiceActorJa,
			VoiceActorImageUrl: c.VoiceActorImageUrl,
		}); err != nil {
			return fmt.Errorf("insert character %d: %w", c.DisplayOrder, err)
		}
	}

	// 6) Staff — Delete + Insert.
	if err := s.db.DeleteAnimeStaff(ctx, anilistID); err != nil {
		return fmt.Errorf("delete staff: %w", err)
	}
	for _, st := range StaffFromMedia(m) {
		if err := s.db.InsertAnimeStaffMember(ctx, dbgen.InsertAnimeStaffMemberParams{
			AnimeID:      anilistID,
			DisplayOrder: st.DisplayOrder,
			NameEn:       st.NameEn,
			NameJa:       st.NameJa,
			ImageUrl:     st.ImageUrl,
			Role:         st.Role,
		}); err != nil {
			return fmt.Errorf("insert staff %d: %w", st.DisplayOrder, err)
		}
	}

	// 7) Recommendations — Delete + Insert.  Express filtered nil
	// mediaRecommendation entries at normalize time, so the slice here
	// is already clean.
	if err := s.db.DeleteAnimeRecommendations(ctx, anilistID); err != nil {
		return fmt.Errorf("delete recommendations: %w", err)
	}
	for _, r := range RecommendationsFromMedia(m) {
		if err := s.db.InsertAnimeRecommendation(ctx, dbgen.InsertAnimeRecommendationParams{
			AnimeID:                     anilistID,
			AnilistID:                   r.AnilistID,
			Title:                       r.Title,
			CoverImageUrl:               r.CoverImageUrl,
			CoverImageColor:             r.CoverImageColor,
			PosterAccent:                r.PosterAccent,
			PosterAccentRgb:             r.PosterAccentRgb,
			PosterAccentContrastOnBlack: r.PosterAccentContrastOnBlack,
			AverageScore:                r.AverageScore,
		}); err != nil {
			return fmt.Errorf("insert recommendation %d: %w", r.AnilistID, err)
		}
	}

	return nil
}

// convertRelationsToDetailRelations is the fallback path when the
// relations enrichment query fails post-refetch.  Returns DetailRelation
// values without the titleChinese / coverImageUrl backfill so the client
// still sees the relation rows, just without the cross-table enrichment.
func convertRelationsToDetailRelations(rels []dbgen.GetAnimeRelationsByIDRow) []DetailRelation {
	if len(rels) == 0 {
		return []DetailRelation{}
	}
	out := make([]DetailRelation, 0, len(rels))
	for _, r := range rels {
		out = append(out, DetailRelation{
			AnilistID:                   r.AnilistID,
			RelationType:                r.RelationType,
			Title:                       r.Title,
			CoverImageUrl:               r.CoverImageUrl,
			CoverImageColor:             r.CoverImageColor,
			PosterAccent:                r.PosterAccent,
			PosterAccentRgb:             r.PosterAccentRgb,
			PosterAccentContrastOnBlack: r.PosterAccentContrastOnBlack,
			Format:                      r.Format,
		})
	}
	return out
}

// enrichRelations backfills titleChinese + coverImageUrl on each
// DetailRelation from the anime_cache table.  Express semantics
// (controllers/detail.controller.js:14-28):
//
//	titleChinese  = cached.titleChinese ?? relation.titleChinese ?? null
//	coverImageUrl = relation.coverImageUrl || cached.coverImageUrl || null
//
// Since the anime_relations table has NO title_chinese column, the
// "relation.titleChinese" branch in Express is always nil for us — the
// simplification is: titleChinese = enrichMap[id].titleChinese (or nil).
// coverImageUrl preserves the relation row's value when present (truthy
// in Express terms = non-empty string), otherwise falls back to the
// enrichment map.
func (s *DetailService) enrichRelations(ctx context.Context, rels []dbgen.GetAnimeRelationsByIDRow) ([]DetailRelation, error) {
	if len(rels) == 0 {
		return []DetailRelation{}, nil
	}

	ids := make([]int32, 0, len(rels))
	for _, r := range rels {
		ids = append(ids, r.AnilistID)
	}

	enriched, err := s.db.GetRelationEnrichmentByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	enrichMap := make(map[int32]dbgen.GetRelationEnrichmentByIDsRow, len(enriched))
	for _, e := range enriched {
		enrichMap[e.AnilistID] = e
	}

	out := make([]DetailRelation, 0, len(rels))
	for _, r := range rels {
		cached, ok := enrichMap[r.AnilistID]

		// coverImageUrl: keep the relation row's value when non-nil;
		// otherwise fall back to the enriched value.  Mirrors
		// `r.coverImageUrl || c?.coverImageUrl || null`.
		cover := r.CoverImageUrl
		if cover == nil && ok {
			cover = cached.CoverImageUrl
		}

		// titleChinese: relation table has no title_chinese column,
		// so the Express ?? chain simplifies to the enrichment value
		// (or nil when no enrichment row exists).
		var titleCn *string
		if ok {
			titleCn = cached.TitleChinese
		}

		out = append(out, DetailRelation{
			AnilistID:                   r.AnilistID,
			RelationType:                r.RelationType,
			Title:                       r.Title,
			TitleChinese:                titleCn,
			CoverImageUrl:               cover,
			CoverImageColor:             r.CoverImageColor,
			PosterAccent:                r.PosterAccent,
			PosterAccentRgb:             r.PosterAccentRgb,
			PosterAccentContrastOnBlack: r.PosterAccentContrastOnBlack,
			Format:                      r.Format,
		})
	}

	return out, nil
}

// assembleDetail copies main-row fields and the child arrays into an
// AnimeDetail value.  Empty slices stay as `[]T{}` (initialised by the
// dbgen layer's "items := []T{}" preamble), so the JSON serialises as
// `[]` rather than `null`.
//
// Pure function — no receiver — so handler tests can verify the
// shape-only assembly without spinning up a DetailService.
func assembleDetail(
	main dbgen.GetAnimeMainByIDRow,
	genres []string,
	studios []string,
	relations []DetailRelation,
	characters []dbgen.GetAnimeCharactersByIDRow,
	staffRows []dbgen.GetAnimeStaffByIDRow,
	recommendations []dbgen.GetAnimeRecommendationsByIDRow,
	episodeTitlesRows []dbgen.GetAnimeEpisodeTitlesByIDRow,
) *AnimeDetail {
	if genres == nil {
		genres = []string{}
	}
	if studios == nil {
		studios = []string{}
	}
	if relations == nil {
		relations = []DetailRelation{}
	}

	chars := make([]DetailCharacter, 0, len(characters))
	for _, c := range characters {
		chars = append(chars, DetailCharacter{
			NameEn:             c.NameEn,
			NameJa:             c.NameJa,
			NameCn:             c.NameCn,
			ImageUrl:           c.ImageUrl,
			Role:               c.Role,
			VoiceActorEn:       c.VoiceActorEn,
			VoiceActorJa:       c.VoiceActorJa,
			VoiceActorCn:       c.VoiceActorCn,
			VoiceActorImageUrl: c.VoiceActorImageUrl,
		})
	}

	staff := make([]DetailStaff, 0, len(staffRows))
	for _, st := range staffRows {
		staff = append(staff, DetailStaff{
			NameEn:   st.NameEn,
			NameJa:   st.NameJa,
			ImageUrl: st.ImageUrl,
			Role:     st.Role,
		})
	}

	recs := make([]DetailRecommendation, 0, len(recommendations))
	for _, r := range recommendations {
		recs = append(recs, DetailRecommendation{
			AnilistID:                   r.AnilistID,
			Title:                       r.Title,
			CoverImageUrl:               r.CoverImageUrl,
			CoverImageColor:             r.CoverImageColor,
			PosterAccent:                r.PosterAccent,
			PosterAccentRgb:             r.PosterAccentRgb,
			PosterAccentContrastOnBlack: r.PosterAccentContrastOnBlack,
			AverageScore:                r.AverageScore,
		})
	}

	epTitles := make([]DetailEpisodeTitle, 0, len(episodeTitlesRows))
	for _, t := range episodeTitlesRows {
		epTitles = append(epTitles, DetailEpisodeTitle{
			Episode: t.Episode,
			Name:    t.Name,
			NameCn:  t.NameCn,
		})
	}

	return &AnimeDetail{
		AnilistID:                   main.AnilistID,
		TitleRomaji:                 main.TitleRomaji,
		TitleEnglish:                main.TitleEnglish,
		TitleNative:                 main.TitleNative,
		TitleChinese:                main.TitleChinese,
		CoverImageUrl:               main.CoverImageUrl,
		CoverImageColor:             main.CoverImageColor,
		PosterAccent:                main.PosterAccent,
		PosterAccentRgb:             main.PosterAccentRgb,
		PosterAccentContrastOnBlack: main.PosterAccentContrastOnBlack,
		BannerImageUrl:              main.BannerImageUrl,
		Description:                 main.Description,
		Episodes:                    main.Episodes,
		Status:                      main.Status,
		Season:                      main.Season,
		SeasonYear:                  main.SeasonYear,
		AverageScore:                main.AverageScore,
		Format:                      main.Format,
		Duration:                    main.Duration,
		Source:                      main.Source,
		StartDate:                   main.StartDate,
		Genres:                      genres,
		Studios:                     studios,
		Relations:                   relations,
		Characters:                  chars,
		Staff:                       staff,
		Recommendations:             recs,
		EpisodeTitles:               epTitles,
		BgmID:                       main.BgmID,
		BangumiScore:                main.BangumiScore,
		BangumiVotes:                main.BangumiVotes,
		BangumiVersion:              main.BangumiVersion,
		CachedAt:                    main.CachedAt,
	}
}

// writeError maps internal fetchDetail errors to the appropriate httpx
// envelope.  *APIError flows through Fail unchanged; bare errors land
// as 500 SERVER_ERROR via WrapError so the cause is logged but not
// leaked to the client.
func (s *DetailService) writeError(w http.ResponseWriter, err error) {
	if apiErr, ok := httpx.IsAPIError(err); ok {
		httpx.Fail(w, apiErr)
		return
	}
	httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
}
