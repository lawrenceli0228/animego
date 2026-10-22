package jwtx

// session.go — refusing an access token whose session has ended.
//
// An access token verifies on its own for its whole 15 minutes.  Without a
// lookup, ending a session (logout, signing a device out from the settings
// page, a password change, eviction past the per-user session cap) only
// stopped that device at its next refresh: it stayed signed in until the
// token ran out.  With a SessionChecker attached, RequireAuth and
// OptionalAuth ask whether the session the token names still stands, so the
// device is signed out on its next request.

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// SessionChecker reports whether a user's session is still live.
type SessionChecker interface {
	SessionLive(ctx context.Context, sessionID, userID uuid.UUID) (bool, error)
}

// WithSessionCheck returns a copy of s whose RequireAuth and OptionalAuth
// refuse tokens whose session c no longer finds.  s itself is unchanged.
func (s *Signer) WithSessionCheck(c SessionChecker) *Signer {
	cp := *s
	cp.sessions = c
	return &cp
}

// sessionCheckTimeout bounds the lookup so a stalled database turns into a
// 500 rather than a request that hangs on its middleware.
const sessionCheckTimeout = 2 * time.Second

type sessionVerdict int

const (
	sessionLive    sessionVerdict = iota
	sessionEnded                  // the session is gone or expired
	sessionUnknown                // the lookup itself failed
)

// checkSession answers for the session c names.  A token that names none —
// minted before access tokens carried a sid — is not looked up: it cannot
// be, and it runs out within the access TTL anyway.
func (s *Signer) checkSession(ctx context.Context, c *AccessClaims) sessionVerdict {
	if s.sessions == nil || c.SessionID == uuid.Nil {
		return sessionLive
	}
	ctx, cancel := context.WithTimeout(ctx, sessionCheckTimeout)
	defer cancel()
	live, err := s.sessions.SessionLive(ctx, c.SessionID, c.UserID)
	switch {
	case err != nil:
		slog.WarnContext(ctx, "jwtx: session check failed", "err", err)
		return sessionUnknown
	case !live:
		return sessionEnded
	}
	return sessionLive
}
