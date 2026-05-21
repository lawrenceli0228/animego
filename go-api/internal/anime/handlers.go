// Package anime owns the /api/anime/* HTTP handlers.
//
// Each exported function returns a chi-compatible http.HandlerFunc bound
// to the dbgen.Querier (and, for later endpoints, the AniList client +
// caches + enrichment queue).  The Querier interface lets handler tests
// substitute a mock without spinning up Postgres.
//
// Handlers follow the pattern documented in go-api/README.md "Adding a
// new endpoint":  pull a query-level timeout off the request context,
// parse + validate query params, hit the DB through Querier, write the
// httpx envelope.
package anime

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/torrents"
)

// queryTimeout bounds every handler's database round-trip.  Five seconds
// is generous for the kinds of queries P2.1 issues — bulk anime_cache
// reads with a LIMIT clause typically return in <50ms even on the dev
// machine; the budget covers contention spikes and per-test container
// warmup.
//
// Each handler creates a child context derived from the request context
// so that client-disconnect propagates and frees the connection.
const queryTimeout = 5 * time.Second

// CompletedGems implements GET /api/anime/completed-gems — a random
// sample of finished, highly-rated anime with cover art.  Replaces
// server/controllers/anime.controller.js:77-87.
//
// Query parameters:
//
//	limit  default 6, max 20
//
// Response envelope:
//
//	{"data":[{...anime fields...}, ...]}
func CompletedGems(q dbgen.Querier) http.HandlerFunc {
	const (
		defaultLimit = 6
		maxLimit     = 20
	)
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		limit := parseLimit(req.URL.Query().Get("limit"), defaultLimit, maxLimit)

		rows, err := q.GetCompletedGems(ctx, int32(limit))
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		// Express:  res.json({ data });  — flat array envelope, no
		// pagination metadata (random sample has no total / page concept).
		httpx.Data(w, http.StatusOK, rows)
	}
}

// Seasonal implements GET /api/anime/seasonal — paginated season listing
// from the local anime_cache table.  Cold-start (cache miss) AniList path
// lands in P2.1.4 with the service-layer wiring.  Replaces the warmed-
// cache branch of anime.controller.js:113-127.
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
func Seasonal(q dbgen.Querier) http.HandlerFunc {
	const (
		defaultPerPage = 20
		maxPerPage     = 200
	)
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

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

		// Year: default current, sanity range 1900..3000.  Express coerces
		// query strings via Number(...) — non-numeric falls through to the
		// default via JS's `||` on NaN.  We mirror that with the parseInt
		// fallback below.
		year := parseYear(qs.Get("year"))

		// Page: default 1, min 1.
		page := parseIntDefault(qs.Get("page"), 1)
		if page < 1 {
			page = 1
		}

		// PerPage: default 20, capped at 200 (Express's Math.min(perPage, 200)).
		perPage := parseIntDefault(qs.Get("perPage"), defaultPerPage)
		if perPage < 1 {
			perPage = defaultPerPage
		}
		if perPage > maxPerPage {
			perPage = maxPerPage
		}

		offset := int32((page - 1) * perPage)
		limit := int32(perPage)
		yearI32 := int32(year)

		// Fetch the page + the total count in parallel.  errgroup is
		// overkill for two calls but the pattern scales when P2.1.4
		// adds genre filters and a third aggregate.
		var (
			rows  []dbgen.GetSeasonalAnimeRow
			total int64
		)
		g, gctx := errgroup.WithContext(ctx)
		g.Go(func() error {
			var err error
			rows, err = q.GetSeasonalAnime(gctx, &season, &yearI32, limit, offset)
			return err
		})
		g.Go(func() error {
			var err error
			total, err = q.CountSeasonal(gctx, &season, &yearI32)
			return err
		})
		if err := g.Wait(); err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		totalPages := 0
		if perPage > 0 {
			totalPages = int(math.Ceil(float64(total) / float64(perPage)))
		}

		// Express:  res.json({data, pagination}) — flat sibling keys, not
		// wrapped via the canonical httpx.Data {data: payload} envelope.
		// Ensure rows is never nil so an empty result serialises as [].
		if rows == nil {
			rows = []dbgen.GetSeasonalAnimeRow{}
		}
		writeMultiKeyEnvelope(w, http.StatusOK, seasonalResponse{
			Data: rows,
			Pagination: seasonalPagination{
				Page:       page,
				PerPage:    perPage,
				Total:      int(total),
				TotalPages: totalPages,
			},
		})
	}
}

