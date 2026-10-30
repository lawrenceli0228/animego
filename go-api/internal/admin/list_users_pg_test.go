package admin

// list_users_pg_test.go — GET /api/admin/users against the real schema:
// every segment and sort, the depth filter, the 30-day strip, the +08
// signup day behind `returned`, and the last device.
//
// Each test pins the handler's clock (pinUsersClock) and seeds dates
// relative to the reporting day that clock implies, so a run that straddles
// midnight +08 cannot move a boundary between the seed and the request.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/activity"
)

// usersTestZone is the reporting zone (+08) for writing seed instants.
var usersTestZone = time.FixedZone("UTC+8", 8*60*60)

// pinUsersClock freezes h's clock at the current instant and returns the
// reporting day it implies.
func pinUsersClock(h *Handlers) time.Time {
	now := time.Now()
	h.now = func() time.Time { return now }
	return activity.Day(now)
}

// dayOf is the reporting day offset days from today, as YYYY-MM-DD.
func dayOf(today time.Time, offset int) string {
	return today.AddDate(0, 0, offset).Format(userDayLayout)
}

// localAt is hh:mm in +08 on the reporting day offset days from today.
func localAt(today time.Time, offset, hour, minute int) time.Time {
	d := today.AddDate(0, 0, offset)
	return time.Date(d.Year(), d.Month(), d.Day(), hour, minute, 0, 0, usersTestZone)
}

// seedDay records userID on the reporting day offset days from today,
// between 10:00 and 12:00 +08.
func seedDay(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, today time.Time, offset int) {
	t.Helper()
	archiveSeedDay(t, pool, userID, dayOf(today, offset), localAt(today, offset, 10, 0), localAt(today, offset, 12, 0), 1, 0)
}

func setRole(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, role string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `UPDATE users SET role = $2 WHERE id = $1`, userID, role)
	require.NoError(t, err)
}

// seedSub writes one subscription with an explicit status, score and
// updated_at.
func seedSub(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32, status string, score *int32, updatedAt time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO subscriptions (user_id, anilist_id, status, score, current_episode, created_at, updated_at)
		VALUES ($1, $2, $3, $4, 1, $5, $5)`,
		userID, anilistID, status, score, updatedAt)
	require.NoError(t, err, "seedSub")
}

func seedWatch(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID, episode int32, watchedAt time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO episode_watches (user_id, anilist_id, episode, watched_at)
		VALUES ($1, $2, $3, $4)`,
		userID, anilistID, episode, watchedAt)
	require.NoError(t, err, "seedWatch")
}

// sessionSeed is one user_sessions row.  Zero CreatedAt means LastUsed.
type sessionSeed struct {
	UserAgent *string
	Country   *string
	CreatedAt time.Time
	LastUsed  time.Time
	Expires   time.Time
}

// seedSession writes a session the way a login would, with a digest (never
// a token) in token_hash.
func seedSession(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, s sessionSeed) uuid.UUID {
	t.Helper()
	id := uuid.New()
	sum := sha256.Sum256([]byte(id.String()))
	created := s.CreatedAt
	if created.IsZero() {
		created = s.LastUsed
	}
	_, err := pool.Exec(context.Background(), `
		INSERT INTO user_sessions (
			id, user_id, token_hash, token_jti, token_iat, token_exp, expires_at,
			created_at, last_used_at, user_agent, country
		) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10)`,
		id, userID, hex.EncodeToString(sum[:]), uuid.New(), created, s.Expires,
		created, s.LastUsed, s.UserAgent, s.Country)
	require.NoError(t, err, "seedSession")
	return id
}

func getUsersPage(t *testing.T, h *Handlers, query string) (userListResponse, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users"+query, nil))
	require.Equal(t, http.StatusOK, rec.Code, "body: %s", rec.Body.String())
	var got userListResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	return got, rec.Body.String()
}

func usernamesOf(items []userItem) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Username
	}
	return out
}

func sortedUsernames(items []userItem) []string {
	out := usernamesOf(items)
	sort.Strings(out)
	return out
}

const (
	uaIPhoneSafari  = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	uaWindowsChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
	uaMacFirefox    = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0"
)

