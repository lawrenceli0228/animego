package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestData_SimpleObject(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	Data(rec, http.StatusOK, map[string]any{"hello": "world"})

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	got := rec.Body.String()
	want := `{"data":{"hello":"world"}}`
	if got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestData_NoTrailingNewline(t *testing.T) {
	t.Parallel()

	// Express never appends \n to res.json output.  Shadow-traffic diff
	// would fail if Go appends one (json.NewEncoder.Encode does by default).
	rec := httptest.NewRecorder()
	Data(rec, http.StatusOK, map[string]int{"x": 1})

	body := rec.Body.Bytes()
	if len(body) == 0 || body[len(body)-1] == '\n' {
		t.Errorf("body ends with newline; bytes = %q", body)
	}
}

func TestData_NilPayloadProducesNull(t *testing.T) {
	t.Parallel()

	// Documented behavior: passing nil emits {"data":null}.  Discouraged
	// (handlers should use map[string]any{"ok": true} for "no body"
	// success cases), but Data does not panic on it.
	rec := httptest.NewRecorder()
	Data(rec, http.StatusOK, nil)

	if got := rec.Body.String(); got != `{"data":null}` {
		t.Errorf("body = %q, want {\"data\":null}", got)
	}
}

func TestData_HTMLCharsNotEscaped(t *testing.T) {
	t.Parallel()

	// Express emits raw < > & in JSON output (default JSON.stringify).
	// Go's json.Marshal HTML-escapes these to < > & by
	// default — we override with SetEscapeHTML(false) so byte diff passes.
	rec := httptest.NewRecorder()
	Data(rec, http.StatusOK, map[string]string{"q": "a<b & c>d"})

	got := rec.Body.String()
	want := `{"data":{"q":"a<b & c>d"}}`
	if got != want {
		t.Errorf("HTML chars were escaped: got %q, want %q", got, want)
	}
}

func TestPage_HasMoreTrue(t *testing.T) {
	t.Parallel()

	next := 2
	rec := httptest.NewRecorder()
	Page(rec, http.StatusOK, []string{"a", "b"}, Pagination{
		Total: 100, Page: 1, HasMore: true, NextPage: &next,
	})

	want := `{"data":["a","b"],"total":100,"page":1,"hasMore":true,"nextPage":2}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestPage_HasMoreFalseEmitsNull(t *testing.T) {
	t.Parallel()

	// The critical Express-parity test: nextPage must serialise as `null`,
	// not be omitted.  follow.controller.js:59 emits `nextPage: null` on
	// the last page.
	rec := httptest.NewRecorder()
	Page(rec, http.StatusOK, []int{42}, Pagination{
		Total: 1, Page: 1, HasMore: false, NextPage: nil,
	})

	want := `{"data":[42],"total":1,"page":1,"hasMore":false,"nextPage":null}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestPage_NilItemsBecomesEmptyArray(t *testing.T) {
	t.Parallel()

	// Defensive: callers should pass []T{} for empty pages, but nil must
	// not produce "data":null — that would break Express envelope contract.
	rec := httptest.NewRecorder()
	Page[string](rec, http.StatusOK, nil, Pagination{
		Total: 0, Page: 1, HasMore: false, NextPage: nil,
	})

	want := `{"data":[],"total":0,"page":1,"hasMore":false,"nextPage":null}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestPage_EmptySlicePreserved(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	Page(rec, http.StatusOK, []string{}, Pagination{
		Total: 0, Page: 1, HasMore: false, NextPage: nil,
	})

	want := `{"data":[],"total":0,"page":1,"hasMore":false,"nextPage":null}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestPage_FieldOrderMatchesExpress(t *testing.T) {
	t.Parallel()

	// Express writes  data, total, page, hasMore, nextPage  in that order.
	// Go must match exactly — V8 JSON.stringify preserves insertion order.
	next := 2
	rec := httptest.NewRecorder()
	Page(rec, http.StatusOK, []int{1}, Pagination{
		Total: 1, Page: 1, HasMore: true, NextPage: &next,
	})

	body := rec.Body.String()
	keys := []string{"data", "total", "page", "hasMore", "nextPage"}
	last := -1
	for _, k := range keys {
		idx := strings.Index(body, `"`+k+`"`)
		if idx < 0 {
			t.Fatalf("missing key %q in body %q", k, body)
		}
		if idx < last {
			t.Errorf("key %q appears before previous key (idx=%d, last=%d) in %q", k, idx, last, body)
		}
		last = idx
	}
}

func TestFail_APIError(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	Fail(rec, NewError(http.StatusNotFound, CodeNotFound, "用户不存在"))

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	want := `{"error":{"code":"NOT_FOUND","message":"用户不存在"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestFail_WrappedAPIError(t *testing.T) {
	t.Parallel()

	root := errors.New("connection refused")
	apiErr := NewError(http.StatusServiceUnavailable, CodeServerError, "database unreachable", WithCause(root))

	rec := httptest.NewRecorder()
	Fail(rec, apiErr)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
	got := rec.Body.String()
	want := `{"error":{"code":"SERVER_ERROR","message":"database unreachable"}}`
	if got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
	// Cause must NOT leak into the body.
	if strings.Contains(got, "connection refused") {
		t.Errorf("cause leaked into response body: %s", got)
	}
}

func TestFail_PlainErrorWrapsAs500(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	Fail(rec, errors.New("something broke"))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	want := `{"error":{"code":"SERVER_ERROR","message":"internal error"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestFail_NilErrorIsDefensive(t *testing.T) {
	t.Parallel()

	// Callers should never pass nil but Fail must not panic.
	rec := httptest.NewRecorder()
	Fail(rec, nil)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	want := `{"error":{"code":"SERVER_ERROR","message":"internal error"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestFail_AllErrorCodesRoundTrip(t *testing.T) {
	t.Parallel()

	// Smoke test: every code constant in codes.go round-trips through Fail
	// without losing its identity.  Detects accidental renames or typos.
	cases := []struct {
		code   string
		status int
	}{
		{CodeBadRequest, 400},
		{CodeValidationError, 400},
		{CodeInvalidAction, 400},
		{CodeInvalidCredentials, 401},
		{CodeNoToken, 401},
		{CodeInvalidToken, 401},
		{CodeTokenExpired, 401},
		{CodeUnauthorized, 401},
		{CodeForbidden, 403},
		{CodeNotFound, 404},
		{CodeConflict, 409},
		{CodeDuplicate, 409},
		{CodeTooManyRequests, 429},
		{CodeServerError, 500},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.code, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			Fail(rec, NewError(tc.status, tc.code, "test"))

			if rec.Code != tc.status {
				t.Errorf("status = %d, want %d", rec.Code, tc.status)
			}
			var payload map[string]map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
				t.Fatalf("unmarshal body: %v", err)
			}
			if payload["error"]["code"] != tc.code {
				t.Errorf("code = %q, want %q", payload["error"]["code"], tc.code)
			}
		})
	}
}

func TestWriteJSON_MarshalFailureFallback(t *testing.T) {
	t.Parallel()

	// Pass a value json.Marshal cannot encode (channel) — Data must NOT
	// panic, must respond 500, and must produce the canonical SERVER_ERROR
	// envelope so the client always sees valid JSON.
	rec := httptest.NewRecorder()
	Data(rec, http.StatusOK, make(chan int))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	want := `{"error":{"code":"SERVER_ERROR","message":"internal error"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestData_BodyByteExact(t *testing.T) {
	t.Parallel()

	// Smoke test that Data does not introduce stray whitespace or BOM
	// markers — every byte must be JSON.
	rec := httptest.NewRecorder()
	Data(rec, http.StatusOK, struct {
		Anilist int    `json:"anilistId"`
		Title   string `json:"titleChinese"`
	}{Anilist: 12345, Title: "进击的巨人"})

	want := []byte(`{"data":{"anilistId":12345,"titleChinese":"进击的巨人"}}`)
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Errorf("body bytes mismatch\n got: %q\nwant: %q", rec.Body.Bytes(), want)
	}
}
