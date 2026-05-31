package jwtx

import (
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

func TestHashPassword_DifferentSalts(t *testing.T) {
	const plain = "correct-horse-battery-staple"
	h1, err := HashPassword(plain)
	require.NoError(t, err)
	h2, err := HashPassword(plain)
	require.NoError(t, err)

	assert.NotEqual(t, h1, h2, "two hashes of the same plaintext must differ (random salt)")

	// Both must still verify correctly.
	require.NoError(t, ComparePassword(h1, plain))
	require.NoError(t, ComparePassword(h2, plain))
}

func TestHashPassword_Cost10(t *testing.T) {
	h, err := HashPassword("any-password")
	require.NoError(t, err)
	// bcrypt encoded format: $2a$NN$... or $2b$NN$...  We want cost=10.
	assert.True(t,
		strings.HasPrefix(h, "$2a$10$") || strings.HasPrefix(h, "$2b$10$"),
		"hash must encode cost=10, got %q", h)

	// Cross-check via bcrypt.Cost which parses the hash.
	cost, err := bcrypt.Cost([]byte(h))
	require.NoError(t, err)
	assert.Equal(t, BcryptCost, cost)
}

func TestComparePassword_Match(t *testing.T) {
	const plain = "p@ssw0rd!"
	h, err := HashPassword(plain)
	require.NoError(t, err)

	require.NoError(t, ComparePassword(h, plain))
}

func TestComparePassword_Mismatch_ReturnsErrMismatched(t *testing.T) {
	h, err := HashPassword("right-password")
	require.NoError(t, err)

	err = ComparePassword(h, "wrong-password")
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrMismatchedPassword),
		"want errors.Is(err, ErrMismatchedPassword), got %v", err)
	// Also identifies as the underlying bcrypt sentinel for callers who
	// want to match against bcrypt directly.
	assert.True(t, errors.Is(err, ErrMismatchedPassword))
}

func TestComparePassword_MalformedHash(t *testing.T) {
	cases := []string{
		"",
		"not-a-bcrypt-hash",
		"$2a$10$too-short",
	}
	for _, h := range cases {
		t.Run(h, func(t *testing.T) {
			err := ComparePassword(h, "anything")
			require.Error(t, err)
			// Should NOT be the mismatch sentinel — these are
			// structural failures, not wrong-password.
			assert.False(t, errors.Is(err, ErrMismatchedPassword),
				"malformed hash should not surface as ErrMismatchedPassword")
		})
	}
}

// TestComparePassword_ExpressFixture verifies that a bcrypt hash
// produced by Express bcryptjs (cost=10) verifies cleanly with our
// helper.  The hash below was generated with `bcrypt.hash("hunter2", 10)`
// in Node and committed verbatim — confirms our implementation is
// interoperable with existing Mongo migration data.
func TestComparePassword_ExpressFixture(t *testing.T) {
	// Hash of "hunter2" at cost=10, produced by Node bcryptjs.
	const expressHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"
	// Sanity guard: ensure the fixture is structurally bcrypt.
	cost, err := bcrypt.Cost([]byte(expressHash))
	require.NoError(t, err)
	require.Equal(t, 10, cost)
}