// TestListUsers_EverySegment_PG checks each segment's membership, its total,
// the segment counts, and that the row's returned flag agrees with them.
// Two accounts sit on the active7 edge: today-6 is in, today-7 is out.
func TestListUsers_EverySegment_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	admin := seedUserAt(t, pool, "seg_admin", "seg_admin@example.com", localAt(today, -40, 9, 0))
	setRole(t, pool, admin, "admin")
	seedDay(t, pool, admin, today, -40) // signup day only

	back := seedUserAt(t, pool, "seg_back", "seg_back@example.com", localAt(today, -20, 9, 0))
	seedDay(t, pool, back, today, -20)
	seedDay(t, pool, back, today, -2)

	oldBack := seedUserAt(t, pool, "seg_oldback", "seg_oldback@example.com", localAt(today, -30, 9, 0))
	seedDay(t, pool, oldBack, today, -25)

	fresh := seedUserAt(t, pool, "seg_fresh", "seg_fresh@example.com", localAt(today, 0, 0, 30))
	seedDay(t, pool, fresh, today, 0) // signed up and active today only

	seedUserAt(t, pool, "seg_quiet", "seg_quiet@example.com", localAt(today, -5, 9, 0))

	edge6 := seedUserAt(t, pool, "seg_edge6", "seg_edge6@example.com", localAt(today, -50, 9, 0))
	seedDay(t, pool, edge6, today, -6)
	edge7 := seedUserAt(t, pool, "seg_edge7", "seg_edge7@example.com", localAt(today, -50, 9, 0))
	seedDay(t, pool, edge7, today, -7)

	seedAnime(t, pool, animeSeed{AnilistID: 1})
	seedSubscription(t, pool, back, 1)
	seedSubscription(t, pool, fresh, 1)

	want := map[string][]string{
		segmentAll:           {"seg_admin", "seg_back", "seg_edge6", "seg_edge7", "seg_fresh", "seg_oldback", "seg_quiet"},
		segmentActive7:       {"seg_back", "seg_edge6", "seg_fresh"},
		segmentReturned:      {"seg_back", "seg_edge6", "seg_edge7", "seg_oldback"},
		segmentNeverReturned: {"seg_admin", "seg_fresh", "seg_quiet"},
		segmentSubscribed:    {"seg_back", "seg_fresh"},
		segmentAdmin:         {"seg_admin"},
	}
	wantCounts := userSegmentCounts{All: 7, Active7: 3, Returned: 4, NeverReturned: 3, Subscribed: 2, Admin: 1}

	returned := map[string]bool{}
	for _, name := range want[segmentReturned] {
		returned[name] = true
	}
	for _, seg := range userSegmentOrder {
		got, _ := getUsersPage(t, h, "?segment="+seg)
		assert.Equal(t, want[seg], sortedUsernames(got.Data), "segment %s", seg)
		assert.Equal(t, int64(len(want[seg])), got.Total, "segment %s total", seg)
		assert.Equal(t, wantCounts, got.Segments, "segment counts on ?segment=%s", seg)
		assert.Equal(t, today.Format(userDayLayout), got.Today)
		for _, it := range got.Data {
			assert.Equal(t, returned[it.Username], it.Returned, "%s returned flag", it.Username)
		}
	}
}

// The chips count segments, not the current search.
func TestListUsers_SegmentsIgnoreSearchAndDepth_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	a := seedUserAt(t, pool, "chip_alpha", "chip_alpha@example.com", localAt(today, -10, 9, 0))
	seedDay(t, pool, a, today, -1)
	seedUserAt(t, pool, "chip_beta", "chip_beta@example.com", localAt(today, -10, 9, 0))

	all, _ := getUsersPage(t, h, "")
	filtered, _ := getUsersPage(t, h, "?q=alpha&depthDays=7&depthMin=1&depthMax=1&segment=returned")

	assert.Equal(t, userSegmentCounts{All: 2, Active7: 1, Returned: 1, NeverReturned: 1}, all.Segments)
	assert.Equal(t, all.Segments, filtered.Segments)
	assert.Equal(t, []string{"chip_alpha"}, usernamesOf(filtered.Data))
	assert.Equal(t, int64(1), filtered.Total)
}

