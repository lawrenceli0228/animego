package community

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestMigration0046_PG applies 0046 over a schema at 0045 that already holds
// every kind of row the widened tables had before (activity events of all
// three types, a notification, reports of both kinds), checks those rows
// survive and the new constraints hold, then runs it down — which must
// remove only what 0045 cannot represent — and up again.
func TestMigration0046_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	testutil.MigrateTo(t, uri, 45)
	pool := testutil.NewWebPool(t, ctx, uri)

	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	fails := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		assert.Error(t, err, sql)
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n), sql)
		return n
	}

	var alice, bob uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, email, password) VALUES ('alice', 'a@x.test', 'h') RETURNING id`).Scan(&alice))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, email, password) VALUES ('bob', 'b@x.test', 'h') RETURNING id`).Scan(&bob))
	exec(`INSERT INTO anime_cache (anilist_id, title_romaji) VALUES (154587, 'Frieren')`)
	var commentID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO episode_comments (anilist_id, episode, user_id, username, content) VALUES (154587, 1, $1, 'alice', 'hi')
		RETURNING id`, alice).Scan(&commentID))
	exec(`INSERT INTO activity_events (user_id, event_type, anilist_id, episode) VALUES ($1, 'watch_progress', 154587, 3)`, alice)
	exec(`INSERT INTO activity_events (user_id, event_type, anilist_id, episode, comment_id) VALUES ($1, 'comment', 154587, 1, $2)`, alice, commentID)
	exec(`INSERT INTO activity_events (user_id, event_type, target_user_id) VALUES ($1, 'follow', $2)`, alice, bob)
	exec(`INSERT INTO notifications (user_id, actor_id, notification_type, dedupe_key) VALUES ($1, $2, 'follow', 'follow:x')`, bob, alice)
	exec(`INSERT INTO reports (reporter_id, target_type, target_comment_id, reason) VALUES ($1, 'comment', $2, 'spam')`, bob, commentID)
	exec(`INSERT INTO reports (reporter_id, target_type, target_user_id, reason) VALUES ($1, 'user', $2, 'spam')`, bob, alice)

	testutil.MigrateTo(t, uri, 46)

	t.Run("rows that predate 0046 survive it", func(t *testing.T) {
		assert.Equal(t, 3, count(`SELECT count(*) FROM activity_events`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM notifications`))
		assert.Equal(t, 2, count(`SELECT count(*) FROM reports`))
	})

	t.Run("status events", func(t *testing.T) {
		exec(`INSERT INTO activity_events (user_id, event_type, anilist_id, status) VALUES ($1, 'status', 154587, 'completed')`, alice)
		fails(`INSERT INTO activity_events (user_id, event_type, anilist_id, status) VALUES ($1, 'status', 154587, 'finished')`, alice)
		fails(`INSERT INTO activity_events (user_id, event_type, anilist_id) VALUES ($1, 'status', 154587)`, alice)
		fails(`INSERT INTO activity_events (user_id, event_type, anilist_id, episode, status) VALUES ($1, 'status', 154587, 3, 'completed')`, alice)
		fails(`INSERT INTO activity_events (user_id, event_type, anilist_id, episode, status) VALUES ($1, 'watch_progress', 154587, 3, 'completed')`, alice)
	})

	var reviewID, threadID uuid.UUID
	t.Run("reviews", func(t *testing.T) {
		body := strings.Repeat("评", 300)
		require.NoError(t, pool.QueryRow(ctx, `
			INSERT INTO anime_reviews (anilist_id, user_id, summary, body) VALUES (154587, $1, '一句话总结一下这部番', $2)
			RETURNING id`, alice, body).Scan(&reviewID))
		fails(`INSERT INTO anime_reviews (anilist_id, user_id, summary, body) VALUES (154587, $1, '又一篇评价的一句话总结', $2)`, alice, body)
		fails(`INSERT INTO anime_reviews (anilist_id, user_id, summary, body) VALUES (154587, $1, '太短', $2)`, bob, body)
		fails(`INSERT INTO anime_reviews (anilist_id, user_id, summary, body) VALUES (154587, $1, '一句话总结一下这部番', 'short')`, bob)
		fails(`UPDATE anime_reviews SET deleted_by = $1 WHERE id = $2`, alice, reviewID)
		exec(`UPDATE anime_reviews SET deleted_at = now(), deleted_by = $1 WHERE id = $2`, alice, reviewID)
		exec(`INSERT INTO anime_reviews (anilist_id, user_id, summary, body) VALUES (154587, $1, '删掉以后再写一篇新的评价', $2)`, alice, body)
		exec(`INSERT INTO anime_review_votes (review_id, user_id) VALUES ($1, $2)`, reviewID, bob)
		fails(`INSERT INTO anime_review_votes (review_id, user_id) VALUES ($1, $2)`, reviewID, bob)
	})

	t.Run("threads and replies", func(t *testing.T) {
		require.NoError(t, pool.QueryRow(ctx, `
			INSERT INTO anime_threads (anilist_id, user_id, title, body) VALUES (154587, $1, '第五集讨论', 'x')
			RETURNING id`, alice).Scan(&threadID))
		fails(`INSERT INTO anime_threads (anilist_id, user_id, title, body) VALUES (154587, $1, '短', 'x')`, alice)
		var eventID uuid.UUID
		require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM activity_events WHERE event_type = 'status'`).Scan(&eventID))
		exec(`INSERT INTO community_replies (anilist_id, thread_id, user_id, body) VALUES (154587, $1, $2, 'r')`, threadID, bob)
		exec(`INSERT INTO community_replies (anilist_id, activity_event_id, user_id, body) VALUES (154587, $1, $2, 'r')`, eventID, bob)
		fails(`INSERT INTO community_replies (anilist_id, user_id, body) VALUES (154587, $1, 'no parent')`, bob)
		fails(`INSERT INTO community_replies (anilist_id, thread_id, activity_event_id, user_id, body) VALUES (154587, $1, $2, $3, 'two parents')`, threadID, eventID, bob)
		fails(`INSERT INTO community_replies (anilist_id, thread_id, user_id, body) VALUES (154587, $1, $2, '')`, threadID, bob)
		fails(`INSERT INTO community_replies (anilist_id, thread_id, user_id, body) VALUES (154587, $1, $2, $3)`, threadID, bob, strings.Repeat("x", 501))
		exec(`INSERT INTO activity_likes (activity_event_id, user_id) VALUES ($1, $2)`, eventID, bob)
	})

	t.Run("notifications and reports widen", func(t *testing.T) {
		var replyID uuid.UUID
		require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM community_replies WHERE thread_id IS NOT NULL`).Scan(&replyID))
		exec(`INSERT INTO notifications (user_id, actor_id, notification_type, reply_id, dedupe_key) VALUES ($1, $2, 'thread_reply', $3, 'thread_reply:1')`, alice, bob, replyID)
		fails(`INSERT INTO notifications (user_id, actor_id, notification_type, dedupe_key) VALUES ($1, $2, 'activity_reply', 'activity_reply:2')`, alice, bob)
		exec(`INSERT INTO reports (reporter_id, target_type, target_review_id, reason) VALUES ($1, 'review', $2, 'spam')`, bob, reviewID)
		exec(`INSERT INTO reports (reporter_id, target_type, target_thread_id, reason) VALUES ($1, 'thread', $2, 'spam')`, bob, threadID)
		fails(`INSERT INTO reports (reporter_id, target_type, target_thread_id, reason) VALUES ($1, 'review', $2, 'spam')`, bob, threadID)
		fails(`INSERT INTO reports (reporter_id, target_type, target_review_id, reason) VALUES ($1, 'review', $2, 'spam')`, bob, reviewID)
	})

	t.Run("down removes only what 0045 cannot hold; up again", func(t *testing.T) {
		testutil.MigrateTo(t, uri, 45)
		assert.Equal(t, 3, count(`SELECT count(*) FROM activity_events`), "the status event goes, the rest stay")
		assert.Equal(t, 1, count(`SELECT count(*) FROM notifications`))
		assert.Equal(t, 2, count(`SELECT count(*) FROM reports`))
		assert.Zero(t, count(`SELECT count(*) FROM information_schema.tables WHERE table_name IN
			('anime_reviews', 'anime_review_votes', 'anime_threads', 'community_replies', 'activity_likes')`))
		fails(`INSERT INTO activity_events (user_id, event_type, anilist_id) VALUES ($1, 'status', 154587)`, alice)

		testutil.MigrateTo(t, uri, 46)
		assert.Equal(t, 5, count(`SELECT count(*) FROM information_schema.tables WHERE table_name IN
			('anime_reviews', 'anime_review_votes', 'anime_threads', 'community_replies', 'activity_likes')`))
		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
	})
}
