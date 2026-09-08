package httpx

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNewTransport_IsNotTheSharedDefault is the property every caller depends
// on: a pool of its own.
//
// Sharing http.DefaultTransport makes an unrelated package's httptest server
// able to close this client's idle connections, because Server.Close() calls
// CloseIdleConnections on the default transport process-wide
// (net/http/httptest/server.go).
func TestNewTransport_IsNotTheSharedDefault(t *testing.T) {
	t.Parallel()

	tr := NewTransport()
	require.NotNil(t, tr)
	assert.NotSame(t, http.DefaultTransport, tr,
		"a client using the shared default can have its connections closed by "+
			"any httptest server in the process")
}

// TestNewTransport_IsFreshEveryCall pins that two clients do not end up
// sharing one pool with each other either.
func TestNewTransport_IsFreshEveryCall(t *testing.T) {
	t.Parallel()

	assert.NotSame(t, NewTransport(), NewTransport())
}

// TestNewTransport_KeepsStandardDefaults pins that isolation did not cost the
// settings the default transport carries.  Proxy is the one that matters
// outside a datacentre; the timeouts are what stop a wedged upstream holding
// a connection open indefinitely.
func TestNewTransport_KeepsStandardDefaults(t *testing.T) {
	t.Parallel()

	std, ok := http.DefaultTransport.(*http.Transport)
	require.True(t, ok, "http.DefaultTransport is no longer an *http.Transport — "+
		"re-verify NewTransport's fallback branch")

	tr := NewTransport()
	assert.NotNil(t, tr.Proxy, "proxy support must survive the clone")
	assert.Equal(t, std.TLSHandshakeTimeout, tr.TLSHandshakeTimeout)
	assert.Equal(t, std.IdleConnTimeout, tr.IdleConnTimeout)
	assert.Equal(t, std.ExpectContinueTimeout, tr.ExpectContinueTimeout)
	assert.Equal(t, std.MaxIdleConns, tr.MaxIdleConns)
	assert.Equal(t, std.ForceAttemptHTTP2, tr.ForceAttemptHTTP2)
}
