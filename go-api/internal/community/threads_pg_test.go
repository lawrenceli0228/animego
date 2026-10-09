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

func (e *env) thread(u user, title, body string, spoiler bool) wireThreadView {
	e.t.Helper()
	return data[wireThreadView](e.t, e.call(u, http.MethodPost, base+"/threads",
		map[string]any{"title": title, "body": body, "isSpoiler": spoiler}), http.StatusCreated)
}

func (e *env) threadReply(u user, threadID uuid.UUID, body string, parent *uuid.UUID) wireReply {
	e.t.Helper()
	payload := map[string]any{"body": body}
	if parent != nil {
		payload["parentId"] = parent.String()
	}
	return data[wireReply](e.t, e.call(u, http.MethodPost, base+"/threads/"+threadID.String()+"/replies", payload), http.StatusCreated)
}

// notifications lists (recipient, type) for every notification about a reply.
func (e *env) replyNotifications() map[string][]string {
	e.t.Helper()
	rows, err := e.pool.Query(context.Background(), `
		SELECT recipient.username, n.notification_type
		FROM notifications n
		JOIN users recipient ON recipient.id = n.user_id
		WHERE n.reply_id IS NOT NULL
		ORDER BY recipient.username, n.created_at`)
	require.NoError(e.t, err)
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var name, kind string
		require.NoError(e.t, rows.Scan(&name, &kind))
		out[name] = append(out[name], kind)
	}
	require.NoError(e.t, rows.Err())
	return out
}

func TestCreateThread_Validation(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice := e.user("alice")
	for _, tc := range []struct {
		name string
		body any
		msg  string
	}{
		{"malformed", `{`, msgInvalidBody},
		{"title too short", map[string]any{"title": "三个字", "body": "x"}, msgTitleLength},
		{"title too long", map[string]any{"title": strings.Repeat("长", 81), "body": "x"}, msgTitleLength},
		{"title blank", map[string]any{"title": "      ", "body": "x"}, msgTitleLength},
		{"body blank", map[string]any{"title": "第五集讨论", "body": " \n\t "}, msgContentRequired},
		{"body too long", map[string]any{"title": "第五集讨论", "body": strings.Repeat("长", threadBodyMax+1)}, msgContentTooLong},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failure(t, e.call(alice, http.MethodPost, base+"/threads", tc.body), http.StatusBadRequest, "VALIDATION_ERROR", tc.msg)
		})
	}
	assert.Zero(t, e.count(`SELECT count(*) FROM anime_threads`))
}

func TestThreads_CreateListView(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	created := e.thread(alice, "  第五集\n的回忆杀 ", "大家怎么看\n辛美尔那段？", false)
	assert.Equal(t, "第五集 的回忆杀", created.Thread.Title)
	assert.Equal(t, "大家怎么看\n辛美尔那段？", created.Thread.Body)
	assert.True(t, created.Thread.IsOwn)
	assert.Empty(t, created.Replies)

	spoiler := e.thread(bob, "结局到底什么意思", "最后那一幕其实是……", true)
	// Not a spoiler thread, but with a spoiler inside: the list shows it closed.
	inline := e.thread(bob, "第十集的那段对白", "**名场面**：~!辛美尔的雕像!~ 那里，[原作](https://example.com/x) 也有", false)

	list := data[wirePage[wireThreadSummary]](t, e.call(anonymous, http.MethodGet, base+"/threads", nil), http.StatusOK)
	require.Len(t, list.Items, 3)
	assert.Equal(t, int64(3), list.Total)
	byID := map[uuid.UUID]wireThreadSummary{}
	for _, item := range list.Items {
		byID[item.ID] = item
	}
	assert.Equal(t, "大家怎么看 辛美尔那段？", byID[created.Thread.ID].Excerpt)
	assert.Empty(t, byID[spoiler.Thread.ID].Excerpt, "a spoiler thread's body stays off the list")
	assert.True(t, byID[spoiler.Thread.ID].IsSpoiler)
	assert.Equal(t, "名场面：▇▇ 那里，原作 也有", byID[inline.Thread.ID].Excerpt)
	summary := e.call(anonymous, http.MethodGet, base, nil).Body.String()
	assert.NotContains(t, summary, "最后那一幕")
	assert.NotContains(t, summary, "辛美尔的雕像")

	view := data[wireThreadView](t, e.call(anonymous, http.MethodGet, base+"/threads/"+spoiler.Thread.ID.String(), nil), http.StatusOK)
	assert.Equal(t, "最后那一幕其实是……", view.Thread.Body)

	failure(t, e.call(anonymous, http.MethodGet, base+"/threads/"+uuid.New().String(), nil), http.StatusNotFound, "NOT_FOUND", msgThreadNotFound)
	failure(t, e.call(anonymous, http.MethodGet, base+"/threads/nope", nil), http.StatusBadRequest, "BAD_REQUEST", msgInvalidParams)
	e.anime(21)
	failure(t, e.call(anonymous, http.MethodGet, "/api/anime/21/community/threads/"+created.Thread.ID.String(), nil),
		http.StatusNotFound, "NOT_FOUND", msgThreadNotFound)
}

