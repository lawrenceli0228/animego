// Package pii masks personally identifying information that users have put
// into fields that were never meant to hold it.
//
// The concrete problem this exists for: `users.username` is constrained only
// by length (0001_init.up.sql — CHECK char_length BETWEEN 3 AND 50), so
// nothing stopped people from registering with an email address or a phone
// number.  Some did.  That username is then the public display name AND the
// /u/{username} routing key, so it reaches:
//
//   - GET /api/anime/{id}/watchers          (no auth at all)
//   - GET /api/community/discussions/trending
//   - GET /api/comments/{anilistId}/{episode}
//   - GET /api/comments/summary/{anilistId}
//   - GET /api/users/{username} (+ /followers, /following)
//
// and, worst of all, gets server-rendered into /anime/{id} — a route that is
// ISR-prerendered, Cloudflare edge-cached and indexed by Google.  A contact
// detail baked into a CDN-cached search result is the failure this package
// prevents.
//
// The masking is deliberately narrow: a username that does NOT look like a
// contact detail passes through byte-for-byte.  Only contact-shaped ones are
// replaced, and they are replaced with a *stable, opaque* slug rather than a
// partial redaction — "xi***@qq.com" still discloses the provider and enough
// of the local part to be worth guessing at.
//
// The slug is derived with MD5 rather than SHA-256 on purpose: Postgres ships
// md5() as a core function, so the reverse lookup (slug → user row) can be
// computed in SQL without the pgcrypto extension.  This is not a security
// hash — it is an opaque, collision-resistant-enough label, and the input it
// protects is already known to anyone who can enumerate the user list by
// other means.  Do not reuse it for anything that needs preimage resistance.
package pii

import (
	"crypto/md5"
	"encoding/hex"
	"regexp"
	"strings"
)

// SlugPrefix marks a username that this package generated.  Real usernames
// can technically start with it too, which is why resolution never assumes a
// prefixed value is a slug — it looks the row up and falls back.
const SlugPrefix = "user-"

// slugHexLen is how much of the MD5 hex we keep.  40 bits over a user table
// in the low thousands leaves collision odds negligible, and the lookup
// treats a multi-row match as "not found" rather than guessing.
const slugHexLen = 10

// minDigitRun is the shortest all-digit username treated as a contact
// detail.  QQ numbers run 5-11 digits and mainland mobile numbers are 11, so
// the line sits just under the QQ range: short numeric handles like "2024"
// stay untouched while account identifiers do not.
//
// The asymmetry is deliberate.  Masking a legitimate numeric handle costs
// that user a display name until they rename; failing to mask a QQ number
// publishes a contact address into a CDN-cached, indexed page.
const minDigitRun = 7

// allDigits matches a username made entirely of ASCII digits.
var allDigits = regexp.MustCompile(`^[0-9]+$`)

// LooksLikeContact reports whether username is shaped like a way to contact
// the person behind it.
//
// The email test is intentionally cruder than RFC 5322: any '@' at all is
// treated as an address.  A username has no legitimate reason to contain one,
// and a false positive costs a display name while a false negative costs an
// email address.
func LooksLikeContact(username string) bool {
	u := strings.TrimSpace(username)
	if u == "" {
		return false
	}
	if strings.ContainsRune(u, '@') {
		return true
	}
	return allDigits.MatchString(u) && len(u) >= minDigitRun
}

// Slug returns the opaque public label for username.
//
// It hashes the raw bytes with no case folding, so the value matches
// Postgres `left(md5(username), 10)` exactly.  Lowercasing first would have
// meant relying on Go's Unicode casing and the database collation agreeing,
// which they need not.
func Slug(username string) string {
	sum := md5.Sum([]byte(username))
	return SlugPrefix + hex.EncodeToString(sum[:])[:slugHexLen]
}

// PublicUsername returns the value safe to serialize to an unauthenticated
// caller: username unchanged, or its slug when it is contact-shaped.
//
// Call this at the serialization boundary of every public response.  Do NOT
// call it for the caller's own account (/api/auth/me, /api/account) or for
// admin views — those need the real value to be usable.
func PublicUsername(username string) string {
	if LooksLikeContact(username) {
		return Slug(username)
	}
	return username
}

// PublicUsernamePtr is PublicUsername for the optional-username fields
// (reply_to_username, report target, and friends).  nil passes through.
func PublicUsernamePtr(username *string) *string {
	if username == nil {
		return nil
	}
	masked := PublicUsername(*username)
	return &masked
}