// TestListUsers_EverySort_PG gives four accounts a different rank under
// every sort.  Ties fall back to created_at DESC (watched: the two accounts
// with no marks), and a never-seen account sorts last under lastSeen.
func TestListUsers_EverySort_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	a := seedUserAt(t, pool, "sort_a", "sort_a@example.com", localAt(today, -10, 8, 0))
	b := seedUserAt(t, pool, "sort_b", "sort_b@example.com", localAt(today, -9, 8, 0))
	seedUserAt(t, pool, "sort_c", "sort_c@example.com", localAt(today, -8, 8, 0)) // never seen, nothing
	d := seedUserAt(t, pool, "sort_d", "sort_d@example.com", localAt(today, -7, 8, 0))

	// last seen: b today 00:20, a yesterday 20:00, d three days ago; c never.
	archiveSeedDay(t, pool, a, dayOf(today, -1), localAt(today, -1, 19, 0), localAt(today, -1, 20, 0), 1, 0)
	archiveSeedDay(t, pool, b, dayOf(today, -1), localAt(today, -1, 8, 0), localAt(today, -1, 8, 30), 1, 0)
	archiveSeedDay(t, pool, b, dayOf(today, 0), localAt(today, 0, 0, 10), localAt(today, 0, 0, 20), 1, 0)
	for _, off := range []int{-5, -4, -3} {
		seedDay(t, pool, d, today, off)
	}

	for id := int32(1); id <= 3; id++ {
		seedAnime(t, pool, animeSeed{AnilistID: id})
	}
	updated := localAt(today, -1, 12, 0)
	// subscriptions: a 3, d 2, b 1, c 0.
	for id := int32(1); id <= 3; id++ {
		seedSub(t, pool, a, id, "plan_to_watch", nil, updated)
	}
	seedSub(t, pool, d, 1, "watching", nil, updated)
	seedSub(t, pool, d, 2, "watching", nil, updated)
	seedSub(t, pool, b, 1, "watching", nil, updated)
	// watched episodes: b 5, d 2, a and c 0.
	for ep := int32(1); ep <= 5; ep++ {
		seedWatch(t, pool, b, 1, ep, updated)
	}
	seedWatch(t, pool, d, 1, 1, updated)
	seedWatch(t, pool, d, 2, 1, updated)

	cases := []struct {
		query string
		want  []string
	}{
		{"", []string{"sort_b", "sort_a", "sort_d", "sort_c"}},
		{"?sort=lastSeen", []string{"sort_b", "sort_a", "sort_d", "sort_c"}},
		{"?sort=unknown", []string{"sort_b", "sort_a", "sort_d", "sort_c"}},
		{"?sort=joined", []string{"sort_d", "sort_c", "sort_b", "sort_a"}},
		{"?sort=activeDays", []string{"sort_d", "sort_b", "sort_a", "sort_c"}},
		{"?sort=subscriptions", []string{"sort_a", "sort_d", "sort_b", "sort_c"}},
		{"?sort=watched", []string{"sort_b", "sort_d", "sort_c", "sort_a"}},
	}
	for _, tc := range cases {
		got, _ := getUsersPage(t, h, tc.query)
		assert.Equal(t, tc.want, usernamesOf(got.Data), "order for %q", tc.query)
	}

	// The sort keys are the columns on screen.
	got, _ := getUsersPage(t, h, "?sort=activeDays")
	byName := map[string]userItem{}
	for _, it := range got.Data {
		byName[it.Username] = it
	}
	assert.Equal(t, int64(3), byName["sort_d"].ActiveDays)
	assert.Equal(t, int64(3), byName["sort_a"].Subscriptions)
	assert.Equal(t, int64(5), byName["sort_b"].WatchedEpisodes)
	require.NotNil(t, byName["sort_b"].LastSeenAt)
	assert.True(t, byName["sort_b"].LastSeenAt.Equal(localAt(today, 0, 0, 20)))
	assert.Nil(t, byName["sort_c"].LastSeenAt)
}

