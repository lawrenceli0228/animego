// Package bangumi — HTTP client for api.bgm.tv.  Provides typed response
// structs for the 4 endpoints the Express enrichment workers use:
// search by title, subject detail (v0), characters (v0), and episodes (v1).
//
// This client is the Go port of server/services/bangumi.service.js's four
// fetch helpers (fetchBangumiData, fetchBangumiSubject, fetchBangumiCharacters,
// fetchBangumiEpisodes), backed by server/utils/rateLimitedFetch.js's 800ms
// throttle.  It preserves byte-exact wire behaviour so production Bangumi
// traffic stays inside the same per-IP budget and rate-limit allowlists
// keyed on the User-Agent string:
//
//   - One in-flight request per 800ms (≈75 req/min) via a token-bucket
//     rate limiter.  This replaces the JS createRateLimitedFetch(800)
//     lastCallAt trick.  Throttle is per-Client and shared across all
//     four endpoint methods, exactly like the Express single closure.
//   - User-Agent header is "AnimGo/1.0 (https://github.com/animego)".
//     The "AnimGo" typo (vs "AnimeGo") is intentional and preserved —
//     Bangumi may have rate-limit allowlists keyed on this exact UA.
//   - HTTP 404 maps to ErrNotFound for all four endpoints.  Search 404s
//     when the keyword has zero results; Subject/Characters/Episodes 404
//     for unknown bgmId.  Callers use errors.Is(err, ErrNotFound) to
//     distinguish "no upstream record" from transport failure.
//   - Other non-2xx responses are wrapped in *ErrUpstream with the
//     original status, so callers (workers / handlers) can map them to
//     a 502 envelope while preserving the upstream code for logs.
//
// Throttling: a 800ms token-bucket rate limiter shared across all calls
// from one Client instance, matching the JS createRateLimitedFetch(800).
// Each call accepts a context.Context for cancellation/timeout.
//
// SCOPE: this package is the HTTP layer only — the 3-phase enrichment
// queue logic (Map-based queue, processQueue loop, retry-on-failure)
// lives elsewhere in internal/queue/ workers.  Do not add queue state
// here.
package bangumi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/time/rate"
)

// ---------------------------------------------------------------------------
// Public constants & sentinel errors
// ---------------------------------------------------------------------------

// DefaultEndpoint is the production Bangumi API base.  Override with
// WithEndpoint(...) in tests (httptest.NewServer) or staging.
const DefaultEndpoint = "https://api.bgm.tv"

// DefaultUA is the User-Agent sent on every request.  The "AnimGo" typo
// (vs "AnimeGo") is intentional and preserved byte-exact from the
// Express service — Bangumi may have rate-limit allowlists keyed on this
// exact string.
const DefaultUA = "AnimGo/1.0 (https://github.com/animego)"

// minInterval is the per-request gap the Express service enforces.
// 800ms ≈ 75 req/min, matching createRateLimitedFetch(800) exactly.
const minInterval = 800 * time.Millisecond

// httpTimeout is the per-request HTTP client timeout.  Long enough to
// survive Bangumi's worst observed latency without hanging callers
// forever.  Override with WithHTTPClient(...) to tune.
const httpTimeout = 8 * time.Second

// ErrNotFound is returned when Bangumi responds with 404.  For Search
// this means "no results"; for Subject/Characters/Episodes it means
// "unknown bgmId".  Callers use errors.Is(err, ErrNotFound) to branch
// on "no upstream record" vs "transport failure".
var ErrNotFound = errors.New("bangumi: not found")

// ErrUpstream wraps a non-2xx response (other than 404).  Callers in
// the handler / worker layer can map this to a 502 envelope using the
// embedded Message.  Status preserves the original HTTP code for
// observability (logs / traces).
type ErrUpstream struct {
	Status  int
	Message string
}

// Error formats as "bangumi: <message> (<status>)" so structured logs
// can grep on the prefix.
func (e *ErrUpstream) Error() string {
	if e == nil {
		return "<nil ErrUpstream>"
	}
	return fmt.Sprintf("bangumi: %s (%d)", e.Message, e.Status)
}

// ---------------------------------------------------------------------------
// Client + functional options
// ---------------------------------------------------------------------------

// Client is the Bangumi HTTP caller.  It wraps a *http.Client with a
// 800ms token-bucket throttle and the canonical User-Agent header.  The
// limiter has burst=1 (a single token, refilled every 800ms) which
// matches Express's "one request per 800ms, no burst" semantics —
// multiple concurrent callers serialise through the limiter exactly the
// way JS serialised through lastCallAt.
//
// Clients are safe for concurrent use.  All four endpoint methods reuse
// the same limiter and *http.Client.
type Client struct {
	endpoint string
	ua       string
	http     *http.Client
	limiter  *rate.Limiter
}

