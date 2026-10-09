package community

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUnknownAnimeIs404AndBadIDIs400_EverywhereOnTheTab(t *testing.T) {
	e := newEnv(t, generous())
	alice := e.user("alice")
	someID := uuid.New().String()
	for _, path := range []string{
		"", "/reviews", "/reviews/" + someID, "/threads", "/threads/" + someID,
		"/activity", "/activity/" + someID, "/watchers",
	} {
		t.Run("GET"+path, func(t *testing.T) {
			failure(t, e.call(anonymous, http.MethodGet, "/api/anime/999999/community"+path, nil),
				http.StatusNotFound, "NOT_FOUND", msgAnimeNotFound)
			failure(t, e.call(anonymous, http.MethodGet, "/api/anime/abc/community"+path, nil),
				http.StatusBadRequest, "BAD_REQUEST", msgInvalidParams)
			failure(t, e.call(anonymous, http.MethodGet, "/api/anime/0/community"+path, nil),
				http.StatusBadRequest, "BAD_REQUEST", msgInvalidParams)
		})
	}
	// Writes too: the anime check comes before anything is written.
	failure(t, e.call(alice, http.MethodPost, "/api/anime/999999/community/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusNotFound, "NOT_FOUND", msgAnimeNotFound)
	failure(t, e.call(alice, http.MethodPost, "/api/anime/999999/community/threads",
		map[string]any{"title": "第五集讨论", "body": "x"}), http.StatusNotFound, "NOT_FOUND", msgAnimeNotFound)
	assert.Zero(t, e.count(`SELECT count(*) FROM anime_reviews`))
}

func TestMountDoesNotShadowTheDetailRoute(t *testing.T) {
	e := newEnv(t, generous())
	assert.Equal(t, http.StatusTeapot, e.call(anonymous, http.MethodGet, "/api/anime/154587", nil).Code)
}

// A read made with a session can carry that reader's own private review,
// votes and likes, so no shared cache may keep it; an anonymous read is the
// same for everyone and stays cacheable.
func TestReadsWithASessionAreNeverSharedCacheable(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice := e.user("alice")
	for _, path := range []string{base, base + "/reviews", base + "/threads", base + "/activity", base + "/watchers"} {
		signedIn := e.call(alice, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, signedIn.Code, path)
		assert.Equal(t, "private, no-store", signedIn.Header().Get("Cache-Control"), path)

		anon := e.call(anonymous, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, anon.Code, path)
		assert.NotContains(t, anon.Header().Get("Cache-Control"), "private", path)
	}
	mine := e.call(alice, http.MethodGet, base+"/reviews/mine", nil)
	assert.Equal(t, "private, no-store", mine.Header().Get("Cache-Control"), "even a 404 for her own review")
}

// Only JSON bodies are read.  A form on another site can POST text/plain
// with the visitor's cookies and no preflight, and text/plain can be made to
// parse as JSON ({"title":"…","body":"…","p":"=" from one form field); it
// cannot send application/json without the browser asking first, and CORS
// answers that question no.
func TestWritesReadOnlyJSONBodies(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	th := e.thread(bob, "第五集的回忆杀", "说说看", false)
	event := e.statusEvent(bob, 154587, "completed", time.Now())
	review := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews", map[string]any{
		"summary": "一部关于时间与告别的作品", "body": strings.Repeat("好", reviewBodyMin),
	}), http.StatusCreated)

	formBody := `{"summary":"一部关于时间与告别的作品","title":"表单冒名的帖子","body":"` + strings.Repeat("好", reviewBodyMin) + `","p":"="}`
	for _, tc := range []struct{ method, path, contentType string }{
		{http.MethodPost, base + "/reviews", "text/plain"},
		{http.MethodPatch, base + "/reviews/" + review.ID.String(), "text/plain;charset=UTF-8"},
		{http.MethodPost, base + "/threads", "application/x-www-form-urlencoded"},
		{http.MethodPost, base + "/threads/" + th.Thread.ID.String() + "/replies", "multipart/form-data; boundary=x"},
		{http.MethodPost, base + "/activity/" + event.String() + "/replies", ""},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(formBody))
		if tc.contentType != "" {
			req.Header.Set("Content-Type", tc.contentType)
		}
		req.Header.Set("Authorization", "Bearer "+alice.token)
		rec := httptest.NewRecorder()
		e.router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusUnsupportedMediaType, rec.Code, "%s %s (%q): %s", tc.method, tc.path, tc.contentType, rec.Body.String())
	}
	assert.Zero(t, e.count(`SELECT count(*) FROM anime_threads WHERE title = '表单冒名的帖子'`), "no thread was written")
	assert.Zero(t, e.count(`SELECT count(*) FROM community_replies`), "nor a reply")

	ok := e.call(alice, http.MethodPost, base+"/threads", map[string]any{"title": "正常的帖子", "body": "说说看"})
	assert.Equal(t, http.StatusCreated, ok.Code, "application/json is read")
	req := httptest.NewRequest(http.MethodPost, base+"/threads", strings.NewReader(`{"title":"带字符集的帖子","body":"说说看"}`))
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Authorization", "Bearer "+alice.token)
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusCreated, rec.Code, "with a charset too: %s", rec.Body.String())
}

