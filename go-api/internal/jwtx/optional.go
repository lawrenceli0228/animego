package jwtx

// optional.go — OptionalAuth middleware.  Mirrors Express's
// optionalAuth: if a valid access token is present, attach the claims;
// otherwise continue with no claims (handler downstream sees
// ClaimsFrom returning (nil, false) and treats the request as anon).
//
// Used by routes that expose more data when authenticated (e.g. public
// profile reports isFollowing only for logged-in viewers) but still
// serve anonymous callers.  Distinct from RequireAuth, which 401s on
// missing/invalid token.

import (
	"net/http"
)

// OptionalAuth returns a chi/http middleware that attaches *AccessClaims
// to the request context when a valid access token is present.  Invalid
// or missing tokens are SILENT — the request continues as anonymous
// (no claims, no error response).
//
// Token sources: same as RequireAuth (Authorization: Bearer header OR
// accessToken cookie; header wins).
//
// Usage:
//
//	r.With(jwtx.OptionalAuth(signer)).Get("/api/users/{username}", profileHandler)
func OptionalAuth(s *Signer) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := ClaimsFromRequest(s, r)
			if !ok {
				// No token, or a token that is present but invalid (expired
				// / tampered) → anon.  Don't error.  This matches Express's
				// optionalAuth catch-all: `catch (_) { /* ignore */ }`.
				next.ServeHTTP(w, r)
				return
			}
			ctx := withClaims(r.Context(), claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClaimsFromRequest verifies the access token carried by r and returns its
// claims, or (nil, false) when there is no token or the token does not
// verify.  It never writes to the response and never distinguishes the two
// failures — callers that need to are looking at RequireAuth.
//
// This is a read of the request, not a mutation of it.  Attaching the claims
// stays the private business of RequireAuth / OptionalAuth via withClaims, so
// no caller of this function can fabricate an authenticated context.
//
// If you are reaching for this from an outer middleware in order to learn who
// is calling, use WithClaimsSink instead: this function re-runs the HMAC
// verification the auth middleware is about to run anyway, which measured at
// ~8.5µs and 49 allocations per request on the site's hot path.
func ClaimsFromRequest(s *Signer, r *http.Request) (*AccessClaims, bool) {
	if s == nil || r == nil {
		return nil, false
	}
	token, ok := extractToken(r)
	if !ok {
		return nil, false
	}
	claims, err := s.VerifyAccess(token)
	if err != nil {
		return nil, false
	}
	return claims, true
}

// HasToken reports whether r carries anything that looks like an access token,
// without verifying it.
//
// Header and cookie reads only — no crypto, no allocation.  It exists so an
// outer middleware can skip its own setup work for the requests that are
// obviously anonymous, which on a search-traffic-led site is most of them.
// A true result is not a claim that the token is valid.
func HasToken(r *http.Request) bool {
	if r == nil {
		return false
	}
	_, ok := extractToken(r)
	return ok
}
