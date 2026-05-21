package anime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	"github.com/lawrenceli0228/animego/go-api/internal/colorx"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// scheduleCacheTTL mirrors Express's SCHEDULE_TTL (30 minutes) in
// server/services/anilist.service.js:402.  Cache key is the local-tz
// 'YYYY-MM-DD' string so the entry naturally expires when the date rolls
// over (and TTL kicks in mid-day).
const scheduleCacheTTL = 30 * time.Minute

// scheduleQueryTimeout is the per-request context timeout for /schedule.
// Schedule is unique among the anime endpoints: it paginates AniList
// (typically 1-2 pages but defensive cap at 10) and each AniList call
// has a 10s HTTP client timeout, so the request-level budget must be
// wider than handlers.go's standard 5s queryTimeout.  20s gives us
// comfortable headroom for the AniList side plus the titleChinese DB
// lookup without leaving callers blocked indefinitely on a stuck
// upstream.
const scheduleQueryTimeout = 20 * time.Second

// schedulePageCap is the defensive sanity ceiling on the AniList
// pagination loop.  AniList weekly schedule fits in 1-2 pages of 50
// items each, but a buggy upstream returning HasNextPage=true forever
// would otherwise loop unboundedly.  10 pages = up to 500 schedule
// entries which already exceeds the largest week ever observed.
const schedulePageCap = 10

// AniListScheduler is the narrow interface ScheduleService consumes —
// only the Schedule method.  *anilist.Client satisfies this, and tests
// substitute a fake implementation that returns canned pages.
//
// Defined here (not in internal/anilist) per the Go convention "accept
// interfaces, return structs at the consumer side".
type AniListScheduler interface {
	Schedule(ctx context.Context, v anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error)
}

// ScheduleService composes the AniList client, ristretto cache, and
// sqlc-generated Querier into one /api/anime/schedule handler.  The
// cache is keyed by local-tz 'YYYY-MM-DD' with a 30-minute TTL, matching
// Express's SCHEDULE_TTL.  Cache hits skip both the AniList pagination
// and the DB titleChinese lookup, so warm-day requests serve in
// sub-millisecond time.
type ScheduleService struct {
	anilist AniListScheduler
	cache   *cache.Cache[ScheduleResponse]
	db      dbgen.Querier

	// tzOverride is test-only — production uses time.Local.  Tests pin
	// time.UTC so the local-date grouping logic is deterministic across
	// CI machines in different timezones.
	tzOverride *time.Location

	// nowFn is test-only — production uses time.Now.  Tests pass a fixed
	// time.Time so the today-key and cache hits are reproducible.
	nowFn func() time.Time
}

// ScheduleItem is one entry inside groups[dateStr] of the schedule
// response.  Field order matches Express anilist.service.js byte-for-byte:
//
//	scheduleId, airingAt, episode, anilistId, titleRomaji, titleEnglish,
//	titleNative, titleChinese, coverImageUrl, coverImageColor,
//	posterAccent, posterAccentRgb, posterAccentContrastOnBlack, format,
//	averageScore, genres
//
// Pointer types follow the same "nullable on the wire" rules normalize.go
// uses — *string for cover/colour/title fields, *int for averageScore.
type ScheduleItem struct {
	ScheduleID                  int      `json:"scheduleId"`
	AiringAt                    int64    `json:"airingAt"`
	Episode                     int      `json:"episode"`
	AnilistID                   int      `json:"anilistId"`
	TitleRomaji                 *string  `json:"titleRomaji"`
	TitleEnglish                *string  `json:"titleEnglish"`
	TitleNative                 *string  `json:"titleNative"`
	TitleChinese                *string  `json:"titleChinese"`
	CoverImageUrl               *string  `json:"coverImageUrl"`
	CoverImageColor             *string  `json:"coverImageColor"`
	PosterAccent                string   `json:"posterAccent"`
	PosterAccentRgb             string   `json:"posterAccentRgb"`
	PosterAccentContrastOnBlack float64  `json:"posterAccentContrastOnBlack"`
	Format                      *string  `json:"format"`
	AverageScore                *int     `json:"averageScore"`
	Genres                      []string `json:"genres"`
}

