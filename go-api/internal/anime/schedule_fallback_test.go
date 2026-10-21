package anime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// The test clock (newTestService) is 2026-05-25 12:00 UTC, so "today" is
// 2026-05-25 00:00 UTC and the week runs to 2026-06-01 00:00 UTC.
var fallbackToday = time.Date(2026, 5, 25, 0, 0, 0, 0, time.UTC)

// anilistDisabled is what AniList answered every caller on 2026-10-21.
func anilistDisabled() *fakeScheduler {
	return &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return nil, &anilist.ErrUpstream{Status: 403, Message: "AniList API error: 403"}
		},
	}
}

func fallbackRow(id int32, at time.Time, ep int32, episodes *int32) dbgen.ListScheduleFallbackRowsRow {
	romaji := "Show " + string(rune('A'+id%26))
	return dbgen.ListScheduleFallbackRowsRow{
		AnilistID:         id,
		TitleRomaji:       &romaji,
		CoverImageUrl:     strPtr("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1.jpg"),
		CoverImageColor:   strPtr("#3b82f6"),
		Format:            strPtr("TV"),
		Episodes:          episodes,
		NextAiringAt:      pgtype.Timestamptz{Time: at, Valid: true},
		NextAiringEpisode: ep,
		Genres:            []string{"Action"},
	}
}

func int32Ptr(v int32) *int32 { return &v }

func float64Ptr(v float64) *float64 { return &v }

type scheduleBody struct {
	Data ScheduleResponse `json:"data"`
}

func getSchedule(t *testing.T, svc *ScheduleService) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
	return rec
}

func decodeSchedule(t *testing.T, rec *httptest.ResponseRecorder) ScheduleResponse {
	t.Helper()
	var body scheduleBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body.Data
}

// AniList answers once, then goes down after the cache entry has expired:
// the page keeps today's exact week instead of going blank, and the
// catalogue is never asked.
func TestSchedule_AniListDown_ServesLastGoodSameDay(t *testing.T) {
	t.Parallel()

	monAfternoon := fallbackToday.Add(14 * time.Hour).Unix()
	up := true
	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			if !up {
				return nil, &anilist.ErrUpstream{Status: 403, Message: "AniList API error: 403"}
			}
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					AiringSchedules: []anilist.AiringSchedule{mkSchedule(1, monAfternoon, 5, mkMedia(101, "Alpha"))},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	first := getSchedule(t, svc)
	require.Equal(t, http.StatusOK, first.Code)

	// The 30-minute entry runs out while AniList is down.
	svc.cache.Wait()
	svc.cache.Clear()
	up = false

	second := getSchedule(t, svc)
	require.Equal(t, http.StatusOK, second.Code)
	assert.Equal(t, first.Body.String(), second.Body.String(), "same-day fallback is today's AniList answer verbatim")
	assert.Equal(t, int64(2), sched.calls.Load(), "AniList is still asked first")
	assert.Equal(t, int64(0), db.fallbackCalls.Load(), "an exact copy beats the catalogue")
}

// Yesterday's AniList answer starts a day early and ends a day short; it is
// not served as today's week.
func TestSchedule_AniListDown_LastGoodFromYesterdayIgnored(t *testing.T) {
	t.Parallel()

	db := emptyTitleChineseDB()
	svc := newTestService(t, anilistDisabled(), db)
	svc.lastGood.set(&ScheduleResponse{
		Today:  "2026-05-24",
		Groups: map[string][]ScheduleItem{"2026-05-24": {{ScheduleID: 1, AnilistID: 101}}},
	})

	rec := getSchedule(t, svc)

	assert.Equal(t, http.StatusBadGateway, rec.Code, "nothing for today, so the AniList error stands")
	assert.Equal(t, int64(1), db.fallbackCalls.Load(), "the catalogue was asked instead")
}

// After a restart (no copy in memory) the week is rebuilt from each title's
// stored next episode, stepped forward when the outage has outlived it.
func TestSchedule_AniListDown_CatalogueFallback(t *testing.T) {
	t.Parallel()

	inWindow := fallbackRow(201, fallbackToday.Add(24*time.Hour+14*time.Hour), 5, int32Ptr(12))
	inWindow.AverageScore = float64Ptr(84.6)
	inWindow.TitleChinese = strPtr("甲")
	earlierSameDay := fallbackRow(204, fallbackToday.Add(24*time.Hour+9*time.Hour), 1, int32Ptr(0))
	earlierSameDay.Genres = nil
	stale := fallbackRow(202, fallbackToday.Add(-3*24*time.Hour+20*time.Hour), 7, nil)
	finaleAired := fallbackRow(203, fallbackToday.Add(-2*24*time.Hour), 12, int32Ptr(12))

	var gotFloor, gotEnd time.Time
	db := emptyTitleChineseDB()
	db.fallbackRowsFn = func(_ context.Context, staleFloor, weekEnd pgtype.Timestamptz) ([]dbgen.ListScheduleFallbackRowsRow, error) {
		gotFloor, gotEnd = staleFloor.Time, weekEnd.Time
		return []dbgen.ListScheduleFallbackRowsRow{stale, finaleAired, inWindow, earlierSameDay}, nil
	}
	svc := newTestService(t, anilistDisabled(), db)

	rec := getSchedule(t, svc)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, fallbackToday.Add(-28*24*time.Hour), gotFloor)
	assert.Equal(t, fallbackToday.Add(7*24*time.Hour), gotEnd)

	got := decodeSchedule(t, rec)
	assert.Equal(t, "2026-05-25", got.Today)
	require.Len(t, got.Groups, 2, "the aired finale is left out")

	tue := got.Groups["2026-05-26"]
	require.Len(t, tue, 2)
	assert.Equal(t, 204, tue[0].AnilistID, "sorted by airing time within the day")
	assert.Equal(t, 201, tue[1].AnilistID)
	alpha := tue[1]
	assert.Equal(t, -(201*1000 + 5), alpha.ScheduleID, "synthetic ids are negative")
	assert.Equal(t, 5, alpha.Episode)
	require.NotNil(t, alpha.AverageScore)
	assert.Equal(t, 85, *alpha.AverageScore)
	assert.Equal(t, "甲", *alpha.TitleChinese)
	assert.NotEmpty(t, alpha.PosterAccent)
	assert.Equal(t, []string{"Action"}, alpha.Genres)
	assert.Equal(t, []string{}, tue[0].Genres, "genres is [] on the wire, never null")

	fri := got.Groups["2026-05-29"]
	require.Len(t, fri, 1)
	assert.Equal(t, 202, fri[0].AnilistID)
	assert.Equal(t, 8, fri[0].Episode, "one week forward is one episode forward")
	assert.Equal(t, fallbackToday.Add(4*24*time.Hour+20*time.Hour).Unix(), fri[0].AiringAt)
}

