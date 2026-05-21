// Package bangumi — client_test.go
//
// Tests the Bangumi HTTP client against an httptest fake that mimics
// the production api.bgm.tv wire format.  Covers all four endpoint
// methods, 404→ErrNotFound mapping, 5xx→*ErrUpstream wrapping, the
// User-Agent + Accept header propagation (including the "AnimGo" typo),
// the 800ms throttle, and context cancellation behaviour.
//
// The throttle test is the only place we exercise a real rate.Limiter
// against wall-clock time — it's bounded to ~1.5s of total runtime and
// is the only "slow" test in this file.  All other tests replace the
// production 800ms limiter with rate.Inf so individual test cases run
// in well under a second.
package bangumi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/time/rate"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// testClient builds a Client pointed at the given fake URL.  The
// limiter is replaced with an unrestricted one (rate.Inf) so individual
// tests don't pay the 800ms tax — TestClient_Throttle_800ms is the only
// test that wants to exercise the real limiter.
func testClient(t *testing.T, baseURL string, opts ...Option) *Client {
	t.Helper()
	base := []Option{WithEndpoint(baseURL)}
	c := NewClient(append(base, opts...)...)
	c.limiter = rate.NewLimiter(rate.Inf, 0)
	return c
}

// writeJSON is a small helper for fake servers.
func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// ---------------------------------------------------------------------------
// Search — happy + edge cases
// ---------------------------------------------------------------------------

func TestClient_Search_OK(t *testing.T) {
	t.Parallel()

	const body = `{
	  "list": [
	    {
	      "id": 326,
	      "name": "進撃の巨人",
	      "name_cn": "进击的巨人",
	      "type": 2
	    },
	    {
	      "id": 9624,
	      "name": "進撃の巨人 Season 2",
	      "name_cn": "进击的巨人 第二季",
	      "type": 2
	    }
	  ]
	}`

	var seenMethod, seenPath, seenQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenPath = r.URL.Path
		seenQuery = r.URL.RawQuery
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Search(context.Background(), "進撃の巨人")

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.MethodGet, seenMethod)
	// Server decodes the path before exposing it; assert the decoded form.
	assert.Equal(t, "/search/subject/進撃の巨人", seenPath)
	assert.Equal(t, "type=2&responseGroup=small&max_results=5", seenQuery)
	require.Len(t, resp.List, 2)
	assert.Equal(t, 326, resp.List[0].ID)
	assert.Equal(t, "進撃の巨人", resp.List[0].Name)
	assert.Equal(t, "进击的巨人", resp.List[0].NameCN)
}

func TestClient_Search_404_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Search(context.Background(), "this-keyword-has-no-results")

	require.Error(t, err)
	assert.Nil(t, resp)
	assert.True(t, errors.Is(err, ErrNotFound),
		"expected errors.Is(err, ErrNotFound), got %T: %v", err, err)
}

func TestClient_Search_EmptyList(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `{"list":[]}`)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Search(context.Background(), "anything")

	// 200 OK with empty list → no error, empty list.  This is distinct
	// from the 404 case (which becomes ErrNotFound).
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Empty(t, resp.List)
}

// TestClient_Search_KeywordPathEscape verifies the keyword is encoded
// via url.PathEscape (NOT QueryEscape) — the difference matters for
// "+" handling (PathEscape leaves "+" alone, QueryEscape converts to
// "%2B"), but more importantly for the byte-exact request the JS code
// sends via encodeURIComponent.
func TestClient_Search_KeywordPathEscape(t *testing.T) {
	t.Parallel()

	const keyword = "進撃の巨人"
	wantPathRaw := "/search/subject/" + url.PathEscape(keyword)

	var seenRawPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Use r.URL.EscapedPath to inspect the raw (still-encoded) path,
		// so we can byte-compare against url.PathEscape's output.
		seenRawPath = r.URL.EscapedPath()
		writeJSON(w, http.StatusOK, `{"list":[]}`)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Search(context.Background(), keyword)
	require.NoError(t, err)
	assert.Equal(t, wantPathRaw, seenRawPath,
		"expected keyword to be url.PathEscape'd in the path segment")
	// Sanity-check that the encoded form contains URL-encoded bytes.
	assert.Contains(t, seenRawPath, "%E9%80%B2",
		"expected CJK bytes to be percent-encoded; got %s", seenRawPath)
}

// ---------------------------------------------------------------------------
// Subject — happy + 404 + 5xx
// ---------------------------------------------------------------------------