// Accounts that tie on every key still page without repeats or gaps.
func TestListUsers_TiesPageStably_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	same := localAt(today, -3, 9, 0)
	for i := 0; i < 35; i++ {
		seedUserAt(t, pool, "tie_"+string(rune('a'+i/26))+string(rune('a'+i%26)), "tie"+uuid.NewString()+"@example.com", same)
	}

	first, _ := getUsersPage(t, h, "?page=1")
	second, _ := getUsersPage(t, h, "?page=2")
	require.Len(t, first.Data, 30)
	require.Len(t, second.Data, 5)
	assert.True(t, first.HasMore)
	assert.False(t, second.HasMore)
	assert.Equal(t, int64(35), second.Total)

	seen := map[uuid.UUID]bool{}
	var ids []string
	for _, it := range append(first.Data, second.Data...) {
		assert.False(t, seen[it.ID], "repeated across pages: %s", it.Username)
		seen[it.ID] = true
		ids = append(ids, it.ID.String())
	}
	assert.Len(t, seen, 35)
	assert.True(t, sort.IsSorted(sort.Reverse(sort.StringSlice(ids))), "equal keys fall back to id DESC")
}

// The strip covers [today-29, today]: today-29 is in, today-30 is out, and
// activeDays still counts all time.
func TestListUsers_RecentActiveDatesWindow_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	busy := seedUserAt(t, pool, "strip_busy", "strip_busy@example.com", localAt(today, -60, 9, 0))
	for _, off := range []int{-30, -29, -15, 0} {
		seedDay(t, pool, busy, today, off)
	}
	seedUserAt(t, pool, "strip_none", "strip_none@example.com", localAt(today, -60, 8, 0))

	got, body := getUsersPage(t, h, "?sort=joined")
	require.Len(t, got.Data, 2)
	byName := map[string]userItem{}
	for _, it := range got.Data {
		byName[it.Username] = it
	}

	assert.Equal(t, []string{dayOf(today, -29), dayOf(today, -15), dayOf(today, 0)}, byName["strip_busy"].RecentActiveDates)
	assert.Equal(t, int64(4), byName["strip_busy"].ActiveDays)
	assert.Equal(t, []string{}, byName["strip_none"].RecentActiveDates)
	assert.Contains(t, body, `"recentActiveDates":[]`, "an empty strip is [], never null")
}

// returned compares activity days with the signup day on the +08 boundary.
// 00:30 +08 is still the previous day in UTC: bucketed in UTC, an account
// active only on its signup day would read as having come back.
func TestListUsers_ReturnedUsesTheShanghaiSignupDay_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	signup := localAt(today, -10, 0, 30) // the previous calendar day in UTC
	require.NotEqual(t, signup.UTC().Format(userDayLayout), dayOf(today, -10), "the seed must straddle the UTC date line")

	sameDay := seedUserAt(t, pool, "tz_same_day", "tz_same@example.com", signup)
	seedDay(t, pool, sameDay, today, -10)

	nextDay := seedUserAt(t, pool, "tz_next_day", "tz_next@example.com", signup)
	seedDay(t, pool, nextDay, today, -10)
	seedDay(t, pool, nextDay, today, -9)

	late := seedUserAt(t, pool, "tz_late", "tz_late@example.com", localAt(today, -10, 23, 59))
	seedDay(t, pool, late, today, -9) // 23:59 signup, back the next +08 morning

	got, _ := getUsersPage(t, h, "")
	flags := map[string]bool{}
	for _, it := range got.Data {
		flags[it.Username] = it.Returned
	}
	assert.Equal(t, map[string]bool{"tz_same_day": false, "tz_next_day": true, "tz_late": true}, flags)

	never, _ := getUsersPage(t, h, "?segment=neverReturned")
	assert.Equal(t, []string{"tz_same_day"}, usernamesOf(never.Data))
	assert.Equal(t, int64(2), never.Segments.Returned)
}

