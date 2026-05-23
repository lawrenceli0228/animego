package dandanplay

// client_test.go — HTTP-level coverage for the dandanplay client.
// Uses httptest.NewServer so no real network calls.  Each test
// exercises one of the four public methods + verifies header injection,
// rate-limit serialisation, cache hit, and the 4xx → null fallback.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// newTestClient builds a Client pointed at a fake server with cached
// envelopes ready to go.  Returns the client + the call-count atomic
// so tests can assert cache hits.
func newTestClient(t *testing.T, handler http.HandlerFunc) (*Client, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	c, err := NewClient(
		WithEndpoint(srv.URL),
		WithCredentials("app-id", "app-secret"),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(c.Close)
	return c, &calls
}

func TestMatchCombined_Happy(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-AppId"); got != "app-id" {
			t.Errorf("X-AppId = %q, want app-id", got)
		}
		if got := r.Header.Get("X-AppSecret"); got != "app-secret" {
			t.Errorf("X-AppSecret = %q, want app-secret", got)
		}
		if r.URL.Path != "/api/v2/match" || r.Method != http.MethodPost {
			t.Errorf("path/method = %s %s, want POST /api/v2/match", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"isMatched":true,"matches":[{"animeId":42,"animeTitle":"Foo","episodeId":7,"episodeTitle":"Ep 1"}]}`))
	})

	got, err := c.MatchCombined(context.Background(), "foo.mkv", "deadbeef", 12345)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got == nil || got.AnimeID != 42 || got.EpisodeID != 7 || !got.IsMatched {
		t.Fatalf("got = %+v, want IsMatched=true AnimeID=42 EpisodeID=7", got)
	}
}

func TestMatchCombined_NoMatchReturnsNil(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"isMatched":false,"matches":[]}`))
	})
	got, err := c.MatchCombined(context.Background(), "foo.mkv", "", 0)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != nil {
		t.Fatalf("got = %+v, want nil for empty matches", got)
	}
}

func TestMatchCombined_4xxIsMiss(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	got, err := c.MatchCombined(context.Background(), "x.mkv", "", 0)
	if err != nil {
		t.Fatalf("4xx should be miss, not error; got err=%v", err)
	}
	if got != nil {
		t.Fatalf("got = %+v, want nil for 4xx", got)
	}
}

func TestFetchEpisodesByBgmID_CacheHit(t *testing.T) {
	c, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"bangumi":{"animeId":111,"animeTitle":"Show","imageUrl":"x.jpg","episodes":[{"episodeId":1,"episodeTitle":"E1","episodeNumber":"1"},{"episodeId":2,"episodeTitle":"E2","episodeNumber":"2"}]}}`))
	})

	first, err := c.FetchEpisodesByBgmID(context.Background(), 12345)
	if err != nil || first == nil {
		t.Fatalf("first fetch: err=%v first=%v", err, first)
	}
	// Wait for ristretto Set to become visible.
	c.episodesCh.Wait()

	second, err := c.FetchEpisodesByBgmID(context.Background(), 12345)
	if err != nil || second == nil {
		t.Fatalf("second fetch: err=%v second=%v", err, second)
	}
	if calls.Load() != 1 {
		t.Errorf("HTTP call count = %d, want 1 (second call should hit cache)", calls.Load())
	}
	if len(second.Episodes) != 2 || second.Episodes[0].Number == nil || *second.Episodes[0].Number != 1 {
		t.Errorf("episodes parse: %+v", second.Episodes)
	}
}

func TestFetchEpisodesByDandanAnimeID_DistinctCacheKey(t *testing.T) {
	// The two episode-lookup methods share a Cache but use different
	// key prefixes ("bgm:" vs "dan:").  A bgm fetch must NOT serve a
	// later dandanplay-animeId fetch from cache.
	c, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"bangumi":{"animeId":555,"animeTitle":"S","imageUrl":"","episodes":[]}}`))
	})
	if _, err := c.FetchEpisodesByBgmID(context.Background(), 555); err != nil {
		t.Fatal(err)
	}
	c.episodesCh.Wait()
	if _, err := c.FetchEpisodesByDandanAnimeID(context.Background(), 555); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Errorf("HTTP call count = %d, want 2 (different cache keys)", calls.Load())
	}
}

func TestSearchAnime_EmptyKeywordNoCall(t *testing.T) {
	c, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("HTTP must not be called for empty keyword")
		w.WriteHeader(http.StatusOK)
	})
	out, err := c.SearchAnime(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 {
		t.Errorf("got %d results, want 0 for empty keyword", len(out))
	}
	if calls.Load() != 0 {
		t.Errorf("HTTP calls = %d, want 0", calls.Load())
	}
}

func TestSearchAnime_Happy(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.RawQuery, "keyword=") {
			t.Errorf("missing keyword query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"animes":[{"animeId":1,"animeTitle":"A","type":"tv","imageUrl":"i","episodeCount":12}]}`))
	})
	out, err := c.SearchAnime(context.Background(), "kaguya")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].DandanAnimeID != 1 || out[0].Episodes != 12 {
		t.Fatalf("results = %+v", out)
	}
}

func TestFetchComments_4xxReturnsEmpty(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	got, err := c.FetchComments(context.Background(), 999)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Count != 0 || string(got.Comments) != `[]` {
		t.Fatalf("got = %+v, want zero-comments shape", got)
	}
}

func TestFetchComments_NullCommentsBecomesArray(t *testing.T) {
	// dandanplay sometimes returns comments=null on empty episodes —
	// normalise to [] so the frontend doesn't crash on .map().
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"count":0,"comments":null}`))
	})
	got, err := c.FetchComments(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Comments) != `[]` {
		t.Errorf("got Comments = %s, want []", got.Comments)
	}
}

func TestRateLimiter_SerialisesRequests(t *testing.T) {
	// 800ms interval ⇒ two concurrent calls take ≥800ms.  Use a 200ms
	// floor for the test to avoid flakiness on slow CI; just need to
	// prove the limiter actually gates back-to-back calls.
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"animes":[]}`))
	})
	start := time.Now()
	_, _ = c.SearchAnime(context.Background(), "a")
	_, _ = c.SearchAnime(context.Background(), "b")
	elapsed := time.Since(start)
	if elapsed < 500*time.Millisecond {
		t.Errorf("two calls took %v; expected ≥500ms (limiter active)", elapsed)
	}
}

// silence the unused import warning when json is only referenced via
// json.RawMessage in TestFetchComments_NullCommentsBecomesArray
var _ = json.RawMessage{}
