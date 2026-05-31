package auth

// cookies.go — refresh token cookie helpers.  httpOnly + sameSite=strict
// in dev, sameSite=none + secure in prod (matches Express's
// auth.controller.js:23-31 setRefreshCookie).
//
// Cookie name is "refreshToken" verbatim; path is site-wide ("/") — see
// refreshCookiePath for why the earlier /api scoping broke SSR refresh.

import (
	"net/http"
	"time"
)

// RefreshCookieName is the cookie key both SetRefreshCookie and
// ClearRefreshCookie write under.  Exported so the refresh handler can
// look up the same key on read.
const RefreshCookieName = "refreshToken"

// refreshCookiePath is site-wide ("/"), matching sessionCookiePath.
//
// It was "/api" (CSRF-surface reduction) but that BROKE the SSR refresh:
// next-app/src/proxy.ts refreshes on page navigations (/, /profile, ...),
// and a /api-scoped cookie is NOT sent on those paths, so proxy.ts could
// never read the current refresh token there — the access token expired,
// the SSR refresh silently failed, and the user got logged out (every
// ~15m once JWT_EXPIRES_IN dropped to 15m). Site-wide path lets every
// page navigation carry the cookie so the rotation stays consistent.
// The cookie stays httpOnly + sameSite=none + secure, so the widened
// path doesn't add XSS exposure; CSRF on /auth/refresh only forces a
// harmless token rotation.
const refreshCookiePath = "/"

// SetRefreshCookie writes the refreshToken cookie with the same
// attributes Express uses:
//
//   - httpOnly: true (no JS access — prevents XSS exfiltration)
//   - secure: prod only (HTTPS-only)
//   - sameSite: prod=none (cross-origin cookies for SSR fetch) / dev=strict
//   - path: "/" (site-wide, so SSR page-nav refresh in proxy.ts works)
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

// sessionCookieName matches Express's P8.1 `session` cookie that
// next-app/src/proxy.ts and RSC layouts read to verify the user.
const sessionCookieName = "session"

// sessionCookiePath is site-wide (empty = "/") so next-app's SSR
// requests to any path carry the cookie.
const sessionCookiePath = "/"

// SetSessionCookie writes the short-lived `session` cookie carrying the
// accessToken.  Mirrors Express auth.controller.js setSessionCookie
// (P8.1).  next-app/src/proxy.ts reads this cookie to gate /admin,
// /library, /player; RSC layouts read it for fetchCurrentUser.
func SetSessionCookie(w http.ResponseWriter, accessToken string, ttl time.Duration, isProd bool) {
	sameSite := http.SameSiteStrictMode
	if isProd {
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    accessToken,
		Path:     sessionCookiePath,
		HttpOnly: true,
		Secure:   isProd,
		SameSite: sameSite,
		MaxAge:   int(ttl.Seconds()),
		Expires:  time.Now().Add(ttl),
	})
}

// ClearSessionCookie expires the session cookie on logout.
func ClearSessionCookie(w http.ResponseWriter, isProd bool) {
	sameSite := http.SameSiteStrictMode
	if isProd {
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     sessionCookiePath,
		HttpOnly: true,
		Secure:   isProd,
		SameSite: sameSite,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
}
