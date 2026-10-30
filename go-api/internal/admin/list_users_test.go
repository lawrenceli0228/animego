package admin

// list_users_test.go — pure unit tests for the user table's query
// composition: what the query string turns into, which whitelisted SQL that
// selects, and which values travel as parameters.  The pg tests in
// list_users_pg_test.go run the same statements against the real schema.

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/activity"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// unitToday is a fixed reporting day: 2026-03-02 in +08.
var unitToday = activity.Day(time.Date(2026, 3, 1, 17, 30, 0, 0, time.UTC))

func listParams(t *testing.T, raw string) usersListParams {
	t.Helper()
	qs, err := url.ParseQuery(raw)
	require.NoError(t, err)
	return parseUsersListParams(qs, unitToday)
}

// The SQL every segment is expected to select, spelled out here so the test
// pins the semantics (the +08 signup day, the six-day lookback) rather than
// echoing the map it checks.
const (
	wantActive7SQL = `EXISTS (SELECT 1 FROM user_activity_daily AS a ` +
		`WHERE a.user_id = u.id AND a.activity_date >= p.today - 6)`
	wantReturnedSQL = `EXISTS (SELECT 1 FROM user_activity_daily AS a ` +
		`WHERE a.user_id = u.id AND a.activity_date > (u.created_at AT TIME ZONE 'Asia/Shanghai')::date)`
	wantSubscribedSQL = `EXISTS (SELECT 1 FROM subscriptions AS s WHERE s.user_id = u.id)`
	wantAdminSQL      = `u.role = 'admin'`
	wantFrom          = `WITH p AS (SELECT $1::date AS today) `
	wantTieBreak      = ` DESC NULLS LAST, u.created_at DESC, u.id DESC`
)

// assertPlaceholders checks that $1..$n all appear in sql and $n+1 does not:
// Postgres refuses a parameter it cannot type, and an extra one is a bug.
func assertPlaceholders(t *testing.T, sql string, n int) {
	t.Helper()
	for i := 1; i <= n; i++ {
		assert.Contains(t, sql, "$"+strconv.Itoa(i), "placeholder $%d unused in: %s", i, sql)
	}
	assert.NotContains(t, sql, "$"+strconv.Itoa(n+1), "placeholder beyond the args in: %s", sql)
}

// whereOf is the statement's outer WHERE clause, "" when it has none.  The
// projection's subqueries have WHERE clauses of their own, so the search
// starts after the row source.
func whereOf(sql string) string {
	i := strings.Index(sql, usersFrom)
	if i < 0 {
		return "<no row source>"
	}
	rest, ok := strings.CutPrefix(sql[i+len(usersFrom):], " WHERE ")
	if !ok {
		return ""
	}
	if j := strings.Index(rest, " ORDER BY "); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

func TestReportingDate_IsTheShanghaiCalendarDay(t *testing.T) {
	t.Parallel()
	// 17:30 UTC on the 1st is 01:30 on the 2nd in +08.
	got := reportingDate(unitToday)
	assert.Equal(t, pgtype.Date{Time: time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC), Valid: true}, got)
	assert.Equal(t, "2026-03-02", unitToday.Format(userDayLayout))
}

func TestBuildUsersListSQL_Defaults(t *testing.T) {
	t.Parallel()
	p := listParams(t, "")
	assert.Equal(t, segmentAll, p.Segment)
	assert.Equal(t, sortLastSeen, p.Sort)
	assert.Nil(t, p.Depth)
	assert.Equal(t, 1, p.Page)

	got := buildUsersListSQL(p)

	assert.True(t, strings.HasPrefix(got.List, wantFrom+"SELECT u.id, u.username, u.email, u.role, u.created_at, "), got.List)
	assert.Empty(t, whereOf(got.List))
	assert.Contains(t, got.List, " FROM users AS u CROSS JOIN p ORDER BY last_seen_at"+wantTieBreak+" LIMIT $2 OFFSET $3")
	assert.Equal(t, []any{reportingDate(unitToday), int64(30), int64(0)}, got.ListArgs)
	assertPlaceholders(t, got.List, len(got.ListArgs))

	assert.Equal(t, wantFrom+"SELECT count(*)::bigint FROM users AS u CROSS JOIN p", got.Count)
	assert.Equal(t, []any{reportingDate(unitToday)}, got.CountArgs)
	assertPlaceholders(t, got.Count, len(got.CountArgs))
}

