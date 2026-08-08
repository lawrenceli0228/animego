package deepseek

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClient_Chat_OK(t *testing.T) {
	t.Parallel()

	var gotAuth string
	var gotReq chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotReq)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"翻译好的简介。"}}]}`))
	}))
	defer srv.Close()

	c := NewClient("test-key", WithEndpoint(srv.URL))
	out, err := c.Chat(context.Background(), "system prompt", "user text")

	require.NoError(t, err)
	assert.Equal(t, "翻译好的简介。", out)
	assert.Equal(t, "Bearer test-key", gotAuth)
	assert.Equal(t, DefaultModel, gotReq.Model)
	require.Len(t, gotReq.Messages, 2)
	assert.Equal(t, "system", gotReq.Messages[0].Role)
	assert.Equal(t, "user", gotReq.Messages[1].Role)
	assert.False(t, gotReq.Stream)
	// The budget must actually reach the wire, not just exist as a constant.
	assert.Equal(t, maxOutputTokens, gotReq.MaxTokens)
	// And so must the thinking switch — this one is the actual fix for the
	// 2026-08 incident, and it is invisible unless asserted on the wire: a
	// dropped `thinking` field is not a compile error, not a runtime error,
	// and not a test failure anywhere else. It just silently restores 20×
	// the token spend and the empty-content failures along with it.
	require.NotNil(t, gotReq.Thinking, "thinking must be sent, not omitted")
	assert.Equal(t, "disabled", gotReq.Thinking.Type)
}

func TestClient_Chat_Non2xx_ErrUpstream(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid api key"}}`))
	}))
	defer srv.Close()

	c := NewClient("bad-key", WithEndpoint(srv.URL))
	_, err := c.Chat(context.Background(), "s", "u")

	var up *ErrUpstream
	require.ErrorAs(t, err, &up)
	assert.Equal(t, http.StatusUnauthorized, up.Status)
	assert.Contains(t, up.Body, "invalid api key")
}

// A 2xx with no choices at all is a malformed envelope — there is no answer
// slot, nothing about the request explains it, and a retry may well work.
// It stays an error.
//
// This test and the two empty-content tests below are the whole point of the
// 2026-08 fix: these cases used to share one `||` branch and one error
// string, which is why 997 budget exhaustions were misread as upstream
// corruption.  If someone ever re-merges them, exactly one of these fails.
func TestClient_Chat_EmptyChoices_Error(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer srv.Close()

	c := NewClient("k", WithEndpoint(srv.URL))
	_, err := c.Chat(context.Background(), "s", "u")

	require.Error(t, err)
	var up *ErrUpstream
	assert.False(t, errors.As(err, &up), "malformed 2xx is not an upstream-status error")
}

// Empty content is the reasoning model burning its whole budget on the chain
// of thought.  The worker's validateTranslation already rejects an empty
// string and stamps the attempt, so the client must hand it over as data —
// raising it to an error skips that gate and the row retries forever.
func TestClient_Chat_EmptyContent_NoError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Ds-Trace-Id", "trace-abc123")
		// Shape taken from a real 2026-08 failure: the budget pinned
		// exactly, all of it spent reasoning, not one token of content.
		_, _ = w.Write([]byte(`{
			"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"","reasoning_content":"让我想想这个专有名词该怎么翻译……"}}],
			"usage":{"prompt_tokens":312,"completion_tokens":8192,"total_tokens":8504,
			         "completion_tokens_details":{"reasoning_tokens":8192}}
		}`))
	}))
	defer srv.Close()

	c := NewClient("k", WithEndpoint(srv.URL))
	out, err := c.Chat(context.Background(), "s", "u")

	require.NoError(t, err, "budget exhaustion is not an error — the worker's validator is the gate")
	assert.Equal(t, "", out)
}

// JSON null decodes into the same zero-value string as "", so it must take
// the same path.  Asserted explicitly because the two are different bytes on
// the wire and it would be easy to "fix" one without the other.
func TestClient_Chat_NullContent_NoError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":null}}]}`))
	}))
	defer srv.Close()

	c := NewClient("k", WithEndpoint(srv.URL))
	out, err := c.Chat(context.Background(), "s", "u")

	require.NoError(t, err)
	assert.Equal(t, "", out)
}