func TestWritesRequireASession(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	id := uuid.New().String()
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, base + "/reviews"},
		{http.MethodGet, base + "/reviews/mine"},
		{http.MethodPatch, base + "/reviews/" + id},
		{http.MethodDelete, base + "/reviews/" + id},
		{http.MethodPut, base + "/reviews/" + id + "/helpful"},
		{http.MethodDelete, base + "/reviews/" + id + "/helpful"},
		{http.MethodPost, base + "/threads"},
		{http.MethodDelete, base + "/threads/" + id},
		{http.MethodPost, base + "/threads/" + id + "/replies"},
		{http.MethodPost, base + "/activity/" + id + "/replies"},
		{http.MethodPut, base + "/activity/" + id + "/like"},
		{http.MethodDelete, base + "/activity/" + id + "/like"},
		{http.MethodDelete, base + "/replies/" + id},
	} {
		rec := e.call(anonymous, tc.method, tc.path, map[string]any{})
		assert.Equal(t, http.StatusUnauthorized, rec.Code, "%s %s: %s", tc.method, tc.path, rec.Body.String())
	}
}

func TestCreateReview_ValidatesBeforeWriting(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice := e.user("alice")
	ok := strings.Repeat("一", 10)
	cases := []struct {
		name string
		body any
		msg  string
	}{
		{"malformed json", `{"summary":`, msgInvalidBody},
		{"summary too short", reviewBody(strings.Repeat("一", 9), 300, false, false), msgSummaryLength},
		{"summary too long", reviewBody(strings.Repeat("一", 61), 300, false, false), msgSummaryLength},
		{"summary whitespace", reviewBody(strings.Repeat(" ", 20), 300, false, false), msgSummaryLength},
		{"body too short", reviewBody(ok, 299, false, false), msgReviewTooShort},
		{"body too long", reviewBody(ok, reviewBodyMax+1, false, false), msgReviewTooLong},
		{"body padded with spaces", map[string]any{"summary": ok, "body": "好" + strings.Repeat(" ", 400) + "好"}, msgReviewTooShort},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			failure(t, e.call(alice, http.MethodPost, base+"/reviews", tc.body), http.StatusBadRequest, "VALIDATION_ERROR", tc.msg)
		})
	}
	assert.Zero(t, e.count(`SELECT count(*) FROM anime_reviews`), "nothing invalid reached the table")
}

func TestCreateReview_StoresNormalizedTextAndAnswersWithTheReview(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice := e.user("alice")
	got := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews", map[string]any{
		"summary": "  一部关于时间\n与告别的作品  ",
		"body":    "\r\n" + longText(300) + "\r\n" + longText(10) + "  ",
	}), http.StatusCreated)
	assert.Equal(t, "一部关于时间 与告别的作品", got.Summary)
	assert.Equal(t, longText(300)+"\n"+longText(10), got.Body)
	assert.True(t, got.IsOwn)
	assert.Equal(t, "alice", got.Author.Username)
	assert.False(t, got.IsPrivate)
	assert.Zero(t, got.HelpfulCount)
}

func TestCreateReview_NoScoreAnywhere(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice := e.user("alice")
	body := reviewBody(strings.Repeat("一", 10), 300, false, false)
	body["score"] = 9
	rec := e.call(alice, http.MethodPost, base+"/reviews", body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.NotContains(t, strings.ToLower(rec.Body.String()), "score", "a score sent in is ignored and none comes back")
	assert.NotContains(t, strings.ToLower(e.call(anonymous, http.MethodGet, base, nil).Body.String()), "score")
}

func TestOneLiveReviewPerUser_DeleteFreesTheSlot(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	e.anime(21)
	alice := e.user("alice")
	first := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
	failure(t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("二", 10), 300, false, false)), http.StatusConflict, "CONFLICT", msgAlreadyReviewed)

	// Another anime is another slot.
	assert.Equal(t, http.StatusCreated, e.call(alice, http.MethodPost, "/api/anime/21/community/reviews",
		reviewBody(strings.Repeat("三", 10), 300, false, false)).Code)

	require.Equal(t, http.StatusOK, e.call(alice, http.MethodDelete, base+"/reviews/"+first.ID.String(), nil).Code)
	assert.Equal(t, http.StatusCreated, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("二", 10), 300, false, false)).Code)
}