func TestBuildUsersListSQL_EverySegment(t *testing.T) {
	t.Parallel()
	cases := []struct {
		segment string
		want    string // "" = no WHERE
	}{
		{segmentAll, ""},
		{segmentActive7, wantActive7SQL},
		{segmentReturned, wantReturnedSQL},
		{segmentNeverReturned, "NOT " + wantReturnedSQL},
		{segmentSubscribed, wantSubscribedSQL},
		{segmentAdmin, wantAdminSQL},
	}
	require.Len(t, cases, len(userSegmentOrder), "a segment without a case")
	for _, tc := range cases {
		t.Run(tc.segment, func(t *testing.T) {
			t.Parallel()
			got := buildUsersListSQL(listParams(t, "segment="+tc.segment))

			assert.Equal(t, tc.want, whereOf(got.List))
			assert.Equal(t, tc.want, whereOf(got.Count))
			// A segment adds SQL, never a parameter.
			assert.Equal(t, []any{reportingDate(unitToday), int64(30), int64(0)}, got.ListArgs)
			assert.Equal(t, []any{reportingDate(unitToday)}, got.CountArgs)
			assertPlaceholders(t, got.List, len(got.ListArgs))
			assertPlaceholders(t, got.Count, len(got.CountArgs))
		})
	}
}

func TestBuildUsersListSQL_EverySort(t *testing.T) {
	t.Parallel()
	cases := []struct {
		sort    string
		wantKey string
	}{
		{sortLastSeen, "last_seen_at"},
		{sortJoined, "u.created_at"},
		{sortActiveDays, "active_days"},
		{sortSubscriptions, "subscription_count"},
		{sortWatched, "watched_episodes"},
	}
	require.Len(t, cases, len(userSortKeys), "a sort without a case")
	for _, tc := range cases {
		t.Run(tc.sort, func(t *testing.T) {
			t.Parallel()
			got := buildUsersListSQL(listParams(t, "sort="+tc.sort))
			assert.Contains(t, got.List, " ORDER BY "+tc.wantKey+wantTieBreak+" LIMIT $2 OFFSET $3")
			assert.NotContains(t, got.Count, "ORDER BY", "the count must not sort")
		})
	}
}

// Every sort key except joined is an alias of the projection, so the column
// on screen and the order of the rows are the same expression.
func TestUserSortKeys_AreProjectedColumns(t *testing.T) {
	t.Parallel()
	for sort, key := range userSortKeys {
		if sort == sortJoined {
			continue
		}
		assert.Contains(t, userRowColumnsSQL, " AS "+key, "sort %s orders by %s, which the page does not project", sort, key)
	}
}

func TestParseUsersListParams_UnknownValuesFallBack(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, raw   string
		wantSegment string
		wantSort    string
	}{
		{"empty", "segment=&sort=", segmentAll, sortLastSeen},
		{"unknown", "segment=vip&sort=random", segmentAll, sortLastSeen},
		{"case matters", "segment=Admin&sort=LastSeen", segmentAll, sortLastSeen},
		{"sql in segment", "segment=" + url.QueryEscape("admin' OR '1'='1"), segmentAll, sortLastSeen},
		{"sql in sort", "sort=" + url.QueryEscape("u.id; DROP TABLE users"), segmentAll, sortLastSeen},
		{"valid", "segment=neverReturned&sort=watched", segmentNeverReturned, sortWatched},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			p := listParams(t, tc.raw)
			assert.Equal(t, tc.wantSegment, p.Segment)
			assert.Equal(t, tc.wantSort, p.Sort)
		})
	}
}

// The builder does not trust its input either: a params value that never
// went through the parser still yields whitelisted SQL.
func TestBuildUsersListSQL_UnvalidatedParamsStayWhitelisted(t *testing.T) {
	t.Parallel()
	evil := "x) OR 1=1; DROP TABLE users; --"
	got := buildUsersListSQL(usersListParams{Page: 0, Segment: evil, Sort: evil, Today: unitToday})

	assert.NotContains(t, got.List, "DROP")
	assert.NotContains(t, got.Count, "DROP")
	assert.Empty(t, whereOf(got.List))
	assert.Contains(t, got.List, " ORDER BY last_seen_at"+wantTieBreak)
	assert.Equal(t, int64(0), got.ListArgs[len(got.ListArgs)-1], "page < 1 reads as page 1")

	huge := buildUsersListSQL(usersListParams{Page: int(^uint(0) >> 1), Today: unitToday})
	assert.Equal(t, int64(maxUsersPage-1)*pageSize, huge.ListArgs[len(huge.ListArgs)-1], "the offset cannot overflow")
}

