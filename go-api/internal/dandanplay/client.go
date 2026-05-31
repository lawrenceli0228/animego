// Package dandanplay — HTTP client for the dandanplay.net public API.
//
// Mirrors server/services/dandanplay.service.js:
//
//   - 800ms global rate limit via golang.org/x/time/rate (token-bucket,
//     burst=1).  Independent from Bangumi's limiter so admin enrichment
//     queues don't starve user-triggered /match calls.
//   - X-AppId / X-AppSecret header injection from env (no HMAC — the
//     dandanplay v2 API uses static credentials).
//   - 30-min comment cache + 24h episode cache via internal/cache
//     (ristretto).  Episode cache is double-keyed: "bgm:<id>" for the
//     bgmId-based fetch, "dan:<id>" for the dandanplay-animeId-based
//     fetch.  Keeps the two lookup paths from accidentally sharing
//     state (the dandanplay API returns the same shape but the lookup
//     ids do not overlap).
//   - 8-second per-request HTTP timeout.  Total /match orchestration
//     timeout (20s) is enforced at the handler layer.
//
// Public surface:
//
//	MatchCombined(ctx, fileName, fileHash, fileSize) (*MatchResult, error)
//	FetchEpisodesByBgmID(ctx, bgmID) (*EpisodeData, error)
//	FetchEpisodesByDandanAnimeID(ctx, dandanAnimeID) (*EpisodeData, error)
//	SearchAnime(ctx, keyword) ([]DandanAnime, error)
//	FetchComments(ctx, episodeID) (*CommentsResponse, error)
//
// Errors are wrapped with fmt.Errorf so callers can errors.Is/As as needed.
// Network / 5xx returns wrapped error; 4xx returns (nil, nil) for the
// "miss" semantics Express used (return null on !res.ok).

package dandanplay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"golang.org/x/time/rate"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
)

// Defaults — exposed as package vars so tests can swap them.
const (
	DefaultEndpoint = "https://api.dandanplay.net"
	httpTimeout     = 8 * time.Second
	minInterval     = 800 * time.Millisecond

	commentTTL = 30 * time.Minute
	episodeTTL = 24 * time.Hour
)

// Retry policy constants.
const (
	maxRetries  = 3 // 4 total attempts
	backoffBase = 500 * time.Millisecond
	backoffCap  = 8 * time.Second
)

// Client is the dandanplay HTTP caller.  Construct once at boot, share
// across handlers.  All methods are safe for concurrent use — the
// limiter, *http.Client, and ristretto caches are goroutine-safe.
type Client struct {
	endpoint   string
	appID      string
	appSecret  string
	http       *http.Client
	limiter    *rate.Limiter
	commentsCh *cache.Cache[CommentsResponse]
	episodesCh *cache.Cache[EpisodeData]
}

// Option configures a Client at construction.
type Option func(*Client) error

// WithEndpoint overrides the base URL.  Used by tests with httptest.
func WithEndpoint(u string) Option {
	return func(c *Client) error {
		c.endpoint = u
		return nil
	}
}

// WithHTTPClient swaps the underlying transport — useful for tests
// that want to drive deterministic timeouts.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) error {
		c.http = h
		return nil
	}
}

// WithCredentials injects the AppId / AppSecret pair.  Production
// callers read these from env (DANDANPLAY_APP_ID / DANDANPLAY_APP_SECRET).
// Empty values mean "send no auth headers" — the public-tier endpoints
// still respond, just with stricter rate limits.
func WithCredentials(appID, appSecret string) Option {
	return func(c *Client) error {
		c.appID = appID
		c.appSecret = appSecret
		return nil
	}
}

// NewClient builds a Client with the 800ms limiter, 8s HTTP timeout,
// and two ristretto caches (comment 30min / episodes 24h).  Returns
// the underlying cache.New error if either cache fails to construct.
func NewClient(opts ...Option) (*Client, error) {
	c := &Client{
		endpoint: DefaultEndpoint,
		http:     &http.Client{Timeout: httpTimeout},
		limiter:  rate.NewLimiter(rate.Every(minInterval), 1),
	}
	for _, opt := range opts {
		if err := opt(c); err != nil {
			return nil, err
		}
	}
	commentsCh, err := cache.New[CommentsResponse](cache.Config{
		NumCounters: 1e6,
		MaxCost:     1e7,
		DefaultTTL:  commentTTL,
	})
	if err != nil {
		return nil, fmt.Errorf("dandanplay: comments cache: %w", err)
	}
	c.commentsCh = commentsCh

	episodesCh, err := cache.New[EpisodeData](cache.Config{
		NumCounters: 1e6,
		MaxCost:     1e7,
		DefaultTTL:  episodeTTL,
	})
	if err != nil {
		return nil, fmt.Errorf("dandanplay: episodes cache: %w", err)
	}
	c.episodesCh = episodesCh
	return c, nil
}

