// Package dandanplay — HTTP handlers for the /api/dandanplay/* surface.
//
// Four endpoints back this package (P2.6.1):
//
//	POST /api/dandanplay/match              — Match  (3-phase orchestration, see match.go)
//	GET  /api/dandanplay/search             — Search (parallel cache + dandanplay)
//	GET  /api/dandanplay/comments/:episodeId — Comments (pass-through)
//	GET  /api/dandanplay/episodes/:animeId   — Episodes (pass-through, ?bgmId override)
//
// All four endpoints use NON-standard JSON envelopes (see envelope.go).
// The 3-phase Match orchestration lives in match.go; the helpers for
// siteAnime enrichment + AnimeCache search live in site_anime.go.
//
// The constructor takes a DBQuerier (sqlc subset, defined here at the
// use-site per "accept interfaces, return structs"), the dandanplay
// *Client, and the bangumi *Client.  main.go is responsible for the
// chi route wiring — this file owns request shape + dispatch only.
package dandanplay

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/sync/errgroup"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// matchTimeout caps the entire 3-phase orchestration.  Phase 1 (one
// dandanplay match + one episodes fetch + N per-file matches), Phase 2
// (one DB search + N episodes fetches + N per-file matches), Phase 3
// (M per-file matches) can stack to >20s even with the client's 800ms
// limiter.  Wrapping the handler in context.WithTimeout gives a hard
// ceiling so a runaway match doesn't hold an HTTP connection open
// indefinitely.  Enforced at the handler boundary (not in middleware)
// so the timeout is co-located with the orchestration code and shows
// up in a code-review grep for "Match".
const matchTimeout = 20 * time.Second

// commentsInvalidMsg / episodesNotFoundMsg are the two Express-quirky
// bare-error messages.  Preserved byte-for-byte so the frontend's
// error-key detection logic doesn't break on cutover.
const (
	commentsInvalidMsg   = "Invalid episodeId"
	episodesNotFoundMsg  = "Anime not found on dandanplay"
)

// DBQuerier is the sqlc subset the dandanplay handlers consume.
// Defined at the use-site (Accept interfaces, return structs) so tests
// can substitute a fake without dragging the full dbgen.Querier surface
// into the test setup.  dbgen.Querier satisfies it.
//
// Four methods cover the four endpoints + their helpers:
//
//	SearchAnimeCacheForDandanplay — Phase 1 siteAnime + Phase 2 search
//	GetAnimeByBgmID                — findSiteAnime level-3 fallback
//	GetAnimeGenresByID             — pickSiteAnime enrichment
//	GetAnimeStudiosByID            — pickSiteAnime enrichment
type DBQuerier interface {
	SearchAnimeCacheForDandanplay(ctx context.Context, pattern *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error)
	GetAnimeByBgmID(ctx context.Context, bgmID *int32) (dbgen.GetAnimeByBgmIDRow, error)
	GetAnimeGenresByID(ctx context.Context, animeID int32) ([]string, error)
	GetAnimeStudiosByID(ctx context.Context, animeID int32) ([]string, error)
}

// BangumiSearcher is the bangumi *Client subset findSiteAnime needs.
// Defined here so tests don't need a live HTTP server to exercise the
// level-3 fallback path.  *bangumi.Client satisfies it.
type BangumiSearcher interface {
	Search(ctx context.Context, keyword string) (*bangumi.SearchResponse, error)
}

// DandanClient is the dandanplay *Client subset the handlers consume.
// All five methods are required to support the four endpoints + the
// per-file matchUnmappedFiles fallback inside /match.
type DandanClient interface {
	MatchCombined(ctx context.Context, fileName, fileHash string, fileSize int64) (*MatchResult, error)
	FetchEpisodesByBgmID(ctx context.Context, bgmID int32) (*EpisodeData, error)
	FetchEpisodesByDandanAnimeID(ctx context.Context, animeID int64) (*EpisodeData, error)
	SearchAnime(ctx context.Context, keyword string) ([]DandanAnime, error)
	FetchComments(ctx context.Context, episodeID int64) (*CommentsResponse, error)
}