func TestParseDepthFilter(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name         string
		days, lo, hi string
		want         *depthFilter
	}{
		{"30 days, 3-6", "30", "3", "6", &depthFilter{Days: 30, Min: 3, Max: 6}},
		{"7 days, one day", "7", "1", "1", &depthFilter{Days: 7, Min: 1, Max: 1}},
		{"90 days, open top", "90", "14", "90", &depthFilter{Days: 90, Min: 14, Max: 90}},
		{"window not offered", "14", "1", "2", nil},
		{"zero min", "30", "0", "6", nil},
		{"negative min", "30", "-1", "6", nil},
		{"min above max", "30", "7", "6", nil},
		{"missing days", "", "1", "2", nil},
		{"missing min", "30", "", "2", nil},
		{"missing max", "30", "1", "", nil},
		{"not a number", "30", "one", "2", nil},
		{"fraction", "30", "1.5", "2", nil},
		{"overflows int32", "30", "1", "99999999999", nil},
		{"padded", "30", " 1", "2", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, parseDepthFilter(tc.days, tc.lo, tc.hi))
		})
	}
}

func TestBuildUsersListSQL_DepthFilter(t *testing.T) {
	t.Parallel()
	got := buildUsersListSQL(listParams(t, "depthDays=30&depthMin=3&depthMax=6"))

	wantDepth := `(SELECT count(*) FROM user_activity_daily AS a WHERE a.user_id = u.id ` +
		`AND a.activity_date BETWEEN p.today - ($2::int - 1) AND p.today) BETWEEN $3::int AND $4::int`
	assert.Equal(t, wantDepth, whereOf(got.List))
	assert.Equal(t, wantDepth, whereOf(got.Count))
	assert.Contains(t, got.List, " LIMIT $5 OFFSET $6")
	assert.Equal(t, []any{reportingDate(unitToday), int32(30), int32(3), int32(6), int64(30), int64(0)}, got.ListArgs)
	assert.Equal(t, []any{reportingDate(unitToday), int32(30), int32(3), int32(6)}, got.CountArgs)
	assertPlaceholders(t, got.List, len(got.ListArgs))
	assertPlaceholders(t, got.Count, len(got.CountArgs))
}

func TestBuildUsersListSQL_InvalidDepthIsIgnored(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		"depthDays=30&depthMin=0&depthMax=6",
		"depthDays=30&depthMin=3",
		"depthDays=31&depthMin=3&depthMax=6",
	} {
		got := buildUsersListSQL(listParams(t, raw))
		assert.Empty(t, whereOf(got.List), raw)
		assert.Len(t, got.ListArgs, 3, raw)
	}
}

func TestBuildUsersListSQL_EverythingTogether(t *testing.T) {
	t.Parallel()
	got := buildUsersListSQL(listParams(t, "q=alice&segment=returned&sort=watched&depthDays=7&depthMin=2&depthMax=2&page=3"))

	assert.Equal(t,
		`(u.username ILIKE $2 OR u.email ILIKE $2) AND `+wantReturnedSQL+` AND `+
			`(SELECT count(*) FROM user_activity_daily AS a WHERE a.user_id = u.id `+
			`AND a.activity_date BETWEEN p.today - ($3::int - 1) AND p.today) BETWEEN $4::int AND $5::int`,
		whereOf(got.List))
	assert.Contains(t, got.List, " ORDER BY watched_episodes"+wantTieBreak+" LIMIT $6 OFFSET $7")
	assert.Equal(t, []any{reportingDate(unitToday), "%alice%", int32(7), int32(2), int32(2), int64(30), int64(60)}, got.ListArgs)
	assert.Equal(t, got.ListArgs[:5], got.CountArgs)
	assert.Equal(t, whereOf(got.List), whereOf(got.Count))
}

func TestBuildUsersListSQL_SearchIsAParameter(t *testing.T) {
	t.Parallel()
	q := "o'brien'); DROP TABLE users; --"
	got := buildUsersListSQL(listParams(t, "q="+url.QueryEscape(q)))

	assert.Equal(t, "(u.username ILIKE $2 OR u.email ILIKE $2)", whereOf(got.List))
	assert.NotContains(t, got.List, "brien")
	assert.NotContains(t, got.Count, "brien")
	assert.Equal(t, "%"+q+"%", got.ListArgs[1])
}

