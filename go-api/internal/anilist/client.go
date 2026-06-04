// Package anilist — HTTP client for AniList GraphQL API.
//
// This client is the Go port of the Express
// server/services/anilist.service.js queryAniList helper.  It preserves
// the exact rate-limit and retry semantics the legacy backend uses so
// production AniList traffic stays inside the same per-IP budget:
//
//   - One in-flight request per 700ms (≈85 req/min) via a token-bucket
//     rate limiter.  This replaces the JS lastRequestTime trick.
//   - On HTTP 429, honour Retry-After (defaulting to 60s when the header
//     is missing or unparsable), then retry — up to 3 retries (4 total
//     attempts) before surfacing ErrRateLimited.
//   - Non-2xx responses other than 429 are wrapped in *ErrUpstream with
//     the original status, so callers (handlers) can map them to a 502
//     envelope.
//   - GraphQL field errors (200-OK with non-empty "errors" array) are
//     also wrapped in *ErrUpstream{Status: 502}, matching Express.
//
// types.go and queries.go are LOCKED — this file does not touch them.
// The GraphQL POST body is constructed inline via an anonymous struct so
// the per-query *Vars structs keep their omitempty semantics.  The
// response is decoded into a local wire struct (json.RawMessage Data) so
// the typed response payload can be unmarshaled into the caller's
// destination pointer without going through types.go's
// graphqlResponse.Data any field.
package anilist

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ---------------------------------------------------------------------------
// Public constants & sentinel errors
// ---------------------------------------------------------------------------

// DefaultEndpoint is the production AniList GraphQL endpoint.  Override
// with WithEndpoint(...) in tests or staging.
const DefaultEndpoint = "https://graphql.anilist.co"

// minInterval is the per-request gap the Express service enforces.
// 700ms ≈ 85 req/min, well under AniList's documented 90 req/min cap.
const minInterval = 700 * time.Millisecond

// maxRetries is the number of 429 retries before giving up.  The first
// HTTP attempt is not counted as a retry, so the total attempt budget is
// maxRetries + 1.
const maxRetries = 3

// defaultRetryAfter is the fallback sleep duration when the upstream
// 429 response omits or sends a malformed Retry-After header.  Express
// uses the same 60s default.
const defaultRetryAfter = 60 * time.Second

// httpTimeout is the per-request HTTP client timeout.  Long enough to
// survive AniList's worst observed latency without hanging callers
// forever.  Override with WithHTTPClient(...) to tune.
const httpTimeout = 10 * time.Second

// breakerCooldown is how long the circuit stays open after AniList rate-
// limits us (a 429 that exhausts the retry budget).  While open, do()
// short-circuits to ErrRateLimited WITHOUT making the HTTP call — so a
// caller (e.g. the detail handler under an SEO crawl) degrades to stale
// data in microseconds instead of burning the full retry budget (up to
// refetchTimeout, ~15s) on every request during an AniList rate-limit
// storm.  It also stops us hammering AniList while it's asking us to back
// off.  After the cooldown the next call probes upstream again (a 429
// re-trips it).  Set to 0 via WithBreakerCooldown to disable (tests).
const breakerCooldown = 30 * time.Second

// ErrRateLimited is returned after maxRetries exhausted on HTTP 429.
// Express raises an Error with status=429 and a Chinese message; the
// handler layer in Go is responsible for mapping this sentinel to that
// envelope.  This package stays I/O-agnostic.
var ErrRateLimited = errors.New("anilist: rate limited after 3 retries")

// ErrUpstream wraps a non-2xx response (or a GraphQL field-error
// payload).  Callers in the handler layer map this to a 502 envelope
// using the embedded Message.  Status preserves the original HTTP code
// for observability (logs / traces) — it is not necessarily the status
// the client API will return to the browser.
type ErrUpstream struct {
	Status  int
	Message string
}

// Error formats as "anilist upstream: <status> <message>" so structured
// logs can grep on the prefix.
func (e *ErrUpstream) Error() string {
	if e == nil {
		return "<nil ErrUpstream>"
	}
	return fmt.Sprintf("anilist upstream: %d %s", e.Status, e.Message)
}