// Handlers carries the deps shared by every /api/dandanplay handler.
// Construct once at startup via NewHandlers and register each method
// on the chi router.  None of the endpoints require auth — match /
// search / comments / episodes are all public.
//
// BangumiClient is allowed to be nil for tests that don't exercise the
// findSiteAnime level-3 fallback — the helper short-circuits when the
// pointer is nil.  Production main.go MUST always pass a real client.
type Handlers struct {
	DB            DBQuerier
	Client        DandanClient
	BangumiClient BangumiSearcher
}

// NewHandlers constructs a Handlers bundle.  db + client are required;
// bangumiClient may be nil (the level-3 findSiteAnime fallback then
// short-circuits to nil and /match emits siteAnime:null in the
// otherwise-rare Phase 1 success + no-cache-hit branch).
//
// Fail-fast on the two hard-required deps so a misconfigured startup
// surfaces in the smoke test rather than at the first request.
func NewHandlers(db DBQuerier, client DandanClient, bangumiClient BangumiSearcher) *Handlers {
	if db == nil {
		panic("dandanplay.NewHandlers: nil DBQuerier")
	}
	if client == nil {
		panic("dandanplay.NewHandlers: nil DandanClient")
	}
	return &Handlers{
		DB:            db,
		Client:        client,
		BangumiClient: bangumiClient,
	}
}

// ─── GET /api/dandanplay/search?keyword=… ──────────────────────────────────

// searchResponse is the top-level envelope for /search.  Express
// emitted `{ results: [...] }` — NOT the standard `{data:…}` wrap.
// Slice order is load-bearing: cacheResults first, dandanResults
// second (frontend renders them in two separate sections and relies on
// `source` to discriminate).
type searchResponse struct {
	Results []searchResultItem `json:"results"`
}

// searchResultItem unions the two source shapes Express returned —
// 18-field cache rows and 6-field dandanplay rows.  Tagged-union shape
// via the `source` discriminator (animeCache | dandanplay); fields
// only set when relevant for the source.  Empty cache fields use
// pointer zero-value; empty dandanplay fields are absent — that
// mirrors Express's behaviour where `cacheResults.map(...)` only set
// cache fields and the spread of the dandan map only set dandan fields.
//
// Implementing this as one struct with omitempty on the dandanplay-
// only fields would emit them as empty on cache rows, which would NOT
// match Express byte-for-byte.  Custom MarshalJSON is cleaner.
type searchResultItem struct {
	source string

	// Shared.
	title string

	// animeCache-source-only.
	cacheRow *dbgen.SearchAnimeCacheForDandanplayRow

	// dandanplay-source-only.
	dandanAnime *DandanAnime
}

// MarshalJSON emits the exact field set Express did for each source.
// cache rows: 20 fields, dandan rows: 6 fields.  Field order matches
// the Express controller (lines 182-212) so a byte-level shadow-diff
// stays green — both inner structs use declaration order to lock the
// JSON output.
func (i searchResultItem) MarshalJSON() ([]byte, error) {
	switch i.source {
	case "animeCache":
		row := i.cacheRow
		out := cacheSearchItem{
			Source:        "animeCache",
			AnilistID:     row.AnilistID,
			Title:         i.title,
			TitleChinese:  row.TitleChinese,
			TitleNative:   row.TitleNative,
			TitleRomaji:   row.TitleRomaji,
			CoverImageUrl: row.CoverImageUrl,
			Episodes:      row.Episodes,
			BgmID:         row.BgmID,
			Season:        row.Season,
			SeasonYear:    row.SeasonYear,
			Format:        row.Format,
			AverageScore:  row.AverageScore,
			BangumiScore:  row.BangumiScore,
			BangumiVotes:  row.BangumiVotes,
			// Cache-row search items historically did not enrich
			// genres / studios server-side — Mongoose only emitted
			// the array if it was present.  We mirror that by always
			// emitting an empty slice (stable shape), matching
			// Express's `.lean()` projection when the array wasn't
			// populated.  The Phase 1 /match siteAnime path loads
			// genres + studios separately via pickSiteAnime; /search
			// stays cheap.
			Genres:      []string{},
			Studios:     []string{},
			AnimeSource: row.Source,
			Duration:    row.Duration,
			Status:      row.Status,
		}
		return marshalNoHTMLEscape(out)
	case "dandanplay":
		a := i.dandanAnime
		out := dandanSearchItem{
			Source:        "dandanplay",
			DandanAnimeID: a.DandanAnimeID,
			Title:         a.Title,
			Episodes:      a.Episodes,
			ImageURL:      a.ImageURL,
			Type:          a.Type,
		}
		return marshalNoHTMLEscape(out)
	default:
		return []byte("null"), nil
	}
}

