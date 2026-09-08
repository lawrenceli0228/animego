package dandanplay

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestClientDoesNotShareTheDefaultTransport pins that NewClient() gives its
// client a private connection pool.
//
// This asserts a structural fact rather than a behaviour, which is unusual
// and deliberate.  The behaviour it protects is a race: any httptest server
// in this process, on Close(), calls CloseIdleConnections on
// http.DefaultTransport (net/http/httptest/server.go), so a client sharing it
// can have a pooled connection closed out from under an in-flight request by
// an unrelated parallel test.  It surfaces as:
//
//	net/http: HTTP/1.x transport connection broken: http: CloseIdleConnections called
//
// The window — connection checked out of the pool, request not yet finished —
// is narrow enough that ~200 local attempts failed to reproduce it, so there
// is no honest behavioural test to write.  What can be pinned is the property
// that makes the race impossible, and reverting the fix turns this red.
func TestClientDoesNotShareTheDefaultTransport(t *testing.T) {
	t.Parallel()

	c, err := NewClient()
	require.NoError(t, err)

	transport := c.http.Transport
	require.NotNil(t, transport,
		"a nil Transport means net/http falls back to the shared "+
			"http.DefaultTransport, which is the thing this guards against")
	assert.NotSame(t, http.DefaultTransport, transport,
		"this client shares the process-wide connection pool, so any httptest "+
			"server's Close() can kill its in-flight requests")
}
