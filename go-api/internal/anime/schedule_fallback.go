package anime

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/lawrenceli0228/animego/go-api/internal/colorx"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// What /schedule serves when AniList cannot be asked.
//
// The week used to come from AniList alone: a 30-minute cache in front of
// it, and on a miss with AniList failing, a 502 — /calendar and the
// homepage's 今日更新 went blank. On 2026-10-21 AniList answered every
// caller 403 ("temporarily disabled due to severe stability issues") and
// the page stayed blank for as long as that lasted.
//
// Two answers, in order:
//
//  1. lastGood — today's last AniList answer, kept past the cache TTL.
//     Exact, but in memory only, so it covers an outage that starts
//     after this process has fetched today's week.
//  2. the catalogue — each title's next episode as anime_cache last
//     stated it, stepped forward a week at a time when the outage has
//     outlived that statement. Survives a restart and a date change,
//     which is when (1) is empty. It knows one airing per title, so a
//     title airing twice in a week shows once.
//
// Neither is written to the 30-minute cache: a fallback is held for
// scheduleFallbackTTL and AniList is asked again after it.

// scheduleFallbackTTL is how long a fallback week is served before AniList
// is asked again. Short, so the real week returns within minutes of AniList
// coming back; long enough that an outage costs one AniList call per window
// rather than one per page view.
const scheduleFallbackTTL = 5 * time.Minute

// scheduleFallbackStaleness bounds how old a stored next airing may be and
// still be stepped forward. A weekly show four weeks past its last stated
// airing has been through four refreshes that could have changed it (a
// break, a delay, an early finale); past that, guessing is worse than
// leaving it out.
const scheduleFallbackStaleness = 28 * 24 * time.Hour

const scheduleWeek = 7 * 24 * time.Hour

// Fallback sources, for the log line.
const (
	fallbackLastGood  = "last_good"
	fallbackCatalogue = "catalogue"
)

// lastGoodSchedule holds today's last AniList answer. Its own lock rather
// than the ristretto cache: the cache drops the entry at its TTL, which is
// exactly when this copy is needed.
type lastGoodSchedule struct {
	mu   sync.Mutex
	resp *ScheduleResponse
}

func (l *lastGoodSchedule) set(r *ScheduleResponse) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.resp = r
}

// get returns the stored answer only when it is for todayKey — yesterday's
// week starts a day early and ends a day short.
func (l *lastGoodSchedule) get(todayKey string) (*ScheduleResponse, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.resp == nil || l.resp.Today != todayKey {
		return nil, false
	}
	return l.resp, true
}

// fallbackSchedule answers the week without AniList. ok is false when there
// is nothing to show — an empty catalogue answer is not an answer, and the
// caller keeps AniList's error so the page says the schedule did not load
// rather than "nothing airs this week".
func (s *ScheduleService) fallbackSchedule(ctx context.Context, today time.Time, todayKey string) (*ScheduleResponse, string, bool, error) {
	if r, ok := s.lastGood.get(todayKey); ok {
		return r, fallbackLastGood, true, nil
	}

	weekEnd := today.Add(scheduleWeek)
	rows, err := s.db.ListScheduleFallbackRows(ctx,
		pgtype.Timestamptz{Time: today.Add(-scheduleFallbackStaleness), Valid: true},
		pgtype.Timestamptz{Time: weekEnd, Valid: true},
	)
	if err != nil {
		return nil, "", false, fmt.Errorf("anime/schedule: fallback rows: %w", err)
	}

	groups := catalogueWeek(rows, today, weekEnd, s.tz())
	if len(groups) == 0 {
		return nil, "", false, nil
	}
	return &ScheduleResponse{Today: todayKey, Groups: groups}, fallbackCatalogue, true, nil
}

// catalogueWeek places each row's next airing inside [weekStart, weekEnd),
// grouped by local date and sorted by airing time like the AniList path.
func catalogueWeek(rows []dbgen.ListScheduleFallbackRowsRow, weekStart, weekEnd time.Time, tz *time.Location) map[string][]ScheduleItem {
	groups := make(map[string][]ScheduleItem)
	for _, r := range rows {
		if !r.NextAiringAt.Valid {
			continue
		}
		at, ep, ok := projectAiring(r.NextAiringAt.Time, int(r.NextAiringEpisode), r.Episodes, weekStart, weekEnd)
		if !ok {
			continue
		}
		key := at.In(tz).Format("2006-01-02")
		groups[key] = append(groups[key], fallbackItem(r, at, ep))
	}
	for key, items := range groups {
		sort.SliceStable(items, func(i, j int) bool { return items[i].AiringAt < items[j].AiringAt })
		groups[key] = items
	}
	return groups
}

// projectAiring steps a stored airing forward a week (and an episode) at a
// time until it reaches the window. ok is false when it lands past the
// window, or past the title's last episode when the count is known — a
// show whose finale aired during the outage must not grow an episode 13.
func projectAiring(at time.Time, ep int, episodes *int32, weekStart, weekEnd time.Time) (time.Time, int, bool) {
	for at.Before(weekStart) {
		at = at.Add(scheduleWeek)
		ep++
	}
	if !at.Before(weekEnd) {
		return time.Time{}, 0, false
	}
	if episodes != nil && *episodes > 0 && ep > int(*episodes) {
		return time.Time{}, 0, false
	}
	return at, ep, true
}

// fallbackItem shapes a catalogue row like an AniList airing. scheduleId is
// negative: AniList's ids are positive, so a synthetic one can never
// collide with a real one on the page's list keys.
func fallbackItem(r dbgen.ListScheduleFallbackRowsRow, at time.Time, ep int) ScheduleItem {
	rawColor := ""
	if r.CoverImageColor != nil {
		rawColor = *r.CoverImageColor
	}
	accent := colorx.NormalizePosterAccent(rawColor)

	genres := r.Genres
	if genres == nil {
		genres = []string{}
	}

	return ScheduleItem{
		ScheduleID:                  -(int(r.AnilistID)*1000 + ep),
		AiringAt:                    at.Unix(),
		Episode:                     ep,
		AnilistID:                   int(r.AnilistID),
		TitleRomaji:                 r.TitleRomaji,
		TitleEnglish:                r.TitleEnglish,
		TitleNative:                 r.TitleNative,
		TitleChinese:                r.TitleChinese,
		TitleHant:                   r.TitleHant,
		TitleHantSource:             r.TitleHantSource,
		TitleHantSeo:                r.TitleHantSeo,
		CoverImageUrl:               r.CoverImageUrl,
		CoverImageColor:             r.CoverImageColor,
		PosterAccent:                accent.Accent,
		PosterAccentRgb:             accent.AccentRgb,
		PosterAccentContrastOnBlack: accent.AccentContrastOnBlack,
		Format:                      r.Format,
		AverageScore:                roundScore(r.AverageScore),
		Genres:                      genres,
	}
}

// roundScore turns the catalogue's numeric score into the integer AniList
// sends on this endpoint.
func roundScore(v *float64) *int {
	if v == nil {
		return nil
	}
	n := int(math.Round(*v))
	return &n
}
