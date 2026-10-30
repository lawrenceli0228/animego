package admin

// user_detail_test.go — loadUserDetail against a fake querier: the 404
// mapping, error propagation, the null and empty-list conventions, and the
// wire field names.  user_detail_pg_test.go runs the real queries.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

type fakeDetailQuerier struct {
	row         dbgen.GetAdminUserDetailRow
	rowErr      error
	days        []dbgen.ListAdminUserActivityDaysRow
	daysErr     error
	watches     []dbgen.ListAdminUserRecentWatchesRow
	watchesErr  error
	subs        []dbgen.ListAdminUserRecentSubscriptionsRow
	subsErr     error
	sessions    []dbgen.ListAdminUserLiveSessionsRow
	sessionsErr error

	calls     int
	gotToday  pgtype.Date
	gotLimits []int32
}

func (f *fakeDetailQuerier) GetAdminUserDetail(_ context.Context, _ uuid.UUID) (dbgen.GetAdminUserDetailRow, error) {
	f.calls++
	return f.row, f.rowErr
}

func (f *fakeDetailQuerier) ListAdminUserActivityDays(_ context.Context, _ uuid.UUID, today pgtype.Date) ([]dbgen.ListAdminUserActivityDaysRow, error) {
	f.calls++
	f.gotToday = today
	return f.days, f.daysErr
}

func (f *fakeDetailQuerier) ListAdminUserRecentWatches(_ context.Context, _ uuid.UUID, limit int32) ([]dbgen.ListAdminUserRecentWatchesRow, error) {
	f.calls++
	f.gotLimits = append(f.gotLimits, limit)
	return f.watches, f.watchesErr
}

func (f *fakeDetailQuerier) ListAdminUserRecentSubscriptions(_ context.Context, _ uuid.UUID, limit int32) ([]dbgen.ListAdminUserRecentSubscriptionsRow, error) {
	f.calls++
	f.gotLimits = append(f.gotLimits, limit)
	return f.subs, f.subsErr
}

func (f *fakeDetailQuerier) ListAdminUserLiveSessions(_ context.Context, _ uuid.UUID) ([]dbgen.ListAdminUserLiveSessionsRow, error) {
	f.calls++
	return f.sessions, f.sessionsErr
}