// The diagnostic fields exist so a failure can be read off a log line
// instead of reproduced.  This pins the JSON tags — a typo in any of them
// decodes silently to zero and quietly blinds the next post-mortem.
func TestClient_Chat_ParsesFinishReasonAndUsage(t *testing.T) {
	t.Parallel()

	// A full success envelope with every field we claim to read, using the
	// measured 2026-08 numbers (3,943 reasoning tokens before a good
	// answer; 256 tokens served from the prefix cache).
	const fixture = `{
		"choices":[{
			"finish_reason":"stop",
			"message":{"role":"assistant","content":"翻译好的简介。","reasoning_content":"先确认专有名词。"}
		}],
		"usage":{
			"prompt_tokens":312,
			"completion_tokens":4638,
			"total_tokens":4950,
			"completion_tokens_details":{"reasoning_tokens":3943},
			"prompt_cache_hit_tokens":256,
			"prompt_cache_miss_tokens":56
		}
	}`

	var parsed chatResponse
	require.NoError(t, json.Unmarshal([]byte(fixture), &parsed))

	require.Len(t, parsed.Choices, 1)
	assert.Equal(t, "stop", parsed.Choices[0].FinishReason)
	assert.Equal(t, "翻译好的简介。", parsed.Choices[0].Message.Content)
	assert.Equal(t, "先确认专有名词。", parsed.Choices[0].Message.ReasoningContent)

	assert.Equal(t, 312, parsed.Usage.PromptTokens)
	assert.Equal(t, 4638, parsed.Usage.CompletionTokens)
	assert.Equal(t, 4950, parsed.Usage.TotalTokens)
	assert.Equal(t, 3943, parsed.Usage.CompletionTokensDetails.ReasoningTokens)
	assert.Equal(t, 256, parsed.Usage.PromptCacheHitTokens)
	assert.Equal(t, 56, parsed.Usage.PromptCacheMissTokens)

	// And the same envelope still yields its content through the public API.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(fixture))
	}))
	defer srv.Close()

	out, err := NewClient("k", WithEndpoint(srv.URL)).Chat(context.Background(), "s", "u")
	require.NoError(t, err)
	assert.Equal(t, "翻译好的简介。", out)
}

// Permanent() decides whether river's attempt⁴ ladder is worth climbing.
// Getting 402 wrong costs ~20 days of silent backoff instead of a loud stop.
func TestErrUpstream_Permanent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
		want   bool
	}{
		{"401 revoked or missing key", http.StatusUnauthorized, true},
		{"402 insufficient balance", http.StatusPaymentRequired, true},
		{"403 key not entitled", http.StatusForbidden, true},
		{"429 rate limit clears by waiting", http.StatusTooManyRequests, false},
		{"500 upstream blip", http.StatusInternalServerError, false},
		{"503 upstream unavailable", http.StatusServiceUnavailable, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := &ErrUpstream{Status: tt.status, Body: "{}"}
			assert.Equal(t, tt.want, err.Permanent())
		})
	}
}

// Permanent() is reachable through errors.As from a Chat error, which is how
// the worker will actually ask the question.
func TestClient_Chat_Non2xx_PermanentClassification(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write([]byte(`{"error":{"message":"Insufficient Balance"}}`))
	}))
	defer srv.Close()

	c := NewClient("k", WithEndpoint(srv.URL))
	_, err := c.Chat(context.Background(), "s", "u")

	var up *ErrUpstream
	require.ErrorAs(t, err, &up)
	assert.Equal(t, http.StatusPaymentRequired, up.Status)
	assert.True(t, up.Permanent(), "402 must not be retried — the balance will not refill itself")
}

// A nil receiver must not panic: callers reach Permanent() through
// errors.As, and a defensive nil check costs nothing.
func TestErrUpstream_Permanent_NilReceiver(t *testing.T) {
	t.Parallel()

	var e *ErrUpstream
	assert.False(t, e.Permanent())
}

// The budget is the whole fix — if it silently reverts to 2048 the sweep
// starts burning money again with no visible symptom until the logs pile up.
func TestMaxOutputTokens_LeavesRoomForReasoning(t *testing.T) {
	t.Parallel()

	// Measured worst case: 3,943 reasoning tokens before a usable answer.
	assert.GreaterOrEqual(t, maxOutputTokens, 2*3943,
		"budget must cover ~2x the worst observed chain of thought plus the answer")
}