func TestBuildUsersListSQL_SearchEscapesWildcards(t *testing.T) {
	t.Parallel()
	got := buildUsersListSQL(listParams(t, "q="+url.QueryEscape(`a%_b\`)))
	require.Len(t, got.CountArgs, 2)
	assert.Equal(t, `%a\%\_b\\%`, got.CountArgs[1])
}

func TestBuildUsersListSQL_BlankSearchIsNoFilter(t *testing.T) {
	t.Parallel()
	got := buildUsersListSQL(listParams(t, "q="+url.QueryEscape("  \t  ")))
	assert.NotContains(t, got.List, "ILIKE")
	assert.Empty(t, whereOf(got.List))
	assert.Len(t, got.CountArgs, 1)
}

func TestBuildUsersListSQL_Pagination(t *testing.T) {
	t.Parallel()
	offsetOf := func(raw string) any {
		args := buildUsersListSQL(listParams(t, raw)).ListArgs
		return args[len(args)-1]
	}
	assert.Equal(t, int64(0), offsetOf("page=1"))
	assert.Equal(t, int64(30), offsetOf("page=2"))
	assert.Equal(t, int64(120), offsetOf("page=5"))
	// A page past any real one is capped instead of overflowing the offset.
	assert.Equal(t, maxUsersPage, listParams(t, "page=99999999999999").Page)
	assert.Equal(t, int64(maxUsersPage-1)*pageSize, offsetOf("page=99999999999999"))
}

func TestUserSegmentsSQL_CountsEverySegmentFromTheSamePredicates(t *testing.T) {
	t.Parallel()
	want := wantFrom + "SELECT count(*)::bigint, " +
		"count(*) FILTER (WHERE " + wantActive7SQL + ")::bigint, " +
		"count(*) FILTER (WHERE " + wantReturnedSQL + ")::bigint, " +
		"count(*) FILTER (WHERE NOT " + wantReturnedSQL + ")::bigint, " +
		"count(*) FILTER (WHERE " + wantSubscribedSQL + ")::bigint, " +
		"count(*) FILTER (WHERE " + wantAdminSQL + ")::bigint" +
		" FROM users AS u CROSS JOIN p"
	assert.Equal(t, want, userSegmentsSQL)
	assertPlaceholders(t, userSegmentsSQL, 1)
}

// The row's returned flag is the segment's predicate, verbatim.
func TestUserRowColumns_ReturnedIsTheSegmentPredicate(t *testing.T) {
	t.Parallel()
	assert.Contains(t, userRowColumnsSQL, wantReturnedSQL+" AS returned")
}

func TestParsePage(t *testing.T) {
	t.Parallel()

	cases := []struct {
		input string
		want  int
	}{
		{"", 1},
		{"1", 1},
		{"2", 2},
		{"99", 99},
		{"-5", 1},
		{"0", 1},
		{"abc", 1},
		{"1.5", 1},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, parsePage(tc.input))
		})
	}
}

// The field names are users.ts's, exactly.  The pg tests decode into the
// same Go structs, which a mistyped tag would survive.
func TestUserListResponse_FieldNamesMatchTheWireContract(t *testing.T) {
	t.Parallel()
	country := "JP"
	body, err := json.Marshal(userListResponse{
		Data:  []userItem{{ID: uuid.New(), RecentActiveDates: []string{}, LastDevice: &userDevice{Country: &country}}},
		Today: "2026-03-02",
	})
	require.NoError(t, err)

	var top map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(body, &top))
	assert.Equal(t, sorted("data", "hasMore", "total", "page", "today", "segments"), keysOf(t, body))
	assert.Equal(t, sorted("all", "active7", "returned", "neverReturned", "subscribed", "admin"), keysOf(t, top["segments"]))

	var rows []json.RawMessage
	require.NoError(t, json.Unmarshal(top["data"], &rows))
	require.Len(t, rows, 1)
	assert.Equal(t, sorted("_id", "username", "email", "role", "createdAt", "lastSeenAt", "activeDays", "logins",
		"subscriptions", "followers", "ratings", "watchedEpisodes", "returned", "recentActiveDates", "lastDevice"),
		keysOf(t, rows[0]))
	var row map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rows[0], &row))
	assert.Equal(t, sorted("kind", "os", "browser", "country", "lastUsedAt"), keysOf(t, row["lastDevice"]))
}

// --- attachUserBatches -------------------------------------------------------

type fakeBatchQuerier struct {
	days       []dbgen.ListAdminUserRecentDaysRow
	devices    []dbgen.ListAdminUserLastDevicesRow
	daysErr    error
	devicesErr error
	gotIDs     []uuid.UUID
	gotToday   pgtype.Date
}

func (f *fakeBatchQuerier) ListAdminUserRecentDays(_ context.Context, ids []uuid.UUID, today pgtype.Date) ([]dbgen.ListAdminUserRecentDaysRow, error) {
	f.gotIDs, f.gotToday = ids, today
	return f.days, f.daysErr
}

func (f *fakeBatchQuerier) ListAdminUserLastDevices(_ context.Context, _ []uuid.UUID) ([]dbgen.ListAdminUserLastDevicesRow, error) {
	return f.devices, f.devicesErr
}

func pgDay(s string) pgtype.Date {
	d, err := time.Parse(userDayLayout, s)
	if err != nil {
		panic(err)
	}
	return pgtype.Date{Time: d, Valid: true}
}

func TestAttachUserBatches_FillsEachAccountFromOneQueryEach(t *testing.T) {
	t.Parallel()
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	items := []userItem{
		{ID: a, RecentActiveDates: []string{}},
		{ID: b, RecentActiveDates: []string{}},
		{ID: c, RecentActiveDates: []string{}},
	}
	used := time.Date(2026, 3, 1, 22, 15, 0, 0, time.FixedZone("x", 3600))
	country := "JP"
	ua := "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	q := &fakeBatchQuerier{
		days: []dbgen.ListAdminUserRecentDaysRow{
			{UserID: a, ActivityDate: pgDay("2026-02-01")},
			{UserID: a, ActivityDate: pgDay("2026-03-02")},
			{UserID: c, ActivityDate: pgDay("2026-02-20")},
			{UserID: uuid.New(), ActivityDate: pgDay("2026-02-21")}, // not on the page
		},
		devices: []dbgen.ListAdminUserLastDevicesRow{
			{UserID: b, UserAgent: &ua, Country: &country, LastUsedAt: pgtype.Timestamptz{Time: used, Valid: true}},
			{UserID: c, UserAgent: nil, Country: nil, LastUsedAt: pgtype.Timestamptz{Time: used, Valid: true}},
		},
	}

	require.NoError(t, attachUserBatches(context.Background(), q, items, unitToday))

	assert.Equal(t, []uuid.UUID{a, b, c}, q.gotIDs)
	assert.Equal(t, reportingDate(unitToday), q.gotToday)
	assert.Equal(t, []string{"2026-02-01", "2026-03-02"}, items[0].RecentActiveDates)
	assert.Equal(t, []string{}, items[1].RecentActiveDates)
	assert.Equal(t, []string{"2026-02-20"}, items[2].RecentActiveDates)

	assert.Nil(t, items[0].LastDevice)
	require.NotNil(t, items[1].LastDevice)
	assert.Equal(t, userDevice{Kind: "phone", OS: "iPhone", Browser: "Safari", Country: &country, LastUsedAt: used.UTC()}, *items[1].LastDevice)
	require.NotNil(t, items[2].LastDevice)
	assert.Equal(t, userDevice{Kind: "unknown", OS: "", Browser: "", Country: nil, LastUsedAt: used.UTC()}, *items[2].LastDevice,
		"a session that never stated a User-Agent is an unknown device, not a missing one")
}

func TestAttachUserBatches_EmptyPageQueriesNothing(t *testing.T) {
	t.Parallel()
	q := &fakeBatchQuerier{daysErr: errors.New("must not be called")}
	require.NoError(t, attachUserBatches(context.Background(), q, nil, unitToday))
	assert.Nil(t, q.gotIDs)
}

func TestAttachUserBatches_PropagatesErrors(t *testing.T) {
	t.Parallel()
	items := []userItem{{ID: uuid.New(), RecentActiveDates: []string{}}}
	err := attachUserBatches(context.Background(), &fakeBatchQuerier{daysErr: errors.New("boom")}, items, unitToday)
	assert.ErrorContains(t, err, "recent days")
	err = attachUserBatches(context.Background(), &fakeBatchQuerier{devicesErr: errors.New("boom")}, items, unitToday)
	assert.ErrorContains(t, err, "last devices")
}
