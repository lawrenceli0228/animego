package jwtx

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testSecrets are non-empty fixture secrets used across all jwt tests.
// Two distinct values so accidental cross-use (signing with access,
// verifying with refresh) fails loudly in tests just like in prod.
const (
	testAccessSecret  = "test-access-secret-do-not-use-in-prod"
	testRefreshSecret = "test-refresh-secret-do-not-use-in-prod"
)

func newTestSigner(t *testing.T) *Signer {
	t.Helper()
	s, err := NewSigner(testAccessSecret, testRefreshSecret, 15*time.Minute, 7*24*time.Hour)
	require.NoError(t, err)
	return s
}

func TestNewSigner_EmptySecret_ReturnsError(t *testing.T) {
	cases := []struct {
		name   string
		access string
		refr   string
	}{
		{"both empty", "", ""},
		{"access empty", "", "r"},
		{"refresh empty", "a", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, err := NewSigner(tc.access, tc.refr, time.Minute, time.Hour)
			require.ErrorIs(t, err, ErrEmptySecret)
			require.Nil(t, s)
		})
	}
}

func TestSignAccess_HappyPath(t *testing.T) {
	s := newTestSigner(t)
	userID := uuid.New()
	role := "admin"

	tok, err := s.SignAccess(userID, "alice", &role)
	require.NoError(t, err)
	require.NotEmpty(t, tok)

	claims, err := s.VerifyAccess(tok)
	require.NoError(t, err)
	assert.Equal(t, userID, claims.UserID)
	assert.Equal(t, "alice", claims.Username)
	require.NotNil(t, claims.Role)
	assert.Equal(t, "admin", *claims.Role)
	// iat + exp populated
	require.NotNil(t, claims.IssuedAt)
	require.NotNil(t, claims.ExpiresAt)
	assert.True(t, claims.ExpiresAt.After(claims.IssuedAt.Time))
}

// decodeJWTPayload returns the raw JSON object of the JWT's payload
// segment.  Used to verify that nil Role omits the key entirely rather
// than serialising as null.
func decodeJWTPayload(t *testing.T, tok string) map[string]any {
	t.Helper()
	parts := strings.Split(tok, ".")
	require.Len(t, parts, 3, "expected header.payload.signature")
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(t, err)
	out := map[string]any{}
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

func TestSignAccess_Role_Nil_OmittedFromJSON(t *testing.T) {
	s := newTestSigner(t)
	tok, err := s.SignAccess(uuid.New(), "bob", nil)
	require.NoError(t, err)

	payload := decodeJWTPayload(t, tok)
	_, present := payload["role"]
	assert.False(t, present, "role key must be absent when nil")
	// Sanity: other fields should be present.
	assert.Contains(t, payload, "userId")
	assert.Contains(t, payload, "username")
}

func TestSignAccess_Role_NonNil_PresentInJSON(t *testing.T) {
	s := newTestSigner(t)
	role := "user"
	tok, err := s.SignAccess(uuid.New(), "carol", &role)
	require.NoError(t, err)

	payload := decodeJWTPayload(t, tok)
	assert.Equal(t, "user", payload["role"])
}

func TestSignRefresh_HappyPath(t *testing.T) {
	s := newTestSigner(t)
	userID, sid := uuid.New(), uuid.New()

	issued, err := s.SignRefresh(userID, sid)
	require.NoError(t, err)

	claims, err := s.VerifyRefresh(issued.Token)
	require.NoError(t, err)
	assert.Equal(t, userID, claims.UserID)
	assert.Equal(t, sid, claims.SessionID)
	assert.Equal(t, issued.JTI.String(), claims.ID)
	require.NotNil(t, claims.ExpiresAt)
	assert.True(t, issued.ExpiresAt.Equal(claims.ExpiresAt.Time), "IssuedRefresh.ExpiresAt is the token's exp")
	assert.True(t, issued.IssuedAt.Equal(claims.IssuedAt.Time), "IssuedRefresh.IssuedAt is the token's iat")
	assert.Zero(t, issued.IssuedAt.Nanosecond(), "stored times carry the token's one-second precision")
}

// Two logins in the same second used to sign byte-identical refresh tokens
// (claims were only userId/iat/exp), so per-device rows keyed by token hash
// could not tell the two devices apart.  The jti makes every token distinct.
func TestSignRefresh_SameSecondTokensDiffer(t *testing.T) {
	s := newTestSigner(t)
	userID, sid := uuid.New(), uuid.New()

	a, err := s.SignRefresh(userID, sid)
	require.NoError(t, err)
	b, err := s.SignRefresh(userID, sid)
	require.NoError(t, err)

	assert.NotEqual(t, a.Token, b.Token)
	assert.NotEqual(t, a.JTI, b.JTI)
}

func TestSignRefresh_NilSession_Refused(t *testing.T) {
	s := newTestSigner(t)

	_, err := s.SignRefresh(uuid.New(), uuid.Nil)

	assert.ErrorIs(t, err, ErrNoSession)
}

// The grace window re-sends a session's current token without that token
// being stored: it is rebuilt from the stored claims.  That only works if
// signing is byte-for-byte reproducible.
func TestResignRefresh_ReproducesTheToken(t *testing.T) {
	s := newTestSigner(t)
	userID, sid := uuid.New(), uuid.New()
	issued, err := s.SignRefresh(userID, sid)
	require.NoError(t, err)

	// Round-trip the times the way Postgres would hand them back: same
	// instant, different location, no monotonic reading.
	iat := issued.IssuedAt.In(time.FixedZone("UTC+8", 8*3600)).Round(0)
	exp := issued.ExpiresAt.UTC()
	again, err := s.ResignRefresh(userID, sid, issued.JTI, iat, exp)
	require.NoError(t, err)

	assert.Equal(t, issued.Token, again)
}

func TestResignRefresh_DifferentJTIDiffers(t *testing.T) {
	s := newTestSigner(t)
	userID, sid := uuid.New(), uuid.New()
	issued, err := s.SignRefresh(userID, sid)
	require.NoError(t, err)

	other, err := s.ResignRefresh(userID, sid, uuid.New(), issued.IssuedAt, issued.ExpiresAt)
	require.NoError(t, err)

	assert.NotEqual(t, issued.Token, other)
}

// A refresh token minted before per-device sessions has no sid and no jti.
// It must still verify, and read as SessionID == uuid.Nil so the handler
// takes the legacy path.
func TestVerifyRefresh_LegacyTokenHasNilSession(t *testing.T) {
	s := newTestSigner(t)
	userID := uuid.New()
	now := time.Now()
	legacy := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId": userID.String(),
		"iat":    now.Unix(),
		"exp":    now.Add(time.Hour).Unix(),
	})
	tok, err := legacy.SignedString([]byte(testRefreshSecret))
	require.NoError(t, err)

	claims, err := s.VerifyRefresh(tok)
	require.NoError(t, err)

	assert.Equal(t, userID, claims.UserID)
	assert.Equal(t, uuid.Nil, claims.SessionID)
	assert.Empty(t, claims.ID)
}

