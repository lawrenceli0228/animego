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
			token, ok := extractToken(r)
			if !ok {
				// No token at all → anon.  Don't error.
				next.ServeHTTP(w, r)
				return
			}
			claims, err := s.VerifyAccess(token)
			if err != nil {
				// Token present but invalid (expired / tampered) → treat
				// as anon rather than 401.  This matches Express's
				// optionalAuth catch-all: `catch (_) { /* ignore */ }`.
				next.ServeHTTP(w, r)
				return
			}
			ctx := withClaims(r.Context(), claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