// ---------------------------------------------------------------------------
// Client + functional options
// ---------------------------------------------------------------------------

// Client is the AniList GraphQL caller.  It wraps a *http.Client with a
// 700ms token-bucket throttle.  The limiter has burst=1 (a single token,
// refilled every 700ms) which matches Express's "one request per 700ms,
// no burst" semantics — multiple concurrent callers serialise through
// the limiter exactly the way JS serialised through lastRequestTime.
//
// Clients are safe for concurrent use.  All four query methods reuse
// the same limiter and *http.Client.
type Client struct {
	endpoint string
	http     *http.Client
	limiter  *rate.Limiter
	// sleep is the timer hook used by the 429 retry loop.  In tests it
	// is replaced via WithSleep(...) so retry behaviour can be asserted
	// without real elapsed time.  The function must respect the passed
	// duration semantically — production code uses time.Sleep equivalent.
	sleep func(context.Context, time.Duration) error

	// Circuit breaker (see breakerCooldown). breakerCooldown==0 disables
	// it. openUntil is the instant the circuit closes again; now() is a
	// hook so tests can advance time without sleeping. mu guards both.
	breakerCooldown time.Duration
	now             func() time.Time
	mu              sync.Mutex
	openUntil       time.Time
}

// Option mutates a Client during construction.  See NewClient.
type Option func(*Client)

// WithEndpoint overrides the AniList GraphQL URL.  Used by tests
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

// WithSleep replaces the retry-sleep function.  Test-only — production
// callers should not need this.  The signature accepts ctx so
// implementations can honour cancellation if they want; the default
// implementation uses time.NewTimer with a select on ctx.Done().
//
// A common test pattern is:
//
//	var slept []time.Duration
//	c := anilist.NewClient(anilist.WithSleep(func(_ context.Context, d time.Duration) error {
//	    slept = append(slept, d)
//	    return nil
//	}))
func WithSleep(f func(context.Context, time.Duration) error) Option {
	return func(c *Client) {
		c.sleep = f
	}
}