// Close releases the underlying ristretto caches.  Safe to call once
// during process shutdown.
func (c *Client) Close() {
	if c.commentsCh != nil {
		c.commentsCh.Close()
	}
	if c.episodesCh != nil {
		c.episodesCh.Close()
	}
}

// MatchResult is the trimmed projection of /api/v2/match the orchestrator
// uses.  Matches the JS service.js shape exactly.
type MatchResult struct {
	IsMatched    bool   `json:"isMatched"`
	AnimeID      int64  `json:"animeId"`
	AnimeTitle   string `json:"animeTitle"`
	EpisodeID    int64  `json:"episodeId"`
	EpisodeTitle string `json:"episodeTitle"`
}

// EpisodeData is the trimmed projection of /api/v2/bangumi/* endpoints.
// `Episodes` carries the per-episode entries the build-episode-map
// helper consumes.
type EpisodeData struct {
	DandanAnimeID int64           `json:"dandanAnimeId"`
	Title         string          `json:"title"`
	ImageURL      string          `json:"imageUrl"`
	Episodes      []DandanEpisode `json:"episodes"`
}

// DandanAnime is one entry returned by /api/v2/search/anime.
type DandanAnime struct {
	DandanAnimeID int64  `json:"dandanAnimeId"`
	Title         string `json:"title"`
	Type          string `json:"type"`
	ImageURL      string `json:"imageUrl"`
	Episodes      int    `json:"episodes"`
}

// CommentsResponse is the /api/v2/comment/:id projection.  Express
// emitted { count, comments } verbatim; the Comments slice is
// json.RawMessage so the frontend can render the dandanplay-shaped
// comment objects without us re-modelling every field.
type CommentsResponse struct {
	Count    int             `json:"count"`
	Comments json.RawMessage `json:"comments"`
}

// ─── HTTP plumbing ──────────────────────────────────────────────────────────

// do is the shared call path — limiter wait + retry-with-backoff +
// header injection + JSON decode + error envelope.  Caller-supplied
// `dest` is the typed struct to decode the response body into.
// Returns (true, nil) on success, (false, nil) on non-429/non-5xx 4xx
// (mirrors JS `!res.ok` → null), (false, err) on network / 5xx /
// decode failure.
//
// Retry policy (see doWithRetry for full detail):
//   - HTTP 429 → honor Retry-After header; otherwise exponential backoff
//     with full jitter (base 500ms, cap 8s).
//   - HTTP 5xx (500/502/503/504) → same backoff schedule.
//   - Transient network errors (i/o timeout, EOF, connection reset) → same.
//   - Up to 3 retries (4 total attempts).
//   - The rate-limiter Wait is consumed on EVERY attempt, including retries.
//   - Every backoff sleep is context-cancellable.
func (c *Client) do(ctx context.Context, method, path string, body any, dest any) (bool, error) {
	// Encode the body once; each attempt re-reads from the same bytes.
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			return false, fmt.Errorf("dandanplay: encode body: %w", err)
		}
	}
	return c.doWithRetry(ctx, method, path, bodyBytes, dest)
}

// doWithRetry executes one HTTP attempt and retries on 429 / 5xx /
// transient network errors with exponential-backoff-plus-full-jitter.
// bodyBytes may be nil for GET requests.
func (c *Client) doWithRetry(ctx context.Context, method, path string, bodyBytes []byte, dest any) (bool, error) {
	for attempt := 0; ; attempt++ {
		// Check context before every attempt (including the first).
		if err := ctx.Err(); err != nil {
			return false, err
		}

		// Rate-limiter gates EVERY attempt, including retries.
		if err := c.limiter.Wait(ctx); err != nil {
			return false, fmt.Errorf("dandanplay: limiter wait: %w", err)
		}

		ok, retry, retryAfter, err := c.doOnce(ctx, method, path, bodyBytes, dest)
		if !retry {
			// Success, 4xx-miss, decode error, or non-retryable error.
			return ok, err
		}

		// retry == true: 429, 5xx, or transient network error.
		if attempt >= maxRetries {
			// Exhausted retries — surface the last error.
			return false, err
		}

		d := backoffDelay(attempt, retryAfter)
		slog.WarnContext(ctx, "dandanplay: retrying",
			"method", method, "path", path,
			"attempt", attempt+1, "backoff", d, "reason", err)

		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(d):
		}
	}
}

