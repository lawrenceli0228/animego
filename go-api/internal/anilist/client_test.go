// Package anilist — client_test.go
//
// Tests the AniList GraphQL client against an httptest fake that mimics
// the production AniList wire format.  Covers all four query methods,
// the 429 retry loop, upstream error wrapping, the 700ms throttle, and
// context cancellation behaviour.
//
// All retry-loop tests inject a no-op sleep via WithSleep so test
// runtime stays under a few milliseconds.  The throttle test is the
// one place we exercise a real rate.Limiter against wall-clock time —
// it's bounded to ~1.5s of total runtime and is the only "slow" test
// in this file.
package anilist

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/time/rate"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// noopSleep is the test sleep hook that records each delay request
// without actually waiting.  Tests pass it via WithSleep to fast-forward
// through the 429 retry backoff.
func newNoopSleep() (func(context.Context, time.Duration) error, *[]time.Duration) {
	var recorded []time.Duration
	hook := func(_ context.Context, d time.Duration) error {
		recorded = append(recorded, d)
		return nil
	}
	return hook, &recorded
}

// testClient builds a Client pointed at the given fake URL.  The
// limiter is replaced with an unrestricted one so individual tests
// don't pay the 700ms tax — TestClient_Throttle_700ms is the only
// test that wants to exercise the real limiter.
func testClient(t *testing.T, url string, opts ...Option) *Client {
	t.Helper()
	noop, _ := newNoopSleep()
	base := []Option{
		WithEndpoint(url),
		WithSleep(noop),
	}
	c := NewClient(append(base, opts...)...)
	// Replace the production 700ms limiter with one that allows
	// effectively unlimited bursts — individual functional tests don't
	// care about throttle behaviour.
	c.limiter = rate.NewLimiter(rate.Inf, 0)
	return c
}

// writeJSON is a small helper for fake servers that emit GraphQL
// responses.  Sets the content-type header and writes the body.
func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// ---------------------------------------------------------------------------
// Happy-path tests for the four query methods
// ---------------------------------------------------------------------------

func TestClient_Search_OK(t *testing.T) {
	t.Parallel()

	const body = `{
	  "data": {
	    "Page": {
	      "pageInfo": { "total": 1, "currentPage": 1, "lastPage": 1, "hasNextPage": false, "perPage": 20 },
	      "media": [
	        {
	          "id": 1,
	          "title": { "romaji": "Cowboy Bebop", "english": "Cowboy Bebop", "native": "カウボーイビバップ" },
	          "coverImage": { "extraLarge": "https://example.com/a.jpg", "large": "https://example.com/b.jpg", "color": "#aabbcc" },
	          "bannerImage": null,
	          "description": "Space cowboys.",
	          "episodes": 26,
	          "status": "FINISHED",
	          "season": "SPRING",
	          "seasonYear": 1998,
	          "averageScore": 86,
	          "genres": ["Action", "Sci-Fi"],
	          "format": "TV"
	        }
	      ]
	    }
	  }
	}`

	var seenMethod, seenContentType, seenAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenContentType = r.Header.Get("Content-Type")
		seenAccept = r.Header.Get("Accept")
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	search := "cowboy"
	resp, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20, Search: &search})

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, http.MethodPost, seenMethod)
	assert.Equal(t, "application/json", seenContentType)
	assert.Equal(t, "application/json", seenAccept)
	assert.Equal(t, 1, resp.Page.PageInfo.Total)
	require.Len(t, resp.Page.Media, 1)
	assert.Equal(t, 1, resp.Page.Media[0].ID)
	require.NotNil(t, resp.Page.Media[0].Title)
	require.NotNil(t, resp.Page.Media[0].Title.Romaji)
	assert.Equal(t, "Cowboy Bebop", *resp.Page.Media[0].Title.Romaji)
}

