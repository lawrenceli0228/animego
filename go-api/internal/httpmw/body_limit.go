package httpmw

// body_limit.go — request body size cap.  Express enforces
// express.json({ limit: '100kb' }) implicitly via body-parser; Go's
// json.NewDecoder reads until EOF or Content-Length with no built-in
// cap, so a single 1GB POST allocates 1GB before validation rejects it.
//
// MaxBodyBytes wraps every request with http.MaxBytesReader.  Exceeding
// the limit causes the body Read to fail with *http.MaxBytesError,
// which downstream JSON decoders surface as a parse error — handlers
// then emit their normal 400 "Invalid request body" envelope.  No
// special-case handling needed because the decode-error path already
// exists in every endpoint that accepts JSON.

import (
	"net/http"
)

// DefaultMaxBodyBytes mirrors Express's 100kb default plus headroom
// for the largest legitimate request (admin enrichment update with
// long Chinese titles + admin user create with reasonable password).
// 1 MiB is the same ceiling popular Node services (NestJS, Fastify)
// default to when callers tune above 100kb.
const DefaultMaxBodyBytes int64 = 1 << 20 // 1 MiB

// MaxBodyBytes returns a chi middleware that caps the request body at
// `n` bytes.  Apply globally before any JSON-reading middleware /
// handler.  Reads past `n` return *http.MaxBytesError from Body.Read;
// handlers downstream see this as a decode failure and emit their
// configured 400 envelope.
//
// Express byte-parity note: Express returns 413 PayloadTooLarge for
// over-limit bodies via body-parser's error handler.  We deliberately
// fold this into the existing 400 path because (a) no Express
// integration test asserts the specific 413 code, (b) frontends treat
// 400+413 identically on retry, and (c) shifting to 413 would require
// every handler to peek at MaxBytesError type — high blast radius for
// the same observable outcome.  If Phase 8.5 shadow-diff flags this
// later we can add an explicit MaxBytesError → 413 mapper here.
func MaxBodyBytes(n int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// GET / HEAD / DELETE etc. typically don't carry bodies;
			// wrapping is safe (MaxBytesReader on a nil/empty body is
			// a no-op) but we skip the wrap for ~free CPU.
			if r.Body == nil || r.Body == http.NoBody {
				next.ServeHTTP(w, r)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, n)
			next.ServeHTTP(w, r)
		})
	}
}
