// Package deepseek — minimal chat-completions client for the DeepSeek API.
//
// One caller today: the description_llm_backfill sweep, which translates
// AniList's English synopses into Chinese for rows the Bangumi channel can
// never serve.  The client therefore implements exactly one operation — a
// non-streaming chat completion with a system + user message — and none of
// the surface a general SDK would carry (no streaming, no tools, no usage
// aggregation; usage is parsed for diagnostics only, never accumulated).
//
// The API is OpenAI-compatible (POST /chat/completions, Bearer auth), so if
// a second caller ever needs more, reach for an SDK rather than growing this
// file into one.
//
// One thing this client is NOT OpenAI-compatible about, and it cost us: the
// configured model is a *reasoning* model.  It emits a chain of thought
// (message.reasoning_content) before any answer, and both come out of the
// same max_tokens budget.  See maxOutputTokens and Chat for the 2026-08
// incident that taught us this.
package deepseek

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
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

// maxOutputTokens caps a runaway completion.  Read the number as a *total
// generation budget*, not a cap on how long the translation may be: on a
// reasoning model like deepseek-v4-flash, max_tokens covers
// reasoning_content (the chain of thought) plus the visible content, and the
// chain of thought is billed and counted first.
//
// The old value was 2048, sized off the visible answer alone ("longest
// synopsis ~2,300 chars ≈ 600 tokens, Chinese runs shorter than English, so
// 2048 is generous").  That reasoning was correct about the answer and
// blind to the thinking.  In 2026-08 the description_llm sweep failed 997
// times in a row with completion_tokens == reasoning_tokens == 2048 —
// exactly the ceiling, every time.  The model had spent the entire budget
// deliberating and emitted zero tokens of translation: finish_reason
// "length", content "".  ~2M output tokens paid for, nothing written, 74
// jobs wedged.
//
// The trigger is input ambiguity, not input length.  Obscure proper nouns
// and titles with no settled Chinese rendering send the model into a long
// weigh-the-options monologue; a single ordinary synopsis was measured
// burning 3,943 reasoning tokens before writing a 695-byte answer that was
// perfectly good.  Re-running the failing inputs at 8192 succeeded
// immediately.
//
// 8192 buys roughly 2× the worst thinking we have actually observed while
// staying a real ceiling on a looping model.  Note the cost asymmetry: the
// budget is only *charged* when spent, so a headroom raise costs nothing on
// the calls that never needed it — whereas setting it too low costs the
// full budget AND produces nothing.
//
// THIS NUMBER IS A NET, NOT THE FIX.  Raising it was the first response to
// the incident and it does not close the hole: the chain of thought has no
// upper bound to chase.  The same input that burned 3,061 reasoning tokens
// on one call was measured burning all 8,192 on another and still returning
// content "" — a bigger budget just moves the wall.  What actually removes
// the failure mode is turning the chain of thought off (see thinkingMode);
// this ceiling stays behind it to bound a runaway if that switch is ever
// removed or the upstream default changes.
const maxOutputTokens = 8192

// thinkingMode disables the chain of thought.
//
// deepseek-v4-flash and -pro are both reasoning models and both default to
// thinking enabled; the API exposes `thinking: {type: "enabled"|"disabled"}`
// to switch it off.  There is no non-reasoning model to fall back to — the
// /models endpoint lists exactly those two.
//
// Turning it off is right for this caller specifically, and the numbers are
// not close.  Translating one synopsis, same input, same prompt:
//
//	thinking enabled : 3,220 completion tokens (3,061 of them reasoning), 25.4s
//	thinking disabled:   155 completion tokens (no reasoning),             2.8s
//
// 20× the output tokens and 9× the wall clock, spent deliberating over a
// mechanical translation.  Measured across the catalogue, reasoning was
// 92.6% of all output tokens — i.e. we were paying for the monologue and
// getting the translation as a rounding error.  Full-backlog projection
// drops from ≈$4 to ≈$0.33, and the rows that had failed repeatedly
// translated on the first try with thinking off.
//
// The quality trade was checked, not assumed: on paired samples the thinking
// runs were marginally better on obscure proper nouns, but one of them
// silently dropped an entire source sentence — a worse violation of this
// prompt's "no additions, no omissions" rule than any wording difference.
// Not a 12× gap.
//
// reasoning_effort ("low"|"high"|"max") is NOT an alternative: a run with
// "low" still consumed the entire 8,192-token budget on thinking and
// returned nothing.  The switch is binary in practice.
var thinkingMode = &thinkingConfig{Type: "disabled"}