func TestClient_Subject_OK(t *testing.T) {
	t.Parallel()

	const body = `{
	  "id": 326,
	  "name": "進撃の巨人",
	  "name_cn": "进击的巨人",
	  "type": 2,
	  "date": "2013-04-07",
	  "eps": 25,
	  "summary": "巨人来袭",
	  "images": {
	    "common": "https://lain.bgm.tv/r/200/pic/cover/c/common.jpg",
	    "large":  "https://lain.bgm.tv/r/800/pic/cover/c/large.jpg"
	  },
	  "rating": {
	    "score": 9.2,
	    "total": 12345
	  },
	  "tags": [
	    { "name": "巨人", "count": 100 },
	    { "name": "热血", "count": 50 }
	  ]
	}`

	var seenPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Subject(context.Background(), 326)

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, "/v0/subjects/326", seenPath)
	assert.Equal(t, 326, resp.ID)
	assert.Equal(t, "进击的巨人", resp.NameCN)
	assert.Equal(t, "2013-04-07", resp.Date)
	assert.Equal(t, 25, resp.Eps)
	require.NotNil(t, resp.Rating)
	assert.Equal(t, 9.2, resp.Rating.Score)
	assert.Equal(t, 12345, resp.Rating.Count)
	require.NotNil(t, resp.Images)
	assert.Equal(t, "https://lain.bgm.tv/r/800/pic/cover/c/large.jpg", resp.Images.Large)
	require.Len(t, resp.Tags, 2)
	assert.Equal(t, "巨人", resp.Tags[0].Name)
	assert.Equal(t, 100, resp.Tags[0].Count)
}

func TestClient_Subject_404(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Subject(context.Background(), 99999999)

	require.Error(t, err)
	assert.Nil(t, resp)
	assert.True(t, errors.Is(err, ErrNotFound),
		"expected errors.Is(err, ErrNotFound), got %T: %v", err, err)
}

func TestClient_Subject_500_ErrUpstream(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Subject(context.Background(), 326)

	require.Error(t, err)
	assert.Nil(t, resp)

	var upstream *ErrUpstream
	require.True(t, errors.As(err, &upstream),
		"expected *ErrUpstream, got %T: %v", err, err)
	assert.Equal(t, http.StatusInternalServerError, upstream.Status)
	assert.Equal(t, "Bangumi API error", upstream.Message)
	// 404 sentinel must NOT match 500.
	assert.False(t, errors.Is(err, ErrNotFound),
		"500 must not match ErrNotFound")
}

// TestClient_429_ErrUpstream — Bangumi can also return 429 (rate
// limited).  Express has no explicit retry for Bangumi (relying solely
// on the 800ms throttle), so we map it to *ErrUpstream too, NOT to a
// dedicated sentinel.
func TestClient_429_ErrUpstream(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Subject(context.Background(), 326)

	require.Error(t, err)
	var upstream *ErrUpstream
	require.True(t, errors.As(err, &upstream))
	assert.Equal(t, http.StatusTooManyRequests, upstream.Status)
}

// ---------------------------------------------------------------------------
// Characters — slice decode
// ---------------------------------------------------------------------------

func TestClient_Characters_OK(t *testing.T) {
	t.Parallel()

	const body = `[
	  {
	    "id": 1,
	    "name": "艾伦·耶格尔",
	    "name_cn": "艾伦·耶格尔",
	    "relation": 1,
	    "type": 1,
	    "images": { "medium": "https://lain.bgm.tv/r/200/pic/crt/m/eren.jpg" },
	    "actors": [
	      { "id": 11, "name": "梶裕貴", "name_cn": "梶裕贵" }
	    ]
	  },
	  {
	    "id": 2,
	    "name": "三笠·阿克曼",
	    "name_cn": "三笠·阿克曼",
	    "relation": 1,
	    "type": 1,
	    "actors": [
	      { "id": 12, "name": "石川由依" }
	    ]
	  },
	  {
	    "id": 3,
	    "name": "Hannes",
	    "name_cn": "韩斯",
	    "relation": 2,
	    "type": 1
	  }
	]`

	var seenPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	chars, err := c.Characters(context.Background(), 326)

	require.NoError(t, err)
	assert.Equal(t, "/v0/subjects/326/characters", seenPath)
	require.Len(t, chars, 3)
	assert.Equal(t, 1, chars[0].ID)
	assert.Equal(t, "艾伦·耶格尔", chars[0].Name)
	assert.Equal(t, 1, chars[0].Relation) // 主角
	require.NotNil(t, chars[0].Images)
	assert.Equal(t, "https://lain.bgm.tv/r/200/pic/crt/m/eren.jpg", chars[0].Images.Medium)
	require.Len(t, chars[0].Actors, 1)
	assert.Equal(t, "梶裕貴", chars[0].Actors[0].Name)
	// Character with no actors / no images should still decode.
	assert.Equal(t, 3, chars[2].ID)
	assert.Equal(t, 2, chars[2].Relation) // 配角
	assert.Empty(t, chars[2].Actors)
	assert.Nil(t, chars[2].Images)
}

