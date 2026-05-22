package auth

// cookies.go — refresh token cookie helpers.  httpOnly + sameSite=strict
// in dev, sameSite=none + secure in prod (matches Express's
// auth.controller.js:23-31 setRefreshCookie).
//
// Cookie name is "refreshToken" verbatim; the path is scoped to /api so
// the cookie never travels with static asset requests (CSRF surface
// reduction).

import (
	"net/http"
	"time"
)

// RefreshCookieName is the cookie key both SetRefreshCookie and
// ClearRefreshCookie write under.  Exported so the refresh handler can
// look up the same key on read.
const RefreshCookieName = "refreshToken"

// refreshCookiePath scopes the cookie to /api so it isn't sent with
// page navigations or static asset GETs.  Reduces CSRF surface vs a
// site-wide cookie.
const refreshCookiePath = "/api"

// SetRefreshCookie writes the refreshToken cookie with the same
// attributes Express uses:
//
//   - httpOnly: true (no JS access — prevents XSS exfiltration)
//   - secure: prod only (HTTPS-only)
//   - sameSite: prod=none (cross-origin cookies for SSR fetch) / dev=strict
//   - path: /api (scoped to API — minimizes CSRF surface)
//   - maxAge: ttl seconds (caller passes the same JWT_REFRESH_EXPIRES_IN
//     used to sign the token so both expire together)
//
// isProd: pass true when NODE_ENV-equivalent is "production".  Caller
// derives this from config (e.g. os.Getenv("GO_ENV") == "production").
func SetRefreshCookie(w http.ResponseWriter, token string, ttl time.Duration, isProd bool) {
	sameSite := http.SameSiteStrictMode
	if isProd {
		// SameSite=None requires Secure; this is enforced by every
		// modern browser.  isProd implies Secure=true below.
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{
		Name:     RefreshCookieName,
		Value:    token,
		Path:     refreshCookiePath,
		HttpOnly: true,
		Secure:   isProd,
		SameSite: sameSite,
		MaxAge:   int(ttl.Seconds()),
		Expires:  time.Now().Add(ttl),
	})
}

// ClearRefreshCookie expires the refreshToken cookie.  Used by /logout
// to invalidate the client-side reference; the DB-side refresh_token
// column is independently nulled by the handler.
//
// Browsers only honor the Set-Cookie delete if path + sameSite + secure
// match the original Set-Cookie attributes, so we mirror SetRefreshCookie
// here with MaxAge=-1 and an empty value.
func ClearRefreshCookie(w http.ResponseWriter, isProd bool) {
	sameSite := http.SameSiteStrictMode
	if isProd {
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{
		Name:     RefreshCookieName,
		Value:    "",
		Path:     refreshCookiePath,
		HttpOnly: true,
		Secure:   isProd,
		SameSite: sameSite,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
}
