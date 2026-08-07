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