func ts(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func TestLoadUserDetail_MissingAccountIsNotFound(t *testing.T) {
	t.Parallel()
	q := &fakeDetailQuerier{rowErr: pgx.ErrNoRows}
	_, err := loadUserDetail(context.Background(), q, uuid.New(), unitToday)
	assert.ErrorIs(t, err, errUserNotFound)
	assert.Equal(t, 1, q.calls, "nothing else is read for a missing account")
}

func TestLoadUserDetail_PropagatesEveryError(t *testing.T) {
	t.Parallel()
	boom := errors.New("boom")
	cases := map[string]*fakeDetailQuerier{
		"detail":        {rowErr: boom},
		"days":          {daysErr: boom},
		"watches":       {watchesErr: boom},
		"subscriptions": {subsErr: boom},
		"sessions":      {sessionsErr: boom},
	}
	for name, q := range cases {
		_, err := loadUserDetail(context.Background(), q, uuid.New(), unitToday)
		assert.ErrorIs(t, err, boom, name)
		assert.NotErrorIs(t, err, errUserNotFound, name)
	}
}

func TestMeanScore(t *testing.T) {
	t.Parallel()
	assert.Nil(t, meanScore(0, 0), "nothing rated is null, not zero")
	assert.Nil(t, meanScore(5, 0))
	require.NotNil(t, meanScore(17, 2))
	assert.Equal(t, 8.5, *meanScore(17, 2))
	assert.InDelta(t, 23.0/3, *meanScore(23, 3), 1e-12)
}

// An account with nothing recorded: every list is [], every "never" is null.
func TestLoadUserDetail_EmptyAccountSerialisesNullsAndEmptyLists(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	q := &fakeDetailQuerier{row: dbgen.GetAdminUserDetailRow{
		ID: id, Username: "nobody", Email: "nobody@example.com",
		CreatedAt: ts(time.Date(2026, 1, 5, 3, 0, 0, 0, time.UTC)), IsPublic: true,
	}}
	got, err := loadUserDetail(context.Background(), q, id, unitToday)
	require.NoError(t, err)

	body, err := json.Marshal(got)
	require.NoError(t, err)
	for _, frag := range []string{
		`"instrumentedSince":null`, `"role":null`, `"avatarUrl":null`, `"lastSeenAt":null`,
		`"days90":[]`, `"avgScore":null`, `"lastUpdatedAt":null`, `"lastWatchedAt":null`,
		`"recentWatches":[]`, `"recentSubscriptions":[]`, `"sessions":[]`, `"today":"2026-03-02"`,
	} {
		assert.Contains(t, string(body), frag)
	}
}

func TestLoadUserDetail_MapsEveryRow(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	created := time.Date(2025, 11, 20, 1, 2, 3, 0, time.FixedZone("x", 3600))
	seen := time.Date(2026, 3, 2, 0, 30, 0, 0, time.UTC)
	avatar := "/avatars/a.webp"
	cn, romaji, eps := "番剧", "Bangumi", int32(12)
	score := int32(9)
	ua := uaWindowsChrome
	jp := "JP"
	sid := uuid.New()
	q := &fakeDetailQuerier{
		row: dbgen.GetAdminUserDetailRow{
			ID: id, Username: "someone", Email: "someone@example.com", Role: nil,
			CreatedAt: ts(created), IsPublic: false, AvatarUrl: &avatar,
			ActiveDays: 9, RecordedDays: 4, LastSeenAt: ts(seen), Logins: 3, Requests: 40,
			SubsTotal: 5, SubsWatching: 2, SubsCompleted: 1, SubsPlanToWatch: 1, SubsDropped: 1,
			SubsRated: 2, SubsScoreSum: 15, SubsLastUpdatedAt: ts(seen),
			WatchesTotal: 11, LastWatchedAt: ts(seen),
			Comments: 1, Replies: 2, Threads: 3, Reviews: 4, Danmaku: 5, Following: 6, Followers: 7,
			ReportsFiled: 8, EditSubmissions: 9,
			InstrumentedSince: pgDay("2026-01-10"),
		},
		days: []dbgen.ListAdminUserActivityDaysRow{
			{ActivityDate: pgDay("2026-01-01"), Recorded: false},
			{ActivityDate: pgDay("2026-03-02"), Recorded: true},
		},
		watches: []dbgen.ListAdminUserRecentWatchesRow{
			{AnilistID: 7, TitleChinese: &cn, TitleRomaji: &romaji, Episodes: &eps, Episode: 3, WatchedAt: ts(seen)},
		},
		subs: []dbgen.ListAdminUserRecentSubscriptionsRow{
			{AnilistID: 7, TitleChinese: &cn, Episodes: nil, Status: "completed", Score: &score, CurrentEpisode: 12, UpdatedAt: ts(seen)},
		},
		sessions: []dbgen.ListAdminUserLiveSessionsRow{
			{ID: sid, UserAgent: &ua, Country: &jp, CreatedAt: ts(created), LastUsedAt: ts(seen), ExpiresAt: ts(seen.Add(time.Hour))},
		},
	}

	got, err := loadUserDetail(context.Background(), q, id, unitToday)
	require.NoError(t, err)

	assert.Equal(t, reportingDate(unitToday), q.gotToday)
	assert.Equal(t, []int32{recentItemsLimit, recentItemsLimit}, q.gotLimits)
	assert.Equal(t, "2026-03-02", got.Today)
	require.NotNil(t, got.InstrumentedSince)
	assert.Equal(t, "2026-01-10", *got.InstrumentedSince)
	assert.Equal(t, userDetailAccount{
		ID: id, Username: "someone", Email: "someone@example.com", CreatedAt: created.UTC(), IsPublic: false, AvatarURL: &avatar,
	}, got.User)
	assert.Equal(t, int64(9), got.Activity.ActiveDays)
	assert.Equal(t, int64(4), got.Activity.RecordedDays)
	assert.Equal(t, []userActivityDay{{Date: "2026-01-01", Recorded: false}, {Date: "2026-03-02", Recorded: true}}, got.Activity.Days90)
	require.NotNil(t, got.Subscriptions.AvgScore)
	assert.Equal(t, 7.5, *got.Subscriptions.AvgScore)
	assert.Equal(t, userDetailCommunity{
		Comments: 1, Replies: 2, Threads: 3, Reviews: 4, Danmaku: 5, Following: 6, Followers: 7, ReportsFiled: 8, EditSubmissions: 9,
	}, got.Community)
	require.Len(t, got.RecentWatches, 1)
	assert.Equal(t, int32(3), got.RecentWatches[0].Episode)
	assert.Equal(t, &eps, got.RecentWatches[0].Episodes)
	require.Len(t, got.Sessions, 1)
	assert.Equal(t, userSessionView{
		ID: sid, Kind: "desktop", OS: "Windows", Browser: "Chrome", Country: &jp,
		CreatedAt: created.UTC(), LastUsedAt: seen, ExpiresAt: seen.Add(time.Hour),
	}, got.Sessions[0])
}

// keysOf is the sorted key set of a JSON object.
func keysOf(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var m map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &m), string(raw))
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sorted(keys ...string) []string {
	sort.Strings(keys)
	return keys
}