// traceIDHeader carries DeepSeek's per-request trace id.  It is the only
// identifier their support will act on, it appears on success and failure
// alike, and it is nowhere in the response body — so it has to be lifted off
// the header before the response is discarded, or a post-mortem has nothing
// to hand upstream.
const traceIDHeader = "X-Ds-Trace-Id"

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

// Permanent reports whether this status is a *deterministic* rejection —
// one where the identical request will keep failing until a human changes
// something outside the process.  Retrying those is not resilience, it is
// noise that hides the real problem.
//
// The three permanent codes, and what each actually means at DeepSeek:
//
//   - 401 Unauthorized — the API key is missing, malformed, or revoked.
//     Every subsequent call carries the same bad key.
//   - 402 Payment Required — account balance exhausted.  DeepSeek uses this
//     specifically for "insufficient balance"; it clears when someone tops
//     up the account, never by waiting.
//   - 403 Forbidden — the key authenticates but is not entitled to this
//     model or endpoint (wrong tier, region block, org policy).
//
// Everything else stays retryable on purpose: 429 is a rate limit that
// resolves by waiting, and 5xx are upstream blips.
//
// Why this matters more than it looks: the sweep runs under river with an
// attempt⁴ backoff and 25 attempts.  A permanent failure treated as
// transient does not fail loudly — it stretches the retry ladder out to
// roughly twenty days of ever-longer sleeps, so an expired key looks like a
// queue that has simply gone quiet.  Loud beats slow.
//
// This method only *classifies*.  It deliberately does not short-circuit
// anything here — no breaker, no in-client state.  How the worker reacts
// (abandon the job, cancel the sweep, page someone) belongs to the worker,
// which is the layer that knows what else is in flight.
func (e *ErrUpstream) Permanent() bool {
	if e == nil {
		return false
	}
	switch e.Status {
	case http.StatusUnauthorized, http.StatusPaymentRequired, http.StatusForbidden:
		return true
	default:
		return false
	}
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

// thinkingConfig is the `thinking` request object.  Only Type is sent:
// reasoning_effort is meaningless once thinking is disabled, and was
// measured not to help while it is enabled (see thinkingMode).
type thinkingConfig struct {
	Type string `json:"type"`
}

type chatRequest struct {
	Model     string          `json:"model"`
	Messages  []chatMessage   `json:"messages"`
	Stream    bool            `json:"stream"`
	MaxTokens int             `json:"max_tokens"`
	Thinking  *thinkingConfig `json:"thinking,omitempty"`
}

// chatResponse is the subset of the completion envelope we actually read.
// Every field here was observed on the wire against deepseek-v4-flash in
// 2026-08; anything the API omits decodes to its zero value.
//
// Until that incident this struct held exactly one field — Content — which
// is why "the model spent its whole budget thinking" and "the upstream sent
// us garbage" were indistinguishable from inside the client.  The extra
// fields cost one struct definition and turn a mystery into a log line.
//
// Deliberately NOT parsed: `refusal`.  The incident produced a plausible
// content-moderation hypothesis, and it was tested and disproved —
// deliberately explicit synopses translate without complaint,
// finish_reason "content_filter" did not occur once across 997 failures,
// and `refusal` is simply not a field DeepSeek sends.  Decoding it would
// manufacture the appearance of a signal we do not have.
type chatResponse struct {
	Choices []struct {
		// FinishReason separates a finished answer ("stop") from a
		// truncated one ("length").  This single string would have named
		// the 2026-08 bug on day one; every one of the 997 failures
		// carried "length" and nothing was reading it.
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Content string `json:"content"`
			// ReasoningContent is the model's chain of thought.  It is
			// never persisted and never returned to callers — it is not
			// the translation, it is the deliberation about it, and it
			// bloats logs badly (thousands of tokens of prose).  We keep
			// it only to report its *length* when Content is empty,
			// because that length is the direct evidence that the model
			// thought hard and then ran out of room to answer.
			ReasoningContent string `json:"reasoning_content"`
		} `json:"message"`
	} `json:"choices"`

	// Usage is the billing/diagnostic block.  Parsed for logs only; the
	// client keeps no running totals.
	Usage struct {
		PromptTokens int `json:"prompt_tokens"`
		// CompletionTokens counts reasoning + content together.  When it
		// equals maxOutputTokens exactly, the budget was the binding
		// constraint — that precise pin is what confirmed the diagnosis.
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
		// CompletionTokensDetails.ReasoningTokens is the only field that
		// shows where the money went.  Without it, a 2048-token completion
		// that returns an empty string looks like the API lying about its
		// own accounting.
		CompletionTokensDetails struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
		// Prefix caching is live and working: the constant system prompt
		// was measured hitting cache at 256 tokens per call.  Logging the
		// hit/miss split makes a future cache regression visible as a cost
		// jump rather than an unexplained invoice.
		PromptCacheHitTokens  int `json:"prompt_cache_hit_tokens"`
		PromptCacheMissTokens int `json:"prompt_cache_miss_tokens"`
	} `json:"usage"`
}