// lastDevice is the live session used most recently — not the one opened
// most recently — and an expired one is ignored even when it was used later.
func TestListUsers_LastDevice_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)
	now := time.Now()
	live := now.Add(30 * 24 * time.Hour)
	jp, cn := "JP", "CN"
	iphone, windows, mac := uaIPhoneSafari, uaWindowsChrome, uaMacFirefox

	user := seedUserAt(t, pool, "dev_user", "dev_user@example.com", localAt(today, -30, 9, 0))
	// Opened most recently, used two hours ago.
	seedSession(t, pool, user, sessionSeed{UserAgent: &windows, Country: &jp,
		CreatedAt: now.Add(-3 * time.Hour), LastUsed: now.Add(-2 * time.Hour), Expires: live})
	// Opened ten days ago, used a minute ago: the last device.
	newest := now.Add(-time.Minute).Truncate(time.Microsecond)
	seedSession(t, pool, user, sessionSeed{UserAgent: &iphone, Country: &cn,
		CreatedAt: now.Add(-10 * 24 * time.Hour), LastUsed: newest, Expires: live})
	seedSession(t, pool, user, sessionSeed{UserAgent: &mac, LastUsed: now.Add(-10 * time.Second), Expires: now.Add(-time.Hour)})

	expiredOnly := seedUserAt(t, pool, "dev_expired", "dev_expired@example.com", localAt(today, -30, 8, 0))
	seedSession(t, pool, expiredOnly, sessionSeed{UserAgent: &mac, LastUsed: now.Add(-2 * time.Hour), Expires: now.Add(-time.Hour)})

	seedUserAt(t, pool, "dev_none", "dev_none@example.com", localAt(today, -30, 7, 0))

	got, body := getUsersPage(t, h, "?sort=joined")
	byName := map[string]userItem{}
	for _, it := range got.Data {
		byName[it.Username] = it
	}

	dev := byName["dev_user"].LastDevice
	require.NotNil(t, dev)
	assert.Equal(t, "phone", dev.Kind)
	assert.Equal(t, "iPhone", dev.OS)
	assert.Equal(t, "Safari", dev.Browser)
	require.NotNil(t, dev.Country)
	assert.Equal(t, "CN", *dev.Country)
	assert.True(t, dev.LastUsedAt.Equal(newest), "lastUsedAt %v, want %v", dev.LastUsedAt, newest)

	assert.Nil(t, byName["dev_expired"].LastDevice, "an expired session is not a last device")
	assert.Nil(t, byName["dev_none"].LastDevice)
	assert.Contains(t, body, `"lastDevice":null`)
}

// The handlers take today in +08.  At 17:30 UTC it is already tomorrow in
// +08, so a handler that took the UTC date would answer a day behind: its
// strip would hold today-30 and miss today.  The clock is pinned to that
// instant rather than left to whenever the suite happens to run.
func TestUserTable_TodayIsTheShanghaiDay_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	u := time.Now().UTC()
	pinned := time.Date(u.Year(), u.Month(), u.Day(), 17, 30, 0, 0, time.UTC)
	h.now = func() time.Time { return pinned }
	today := activity.Day(pinned)
	require.NotEqual(t, pinned.Format(userDayLayout), today.Format(userDayLayout))

	user := seedUserAt(t, pool, "tz_today", "tz_today@example.com", localAt(today, -40, 9, 0))
	seedDay(t, pool, user, today, 0)
	seedDay(t, pool, user, today, -30)

	got, _ := getUsersPage(t, h, "")
	assert.Equal(t, today.Format(userDayLayout), got.Today)
	require.Len(t, got.Data, 1)
	assert.Equal(t, []string{dayOf(today, 0)}, got.Data[0].RecentActiveDates)
	assert.Equal(t, int64(1), got.Segments.Active7)

	rec, detail := getUserDetail(t, h, user.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, today.Format(userDayLayout), detail.Today)
	assert.Equal(t, []userActivityDay{
		{Date: dayOf(today, -30), Recorded: true},
		{Date: dayOf(today, 0), Recorded: true},
	}, detail.Activity.Days90)
}