// ScheduleResponse is the {today, groups} payload.  It is reused as
// both the cache value AND the wire-level "data" payload that the
// handler wraps with httpx.Data — the final envelope is
// {"data":{"today":"...","groups":{...}}}.
type ScheduleResponse struct {
	Today  string                    `json:"today"`
	Groups map[string][]ScheduleItem `json:"groups"`
}

// NewScheduleService builds a ScheduleService with a 30-minute ristretto
// cache.  The caller passes the AniList client (or test stub) and the
// sqlc Querier; the cache is constructed internally because its lifetime
// is tied to the service itself.
func NewScheduleService(client AniListScheduler, db dbgen.Querier) (*ScheduleService, error) {
	c, err := cache.New[ScheduleResponse](cache.Config{DefaultTTL: scheduleCacheTTL})
	if err != nil {
		return nil, fmt.Errorf("anime/schedule: build cache: %w", err)
	}
	return &ScheduleService{
		anilist: client,
		cache:   c,
		db:      db,
		nowFn:   time.Now,
	}, nil
}

// Handler returns the chi-compatible http.HandlerFunc.  The handler
// wraps the request context with a 20s timeout (broader than the 5s
// queryTimeout used by simple DB-only endpoints because /schedule
// paginates AniList) and writes the {data: {today, groups}} envelope.
//
// Upstream AniList failures map to 502 BAD_GATEWAY via httpx.WrapError.
// DB titleChinese failures degrade gracefully — the schedule still
// returns 200 with titleChinese fields left nil, which the frontend
// already handles for unenriched cache rows.
//
// TODO P2.1.5: enqueue Bangumi V1 enrichment for entries with
// bangumi_version=0 (workers currently stubs).
func (s *ScheduleService) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), scheduleQueryTimeout)
		defer cancel()

		resp, err := s.fetchSchedule(ctx)
		if err != nil {
			// AniList upstream errors (transport, GraphQL field
			// errors, 4xx/5xx) all surface as *anilist.ErrUpstream.
			// Map to 502 BAD_GATEWAY so the frontend can distinguish
			// upstream issues from internal server bugs.
			var upstream *anilist.ErrUpstream
			if errors.As(err, &upstream) {
				httpx.Fail(w, httpx.WrapError(err, http.StatusBadGateway, httpx.CodeServerError, "AniList upstream error"))
				return
			}
			if errors.Is(err, anilist.ErrRateLimited) {
				httpx.Fail(w, httpx.WrapError(err, http.StatusBadGateway, httpx.CodeServerError, "AniList rate limited"))
				return
			}
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "schedule fetch failed"))
			return
		}

		httpx.Data(w, http.StatusOK, resp)
	}
}