// YearlyTop implements GET /api/anime/yearly-top — top-rated TV/Movie/ONA
// anime for the given year.  Replaces anime.controller.js:93-110.
//
// Express semantics preserved: the DB is always queried with limit=20,
// then sliced down to the caller's limit in Go.  This matches the
// 1h cache key Express uses (year only, not year+limit) — so a cache
// warmed by ?limit=10 can satisfy ?limit=15 from the same entry.  The
// cache itself lands in P2.1.4; for now every request hits Postgres.
//
// Query parameters:
//
//	year   default <current>
//	limit  default 10, max 20
//
// Response envelope:
//
//	{"data":[{...anime fields...}, ...]}
func YearlyTop(q dbgen.Querier) http.HandlerFunc {
	const (
		defaultLimit = 10
		maxLimit     = 20
	)
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		qs := req.URL.Query()

		year := parseYear(qs.Get("year"))
		limit := parseLimit(qs.Get("limit"), defaultLimit, maxLimit)

		yearI32 := int32(year)
		rows, err := q.GetYearlyTop(ctx, &yearI32, int32(maxLimit))
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		// Express:  data.slice(0, limitNum)  — query 20 then trim in code.
		if len(rows) > limit {
			rows = rows[:limit]
		}

		httpx.Data(w, http.StatusOK, rows)
	}
}

// Trending implements GET /api/anime/trending — most-subscribed anime
// ordered by watcher count desc.  Replaces anime.controller.js:17-50.
//
// The Express two-query (Subscription.aggregate + AnimeCache.find) is
// folded into a single SQL JOIN via dbgen.GetTrendingWithCounts.  The
// 1h in-memory cache from Express lands in P2.1.4 with the cache
// package wiring; for now every request hits Postgres (2 cheap queries).
//
// Query parameters:
//
//	limit  default 10, max 20
//
// Response envelope (rank/watcherCount injected at the top, anime fields follow):
//
//	{"data":[{"rank":1, "watcherCount":42, "anilistId":..., ...}, ...]}
func Trending(q dbgen.Querier) http.HandlerFunc {
	const (
		defaultLimit = 10
		maxLimit     = 20
	)
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		limit := parseLimit(req.URL.Query().Get("limit"), defaultLimit, maxLimit)

		rows, err := q.GetTrendingWithCounts(ctx, int32(maxLimit))
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		// Express:  agg.filter(r => animeMap[r._id]).map((r, i) => ({rank: i+1, ...}))
		// The SQL JOIN already drops anime_cache misses, so we can map
		// 1:1 without filtering.  Rank is iteration order, 1-indexed.
		items := make([]trendingItem, 0, len(rows))
		for i, r := range rows {
			items = append(items, trendingItem{
				Rank:            i + 1,
				WatcherCount:    r.WatcherCount,
				AnilistID:       r.AnilistID,
				TitleRomaji:     r.TitleRomaji,
				TitleEnglish:    r.TitleEnglish,
				TitleNative:     r.TitleNative,
				TitleChinese:    r.TitleChinese,
				CoverImageUrl:   r.CoverImageUrl,
				CoverImageColor: r.CoverImageColor,
				PosterAccent:    r.PosterAccent,
				AverageScore:    r.AverageScore,
				BangumiScore:    r.BangumiScore,
				Episodes:        r.Episodes,
				Season:          r.Season,
				SeasonYear:      r.SeasonYear,
				Status:          r.Status,
				Format:          r.Format,
				Description:     r.Description,
			})
		}
		if len(items) > limit {
			items = items[:limit]
		}

		httpx.Data(w, http.StatusOK, items)
	}
}

