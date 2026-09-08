// transport.go — outbound HTTP plumbing.
//
// The rest of this package shapes RESPONSES we send.  This file is the one
// piece of client-side plumbing here, and it exists because the alternative
// was the same subtle three lines, with the same paragraph of explanation,
// copied into five packages.
package httpx

import "net/http"

// NewTransport returns a private *http.Transport carrying the standard
// library's defaults.
//
// # WHY THIS IS NOT JUST http.DefaultTransport
//
// An *http.Client with a nil Transport uses http.DefaultTransport, which is
// one object — and one connection pool — shared by the whole process.  That
// is usually harmless in production and actively hostile under test, because
// the standard library reaches into it from a place nobody expects
// (net/http/httptest/server.go, in Server.Close):
//
//	// Not part of httptest.Server's correctness, but assume most
//	// users of httptest.Server will be using the standard
//	// transport, so help them out and close any idle connections for them.
//	if t, ok := http.DefaultTransport.(closeIdleTransport); ok {
//		t.CloseIdleConnections()
//	}
//
// So ANY httptest server shutting down closes idle connections belonging to
// every client in the process.  In a package whose tests run t.Parallel()
// against their own httptest servers, one test's deferred srv.Close() can
// kill a sibling's in-flight request the moment it reuses a pooled
// connection, and the request fails with:
//
//	net/http: HTTP/1.x transport connection broken: http: CloseIdleConnections called
//
// Observed in CI on 2026-09-08 in internal/bangumi.  It is rare because the
// window is narrow — a connection has to be checked out of the pool and not
// yet finished — which also makes it very hard to reproduce on demand and
// very easy to dismiss as noise when it blocks a merge.
//
// Cloning gives each client its own pool, so the shared value nobody in this
// codebase asked for stops being a channel between unrelated tests.  In
// production it costs nothing and buys per-upstream pool isolation.
func NewTransport() *http.Transport {
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		return t.Clone()
	}
	// Unreachable with the standard library: http.DefaultTransport has been
	// an *http.Transport in every Go release.  If something replaced it,
	// keep the isolation this function exists for rather than handing back
	// the shared value, and keep proxy support — the one default that
	// matters outside a datacentre.
	return &http.Transport{Proxy: http.ProxyFromEnvironment}
}