// fetchSchedule runs the cache → AniList pagination → group → DB
// titleChinese pipeline.  Separated from the HTTP handler so tests can
// exercise the business logic without spinning up httptest recorders.
func (s *ScheduleService) fetchSchedule(ctx context.Context) (*ScheduleResponse, error) {
	tz := s.tz()
	now := s.now().In(tz)

	// Today midnight in the local timezone — used as both the cache
	// key and the lower bound for AniList's airingAt_greater filter.
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, tz)
	todayKey := today.Format("2006-01-02")

	// Cache hit: return the cached payload verbatim.  Ristretto's
	// 30-minute TTL handles intra-day refresh; cross-day refreshes
	// happen automatically because todayKey changes at local midnight.
	if cached, ok := s.cache.Get(todayKey); ok {
		return &cached, nil
	}

	// Week window: [today_midnight, today_midnight + 7d) in Unix
	// seconds.  AniList's airingAt_greater / airingAt_lesser are
	// exclusive bounds per the GraphQL schema documentation.
	weekStart := today.Unix()
	weekEnd := weekStart + 7*24*60*60

	// Paginate until HasNextPage=false, with a sanity cap of 10 pages
	// to defend against an upstream loop bug.  Schedule typically fits
	// in 1-2 pages of 50 entries each.
	var allSchedules []anilist.AiringSchedule
	for page := 1; page <= schedulePageCap; page++ {
		resp, err := s.anilist.Schedule(ctx, anilist.ScheduleVars{
			WeekStart: weekStart,
			WeekEnd:   weekEnd,
			Page:      page,
		})
		if err != nil {
			return nil, fmt.Errorf("anime/schedule: anilist page %d: %w", page, err)
		}
		allSchedules = append(allSchedules, resp.Page.AiringSchedules...)
		if !resp.Page.PageInfo.HasNextPage {
			break
		}
	}

	// Group by local-date string, skipping adult content.  Express
	// uses ?. + truthy check; the Go port mirrors the same nil-safety
	// pattern via explicit pointer dereferences.
	groups := make(map[string][]ScheduleItem)
	for _, item := range allSchedules {
		if isAdult(item.Media) {
			continue
		}
		key := time.Unix(item.AiringAt, 0).In(tz).Format("2006-01-02")
		groups[key] = append(groups[key], toScheduleItem(item))
	}

	// titleChinese lookup: collect unique anilist IDs across all
	// groups (dedupe via map) and resolve titleChinese in a single
	// SQL query.  Failure degrades gracefully — we log the error and
	// continue with titleChinese fields left as nil rather than
	// failing the whole request.
	if len(groups) > 0 {
		ids := uniqueAnilistIDs(groups)
		if len(ids) > 0 {
			rows, err := s.db.GetTitleChineseByAnilistIDs(ctx, ids)
			if err != nil {
				slog.Warn("anime/schedule: titleChinese lookup failed; returning without enrichment",
					"err", err,
					"ids_count", len(ids),
				)
			} else {
				titleByID := make(map[int32]*string, len(rows))
				for _, r := range rows {
					titleByID[r.AnilistID] = r.TitleChinese
				}
				for key, items := range groups {
					for i := range items {
						if tc, ok := titleByID[int32(items[i].AnilistID)]; ok {
							items[i].TitleChinese = tc
						}
					}
					groups[key] = items
				}
			}
		}
	}

	// Stable order: each group's items sorted by airingAt asc so the
	// UI renders chronologically within a day.  Go map iteration is
	// random, but encoding/json sorts map keys alphabetically when
	// marshaling — that's what we want for date keys.
	for key, items := range groups {
		sort.SliceStable(items, func(i, j int) bool {
			return items[i].AiringAt < items[j].AiringAt
		})
		groups[key] = items
	}

	result := ScheduleResponse{Today: todayKey, Groups: groups}
	s.cache.Set(todayKey, result)
	return &result, nil
}

// tz returns the effective timezone — tzOverride if set (tests), else
// time.Local.  Centralised so production and test paths can't drift.
func (s *ScheduleService) tz() *time.Location {
	if s.tzOverride != nil {
		return s.tzOverride
	}
	return time.Local
}

// now returns the effective wall clock — nowFn if set (tests), else
// time.Now.  Tests pin this to a fixed Time so cache + date logic is
// deterministic.
func (s *ScheduleService) now() time.Time {
	if s.nowFn != nil {
		return s.nowFn()
	}
	return time.Now()
}

// isAdult reports whether an AniList Media entry is flagged adult.  The
// JS check `if (item.media.isAdult) return;` skips the schedule item
// whenever the pointer is non-nil AND the value is true; nil pointers
// (absent in the query response) count as non-adult.
func isAdult(m anilist.Media) bool {
	return m.IsAdult != nil && *m.IsAdult
}