// The field names are users.ts's, exactly: a typo here is a blank cell in
// the drawer and nothing else would notice.
func TestUserDetailResponse_FieldNamesMatchTheWireContract(t *testing.T) {
	t.Parallel()
	cn := "x"
	q := &fakeDetailQuerier{
		row:      dbgen.GetAdminUserDetailRow{CreatedAt: ts(time.Now())},
		days:     []dbgen.ListAdminUserActivityDaysRow{{ActivityDate: pgDay("2026-03-01"), Recorded: true}},
		watches:  []dbgen.ListAdminUserRecentWatchesRow{{AnilistID: 1, TitleChinese: &cn, WatchedAt: ts(time.Now())}},
		subs:     []dbgen.ListAdminUserRecentSubscriptionsRow{{AnilistID: 1, Status: "watching", UpdatedAt: ts(time.Now())}},
		sessions: []dbgen.ListAdminUserLiveSessionsRow{{ID: uuid.New(), CreatedAt: ts(time.Now()), LastUsedAt: ts(time.Now()), ExpiresAt: ts(time.Now())}},
	}
	got, err := loadUserDetail(context.Background(), q, uuid.New(), unitToday)
	require.NoError(t, err)
	body, err := json.Marshal(got)
	require.NoError(t, err)

	var top map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(body, &top))
	assert.Equal(t, sorted("today", "instrumentedSince", "user", "activity", "subscriptions", "watches",
		"recentWatches", "recentSubscriptions", "sessions", "community"), keysOf(t, body))
	assert.Equal(t, sorted("_id", "username", "email", "role", "createdAt", "isPublic", "avatarUrl"), keysOf(t, top["user"]))
	assert.Equal(t, sorted("activeDays", "recordedDays", "lastSeenAt", "logins", "requests", "days90"), keysOf(t, top["activity"]))
	assert.Equal(t, sorted("total", "watching", "completed", "planToWatch", "dropped", "rated", "avgScore", "lastUpdatedAt"),
		keysOf(t, top["subscriptions"]))
	assert.Equal(t, sorted("total", "lastWatchedAt"), keysOf(t, top["watches"]))
	assert.Equal(t, sorted("comments", "replies", "threads", "reviews", "danmaku", "following", "followers",
		"reportsFiled", "editSubmissions"), keysOf(t, top["community"]))

	titles := []string{"anilistId", "titleChinese", "titleRomaji", "titleEnglish", "titleNative", "titleHant", "episodes"}
	var watches, subs, sessions, days []json.RawMessage
	require.NoError(t, json.Unmarshal(top["recentWatches"], &watches))
	require.NoError(t, json.Unmarshal(top["recentSubscriptions"], &subs))
	require.NoError(t, json.Unmarshal(top["sessions"], &sessions))
	var activity map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(top["activity"], &activity))
	require.NoError(t, json.Unmarshal(activity["days90"], &days))
	withTitles := func(extra ...string) []string { return sorted(slices.Concat(titles, extra)...) }
	assert.Equal(t, withTitles("episode", "watchedAt"), keysOf(t, watches[0]))
	assert.Equal(t, withTitles("status", "score", "currentEpisode", "updatedAt"), keysOf(t, subs[0]))
	assert.Equal(t, sorted("id", "kind", "os", "browser", "country", "createdAt", "lastUsedAt", "expiresAt"), keysOf(t, sessions[0]))
	assert.Equal(t, sorted("date", "recorded"), keysOf(t, days[0]))
}

func TestGetUser_MalformedID_400(t *testing.T) {
	t.Parallel()
	h := NewHandlers(nil, nil, nil, nil)
	rec := httptest.NewRecorder()
	h.GetUser(rec, requestWithUserID(t, http.MethodGet, "/api/admin/users/nope", "", "nope"))
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid user ID")
}
