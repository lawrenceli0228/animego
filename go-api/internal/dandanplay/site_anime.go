// Package dandanplay — siteAnime helpers + AnimeCache search.
//
// Three helpers live here:
//
//   - searchAnimeCache: tokenise the keyword (regex `[\p{L}\p{N}]+`),
//     build the ILIKE pattern `%token1%token2%...%`, call
//     SearchAnimeCacheForDandanplay.  Empty / token-less keyword
//     returns []SearchAnimeCacheForDandanplayRow{} (no error).
//
//   - findSiteAnime: 3-level fallback Express used to enrich Phase 1
//     responses.  title → user keyword → Bangumi search → bgmId lookup.
//     The Bangumi leg is wrapped in context.WithTimeout(ctx, 2s) so a
//     slow bgm.tv never blocks /match.  All errors are swallowed — the
//     enrichment is best-effort.
//
//   - pickSiteAnime / pickSiteAnimeFromCacheRow: project the row into
//     the legacy Express response shape (18 fields, camelCase JSON
//     tags).  Genres / studios are loaded via parallel errgroup calls
//     to GetAnimeGenresByID / GetAnimeStudiosByID so the 2 extra
//     round-trips don't serialise.
package dandanplay

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// bgmFallbackTimeout caps the Bangumi search leg of findSiteAnime.
// Matches Express's BGM_FALLBACK_TIMEOUT_MS=2000 byte-for-byte.
const bgmFallbackTimeout = 2 * time.Second

// keywordTokenRe matches the Unicode-aware token rule Express used:
// `/[\p{L}\p{N}]+/gu`.  Letters + numbers, any script, repeated.  Each
// run becomes one ILIKE token in the assembled pattern.
var keywordTokenRe = regexp.MustCompile(`[\p{L}\p{N}]+`)

// keywordMaxRunes mirrors Express's `.slice(0, 100)` cap — defensive
// upper bound on the keyword length so a pathological query cannot
// build a 10kb ILIKE pattern.
const keywordMaxRunes = 100

// siteAnimePayload is the projection /match emits as `siteAnime`.
// Matches Express's pickSiteAnime field-for-field (camelCase JSON
// tags).  All fields are pointers so JSON null is faithful when the
// upstream column was NULL (matches Mongoose's `.lean()` output).
type siteAnimePayload struct {
	AnilistID     int32    `json:"anilistId"`
	TitleChinese  *string  `json:"titleChinese"`
	TitleNative   *string  `json:"titleNative"`
	TitleRomaji   *string  `json:"titleRomaji"`
	CoverImageUrl *string  `json:"coverImageUrl"`
	Episodes      *int32   `json:"episodes"`
	Status        *string  `json:"status"`
	Season        *string  `json:"season"`
	SeasonYear    *int32   `json:"seasonYear"`
	AverageScore  *float64 `json:"averageScore"`
	BangumiScore  *float64 `json:"bangumiScore"`
	BangumiVotes  *int32   `json:"bangumiVotes"`
	Genres        []string `json:"genres"`
	Format        *string  `json:"format"`
	BgmID         *int32   `json:"bgmId"`
	Studios       []string `json:"studios"`
	Source        *string  `json:"source"`
	Duration      *int32   `json:"duration"`
}

// buildKeywordPattern emits the ILIKE pattern the dandanplay SQL
// expects.  Tokenises the keyword on Unicode letters + digits, joins
// the tokens with `%` separators, and adds leading + trailing `%`
// wildcards.  Returns the pattern and a true ok flag, or an empty
// string + false when the keyword has no extractable tokens.
//
// Example:
//
//	"Kaguya-sama wa" → []{"Kaguya","sama","wa"} → "%Kaguya%sama%wa%"
//
// The Unicode letter class survives CJK input (進撃の巨人 → one token),
// so this stays consistent with Express's Unicode regex semantics.
func buildKeywordPattern(keyword string) (string, bool) {
	if keyword == "" {
		return "", false
	}
	// Defensive rune-cap — keyword could be user-controlled input.
	keyword = trimMaxRunes(keyword, keywordMaxRunes)
	tokens := keywordTokenRe.FindAllString(keyword, -1)
	if len(tokens) == 0 {
		return "", false
	}
	return "%" + strings.Join(tokens, "%") + "%", true
}