func TestClient_Characters_404(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Characters(context.Background(), 99999999)
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrNotFound))
}

// ---------------------------------------------------------------------------
// Episodes — {eps:[...]} envelope decode
// ---------------------------------------------------------------------------

func TestClient_Episodes_OK(t *testing.T) {
	t.Parallel()

	const body = `{
	  "eps": [
	    {
	      "id":   1001,
	      "sort": 1,
	      "type": 0,
	      "name": "二千年後の君へ",
	      "name_cn": "致两千年后的你",
	      "status": "Air"
	    },
	    {
	      "id":   1002,
	      "sort": 2,
	      "type": 0,
	      "name": "その日",
	      "name_cn": "那一天",
	      "status": "Air"
	    },
	    {
	      "id":   1003,
	      "sort": 1.5,
	      "type": 1,
	      "name": "SP",
	      "name_cn": "番外",
	      "status": "Air"
	    }
	  ]
	}`

	var seenPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Episodes(context.Background(), 326)

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, "/subject/326/ep", seenPath)
	require.Len(t, resp.Eps, 3)
	assert.Equal(t, 1001, resp.Eps[0].ID)
	assert.Equal(t, float64(1), resp.Eps[0].Sort)
	assert.Equal(t, 0, resp.Eps[0].Type) // 正篇
	assert.Equal(t, "致两千年后的你", resp.Eps[0].NameCN)
	// Specials use non-integer sort (1.5) — must decode as float64.
	assert.Equal(t, 1.5, resp.Eps[2].Sort)
	assert.Equal(t, 1, resp.Eps[2].Type) // SP
}

func TestClient_Episodes_404(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Episodes(context.Background(), 99999999)
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrNotFound))
}

// ---------------------------------------------------------------------------
// Header propagation — User-Agent (with "AnimGo" typo) + Accept
// ---------------------------------------------------------------------------

// TestClient_UserAgent_Sent asserts that every request carries the
// DefaultUA byte-exact, INCLUDING the "AnimGo" typo (vs "AnimeGo").
// Bangumi rate-limit allowlists may be keyed on this exact string —
// changing it could push our traffic into a stricter bucket.
func TestClient_UserAgent_Sent(t *testing.T) {
	t.Parallel()

	var seenUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenUA = r.Header.Get("User-Agent")
		writeJSON(w, http.StatusOK, `{"list":[]}`)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Search(context.Background(), "test")
	require.NoError(t, err)

	assert.Equal(t, "AnimGo/1.0 (https://github.com/animego)", seenUA)
	// Belt-and-braces: confirm the typo specifically.
	assert.True(t, strings.HasPrefix(seenUA, "AnimGo/"),
		"UA must start with the AnimGo typo (NOT AnimeGo/); got %q", seenUA)
	assert.False(t, strings.Contains(seenUA, "AnimeGo"),
		"UA must NOT contain AnimeGo — preserve the production typo; got %q", seenUA)
}

func TestClient_AcceptHeader_Sent(t *testing.T) {
	t.Parallel()

	var seenAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAccept = r.Header.Get("Accept")
		writeJSON(w, http.StatusOK, `{"list":[]}`)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Search(context.Background(), "test")
	require.NoError(t, err)

	assert.Equal(t, "application/json", seenAccept)
}

// TestClient_WithUserAgent_Override verifies the test-only override works.
func TestClient_WithUserAgent_Override(t *testing.T) {
	t.Parallel()

	var seenUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenUA = r.Header.Get("User-Agent")
		writeJSON(w, http.StatusOK, `{"list":[]}`)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL, WithUserAgent("CustomAgent/2.0"))
	_, err := c.Search(context.Background(), "test")
	require.NoError(t, err)

	assert.Equal(t, "CustomAgent/2.0", seenUA)
}

// ---------------------------------------------------------------------------
// Throttle + context behaviour
// ---------------------------------------------------------------------------

