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
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/time/rate"
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

// ─── MatchCombined's cache ──────────────────────────────────────────────────
//
// This method used to be the only caller-facing one with no cache, and
// it is the one the import path calls once per cluster (plus once per
// unmapped episode) — so it was also the one holding the process-wide
// 800ms bucket that every user of the process shares.
//
// The two properties worth pinning hardest are not "does a hit get
// reused":
//
//  1. A MISS MUST BE CACHED TOO. The browser re-asks the identical
//     question on every library mount, every tab-return and every
//     rescan — its own cache stores the negative and then refuses to
//     honour it — so an uncacheable miss is a permanent tax, paid at
//     800ms a piece, by every user at once.
//  2. AN ERROR MUST NOT BE. A cached failure turns a transient outage
//     into a ten-minute one that no reader can clear.

const matchHitBody = `{"isMatched":true,"matches":[{"animeId":42,"animeTitle":"Foo","episodeId":7,"episodeTitle":"Ep 1"}]}`

// serveMatch is the happy-path handler; tests that only care about call
// counts do not need to vary the payload.
func serveMatch(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(matchHitBody))
}

func TestMatchCombined_CacheHit(t *testing.T) {
	c, calls := newTestClient(t, serveMatch)

	first, err := c.MatchCombined(context.Background(), "foo.mkv", "deadbeef", 12345)
	if err != nil || first == nil {
		t.Fatalf("first: err=%v result=%v", err, first)
	}
	c.matchCh.Wait()

	second, err := c.MatchCombined(context.Background(), "foo.mkv", "deadbeef", 12345)
	if err != nil || second == nil {
		t.Fatalf("second: err=%v result=%v", err, second)
	}
	if calls.Load() != 1 {
		t.Errorf("HTTP call count = %d, want 1 (second call should hit cache)", calls.Load())
	}
	if *second != *first {
		t.Errorf("cached value = %+v, want %+v", *second, *first)
	}
	// A caller must not be able to corrupt the cached entry through the
	// pointer it was handed.
	//
	// This passes today for a structural reason rather than for
	// anything MatchCombined does: cache.Get returns matchCacheEntry by
	// value, so every caller already gets its own copy. It is here as a
	// tripwire for the change that would end that quietly — storing
	// *matchCacheEntry, or handing out a pointer captured before the
	// copy. It does not discriminate today's line, and it is not
	// supposed to.
	first.AnimeTitle = "clobbered"
	third, err := c.MatchCombined(context.Background(), "foo.mkv", "deadbeef", 12345)
	if err != nil || third == nil || third.AnimeTitle != "Foo" {
		t.Errorf("after mutating an earlier result, cache returned %+v", third)
	}
}