func TestPrivateReview_VisibleOnlyToItsAuthor(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	priv := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody("只给自己看的私密评价", 300, false, true)), http.StatusCreated)
	assert.True(t, priv.IsPrivate)

	for name, viewer := range map[string]user{"anonymous": anonymous, "another user": bob} {
		t.Run(name, func(t *testing.T) {
			list := data[wirePage[wireReview]](t, e.call(viewer, http.MethodGet, base+"/reviews", nil), http.StatusOK)
			assert.Empty(t, list.Items)
			assert.Zero(t, list.Total, "the total does not count what the reader cannot see")
			failure(t, e.call(viewer, http.MethodGet, base+"/reviews/"+priv.ID.String(), nil),
				http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
			summary := e.call(viewer, http.MethodGet, base, nil)
			require.Equal(t, http.StatusOK, summary.Code)
			assert.NotContains(t, summary.Body.String(), "只给自己看的私密评价")
		})
	}
	t.Run("the author", func(t *testing.T) {
		list := data[wirePage[wireReview]](t, e.call(alice, http.MethodGet, base+"/reviews", nil), http.StatusOK)
		require.Len(t, list.Items, 1)
		assert.Equal(t, int64(1), list.Total)
		assert.True(t, list.Items[0].IsOwn)
		assert.True(t, list.Items[0].IsPrivate)
		assert.Equal(t, http.StatusOK, e.call(alice, http.MethodGet, base+"/reviews/"+priv.ID.String(), nil).Code)
	})
	t.Run("nobody else can vote on it, edit it or delete it", func(t *testing.T) {
		for _, method := range []string{http.MethodPut, http.MethodDelete} {
			failure(t, e.call(bob, method, base+"/reviews/"+priv.ID.String()+"/helpful", nil),
				http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
		}
		failure(t, e.call(bob, http.MethodPatch, base+"/reviews/"+priv.ID.String(),
			reviewBody("想改别人的私密评价", 300, false, false)), http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
		failure(t, e.call(bob, http.MethodDelete, base+"/reviews/"+priv.ID.String(), nil),
			http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
	})
}

func TestSpoilerReview_ListWithholdsTheBodySingleReadReturnsIt(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice := e.user("alice")
	created := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		map[string]any{"summary": "结局让人意外的一部番", "body": "结局" + longText(300), "isSpoiler": true}), http.StatusCreated)
	assert.NotEmpty(t, created.Body, "the author's own write answers with what they wrote")

	list := data[wirePage[wireReview]](t, e.call(anonymous, http.MethodGet, base+"/reviews", nil), http.StatusOK)
	require.Len(t, list.Items, 1)
	assert.True(t, list.Items[0].IsSpoiler)
	assert.True(t, list.Items[0].BodyHidden)
	assert.Empty(t, list.Items[0].Body)
	assert.NotContains(t, e.call(anonymous, http.MethodGet, base, nil).Body.String(), "结局"+longText(10),
		"the server-rendered summary carries no spoiler text")

	one := data[wireReview](t, e.call(anonymous, http.MethodGet, base+"/reviews/"+created.ID.String(), nil), http.StatusOK)
	assert.Equal(t, "结局"+longText(300), one.Body)
	assert.False(t, one.BodyHidden)
}

func TestUpdateReview_AuthorOnly(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	e.anime(21)
	alice, bob := e.user("alice"), e.user("bob")
	r := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
	path := base + "/reviews/" + r.ID.String()

	failure(t, e.call(bob, http.MethodPatch, path, reviewBody("别人来改这篇评价", 300, false, false)),
		http.StatusForbidden, "FORBIDDEN", msgNotYourReview)
	failure(t, e.call(alice, http.MethodPatch, "/api/anime/21/community/reviews/"+r.ID.String(),
		reviewBody("换个番剧路径来改", 300, false, false)), http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
	failure(t, e.call(alice, http.MethodPatch, path, reviewBody("短", 300, false, false)),
		http.StatusBadRequest, "VALIDATION_ERROR", msgSummaryLength)

	updated := data[wireReview](t, e.call(alice, http.MethodPatch, path,
		map[string]any{"summary": "改过之后的一句话总结", "body": longText(400), "isSpoiler": true, "isPrivate": true}), http.StatusOK)
	assert.Equal(t, "改过之后的一句话总结", updated.Summary)
	assert.Equal(t, longText(400), updated.Body)
	assert.True(t, updated.IsSpoiler)
	assert.True(t, updated.IsPrivate)

	require.Equal(t, http.StatusOK, e.call(alice, http.MethodDelete, path, nil).Code)
	failure(t, e.call(alice, http.MethodPatch, path, reviewBody("删掉以后再来改它", 300, false, false)),
		http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
	failure(t, e.call(alice, http.MethodPatch, base+"/reviews/not-a-uuid", reviewBody("错误的评价编号", 300, false, false)),
		http.StatusBadRequest, "BAD_REQUEST", msgInvalidParams)
}

func TestDeleteReview_IsSoftAndAuthorOnly(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	r := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
	path := base + "/reviews/" + r.ID.String()

	failure(t, e.call(bob, http.MethodDelete, path, nil), http.StatusForbidden, "FORBIDDEN", msgNotYourReview)
	require.Equal(t, http.StatusOK, e.call(alice, http.MethodDelete, path, nil).Code)
	failure(t, e.call(alice, http.MethodDelete, path, nil), http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)

	assert.Equal(t, 1, e.count(`SELECT count(*) FROM anime_reviews WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_by = $2`, r.ID, alice.ID),
		"the row stays, marked deleted by its author")
	assert.Empty(t, data[wirePage[wireReview]](t, e.call(alice, http.MethodGet, base+"/reviews", nil), http.StatusOK).Items)
	failure(t, e.call(anonymous, http.MethodGet, path, nil), http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
}

func TestMyReview(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice := e.user("alice")
	failure(t, e.call(alice, http.MethodGet, base+"/reviews/mine", nil), http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
	r := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		map[string]any{"summary": "私密而且含剧透的评价", "body": longText(300), "isSpoiler": true, "isPrivate": true}), http.StatusCreated)
	mine := data[wireReview](t, e.call(alice, http.MethodGet, base+"/reviews/mine", nil), http.StatusOK)
	assert.Equal(t, r.ID, mine.ID)
	assert.Equal(t, longText(300), mine.Body, "the editor gets the whole text back, spoiler or not")
}

func TestHelpfulVotes(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob, carol := e.user("alice"), e.user("bob"), e.user("carol")
	r := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
	vote := base + "/reviews/" + r.ID.String() + "/helpful"

	got := data[voteDTO](t, e.call(bob, http.MethodPut, vote, nil), http.StatusOK)
	assert.Equal(t, voteDTO{Voted: true, HelpfulCount: 1}, got)
	got = data[voteDTO](t, e.call(bob, http.MethodPut, vote, nil), http.StatusOK)
	assert.Equal(t, voteDTO{Voted: true, HelpfulCount: 1}, got, "a second vote by the same user does not count")
	assert.Equal(t, 1, e.count(`SELECT count(*) FROM anime_review_votes WHERE review_id = $1`, r.ID))

	got = data[voteDTO](t, e.call(carol, http.MethodPut, vote, nil), http.StatusOK)
	assert.Equal(t, int64(2), got.HelpfulCount)

	list := data[wirePage[wireReview]](t, e.call(bob, http.MethodGet, base+"/reviews", nil), http.StatusOK)
	assert.True(t, list.Items[0].ViewerVoted)
	assert.Equal(t, int64(2), list.Items[0].HelpfulCount)
	anon := data[wirePage[wireReview]](t, e.call(anonymous, http.MethodGet, base+"/reviews", nil), http.StatusOK)
	assert.False(t, anon.Items[0].ViewerVoted)

	got = data[voteDTO](t, e.call(bob, http.MethodDelete, vote, nil), http.StatusOK)
	assert.Equal(t, voteDTO{Voted: false, HelpfulCount: 1}, got)
	got = data[voteDTO](t, e.call(bob, http.MethodDelete, vote, nil), http.StatusOK)
	assert.Equal(t, voteDTO{Voted: false, HelpfulCount: 1}, got, "taking back a vote that is not there is not an error")

	failure(t, e.call(alice, http.MethodPut, vote, nil), http.StatusBadRequest, "INVALID_ACTION", msgOwnReview)
	failure(t, e.call(bob, http.MethodPut, base+"/reviews/"+uuid.New().String()+"/helpful", nil),
		http.StatusNotFound, "NOT_FOUND", msgReviewNotFound)
}

func TestHelpfulVote_TheDatabaseHoldsOneVotePerUser(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	alice, bob := e.user("alice"), e.user("bob")
	r := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
		reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
	_, err := e.pool.Exec(context.Background(), `INSERT INTO anime_review_votes (review_id, user_id) VALUES ($1, $2)`, r.ID, bob.ID)
	require.NoError(t, err)
	_, err = e.pool.Exec(context.Background(), `INSERT INTO anime_review_votes (review_id, user_id) VALUES ($1, $2)`, r.ID, bob.ID)
	require.Error(t, err, "the primary key refuses a second vote")
}

func TestHelpfulVote_BlockedEitherWay(t *testing.T) {
	for _, aliceBlocks := range []bool{true, false} {
		e := newEnv(t, generous())
		e.anime(154587)
		alice, bob := e.user("alice"), e.user("bob")
		r := data[wireReview](t, e.call(alice, http.MethodPost, base+"/reviews",
			reviewBody(strings.Repeat("一", 10), 300, false, false)), http.StatusCreated)
		if aliceBlocks {
			e.block(alice, bob)
		} else {
			e.block(bob, alice)
		}
		// The blocked reader does not see the review at all...
		assert.Empty(t, data[wirePage[wireReview]](t, e.call(bob, http.MethodGet, base+"/reviews", nil), http.StatusOK).Items)
		// ...and cannot vote on it by id either.
		failure(t, e.call(bob, http.MethodPut, base+"/reviews/"+r.ID.String()+"/helpful", nil),
			http.StatusForbidden, "FORBIDDEN", msgInteractionUnavailable)
		assert.Zero(t, e.count(`SELECT count(*) FROM anime_review_votes`))
	}
}

func TestReviewList_SortedByHelpfulThenNewest(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	users := []user{e.user("author1"), e.user("author2"), e.user("author3"), e.user("voter1"), e.user("voter2")}
	ids := make([]uuid.UUID, 3)
	for i := 0; i < 3; i++ {
		r := data[wireReview](t, e.call(users[i], http.MethodPost, base+"/reviews",
			reviewBody(strings.Repeat("评", 10+i), 300, false, false)), http.StatusCreated)
		ids[i] = r.ID
		// Spread the creation times so "newest" is unambiguous.
		_, err := e.pool.Exec(context.Background(), `UPDATE anime_reviews SET created_at = $2 WHERE id = $1`,
			r.ID, time.Now().Add(time.Duration(i-3)*time.Hour))
		require.NoError(t, err)
	}
	// ids[0] (oldest) gets two votes, ids[1] none, ids[2] (newest) one.
	for _, voter := range users[3:] {
		require.Equal(t, http.StatusOK, e.call(voter, http.MethodPut, base+"/reviews/"+ids[0].String()+"/helpful", nil).Code)
	}
	require.Equal(t, http.StatusOK, e.call(users[3], http.MethodPut, base+"/reviews/"+ids[2].String()+"/helpful", nil).Code)

	list := data[wirePage[wireReview]](t, e.call(anonymous, http.MethodGet, base+"/reviews", nil), http.StatusOK)
	require.Len(t, list.Items, 3)
	assert.Equal(t, []uuid.UUID{ids[0], ids[2], ids[1]}, []uuid.UUID{list.Items[0].ID, list.Items[1].ID, list.Items[2].ID})

	page2 := data[wirePage[wireReview]](t, e.call(anonymous, http.MethodGet, base+"/reviews?page=2&limit=2", nil), http.StatusOK)
	require.Len(t, page2.Items, 1)
	assert.Equal(t, ids[1], page2.Items[0].ID)
	assert.False(t, page2.HasMore)
	page1 := data[wirePage[wireReview]](t, e.call(anonymous, http.MethodGet, base+"/reviews?limit=2", nil), http.StatusOK)
	assert.True(t, page1.HasMore)
	assert.Equal(t, 2, *page1.NextPage)
}

func TestReviewAuthorsArePIIMasked(t *testing.T) {
	e := newEnv(t, generous())
	e.anime(154587)
	contact := e.user("someone@example.com")
	rec := e.call(contact, http.MethodPost, base+"/reviews", reviewBody(strings.Repeat("一", 10), 300, false, false))
	require.Equal(t, http.StatusCreated, rec.Code)
	assert.NotContains(t, rec.Body.String(), "@example.com")
	assert.NotContains(t, e.call(anonymous, http.MethodGet, base, nil).Body.String(), "@example.com")
}