// Chat runs one non-streaming completion and returns the first choice's
// content.  Contract:
//
//   - transport / ctx errors — wrapped, caller (river) retries
//   - non-2xx — *ErrUpstream with status + body snippet; ask Permanent()
//     whether retrying is worth anything
//   - 2xx with zero choices — plain error.  This is a genuinely malformed
//     envelope (no answer slot at all) and deserves a retry.
//   - 2xx with an empty content string — ("", nil), plus a Warn carrying
//     the diagnostics.  NOT an error.  See below.
//   - 2xx with content — (content, nil)
//
// The last two used to be one branch joined by ||, and collapsing them is
// what made the 2026-08 failure unreadable: "the model produced nothing"
// was reported with the same words as "the upstream is broken", so 997
// budget exhaustions were read as malformed responses and the sweep chased
// a phantom API bug.  They are different events with different owners and
// they now report separately.
//
// Returning ("", nil) for empty content *removes* a special case rather
// than adding one.  The worker already owns the "is this output usable?"
// decision — validateTranslation rejects an empty string like any other
// unusable output, stamps the attempt, and returns nil so the row is not
// retried forever.  The old code promoted empty content to an error, which
// jumped that gate entirely: the job failed before the stamp was written,
// so the row came back on the next sweep, failed identically, and never
// converged.  Handing empty content to the worker as data puts the decision
// back where the policy lives.
//
// Note that a JSON `null` content decodes into the same empty string as a
// literal "" — Go's decoder leaves a string at its zero value for null.
// Both take this path.  That collapse is fine here precisely because the
// worker treats them identically (both are "no usable translation"), and
// the Warn below carries finish_reason and the token counts, which is what
// actually distinguishes the interesting case from the boring one.
func (c *Client) Chat(ctx context.Context, system, user string) (string, error) {
	payload, err := json.Marshal(chatRequest{
		Model: c.model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Stream:    false,
		MaxTokens: maxOutputTokens,
		Thinking:  thinkingMode,
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

	// Lift the trace id before anything can return — it is the only handle
	// DeepSeek support accepts, and it lives on the header, not in the body.
	traceID := res.Header.Get(traceIDHeader)

	// Malformed envelope: a 2xx with no answer slot at all.  Nothing about
	// the request explains this, so it reads as an upstream glitch and is
	// worth retrying.  Distinct from the empty-content case below.
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("deepseek: response carried no choices (trace_id=%q)", traceID)
	}

	choice := parsed.Choices[0]
	if choice.Message.Content == "" {
		// The model answered with nothing.  Not an error — the worker's
		// validator is the gate for unusable output (see the doc comment).
		// It is still abnormal and still costs money, so it gets a Warn
		// with everything needed to tell the two shapes apart without a
		// reproduction:
		//   finishReason "length" + reasoningTokens ≈ completionTokens ≈
		//   maxTokens  → budget exhausted in the chain of thought; raise
		//   maxOutputTokens or simplify the input.
		//   finishReason "stop" + low token counts → the model genuinely
		//   had nothing to say, which is a prompt problem, not a budget
		//   one.
		slog.WarnContext(ctx, "deepseek: completion returned empty content",
			"finishReason", choice.FinishReason,
			"reasoningLen", len(choice.Message.ReasoningContent),
			"promptTokens", parsed.Usage.PromptTokens,
			"completionTokens", parsed.Usage.CompletionTokens,
			"reasoningTokens", parsed.Usage.CompletionTokensDetails.ReasoningTokens,
			"totalTokens", parsed.Usage.TotalTokens,
			"cacheHitTokens", parsed.Usage.PromptCacheHitTokens,
			"cacheMissTokens", parsed.Usage.PromptCacheMissTokens,
			"maxTokens", maxOutputTokens,
			"systemLen", len(system),
			"userLen", len(user),
			"traceId", traceID)
		return "", nil
	}

	return choice.Message.Content, nil
}