// cacheSearchItem is the JSON shape for animeCache rows in /search
// results.  Declaration order is load-bearing — it controls the
// JSON output order so the shadow-diff vs Express stays byte-clean.
type cacheSearchItem struct {
	Source        string   `json:"source"`
	AnilistID     int32    `json:"anilistId"`
	Title         string   `json:"title"`
	TitleChinese  *string  `json:"titleChinese"`
	TitleNative   *string  `json:"titleNative"`
	TitleRomaji   *string  `json:"titleRomaji"`
	CoverImageUrl *string  `json:"coverImageUrl"`
	Episodes      *int32   `json:"episodes"`
	BgmID         *int32   `json:"bgmId"`
	Season        *string  `json:"season"`
	SeasonYear    *int32   `json:"seasonYear"`
	Format        *string  `json:"format"`
	AverageScore  *float64 `json:"averageScore"`
	BangumiScore  *float64 `json:"bangumiScore"`
	BangumiVotes  *int32   `json:"bangumiVotes"`
	Genres        []string `json:"genres"`
	Studios       []string `json:"studios"`
	AnimeSource   *string  `json:"animeSource"`
	Duration      *int32   `json:"duration"`
	Status        *string  `json:"status"`
}

// dandanSearchItem is the JSON shape for dandanplay rows in /search
// results.  Declaration order matches Express controller lines
// 205-212.
type dandanSearchItem struct {
	Source        string `json:"source"`
	DandanAnimeID int64  `json:"dandanAnimeId"`
	Title         string `json:"title"`
	Episodes      int    `json:"episodes"`
	ImageURL      string `json:"imageUrl"`
	Type          string `json:"type"`
}

// Search implements GET /api/dandanplay/search?keyword=…
//
// Empty keyword → 200 `{ "results": [] }` (no error, matches Express's
// `if (!keyword) return res.json({results:[]})`).  Otherwise runs the
// AnimeCache search and the dandanplay /api/v2/search/anime call in
// parallel via errgroup, then concatenates in the load-bearing order
// (cache first).
//
// On any DB or upstream error, emits a 500 bare-error envelope (matches
// Express's `next(err)` → globalErrorHandler default behaviour).
func (h *Handlers) Search(w http.ResponseWriter, r *http.Request) {
	keyword := trimMaxRunes(r.URL.Query().Get("keyword"), keywordMaxRunes)
	if keyword == "" {
		writeJSON(w, http.StatusOK, searchResponse{Results: []searchResultItem{}})
		return
	}

	var (
		cacheRows []dbgen.SearchAnimeCacheForDandanplayRow
		dandanRow []DandanAnime
	)
	g, gctx := errgroup.WithContext(r.Context())
	g.Go(func() error {
		rows, err := h.searchAnimeCache(gctx, keyword)
		if err != nil {
			return err
		}
		cacheRows = rows
		return nil
	})
	g.Go(func() error {
		rows, err := h.Client.SearchAnime(gctx, keyword)
		if err != nil {
			return err
		}
		dandanRow = rows
		return nil
	})
	if err := g.Wait(); err != nil {
		writeBareErrorJSON(w, http.StatusInternalServerError, "search failed")
		return
	}

	results := make([]searchResultItem, 0, len(cacheRows)+len(dandanRow))
	for i := range cacheRows {
		row := cacheRows[i]
		title := ""
		if row.TitleNative != nil && *row.TitleNative != "" {
			title = *row.TitleNative
		} else if row.TitleRomaji != nil {
			title = *row.TitleRomaji
		}
		results = append(results, searchResultItem{
			source:   "animeCache",
			title:    title,
			cacheRow: &row,
		})
	}
	for i := range dandanRow {
		a := dandanRow[i]
		results = append(results, searchResultItem{
			source:      "dandanplay",
			title:       a.Title,
			dandanAnime: &a,
		})
	}
	writeJSON(w, http.StatusOK, searchResponse{Results: results})
}

