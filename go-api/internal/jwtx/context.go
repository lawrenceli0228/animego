package jwtx

import (
	"context"
	"sync/atomic"
)

// context.go — request-scoped claims storage.  The middleware places
// the verified *AccessClaims under a package-private context key so
// downstream handlers can pull them via ClaimsFrom.  The key type is
// unexported so external packages can only read — never write — to
// avoid collision with other middlewares (e.g. logging, request-id).

// contextKey is an unexported struct so other packages can neither
// construct nor reference the key.  Empty struct = zero allocation.
type contextKey struct{}

// claimsKey is the singleton key under which RequireAuth stores the
// verified access-token claims.
var claimsKey = contextKey{}

// ClaimsFrom extracts the verified AccessClaims from a context.
// Returns (nil, false) when the context was not populated by
// RequireAuth — e.g. a public route, or a handler called outside a
// chi middleware chain.
//
// Handlers should treat (_, false) as unauthenticated and either
// return 401 or fall back to anonymous behavior, depending on the
// route contract.
func ClaimsFrom(ctx context.Context) (*AccessClaims, bool) {
	if ctx == nil {
		return nil, false
	}
	v := ctx.Value(claimsKey)
	if v == nil {
		return nil, false
	}
	c, ok := v.(*AccessClaims)
	return c, ok
}

// withClaims is the internal helper used by RequireAuth to inject
// claims into the request context.  Kept package-private so external
// callers can't fake auth by inserting a forged AccessClaims value.
//
// It also publishes to a ClaimsSink if an outer middleware installed one —
// see WithClaimsSink for why that indirection exists.
func withClaims(ctx context.Context, c *AccessClaims) context.Context {
	if sink, ok := ctx.Value(sinkKey).(*ClaimsSink); ok {
		sink.claims.Store(c)
	}
	return context.WithValue(ctx, claimsKey, c)
}

// sinkContextKey is a distinct unexported key type so a ClaimsSink can never
// be confused with the claims themselves.
type sinkContextKey struct{}

var sinkKey = sinkContextKey{}

// ClaimsSink is a one-slot mailbox an OUTER middleware can leave for the
// route-scoped auth middleware to drop verified claims into.
//
// It exists because of an ordering problem with no other cheap answer.  A
// middleware mounted at the top of the router runs BEFORE any route-scoped
// RequireAuth / OptionalAuth, so at the moment it executes there are no claims
// to read; and the inner context those middlewares build is not reachable from
// the outer wrapper afterwards.  An observer that must see every authenticated
// request — internal/activity's presence recorder is the one — therefore had
// only bad options: verify the token a second time itself (measured at ~8.5µs
// and 49 allocations per request, all of it duplicate work), or be registered
// inside every authenticated route group and quietly miss the next one somebody
// adds.
//
// The sink costs a pointer store on a value the auth middleware already holds.
//
// It carries claims OUT of the auth middleware; it can never carry them in.
// Storing into it does not authenticate anything — ClaimsFrom still reads the
// separate, unexported claims key that only withClaims writes — so a caller
// holding a sink cannot forge a session, only observe one.
type ClaimsSink struct {
	// atomic because the read happens after the inner handler returns, and a
	// handler is free to hand the request context to a goroutine.  Nothing
	// does that with an auth middleware today; paying an atomic store to keep
	// that from becoming a data race later is not a trade worth thinking about
	// twice.
	claims atomic.Pointer[AccessClaims]
}

// Claims returns the verified claims published to this sink, or nil if the
// request turned out to be anonymous (or never reached an auth middleware).
func (s *ClaimsSink) Claims() *AccessClaims {
	if s == nil {
		return nil
	}
	return s.claims.Load()
}

// WithClaimsSink returns a context carrying a fresh sink, plus the sink.
//
// The caller passes the context down via r.WithContext and reads the sink
// after next.ServeHTTP has returned.
func WithClaimsSink(ctx context.Context) (context.Context, *ClaimsSink) {
	sink := &ClaimsSink{}
	return context.WithValue(ctx, sinkKey, sink), sink
}