// searchAnimeCache runs the tokenised ILIKE search against anime_cache.
// Returns an empty slice (NOT nil) when the keyword is empty or has no
// tokens — matches Express's `if (!keyword) return [];` early exit.
// Surfacing the DB error to the caller keeps Phase 2 deterministic;
// the findSiteAnime helper swallows it so the /match flow can still
// progress.
func (h *Handlers) searchAnimeCache(ctx context.Context, keyword string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
	pattern, ok := buildKeywordPattern(keyword)
	if !ok {
		return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil
	}
	rows, err := h.DB.SearchAnimeCacheForDandanplay(ctx, &pattern)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// findSiteAnime is the 3-level fallback Express ran after Phase 1 to
// enrich the response with a local AnimeCache row.  Never returns an
// error — all failures degrade to (nil, nil) so the /match call keeps
// progressing.  Bangumi leg is cap-timed via context.WithTimeout so a
// slow bgm.tv cannot stall the orchestration.
//
// Order:
//  1. searchAnimeCache(title) — dandanplay-provided title.
//  2. searchAnimeCache(userKeyword) — only when keyword != title.
//  3. bangumi.Search(title) → first hit's id → GetAnimeByBgmID.
//
// The Bangumi call inherits the parent context so cancellation
// propagates correctly when /match's overall 20s cap fires.
func (h *Handlers) findSiteAnime(ctx context.Context, title, userKeyword string) *dbgen.SearchAnimeCacheForDandanplayRow {
	// Level 1: title (the dandanplay-side AnimeTitle, usually JA).
	if title != "" {
		rows, err := h.searchAnimeCache(ctx, title)
		if err != nil {
			slog.WarnContext(ctx, "dandanplay findSiteAnime title search error",
				"err", err, "title", title)
		} else if len(rows) > 0 {
			row := rows[0]
			return &row
		}
	}
	// Level 2: user-supplied keyword.  Skip if identical to title so
	// we don't burn a second ILIKE on the same string.
	if userKeyword != "" && userKeyword != title {
		rows, err := h.searchAnimeCache(ctx, userKeyword)
		if err != nil {
			slog.WarnContext(ctx, "dandanplay findSiteAnime keyword search error",
				"err", err, "keyword", userKeyword)
		} else if len(rows) > 0 {
			row := rows[0]
			return &row
		}
	}
	// Level 3: Bangumi search → bgmId → anime_cache lookup.  Anything
	// can fail here (Bangumi down, hit list empty, bgmId unknown
	// locally) — every branch returns nil so the caller emits
	// siteAnime:null.
	return h.bangumiFallback(ctx, title, userKeyword)
}

// bangumiFallback is the level-3 leg of findSiteAnime extracted so the
// 2s context.WithTimeout sits at a clear cancellation boundary.  Empty
// title → skip the call entirely (mirrors Express's
// `if (!keyword) return null` inside fetchBangumiData).
func (h *Handlers) bangumiFallback(ctx context.Context, title, userKeyword string) *dbgen.SearchAnimeCacheForDandanplayRow {
	if h.BangumiClient == nil {
		return nil
	}
	// fetchBangumiData prioritised titleNative, then titleRomaji.  The
	// /match handler passes the dandanplay-side title as the first arg
	// and the user keyword as the second — preserve that order.
	keyword := title
	if keyword == "" {
		keyword = userKeyword
	}
	if keyword == "" {
		return nil
	}
	bgmCtx, cancel := context.WithTimeout(ctx, bgmFallbackTimeout)
	defer cancel()
	resp, err := h.BangumiClient.Search(bgmCtx, keyword)
	if err != nil {
		// Includes ErrNotFound, deadline, transport.  None are fatal
		// to /match — just emit siteAnime:null.
		slog.DebugContext(bgmCtx, "dandanplay bangumi fallback miss",
			"err", err, "keyword", keyword)
		return nil
	}
	if resp == nil || len(resp.List) == 0 {
		return nil
	}
	hit := resp.List[0]
	// Prefer the exact-native match if one exists in the list (matches
	// Express's `list.find(r => r.name === titleNative) || list[0]`).
	if title != "" {
		for _, r := range resp.List {
			if r.Name == title {
				hit = r
				break
			}
		}
	}
	if hit.ID == 0 {
		return nil
	}
	bgmID := int32(hit.ID)
	row, err := h.DB.GetAnimeByBgmID(bgmCtx, &bgmID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.WarnContext(bgmCtx, "dandanplay bangumi fallback GetAnimeByBgmID error",
				"err", err, "bgmId", bgmID)
		}
		return nil
	}
	// Re-shape GetAnimeByBgmIDRow → SearchAnimeCacheForDandanplayRow
	// so the caller's projection helper has one input type to handle.
	return rowFromBgmRow(row)
}

