// Package deepseek — minimal chat-completions client for the DeepSeek API.
//
// One caller today: the description_llm_backfill sweep, which translates
// AniList's English synopses into Chinese for rows the Bangumi channel can
// never serve.  The client therefore implements exactly one operation — a
// non-streaming chat completion with a system + user message — and none of
// the surface a general SDK would carry (no streaming, no tools, no usage
// accounting beyond what the response happens to include).
//
// The API is OpenAI-compatible (POST /chat/completions, Bearer auth), so if
// a second caller ever needs more, reach for an SDK rather than growing this
// file into one.
package deepseek

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefaultEndpoint is the production chat-completions URL.  Override with
// WithEndpoint in tests (httptest.NewServer).
const DefaultEndpoint = "https://api.deepseek.com/chat/completions"

// DefaultModel is the cheap tier — translation is a mechanical task and the
// flash model's quality is indistinguishable from pro on it, at a fifth of
// the output price ($0.28/M vs $0.87/M as of 2026-08).
const DefaultModel = "deepseek-v4-flash"

// httpTimeout bounds one completion round-trip.  Synopsis translations run
// a few hundred output tokens, well under a minute even on a congested API;
// the worker's own job timeout sits above this, so the client timeout is the
// one that actually fires on a wedged upstream.
const httpTimeout = 60 * time.Second

// maxOutputTokens caps a runaway completion.  The longest source synopsis in
// the catalogue is ~2,300 chars (~600 tokens); Chinese output runs shorter
// than English input, so 2048 is generous headroom rather than a limit any
// legitimate translation approaches.
const maxOutputTokens = 2048

// ErrUpstream wraps a non-2xx response.  Status preserves the original HTTP
// code for logs; Body carries a bounded snippet of the response so a 4xx's
// error message (wrong key, model retired, insufficient balance) is visible
// without a second request.
type ErrUpstream struct {
	Status int
	Body   string
}

func (e *ErrUpstream) Error() string {
	return fmt.Sprintf("deepseek upstream: %d %s", e.Status, e.Body)
}

// Client is the chat-completions caller.  Safe for concurrent use — it holds
// nothing mutable.
type Client struct {
	endpoint string
	model    string
	apiKey   string
	httpc    *http.Client
}

// Option mutates a Client during construction.
type Option func(*Client)

// WithEndpoint overrides the chat-completions URL (tests).
func WithEndpoint(u string) Option {
	return func(c *Client) { c.endpoint = u }
}

// WithModel overrides the model id.
func WithModel(m string) Option {
	return func(c *Client) { c.model = m }
}

// WithHTTPClient swaps the underlying *http.Client.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.httpc = h }
}

// NewClient constructs a Client.  The key is required by the API but not
// validated here — a missing key surfaces as a 401 ErrUpstream on first use,
// which is the loud failure the caller wants.
func NewClient(apiKey string, opts ...Option) *Client {
	c := &Client{
		endpoint: DefaultEndpoint,
		model:    DefaultModel,
		apiKey:   apiKey,
		httpc:    &http.Client{Timeout: httpTimeout},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model     string        `json:"model"`
	Messages  []chatMessage `json:"messages"`
	Stream    bool          `json:"stream"`
	MaxTokens int           `json:"max_tokens"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

// Chat runs one non-streaming completion and returns the first choice's
// content.  Errors:
//   - transport / ctx errors — wrapped, caller (river) retries
//   - non-2xx — *ErrUpstream with status + body snippet
//   - 2xx with no usable content — plain error (malformed upstream)
func (c *Client) Chat(ctx context.Context, system, user string) (string, error) {
	payload, err := json.Marshal(chatRequest{
		Model: c.model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Stream:    false,
		MaxTokens: maxOutputTokens,
	})
	if err != nil {
		return "", fmt.Errorf("deepseek: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("deepseek: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	res, err := c.httpc.Do(req)
	if err != nil {
		return "", fmt.Errorf("deepseek: http do: %w", err)
	}
	defer func() { _ = res.Body.Close() }()

	// Bound the read either way: error bodies are small JSON, and a success
	// body is capped by maxOutputTokens — 1MB is far beyond both and keeps a
	// misbehaving upstream from ballooning memory.
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("deepseek: read response: %w", err)
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		snippet := string(body)
		if len(snippet) > 512 {
			snippet = snippet[:512]
		}
		return "", &ErrUpstream{Status: res.StatusCode, Body: snippet}
	}

	var parsed chatResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("deepseek: decode response: %w", err)
	}
	if len(parsed.Choices) == 0 || parsed.Choices[0].Message.Content == "" {
		return "", fmt.Errorf("deepseek: response carried no content")
	}
	return parsed.Choices[0].Message.Content, nil
}