// toScheduleItem converts one AniList AiringSchedule into the
// ScheduleItem wire shape.  All title / cover / format fields pass
// through as pointers; the accent triple is computed via
// colorx.NormalizePosterAccent which guarantees non-empty strings even
// for null / invalid input (brand-violet fallback).
func toScheduleItem(s anilist.AiringSchedule) ScheduleItem {
	// Cover image URL: extraLarge ?? large, matching Express's
	// `m.coverImage?.extraLarge || m.coverImage?.large` (JS `||` is
	// falsy-skip — empty string falls through to large).
	coverURL := scheduleCoverURL(s.Media.CoverImage)

	// Cover image colour (the raw AniList hex, or nil if absent).
	// Passed through unchanged on the wire; the accent fields below
	// carry the clamped derivative.
	var coverColor *string
	if s.Media.CoverImage != nil {
		coverColor = s.Media.CoverImage.Color
	}

	// Accent fields: brand-fallback applies for empty / invalid /
	// grayscale colours so PosterAccent is always a valid hex string.
	rawColor := ""
	if coverColor != nil {
		rawColor = *coverColor
	}
	accent := colorx.NormalizePosterAccent(rawColor)

	// Title triple (romaji, english, native).  AniList sometimes
	// returns Title=nil for orphan rows; the JS service tolerates
	// this with optional chaining.
	var romaji, english, native *string
	if s.Media.Title != nil {
		romaji = s.Media.Title.Romaji
		english = s.Media.Title.English
		native = s.Media.Title.Native
	}

	// Genres: always emit a slice (never nil) so the JSON is `[]`
	// rather than `null` — matches the JS `||  []` fallback in
	// anilist.service.js:445.
	genres := s.Media.Genres
	if genres == nil {
		genres = []string{}
	}

	return ScheduleItem{
		ScheduleID:                  s.ID,
		AiringAt:                    s.AiringAt,
		Episode:                     s.Episode,
		AnilistID:                   s.Media.ID,
		TitleRomaji:                 romaji,
		TitleEnglish:                english,
		TitleNative:                 native,
		TitleChinese:                nil, // populated below from DB lookup
		CoverImageUrl:               coverURL,
		CoverImageColor:             coverColor,
		PosterAccent:                accent.Accent,
		PosterAccentRgb:             accent.AccentRgb,
		PosterAccentContrastOnBlack: accent.AccentContrastOnBlack,
		Format:                      s.Media.Format,
		AverageScore:                s.Media.AverageScore,
		Genres:                      genres,
	}
}

// scheduleCoverURL implements Express's `extraLarge || large` fallback
// for cover images.  Empty-string ExtraLarge falls through to Large
// (matches JS `||` semantics on empty strings).  Returns nil when both
// are missing or the CoverImage pointer itself is nil.
//
// Mirrors normalize.go's coverImageURL helper — kept as a private
// duplicate here to avoid coupling normalize.go to the schedule item
// shape.  If this duplication grows past one more endpoint we should
// pull it into a small internal/anime helper file.
func scheduleCoverURL(c *anilist.CoverImage) *string {
	if c == nil {
		return nil
	}
	if c.ExtraLarge != nil && *c.ExtraLarge != "" {
		return c.ExtraLarge
	}
	if c.Large != nil && *c.Large != "" {
		return c.Large
	}
	return nil
}

// uniqueAnilistIDs walks all items across all groups and returns the
// deduplicated set of anilist IDs as []int32 (the type
// GetTitleChineseByAnilistIDs expects).  Iteration order is
// non-deterministic — the DB doesn't care, and our subsequent map
// lookup is independent of slice order.
func uniqueAnilistIDs(groups map[string][]ScheduleItem) []int32 {
	seen := make(map[int32]struct{})
	for _, items := range groups {
		for _, item := range items {
			seen[int32(item.AnilistID)] = struct{}{}
		}
	}
	if len(seen) == 0 {
		return nil
	}
	ids := make([]int32, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	return ids
}
