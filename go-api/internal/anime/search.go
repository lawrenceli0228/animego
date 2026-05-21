// Package anime — /search endpoint wiring.
//
// Composition: AniList GraphQL search + 10-minute in-memory cache
// (ristretto) + anime_cache upsert + DB re-read so enriched columns
// (title_chinese, bangumi_score, etc.) flow back into the response
// even though the AniList payload doesn't carry them.
//
// Express equivalent: server/controllers/anime.controller.js:130-147 +
// server/services/anilist.service.js:333-358.  The Bangumi enrichment
// trigger (Express `enqueueEnrichment`) is deferred to P2.1.5 — the
// queue workers are still stubs in this milestone, so search.go skips
// the enqueue step and leaves a TODO marker above the upsert loop.
//
// Wiring into chi lives in cmd/api/main.go (NOT touched here — main.go
// is owned by the wiring step that follows /search + /schedule both
// landing).
package anime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"

	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// searchCacheTTL is the in-memory TTL for /search responses.  Matches
// the Express SEARCH_TTL_MS constant (10 minutes) byte-exact.
const searchCacheTTL = 10 * time.Minute

// searchDefaultPerPage is the default page size when the caller omits
// perPage.  Express anime.controller.js:130 reads `perPage = 20` from
// the destructured query object.
const searchDefaultPerPage = 20

// searchMaxPerPage caps the page size.  Express applies the cap via
// Math.min(perPage, 50) at anime.controller.js:138.
const searchMaxPerPage = 50

// AniListSearcher is the narrow interface SearchService depends on —
// only the Search method.  *anilist.Client satisfies it; tests inject a
// stub via the fakeSearcher struct in search_test.go.  Defined here at
// the consumer (anime package) per the "accept interfaces, return
// structs" rule.
type AniListSearcher interface {
	Search(ctx context.Context, v anilist.SearchVars) (*anilist.SearchAnimeResponse, error)
}

// SearchService composes the AniList client, the ristretto cache, and
// the sqlc-generated Querier into a single /api/anime/search handler.
// Built once at server startup via NewSearchService and reused across
// requests — the cache lives on the service value so requests within a
// 10-minute window can short-circuit before reaching AniList.
type SearchService struct {
	anilist AniListSearcher
	cache   *cache.Cache[SearchPage]
	db      dbgen.Querier
}

// SearchPage is the cache-value shape: AniList page info + the post-
// upsert DB rows.  JSON tags exist so a future debug dump endpoint can
// json.Marshal the cache entry directly, but the response envelope is
// rebuilt at write time (see Handler) and does not flow through this
// struct's tags.
type SearchPage struct {
	PageInfo anilist.PageInfo                `json:"pageInfo"`
	Anime    []dbgen.GetAnimeByAnilistIDsRow `json:"anime"`
}

// NewSearchService builds a SearchService with a 10-minute ristretto
// cache.  Returns an error only when ristretto rejects the
// configuration — in practice the zero Config{} with DefaultTTL set is
// always accepted.  Callers should close the cache at shutdown via
// SearchService.Close to release ristretto's background goroutines.
func NewSearchService(client AniListSearcher, db dbgen.Querier) (*SearchService, error) {
	c, err := cache.New[SearchPage](cache.Config{DefaultTTL: searchCacheTTL})
	if err != nil {
		return nil, fmt.Errorf("anime/search: build cache: %w", err)
	}
	return &SearchService{anilist: client, cache: c, db: db}, nil
}

// Close releases the underlying ristretto cache.  Safe to call multiple
// times — ristretto's Close is idempotent and the wrapper is too.
func (s *SearchService) Close() {
	if s.cache != nil {
		s.cache.Close()
	}
}

