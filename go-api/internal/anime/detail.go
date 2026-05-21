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

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// detailCacheTTL mirrors the Express DETAIL_CACHE_TTL of 1 hour.  Each
// /:anilistId response is cached under the integer ID stringified — same
// key shape Express used for AnimeCache.findOne(anilistId).
const detailCacheTTL = 1 * time.Hour

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
	Recommendations             []DetailRecommendation `json:"recommendations"`
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

// DetailDB is the narrow interface DetailService consumes.  Defined at
// the consumer (anime package) per "accept interfaces, return structs".
// *dbgen.Queries satisfies this — and the test suite injects a fake
// implementation so the handler can run without Postgres.
type DetailDB interface {
	GetAnimeMainByID(ctx context.Context, anilistID int32) (dbgen.GetAnimeMainByIDRow, error)
	GetAnimeGenresByID(ctx context.Context, animeID int32) ([]string, error)
	GetAnimeStudiosByID(ctx context.Context, animeID int32) ([]string, error)
	GetAnimeRelationsByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeRelationsByIDRow, error)
	GetAnimeCharactersByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeCharactersByIDRow, error)
	GetAnimeStaffByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeStaffByIDRow, error)
	GetAnimeRecommendationsByID(ctx context.Context, animeID int32) ([]dbgen.GetAnimeRecommendationsByIDRow, error)
	GetRelationEnrichmentByIDs(ctx context.Context, ids []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error)
}

// DetailService composes the DB + ristretto cache into one /:anilistId
// handler.  Built once at startup via NewDetailService and reused across
// requests — the cache lives on the service so requests within the
// 1-hour window short-circuit before reaching Postgres.
type DetailService struct {
	db    DetailDB
	cache *cache.Cache[*AnimeDetail]
}

// NewDetailService builds a DetailService with a 1-hour ristretto cache.
// Returns an error only when ristretto rejects the configuration — in
// practice the zero Config{} with DefaultTTL set is always accepted.
// Callers should close the cache at shutdown via DetailService.Close to
// release ristretto's background goroutines.
func NewDetailService(db DetailDB) (*DetailService, error) {
	c, err := cache.New[*AnimeDetail](cache.Config{DefaultTTL: detailCacheTTL})
	if err != nil {
		return nil, fmt.Errorf("anime/detail: build cache: %w", err)
	}
	return &DetailService{db: db, cache: c}, nil
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
// arrays in parallel → relations enrichment → cache → return.  Separated
// from Handler so the HTTP envelope owns input parsing while fetchDetail
// owns the DB orchestration.
//
// On cache hit the cached *AnimeDetail is returned without touching the
// DB.  On cache miss the main row is read first (because pgx.ErrNoRows
// must map to 404 before any child queries run — those would return
// empty slices and mask the missing parent).  Child arrays + the
// relations enrichment lookup then run in parallel via errgroup.
//
// TODO P2.1.6: stale detection + AniList re-fetch + Bangumi enrichment enqueue
func (s *DetailService) fetchDetail(ctx context.Context, anilistID int32) (*AnimeDetail, error) {
	key := strconv.FormatInt(int64(anilistID), 10)
	if hit, ok := s.cache.Get(key); ok && hit != nil {
		return hit, nil
	}

	main, err := s.db.GetAnimeMainByID(ctx, anilistID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Express's getAnimeDetail re-fetches from AniList here;
			// we defer that to P2.1.6 and return 404 in the interim
			// so frontend clients see a stable "not in cache" signal.
			return nil, httpx.NewError(
				http.StatusNotFound,
				httpx.CodeNotFound,
				"番剧不存在",
			)
		}
		return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
	}

	// Six independent child reads run in parallel.  errgroup propagates
	// the first error and cancels the rest via gctx — any failure here
	// fails the whole detail with 500.
	var (
		genres          []string
		studios         []string
		relations       []dbgen.GetAnimeRelationsByIDRow
		characters      []dbgen.GetAnimeCharactersByIDRow
		staffRows       []dbgen.GetAnimeStaffByIDRow
		recommendations []dbgen.GetAnimeRecommendationsByIDRow
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		var err error
		genres, err = s.db.GetAnimeGenresByID(gctx, anilistID)
		return err
	})
	g.Go(func() error {
		var err error
		studios, err = s.db.GetAnimeStudiosByID(gctx, anilistID)
		return err
	})
	g.Go(func() error {
		var err error
		relations, err = s.db.GetAnimeRelationsByID(gctx, anilistID)
		return err
	})
	g.Go(func() error {
		var err error
		characters, err = s.db.GetAnimeCharactersByID(gctx, anilistID)
		return err
	})
	g.Go(func() error {
		var err error
		staffRows, err = s.db.GetAnimeStaffByID(gctx, anilistID)
		return err
	})
	g.Go(func() error {
		var err error
		recommendations, err = s.db.GetAnimeRecommendationsByID(gctx, anilistID)
		return err
	})
	if err := g.Wait(); err != nil {
		return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
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

	detail := assembleDetail(main, genres, studios, enrichedRelations, characters, staffRows, recommendations)

	// Populate cache.  Set is best-effort — ristretto may reject under
	// contention but the next request will re-read from DB without
	// failing the current response.
	if ok := s.cache.Set(key, detail); !ok {
		slog.Debug("anime/detail: cache set rejected", "anilistId", anilistID)
	}

	return detail, nil
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