func TestClient_Seasonal_OK(t *testing.T) {
	t.Parallel()

	const body = `{
	  "data": {
	    "Page": {
	      "pageInfo": { "total": 2, "currentPage": 1, "lastPage": 1, "hasNextPage": false, "perPage": 20 },
	      "media": [
	        { "id": 100, "title": { "romaji": "Foo" }, "coverImage": null, "bannerImage": null, "description": null, "episodes": 12, "status": "RELEASING", "season": "FALL", "seasonYear": 2025, "averageScore": 80, "genres": [], "format": "TV" },
	        { "id": 101, "title": { "romaji": "Bar" }, "coverImage": null, "bannerImage": null, "description": null, "episodes": 13, "status": "RELEASING", "season": "FALL", "seasonYear": 2025, "averageScore": 70, "genres": [], "format": "TV" }
	      ]
	    }
	  }
	}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Seasonal(context.Background(), SeasonalVars{Page: 1, PerPage: 20, Season: "FALL", SeasonYear: 2025})

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 2, resp.Page.PageInfo.Total)
	require.Len(t, resp.Page.Media, 2)
	assert.Equal(t, 100, resp.Page.Media[0].ID)
	assert.Equal(t, 101, resp.Page.Media[1].ID)
}

func TestClient_Detail_OK(t *testing.T) {
	t.Parallel()

	const body = `{
	  "data": {
	    "Media": {
	      "id": 42,
	      "title": { "romaji": "Test", "english": null, "native": null },
	      "coverImage": null,
	      "bannerImage": null,
	      "description": "Detail body.",
	      "episodes": 12,
	      "status": "FINISHED",
	      "season": "SUMMER",
	      "seasonYear": 2024,
	      "averageScore": 75,
	      "genres": ["Drama"],
	      "format": "TV",
	      "studios": { "nodes": [{ "name": "Studio A" }] },
	      "characters": { "edges": [] },
	      "staff": { "edges": [] },
	      "recommendations": { "nodes": [] }
	    }
	  }
	}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Detail(context.Background(), DetailVars{ID: 42})

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, 42, resp.Media.ID)
	require.NotNil(t, resp.Media.Studios)
	require.Len(t, resp.Media.Studios.Nodes, 1)
	assert.Equal(t, "Studio A", resp.Media.Studios.Nodes[0].Name)
}

