package activity

// middleware.go -- the unforgeable half of the activity record.
//
// Every authenticated call to /api/* is one datum: this account existed on the
// other end of a request at this instant.  It is derived from a signed access
// token the server itself issued, so unlike the beacon it cannot be inflated
// by anybody who does not already hold a valid session -- which is why
// DAU/WAU/MAU, visit days and retention are all computed from what this
// middleware writes and none of them read the beacon's table.

import (
	"net/http"
	"strings"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// Middleware records one request per authenticated caller.
//
// MOUNT IT ONCE, AT THE TOP OF THE ROUTER.  Mounting it inside each
// authenticated r.Route block would be correct today and quietly wrong the
// first time somebody adds a route group without knowing this exists —
// coverage that depends on remembering is coverage that decays.
//
// The awkward part is that a top-level middleware runs BEFORE the route-scoped
// RequireAuth / OptionalAuth that attaches claims, and cannot reach the inner
// context they build.  So it leaves a jwtx.ClaimsSink in the context on the way
// down and reads it on the way back up: the auth middleware stores the claims
// it already verified, and this one costs a pointer load instead of ~8.5µs and
// 49 allocations of duplicate crypto.  See jwtx.WithClaimsSink.
//
// WHAT IT COSTS, AS MEASURED DELTAS (BenchmarkMiddleware, middleware_test.go,
// against the same handler without this middleware in front of it):
//
//	anonymous           +51ns, ZERO allocations.  A path prefix check and a
//	                    token lookup that finds nothing.  This is the majority
//	                    of traffic on a search-led catalogue and it has to
//	                    stay free.
//	authed, auth route  +1.3µs / +3 allocations.  The sink: a context value, a
//	                    request copy, a pointer load, a map write.  No crypto —
//	                    RequireAuth had already done it.
//	authed, public route
//	                    +7.4µs / +52 allocations, almost all of it one HMAC
//	                    verification, because on a route with no auth
//	                    middleware nothing else was going to verify the token.
//	                    Not duplicate work; see the fallback below for why
//	                    skipping it would undercount DAU rather than merely
//	                    lose detail.
//
// For scale: every handler behind this then queries Postgres, which is two to
// three orders of magnitude more than the largest figure above.
//
// It never blocks, never writes to the response, and never fails a request.
// No database work happens here at all — the recorder buffers in memory and
// flushes from a background goroutine once a minute.
func Middleware(signer *jwtx.Signer, rec *Recorder) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		// A nil recorder or signer means this deployment is not recording.
		// Return the handler untouched rather than a wrapper that checks nil
		// on every request.
		if rec == nil || signer == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Two cheap rejections before any allocation.  HasToken is header
			// and cookie reads with no crypto, so an anonymous request leaves
			// here having allocated nothing.
			if !shouldRecordPath(r.URL.Path) || !jwtx.HasToken(r) {
				next.ServeHTTP(w, r)
				return
			}

			ctx, sink := jwtx.WithClaimsSink(r.Context())
			next.ServeHTTP(w, r.WithContext(ctx))

			// Read AFTER the handler: the sink is filled by the route's own
			// auth middleware, which runs inside this call.
			if claims := sink.Claims(); claims != nil {
				rec.Touch(claims.UserID, time.Now())
				return
			}

			// The sink is empty for two different reasons and only one of them
			// means "anonymous".
			//
			// Plenty of routes here are public and mount no auth middleware at
			// all — /api/anime/*, /api/danmaku/*, /api/dandanplay/*.  A signed-in
			// reader browsing the catalogue sends their cookie to those routes
			// and nothing ever verifies it, so relying on the sink alone would
			// drop exactly the traffic pattern this feature exists to measure:
			// somebody who reads and does not interact.  DAU would undercount
			// the quiet majority and nobody would be able to tell.
			//
			// So the sink is an optimisation, not the mechanism.  On a miss we
			// verify — which on a public route is not duplicate work, it is the
			// only verification that happens.  Anonymous requests never reach
			// here (HasToken filtered them above), so the cost lands only on
			// requests that really do carry a credential.
			if claims, ok := jwtx.ClaimsFromRequest(signer, r); ok && claims != nil {
				rec.Touch(claims.UserID, time.Now())
			}
		})
	}
}

// shouldRecordPath decides which paths count as presence.
//
// Only /api/*, and not the health probe.  The probe is the load balancer, not
// a person -- it carries no token today, so it would be filtered by the claims
// check anyway, but relying on that would make the exclusion an accident of
// how the probe is configured rather than a decision.
//
// Everything else under /api/ is in, including refresh and SSR fan-out.  That
// is on purpose: a server-rendered page fetching four endpoints is still one
// human asking for one page, and the alternative -- guessing which calls are
// "real" -- would put a policy about what counts as engagement inside a
// middleware.  request_count is documented as a request count for exactly this
// reason; the number of PEOPLE, which is what every headline metric on the
// dashboard reports, is unaffected by fan-out because a person is counted once
// per day no matter how many rows their requests touch.
func shouldRecordPath(path string) bool {
	if !strings.HasPrefix(path, "/api/") {
		return false
	}
	return path != "/api/health"
}
