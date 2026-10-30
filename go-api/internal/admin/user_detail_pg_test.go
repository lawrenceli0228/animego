package admin

// user_detail_pg_test.go — GET /api/admin/users/{userId} against the real
// schema, with every block of the drawer seeded on one synthetic account.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func getUserDetail(t *testing.T, h *Handlers, id string) (*httptest.ResponseRecorder, userDetailResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.GetUser(rec, requestWithUserID(t, http.MethodGet, "/api/admin/users/"+id, "", id))
	var got userDetailResponse
	if rec.Code == http.StatusOK {
		decodeDataInto(t, rec.Body.Bytes(), &got)
	}
	return rec, got
}

// seedTitledAnime writes an anime_cache row with the fields the drawer reads.
func seedTitledAnime(t *testing.T, pool *pgxpool.Pool, id int32, chinese, romaji string, episodes *int32) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO anime_cache (anilist_id, title_chinese, title_romaji, title_english, title_native, title_hant, episodes)
		VALUES ($1, $2, $3, $3 || ' (en)', $3 || ' (ja)', $2 || '（繁）', $4)`,
		id, chinese, romaji, episodes)
	require.NoError(t, err, "seedTitledAnime")
}

func execOK(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err, sql)
}

func TestGetUser_EveryBlock_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)
	now := time.Now()

	signup := localAt(today, -100, 9, 0)
	user := seedUserAt(t, pool, "detail_user", "detail_user@example.com", signup)
	other := seedUserAt(t, pool, "detail_other", "detail_other@example.com", signup)
	third := seedUserAt(t, pool, "detail_third", "detail_third@example.com", signup)
	execOK(t, pool, `UPDATE users SET is_public = false, avatar_url = '/avatars/synthetic.webp' WHERE id = $1`, user)

	// Activity: today-90 falls outside the 90-day calendar, today-89 inside.
	archiveSeedDay(t, pool, user, dayOf(today, -90), localAt(today, -90, 10, 0), localAt(today, -90, 11, 0), 0, 0)
	archiveSeedDay(t, pool, user, dayOf(today, -89), localAt(today, -89, 10, 0), localAt(today, -89, 11, 0), 5, 1)
	archiveSeedDay(t, pool, user, dayOf(today, -40), localAt(today, -40, 10, 0), localAt(today, -40, 11, 0), 0, 0)
	archiveSeedDay(t, pool, user, dayOf(today, -1), localAt(today, -1, 10, 0), localAt(today, -1, 12, 0), 7, 2)
	lastSeen := localAt(today, 0, 0, 40)
	archiveSeedDay(t, pool, user, dayOf(today, 0), localAt(today, 0, 0, 10), lastSeen, 3, 0)
	// Recording began before this account's first recorded day: the seam is
	// read across live and archived people, and a deleted account is where
	// the earliest recorded day lives here.  Its even older reconstructed day
	// (request_count 0) is not a recorded one and must not move the seam.
	var archiveID uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO archived_users (created_at) VALUES ($1) RETURNING archive_id`, localAt(today, -160, 9, 0)).Scan(&archiveID))
	execOK(t, pool, `
		INSERT INTO archived_user_activity_daily (archive_id, activity_date, first_seen_at, last_seen_at, request_count)
		VALUES ($1, $2::date, $3, $3, 0), ($1, $4::date, $5, $5, 2)`,
		archiveID, dayOf(today, -150), localAt(today, -150, 10, 0), dayOf(today, -120), localAt(today, -120, 10, 0))

	// Seven subscriptions, so the six most recent leave the oldest out.
	type sub struct {
		id      int32
		status  string
		score   *int32
		current int32
		offset  int
	}
	subs := []sub{
		{101, "watching", nil, 3, -30},
		{102, "completed", ptr(int32(9)), 12, -20},
		{103, "plan_to_watch", nil, 0, -15},
		{104, "dropped", ptr(int32(6)), 2, -10},
		{105, "watching", ptr(int32(8)), 5, -5},
		{106, "watching", nil, 1, -3},
		{107, "completed", nil, 24, -1},
	}
	for _, s := range subs {
		seedTitledAnime(t, pool, s.id, "番剧"+string(rune('A'+s.id-101)), "Show "+string(rune('A'+s.id-101)), ptr(int32(24)))
		execOK(t, pool, `
			INSERT INTO subscriptions (user_id, anilist_id, status, score, current_episode, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6)`,
			user, s.id, s.status, s.score, s.current, localAt(today, s.offset, 10, 0))
	}
	execOK(t, pool, `UPDATE anime_cache SET episodes = NULL WHERE anilist_id = 106`)

	// Seven episode marks.  102's two share an instant: the higher episode
	// comes first.
	type mark struct {
		anime, episode int32
		at             time.Time
	}
	marks := []mark{
		{101, 1, localAt(today, -30, 10, 0)},
		{102, 1, localAt(today, -20, 10, 0)},
		{102, 2, localAt(today, -20, 10, 0)},
		{105, 4, localAt(today, -5, 10, 0)},
		{105, 5, localAt(today, -4, 10, 0)},
		{106, 1, localAt(today, -3, 10, 0)},
		{107, 24, localAt(today, -1, 10, 0)},
	}
	for _, m := range marks {
		seedWatch(t, pool, user, m.anime, m.episode, m.at)
	}

	// Sessions: two live, one expired.  The one used most recently was opened
	// first, so "most recently used first" and "newest first" disagree.
	windows, iphone, mac := uaWindowsChrome, uaIPhoneSafari, uaMacFirefox
	jp := "JP"
	recent := sessionSeed{UserAgent: &iphone,
		CreatedAt: now.Add(-48 * time.Hour).Truncate(time.Microsecond),
		LastUsed:  now.Add(-5 * time.Minute).Truncate(time.Microsecond),
		Expires:   now.Add(30 * 24 * time.Hour).Truncate(time.Microsecond)}
	earlier := sessionSeed{UserAgent: &windows, Country: &jp,
		CreatedAt: now.Add(-24 * time.Hour).Truncate(time.Microsecond),
		LastUsed:  now.Add(-time.Hour).Truncate(time.Microsecond),
		Expires:   now.Add(29 * 24 * time.Hour).Truncate(time.Microsecond)}
	recentID := seedSession(t, pool, user, recent)
	earlierID := seedSession(t, pool, user, earlier)
	seedSession(t, pool, user, sessionSeed{UserAgent: &mac, LastUsed: now.Add(-30 * time.Second), Expires: now.Add(-time.Hour)})

	// Community: soft-deleted threads, replies and reviews do not count.
	execOK(t, pool, `INSERT INTO episode_comments (anilist_id, episode, user_id, username, content) VALUES
		(101, 1, $1, 'detail_user', 'first'), (102, 2, $1, 'detail_user', 'second'), (101, 1, $2, 'detail_other', 'not hers')`, user, other)
	var liveThread uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO anime_threads (anilist_id, user_id, title, body) VALUES (101, $1, 'A live thread', 'body')
		RETURNING id`, user).Scan(&liveThread))
	execOK(t, pool, `INSERT INTO anime_threads (anilist_id, user_id, title, body, deleted_at) VALUES (102, $1, 'A gone thread', 'body', now())`, user)
	execOK(t, pool, `INSERT INTO community_replies (anilist_id, thread_id, user_id, body, deleted_at) VALUES
		(101, $2, $1, 'one', NULL), (101, $2, $1, 'two', NULL), (101, $2, $1, 'gone', now()), (101, $2, $3, 'not hers', NULL)`,
		user, liveThread, other)
	body := strings.Repeat("A synthetic review body. ", 15)
	execOK(t, pool, `INSERT INTO anime_reviews (anilist_id, user_id, summary, body, deleted_at) VALUES
		(101, $1, 'A live review', $2, NULL), (102, $1, 'A gone review', $2, now())`, user, body)
	execOK(t, pool, `INSERT INTO danmakus (anilist_id, episode, user_id, username, content, live_ends_at) VALUES
		(101, 1, $1, 'detail_user', 'a', now()), (101, 1, $1, 'detail_user', 'b', now()), (102, 2, $1, 'detail_user', 'c', now())`, user)
	seedFollow(t, pool, user, other)
	seedFollow(t, pool, user, third)
	seedFollow(t, pool, other, user)
	execOK(t, pool, `INSERT INTO reports (reporter_id, target_type, target_user_id, reason) VALUES
		($1, 'user', $2, 'spam'), ($2, 'user', $1, 'spam')`, user, other)
	execOK(t, pool, `INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, item_count) VALUES
		($1, 'character', 1, '{}', 'https://example.com/a', 1), ($1, 'person', 2, '{}', 'https://example.com/b', 1)`, user)

	rec, got := getUserDetail(t, h, user.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	assert.Equal(t, today.Format(userDayLayout), got.Today)
	require.NotNil(t, got.InstrumentedSince)
	assert.Equal(t, dayOf(today, -120), *got.InstrumentedSince)

	avatar := "/avatars/synthetic.webp"
	assert.Equal(t, userDetailAccount{
		ID: user, Username: "detail_user", Email: "detail_user@example.com", Role: nil,
		CreatedAt: signup.UTC(), IsPublic: false, AvatarURL: &avatar,
	}, got.User)

	assert.Equal(t, int64(5), got.Activity.ActiveDays)
	assert.Equal(t, int64(3), got.Activity.RecordedDays)
	assert.Equal(t, int64(15), got.Activity.Requests)
	assert.Equal(t, int64(3), got.Activity.Logins)
	require.NotNil(t, got.Activity.LastSeenAt)
	assert.True(t, got.Activity.LastSeenAt.Equal(lastSeen))
	assert.Equal(t, []userActivityDay{
		{Date: dayOf(today, -89), Recorded: true},
		{Date: dayOf(today, -40), Recorded: false},
		{Date: dayOf(today, -1), Recorded: true},
		{Date: dayOf(today, 0), Recorded: true},
	}, got.Activity.Days90)

	assert.Equal(t, int64(7), got.Subscriptions.Total)
	assert.Equal(t, int64(3), got.Subscriptions.Watching)
	assert.Equal(t, int64(2), got.Subscriptions.Completed)
	assert.Equal(t, int64(1), got.Subscriptions.PlanToWatch)
	assert.Equal(t, int64(1), got.Subscriptions.Dropped)
	assert.Equal(t, int64(3), got.Subscriptions.Rated)
	require.NotNil(t, got.Subscriptions.AvgScore)
	assert.InDelta(t, 23.0/3, *got.Subscriptions.AvgScore, 1e-9)
	require.NotNil(t, got.Subscriptions.LastUpdatedAt)
	assert.True(t, got.Subscriptions.LastUpdatedAt.Equal(localAt(today, -1, 10, 0)))

	assert.Equal(t, int64(7), got.Watches.Total)
	require.NotNil(t, got.Watches.LastWatchedAt)
	assert.True(t, got.Watches.LastWatchedAt.Equal(localAt(today, -1, 10, 0)))

	type watchKey struct{ anime, episode int32 }
	var watchOrder []watchKey
	for _, w := range got.RecentWatches {
		watchOrder = append(watchOrder, watchKey{w.AnilistID, w.Episode})
	}
	assert.Equal(t, []watchKey{{107, 24}, {106, 1}, {105, 5}, {105, 4}, {102, 2}, {102, 1}}, watchOrder)
	first := got.RecentWatches[0]
	require.NotNil(t, first.TitleChinese)
	assert.Equal(t, "番剧G", *first.TitleChinese)
	require.NotNil(t, first.TitleHant)
	assert.Equal(t, "番剧G（繁）", *first.TitleHant)
	require.NotNil(t, first.TitleEnglish)
	assert.Equal(t, "Show G (en)", *first.TitleEnglish)
	require.NotNil(t, first.Episodes)
	assert.Equal(t, int32(24), *first.Episodes)
	assert.Nil(t, got.RecentWatches[1].Episodes, "unknown episode count stays null")
	assert.True(t, first.WatchedAt.Equal(localAt(today, -1, 10, 0)))

	var subOrder []int32
	for _, s := range got.RecentSubscriptions {
		subOrder = append(subOrder, s.AnilistID)
	}
	assert.Equal(t, []int32{107, 106, 105, 104, 103, 102}, subOrder)
	rated := got.RecentSubscriptions[2]
	assert.Equal(t, "watching", rated.Status)
	require.NotNil(t, rated.Score)
	assert.Equal(t, int32(8), *rated.Score)
	assert.Equal(t, int32(5), rated.CurrentEpisode)
	assert.Nil(t, got.RecentSubscriptions[0].Score)

	require.Len(t, got.Sessions, 2, "the expired session is not listed")
	assert.Equal(t, userSessionView{
		ID: recentID, Kind: "phone", OS: "iPhone", Browser: "Safari", Country: nil,
		CreatedAt: recent.CreatedAt.UTC(), LastUsedAt: recent.LastUsed.UTC(), ExpiresAt: recent.Expires.UTC(),
	}, normaliseSession(got.Sessions[0]))
	assert.Equal(t, userSessionView{
		ID: earlierID, Kind: "desktop", OS: "Windows", Browser: "Chrome", Country: &jp,
		CreatedAt: earlier.CreatedAt.UTC(), LastUsedAt: earlier.LastUsed.UTC(), ExpiresAt: earlier.Expires.UTC(),
	}, normaliseSession(got.Sessions[1]))

	assert.Equal(t, userDetailCommunity{
		Comments: 2, Replies: 2, Threads: 1, Reviews: 1, Danmaku: 3,
		Following: 2, Followers: 1, ReportsFiled: 1, EditSubmissions: 2,
	}, got.Community)
}

// normaliseSession puts the decoded instants in UTC, the form the seeds are
// compared in, so the struct comparison is about the instants alone.
func normaliseSession(s userSessionView) userSessionView {
	s.CreatedAt, s.LastUsedAt, s.ExpiresAt = s.CreatedAt.UTC(), s.LastUsedAt.UTC(), s.ExpiresAt.UTC()
	return s
}

func TestGetUser_EmptyAccount_PG(t *testing.T) {
	h, pool := makeHandlers(t)
	today := pinUsersClock(h)
	user := seedUserAt(t, pool, "detail_empty", "detail_empty@example.com", localAt(today, -3, 9, 0))

	rec, got := getUserDetail(t, h, user.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Nil(t, got.InstrumentedSince, "nothing was ever recorded per request")
	assert.Nil(t, got.Activity.LastSeenAt)
	assert.Nil(t, got.Subscriptions.AvgScore)
	assert.Nil(t, got.Subscriptions.LastUpdatedAt)
	assert.Nil(t, got.Watches.LastWatchedAt)
	assert.Equal(t, userDetailCommunity{}, got.Community)
	for _, frag := range []string{`"days90":[]`, `"recentWatches":[]`, `"recentSubscriptions":[]`, `"sessions":[]`, `"isPublic":true`} {
		assert.Contains(t, rec.Body.String(), frag)
	}

	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	assert.NotEmpty(t, envelope.Data, "the detail travels in the usual {data: …} envelope")
}

func TestGetUser_NotFound_PG(t *testing.T) {
	h, _ := makeHandlers(t)
	rec, _ := getUserDetail(t, h, uuid.NewString())
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
}

func TestGetUser_DBError_500_PG(t *testing.T) {
	h, _ := makeHandlers(t)
	h.Pool.Close()
	rec, _ := getUserDetail(t, h, uuid.NewString())
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}