func TestThreadReplies_NotifyTheThreadAuthorAndTheRepliedTo(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob, carol := e.user("alice"), e.user("bob"), e.user("carol")
	th := e.thread(alice, "第五集的回忆杀", "说说看", false)

	// bob replies to alice's thread: alice is told.
	fromBob := e.threadReply(bob, th.Thread.ID, "哭死我了", nil)
	assert.True(t, fromBob.IsOwn)
	assert.Equal(t, map[string][]string{"alice": {"thread_reply"}}, e.replyNotifications())

	// carol answers bob's reply: alice (the thread) and bob (the reply) both
	// hear of it, once each.
	fromCarol := e.threadReply(carol, th.Thread.ID, "同意楼上", &fromBob.ID)
	require.NotNil(t, fromCarol.ReplyToUsername)
	assert.Equal(t, "bob", *fromCarol.ReplyToUsername)
	assert.Equal(t, map[string][]string{"alice": {"thread_reply", "thread_reply"}, "bob": {"thread_reply"}}, e.replyNotifications())

	// alice answers in her own thread: bob hears (it answers him), alice
	// does not notify herself.
	e.threadReply(alice, th.Thread.ID, "谢谢大家", &fromBob.ID)
	assert.Equal(t, map[string][]string{"alice": {"thread_reply", "thread_reply"}, "bob": {"thread_reply", "thread_reply"}}, e.replyNotifications())

	// bob answers alice's own reply in alice's own thread: one notification,
	// not two.
	aliceReply := e.threadReply(alice, th.Thread.ID, "楼主补充", nil)
	before := e.count(`SELECT count(*) FROM notifications WHERE user_id = $1`, alice.ID)
	e.threadReply(bob, th.Thread.ID, "收到", &aliceReply.ID)
	assert.Equal(t, before+1, e.count(`SELECT count(*) FROM notifications WHERE user_id = $1`, alice.ID))

	view := data[wireThreadView](t, e.call(anonymous, http.MethodGet, base+"/threads/"+th.Thread.ID.String(), nil), http.StatusOK)
	bodies := make([]string, len(view.Replies))
	for i, r := range view.Replies {
		bodies[i] = r.Body
	}
	assert.Equal(t, []string{"哭死我了", "同意楼上", "谢谢大家", "楼主补充", "收到"}, bodies, "oldest first")
}

func TestThreadReply_Validation(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	th := e.thread(alice, "第五集的回忆杀", "说说看", false)
	other := e.thread(alice, "另一个讨论帖", "另一个", false)
	elsewhere := e.threadReply(bob, other.Thread.ID, "在别的帖子里", nil)
	path := base + "/threads/" + th.Thread.ID.String() + "/replies"

	failure(t, e.call(bob, http.MethodPost, path, map[string]any{"body": "  \u3000 "}), http.StatusBadRequest, "VALIDATION_ERROR", msgContentRequired)
	failure(t, e.call(bob, http.MethodPost, path, map[string]any{"body": strings.Repeat("字", replyBodyMax+1)}), http.StatusBadRequest, "VALIDATION_ERROR", msgContentTooLong)
	failure(t, e.call(bob, http.MethodPost, path, map[string]any{"body": "回复", "parentId": elsewhere.ID.String()}),
		http.StatusBadRequest, "VALIDATION_ERROR", msgParentNotFound)
	failure(t, e.call(bob, http.MethodPost, path, map[string]any{"body": "回复", "parentId": uuid.New().String()}),
		http.StatusBadRequest, "VALIDATION_ERROR", msgParentNotFound)
	failure(t, e.call(bob, http.MethodPost, base+"/threads/"+uuid.New().String()+"/replies", map[string]any{"body": "回复"}),
		http.StatusNotFound, "NOT_FOUND", msgThreadNotFound)
	assert.Equal(t, http.StatusCreated, e.call(bob, http.MethodPost, path, map[string]any{"body": strings.Repeat("字", replyBodyMax)}).Code)
}