// A fallback is held for a few minutes, so an outage costs one AniList call
// per window rather than one per page view.
func TestSchedule_FallbackIsCachedBriefly(t *testing.T) {
	t.Parallel()

	db := emptyTitleChineseDB()
	db.fallbackRowsFn = func(_ context.Context, _, _ pgtype.Timestamptz) ([]dbgen.ListScheduleFallbackRowsRow, error) {
		return []dbgen.ListScheduleFallbackRowsRow{fallbackRow(201, fallbackToday.Add(30*time.Hour), 3, nil)}, nil
	}
	sched := anilistDisabled()
	svc := newTestService(t, sched, db)

	require.Equal(t, http.StatusOK, getSchedule(t, svc).Code)
	svc.cache.Wait()
	require.Equal(t, http.StatusOK, getSchedule(t, svc).Code)

	assert.Equal(t, int64(1), sched.calls.Load())
	assert.Equal(t, int64(1), db.fallbackCalls.Load())
}

// The breaker's ErrRateLimited is an AniList failure like any other.
func TestSchedule_RateLimited_ServesFallback(t *testing.T) {
	t.Parallel()

	db := emptyTitleChineseDB()
	db.fallbackRowsFn = func(_ context.Context, _, _ pgtype.Timestamptz) ([]dbgen.ListScheduleFallbackRowsRow, error) {
		return []dbgen.ListScheduleFallbackRowsRow{fallbackRow(201, fallbackToday.Add(30*time.Hour), 3, nil)}, nil
	}
	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return nil, anilist.ErrRateLimited
		},
	}
	svc := newTestService(t, sched, db)

	rec := getSchedule(t, svc)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Len(t, decodeSchedule(t, rec).Groups["2026-05-26"], 1)
}

// When the catalogue cannot be read either, the page gets AniList's error,
// as before.
func TestSchedule_FallbackDBError_502(t *testing.T) {
	t.Parallel()

	db := emptyTitleChineseDB()
	db.fallbackRowsFn = func(_ context.Context, _, _ pgtype.Timestamptz) ([]dbgen.ListScheduleFallbackRowsRow, error) {
		return nil, errors.New("connection refused")
	}
	svc := newTestService(t, anilistDisabled(), db)

	rec := getSchedule(t, svc)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestProjectAiring(t *testing.T) {
	t.Parallel()

	weekStart := fallbackToday
	weekEnd := weekStart.Add(7 * 24 * time.Hour)
	day := 24 * time.Hour

	tests := []struct {
		name     string
		at       time.Time
		ep       int
		episodes *int32
		wantAt   time.Time
		wantEp   int
		wantOK   bool
	}{
		{"inside the window stays put", weekStart.Add(2 * day), 4, nil, weekStart.Add(2 * day), 4, true},
		{"window start is inside", weekStart, 4, nil, weekStart, 4, true},
		{"one week stale steps once", weekStart.Add(-1 * time.Hour), 4, nil, weekStart.Add(-time.Hour + 7*day), 5, true},
		{"three weeks stale steps three times", weekStart.Add(-20 * day), 4, nil, weekStart.Add(day), 7, true},
		{"stepping past the last episode drops it", weekStart.Add(-3 * day), 12, int32Ptr(12), time.Time{}, 0, false},
		{"the last episode itself is kept", weekStart.Add(-3 * day), 11, int32Ptr(12), weekStart.Add(4 * day), 12, true},
		{"zero episodes means unknown", weekStart.Add(-3 * day), 30, int32Ptr(0), weekStart.Add(4 * day), 31, true},
		{"at or past the window end is out", weekEnd, 4, nil, time.Time{}, 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			at, ep, ok := projectAiring(tc.at, tc.ep, tc.episodes, weekStart, weekEnd)
			assert.Equal(t, tc.wantOK, ok)
			assert.Equal(t, tc.wantEp, ep)
			assert.True(t, tc.wantAt.Equal(at), "at = %v, want %v", at, tc.wantAt)
		})
	}
}

// Day keys follow the service's timezone, as on the AniList path.
func TestCatalogueWeek_GroupsByLocalDate(t *testing.T) {
	t.Parallel()

	tokyo := time.FixedZone("JST", 9*60*60)
	weekStart := time.Date(2026, 5, 25, 0, 0, 0, 0, tokyo)
	at := time.Date(2026, 5, 25, 20, 0, 0, 0, time.UTC) // 05:00 on the 26th in Tokyo

	groups := catalogueWeek([]dbgen.ListScheduleFallbackRowsRow{fallbackRow(201, at, 3, nil)}, weekStart, weekStart.Add(7*24*time.Hour), tokyo)

	require.Len(t, groups["2026-05-26"], 1)
}