func TestClient_Schedule_OK(t *testing.T) {
	t.Parallel()

	const body = `{
	  "data": {
	    "Page": {
	      "pageInfo": { "hasNextPage": false },
	      "airingSchedules": [
	        {
	          "id": 9001,
	          "airingAt": 1700000000,
	          "episode": 3,
	          "media": {
	            "id": 555,
	            "isAdult": false,
	            "title": { "romaji": "Sched One" },
	            "coverImage": null,
	            "format": "TV",
	            "averageScore": 65,
	            "genres": ["Slice of Life"]
	          }
	        }
	      ]
	    }
	  }
	}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	resp, err := c.Schedule(context.Background(), ScheduleVars{WeekStart: 1700000000, WeekEnd: 1700604800, Page: 1})

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.False(t, resp.Page.PageInfo.HasNextPage)
	require.Len(t, resp.Page.AiringSchedules, 1)
	assert.Equal(t, int64(1700000000), resp.Page.AiringSchedules[0].AiringAt)
	assert.Equal(t, 3, resp.Page.AiringSchedules[0].Episode)
	assert.Equal(t, 555, resp.Page.AiringSchedules[0].Media.ID)
}

// ---------------------------------------------------------------------------
// 429 retry behaviour
// ---------------------------------------------------------------------------

func TestClient_429_RetryWithHeader(t *testing.T) {
	t.Parallel()

	const okBody = `{"data":{"Page":{"pageInfo":{"total":0,"currentPage":1,"lastPage":1,"hasNextPage":false,"perPage":20},"media":[]}}}`
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		writeJSON(w, http.StatusOK, okBody)
	}))
	defer srv.Close()

	sleepHook, recorded := newNoopSleep()
	c := NewClient(WithEndpoint(srv.URL), WithSleep(sleepHook))
	c.limiter = rate.NewLimiter(rate.Inf, 0)

	resp, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})

	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, int32(2), callCount.Load(), "expected 1 retry after 429")
	require.Len(t, *recorded, 1, "expected one sleep call between retry attempts")
	assert.Equal(t, 1*time.Second, (*recorded)[0], "Retry-After: 1 → sleep 1s")
}

func TestClient_429_RetryDefault60(t *testing.T) {
	t.Parallel()

	const okBody = `{"data":{"Page":{"pageInfo":{"total":0,"currentPage":1,"lastPage":1,"hasNextPage":false,"perPage":20},"media":[]}}}`
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n == 1 {
			// No Retry-After header — client must fall back to 60s.
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		writeJSON(w, http.StatusOK, okBody)
	}))
	defer srv.Close()

	sleepHook, recorded := newNoopSleep()
	c := NewClient(WithEndpoint(srv.URL), WithSleep(sleepHook))
	c.limiter = rate.NewLimiter(rate.Inf, 0)

	_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})

	require.NoError(t, err)
	require.Len(t, *recorded, 1)
	assert.Equal(t, 60*time.Second, (*recorded)[0], "missing Retry-After → 60s default")
}

func TestClient_429_GiveUpAfter3Retries(t *testing.T) {
	t.Parallel()

	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	sleepHook, recorded := newNoopSleep()
	c := NewClient(WithEndpoint(srv.URL), WithSleep(sleepHook))
	c.limiter = rate.NewLimiter(rate.Inf, 0)

	_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrRateLimited, "expected ErrRateLimited sentinel")
	// 1 initial + 3 retries = 4 total HTTP attempts.
	assert.Equal(t, int32(4), callCount.Load(), "expected 4 total attempts (1 + 3 retries)")
	// 3 sleeps between the 4 attempts.
	assert.Len(t, *recorded, 3, "expected exactly 3 retry sleeps")
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

func TestClient_Breaker_ShortCircuitsWhileOpen(t *testing.T) {
	t.Parallel()

	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	sleepHook, _ := newNoopSleep()
	c := NewClient(WithEndpoint(srv.URL), WithSleep(sleepHook))
	c.limiter = rate.NewLimiter(rate.Inf, 0)

	// First call exhausts the retry budget (1 + 3 = 4 attempts) and trips
	// the breaker.
	_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})
	require.ErrorIs(t, err, ErrRateLimited)
	require.Equal(t, int32(4), callCount.Load())

	// Second call: breaker is open → short-circuit with ZERO HTTP calls.
	_, err = c.Detail(context.Background(), DetailVars{ID: 1})
	require.ErrorIs(t, err, ErrRateLimited)
	assert.Equal(t, int32(4), callCount.Load(), "open breaker must not touch AniList")
}

func TestClient_Breaker_ClosesAfterCooldown(t *testing.T) {
	t.Parallel()

	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	now := time.Unix(1_000_000, 0)
	sleepHook, _ := newNoopSleep()
	c := NewClient(
		WithEndpoint(srv.URL),
		WithSleep(sleepHook),
		WithNow(func() time.Time { return now }),
	)
	c.limiter = rate.NewLimiter(rate.Inf, 0)

	// Trip the breaker.
	_, _ = c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})
	require.Equal(t, int32(4), callCount.Load())

	// Still inside the cooldown window → short-circuit, no new HTTP attempts.
	now = now.Add(breakerCooldown - time.Second)
	_, _ = c.Detail(context.Background(), DetailVars{ID: 1})
	require.Equal(t, int32(4), callCount.Load(), "within cooldown: no upstream call")

	// Past the cooldown → probe upstream again (4 more attempts; it 429s anew).
	now = now.Add(2 * time.Second)
	_, _ = c.Detail(context.Background(), DetailVars{ID: 1})
	assert.Equal(t, int32(8), callCount.Load(), "after cooldown: probes upstream again")
}

// ---------------------------------------------------------------------------
// Non-2xx / GraphQL error wrapping
// ---------------------------------------------------------------------------

func TestClient_5xx_WrappedAsUpstream(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
	}{
		{"500 internal", http.StatusInternalServerError},
		{"502 bad gateway", http.StatusBadGateway},
		{"503 unavailable", http.StatusServiceUnavailable},
		{"400 client", http.StatusBadRequest},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
			}))
			defer srv.Close()

			c := testClient(t, srv.URL)
			_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})

			require.Error(t, err)
			var upstream *ErrUpstream
			require.True(t, errors.As(err, &upstream), "expected *ErrUpstream, got %T: %v", err, err)
			assert.Equal(t, tc.status, upstream.Status)
			assert.Contains(t, upstream.Message, strconv.Itoa(tc.status))
		})
	}
}

func TestClient_GraphQLError_WrappedAsUpstream(t *testing.T) {
	t.Parallel()

	const errBody = `{"data":null,"errors":[{"message":"Variable $id of type Int! was provided invalid value"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, errBody)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Detail(context.Background(), DetailVars{ID: 0})

	require.Error(t, err)
	var upstream *ErrUpstream
	require.True(t, errors.As(err, &upstream), "expected *ErrUpstream, got %T: %v", err, err)
	assert.Equal(t, http.StatusBadGateway, upstream.Status, "GraphQL field errors → 502")
	assert.Equal(t, "Variable $id of type Int! was provided invalid value", upstream.Message)
}

// ---------------------------------------------------------------------------
// Throttle + context behaviour
// ---------------------------------------------------------------------------

func TestClient_Throttle_700ms(t *testing.T) {
	t.Parallel()

	const okBody = `{"data":{"Page":{"pageInfo":{"total":0,"currentPage":1,"lastPage":1,"hasNextPage":false,"perPage":20},"media":[]}}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, okBody)
	}))
	defer srv.Close()

	// Use the real production limiter — no rate.Inf override.
	c := NewClient(WithEndpoint(srv.URL))

	start := time.Now()
	_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})
	require.NoError(t, err)
	_, err = c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})
	require.NoError(t, err)
	elapsed := time.Since(start)

	// burst=1 means the first call goes through immediately; the second
	// must wait ~700ms for the bucket to refill.
	assert.GreaterOrEqual(t, elapsed, 700*time.Millisecond,
		"expected >=700ms total for 2 calls under the 700ms limiter, got %v", elapsed)
	// Don't assert an upper bound — CI scheduling jitter could push it
	// over 1s without indicating a real bug.
}

func TestClient_ContextCancellation(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Should never be reached — ctx is cancelled before the limiter
		// releases a token.
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
	cancel() // cancel immediately

	_, err := c.Search(ctx, SearchVars{Page: 1, PerPage: 20})
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled,
		"expected context.Canceled to propagate from limiter.Wait, got %v", err)
}

// ---------------------------------------------------------------------------
// parseRetryAfter — small unit table
// ---------------------------------------------------------------------------

func TestParseRetryAfter(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want time.Duration
	}{
		{"empty", "", defaultRetryAfter},
		{"valid 5s", "5", 5 * time.Second},
		{"valid 120s", "120", 120 * time.Second},
		{"zero", "0", defaultRetryAfter},
		{"negative", "-3", defaultRetryAfter},
		{"non-numeric", "Wed, 21 Oct 2015 07:28:00 GMT", defaultRetryAfter},
		{"garbage", "soon", defaultRetryAfter},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, parseRetryAfter(tc.raw))
		})
	}
}

// ---------------------------------------------------------------------------
// ErrUpstream Error() formatting
// ---------------------------------------------------------------------------

func TestErrUpstream_Error(t *testing.T) {
	t.Parallel()

	e := &ErrUpstream{Status: 502, Message: "boom"}
	assert.Equal(t, "anilist upstream: 502 boom", e.Error())

	var nilErr *ErrUpstream
	assert.Equal(t, "<nil ErrUpstream>", nilErr.Error())
}

// Compile-time guard: ensure ErrUpstream satisfies the error interface.
var _ error = (*ErrUpstream)(nil)

// Sanity: ensure fmt.Stringer-style format strings line up with what we
// document above.  Kept as a tiny example test to anchor the file.
func ExampleErrUpstream_Error() {
	e := &ErrUpstream{Status: 500, Message: "AniList API error: 500"}
	fmt.Println(e.Error())
	// Output: anilist upstream: 500 AniList API error: 500
}

// ---------------------------------------------------------------------------
// Option / defaultSleep / extra do() branches
// ---------------------------------------------------------------------------

// TestNewClient_WithHTTPClient verifies WithHTTPClient swaps the inner
// *http.Client by checking that a custom 1ns timeout actually causes a
// transport error.
func TestNewClient_WithHTTPClient(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Sleep beyond the 1ns timeout to force a transport failure.
		time.Sleep(50 * time.Millisecond)
		writeJSON(w, http.StatusOK, `{"data":{"Page":{}}}`)
	}))
	defer srv.Close()

	c := NewClient(
		WithEndpoint(srv.URL),
		WithHTTPClient(&http.Client{Timeout: 1 * time.Nanosecond}),
	)
	c.limiter = rate.NewLimiter(rate.Inf, 0)

	_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})
	require.Error(t, err, "expected transport error from 1ns timeout")
	assert.Contains(t, err.Error(), "anilist: http do",
		"expected error to be wrapped by client.do, got %v", err)
}

// TestDefaultSleep covers the production sleep hook directly so we get
// coverage on both the happy path (timer fires) and the ctx-cancellation
// path (timer aborts).
func TestDefaultSleep(t *testing.T) {
	t.Parallel()

	t.Run("zero duration returns immediately", func(t *testing.T) {
		t.Parallel()
		start := time.Now()
		require.NoError(t, defaultSleep(context.Background(), 0))
		assert.Less(t, time.Since(start), 10*time.Millisecond)
	})

	t.Run("timer fires", func(t *testing.T) {
		t.Parallel()
		start := time.Now()
		require.NoError(t, defaultSleep(context.Background(), 30*time.Millisecond))
		assert.GreaterOrEqual(t, time.Since(start), 30*time.Millisecond)
	})

	t.Run("ctx cancelled before timer", func(t *testing.T) {
		t.Parallel()
		ctx, cancel := context.WithCancel(context.Background())
		cancel() // pre-cancelled
		err := defaultSleep(ctx, 1*time.Hour)
		require.Error(t, err)
		assert.ErrorIs(t, err, context.Canceled)
	})
}

// TestClient_NullData covers the null-data branch — AniList returning
// 200 OK with explicit {"data": null, "errors": null} should surface as
// *ErrUpstream(502).  This happens in practice when AniList's GraphQL
// layer fails before constructing the response body.
func TestClient_NullData(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `{"data":null}`)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})

	require.Error(t, err)
	var upstream *ErrUpstream
	require.True(t, errors.As(err, &upstream), "expected *ErrUpstream, got %T: %v", err, err)
	assert.Equal(t, http.StatusBadGateway, upstream.Status)
	assert.Contains(t, upstream.Message, "null data")
}

// TestClient_MalformedJSON covers the json.Decoder error branch — when
// the upstream sends garbage that doesn't parse as a GraphQL envelope at
// all, the client should surface a wrapped decode error (not panic, not
// return success).
func TestClient_MalformedJSON(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `not even close to json`)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode response")
}

// TestClient_TransportError covers the c.http.Do error branch.  We point
// the client at a closed listener so the connection attempt fails at
// the transport level.
func TestClient_TransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // close before any request

	c := testClient(t, url)
	_, err := c.Search(context.Background(), SearchVars{Page: 1, PerPage: 20})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "anilist: http do")
}