func TestMatchCombined_MissIsCachedToo(t *testing.T) {
	// 2xx with an empty matches array — dandanplay answering "I do not
	// know this file", which is the answer for every not-yet-indexed
	// new-season release.
	c, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"isMatched":false,"matches":[]}`))
	})

	got, err := c.MatchCombined(context.Background(), "unknown.mkv", "beef", 99)
	if err != nil || got != nil {
		t.Fatalf("first: err=%v result=%+v, want (nil, nil)", err, got)
	}
	c.matchCh.Wait()

	got, err = c.MatchCombined(context.Background(), "unknown.mkv", "beef", 99)
	if err != nil || got != nil {
		t.Fatalf("second: err=%v result=%+v, want (nil, nil)", err, got)
	}
	if calls.Load() != 1 {
		t.Errorf("HTTP call count = %d, want 1 — a miss must be cached, not just a hit", calls.Load())
	}
}

func TestMatchCombined_4xxMissIsCachedToo(t *testing.T) {
	// The other half of the same branch: `do` reports 4xx as (false,
	// nil), so this arrives as `!ok` rather than as an empty slice.
	c, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})

	if _, err := c.MatchCombined(context.Background(), "bad.mkv", "", 0); err != nil {
		t.Fatalf("4xx should be a miss, not an error: %v", err)
	}
	c.matchCh.Wait()
	if _, err := c.MatchCombined(context.Background(), "bad.mkv", "", 0); err != nil {
		t.Fatalf("second: %v", err)
	}
	if calls.Load() != 1 {
		t.Errorf("HTTP call count = %d, want 1", calls.Load())
	}
}

func TestMatchCombined_UpstreamErrorIsNotCached(t *testing.T) {
	var failing atomic.Bool
	failing.Store(true)
	c, calls := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		if failing.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		serveMatch(w, nil)
	})

	// A deadline, not a cancel: the upstream must actually be REACHED
	// and must actually fail. Pre-empting the request before it leaves
	// would prove nothing about what happens to a real 5xx. The
	// deadline just cuts the 4-attempt backoff chain short so this
	// costs milliseconds instead of seconds.
	//
	// This one keeps the production limiter, unlike the key tests
	// below: what the deadline lands in the middle of is the point, and
	// a 1ms limiter would let all four attempts finish first and turn
	// this into a plain retry-exhaustion test.
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if _, err := c.MatchCombined(ctx, "flaky.mkv", "cafe", 5); err == nil {
		t.Fatal("a 5xx that outlives its context should surface an error")
	}
	reached := calls.Load()
	if reached == 0 {
		t.Fatal("the upstream was never called, so this did not test a 5xx at all")
	}
	c.matchCh.Wait()

	failing.Store(false)
	got, err := c.MatchCombined(context.Background(), "flaky.mkv", "cafe", 5)
	if err != nil {
		t.Fatalf("after recovery: %v", err)
	}
	if got == nil {
		t.Fatal("the failure was cached as a miss — a transient outage would " +
			"become a ten-minute one no reader could clear")
	}
	if calls.Load() <= reached {
		t.Error("the retry never reached the network; the error was served from cache")
	}
}

func TestMatchCombined_KeyMirrorsTheRequestBodyNotTheArguments(t *testing.T) {
	// MatchCombined drops fileSize from the wire body when it is not
	// positive, so 0 and -1 are the SAME upstream question and must not
	// occupy two entries. This is not hypothetical: the library import
	// sends `rep.file?.size ?? 0` and the player sends
	// `f._fileRef?.size ?? 0`.
	c, calls := newTestClient(t, serveMatch)
	// Every call below is a deliberate cache MISS, so each one really
	// goes upstream. The production limiter would add 800ms apiece and
	// prove nothing — same swap the retry tests make.
	c.limiter = newFastLimiter()

	if _, err := c.MatchCombined(context.Background(), "a.mkv", "h", 0); err != nil {
		t.Fatal(err)
	}
	c.matchCh.Wait()
	if _, err := c.MatchCombined(context.Background(), "a.mkv", "h", -1); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Errorf("call count = %d, want 1 — size 0 and -1 both omit the field", calls.Load())
	}

	// A real size IS a different question, though: dandanplay uses it,
	// and folding it in with the sizeless form would serve one answer
	// for both.
	if _, err := c.MatchCombined(context.Background(), "a.mkv", "h", 4096); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Errorf("call count = %d, want 2 — a real size is part of the key", calls.Load())
	}

	// So is the filename. dandanplay parses it when the hash is not in
	// its index, which is exactly the case Phase 1's loose-match gate
	// exists to salvage.
	c.matchCh.Wait()
	if _, err := c.MatchCombined(context.Background(), "b.mkv", "h", 4096); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 {
		t.Errorf("call count = %d, want 3 — the filename is part of the key", calls.Load())
	}
}

func TestMatchCombined_KeyCannotBeForgedThroughFileHash(t *testing.T) {
	// `/match` decodes its body straight off the wire, so nothing makes
	// fileHash the 32 hex characters it is supposed to be. Under a plain
	// join these two would produce the identical key "a:1:b:2:c", and
	// whoever asked first would answer for the other.
	c, calls := newTestClient(t, serveMatch)
	c.limiter = newFastLimiter()

	if _, err := c.MatchCombined(context.Background(), "b:2:c", "a", 1); err != nil {
		t.Fatal(err)
	}
	c.matchCh.Wait()
	if _, err := c.MatchCombined(context.Background(), "c", "a:1:b", 2); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Errorf("call count = %d, want 2 — a crafted fileHash forged another entry's key", calls.Load())
	}
}

func TestMatchCache_IsSizedInEntriesNotBytes(t *testing.T) {
	// MaxCost only means "entry cap" because this cache is built with
	// IgnoreInternalCost. Without it ristretto charges 56 bytes of its
	// own per-entry overhead on top of our cost=1, and the cache
	// silently holds ~3.5k entries instead of the 2e5 its sizing
	// comment claims — SetWithTTL returns true, Wait returns, Get
	// misses, and nothing anywhere says so. The only symptom would be
	// files going back to the network that should have been cached,
	// which is the entire thing this cache exists to stop.
	//
	// Written straight into the cache rather than driven through
	// MatchCombined on purpose: what is under test is the admission
	// policy, and twenty thousand HTTP round-trips would only make it
	// slower to observe the same thing.
	c, _ := newTestClient(t, serveMatch)

	const n = 20_000 // a tenth of the cap, and ~6x what an unflagged cache holds
	for i := 0; i < n; i++ {
		c.matchCh.SetWithTTL(strconv.Itoa(i), matchCacheEntry{found: true}, time.Minute)
	}
	c.matchCh.Wait()

	present := 0
	for i := 0; i < n; i++ {
		if _, ok := c.matchCh.Get(strconv.Itoa(i)); ok {
			present++
		}
	}
	if present < n*9/10 {
		t.Errorf("only %d/%d entries survived admission — the match cache is not "+
			"sized in entries; check IgnoreInternalCost at its cache.New call", present, n)
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

// ─── Retry-with-backoff tests ───────────────────────────────────────────────

// TestRetry_429ThenSuccess verifies that the client retries on HTTP 429 and
// ultimately returns the successful response on the third attempt.
func TestRetry_429ThenSuccess(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n <= 2 {
			// First two requests: 429 with no Retry-After (forces jitter backoff).
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		// Third request: success.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"animes":[{"animeId":7,"animeTitle":"Retry Show","type":"tv","imageUrl":"","episodeCount":1}]}`))
	}))
	t.Cleanup(srv.Close)

	c, err := NewClient(
		WithEndpoint(srv.URL),
		// Use a very fast rate limiter so the test does not take 800ms × 3.
		WithHTTPClient(&http.Client{Timeout: 5 * time.Second}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	// Override the limiter to burst=3 so the rate limit doesn't dominate timing.
	c.limiter = newFastLimiter()
	t.Cleanup(c.Close)

	got, err := c.SearchAnime(context.Background(), "retry")
	if err != nil {
		t.Fatalf("SearchAnime returned error: %v", err)
	}
	if len(got) != 1 || got[0].DandanAnimeID != 7 {
		t.Fatalf("SearchAnime result = %+v, want [{DandanAnimeID:7}]", got)
	}
	if n := calls.Load(); n != 3 {
		t.Errorf("server saw %d calls, want 3 (2 × 429 + 1 success)", n)
	}
}

// TestRetry_ContextCancellation verifies that a cancelled context causes
// the retry loop to abort promptly instead of sleeping through the backoff.
func TestRetry_ContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Always return 429 so the client would keep retrying.
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	t.Cleanup(srv.Close)

	c, err := NewClient(
		WithEndpoint(srv.URL),
		WithHTTPClient(&http.Client{Timeout: 5 * time.Second}),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.limiter = newFastLimiter()
	t.Cleanup(c.Close)

	// Cancel the context immediately after the first request completes.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err = c.SearchAnime(ctx, "cancel")
	elapsed := time.Since(start)

	// Must finish well within the full backoffCap (8s) — the context
	// deadline of 200ms should be what stops it.
	if elapsed > 2*time.Second {
		t.Errorf("call took %v; context cancellation did not abort the backoff sleep", elapsed)
	}
	if err == nil {
		t.Error("expected a non-nil error after context cancellation")
	}
}

// newFastLimiter returns a rate.Limiter with a 1ms interval and burst=10
// so retry tests are not bottlenecked by the 800ms production limiter.
func newFastLimiter() *rate.Limiter {
	return rate.NewLimiter(rate.Every(time.Millisecond), 10)
}

// silence the unused import warning when json is only referenced via
// json.RawMessage in TestFetchComments_NullCommentsBecomesArray
var _ = json.RawMessage{}

// TestFetchEpisodesParsesCrossLinkIDs pins the parse of the two id
// cross-links dandanplay ships in the bangumi detail payload.  These
// give /match an EXACT anime_cache lookup, replacing a title search
// that could not tell 無職転生Ⅱ from 無職転生Ⅲ.
//
// The payload below is the real shape of
// GET /api/v2/bangumi/18727 (無職転生Ⅲ), trimmed to the parsed fields.
func TestFetchEpisodesParsesCrossLinkIDs(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"bangumi":{
			"animeId":18727,
			"bangumiId":"18727",
			"animeTitle":"无职转生Ⅲ ～到了异世界就拿出真本事～",
			"imageUrl":"x.jpg",
			"bangumiUrl":"https://bangumi.tv/subject/501963",
			"onlineDatabases":[
				{"name":"Bangumi.tv","url":"https://bangumi.tv/subject/501963"},
				{"name":"MyAnimeList","url":"https://myanimelist.net/anime/59193"},
				{"name":"AniDB","url":"https://anidb.net/anime/18727"},
				{"name":"AniList","url":"https://anilist.co/anime/178789"}
			],
			"episodes":[{"episodeId":1,"episodeTitle":"E1","episodeNumber":"1"}]}}`))
	})

	got, err := c.FetchEpisodesByDandanAnimeID(context.Background(), 18727)
	if err != nil || got == nil {
		t.Fatalf("fetch: err=%v got=%v", err, got)
	}
	if got.AniListID != 178789 {
		t.Errorf("AniListID = %d, want 178789", got.AniListID)
	}
	if got.BgmID != 501963 {
		t.Errorf("BgmID = %d, want 501963", got.BgmID)
	}
	// `bangumiId` repeats dandanplay's own animeId as a string — it is
	// NOT the bgm.tv subject and must never be mistaken for one.
	if got.BgmID == int32(got.DandanAnimeID) {
		t.Errorf("BgmID must not be dandanplay's animeId (%d)", got.DandanAnimeID)
	}
}

// TestFetchEpisodesToleratesMissingCrossLinks — older or brand-new
// entries publish no cross-links.  Both ids stay 0 and /match falls
// through to the fuzzy leg rather than looking up anilist_id 0.
func TestFetchEpisodesToleratesMissingCrossLinks(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"bangumi":{"animeId":9,"animeTitle":"S","imageUrl":"","bangumiUrl":"","onlineDatabases":[{"name":"MyAnimeList","url":"https://myanimelist.net/anime/1"}],"episodes":[]}}`))
	})

	got, err := c.FetchEpisodesByDandanAnimeID(context.Background(), 9)
	if err != nil || got == nil {
		t.Fatalf("fetch: err=%v got=%v", err, got)
	}
	if got.AniListID != 0 || got.BgmID != 0 {
		t.Errorf("AniListID=%d BgmID=%d, want 0/0", got.AniListID, got.BgmID)
	}
}