// Option mutates a Client during construction.  See NewClient.
type Option func(*Client)

// WithEndpoint overrides the Bangumi base URL.  Used by tests
// (httptest.NewServer) and staging deploys.
func WithEndpoint(u string) Option {
	return func(c *Client) {
		c.endpoint = u
	}
}

// WithHTTPClient swaps the underlying *http.Client — useful for
// injecting a transport with custom timeouts, instrumentation, or
// recording in tests.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) {
		c.http = h
	}
}

// WithUserAgent overrides the User-Agent header.  Production callers
// should NOT use this — DefaultUA (with the "AnimGo" typo) is required
// for Bangumi rate-limit allowlists.  Provided for tests that want to
// assert UA propagation explicitly.
func WithUserAgent(ua string) Option {
	return func(c *Client) {
		c.ua = ua
	}
}

// NewClient constructs a Client with the 800ms token-bucket limiter,
// the canonical DefaultUA, and an 8-second HTTP timeout by default.
// Pass WithEndpoint to override the Bangumi URL (tests) and
// WithHTTPClient to swap timeout / transport.
func NewClient(opts ...Option) *Client {
	c := &Client{
		endpoint: DefaultEndpoint,
		ua:       DefaultUA,
		http:     &http.Client{Timeout: httpTimeout},
		limiter:  rate.NewLimiter(rate.Every(minInterval), 1),
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// ---------------------------------------------------------------------------
// Response types — trimmed to fields the enrichment workers consume.
// ---------------------------------------------------------------------------

// SearchResult is one entry in the {list} array returned by
// /search/subject.  Fields trimmed to what the enrichment workers
// consume — id + name + name_cn.  Other fields exist on the wire (type,
// images, summary, etc.) but workers ignore them, so we don't map them
// here.
type SearchResult struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`    // native title (the Bangumi-side spelling)
	NameCN string `json:"name_cn"` // Chinese title, empty when missing
}

// SearchResponse wraps the {list} envelope returned by /search/subject.
type SearchResponse struct {
	List []SearchResult `json:"list"`
}

// Subject is the /v0/subjects/{id} payload (used by Phase 2 + V3 of the
// enrichment pipeline).  Trimmed to fields the workers actually consume
// — score / vote count (Rating), Chinese title (NameCN), and cover art.
type Subject struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	NameCN  string `json:"name_cn"`
	Type    int    `json:"type"`
	Date    string `json:"date"`
	Eps     int    `json:"eps"`
	Summary string `json:"summary"`
	Images  *struct {
		Common string `json:"common"`
		Large  string `json:"large"`
	} `json:"images,omitempty"`
	Rating *struct {
		Score float64 `json:"score"`
		Count int     `json:"total"`
	} `json:"rating,omitempty"`
	Tags []struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	} `json:"tags,omitempty"`
}

// Character — one entry in /v0/subjects/{id}/characters.  Workers use
// Name (Chinese name on Bangumi-side), Relation (1=主角, 2=配角,
// 3=客串 — used for sort priority), and Actors[0].Name (voice actor CN).
type Character struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	NameCN   string `json:"name_cn"`
	Relation string `json:"relation"`
	Type     int    `json:"type"`
	Images   *struct {
		Medium string `json:"medium"`
	} `json:"images,omitempty"`
	Actors []struct {
		ID     int    `json:"id"`
		Name   string `json:"name"`
		NameCN string `json:"name_cn"`
	} `json:"actors,omitempty"`
}

// Episode — one entry in /subject/{id}/ep response.  Note this endpoint
// is the OLD v1 API — wraps in {eps: [...]}.  The Express comment in
// bangumi.service.js notes: "Uses old subject API (more reliable than
// v0/episodes) — normalises sort offset for sequels".
type Episode struct {
	ID     int     `json:"id"`
	Sort   float64 `json:"sort"`   // episode number within type (may be non-integer for specials)
	Type   int     `json:"type"`   // 0=正篇, 1=SP, ...
	Name   string  `json:"name"`
	NameCN string  `json:"name_cn"`
	Status string  `json:"status"` // e.g. "Air"
}

// EpisodesResponse wraps /subject/{id}/ep, which uses {eps: [...]}.
type EpisodesResponse struct {
	Eps []Episode `json:"eps"`
}

// ---------------------------------------------------------------------------
// Public endpoint methods
// ---------------------------------------------------------------------------

// Search hits GET /search/subject/<keyword>?type=2&responseGroup=small&max_results=5.
// keyword is URL-path-encoded with url.PathEscape (NOT QueryEscape — it
// lives in the path segment, not a query value).
//
// Behaviour:
//   - 404 (no results) → returns ErrNotFound (NOT an empty list).  The
//     Express service treats !res.ok as "return null" — we map that to
//     a typed sentinel here so callers can distinguish "no results"
//     from "transport failure".
//   - 200 with empty list → returns &SearchResponse{List: nil}, no error.
//   - Other non-2xx → *ErrUpstream{Status: <original>, Message: "Bangumi API error"}.
//
// The keyword argument is URL-path-encoded — pass it raw (e.g.
// "進撃の巨人") and the method handles encoding.
func (c *Client) Search(ctx context.Context, keyword string) (*SearchResponse, error) {
	// /search/subject/<keyword>?type=2&responseGroup=small&max_results=5
	// keyword lives in the PATH segment, so PathEscape (not QueryEscape).
	path := "/search/subject/" + url.PathEscape(keyword)
	query := "?type=2&responseGroup=small&max_results=5"

	var dest SearchResponse
	if err := c.get(ctx, path+query, &dest); err != nil {
		return nil, err
	}
	return &dest, nil
}

// Subject hits GET /v0/subjects/{bgmId}.  Returns ErrNotFound for
// unknown bgmId.
func (c *Client) Subject(ctx context.Context, bgmID int) (*Subject, error) {
	path := fmt.Sprintf("/v0/subjects/%d", bgmID)
	var dest Subject
	if err := c.get(ctx, path, &dest); err != nil {
		return nil, err
	}
	return &dest, nil
}

// Characters hits GET /v0/subjects/{bgmId}/characters.  Returns a slice
// (the upstream response is a bare JSON array, not envelope-wrapped).
// Returns ErrNotFound for unknown bgmId.
func (c *Client) Characters(ctx context.Context, bgmID int) ([]Character, error) {
	path := fmt.Sprintf("/v0/subjects/%d/characters", bgmID)
	var dest []Character
	if err := c.get(ctx, path, &dest); err != nil {
		return nil, err
	}
	return dest, nil
}

// Episodes hits GET /subject/{bgmId}/ep (the OLD v1 endpoint — Bangumi
// kept this for backwards compat, and Express uses this one because the
// v0 episodes endpoint is less reliable, per the JS source comment).
// Returns ErrNotFound for unknown bgmId.
func (c *Client) Episodes(ctx context.Context, bgmID int) (*EpisodesResponse, error) {
	path := fmt.Sprintf("/subject/%d/ep", bgmID)
	var dest EpisodesResponse
	if err := c.get(ctx, path, &dest); err != nil {
		return nil, err
	}
	return &dest, nil
}

// ---------------------------------------------------------------------------
// Internal: shared GET + decode
// ---------------------------------------------------------------------------

// get is the shared transport for all four endpoint methods.  It
// applies the 800ms throttle (via limiter.Wait), issues the request
// with the canonical UA + Accept headers, maps 404→ErrNotFound and
// other non-2xx→*ErrUpstream, and decodes the body into dest.
//
// path is the URL-suffix appended to c.endpoint (e.g.
// "/v0/subjects/123").  Callers are responsible for URL-encoding any
// dynamic segments.
//
// dest MUST be a pointer to the destination structure.  json.Decoder
// is used (rather than ReadAll + Unmarshal) so memory stays bounded
// even for the larger payloads (characters list can be 50+ entries).
func (c *Client) get(ctx context.Context, path string, dest any) error {
	// 1) Throttle.  limiter.Wait blocks until a token is available or
	//    ctx is cancelled, returning ctx.Err() in the latter case.
	//    burst=1 + interval=800ms gives the Express
	//    "one request per 800ms" rate exactly.
	if err := c.limiter.Wait(ctx); err != nil {
		return fmt.Errorf("bangumi: rate limit wait: %w", err)
	}

	// 2) Build the HTTP request.  Use the configured base + path.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint+path, nil)
	if err != nil {
		return fmt.Errorf("bangumi: build request: %w", err)
	}
	req.Header.Set("User-Agent", c.ua)
	req.Header.Set("Accept", "application/json")

	// 3) Send.  Any transport-level failure (DNS, connect, TLS, timeout)
	//    is wrapped so callers can spot the failing layer in logs.
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("bangumi: http do: %w", err)
	}
	// Always drain + close to allow connection reuse.
	defer func() {
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}()

	// 4) Map upstream status codes.
	switch {
	case res.StatusCode == http.StatusNotFound:
		// 404 → typed sentinel.  Search 404s when keyword has no
		// results; Subject/Characters/Episodes 404 for unknown bgmId.
		return ErrNotFound
	case res.StatusCode < 200 || res.StatusCode >= 300:
		// Any other non-2xx → *ErrUpstream with original status.
		return &ErrUpstream{
			Status:  res.StatusCode,
			Message: "Bangumi API error",
		}
	}

	// 5) Decode the body into dest.  Use json.NewDecoder so memory
	//    stays bounded for larger payloads.
	if err := json.NewDecoder(res.Body).Decode(dest); err != nil {
		return fmt.Errorf("bangumi: decode response: %w", err)
	}
	return nil
}
