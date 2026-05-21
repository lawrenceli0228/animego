package httpmw

import (
	"net/http"

	gochicors "github.com/go-chi/cors"
)

// CORS returns the chi-compatible CORS middleware.  Configured for the
// Next.js client at the supplied origin — P2.2 cookie auth requires
// AllowCredentials=true, which means AllowedOrigins MUST be specific (not
// "*") for browsers to accept the cookie.
//
// Preflight responses are cached for 5 minutes to keep the request rate
// against /api/* down during a single page session.
func CORS(clientOrigin string) func(next http.Handler) http.Handler {
	return gochicors.Handler(gochicors.Options{
		AllowedOrigins:   []string{clientOrigin},
		AllowedMethods:   []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		ExposedHeaders:   []string{"X-Request-Id"},
		AllowCredentials: true,
		MaxAge:           300,
	})
}
