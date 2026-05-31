package httpx

// Byte-level fixture tests against the Express server's actual JSON output.
//
// Each `want` constant below is the literal byte sequence produced by the
// Express controller listed in its godoc.  When Phase 8.5 shadow traffic
// runs Go alongside Express, a per-byte diff between the two responses is
// the gate that decides whether the rewrite is shipping-safe.  These tests
// catch envelope-shape drift at code-review time instead of after a week
// of shadow traffic.
//
// Source-of-truth for each fixture (do not edit without updating Express):
//
//	server/controllers/detail.controller.js:31     (data: anime)
//	server/controllers/follow.controller.js:19     (data: { following: true })
//	server/controllers/follow.controller.js:59     (data, total, page, hasMore, nextPage)
//	server/controllers/follow.controller.js:8      (NOT_FOUND)
//	server/controllers/subscription.controller.js:49  (VALIDATION_ERROR)

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExpressFixture_DetailGet(t *testing.T) {
	t.Parallel()

	// Source:  detail.controller.js:31   res.json({ data: anime });
	type anime struct {
		AnilistID    int    `json:"anilistId"`
		TitleChinese string `json:"titleChinese"`
		Episodes     int    `json:"episodes"`
	}

	rec := httptest.NewRecorder()
	Data(rec, http.StatusOK, anime{AnilistID: 12345, TitleChinese: "进击的巨人", Episodes: 25})

	want := `{"data":{"anilistId":12345,"titleChinese":"进击的巨人","episodes":25}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestExpressFixture_FollowPost(t *testing.T) {
	t.Parallel()

	// Source:  follow.controller.js:19  res.status(201).json({ data: { following: true } });
	rec := httptest.NewRecorder()
	Data(rec, http.StatusCreated, map[string]bool{"following": true})

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", rec.Code)
	}
	want := `{"data":{"following":true}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestExpressFixture_FollowListHasMoreTrue(t *testing.T) {
	t.Parallel()

	// Source:  follow.controller.js:59
	//   res.json({ data, total, page, hasMore, nextPage: hasMore ? page + 1 : null });
	type userSummary struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	}

	next := 2
	rec := httptest.NewRecorder()
	Page(rec, http.StatusOK, []userSummary{
		{ID: "u1", Username: "alice"},
		{ID: "u2", Username: "bob"},
	}, Pagination{
		Total: 50, Page: 1, HasMore: true, NextPage: &next,
	})

	want := `{"data":[{"id":"u1","username":"alice"},{"id":"u2","username":"bob"}],"total":50,"page":1,"hasMore":true,"nextPage":2}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestExpressFixture_FollowListHasMoreFalse(t *testing.T) {
	t.Parallel()

	// Same source, but last page: nextPage MUST be `null`, not absent.
	type userSummary struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	}

	rec := httptest.NewRecorder()
	Page(rec, http.StatusOK, []userSummary{{ID: "u1", Username: "alice"}}, Pagination{
		Total: 1, Page: 1, HasMore: false, NextPage: nil,
	})

	want := `{"data":[{"id":"u1","username":"alice"}],"total":1,"page":1,"hasMore":false,"nextPage":null}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestExpressFixture_NotFoundError(t *testing.T) {
	t.Parallel()

	// Source:  follow.controller.js:8
	//   res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });
	rec := httptest.NewRecorder()
	Fail(rec, NewError(http.StatusNotFound, CodeNotFound, "用户不存在"))

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	want := `{"error":{"code":"NOT_FOUND","message":"用户不存在"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestExpressFixture_ValidationError(t *testing.T) {
	t.Parallel()

	// Source:  subscription.controller.js:49
	//   res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: errors.array()[0].msg } });
	// Sample message taken from server/__tests__ fixtures: "评分需在 1-10 之间".
	rec := httptest.NewRecorder()
	Fail(rec, NewError(http.StatusBadRequest, CodeValidationError, "评分需在 1-10 之间"))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	want := `{"error":{"code":"VALIDATION_ERROR","message":"评分需在 1-10 之间"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}
