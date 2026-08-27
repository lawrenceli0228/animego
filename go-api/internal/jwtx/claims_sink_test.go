package jwtx

// claims_sink_test.go -- the security invariant behind ClaimsSink.
//
// The sink exists so an outer middleware can learn who made a request without
// verifying the token a second time.  It carries claims OUT of the auth
// middleware.  It must never be able to carry them IN: if writing to a sink
// could make ClaimsFrom return claims, then any package that can obtain a sink
// could fabricate an authenticated request context, and every RequireAuth-
// gated handler downstream would believe it.
//
// That property is currently true because withClaims stores under a separate,
// unexported key and the sink only ever receives a copy of the pointer.  It is
// exactly the kind of property that stays true until somebody "simplifies" the
// two keys into one -- silently, with every test still green.  Hence this file.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func sinkTestSigner(t *testing.T) *Signer {
	t.Helper()
	s, err := NewSigner("access-secret-for-tests", "refresh-secret-for-tests", 15*time.Minute, 7*24*time.Hour)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	return s
}

// TestClaimsSink_WritingToASinkDoesNotAuthenticate is the invariant.
func TestClaimsSink_WritingToASinkDoesNotAuthenticate(t *testing.T) {
	ctx, sink := WithClaimsSink(context.Background())

	forged := &AccessClaims{UserID: uuid.New(), Username: "attacker"}
	sink.claims.Store(forged)

	if claims, ok := ClaimsFrom(ctx); ok || claims != nil {
		t.Fatalf("a sink write authenticated the context: ok=%v claims=%v", ok, claims)
	}
	// The sink itself still reports what was stored -- it is an observation
	// channel, and that is fine.  What must not happen is the line above.
	if sink.Claims() != forged {
		t.Fatal("sink lost the value it was given")
	}
}

// TestClaimsSink_FilledByRequireAuth covers the intended direction: the auth
// middleware publishes the claims it verified, so an outer observer can read
// them after the handler returns without repeating the HMAC.
func TestClaimsSink_FilledByRequireAuth(t *testing.T) {
	signer := sinkTestSigner(t)
	userID := uuid.New()
	token, err := signer.SignAccess(userID, "tester", nil)
	if err != nil {
		t.Fatalf("SignAccess: %v", err)
	}

	ctx, sink := WithClaimsSink(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/subscriptions", nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+token)

	var innerSaw uuid.UUID
	h := RequireAuth(signer)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		if c, ok := ClaimsFrom(r.Context()); ok {
			innerSaw = c.UserID
		}
	}))
	h.ServeHTTP(httptest.NewRecorder(), req)

	if innerSaw != userID {
		t.Fatalf("handler saw %s, want %s", innerSaw, userID)
	}
	got := sink.Claims()
	if got == nil {
		t.Fatal("sink was not filled by RequireAuth")
	}
	if got.UserID != userID {
		t.Fatalf("sink holds %s, want %s", got.UserID, userID)
	}
}

// TestClaimsSink_StaysEmptyForAnonymousAndForgedTokens.
//
// The whole value of reading the sink instead of re-verifying is that it is
// filled ONLY by a middleware that already checked the signature.  If a bad
// token could fill it, presence would be attributable by anyone who can guess
// a uuid.
func TestClaimsSink_StaysEmptyForAnonymousAndForgedTokens(t *testing.T) {
	signer := sinkTestSigner(t)
	other, err := NewSigner("a-different-secret", "another-one", time.Minute, time.Hour)
	if err != nil {
		t.Fatalf("NewSigner: %v", err)
	}
	foreign, err := other.SignAccess(uuid.New(), "elsewhere", nil)
	if err != nil {
		t.Fatalf("SignAccess: %v", err)
	}

	cases := []struct {
		name   string
		header string
	}{
		{"no token", ""},
		{"garbage token", "Bearer not.a.real.token"},
		{"validly-shaped token signed by someone else", "Bearer " + foreign},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, sink := WithClaimsSink(context.Background())
			req := httptest.NewRequest(http.MethodGet, "/api/subscriptions", nil).WithContext(ctx)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			// OptionalAuth rather than RequireAuth so the request reaches the
			// end of the chain in every case and the sink gets its chance.
			OptionalAuth(signer)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
				ServeHTTP(httptest.NewRecorder(), req)

			if got := sink.Claims(); got != nil {
				t.Fatalf("sink was filled for %s: %v", tc.name, got)
			}
		})
	}
}

// TestClaimsSink_IsPerRequest.  Two requests must not see each other's
// claims; the sink is created fresh by WithClaimsSink and never shared.
func TestClaimsSink_IsPerRequest(t *testing.T) {
	_, first := WithClaimsSink(context.Background())
	_, second := WithClaimsSink(context.Background())
	if first == second {
		t.Fatal("WithClaimsSink returned the same sink twice")
	}
	first.claims.Store(&AccessClaims{UserID: uuid.New()})
	if second.Claims() != nil {
		t.Fatal("a write to one sink was visible in another")
	}
}

// TestClaimsSink_NilReceiver: Middleware reads the sink after the handler
// returns, on a path where an earlier guard may have left it nil.
func TestClaimsSink_NilReceiver(t *testing.T) {
	var s *ClaimsSink
	if s.Claims() != nil {
		t.Fatal("nil sink returned claims")
	}
}

// TestHasToken covers the cheap pre-filter that keeps anonymous requests at
// zero allocations: it must find every shape extractToken accepts and invent
// nothing.
func TestHasToken(t *testing.T) {
	cases := []struct {
		name string
		set  func(*http.Request)
		want bool
	}{
		{"nothing", func(*http.Request) {}, false},
		{"bearer header", func(r *http.Request) { r.Header.Set("Authorization", "Bearer x") }, true},
		{"empty bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer ") }, false},
		{"non-bearer header", func(r *http.Request) { r.Header.Set("Authorization", "Basic abc") }, false},
		{"accessToken cookie", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: "x"})
		}, true},
		{"session cookie", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "x"})
		}, true},
		{"unrelated cookie", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: "theme", Value: "dark"})
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			tc.set(req)
			if got := HasToken(req); got != tc.want {
				t.Fatalf("HasToken = %v, want %v", got, tc.want)
			}
		})
	}
	if HasToken(nil) {
		t.Fatal("HasToken(nil) must be false")
	}
}