func TestVerifyAccess_Expired_Returns_ErrTokenExpired(t *testing.T) {
	// Negative TTL → token is already expired at sign time.
	s, err := NewSigner(testAccessSecret, testRefreshSecret, -1*time.Second, time.Hour)
	require.NoError(t, err)

	tok, err := s.SignAccess(uuid.New(), "expired-user", nil)
	require.NoError(t, err)

	_, err = s.VerifyAccess(tok)
	require.Error(t, err)
	assert.True(t, errors.Is(err, jwt.ErrTokenExpired), "want errors.Is(err, jwt.ErrTokenExpired), got %v", err)
}

func TestVerifyAccess_WrongSecret(t *testing.T) {
	signer := newTestSigner(t)
	tok, err := signer.SignAccess(uuid.New(), "dave", nil)
	require.NoError(t, err)

	other, err := NewSigner("different-access-secret", testRefreshSecret, time.Minute, time.Hour)
	require.NoError(t, err)

	_, err = other.VerifyAccess(tok)
	require.Error(t, err)
	assert.True(t, errors.Is(err, jwt.ErrSignatureInvalid),
		"want errors.Is(err, jwt.ErrSignatureInvalid), got %v", err)
}

func TestVerifyAccess_Malformed(t *testing.T) {
	s := newTestSigner(t)
	cases := []string{
		"not.a.jwt",
		"",
		"garbage",
		"a.b",         // missing signature segment
		"a.b.c.extra", // too many segments
	}
	for _, tok := range cases {
		t.Run(tok, func(t *testing.T) {
			_, err := s.VerifyAccess(tok)
			require.Error(t, err)
		})
	}
}

func TestVerifyAccess_AlgNone_Rejected(t *testing.T) {
	// Construct a token signed with alg=none.  An attacker who knows
	// the verifier accepts any algorithm can swap to "none" and bypass
	// the HMAC check entirely.  Our keyFunc must reject this.
	claims := AccessClaims{
		UserID:   uuid.New(),
		Username: "attacker",
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	signed, err := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
	require.NoError(t, err)

	s := newTestSigner(t)
	_, err = s.VerifyAccess(signed)
	require.Error(t, err, "alg=none must be rejected")
	// Library-level signal that the signing method was rejected.
	assert.True(t,
		errors.Is(err, jwt.ErrTokenSignatureInvalid) ||
			errors.Is(err, jwt.ErrTokenUnverifiable) ||
			strings.Contains(err.Error(), "unexpected signing method"),
		"want alg-confusion rejection, got %v", err)
}

func TestVerifyAccess_AlgRS256_Rejected(t *testing.T) {
	// Tokens claiming RS256 are also rejected — keyFunc only accepts
	// *jwt.SigningMethodHMAC.  Build by hand so we don't need to pull
	// in an RSA key just for this assertion.
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"userId":"00000000-0000-0000-0000-000000000000","username":"x","exp":9999999999}`))
	// Signature is junk — keyFunc should reject before signature check.
	sig := base64.RawURLEncoding.EncodeToString([]byte("fake-sig"))
	tok := header + "." + payload + "." + sig

	s := newTestSigner(t)
	_, err := s.VerifyAccess(tok)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unexpected signing method")
}

func TestSignAccess_Username_Roundtrip_Unicode(t *testing.T) {
	s := newTestSigner(t)
	cases := []string{
		"用户一",
		"日本語ユーザ",
		"emoji-🌸-user",
		"plain-ascii",
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			tok, err := s.SignAccess(uuid.New(), name, nil)
			require.NoError(t, err)
			claims, err := s.VerifyAccess(tok)
			require.NoError(t, err)
			assert.Equal(t, name, claims.Username)
		})
	}
}

func TestSignRefresh_CrossSecret_Rejected(t *testing.T) {
	// A refresh token signed with the refresh secret must NOT verify
	// against the access secret (distinct secrets is the whole point).
	s := newTestSigner(t)
	refreshTok, err := s.SignRefresh(uuid.New(), uuid.New())
	require.NoError(t, err)

	_, err = s.VerifyAccess(refreshTok.Token)
	require.Error(t, err, "refresh token must not verify as access")
}
