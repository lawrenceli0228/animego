package anime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// -----------------------------------------------------------------------------
// Test doubles: fakeScheduler (AniList stub) + reuse handlers_test.go's
// fakeQuerier for the DB side.  This file ONLY declares the new method
// stub on the existing fakeQuerier via an extension struct so we don't
// touch handlers_test.go.
// -----------------------------------------------------------------------------

// fakeScheduler is an AniListScheduler stub backed by a function pointer.
// Each test wires the scheduleFn to return the canned pages it needs and
// optionally asserts on call count via the embedded atomic counter.
type fakeScheduler struct {
	scheduleFn func(ctx context.Context, v anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error)
	calls      atomic.Int64
}

func (f *fakeScheduler) Schedule(ctx context.Context, v anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
	f.calls.Add(1)
	if f.scheduleFn == nil {
		return nil, errors.New("fakeScheduler: scheduleFn not set")
	}
	return f.scheduleFn(ctx, v)
}

// scheduleQuerier is an extension of fakeQuerier that adds the
// GetTitleChineseByAnilistIDs method exercised only by the schedule
// tests.  handlers_test.go's fakeQuerier embeds dbgen.Querier so this
// new method satisfies the interface at compile time without changing
// the original file.
type scheduleQuerier struct {
	dbgen.Querier // embed so unimplemented methods panic loud and clear

	getTitleChineseFn func(ctx context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error)
	calls             atomic.Int64
}

func (s *scheduleQuerier) GetTitleChineseByAnilistIDs(ctx context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
	s.calls.Add(1)
	if s.getTitleChineseFn == nil {
		return nil, errors.New("scheduleQuerier: getTitleChineseFn not set")
	}
	return s.getTitleChineseFn(ctx, ids)
}

// Compile-time sanity: scheduleQuerier must satisfy dbgen.Querier for
// any future signature drift to fail at build time.
var _ dbgen.Querier = (*scheduleQuerier)(nil)

// -----------------------------------------------------------------------------
// Test helpers.
// -----------------------------------------------------------------------------

// newTestService builds a ScheduleService with the test scheduler / DB
// stubs and a fixed clock (Mon, 2026-05-25 00:00:00 UTC) so date keys
// are deterministic across CI environments.  Caller can override the
// clock via wantNow / wantTZ if a test needs a different anchor.
func newTestService(t *testing.T, sched AniListScheduler, db dbgen.Querier) *ScheduleService {
	t.Helper()
	s, err := NewScheduleService(sched, db)
	require.NoError(t, err)
	s.tzOverride = time.UTC
	s.nowFn = func() time.Time {
		return time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	}
	t.Cleanup(s.cache.Close)
	return s
}

// strPtr is a convenience for taking the address of a string literal.
func strPtr(s string) *string { return &s }

// intPtr is the *int variant.
func intPtr(i int) *int { return &i }

// boolPtr is the *bool variant — used for IsAdult.
func boolPtr(b bool) *bool { return &b }

// mkMedia builds an anilist.Media with sensible defaults for tests that
// only care about a few fields.
func mkMedia(id int, romaji string) anilist.Media {
	return anilist.Media{
		ID: id,
		Title: &anilist.Title{
			Romaji:  strPtr(romaji),
			English: strPtr(romaji + " EN"),
			Native:  strPtr(romaji + " JP"),
		},
		CoverImage: &anilist.CoverImage{
			ExtraLarge: strPtr("https://cover/" + romaji + "/xl.jpg"),
			Large:      strPtr("https://cover/" + romaji + "/lg.jpg"),
			Color:      strPtr("#3b82f6"),
		},
		Format:       strPtr("TV"),
		AverageScore: intPtr(85),
		Genres:       []string{"Action"},
	}
}