// TestClient_Throttle_800ms makes two real calls under the production
// 800ms limiter and asserts elapsed >= 800ms.  This is the only test
// that uses wall-clock time intentionally.
func TestClient_Throttle_800ms(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `{"list":[]}`)
	}))
	defer srv.Close()

	// Use the real production limiter — no rate.Inf override.
	c := NewClient(WithEndpoint(srv.URL))

	start := time.Now()
	_, err := c.Search(context.Background(), "k1")
	require.NoError(t, err)
	_, err = c.Search(context.Background(), "k2")
	require.NoError(t, err)
	elapsed := time.Since(start)

	// burst=1 means the first call goes through immediately; the second
	// must wait ~800ms for the bucket to refill.
	assert.GreaterOrEqual(t, elapsed, 800*time.Millisecond,
		"expected >=800ms total for 2 calls under the 800ms limiter, got %v", elapsed)
	// Don't assert an upper bound — CI jitter could push it over 1s
	// without indicating a real bug.
}

// TestClient_ContextCancellation drains the limiter's single token then
// invokes Search with a pre-cancelled ctx.  Expectation: limiter.Wait
// returns context.Canceled and the upstream is never hit.
func TestClient_ContextCancellation(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream should not be called when ctx is cancelled")
	}))
	defer srv.Close()

	// Build a client whose limiter has already exhausted its initial
	// token, so limiter.Wait will block until the next refill.
	c := NewClient(WithEndpoint(srv.URL))
	c.limiter = rate.NewLimiter(rate.Every(1*time.Hour), 1)
	// Drain the single starting token so the next Wait blocks.
	require.True(t, c.limiter.Allow(), "expected initial token available")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := c.Search(ctx, "anything")
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled,
		"expected context.Canceled to propagate from limiter.Wait, got %v", err)
}

// TestClient_WithEndpoint_Override verifies the WithEndpoint option swaps
// the base URL.  Build two servers; only one is hit.
func TestClient_WithEndpoint_Override(t *testing.T) {
	t.Parallel()

	var rightHits, wrongHits int
	rightSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rightHits++
		writeJSON(w, http.StatusOK, `{"list":[]}`)
	}))
	defer rightSrv.Close()
	wrongSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wrongHits++
	}))
	defer wrongSrv.Close()

	// Build client with the WRONG URL, then override via WithEndpoint.
	c := NewClient(WithEndpoint(wrongSrv.URL), WithEndpoint(rightSrv.URL))
	c.limiter = rate.NewLimiter(rate.Inf, 0)

	_, err := c.Search(context.Background(), "test")
	require.NoError(t, err)
	assert.Equal(t, 1, rightHits, "expected the right server to be hit once")
	assert.Equal(t, 0, wrongHits, "expected the wrong server never to be hit")
}

// ---------------------------------------------------------------------------
// Extra branches: transport error, malformed JSON, WithHTTPClient
// ---------------------------------------------------------------------------

// TestClient_WithHTTPClient verifies WithHTTPClient swaps the inner
// *http.Client by checking that a 1ns timeout actually causes a
// transport error.
func TestClient_WithHTTPClient(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond)
		writeJSON(w, http.StatusOK, `{"list":[]}`)
	}))
	defer srv.Close()

	c := NewClient(
		WithEndpoint(srv.URL),
		WithHTTPClient(&http.Client{Timeout: 1 * time.Nanosecond}),
	)
	c.limiter = rate.NewLimiter(rate.Inf, 0)

	_, err := c.Search(context.Background(), "test")
	require.Error(t, err, "expected transport error from 1ns timeout")
	assert.Contains(t, err.Error(), "bangumi: http do",
		"expected error to be wrapped by client.get, got %v", err)
}

// TestClient_TransportError points the client at a closed listener so
// the connection attempt fails at the transport level.
func TestClient_TransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	closedURL := srv.URL
	srv.Close()

	c := testClient(t, closedURL)
	_, err := c.Subject(context.Background(), 326)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "bangumi: http do")
}

// TestClient_MalformedJSON covers the json decoder error branch.
func TestClient_MalformedJSON(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `not even close to json`)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Subject(context.Background(), 326)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode response")
}

// ---------------------------------------------------------------------------
// ErrUpstream Error() formatting
// ---------------------------------------------------------------------------

func TestErrUpstream_Error(t *testing.T) {
	t.Parallel()

	e := &ErrUpstream{Status: 500, Message: "Bangumi API error"}
	assert.Equal(t, "bangumi: Bangumi API error (500)", e.Error())

	var nilErr *ErrUpstream
	assert.Equal(t, "<nil ErrUpstream>", nilErr.Error())
}

// Compile-time guards: ensure the public types satisfy expected interfaces.
var (
	_ error = (*ErrUpstream)(nil)
	_ error = ErrNotFound
)