// Handler returns the chi-compatible http.HandlerFunc for
// GET /api/anime/search.
//
// Query parameters:
//
//	q        optional, search keyword (matches AniList Media.search)
//	genre    optional, single genre slug (matches AniList Media.genre)
//	page     default 1, min 1
//	perPage  default 20, max 50
//
// Either q or genre is required — both empty returns 400
// VALIDATION_ERROR with the Chinese message "请提供搜索关键词或类型".
//
// Response envelope (Express byte-exact):
//
//	{"data":[...], "pagination":{"page":1,"perPage":20,"total":N,"totalPages":M}}
func (s *SearchService) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		qs := req.URL.Query()
		q := strings.TrimSpace(qs.Get("q"))
		genre := strings.TrimSpace(qs.Get("genre"))

		// Express:  if (!q && !genre) return 400 with the Chinese message.
		// Trim before the check so a whitespace-only query is treated as
		// absent — the JS code does not trim, so this is a small
		// improvement; matches the spirit of the validator.
		if q == "" && genre == "" {
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				"请提供搜索关键词或类型",
			))
			return
		}

		// Express:  page = 1, perPage = 20 destructured defaults; then
		// Math.min(perPage, 50) at line 138.  parseIntDefault tolerates
		// non-numeric / missing values and falls back to the default.
		page := parseIntDefault(qs.Get("page"), 1)
		if page < 1 {
			page = 1
		}
		perPage := parseIntDefault(qs.Get("perPage"), searchDefaultPerPage)
		if perPage < 1 {
			perPage = searchDefaultPerPage
		}
		if perPage > searchMaxPerPage {
			perPage = searchMaxPerPage
		}

		result, err := s.run(ctx, q, genre, page, perPage)
		if err != nil {
			s.writeError(w, err)
			return
		}

		totalPages := 0
		total := result.PageInfo.Total
		if perPage > 0 {
			totalPages = int(math.Ceil(float64(total) / float64(perPage)))
		}

		// Ensure rows never serialise as null — empty AniList response
		// must surface as `"data":[]` to keep the frontend's
		// Array.prototype.map calls safe.
		anime := result.Anime
		if anime == nil {
			anime = []dbgen.GetAnimeByAnilistIDsRow{}
		}

		writeSearchEnvelope(w, http.StatusOK, searchResponse{
			Data: anime,
			Pagination: searchPagination{
				Page:       result.PageInfo.CurrentPage,
				PerPage:    result.PageInfo.PerPage,
				Total:      total,
				TotalPages: totalPages,
			},
		})
	}
}

// run is the inner data-flow method: cache → AniList → upsert → re-read.
// Separated from Handler so the HTTP envelope owns input parsing +
// error mapping while run owns the AniList / DB orchestration.  Returns
// the populated SearchPage on success; on AniList error it returns the
// raw error so writeError can map it to the correct HTTP status.
func (s *SearchService) run(ctx context.Context, q, genre string, page, perPage int) (*SearchPage, error) {
	// Cache key: "q|genre|page|perPage" — byte-exact match with the
	// Express service-layer key construction so a future shared cache
	// (Redis) lookup hits the same entries.
	key := fmt.Sprintf("%s|%s|%d|%d", q, genre, page, perPage)
	if hit, ok := s.cache.Get(key); ok {
		return &hit, nil
	}

	// Build SearchVars with pointer fields so omitempty drops nil
	// entries from the JSON body — AniList expects `undefined`, not
	// the empty string.
	vars := anilist.SearchVars{Page: page, PerPage: perPage}
	if q != "" {
		vars.Search = &q
	}
	if genre != "" {
		vars.Genre = &genre
	}

	resp, err := s.anilist.Search(ctx, vars)
	if err != nil {
		return nil, err
	}

	// TODO P2.1.5: enqueue Bangumi V1 enrichment for entries with
	// bangumi_version=0 — the river workers are still stubs in P2.1.0,
	// so search runs the upsert-only path and lets a future cron warm
	// the title_chinese / bangumi_score columns asynchronously.
	for _, m := range resp.Page.Media {
		args := NormalizeMainRow(m)
		if upErr := s.db.UpsertAnimeCache(ctx, args); upErr != nil {
			// Per-row failure is logged and skipped — the response
			// composition can still proceed via the AniList payload +
			// previously cached rows.  Failing the entire request on a
			// single row would degrade UX worse than a partial result.
			slog.Warn("anime/search: upsert failed",
				"anilist_id", args.AnilistID,
				"err", upErr.Error(),
			)
		}
	}

	// Re-read by AniList IDs so enriched columns (title_chinese,
	// bangumi_score) populated by prior Bangumi enrichment runs flow
	// into the response.  Express does the same via
	// AnimeCache.find({anilistId: {$in: ids}}) at anilist.service.js:351.
	ids := make([]int32, 0, len(resp.Page.Media))
	for _, m := range resp.Page.Media {
		ids = append(ids, int32(m.ID))
	}
	rows, err := s.db.GetAnimeByAnilistIDs(ctx, ids)
	if err != nil {
		return nil, err
	}

	sp := SearchPage{
		PageInfo: resp.Page.PageInfo,
		Anime:    rows,
	}
	s.cache.Set(key, sp)
	return &sp, nil
}