// mkSchedule builds one AiringSchedule item.
func mkSchedule(id int, airingAt int64, episode int, media anilist.Media) anilist.AiringSchedule {
	return anilist.AiringSchedule{
		ID:       id,
		AiringAt: airingAt,
		Episode:  episode,
		Media:    media,
	}
}

// emptyTitleChineseDB returns a scheduleQuerier whose lookup always
// succeeds with zero rows — used when a test only cares about the
// AniList side.
func emptyTitleChineseDB() *scheduleQuerier {
	return &scheduleQuerier{
		getTitleChineseFn: func(_ context.Context, _ []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			return []dbgen.GetTitleChineseByAnilistIDsRow{}, nil
		},
	}
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

// TestSchedule_DefaultPath_OK exercises the basic happy path with a
// single AniList page and a couple of distinct date keys.
func TestSchedule_DefaultPath_OK(t *testing.T) {
	t.Parallel()

	// Anchor airingAt timestamps to the test clock's "today".  With the
	// fixed clock at 2026-05-25 12:00 UTC, today midnight is
	// 1779667200.  We schedule 3 items across 2 distinct days.
	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60          // Mon 14:00
	tueAfternoon := monMidnight + 24*60*60 + 14*60*60 // Tue 14:00

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo: anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{
						mkSchedule(1, monAfternoon, 5, mkMedia(101, "Alpha")),
						mkSchedule(2, monAfternoon+3600, 1, mkMedia(102, "Beta")),
						mkSchedule(3, tueAfternoon, 12, mkMedia(103, "Gamma")),
					},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Data struct {
			Today  string                    `json:"today"`
			Groups map[string][]ScheduleItem `json:"groups"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Equal(t, "2026-05-25", parsed.Data.Today)
	require.Len(t, parsed.Data.Groups, 2)
	require.Len(t, parsed.Data.Groups["2026-05-25"], 2)
	require.Len(t, parsed.Data.Groups["2026-05-26"], 1)

	// Verify item ordering inside the Monday group: airingAt asc.
	mon := parsed.Data.Groups["2026-05-25"]
	assert.True(t, mon[0].AiringAt < mon[1].AiringAt, "items sorted by airingAt asc")
}

// TestSchedule_PaginatesUntilHasNextFalse verifies the pagination loop
// makes a second AniList call when HasNextPage=true on page 1.
func TestSchedule_PaginatesUntilHasNextFalse(t *testing.T) {
	t.Parallel()

	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, v anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			switch v.Page {
			case 1:
				return &anilist.WeeklyScheduleResponse{
					Page: anilist.SchedulePage{
						PageInfo: anilist.PageInfo{HasNextPage: true},
						AiringSchedules: []anilist.AiringSchedule{
							mkSchedule(1, monAfternoon, 1, mkMedia(101, "Alpha")),
						},
					},
				}, nil
			case 2:
				return &anilist.WeeklyScheduleResponse{
					Page: anilist.SchedulePage{
						PageInfo: anilist.PageInfo{HasNextPage: false},
						AiringSchedules: []anilist.AiringSchedule{
							mkSchedule(2, monAfternoon+3600, 1, mkMedia(102, "Beta")),
						},
					},
				}, nil
			default:
				return nil, errors.New("unexpected page")
			}
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int64(2), sched.calls.Load(), "expected exactly 2 AniList calls (pages 1 and 2)")

	var parsed struct {
		Data struct {
			Groups map[string][]ScheduleItem `json:"groups"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data.Groups["2026-05-25"], 2, "items from both pages merged")
}

// TestSchedule_PaginationSanityCap verifies the loop terminates at the
// 10-page hard cap even when AniList lies and always says HasNextPage=true.
func TestSchedule_PaginationSanityCap(t *testing.T) {
	t.Parallel()

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo:        anilist.PageInfo{HasNextPage: true},
					AiringSchedules: []anilist.AiringSchedule{},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int64(schedulePageCap), sched.calls.Load(),
		"loop should terminate at sanity cap of %d pages", schedulePageCap)
}