// rowFromBgmRow maps the GetAnimeByBgmIDRow projection into the
// SearchAnimeCacheForDandanplayRow shape (identical column set, just a
// different sqlc-generated struct).  Lets pickSiteAnime stay single-
// type.
func rowFromBgmRow(in dbgen.GetAnimeByBgmIDRow) *dbgen.SearchAnimeCacheForDandanplayRow {
	out := dbgen.SearchAnimeCacheForDandanplayRow{
		AnilistID:       in.AnilistID,
		TitleRomaji:     in.TitleRomaji,
		TitleEnglish:    in.TitleEnglish,
		TitleNative:     in.TitleNative,
		TitleChinese:    in.TitleChinese,
		CoverImageUrl:   in.CoverImageUrl,
		CoverImageColor: in.CoverImageColor,
		PosterAccent:    in.PosterAccent,
		Episodes:        in.Episodes,
		Status:          in.Status,
		Season:          in.Season,
		SeasonYear:      in.SeasonYear,
		Format:          in.Format,
		AverageScore:    in.AverageScore,
		BangumiScore:    in.BangumiScore,
		BangumiVotes:    in.BangumiVotes,
		BgmID:           in.BgmID,
		Source:          in.Source,
		Duration:        in.Duration,
	}
	return &out
}

// pickSiteAnime projects a cache row + (parallel-loaded) genres /
// studios into the response shape.  Returns nil when row is nil (the
// "no enrichment available" branch of /match) so the JSON envelope
// emits siteAnime:null.
//
// Genres + studios fetch in parallel via errgroup so the two extra
// child-table round-trips don't serialise.  Errors are downgraded to
// empty slices and logged — siteAnime is best-effort and we'd rather
// emit a partial result than fail the whole /match.
func (h *Handlers) pickSiteAnime(ctx context.Context, row *dbgen.SearchAnimeCacheForDandanplayRow) *siteAnimePayload {
	if row == nil {
		return nil
	}
	var (
		genres  []string
		studios []string
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		got, err := h.DB.GetAnimeGenresByID(gctx, row.AnilistID)
		if err != nil {
			slog.WarnContext(gctx, "dandanplay pickSiteAnime genres error",
				"err", err, "anilistId", row.AnilistID)
			genres = []string{}
			return nil
		}
		genres = got
		return nil
	})
	g.Go(func() error {
		got, err := h.DB.GetAnimeStudiosByID(gctx, row.AnilistID)
		if err != nil {
			slog.WarnContext(gctx, "dandanplay pickSiteAnime studios error",
				"err", err, "anilistId", row.AnilistID)
			studios = []string{}
			return nil
		}
		studios = got
		return nil
	})
	_ = g.Wait() // errgroup callbacks always return nil; ignore.

	if genres == nil {
		genres = []string{}
	}
	if studios == nil {
		studios = []string{}
	}
	return &siteAnimePayload{
		AnilistID:     row.AnilistID,
		TitleChinese:  row.TitleChinese,
		TitleNative:   row.TitleNative,
		TitleRomaji:   row.TitleRomaji,
		CoverImageUrl: row.CoverImageUrl,
		Episodes:      row.Episodes,
		Status:        row.Status,
		Season:        row.Season,
		SeasonYear:    row.SeasonYear,
		AverageScore:  row.AverageScore,
		BangumiScore:  row.BangumiScore,
		BangumiVotes:  row.BangumiVotes,
		Genres:        genres,
		Format:        row.Format,
		BgmID:         row.BgmID,
		Studios:       studios,
		Source:        row.Source,
		Duration:      row.Duration,
	}
}