// Watchers implements GET /api/anime/:anilistId/watchers — public list
// of users currently watching the given anime.  Replaces
// anime.controller.js:53-75.  The Express two-step (Subscription.find +
// populate) collapses into a single SQL JOIN via dbgen.GetWatchers.
//
// Path parameter:
//
//	anilistId  must parse as int; on parse fail returns 400 VALIDATION_ERROR
//	           with the Chinese message "无效的番剧 ID".
//
// Query parameters:
//
//	limit  default 5, max 20
//
// Response envelope:
//
//	{"data":[{"username":"alice"}, ...], "total":N}
func Watchers(q dbgen.Querier) http.HandlerFunc {
	const (
		defaultLimit = 5
		maxLimit     = 20
	)
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		raw := chi.URLParam(req, "anilistId")
		id, err := strconv.Atoi(raw)
		if err != nil {
			// Express:  if (isNaN(anilistId)) return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'无效的番剧 ID'}})
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				"无效的番剧 ID",
			))
			return
		}

		limit := parseLimit(req.URL.Query().Get("limit"), defaultLimit, maxLimit)
		idI32 := int32(id)

		var (
			usernames []string
			total     int64
		)
		g, gctx := errgroup.WithContext(ctx)
		g.Go(func() error {
			var err error
			usernames, err = q.GetWatchers(gctx, idI32, int32(limit))
			return err
		})
		g.Go(func() error {
			var err error
			total, err = q.CountWatchers(gctx, idI32)
			return err
		})
		if err := g.Wait(); err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		// Map []string → []watcherItem so the JSON shape carries an
		// object per element ({username: "..."}) instead of a raw
		// string array.  Match the Express map(s => ({username: ...})).
		items := make([]watcherItem, 0, len(usernames))
		for _, u := range usernames {
			items = append(items, watcherItem{Username: u})
		}

		// Express:  res.json({data, total}) — flat sibling keys, not
		// wrapped via httpx.Data.  See writeMultiKeyEnvelope for the
		// rationale.
		writeMultiKeyEnvelope(w, http.StatusOK, watchersResponse{
			Data:  items,
			Total: total,
		})
	}
}

// Torrents implements GET /api/anime/torrents — 3-source magnet aggregator
// (animes.garden + acg.rip + nyaa.si) wired into internal/torrents.
// Replaces anime.controller.js:291-325 — the per-source partial-tolerance
// + per-query 1h cache live in the aggregator package.
//
// Query parameters:
//
//	q  required, 1..200 chars
//
// Response envelope:
//
//	{"data":[{"title":..., "magnet":..., "size":..., "fansub":..., "date":..., "source":..., "provider":...}, ...]}
func Torrents(agg *torrents.Aggregator) http.HandlerFunc {
	const maxQueryLen = 200

	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		q := req.URL.Query().Get("q")
		if q == "" {
			// Express: 'Missing query'
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				"Missing query",
			))
			return
		}
		if len(q) > maxQueryLen {
			// Express: 'Query too long'
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				"Query too long",
			))
			return
		}

		items, err := agg.Fetch(ctx, q)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "torrents fetch failed"))
			return
		}
		if items == nil {
			items = []torrents.TorrentItem{}
		}

		httpx.Data(w, http.StatusOK, items)
	}
}

// -----------------------------------------------------------------------------
// Response shape structs.  Defined at package scope so handler tests can
// reach for the same types when asserting on parsed JSON.
// -----------------------------------------------------------------------------

// seasonalPagination is the pagination block emitted by /api/anime/seasonal.
// Field order: page, perPage, total, totalPages — matches Express
// res.json({data, pagination: {page, perPage, total, totalPages}}).
type seasonalPagination struct {
	Page       int `json:"page"`
	PerPage    int `json:"perPage"`
	Total      int `json:"total"`
	TotalPages int `json:"totalPages"`
}

// seasonalResponse is the full envelope for /api/anime/seasonal.  Order:
// data first, then pagination — matches Express.
type seasonalResponse struct {
	Data       []dbgen.GetSeasonalAnimeRow `json:"data"`
	Pagination seasonalPagination          `json:"pagination"`
}