// TestSchedule_AdultSkipped verifies items with IsAdult=true are
// filtered out of the response groups.
func TestSchedule_AdultSkipped(t *testing.T) {
	t.Parallel()

	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60

	adult := mkMedia(999, "AdultShow")
	adult.IsAdult = boolPtr(true)

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo: anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{
						mkSchedule(1, monAfternoon, 1, mkMedia(101, "Alpha")),
						mkSchedule(2, monAfternoon+3600, 1, adult),
						mkSchedule(3, monAfternoon+7200, 1, mkMedia(102, "Beta")),
					},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Data struct {
			Groups map[string][]ScheduleItem `json:"groups"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	mon := parsed.Data.Groups["2026-05-25"]
	require.Len(t, mon, 2, "adult item filtered out")
	for _, item := range mon {
		assert.NotEqual(t, 999, item.AnilistID, "adult item should not be present")
	}
}

// TestSchedule_CacheHit_NoAniListCall verifies the 30-minute cache
// short-circuits the second request — no extra AniList call, no extra
// DB lookup.
func TestSchedule_CacheHit_NoAniListCall(t *testing.T) {
	t.Parallel()

	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo: anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{
						mkSchedule(1, monAfternoon, 1, mkMedia(101, "Alpha")),
					},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	// First call: populates cache.
	rec1 := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec1, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
	require.Equal(t, http.StatusOK, rec1.Code)
	require.Equal(t, int64(1), sched.calls.Load())

	// Ristretto writes are asynchronous — must Wait() before the
	// second Get can observe the cached value.
	svc.cache.Wait()

	// Second call: should be served from cache.
	rec2 := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
	require.Equal(t, http.StatusOK, rec2.Code)
	assert.Equal(t, int64(1), sched.calls.Load(), "second request should be cache-hit (no extra AniList call)")
	assert.Equal(t, int64(1), db.calls.Load(), "second request should skip DB (cache hit)")

	// Bodies must be byte-identical.
	assert.Equal(t, rec1.Body.String(), rec2.Body.String())
}

// TestSchedule_GroupKeyIsLocalDate verifies the group key uses the
// configured timezone rather than UTC.  With tzOverride=UTC, an
// airingAt right at midnight UTC must land in the UTC date — but we
// also flip to a +09:00 Tokyo timezone to verify the key shifts.
func TestSchedule_GroupKeyIsLocalDate(t *testing.T) {
	t.Parallel()

	// 2026-05-25 23:00 UTC = 2026-05-26 08:00 Tokyo (UTC+9).
	// With tz=UTC, group key = 2026-05-25.
	// With tz=Tokyo, group key = 2026-05-26.
	airingAt := int64(1779667200 + 23*3600) // 2026-05-25 23:00 UTC

	makeSched := func() *fakeScheduler {
		return &fakeScheduler{
			scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
				return &anilist.WeeklyScheduleResponse{
					Page: anilist.SchedulePage{
						PageInfo: anilist.PageInfo{HasNextPage: false},
						AiringSchedules: []anilist.AiringSchedule{
							mkSchedule(1, airingAt, 1, mkMedia(101, "Alpha")),
						},
					},
				}, nil
			},
		}
	}

	// Case 1: tz=UTC.
	t.Run("utc", func(t *testing.T) {
		t.Parallel()
		db := emptyTitleChineseDB()
		svc := newTestService(t, makeSched(), db)
		// newTestService already sets tzOverride=time.UTC

		rec := httptest.NewRecorder()
		svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
		require.Equal(t, http.StatusOK, rec.Code)

		var parsed struct {
			Data struct {
				Groups map[string][]ScheduleItem `json:"groups"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
		require.Contains(t, parsed.Data.Groups, "2026-05-25", "UTC should group under 2026-05-25")
	})

	// Case 2: tz=Tokyo (UTC+9) — airingAt rolls into the next day.
	t.Run("tokyo", func(t *testing.T) {
		t.Parallel()
		tokyo, err := time.LoadLocation("Asia/Tokyo")
		require.NoError(t, err)

		db := emptyTitleChineseDB()
		s, err := NewScheduleService(makeSched(), db)
		require.NoError(t, err)
		t.Cleanup(s.cache.Close)
		s.tzOverride = tokyo
		s.nowFn = func() time.Time {
			return time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
		}

		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
		require.Equal(t, http.StatusOK, rec.Code)

		var parsed struct {
			Data struct {
				Groups map[string][]ScheduleItem `json:"groups"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
		require.Contains(t, parsed.Data.Groups, "2026-05-26", "Tokyo should group under 2026-05-26")
	})
}

// TestSchedule_TitleChinese_PopulatedFromDB verifies the DB lookup
// fills in titleChinese for matching IDs and leaves the rest nil.
func TestSchedule_TitleChinese_PopulatedFromDB(t *testing.T) {
	t.Parallel()

	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo: anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{
						mkSchedule(1, monAfternoon, 1, mkMedia(101, "Alpha")),
						mkSchedule(2, monAfternoon+3600, 1, mkMedia(102, "Beta")),
					},
				},
			}, nil
		},
	}

	var gotIDs []int32
	var mu sync.Mutex
	db := &scheduleQuerier{
		getTitleChineseFn: func(_ context.Context, ids []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			mu.Lock()
			gotIDs = append([]int32{}, ids...)
			mu.Unlock()
			return []dbgen.GetTitleChineseByAnilistIDsRow{
				{AnilistID: 101, TitleChinese: strPtr("阿尔法"), BangumiVersion: 1},
				// 102 not in DB → titleChinese stays nil
			}, nil
		},
	}
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	mu.Lock()
	assert.ElementsMatch(t, []int32{101, 102}, gotIDs, "DB called with both unique IDs")
	mu.Unlock()

	var parsed struct {
		Data struct {
			Groups map[string][]ScheduleItem `json:"groups"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	mon := parsed.Data.Groups["2026-05-25"]
	require.Len(t, mon, 2)

	// Find item with anilistId=101 — its titleChinese must be set;
	// item with 102 must be nil.
	var item101, item102 *ScheduleItem
	for i := range mon {
		switch mon[i].AnilistID {
		case 101:
			item101 = &mon[i]
		case 102:
			item102 = &mon[i]
		}
	}
	require.NotNil(t, item101)
	require.NotNil(t, item102)
	require.NotNil(t, item101.TitleChinese)
	assert.Equal(t, "阿尔法", *item101.TitleChinese)
	assert.Nil(t, item102.TitleChinese, "non-enriched item should have nil titleChinese")
}

// TestSchedule_TitleChinese_DBError_DegradesGracefully verifies a DB
// failure on the titleChinese lookup still produces a 200 response
// with titleChinese fields left nil.
func TestSchedule_TitleChinese_DBError_DegradesGracefully(t *testing.T) {
	t.Parallel()

	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo: anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{
						mkSchedule(1, monAfternoon, 1, mkMedia(101, "Alpha")),
					},
				},
			}, nil
		},
	}
	db := &scheduleQuerier{
		getTitleChineseFn: func(_ context.Context, _ []int32) ([]dbgen.GetTitleChineseByAnilistIDsRow, error) {
			return nil, errors.New("simulated postgres failure")
		},
	}
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusOK, rec.Code, "DB error should degrade, not 500")
	assert.Equal(t, int64(1), db.calls.Load(), "DB stub was called")

	var parsed struct {
		Data struct {
			Groups map[string][]ScheduleItem `json:"groups"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	mon := parsed.Data.Groups["2026-05-25"]
	require.Len(t, mon, 1)
	assert.Nil(t, mon[0].TitleChinese, "titleChinese should be nil after DB failure")
}

// TestSchedule_AniListError_502 verifies an AniList upstream error
// maps to a 502 BAD_GATEWAY response.
func TestSchedule_AniListError_502(t *testing.T) {
	t.Parallel()

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return nil, &anilist.ErrUpstream{Status: 500, Message: "AniList API error: 500"}
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusBadGateway, rec.Code)
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

// TestSchedule_EnvelopeShape verifies the byte-level shape of the
// envelope: starts with {"data":{"today":"..., contains "groups":{,
// and at least one date key with an array of ScheduleItems.
func TestSchedule_EnvelopeShape(t *testing.T) {
	t.Parallel()

	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo: anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{
						mkSchedule(1, monAfternoon, 5, mkMedia(101, "Alpha")),
					},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()

	// Top-level envelope must start with {"data":{"today":"
	require.True(t, strings.HasPrefix(body, `{"data":{"today":"`),
		"envelope must start with {\"data\":{\"today\":\"  — got: %s", body[:60])
	require.Contains(t, body, `"groups":{`, "envelope must contain groups block")
	require.Contains(t, body, `"2026-05-25"`, "envelope must contain the today date key")

	// today must come before groups in the byte order (struct
	// declaration order is preserved by encoding/json).
	todayIdx := strings.Index(body, `"today"`)
	groupsIdx := strings.Index(body, `"groups"`)
	require.Greater(t, todayIdx, -1)
	require.Greater(t, groupsIdx, todayIdx, "today must come before groups in JSON output")

	// Verify the ScheduleItem field order — scheduleId before
	// airingAt before anilistId before posterAccent.
	scheduleIdIdx := strings.Index(body, `"scheduleId"`)
	airingAtIdx := strings.Index(body, `"airingAt"`)
	anilistIdIdx := strings.Index(body, `"anilistId"`)
	posterAccentIdx := strings.Index(body, `"posterAccent"`)
	require.Greater(t, scheduleIdIdx, -1)
	require.Greater(t, airingAtIdx, scheduleIdIdx, "airingAt after scheduleId")
	require.Greater(t, anilistIdIdx, airingAtIdx, "anilistId after airingAt")
	require.Greater(t, posterAccentIdx, anilistIdIdx, "posterAccent after anilistId")
}

// TestSchedule_AccentFieldsPopulated verifies colorx.NormalizePosterAccent
// runs against the AniList color and the resulting accent fields are
// non-empty (and the empty-color case falls back to brand violet).
func TestSchedule_AccentFieldsPopulated(t *testing.T) {
	t.Parallel()

	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60

	t.Run("color set", func(t *testing.T) {
		t.Parallel()
		media := mkMedia(101, "Alpha")
		// mkMedia already sets color="#3b82f6"
		sched := &fakeScheduler{
			scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
				return &anilist.WeeklyScheduleResponse{
					Page: anilist.SchedulePage{
						PageInfo: anilist.PageInfo{HasNextPage: false},
						AiringSchedules: []anilist.AiringSchedule{
							mkSchedule(1, monAfternoon, 1, media),
						},
					},
				}, nil
			},
		}
		db := emptyTitleChineseDB()
		svc := newTestService(t, sched, db)

		rec := httptest.NewRecorder()
		svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
		require.Equal(t, http.StatusOK, rec.Code)

		var parsed struct {
			Data struct {
				Groups map[string][]ScheduleItem `json:"groups"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
		item := parsed.Data.Groups["2026-05-25"][0]

		// PosterAccent must be a valid hex (7 chars starting with '#').
		require.Len(t, item.PosterAccent, 7)
		require.Equal(t, "#", string(item.PosterAccent[0]))
		require.NotEmpty(t, item.PosterAccentRgb, "rgb string non-empty")
		require.Greater(t, item.PosterAccentContrastOnBlack, 0.0, "contrast > 0")
	})

	t.Run("nil color falls back to brand violet", func(t *testing.T) {
		t.Parallel()
		media := mkMedia(102, "NoColor")
		media.CoverImage.Color = nil
		sched := &fakeScheduler{
			scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
				return &anilist.WeeklyScheduleResponse{
					Page: anilist.SchedulePage{
						PageInfo: anilist.PageInfo{HasNextPage: false},
						AiringSchedules: []anilist.AiringSchedule{
							mkSchedule(1, monAfternoon, 1, media),
						},
					},
				}, nil
			},
		}
		db := emptyTitleChineseDB()
		svc := newTestService(t, sched, db)

		rec := httptest.NewRecorder()
		svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
		require.Equal(t, http.StatusOK, rec.Code)

		var parsed struct {
			Data struct {
				Groups map[string][]ScheduleItem `json:"groups"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
		item := parsed.Data.Groups["2026-05-25"][0]
		assert.Equal(t, "#8B5CF6", item.PosterAccent, "nil color → brand violet fallback")
		assert.Nil(t, item.CoverImageColor, "raw color stays nil")
	})
}

// TestSchedule_CoverImageFallback verifies the extraLarge → large
// fallback when extraLarge is missing.
func TestSchedule_CoverImageFallback(t *testing.T) {
	t.Parallel()

	monMidnight := int64(1779667200)
	monAfternoon := monMidnight + 14*60*60

	media := mkMedia(101, "Alpha")
	media.CoverImage.ExtraLarge = nil // force fallback to Large

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo: anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{
						mkSchedule(1, monAfternoon, 1, media),
					},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	var parsed struct {
		Data struct {
			Groups map[string][]ScheduleItem `json:"groups"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	item := parsed.Data.Groups["2026-05-25"][0]
	require.NotNil(t, item.CoverImageUrl)
	assert.Equal(t, "https://cover/Alpha/lg.jpg", *item.CoverImageUrl,
		"should fall back to large when extraLarge is nil")
}

// TestSchedule_PaginationVarsCorrect verifies the WeekStart/WeekEnd
// values passed to the AniList client match the local-midnight window.
func TestSchedule_PaginationVarsCorrect(t *testing.T) {
	t.Parallel()

	var gotVars anilist.ScheduleVars
	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, v anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			gotVars = v
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo:        anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	// Fixed clock = 2026-05-25 12:00 UTC, tz=UTC.
	// today midnight UTC = 2026-05-25 00:00 UTC = 1779667200.
	expectedStart := int64(1779667200)
	expectedEnd := expectedStart + 7*24*60*60
	assert.Equal(t, expectedStart, gotVars.WeekStart, "weekStart = today midnight Unix seconds")
	assert.Equal(t, expectedEnd, gotVars.WeekEnd, "weekEnd = start + 7 days")
	assert.Equal(t, 1, gotVars.Page, "first page request")
}

// TestSchedule_EmptyResponse verifies an empty AniList response still
// produces a valid envelope with empty groups (and skips the DB call).
func TestSchedule_EmptyResponse(t *testing.T) {
	t.Parallel()

	sched := &fakeScheduler{
		scheduleFn: func(_ context.Context, _ anilist.ScheduleVars) (*anilist.WeeklyScheduleResponse, error) {
			return &anilist.WeeklyScheduleResponse{
				Page: anilist.SchedulePage{
					PageInfo:        anilist.PageInfo{HasNextPage: false},
					AiringSchedules: []anilist.AiringSchedule{},
				},
			}, nil
		},
	}
	db := emptyTitleChineseDB()
	svc := newTestService(t, sched, db)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/schedule", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int64(0), db.calls.Load(), "DB should not be called for empty schedule")

	var parsed struct {
		Data struct {
			Today  string                    `json:"today"`
			Groups map[string][]ScheduleItem `json:"groups"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	assert.Equal(t, "2026-05-25", parsed.Data.Today)
	assert.Empty(t, parsed.Data.Groups)
}