// ─── GET /api/dandanplay/comments/:episodeId ───────────────────────────────

// GetComments implements GET /api/dandanplay/comments/:episodeId.
//
// Path validation: parses :episodeId as int64; rejects NaN / 0 / negative
// with a bare 400 envelope (matches Express's `error: 'Invalid episodeId'`
// — NOT the standard `error:{code,message}` shape).
//
// Upstream miss / 4xx: the dandanplay *Client already returns the
// `{count:0,comments:[]}` fallback (see client.go FetchComments), so
// the response shape stays consistent.
//
// On 5xx / network failure surfacing from the client, emits a 500
// bare-error envelope.
func (h *Handlers) GetComments(w http.ResponseWriter, r *http.Request) {
	raw := chi.URLParam(r, "episodeId")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		writeBareErrorJSON(w, http.StatusBadRequest, commentsInvalidMsg)
		return
	}
	data, err := h.Client.FetchComments(r.Context(), id)
	if err != nil {
		writeBareErrorJSON(w, http.StatusInternalServerError, "comments fetch failed")
		return
	}
	// Pass-through emit — no envelope wrap.
	writeJSON(w, http.StatusOK, data)
}

// ─── GET /api/dandanplay/episodes/:animeId?bgmId=… ─────────────────────────

// GetEpisodes implements GET /api/dandanplay/episodes/:animeId.
//
// Branching: bgmId query string takes precedence over :animeId path
// param (mirrors Express's `if (bgmId) ... else if (animeId) ...`).
// Either may be parsed independently; both invalid → 404 below.
//
// nil EpisodeData (4xx upstream or "bangumi:null") → 404 with the
// bare `{"error":"Anime not found on dandanplay"}` envelope.  500 on
// transport / 5xx upstream.
func (h *Handlers) GetEpisodes(w http.ResponseWriter, r *http.Request) {
	bgmRaw := r.URL.Query().Get("bgmId")
	animeRaw := chi.URLParam(r, "animeId")

	var (
		ep  *EpisodeData
		err error
	)
	switch {
	case bgmRaw != "":
		bgmID, perr := strconv.ParseInt(bgmRaw, 10, 32)
		if perr != nil || bgmID <= 0 {
			writeBareErrorJSON(w, http.StatusNotFound, episodesNotFoundMsg)
			return
		}
		ep, err = h.Client.FetchEpisodesByBgmID(r.Context(), int32(bgmID))
	case animeRaw != "":
		animeID, perr := strconv.ParseInt(animeRaw, 10, 64)
		if perr != nil || animeID <= 0 {
			writeBareErrorJSON(w, http.StatusNotFound, episodesNotFoundMsg)
			return
		}
		ep, err = h.Client.FetchEpisodesByDandanAnimeID(r.Context(), animeID)
	default:
		writeBareErrorJSON(w, http.StatusNotFound, episodesNotFoundMsg)
		return
	}

	if err != nil {
		writeBareErrorJSON(w, http.StatusInternalServerError, "episodes fetch failed")
		return
	}
	if ep == nil {
		writeBareErrorJSON(w, http.StatusNotFound, episodesNotFoundMsg)
		return
	}
	writeJSON(w, http.StatusOK, ep)
}