// doOnce performs a single HTTP round-trip without any retry logic.
// Returns:
//
//	(true,  false, 0, nil)   — 2xx success, dest decoded
//	(false, false, 0, nil)   — 4xx miss (caller treats as "not found")
//	(false, true,  d, err)   — 429 / 5xx / network error → caller should retry
//	(false, false, 0, err)   — non-retryable error (bad request, decode fail)
func (c *Client) doOnce(ctx context.Context, method, path string, bodyBytes []byte, dest any) (ok, retry bool, retryAfter time.Duration, err error) {
	var bodyReader io.Reader
	if bodyBytes != nil {
		bodyReader = bytes.NewReader(bodyBytes)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, bodyReader)
	if err != nil {
		return false, false, 0, fmt.Errorf("dandanplay: build request: %w", err)
	}
	if c.appID != "" {
		req.Header.Set("X-AppId", c.appID)
	}
	if c.appSecret != "" {
		req.Header.Set("X-AppSecret", c.appSecret)
	}
	if bodyBytes != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// Transient network errors (i/o timeout, EOF, connection reset).
		return false, true, 0, fmt.Errorf("dandanplay: HTTP %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusTooManyRequests: // 429
		d := parseRetryAfter(resp.Header.Get("Retry-After"))
		return false, true, d, fmt.Errorf("dandanplay: %s %s: HTTP 429", method, path)

	case resp.StatusCode == 500 ||
		resp.StatusCode == 502 ||
		resp.StatusCode == 503 ||
		resp.StatusCode == 504:
		return false, true, 0, fmt.Errorf("dandanplay: %s %s: HTTP %d", method, path, resp.StatusCode)

	case resp.StatusCode >= 500:
		// Other 5xx — treat as non-retryable to avoid hammering on
		// permanent server errors (e.g. 501 Not Implemented).
		return false, false, 0, fmt.Errorf("dandanplay: %s %s: HTTP %d", method, path, resp.StatusCode)

	case resp.StatusCode >= 400:
		// Express used `if (!res.ok) return null` — caller treats this
		// as a miss, not an error.  Logging stays at debug so we don't
		// spam every 404 from a stale dandanAnimeId lookup.
		slog.DebugContext(ctx, "dandanplay: non-2xx",
			"method", method, "path", path, "status", resp.StatusCode)
		return false, false, 0, nil
	}

	// 2xx — decode body into dest.
	if dest != nil {
		if err := json.NewDecoder(resp.Body).Decode(dest); err != nil {
			return false, false, 0, fmt.Errorf("dandanplay: decode %s: %w", path, err)
		}
	}
	return true, false, 0, nil
}

// backoffDelay returns the duration to sleep before attempt number
// `attempt` (0-indexed).  If retryAfter > 0 it was parsed from a
// Retry-After header and is returned directly.  Otherwise the function
// applies full-jitter exponential backoff: a random value in
// [0, min(backoffCap, backoffBase * 2^attempt)].
func backoffDelay(attempt int, retryAfter time.Duration) time.Duration {
	if retryAfter > 0 {
		return retryAfter
	}
	// Exponential cap: backoffBase << attempt, clamped to backoffCap.
	shift := attempt
	if shift > 10 {
		shift = 10 // prevent overflow on large attempt counts
	}
	ceiling := backoffBase * (1 << shift)
	if ceiling > backoffCap || ceiling <= 0 {
		ceiling = backoffCap
	}
	// Full jitter: uniform random in [0, ceiling).
	return time.Duration(rand.Int64N(int64(ceiling)))
}

// parseRetryAfter parses the Retry-After response header.  The header
// may be an integer (seconds) or an HTTP-date.  Returns 0 if the header
// is absent or unparseable.
func parseRetryAfter(header string) time.Duration {
	if header == "" {
		return 0
	}
	// Try integer seconds first.
	if secs, err := strconv.ParseFloat(header, 64); err == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	// Try HTTP-date (RFC 1123, RFC 850, ANSI C asctime).
	for _, layout := range []string{
		http.TimeFormat,                  // Mon, 02 Jan 2006 15:04:05 GMT
		"Monday, 02-Jan-06 15:04:05 MST", // RFC 850
		"Mon Jan _2 15:04:05 2006",       // ANSI C
	} {
		if t, err := time.Parse(layout, header); err == nil {
			d := time.Until(t)
			if d > 0 {
				return d
			}
			return 0
		}
	}
	return 0
}

// ─── /api/v2/match ──────────────────────────────────────────────────────────