// trendingItem is one row in /api/anime/trending's data array.  Field
// order: rank, watcherCount, then the anime fields in dbgen's column
// order.  Express emits rank + watcherCount before the spread
// (...animeMap[r._id].toObject()), so we replicate that here.
type trendingItem struct {
	Rank            int      `json:"rank"`
	WatcherCount    int64    `json:"watcherCount"`
	AnilistID       int32    `json:"anilistId"`
	TitleRomaji     *string  `json:"titleRomaji"`
	TitleEnglish    *string  `json:"titleEnglish"`
	TitleNative     *string  `json:"titleNative"`
	TitleChinese    *string  `json:"titleChinese"`
	CoverImageUrl   *string  `json:"coverImageUrl"`
	CoverImageColor *string  `json:"coverImageColor"`
	PosterAccent    *string  `json:"posterAccent"`
	AverageScore    *float64 `json:"averageScore"`
	BangumiScore    *float64 `json:"bangumiScore"`
	Episodes        *int32   `json:"episodes"`
	Season          *string  `json:"season"`
	SeasonYear      *int32   `json:"seasonYear"`
	Status          *string  `json:"status"`
	Format          *string  `json:"format"`
	Description     *string  `json:"description"`
}

// watcherItem is one element of /api/anime/:anilistId/watchers' data
// array.  Express: map(s => ({username: s.userId.username})).
type watcherItem struct {
	Username string `json:"username"`
}

// watchersResponse is the full envelope for /api/anime/:anilistId/watchers.
// Field order: data, total — matches Express res.json({data, total}).
type watchersResponse struct {
	Data  []watcherItem `json:"data"`
	Total int64         `json:"total"`
}

// writeMultiKeyEnvelope writes a JSON response whose top-level shape is
// NOT the canonical {data: payload} wrapper.  Two endpoints in this
// package emit envelopes with sibling keys at the top level:
//
//   - /api/anime/seasonal       → {"data":[...], "pagination":{...}}
//   - /api/anime/:id/watchers  → {"data":[...], "total":N}
//
// Express writes these as res.json({data, pagination}) / res.json({data, total}) —
// flat objects, not {data: {data, ...}}.  Routing through httpx.Data
// would double-wrap and break byte-level parity.
//
// Behaviour mirrors httpx.writeJSON: HTML escaping off, no trailing
// newline, Content-Type application/json; charset=utf-8.  Marshal
// failures fall back to the generic 500 SERVER_ERROR envelope.
func writeMultiKeyEnvelope(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Warn("anime envelope marshal failed", "err", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"SERVER_ERROR","message":"internal error"}}`))
		return
	}
	body := bytes.TrimRight(buf.Bytes(), "\n")

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(body); err != nil {
		slog.Warn("anime envelope write failed", "err", err)
	}
}

// -----------------------------------------------------------------------------
// Parse helpers.
// -----------------------------------------------------------------------------

// parseLimit parses a query-string limit with a default and maximum.
// Non-numeric, negative, and missing values fall back to def.  Values
// over max are capped at max — matches Express Math.min(... , max).
func parseLimit(s string, def, max int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// parseIntDefault parses a query-string int with a default.  Non-numeric
// and missing values fall back to def.  Negative / zero pass through;
// callers that need a positive floor enforce it themselves (parseLimit
// is the strict variant; this is the permissive one).
func parseIntDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

// parseYear parses a year string with current-year fallback.  Out-of-range
// values (year < 1900 or year > 3000) also fall back to the current year —
// the Express defaults are looser (it accepts any Number) but a sanity
// range here keeps obviously-wrong inputs from hitting Postgres.
func parseYear(s string) int {
	now := time.Now().UTC().Year()
	if s == "" {
		return now
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return now
	}
	if n < 1900 || n > 3000 {
		return now
	}
	return n
}

// validSeason reports whether s is one of the four canonical AniList
// season values.  Comparison is case-sensitive — Express defaults to
// uppercase WINTER and never lowercases input.
func validSeason(s string) bool {
	switch s {
	case "WINTER", "SPRING", "SUMMER", "FALL":
		return true
	default:
		return false
	}
}
