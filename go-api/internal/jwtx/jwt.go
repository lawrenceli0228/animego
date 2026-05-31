// Package jwtx — JWT signing/verification (HS256) + bcrypt password
// hashing + HTTP middleware that recognizes both Authorization Bearer
// headers and an accessToken cookie (dual-accept for the 7-day cutover
// from header-only Express to cookie-first Go SSR).
//
// Two separate HS256 secrets: JWT_SECRET (access) + JWT_REFRESH_SECRET
// (refresh).  Using distinct secrets means a leaked access token can't
// be re-signed as a refresh.  Lifetimes are configurable per Signer
// (callers wire env vars JWT_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN with
// Express defaults 15m / 7d at the call site).
//
// Token claims:
//
//	Access:  { userId, username, role?, exp, iat }
//	Refresh: { userId, exp, iat }
//
// Role is OMITTED from the JSON payload when nil (Express:
// `if (role) payload.role = role`).  We model it as *string so the
// json:"role,omitempty" tag drops the key entirely on nil.
package jwtx

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// AccessClaims is the JWT payload for short-lived access tokens.  Embeds
// jwt.RegisteredClaims so exp/iat/nbf are validated by the library.
type AccessClaims struct {
	UserID   uuid.UUID `json:"userId"`
	Username string    `json:"username"`
	Role     *string   `json:"role,omitempty"`
	jwt.RegisteredClaims
}

// RefreshClaims is the JWT payload for refresh tokens — userId only.
// No username/role so a leaked refresh can't be used to forge an
// access-shaped payload.
type RefreshClaims struct {
	UserID uuid.UUID `json:"userId"`
	jwt.RegisteredClaims
}

// Signer holds the two HS256 secrets + TTLs.  Construct once at startup
// from env vars (or test fixtures) and inject into handlers.
type Signer struct {
	accessSecret  []byte
	refreshSecret []byte
	accessTTL     time.Duration
	refreshTTL    time.Duration
}

// ErrEmptySecret is returned by NewSigner when either secret is the
// empty string.  Signing with an empty key would silently produce a
// token anyone with the same library could forge — fail loudly instead.
var ErrEmptySecret = errors.New("jwtx: secret is empty")

// NewSigner constructs a Signer.  Both secrets must be non-empty;
// either being empty returns ErrEmptySecret.  TTLs are not validated
// here — a negative TTL is a useful test fixture for expiry behavior.
func NewSigner(accessSecret, refreshSecret string, accessTTL, refreshTTL time.Duration) (*Signer, error) {
	if accessSecret == "" || refreshSecret == "" {
		return nil, ErrEmptySecret
	}
	return &Signer{
		accessSecret:  []byte(accessSecret),
		refreshSecret: []byte(refreshSecret),
		accessTTL:     accessTTL,
		refreshTTL:    refreshTTL,
	}, nil
}

// SignAccess produces a short-lived access token.  role may be nil; when
// nil it's omitted from the JSON payload entirely (matches Express's
// `if (role) payload.role = role`).
func (s *Signer) SignAccess(userID uuid.UUID, username string, role *string) (string, error) {
	now := time.Now()
	claims := AccessClaims{
		UserID:   userID,
		Username: username,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.accessTTL)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(s.accessSecret)
	if err != nil {
		return "", fmt.Errorf("jwtx: sign access token: %w", err)
	}
	return signed, nil
}

// SignRefresh produces a refresh token carrying only the userID.  TTL
// comes from the Signer (Express default 7d).
func (s *Signer) SignRefresh(userID uuid.UUID) (string, error) {
	now := time.Now()
	claims := RefreshClaims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.refreshTTL)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(s.refreshSecret)
	if err != nil {
		return "", fmt.Errorf("jwtx: sign refresh token: %w", err)
	}
	return signed, nil
}

// VerifyAccess parses + validates an access token.  Returns the claims
// or an error.  Callers may use errors.Is(err, jwt.ErrTokenExpired) /
// jwt.ErrSignatureInvalid / jwt.ErrTokenMalformed to distinguish modes;
// HTTP middleware collapses all failures to a generic 401 to avoid
// leaking specific reasons to the network.
func (s *Signer) VerifyAccess(token string) (*AccessClaims, error) {
	return verify[AccessClaims](token, s.accessSecret)
}

// VerifyRefresh — analogous, against the refresh secret.
func (s *Signer) VerifyRefresh(token string) (*RefreshClaims, error) {
	return verify[RefreshClaims](token, s.refreshSecret)
}

// verify is the shared parse path.  Asserts the token's alg is HS256
// before handing the secret bytes to the library — defends against the
// classic alg-confusion attack where an attacker swaps alg to "none"
// or to an asymmetric variant and tries to bypass HMAC verification.
//
// The Claims type parameter must be a pointer-implementer of
// jwt.Claims; we pass &out so ParseWithClaims can populate it.
func verify[C any](token string, secret []byte) (*C, error) {
	var out C
	// We need a *C that also satisfies jwt.Claims.  Both AccessClaims
	// and RefreshClaims embed jwt.RegisteredClaims which implements
	// jwt.Claims, and a pointer to either type therefore satisfies the
	// interface.
	claims := any(&out).(jwt.Claims)
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		// Alg-confusion defense: reject anything that isn't HS256.
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("jwtx: unexpected signing method: %v", t.Header["alg"])
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}
	if !parsed.Valid {
		return nil, jwt.ErrTokenInvalidClaims
	}
	return &out, nil
}