// matchRequest is the request body for /api/v2/match.  fileHash /
// fileSize are optional — when zero / empty we omit them and let
// dandanplay fall back to filename-only matching.
type matchRequest struct {
	FileName string `json:"fileName"`
	FileHash string `json:"fileHash,omitempty"`
	FileSize int64  `json:"fileSize,omitempty"`
}

// matchEnvelope is the v2/match response shape.  Express only read
// the first match — same here.
type matchEnvelope struct {
	IsMatched bool `json:"isMatched"`
	Matches   []struct {
		AnimeID      int64  `json:"animeId"`
		AnimeTitle   string `json:"animeTitle"`
		EpisodeID    int64  `json:"episodeId"`
		EpisodeTitle string `json:"episodeTitle"`
	} `json:"matches"`
}

// MatchCombined is service.js matchCombined — POST /api/v2/match with
// fileName + optional hash/size.  Returns nil on miss / 4xx; non-nil
// MatchResult on any 2xx response with at least one match, even when
// isMatched=false (the orchestrator's loose-match accept gate decides
// whether to use it).
func (c *Client) MatchCombined(ctx context.Context, fileName, fileHash string, fileSize int64) (*MatchResult, error) {
	body := matchRequest{FileName: fileName}
	if fileHash != "" {
		body.FileHash = fileHash
	}
	if fileSize > 0 {
		body.FileSize = fileSize
	}
	var env matchEnvelope
	ok, err := c.do(ctx, http.MethodPost, "/api/v2/match", body, &env)
	if err != nil {
		return nil, err
	}
	if !ok || len(env.Matches) == 0 {
		return nil, nil
	}
	best := env.Matches[0]
	return &MatchResult{
		IsMatched:    env.IsMatched,
		AnimeID:      best.AnimeID,
		AnimeTitle:   best.AnimeTitle,
		EpisodeID:    best.EpisodeID,
		EpisodeTitle: best.EpisodeTitle,
	}, nil
}

// ─── /api/v2/bangumi/* episode lookups ──────────────────────────────────────

// bangumiEnvelope is the shared shape of /api/v2/bangumi/bgmtv/:bgmId
// and /api/v2/bangumi/:dandanAnimeId.
type bangumiEnvelope struct {
	Bangumi *struct {
		AnimeID    int64  `json:"animeId"`
		AnimeTitle string `json:"animeTitle"`
		ImageURL   string `json:"imageUrl"`
		Episodes   []struct {
			EpisodeID     int64  `json:"episodeId"`
			EpisodeTitle  string `json:"episodeTitle"`
			EpisodeNumber string `json:"episodeNumber"`
		} `json:"episodes"`
	} `json:"bangumi"`
}

// FetchEpisodesByBgmID hits /api/v2/bangumi/bgmtv/:bgmId.  bgmId is the
// bangumi.tv subject id (NOT the dandanplay anime id).
func (c *Client) FetchEpisodesByBgmID(ctx context.Context, bgmID int32) (*EpisodeData, error) {
	cacheKey := "bgm:" + strconv.FormatInt(int64(bgmID), 10)
	if hit, ok := c.episodesCh.Get(cacheKey); ok {
		return &hit, nil
	}
	path := "/api/v2/bangumi/bgmtv/" + strconv.FormatInt(int64(bgmID), 10)
	data, err := c.fetchEpisodes(ctx, path)
	if err != nil || data == nil {
		return data, err
	}
	c.episodesCh.Set(cacheKey, *data)
	return data, nil
}

// FetchEpisodesByDandanAnimeID hits /api/v2/bangumi/:dandanAnimeId.
// Used as the Phase 1 follow-up after a successful /match.
func (c *Client) FetchEpisodesByDandanAnimeID(ctx context.Context, animeID int64) (*EpisodeData, error) {
	cacheKey := "dan:" + strconv.FormatInt(animeID, 10)
	if hit, ok := c.episodesCh.Get(cacheKey); ok {
		return &hit, nil
	}
	path := "/api/v2/bangumi/" + strconv.FormatInt(animeID, 10)
	data, err := c.fetchEpisodes(ctx, path)
	if err != nil || data == nil {
		return data, err
	}
	c.episodesCh.Set(cacheKey, *data)
	return data, nil
}