// writeError maps run() errors to the appropriate httpx envelope.
//
//   - context.DeadlineExceeded   → 504 GATEWAY_TIMEOUT mapped to
//                                  SERVER_ERROR (httpx has no timeout
//                                  code; preserve status for ops).
//   - *anilist.ErrUpstream       → 502 BAD_GATEWAY mapped to
//                                  SERVER_ERROR (Express returns 500;
//                                  502 is more accurate and frontend
//                                  treats both as "AniList unreachable").
//   - anilist.ErrRateLimited     → 502 SERVER_ERROR — AniList per-IP
//                                  budget exhausted.  Could be a 429 to
//                                  surface "slow down" to the client,
//                                  but the client did nothing wrong;
//                                  the upstream did.  502 matches
//                                  /:anilistId detail-fetch in Express.
//   - any other error            → 500 SERVER_ERROR.
func (s *SearchService) writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		httpx.Fail(w, httpx.WrapError(err, http.StatusGatewayTimeout, httpx.CodeServerError, "AniList timeout"))
	case errors.Is(err, anilist.ErrRateLimited):
		httpx.Fail(w, httpx.WrapError(err, http.StatusBadGateway, httpx.CodeServerError, "AniList rate limited"))
	default:
		var upstream *anilist.ErrUpstream
		if errors.As(err, &upstream) {
			httpx.Fail(w, httpx.WrapError(err, http.StatusBadGateway, httpx.CodeServerError, "AniList upstream error"))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "search failed"))
	}
}

// -----------------------------------------------------------------------------
// Response shape structs (local to /search).  Distinct from the seasonal
// pair in handlers.go so changes here don't break Express byte-parity on
// /seasonal — they happen to share field names but the contract is
// independent.
// -----------------------------------------------------------------------------

// searchPagination is the pagination block emitted by /api/anime/search.
// Field order: page, perPage, total, totalPages — matches Express
// anime.controller.js:142-145.
type searchPagination struct {
	Page       int `json:"page"`
	PerPage    int `json:"perPage"`
	Total      int `json:"total"`
	TotalPages int `json:"totalPages"`
}

// searchResponse is the full envelope for /api/anime/search.  Field
// order: data, pagination — matches Express.
type searchResponse struct {
	Data       []dbgen.GetAnimeByAnilistIDsRow `json:"data"`
	Pagination searchPagination                `json:"pagination"`
}

// writeSearchEnvelope writes a {"data":[...], "pagination":{...}}
// envelope with HTML escaping off and no trailing newline.  Mirrors the
// writeMultiKeyEnvelope helper in handlers.go — duplicated here on
// purpose so /search stays self-contained and a future refactor of
// /seasonal's helper doesn't accidentally break /search's byte shape.
func writeSearchEnvelope(w http.ResponseWriter, status int, v searchResponse) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Warn("anime/search envelope marshal failed", "err", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"SERVER_ERROR","message":"internal error"}}`))
		return
	}
	body := bytes.TrimRight(buf.Bytes(), "\n")

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(body); err != nil {
		slog.Warn("anime/search envelope write failed", "err", err)
	}
}
