package community

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestActivity_ListsStatusEventsOfPublicUsersNewestFirst(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	e.anime(21)
	alice, bob, hidden := e.user("alice"), e.user("bob"), e.privateUser("hidden")
	now := time.Now()
	e.statusEvent(alice, 154587, "watching", now.Add(-3*time.Hour))
	finished := e.statusEvent(alice, 154587, "completed", now.Add(-time.Hour))
	e.statusEvent(bob, 154587, "plan_to_watch", now.Add(-2*time.Hour))
	e.statusEvent(hidden, 154587, "completed", now)
	e.statusEvent(bob, 21, "completed", now) // another anime
	// A watch_progress event is not the tab's kind.
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO activity_events (user_id, event_type, anilist_id, episode) VALUES ($1, 'watch_progress', 154587, 3)`, bob.ID)
	require.NoError(t, err)

	list := data[wirePage[wireActivity]](t, e.call(anonymous, http.MethodGet, base+"/activity", nil), http.StatusOK)
	got := make([]string, len(list.Items))
	for i, item := range list.Items {
		got[i] = item.Author.Username + ":" + item.Status
		assert.Equal(t, "status", item.Type)
	}
	assert.Equal(t, []string{"alice:completed", "bob:plan_to_watch", "alice:watching"}, got)
	assert.Equal(t, int64(3), list.Total)
	assert.Equal(t, finished, list.Items[0].ID)

	mine := data[wirePage[wireActivity]](t, e.call(hidden, http.MethodGet, base+"/activity", nil), http.StatusOK)
	assert.Equal(t, int64(4), mine.Total, "a private user still sees their own events")
	assert.True(t, mine.Items[0].IsOwn)
}

func TestActivityReplies_NotifyTheOwnerAndAreListedUnderTheEvent(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob, carol := e.user("alice"), e.user("bob"), e.user("carol")
	event := e.statusEvent(alice, 154587, "completed", time.Now())
	path := base + "/activity/" + event.String() + "/replies"

	reply := data[wireReply](t, e.call(bob, http.MethodPost, path, map[string]any{"body": "  我也看完了！ "}), http.StatusCreated)
	assert.Equal(t, "我也看完了！", reply.Body)
	assert.True(t, reply.IsOwn)
	assert.Equal(t, map[string][]string{"alice": {"activity_reply"}}, e.replyNotifications())
	assert.Equal(t, 1, e.count(`SELECT count(*) FROM notifications WHERE activity_event_id = $1 AND reply_id = $2`, event, reply.ID))

	// The owner replying under their own event notifies nobody.
	require.Equal(t, http.StatusCreated, e.call(alice, http.MethodPost, path, map[string]any{"body": "谢谢"}).Code)
	assert.Equal(t, map[string][]string{"alice": {"activity_reply"}}, e.replyNotifications())

	// A reply to bob's reply tells bob as well as alice.
	require.Equal(t, http.StatusCreated, e.call(carol, http.MethodPost, path,
		map[string]any{"body": "加一", "parentId": reply.ID.String()}).Code)
	assert.Equal(t, map[string][]string{"alice": {"activity_reply", "activity_reply"}, "bob": {"activity_reply"}}, e.replyNotifications())

	list := data[wirePage[wireActivity]](t, e.call(anonymous, http.MethodGet, base+"/activity", nil), http.StatusOK)
	require.Len(t, list.Items, 1)
	assert.Equal(t, int64(3), list.Items[0].ReplyCount)
	require.Len(t, list.Items[0].Replies, 3)
	assert.Equal(t, "我也看完了！", list.Items[0].Replies[0].Body)
	require.NotNil(t, list.Items[0].Replies[2].ReplyToUsername)
	assert.Equal(t, "bob", *list.Items[0].Replies[2].ReplyToUsername)

	one := data[wireActivity](t, e.call(anonymous, http.MethodGet, base+"/activity/"+event.String(), nil), http.StatusOK)
	assert.Len(t, one.Replies, 3)
	failure(t, e.call(anonymous, http.MethodGet, base+"/activity/"+uuid.New().String(), nil), http.StatusNotFound, "NOT_FOUND", msgActivityNotFound)
}

func TestActivityReply_Validation(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	e.anime(21)
	alice, bob, hidden := e.user("alice"), e.user("bob"), e.privateUser("hidden")
	event := e.statusEvent(alice, 154587, "completed", time.Now())
	path := base + "/activity/" + event.String() + "/replies"

	failure(t, e.call(bob, http.MethodPost, path, map[string]any{"body": ""}), http.StatusBadRequest, "VALIDATION_ERROR", msgContentRequired)
	failure(t, e.call(bob, http.MethodPost, path, map[string]any{"body": strings.Repeat("字", 501)}), http.StatusBadRequest, "VALIDATION_ERROR", msgContentTooLong)
	failure(t, e.call(bob, http.MethodPost, "/api/anime/21/community/activity/"+event.String()+"/replies", map[string]any{"body": "错番"}),
		http.StatusNotFound, "NOT_FOUND", msgActivityNotFound)

	var progress uuid.UUID
	require.NoError(t, e.pool.QueryRow(context.Background(),
		`INSERT INTO activity_events (user_id, event_type, anilist_id, episode) VALUES ($1, 'watch_progress', 154587, 3) RETURNING id`,
		alice.ID).Scan(&progress))
	failure(t, e.call(bob, http.MethodPost, base+"/activity/"+progress.String()+"/replies", map[string]any{"body": "进度"}),
		http.StatusNotFound, "NOT_FOUND", msgActivityNotFound)

	private := e.statusEvent(hidden, 154587, "completed", time.Now())
	failure(t, e.call(bob, http.MethodPost, base+"/activity/"+private.String()+"/replies", map[string]any{"body": "看不见"}),
		http.StatusNotFound, "NOT_FOUND", msgActivityNotFound)
	assert.Equal(t, http.StatusCreated, e.call(hidden, http.MethodPost, base+"/activity/"+private.String()+"/replies",
		map[string]any{"body": "自己的"}).Code, "the owner can still answer under their own event")
}

func TestActivityLikes(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob, carol := e.user("alice"), e.user("bob"), e.user("carol")
	event := e.statusEvent(alice, 154587, "completed", time.Now())
	like := base + "/activity/" + event.String() + "/like"

	assert.Equal(t, likeDTO{Liked: true, LikeCount: 1}, data[likeDTO](t, e.call(bob, http.MethodPut, like, nil), http.StatusOK))
	assert.Equal(t, likeDTO{Liked: true, LikeCount: 1}, data[likeDTO](t, e.call(bob, http.MethodPut, like, nil), http.StatusOK),
		"liking twice is one like")
	assert.Equal(t, likeDTO{Liked: true, LikeCount: 2}, data[likeDTO](t, e.call(carol, http.MethodPut, like, nil), http.StatusOK))
	assert.Equal(t, 2, e.count(`SELECT count(*) FROM activity_likes WHERE activity_event_id = $1`, event))

	list := data[wirePage[wireActivity]](t, e.call(bob, http.MethodGet, base+"/activity", nil), http.StatusOK)
	assert.True(t, list.Items[0].ViewerLiked)
	assert.Equal(t, int64(2), list.Items[0].LikeCount)

	assert.Equal(t, likeDTO{Liked: false, LikeCount: 1}, data[likeDTO](t, e.call(bob, http.MethodDelete, like, nil), http.StatusOK))
	assert.Equal(t, likeDTO{Liked: false, LikeCount: 1}, data[likeDTO](t, e.call(bob, http.MethodDelete, like, nil), http.StatusOK))
	assert.Zero(t, e.count(`SELECT count(*) FROM notifications`), "likes do not notify")

	failure(t, e.call(bob, http.MethodPut, base+"/activity/"+uuid.New().String()+"/like", nil), http.StatusNotFound, "NOT_FOUND", msgActivityNotFound)
	_, err := e.pool.Exec(context.Background(), `INSERT INTO activity_likes (activity_event_id, user_id) VALUES ($1, $2)`, event, carol.ID)
	assert.Error(t, err, "the primary key holds one like per user")
}

func TestActivity_BlockedEitherWay(t *testing.T) {
	for _, aliceBlocks := range []bool{true, false} {
		e := newEnv(t, generous())
		e.anime(154587)
		alice, bob := e.user("alice"), e.user("bob")
		event := e.statusEvent(alice, 154587, "completed", time.Now())
		if aliceBlocks {
			e.block(alice, bob)
		} else {
			e.block(bob, alice)
		}
		assert.Empty(t, data[wirePage[wireActivity]](t, e.call(bob, http.MethodGet, base+"/activity", nil), http.StatusOK).Items)
		failure(t, e.call(bob, http.MethodPut, base+"/activity/"+event.String()+"/like", nil), http.StatusForbidden, "FORBIDDEN", msgInteractionUnavailable)
		failure(t, e.call(bob, http.MethodPost, base+"/activity/"+event.String()+"/replies", map[string]any{"body": "x"}),
			http.StatusForbidden, "FORBIDDEN", msgInteractionUnavailable)
	}
}

func TestDeleteActivityReply(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	event := e.statusEvent(alice, 154587, "completed", time.Now())
	reply := data[wireReply](t, e.call(bob, http.MethodPost, base+"/activity/"+event.String()+"/replies",
		map[string]any{"body": "我也看完了"}), http.StatusCreated)
	require.Equal(t, 1, e.count(`SELECT count(*) FROM notifications`))

	failure(t, e.call(alice, http.MethodDelete, base+"/replies/"+reply.ID.String(), nil), http.StatusForbidden, "FORBIDDEN", msgNotYourReply)
	require.Equal(t, http.StatusOK, e.call(bob, http.MethodDelete, base+"/replies/"+reply.ID.String(), nil).Code)
	assert.Zero(t, e.count(`SELECT count(*) FROM notifications`))
	list := data[wirePage[wireActivity]](t, e.call(anonymous, http.MethodGet, base+"/activity", nil), http.StatusOK)
	assert.Zero(t, list.Items[0].ReplyCount)
	assert.Empty(t, list.Items[0].Replies)
}

func TestWatchers_EveryStatusPublicUsersAndCounts(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob, carol, hidden := e.user("alice"), e.user("bob"), e.user("carol"), e.privateUser("hidden")
	e.subscribe(alice, 154587, "completed")
	e.subscribe(bob, 154587, "watching")
	e.subscribe(carol, 154587, "dropped")
	e.subscribe(hidden, 154587, "completed")
	at := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	e.statusEvent(alice, 154587, "completed", at)

	type wireWatchers struct {
		Items []struct {
			Username string `json:"username"`
			Status   string `json:"status"`
			Since    string `json:"since"`
		} `json:"items"`
		Total  int64            `json:"total"`
		Counts watcherCountsDTO `json:"counts"`
	}
	got := data[wireWatchers](t, e.call(anonymous, http.MethodGet, base+"/watchers", nil), http.StatusOK)
	assert.Equal(t, int64(3), got.Total)
	assert.Equal(t, watcherCountsDTO{Watching: 1, Completed: 1, Dropped: 1}, got.Counts)
	names := map[string]string{}
	for _, item := range got.Items {
		names[item.Username] = item.Status
		if item.Username == "alice" {
			since, err := time.Parse(time.RFC3339Nano, item.Since)
			require.NoError(t, err)
			assert.True(t, since.Equal(at), "since is when the status was set, read from its event")
		}
	}
	assert.Equal(t, map[string]string{"alice": "completed", "bob": "watching", "carol": "dropped"}, names)
	assert.NotContains(t, names, "hidden", "a private profile stays off the list")

	self := data[wireWatchers](t, e.call(hidden, http.MethodGet, base+"/watchers", nil), http.StatusOK)
	assert.Equal(t, int64(4), self.Total, "except to themselves")
}

func TestSummary_AnonymousAndSignedIn(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	e.subscribe(alice, 154587, "completed")
	e.statusEvent(alice, 154587, "completed", time.Now())
	review := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, true)), http.StatusCreated)
	e.thread(bob, "第五集的回忆杀", "说说看", false)

	type wireSummary struct {
		Reviews  wirePage[wireReview]        `json:"reviews"`
		Threads  wirePage[wireThreadSummary] `json:"threads"`
		Activity wirePage[wireActivity]      `json:"activity"`
		Watchers struct {
			Total int64 `json:"total"`
		} `json:"watchers"`
		Viewer *struct {
			Status   *string    `json:"status"`
			ReviewID *uuid.UUID `json:"reviewId"`
		} `json:"viewer"`
	}
	anon := data[wireSummary](t, e.call(anonymous, http.MethodGet, base, nil), http.StatusOK)
	assert.Nil(t, anon.Viewer)
	assert.Empty(t, anon.Reviews.Items, "the private review is not in the anonymous render")
	assert.Len(t, anon.Threads.Items, 1)
	assert.Len(t, anon.Activity.Items, 1)
	assert.Equal(t, int64(1), anon.Watchers.Total)

	signedIn := data[wireSummary](t, e.call(alice, http.MethodGet, base, nil), http.StatusOK)
	require.NotNil(t, signedIn.Viewer)
	require.NotNil(t, signedIn.Viewer.Status)
	assert.Equal(t, "completed", *signedIn.Viewer.Status)
	require.NotNil(t, signedIn.Viewer.ReviewID)
	assert.Equal(t, review.ID, *signedIn.Viewer.ReviewID)
	assert.Len(t, signedIn.Reviews.Items, 1)

	bobs := data[wireSummary](t, e.call(bob, http.MethodGet, base, nil), http.StatusOK)
	require.NotNil(t, bobs.Viewer)
	assert.Nil(t, bobs.Viewer.Status, "not on bob's list")
	assert.Nil(t, bobs.Viewer.ReviewID)
}

// The tab bar's number is what an anonymous reader is shown, whoever asks:
// a private review, a removed thread and a private profile's status are not
// in it, and neither the author of the private review nor someone with a
// block sees a different number.
func TestCount_IsTheAnonymousTotalForEveryReader(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob, quiet := e.user("alice"), e.user("bob"), e.privateUser("quiet")

	data[wireReview](t, e.call(bob, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
	data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("二", 10), 300, false, true)), http.StatusCreated)
	e.thread(bob, "第五集的回忆杀", "说说看", false)
	removed := e.thread(alice, "删掉的帖子", "说说看", false)
	require.Equal(t, http.StatusOK,
		e.call(alice, http.MethodDelete, base+"/threads/"+removed.Thread.ID.String(), nil).Code)
	e.statusEvent(alice, 154587, "watching", time.Now())
	e.statusEvent(quiet, 154587, "watching", time.Now())
	e.block(alice, bob)

	type wireCount struct {
		Total int64 `json:"total"`
	}
	for _, reader := range []user{anonymous, alice, bob, quiet} {
		rec := e.call(reader, http.MethodGet, base+"/count", nil)
		assert.Equal(t, int64(3), data[wireCount](t, rec, http.StatusOK).Total, "reader %q", reader.Name)
	}

	type wireTotals struct {
		Reviews  struct{ Total int64 } `json:"reviews"`
		Threads  struct{ Total int64 } `json:"threads"`
		Activity struct{ Total int64 } `json:"activity"`
	}
	anon := data[wireTotals](t, e.call(anonymous, http.MethodGet, base, nil), http.StatusOK)
	assert.Equal(t, int64(3), anon.Reviews.Total+anon.Threads.Total+anon.Activity.Total,
		"the bar and the anonymous render of the tab agree")
}

func TestRateLimits_PerUserPerAction(t *testing.T) {
	limits := generous()
	limits.Reviews = Limit{Max: 1, Window: time.Hour}
	limits.Threads = Limit{Max: 1, Window: time.Hour}
	limits.Replies = Limit{Max: 2, Window: time.Hour}
	limits.Reactions = Limit{Max: 2, Window: time.Hour}
	e := newEnv(t, limits)
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")

	r := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
	failure(t, e.call(alice, http.MethodPatch, base+"/reviews/"+r.ID.String(),
		reviewBody(strings.Repeat("二", 10), 300, false, false)), http.StatusTooManyRequests, "TOO_MANY_REQUESTS", msgTooManyRequests)

	th := e.thread(alice, "第五集的回忆杀", "说说看", false)
	failure(t, e.call(alice, http.MethodPost, base+"/threads", map[string]any{"title": "第二个讨论帖", "body": "x"}),
		http.StatusTooManyRequests, "TOO_MANY_REQUESTS", msgTooManyRequests)
	assert.Equal(t, http.StatusCreated, e.call(bob, http.MethodPost, base+"/threads",
		map[string]any{"title": "别人的讨论帖", "body": "x"}).Code, "the budget is per user")

	event := e.statusEvent(alice, 154587, "completed", time.Now())
	e.threadReply(bob, th.Thread.ID, "一", nil)
	require.Equal(t, http.StatusCreated, e.call(bob, http.MethodPost, base+"/activity/"+event.String()+"/replies", map[string]any{"body": "二"}).Code)
	failure(t, e.call(bob, http.MethodPost, base+"/threads/"+th.Thread.ID.String()+"/replies", map[string]any{"body": "三"}),
		http.StatusTooManyRequests, "TOO_MANY_REQUESTS", msgTooManyRequests)
	assert.Equal(t, 2, e.count(`SELECT count(*) FROM community_replies`), "thread and activity replies share one budget")

	require.Equal(t, http.StatusOK, e.call(bob, http.MethodPut, base+"/reviews/"+r.ID.String()+"/helpful", nil).Code)
	require.Equal(t, http.StatusOK, e.call(bob, http.MethodPut, base+"/activity/"+event.String()+"/like", nil).Code)
	failure(t, e.call(bob, http.MethodDelete, base+"/activity/"+event.String()+"/like", nil),
		http.StatusTooManyRequests, "TOO_MANY_REQUESTS", msgTooManyRequests)

	// Invalid input does not spend the budget: it is rejected before the count.
	failure(t, e.call(alice, http.MethodPost, base+"/reviews", reviewBody("短", 300, false, false)),
		http.StatusBadRequest, "VALIDATION_ERROR", msgSummaryLength)
}

func TestAdminRemoval(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob, admin := e.user("alice"), e.user("bob"), e.admin("moderator")
	review := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
	th := e.thread(alice, "第五集的回忆杀", "说说看", false)
	reply := e.threadReply(bob, th.Thread.ID, "哭死我了", nil)

	for _, path := range []string{
		"/api/admin/community/reviews/" + review.ID.String(),
		"/api/admin/community/threads/" + th.Thread.ID.String(),
		"/api/admin/community/replies/" + reply.ID.String(),
	} {
		assert.Equal(t, http.StatusForbidden, e.call(bob, http.MethodDelete, path, nil).Code, "not for a regular user")
		assert.Equal(t, http.StatusUnauthorized, e.call(anonymous, http.MethodDelete, path, nil).Code)
		require.Equal(t, http.StatusOK, e.call(admin, http.MethodDelete, path, nil).Code, path)
		assert.Equal(t, http.StatusNotFound, e.call(admin, http.MethodDelete, path, nil).Code, "already gone")
	}
	assert.Equal(t, 1, e.count(`SELECT count(*) FROM anime_reviews WHERE deleted_by = $1`, admin.ID))
	assert.Equal(t, 1, e.count(`SELECT count(*) FROM anime_threads WHERE deleted_by = $1`, admin.ID))
	assert.Equal(t, 1, e.count(`SELECT count(*) FROM community_replies WHERE deleted_by = $1`, admin.ID))
	assert.Zero(t, e.count(`SELECT count(*) FROM notifications`))
	assert.Equal(t, http.StatusBadRequest, e.call(admin, http.MethodDelete, "/api/admin/community/reviews/nope", nil).Code)
}