// fetchEpisodes shares the wire decode + normalisation between the two
// public episode-lookup entry points.  Returns nil on bangumi=null in
// the JSON envelope (matches Express's `if (!data.bangumi) return null`).
func (c *Client) fetchEpisodes(ctx context.Context, path string) (*EpisodeData, error) {
	var env bangumiEnvelope
	ok, err := c.do(ctx, http.MethodGet, path, nil, &env)
	if err != nil {
		return nil, err
	}
	if !ok || env.Bangumi == nil {
		return nil, nil
	}
	out := &EpisodeData{
		DandanAnimeID: env.Bangumi.AnimeID,
		Title:         env.Bangumi.AnimeTitle,
		ImageURL:      env.Bangumi.ImageURL,
		Episodes:      make([]DandanEpisode, 0, len(env.Bangumi.Episodes)),
	}
	for _, e := range env.Bangumi.Episodes {
		ep := DandanEpisode{
			DandanEpisodeID:  e.EpisodeID,
			Title:            e.EpisodeTitle,
			RawEpisodeNumber: e.EpisodeNumber,
		}
		// Number = parseEpField || extractEpisodeNumber(title).
		if n, ok := ParseEpField(e.EpisodeNumber); ok {
			ep.Number = &n
		} else if n, ok := ExtractEpisodeNumber(e.EpisodeTitle); ok {
			ep.Number = &n
		}
		out.Episodes = append(out.Episodes, ep)
	}
	return out, nil
}

// ─── /api/v2/search/anime ───────────────────────────────────────────────────

type searchEnvelope struct {
	Animes []struct {
		AnimeID      int64  `json:"animeId"`
		AnimeTitle   string `json:"animeTitle"`
		Type         string `json:"type"`
		ImageURL     string `json:"imageUrl"`
		EpisodeCount int    `json:"episodeCount"`
	} `json:"animes"`
}

// SearchAnime hits /api/v2/search/anime?keyword=...  Keyword is sliced
// to 100 chars (matches Express's `.slice(0, 100)`).  Empty keyword
// returns an empty slice without hitting the network.
func (c *Client) SearchAnime(ctx context.Context, keyword string) ([]DandanAnime, error) {
	keyword = trimMaxRunes(keyword, 100)
	if keyword == "" {
		return []DandanAnime{}, nil
	}
	path := "/api/v2/search/anime?keyword=" + url.QueryEscape(keyword)
	var env searchEnvelope
	ok, err := c.do(ctx, http.MethodGet, path, nil, &env)
	if err != nil {
		return nil, err
	}
	if !ok {
		return []DandanAnime{}, nil
	}
	out := make([]DandanAnime, 0, len(env.Animes))
	for _, a := range env.Animes {
		out = append(out, DandanAnime{
			DandanAnimeID: a.AnimeID,
			Title:         a.AnimeTitle,
			Type:          a.Type,
			ImageURL:      a.ImageURL,
			Episodes:      a.EpisodeCount,
		})
	}
	return out, nil
}

// ─── /api/v2/comment/:episodeId ─────────────────────────────────────────────

type commentsEnvelope struct {
	Count    int             `json:"count"`
	Comments json.RawMessage `json:"comments"`
}

// FetchComments hits /api/v2/comment/:episodeId?withRelated=true&chConvert=1.
// On 4xx returns the zero-value { Count: 0, Comments: [] } per Express
// (`if (!res.ok) return { count: 0, comments: [] }`).
func (c *Client) FetchComments(ctx context.Context, episodeID int64) (*CommentsResponse, error) {
	cacheKey := strconv.FormatInt(episodeID, 10)
	if hit, ok := c.commentsCh.Get(cacheKey); ok {
		return &hit, nil
	}
	path := "/api/v2/comment/" + cacheKey + "?withRelated=true&chConvert=1"
	var env commentsEnvelope
	ok, err := c.do(ctx, http.MethodGet, path, nil, &env)
	if err != nil {
		return nil, err
	}
	if !ok {
		// Empty-comments fallback — match Express exactly.
		out := CommentsResponse{Count: 0, Comments: json.RawMessage(`[]`)}
		c.commentsCh.Set(cacheKey, out)
		return &out, nil
	}
	// Defensive: dandanplay sometimes returns comments=null on episodes
	// with zero comments.  Render as [] for the frontend.
	if len(env.Comments) == 0 || string(env.Comments) == "null" {
		env.Comments = json.RawMessage(`[]`)
	}
	out := CommentsResponse{Count: env.Count, Comments: env.Comments}
	c.commentsCh.Set(cacheKey, out)
	return &out, nil
}

// ─── helpers ────────────────────────────────────────────────────────────────

// trimMaxRunes returns the first n runes of s, exactly the way JS
// `.slice(0, n)` operates on UTF-16 code units — except this counts
// runes, which is safer for users typing CJK / emoji search terms.
func trimMaxRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}