func TestThreadReply_BlockedEitherWay(t *testing.T) {
	for _, aliceBlocks := range []bool{true, false} {
		e := newEnv(t, generous())
		e.anime(154587)
		alice, bob := e.user("alice"), e.user("bob")
		th := e.thread(alice, "第五集的回忆杀", "说说看", false)
		if aliceBlocks {
			e.block(alice, bob)
		} else {
			e.block(bob, alice)
		}
		failure(t, e.call(bob, http.MethodPost, base+"/threads/"+th.Thread.ID.String()+"/replies", map[string]any{"body": "回复"}),
			http.StatusForbidden, "FORBIDDEN", msgInteractionUnavailable)
		failure(t, e.call(bob, http.MethodGet, base+"/threads/"+th.Thread.ID.String(), nil),
			http.StatusNotFound, "NOT_FOUND", msgThreadNotFound)
		assert.Zero(t, e.count(`SELECT count(*) FROM community_replies`))
	}
}

func TestThreadReply_BumpsTheThreadUpTheList(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	older := e.thread(alice, "比较早的讨论帖", "早", false)
	newer := e.thread(alice, "比较新的讨论帖", "新", false)
	_, err := e.pool.Exec(context.Background(), `UPDATE anime_threads SET last_activity_at = $2 WHERE id = $1`,
		older.Thread.ID, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	list := data[wirePage[wireThreadSummary]](t, e.call(anonymous, http.MethodGet, base+"/threads", nil), http.StatusOK)
	assert.Equal(t, newer.Thread.ID, list.Items[0].ID)

	e.threadReply(bob, older.Thread.ID, "顶", nil)
	list = data[wirePage[wireThreadSummary]](t, e.call(anonymous, http.MethodGet, base+"/threads", nil), http.StatusOK)
	assert.Equal(t, older.Thread.ID, list.Items[0].ID)
	assert.Equal(t, int64(1), list.Items[0].ReplyCount)
}

func TestDeleteThread_SoftAuthorOnlyAndTakesItsNotifications(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	th := e.thread(alice, "第五集的回忆杀", "说说看", false)
	e.threadReply(bob, th.Thread.ID, "哭死我了", nil)
	require.Equal(t, 1, e.count(`SELECT count(*) FROM notifications WHERE user_id = $1`, alice.ID))
	path := base + "/threads/" + th.Thread.ID.String()

	failure(t, e.call(bob, http.MethodDelete, path, nil), http.StatusForbidden, "FORBIDDEN", msgNotYourThread)
	require.Equal(t, http.StatusOK, e.call(alice, http.MethodDelete, path, nil).Code)

	assert.Zero(t, e.count(`SELECT count(*) FROM notifications WHERE user_id = $1`, alice.ID),
		"an inbox must not link into a thread that answers 404")
	assert.Equal(t, 1, e.count(`SELECT count(*) FROM anime_threads WHERE deleted_at IS NOT NULL AND deleted_by = $1`, alice.ID))
	failure(t, e.call(anonymous, http.MethodGet, path, nil), http.StatusNotFound, "NOT_FOUND", msgThreadNotFound)
	failure(t, e.call(bob, http.MethodPost, path+"/replies", map[string]any{"body": "还在吗"}), http.StatusNotFound, "NOT_FOUND", msgThreadNotFound)
	assert.Empty(t, data[wirePage[wireThreadSummary]](t, e.call(anonymous, http.MethodGet, base+"/threads", nil), http.StatusOK).Items)
	failure(t, e.call(alice, http.MethodDelete, path, nil), http.StatusNotFound, "NOT_FOUND", msgThreadNotFound)
}

func TestDeleteReply_SoftAuthorOnlyAndTakesItsNotification(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	th := e.thread(alice, "第五集的回忆杀", "说说看", false)
	reply := e.threadReply(bob, th.Thread.ID, "哭死我了", nil)
	path := base + "/replies/" + reply.ID.String()

	failure(t, e.call(alice, http.MethodDelete, path, nil), http.StatusForbidden, "FORBIDDEN", msgNotYourReply)
	require.Equal(t, http.StatusOK, e.call(bob, http.MethodDelete, path, nil).Code)
	assert.Zero(t, e.count(`SELECT count(*) FROM notifications`), "the reply's notification goes with it")
	assert.Equal(t, 1, e.count(`SELECT count(*) FROM community_replies WHERE deleted_at IS NOT NULL AND deleted_by = $1`, bob.ID))

	view := data[wireThreadView](t, e.call(anonymous, http.MethodGet, base+"/threads/"+th.Thread.ID.String(), nil), http.StatusOK)
	assert.Empty(t, view.Replies)
	failure(t, e.call(bob, http.MethodDelete, path, nil), http.StatusNotFound, "NOT_FOUND", msgReplyNotFound)
	failure(t, e.call(bob, http.MethodDelete, base+"/replies/"+uuid.New().String(), nil), http.StatusNotFound, "NOT_FOUND", msgReplyNotFound)
}