// NewClient constructs a Client with the 700ms token-bucket limiter and
// a 10-second HTTP timeout by default.  Pass WithEndpoint to override
// the AniList URL (tests) and WithHTTPClient to swap timeout / transport.
func NewClient(opts ...Option) *Client {
	c := &Client{
		endpoint:        DefaultEndpoint,
		http:            &http.Client{Timeout: httpTimeout},
		limiter:         rate.NewLimiter(rate.Every(minInterval), 1),
		sleep:           defaultSleep,
		breakerCooldown: breakerCooldown,
		now:             time.Now,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// WithBreakerCooldown overrides the circuit-breaker cooldown.  Pass 0 to
// disable the breaker entirely (tests that assert raw retry behaviour).
func WithBreakerCooldown(d time.Duration) Option {
	return func(c *Client) {
		c.breakerCooldown = d
	}
}

// WithNow replaces the breaker clock.  Test-only — lets a test open the
// circuit and then jump past the cooldown without real elapsed time.
func WithNow(f func() time.Time) Option {
	return func(c *Client) {
		c.now = f
	}
}

// defaultSleep is the production retry-sleep implementation.  It honours
// ctx cancellation so a caller that aborts during a 429 backoff returns
// promptly instead of blocking for 60 seconds.
func defaultSleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// breakerOpen reports whether the AniList circuit is currently open
// (recently rate-limited).  While open, do() short-circuits to
// ErrRateLimited without making the HTTP call.
func (c *Client) breakerOpen() bool {
	if c.breakerCooldown <= 0 {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now().Before(c.openUntil)
}

// tripBreaker opens the circuit for breakerCooldown after AniList rate-
// limits us, so subsequent calls back off immediately instead of each
// burning the full retry budget against an upstream that's saying "slow
// down".
func (c *Client) tripBreaker() {
	if c.breakerCooldown <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.openUntil = c.now().Add(c.breakerCooldown)
}

// ---------------------------------------------------------------------------
// Variable structs — typed inputs for each query
// ---------------------------------------------------------------------------

// SearchVars are the variables for SearchAnimeQuery.  Search and Genre
// are pointer types so callers can pass nil for "absent" (omitted from
// the JSON body via omitempty), matching AniList's expectation that
// optional String arguments be undefined rather than empty strings.
type SearchVars struct {
	Page    int     `json:"page,omitempty"`
	PerPage int     `json:"perPage,omitempty"`
	Search  *string `json:"search,omitempty"`
	Genre   *string `json:"genre,omitempty"`
}

// SeasonalVars are the variables for SeasonalAnimeQuery.  Season is
// passed as a plain string ("WINTER" | "SPRING" | "SUMMER" | "FALL");
// AniList accepts the enum value as a JSON string literal.
type SeasonalVars struct {
	Page       int    `json:"page,omitempty"`
	PerPage    int    `json:"perPage,omitempty"`
	Season     string `json:"season,omitempty"`
	SeasonYear int    `json:"seasonYear,omitempty"`
}

// DetailVars carries the single required ID for AnimeDetailQuery.
type DetailVars struct {
	ID int `json:"id"`
}

// ScheduleVars are the variables for WeeklyScheduleQuery.  All three
// fields are required by the query ($weekStart, $weekEnd, $page are
// Int! in the GraphQL signature) so they are non-pointer non-omitempty.
type ScheduleVars struct {
	WeekStart int64 `json:"weekStart"`
	WeekEnd   int64 `json:"weekEnd"`
	Page      int   `json:"page"`
}

// ---------------------------------------------------------------------------
// Public query methods
// ---------------------------------------------------------------------------

// Search runs SearchAnimeQuery.  Returns a populated SearchAnimeResponse
// on success or a wrapped error (ErrRateLimited, *ErrUpstream, or a
// context / transport error).
func (c *Client) Search(ctx context.Context, v SearchVars) (*SearchAnimeResponse, error) {
	var dest SearchAnimeResponse
	if err := c.do(ctx, SearchAnimeQuery, v, &dest); err != nil {
		return nil, err
	}
	return &dest, nil
}

// Seasonal runs SeasonalAnimeQuery.  See Search for error semantics.
func (c *Client) Seasonal(ctx context.Context, v SeasonalVars) (*SeasonalAnimeResponse, error) {
	var dest SeasonalAnimeResponse
	if err := c.do(ctx, SeasonalAnimeQuery, v, &dest); err != nil {
		return nil, err
	}
	return &dest, nil
}

// Detail runs AnimeDetailQuery for a single AniList media ID.
func (c *Client) Detail(ctx context.Context, v DetailVars) (*AnimeDetailResponse, error) {
	var dest AnimeDetailResponse
	if err := c.do(ctx, AnimeDetailQuery, v, &dest); err != nil {
		return nil, err
	}
	return &dest, nil
}

// Schedule runs WeeklyScheduleQuery for a [weekStart, weekEnd] window.
func (c *Client) Schedule(ctx context.Context, v ScheduleVars) (*WeeklyScheduleResponse, error) {
	var dest WeeklyScheduleResponse
	if err := c.do(ctx, WeeklyScheduleQuery, v, &dest); err != nil {
		return nil, err
	}
	return &dest, nil
}

// ---------------------------------------------------------------------------
// Internal: shared POST + decode + retry loop
// ---------------------------------------------------------------------------

// do is the shared transport for all four queries.  It serialises the
// {query, variables} envelope, posts to the configured endpoint, and
// decodes the GraphQL "data" field into dest.  All retry / throttle /
// upstream-error semantics live here.
//
// dest MUST be a pointer to a struct annotated with json tags matching
// the corresponding GraphQL response shape (see types.go for the four
// concrete payload types).
func (c *Client) do(ctx context.Context, query string, vars any, dest any) error {
	// Circuit breaker: while AniList is rate-limiting us, fail fast so the
	// caller degrades immediately (e.g. detail → stale data) instead of
	// every request blocking on the retry budget. See breakerCooldown.
	if c.breakerOpen() {
		return ErrRateLimited
	}

	// Marshal the body once — variables may not change between retries,
	// so we can reuse the same payload buffer.  Build via anonymous
	// struct so the per-query *Vars omitempty tags decide which fields
	// AniList actually sees (vs. the graphqlRequest type in types.go
	// which uses map[string]any).
	payload, err := json.Marshal(struct {
		Query     string `json:"query"`
		Variables any    `json:"variables"`
	}{Query: query, Variables: vars})
	if err != nil {
		return fmt.Errorf("anilist: marshal request: %w", err)
	}

	for attempt := 0; attempt <= maxRetries; attempt++ {
		// 1) Throttle.  limiter.Wait blocks until a token is available
		//    or ctx is cancelled, returning ctx.Err() in the latter
		//    case.  burst=1 + interval=700ms gives the Express
		//    "one request per 700ms" rate exactly.
		if err := c.limiter.Wait(ctx); err != nil {
			return fmt.Errorf("anilist: rate limit wait: %w", err)
		}

		// 2) Build + send the HTTP request.  A fresh bytes.Reader per
		//    attempt is required because the previous attempt drained
		//    the body during the HTTP transport.
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
		if err != nil {
			return fmt.Errorf("anilist: build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")

		res, err := c.http.Do(req)
		if err != nil {
			return fmt.Errorf("anilist: http do: %w", err)
		}

		// 3) Handle 429 — sleep and retry, unless budget exhausted.
		if res.StatusCode == http.StatusTooManyRequests {
			// Drain + close so the connection is reused.
			_, _ = io.Copy(io.Discard, res.Body)
			_ = res.Body.Close()

			if attempt >= maxRetries {
				c.tripBreaker()
				return ErrRateLimited
			}
			retryAfter := parseRetryAfter(res.Header.Get("Retry-After"))
			if err := c.sleep(ctx, retryAfter); err != nil {
				return fmt.Errorf("anilist: retry sleep: %w", err)
			}
			continue
		}

		// 4) Handle other non-2xx — wrap in *ErrUpstream with the
		//    original status.  Express maps these to 502; we keep the
		//    original status here for observability.
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			_, _ = io.Copy(io.Discard, res.Body)
			_ = res.Body.Close()
			return &ErrUpstream{
				Status:  res.StatusCode,
				Message: fmt.Sprintf("AniList API error: %d", res.StatusCode),
			}
		}

		// 5) Decode the GraphQL envelope.  We use a local wire struct
		//    (Data is json.RawMessage) so the typed payload can be
		//    unmarshaled into dest without going through types.go's
		//    graphqlResponse.Data any field.
		var wire struct {
			Data   json.RawMessage `json:"data"`
			Errors []graphqlError  `json:"errors,omitempty"`
		}
		decodeErr := json.NewDecoder(res.Body).Decode(&wire)
		_ = res.Body.Close()
		if decodeErr != nil {
			return fmt.Errorf("anilist: decode response: %w", decodeErr)
		}

		// 6) GraphQL field errors — wrap the first message as a 502
		//    upstream error.  Express picks errors[0].message exactly
		//    the same way.
		if len(wire.Errors) > 0 {
			return &ErrUpstream{Status: http.StatusBadGateway, Message: wire.Errors[0].Message}
		}

		// 7) Unmarshal the data payload into the caller's dest pointer.
		if len(wire.Data) == 0 || bytes.Equal(wire.Data, []byte("null")) {
			return &ErrUpstream{Status: http.StatusBadGateway, Message: "AniList returned null data"}
		}
		if err := json.Unmarshal(wire.Data, dest); err != nil {
			return fmt.Errorf("anilist: decode data field: %w", err)
		}
		return nil
	}

	// Unreachable — the loop body always returns or continues.
	return ErrRateLimited
}

// parseRetryAfter parses the Retry-After header value.  AniList sends a
// numeric second-count; per RFC 7231 the header may also carry an
// HTTP-date, but Express only handles the numeric form so we match that
// behaviour and fall back to the default on any parse failure.
func parseRetryAfter(raw string) time.Duration {
	if raw == "" {
		return defaultRetryAfter
	}
	secs, err := strconv.Atoi(raw)
	if err != nil || secs <= 0 {
		return defaultRetryAfter
	}
	return time.Duration(secs) * time.Second
}
