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
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/pii"
	"github.com/lawrenceli0228/animego/go-api/internal/torrents"
)

// trendingCacheKey is the single global key for the Trending cache.
// Express keeps top-N trending in a single module-level variable
// (trendingCache.data) — there is no per-user variation, so one key
// is sufficient.  Per-request limit slicing happens after cache lookup.
const trendingCacheKey = "trending"

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

// Seasonal has moved to seasonal.go as SeasonalService.  See
// NewSeasonalService for the constructor — main.go wires it with the
// AniList client so the cold-start (cache-miss) path activates.

// YearlyTop implements GET /api/anime/yearly-top — top-rated TV/Movie/ONA
// anime for the given year.  Replaces anime.controller.js:93-110.
//
// Express semantics preserved: the DB is always queried with limit=20,
// then sliced down to the caller's limit in Go.  This matches the
// 1h cache key Express uses (year only, not year+limit) — so a cache
// warmed by ?limit=10 can satisfy ?limit=15 from the same entry.
//
// Caching:
//
//   - Backed by a 1h in-memory ristretto cache keyed on year (decimal
//     string).  Cache value is the full []dbgen.GetYearlyTopRow slice
//     (length up to 20) returned by the DB; the per-request limit cap
//     is applied AFTER cache hit/populate.
//   - Cache miss → DB → cache populate → response.
//   - Cache hit → respond directly, no DB round-trip.
//   - ?refresh=true is NOT honored here (Express only honors it on
//     /trending; we match Express by ignoring it on /yearly-top).
//
// Query parameters:
//
//	year   default <current>
//	limit  default 10, max 20
//
// Response envelope:
//
//	{"data":[{...anime fields...}, ...]}
func YearlyTop(q dbgen.Querier, c *cache.Cache[[]dbgen.GetYearlyTopRow]) http.HandlerFunc {
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

		cacheKey := strconv.Itoa(year)

		rows, hit := c.Get(cacheKey)
		if !hit {
			yearI32 := int32(year)
			fresh, err := q.GetYearlyTop(ctx, &yearI32, int32(maxLimit))
			if err != nil {
				httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
				return
			}
			rows = fresh
			// Cache the full 20-row slice; let the per-request limit
			// slice happen below.  Set may return false under cost
			// pressure — log + continue (next request will re-query).
			if ok := c.Set(cacheKey, rows); !ok {
				slog.Warn("yearly-top cache set rejected", "year", year, "rows", len(rows))
			}
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
// folded into a single SQL JOIN via dbgen.GetTrendingWithCounts.
//
// Caching:
//
//   - Backed by a 1h in-memory ristretto cache under a single global key
//     ("trending") — the top-N list is identical for every client, so
//     there is no per-user variation worth keying on.
//   - Cache value is the full mapped []trendingItem slice (length up to
//     20, rank + watcherCount injected); per-request limit slicing
//     happens after the cache hit/populate.
//   - Cache miss → DB → map → cache populate → response.
//   - Cache hit → respond directly, no DB round-trip.
//   - ?refresh=true bypasses the cache lookup: re-queries the DB and
//     repopulates the entry.  Matches Express anime.controller.js:17-19.
//
// Query parameters:
//
//	limit    default 10, max 20
//	refresh  optional; "true" bypasses cache
//
// Response envelope (rank/watcherCount injected at the top, anime fields follow):
//
//	{"data":[{"rank":1, "watcherCount":42, "anilistId":..., ...}, ...]}
func Trending(q dbgen.Querier, c *cache.Cache[[]trendingItem]) http.HandlerFunc {
	const (
		defaultLimit = 10
		maxLimit     = 20
	)
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		qs := req.URL.Query()
		limit := parseLimit(qs.Get("limit"), defaultLimit, maxLimit)
		bypass := qs.Get("refresh") == "true"

		var (
			items []trendingItem
			hit   bool
		)
		if !bypass {
			items, hit = c.Get(trendingCacheKey)
		}

		if !hit {
			rows, err := q.GetTrendingWithCounts(ctx, int32(maxLimit))
			if err != nil {
				httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
				return
			}

			// Express:  agg.filter(r => animeMap[r._id]).map((r, i) => ({rank: i+1, ...}))
			// The SQL JOIN already drops anime_cache misses, so we can map
			// 1:1 without filtering.  Rank is iteration order, 1-indexed.
			items = make([]trendingItem, 0, len(rows))
			for i, r := range rows {
				items = append(items, trendingItem{
					Rank:            i + 1,
					WatcherCount:    r.WatcherCount,
					AnilistID:       r.AnilistID,
					TitleRomaji:     r.TitleRomaji,
					TitleEnglish:    r.TitleEnglish,
					TitleNative:     r.TitleNative,
					TitleChinese:    r.TitleChinese,
					TitleHant:       r.TitleHant,
					TitleHantSource: r.TitleHantSource,
					TitleHantSeo:    r.TitleHantSeo,
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

			// Cache the full mapped slice (≤20); per-request limit is
			// applied below.  A rejected Set under cost pressure is not
			// fatal — next request just re-populates.
			if ok := c.Set(trendingCacheKey, items); !ok {
				slog.Warn("trending cache set rejected", "items", len(items))
			}
		}

		// Slice to the per-request limit AFTER cache lookup/populate so
		// the cache always carries the full top-20.
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
			watchers []dbgen.GetWatchersRow
			total    int64
		)
		g, gctx := errgroup.WithContext(ctx)
		g.Go(func() error {
			var err error
			watchers, err = q.GetWatchers(gctx, idI32, int32(limit))
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

		// Map rows → []watcherItem so the JSON shape carries an object per
		// element ({username, avatarUrl}). avatarUrl drives the watcher
		// avatar thumbnails; nil renders the initial fallback.
		//
		// pii.PublicUsername is load-bearing here, more than anywhere else
		// in the codebase: this endpoint takes no auth at all, and the
		// frontend renders each username four times per watcher (the
		// /u/{username} href, title, aria-label and img alt) into
		// /anime/{id} — a route that is ISR-prerendered, Cloudflare
		// edge-cached and indexed.  A contact-shaped username here ends up
		// in a CDN-cached search result.
		items := make([]watcherItem, 0, len(watchers))
		for _, row := range watchers {
			items = append(items, watcherItem{
				Username:         pii.PublicUsername(row.Username),
				AvatarURL:        row.AvatarUrl,
				BackdropCoverURL: row.BackdropCoverUrl,
			})
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

// maxEpisodeIDs caps how many AniList ids one /api/anime/episodes call may
// ask about.
//
// 200 is set by the request line, not by the database.  The ids travel in
// the query string, and nginx's default large_client_header_buffers gives a
// request line 8 KiB; 200 seven-digit ids plus separators is ~1.6 KiB, so
// the cap keeps a full-size call at roughly a fifth of the ceiling instead
// of letting a slightly larger library turn into an opaque 414 at the proxy
// before go-api ever sees it.  Postgres is nowhere near the binding
// constraint — 200 int4s is a trivial array parameter against a primary-key
// lookup.
//
// It is also comfortably above what a single library holds, so the common
// case is one round trip.  A caller holding more than that splits the list
// and calls twice: the endpoint is stateless, so two calls cost what one
// does.
const maxEpisodeIDs = 200

// episodeCountsCacheControl is the response cache policy for
// /api/anime/episodes.
//
// public because there is no per-user variation in the response at all —
// the endpoint takes no auth and returns catalog facts keyed only by
// AniList id, so an edge or browser cache entry is safe to share.
//
// The two numbers are doing different jobs.  max-age=300 is the window in
// which a reopened tab pays nothing; the counts behind it move at the pace
// of a season ending or the episode backfill sweep landing a row, so five
// minutes of staleness is invisible.  stale-while-revalidate=3600 is the
// one that matters for this caller: the library backfill runs at render
// time, and serving the previous answer immediately while revalidating in
// the background is exactly the behaviour wanted — the list paints from
// cache and heals itself on the next pass.
//
// Set on the 200 path only.  A cached 400 would pin a client's own
// malformed request in front of it.
const episodeCountsCacheControl = "public, max-age=300, stale-while-revalidate=3600"

// EpisodeCountsDB is the slice of dbgen.Querier the Episodes handler needs.
// Declared at the use site (small interface, same as TorrentsDB) so handler
// tests can supply a one-method fake without the full Querier surface.
type EpisodeCountsDB interface {
	GetEpisodeCountsByAnilistIDs(ctx context.Context, anilistIDs []int32) ([]dbgen.GetEpisodeCountsByAnilistIDsRow, error)
}

// Episodes implements GET /api/anime/episodes — a batch total-episode-count
// read for a list of AniList ids.
//
// Why it exists: the browser-side library shows a per-series episode total,
// and it can only get one for series it binds during that session.  The
// binding path short-circuits when a series is already bound and hands back
// no episode data, so every series a user bound before this shipped would
// stay blank forever.  This endpoint is the one-shot batch read that closes
// that gap — the library asks about everything it already has and fills in
// the counts.
//
// Public GET, no auth.  It needs no rate-limit wiring of its own: the
// global limiter already exempts public catalog reads under /api/anime/
// other than the two external fan-outs (httpmw.isPublicReadExempt), and
// this is a bounded primary-key lookup, which is the cheap side of that
// line.
//
// Query parameters:
//
//	ids  required; comma-separated AniList ids, at most maxEpisodeIDs
//
// Validation is strict, because the only caller is our own frontend and a
// silent partial answer is harder to notice than a 400:
//
//   - missing or empty ids            → 400
//   - more than maxEpisodeIDs entries → 400
//   - any entry that is not a positive integer inside int32 → 400
//
// The int32 range check is load-bearing rather than pedantic.  strconv.Atoi
// parses into a 64-bit int on every platform this runs on, so a plain
// int32() conversion would wrap 4294967297 to 1 and cheerfully answer with
// a different anime's episode count.
//
// Ids with no cached row are absent from the response — not null entries,
// not an error.  A caller that asked about 40 series and got 38 back knows
// which two are uncached by set difference, and 200-with-fewer-rows is the
// honest status for "some of what you named does not exist here".
//
// Response envelope:
//
//	{"data":[{"anilistId":1,"episodes":26,"episodesBgm":null}, ...]}
//
// episodes and episodesBgm are two fields and stay two fields.  episodes is
// AniList's authoritative count; episodesBgm (migration 0023) is inferred
// from an external source.  A consumer downstream emits numberOfEpisodes
// into schema.org JSON-LD and only the authoritative value is allowed to
// appear there — so this handler must never coalesce them, and must never
// grow a third convenience field that does the coalescing on the caller's
// behalf.  Choosing between them is the caller's decision precisely because
// only the caller knows whether the value is about to become a factual
// claim to a search engine.
func Episodes(db EpisodeCountsDB) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		ids, err := parseAnilistIDList(req.URL.Query().Get("ids"), maxEpisodeIDs)
		if err != nil {
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				err.Error(),
			))
			return
		}

		rows, queryErr := db.GetEpisodeCountsByAnilistIDs(ctx, ids)
		if queryErr != nil {
			httpx.Fail(w, httpx.WrapError(queryErr, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		items := make([]episodeCountItem, 0, len(rows))
		for _, r := range rows {
			items = append(items, episodeCountItem{
				AnilistID:   r.AnilistID,
				Episodes:    r.Episodes,
				EpisodesBgm: r.EpisodesBgm,
			})
		}

		w.Header().Set("Cache-Control", episodeCountsCacheControl)
		httpx.Data(w, http.StatusOK, items)
	}
}

// parseAnilistIDList splits a comma-separated id list into deduplicated
// int32s, or returns the client-facing reason it could not.
//
// The entry count is checked against max BEFORE anything is parsed, so an
// absurd list costs one strings.Count rather than a full scan-and-allocate.
//
// Surrounding whitespace on an entry is tolerated; an empty entry is not.
// That makes a trailing comma a 400, which is deliberate — every entry is
// generated by a join in our own client, so an empty one means the client
// built the list wrong and should hear about it rather than have the server
// quietly drop a series from the answer.
//
// The rejection message names the offending position and never echoes the
// offending text.  Reflecting an attacker-supplied string into a response
// body buys nothing here (the client already knows what it sent) and the
// index is the more useful half of the answer anyway.
//
// De-duplication happens after the cap so a caller cannot smuggle a huge
// list past it by repeating one id.  It is worth doing at all only because
// ANY() returns one row per matching row, not per array element: without
// it, a duplicated id would silently make the response shorter than the
// request, which is the signal reserved for "not cached here".
func parseAnilistIDList(raw string, max int) ([]int32, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("ids is required")
	}
	if n := strings.Count(raw, ",") + 1; n > max {
		return nil, fmt.Errorf("too many ids: %d (max %d)", n, max)
	}

	parts := strings.Split(raw, ",")
	ids := make([]int32, 0, len(parts))
	seen := make(map[int32]struct{}, len(parts))
	for i, p := range parts {
		n, err := strconv.ParseInt(strings.TrimSpace(p), 10, 32)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("ids[%d] is not a positive 32-bit integer", i)
		}
		id := int32(n)
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}

// maxTorrentVariants caps how many title variants the anilistId path expands
// into.  An anime has at most four cached titles (romaji / native / english /
// chinese); even after de-duplication four is the ceiling, but the cap is
// explicit so a future extra title column can't silently widen the
// variants × sources fan-out.
const maxTorrentVariants = 4

// TorrentsDB is the slice of dbgen.Querier the Torrents handler needs —
// just the by-anilist-id input lookup.  Declared at the use site (small
// interface) so handler tests can supply a one-method fake without the full
// Querier surface.
type TorrentsDB interface {
	GetTorrentQueryInputsByAnilistID(ctx context.Context, anilistID int32) (dbgen.GetTorrentQueryInputsByAnilistIDRow, error)
}

// Torrents implements GET /api/anime/torrents — multi-source magnet
// aggregator (animes.garden + acg.rip + nyaa.si + dmhy + mikan + AnimeTosho)
// wired into internal/torrents.  Replaces anime.controller.js:291-325 — the
// per-source partial-tolerance + per-query 1h cache live in the aggregator
// package.
//
// Two entry points share one response shape:
//
//   - ?anilistId=N (primary): resolve the anime's four cached titles into
//     deduped search variants and, when the id map carries an AniDB id, pull
//     AnimeTosho's complete aid feed alongside the keyword fan-out.  Server
//     -side title resolution is what unlocks full coverage — the client no
//     longer has to guess a single keyword.
//   - ?q=<keyword> (fallback): the legacy single-keyword fan-out, unchanged.
//
// Resolution precedence: anilistId wins when both are present (the richer
// path).  Neither present → 400.
//
// Query parameters:
//
//	anilistId  optional; integer AniList id (primary path)
//	q          optional; 1..200 chars (fallback path)
//
// Response envelope:
//
//	{"data":[{"title":..., "magnet":..., "size":..., "fansub":..., "date":..., "source":..., "seeders":..., "infohash":..., "provider":...}, ...]}
func Torrents(agg *torrents.Aggregator, db TorrentsDB) http.HandlerFunc {
	const maxQueryLen = 200

	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		qs := req.URL.Query()
		rawAnilistID := qs.Get("anilistId")
		q := qs.Get("q")

		var (
			items []torrents.TorrentItem
			err   error
		)

		switch {
		case rawAnilistID != "":
			// Primary path: resolve titles + anidb_id by id, then fan out
			// over the variant set.  An unparseable id is a client error.
			id, convErr := strconv.Atoi(rawAnilistID)
			if convErr != nil {
				httpx.Fail(w, httpx.NewError(
					http.StatusBadRequest,
					httpx.CodeValidationError,
					"无效的番剧 ID",
				))
				return
			}

			row, lookupErr := db.GetTorrentQueryInputsByAnilistID(ctx, int32(id))
			if lookupErr != nil {
				if errors.Is(lookupErr, pgx.ErrNoRows) {
					httpx.Fail(w, httpx.NewError(
						http.StatusNotFound,
						httpx.CodeNotFound,
						"番剧不存在",
					))
					return
				}
				httpx.Fail(w, httpx.WrapError(lookupErr, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
				return
			}

			variants := buildTorrentVariants(row)
			items, err = agg.FetchForAnime(ctx, variants, row.AnidbID)

		case q != "":
			// Fallback path: single-keyword fan-out (legacy behaviour).
			if len(q) > maxQueryLen {
				// Express: 'Query too long'
				httpx.Fail(w, httpx.NewError(
					http.StatusBadRequest,
					httpx.CodeValidationError,
					"Query too long",
				))
				return
			}
			items, err = agg.Fetch(ctx, q)

		default:
			// Neither param — Express: 'Missing query'.
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				"Missing query",
			))
			return
		}

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

// buildTorrentVariants turns an anime's four cached titles into the deduped
// search-variant set FetchForAnime fans out over.  Rules:
//
//   - Only non-nil, non-blank titles contribute (each is trimmed).
//   - De-duplication is case-insensitive (romaji and english are often the
//     same string in different cases; native and chinese can coincide for
//     CJK-original shows) — the FIRST spelling seen is kept so the variant
//     reads naturally in logs.
//   - The set is capped at maxTorrentVariants to bound the
//     variants × sources fan-out.
//
// Simplified/traditional Chinese folding is deliberately NOT done here yet
// (YAGNI — no evidence the upstreams index both forms differently enough to
// justify the conversion table).  TODO: revisit if zh-Hant titles start
// missing zh-Hans-indexed releases.
func buildTorrentVariants(row dbgen.GetTorrentQueryInputsByAnilistIDRow) []string {
	candidates := []*string{row.TitleRomaji, row.TitleNative, row.TitleEnglish, row.TitleChinese}

	out := make([]string, 0, maxTorrentVariants)
	seen := make(map[string]struct{}, maxTorrentVariants)
	for _, c := range candidates {
		if c == nil {
			continue
		}
		t := strings.TrimSpace(*c)
		if t == "" {
			continue
		}
		key := strings.ToLower(t)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, t)
		if len(out) == maxTorrentVariants {
			break
		}
	}
	return out
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
//
// titleHant / titleHantSource / titleHantSeo mirror the anime_cache
// columns added in migration 0022 — see anime.AnimeDetail for why the
// SEO-safe projection is carried as its own field rather than derived at
// the call site.
type trendingItem struct {
	Rank            int      `json:"rank"`
	WatcherCount    int64    `json:"watcherCount"`
	AnilistID       int32    `json:"anilistId"`
	TitleRomaji     *string  `json:"titleRomaji"`
	TitleEnglish    *string  `json:"titleEnglish"`
	TitleNative     *string  `json:"titleNative"`
	TitleChinese    *string  `json:"titleChinese"`
	TitleHant       *string  `json:"titleHant"`
	TitleHantSource *string  `json:"titleHantSource"`
	TitleHantSeo    *string  `json:"titleHantSeo"`
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

// episodeCountItem is one row in /api/anime/episodes' data array.
//
// Hand-declared rather than passing dbgen's row struct straight out, so the
// wire contract is pinned here instead of tracking whatever the SELECT list
// happens to contain — the same reason trendingItem and watcherItem exist.
//
// The shape is the regression guard for R3.  Exactly three fields, and the
// two counts stay separate:
//
//	episodes     AniList's authoritative total; the only value permitted to
//	             reach schema.org numberOfEpisodes downstream
//	episodesBgm  inferred from an external source (migration 0023); fine for
//	             UI, never for structured data
//
// Do not add a coalescing field here, however convenient.  A single
// `totalEpisodes` would erase the distinction at exactly the layer where
// the consumer that cares about it reads, and no call site further down
// would be able to tell an authoritative count from a guess.
type episodeCountItem struct {
	AnilistID   int32  `json:"anilistId"`
	Episodes    *int32 `json:"episodes"`
	EpisodesBgm *int32 `json:"episodesBgm"`
}

// watcherItem is one element of /api/anime/:anilistId/watchers' data
// array.  Express: map(s => ({username: s.userId.username})).
type watcherItem struct {
	Username         string  `json:"username"`
	AvatarURL        *string `json:"avatarUrl"`
	BackdropCoverURL *string `json:"backdropCoverUrl"`
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

// NewTrendingCache constructs the 1h ristretto cache used by Trending.
// Hides the package-private trendingItem type from callers (main.go)
// so they can wire the handler without referencing internals.
func NewTrendingCache() (*cache.Cache[[]trendingItem], error) {
	return cache.New[[]trendingItem](cache.Config{DefaultTTL: 1 * time.Hour})
}

// NewYearlyTopCache constructs the 1h ristretto cache used by YearlyTop.
// Keyed per year ("2024", "2025", ...); values are the full 20-row slice
// from GetYearlyTop, sliced per request at response time.
func NewYearlyTopCache() (*cache.Cache[[]dbgen.GetYearlyTopRow], error) {
	return cache.New[[]dbgen.GetYearlyTopRow](cache.Config{DefaultTTL: 1 * time.Hour})
}
