package jwtx

import "context"

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
func withClaims(ctx context.Context, c *AccessClaims) context.Context {
	return context.WithValue(ctx, claimsKey, c)
}