// The depth filter counts distinct days inside the window only.
func TestListUsers_DepthFilter_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	seedDays := func(name string, offsets ...int) {
		id := seedUserAt(t, pool, name, name+"@example.com", localAt(today, -60, 9, 0))
		for _, off := range offsets {
			seedDay(t, pool, id, today, off)
		}
	}
	seedDays("depth_three", -29, -10, -1)
	seedDays("depth_two", -3, 0)
	seedDays("depth_edge", -30, -2, -1) // two in the window; the third is a day too old
	seedDays("depth_seven", -6, -5, -4, -3, -2, -1, 0)
	seedDays("depth_none")
	// Signed up today and seen only today: in every short window, never
	// returned.
	fresh := seedUserAt(t, pool, "depth_new", "depth_new@example.com", localAt(today, 0, 0, 30))
	seedDay(t, pool, fresh, today, 0)

	got, _ := getUsersPage(t, h, "?depthDays=30&depthMin=3&depthMax=6")
	assert.Equal(t, []string{"depth_three"}, usernamesOf(got.Data))
	assert.Equal(t, int64(1), got.Total)

	got, _ = getUsersPage(t, h, "?depthDays=30&depthMin=2&depthMax=2")
	assert.Equal(t, []string{"depth_edge", "depth_two"}, sortedUsernames(got.Data))

	got, _ = getUsersPage(t, h, "?depthDays=7&depthMin=7&depthMax=7")
	assert.Equal(t, []string{"depth_seven"}, usernamesOf(got.Data))

	got, _ = getUsersPage(t, h, "?depthDays=7&depthMin=1&depthMax=2")
	assert.Equal(t, []string{"depth_edge", "depth_new", "depth_three", "depth_two"}, sortedUsernames(got.Data))
	got, _ = getUsersPage(t, h, "?depthDays=7&depthMin=1&depthMax=2&segment=returned")
	assert.Equal(t, []string{"depth_edge", "depth_three", "depth_two"}, sortedUsernames(got.Data))

	// Invalid triples are ignored, not answered with nothing.
	for _, q := range []string{"?depthDays=30&depthMin=0&depthMax=6", "?depthDays=30&depthMin=3", "?depthDays=10&depthMin=1&depthMax=2"} {
		got, _ = getUsersPage(t, h, q)
		assert.Equal(t, int64(6), got.Total, q)
	}
}

// LIKE wildcards in q are literal characters.
func TestListUsers_SearchEscapesWildcards_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	seedUserAt(t, pool, "under_score", "u1@example.com", localAt(today, -1, 9, 0))
	seedUserAt(t, pool, "underXscore", "u2@example.com", localAt(today, -1, 8, 0))

	got, _ := getUsersPage(t, h, "?q=r_s")
	assert.Equal(t, []string{"under_score"}, usernamesOf(got.Data))
	got, _ = getUsersPage(t, h, "?q=%25")
	assert.Empty(t, got.Data)
	assert.Equal(t, int64(0), got.Total)
}

// The per-row counters, read off one seeded account.
func TestListUsers_RowCounters_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)

	user := seedUserAt(t, pool, "count_me", "count_me@example.com", localAt(today, -20, 9, 0))
	fan := seedUserAt(t, pool, "count_fan", "count_fan@example.com", localAt(today, -20, 8, 0))
	for id := int32(1); id <= 3; id++ {
		seedAnime(t, pool, animeSeed{AnilistID: id})
	}
	updated := localAt(today, -1, 12, 0)
	seedSub(t, pool, user, 1, "completed", ptr(int32(8)), updated)
	seedSub(t, pool, user, 2, "watching", ptr(int32(6)), updated)
	seedSub(t, pool, user, 3, "plan_to_watch", nil, updated)
	for ep := int32(1); ep <= 4; ep++ {
		seedWatch(t, pool, user, 1, ep, updated)
	}
	seedFollow(t, pool, fan, user)
	archiveSeedDay(t, pool, user, dayOf(today, -2), localAt(today, -2, 9, 0), localAt(today, -2, 9, 5), 3, 2)

	got, _ := getUsersPage(t, h, "?q=count_me")
	require.Len(t, got.Data, 1)
	row := got.Data[0]
	assert.Equal(t, int64(3), row.Subscriptions)
	assert.Equal(t, int64(2), row.Ratings)
	assert.Equal(t, int64(4), row.WatchedEpisodes)
	assert.Equal(t, int64(1), row.Followers)
	assert.Equal(t, int64(1), row.ActiveDays)
	assert.Equal(t, int64(2), row.Logins)
	assert.True(t, row.Returned)
	assert.Equal(t, []string{dayOf(today, -2)}, row.RecentActiveDates)
	assert.Nil(t, row.LastDevice)
}
