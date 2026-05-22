package jwtx

// bcrypt.go — password hashing + comparison.  Cost=10 matches the
// Express bcryptjs default + the existing Mongo migration data, so
// hashes produced by the legacy stack verify cleanly here without
// forcing a re-hash on next login.

import (
	"errors"
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

// BcryptCost is the bcrypt work factor used for new password hashes.
// Locked to 10 to match Express bcryptjs default + existing user rows;
// changing this would force a password reset for every existing user.
const BcryptCost = 10

// ErrMismatchedPassword is returned by ComparePassword when the hash
// doesn't match the supplied plaintext.  Wraps
// bcrypt.ErrMismatchedHashAndPassword so callers can errors.Is against
// either identifier.
var ErrMismatchedPassword = errors.New("jwtx: password does not match hash")

// HashPassword bcrypt-hashes the plaintext password using BcryptCost.
// Returns the standard "$2a$10$..." encoded hash suitable for storage
// in users.password.
func HashPassword(plain string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), BcryptCost)
	if err != nil {
		return "", fmt.Errorf("jwtx: bcrypt hash: %w", err)
	}
	return string(hash), nil
}

// ComparePassword verifies plain against the stored hash.  Returns nil
// on match, ErrMismatchedPassword on mismatch, or a wrapped bcrypt
// error on malformed hash input.
//
// Uses bcrypt.CompareHashAndPassword under the hood, which is
// constant-time with respect to the secret comparison.
func ComparePassword(hash, plain string) error {
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)); err != nil {
		if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
			return ErrMismatchedPassword
		}
		return fmt.Errorf("jwtx: bcrypt compare: %w", err)
	}
	return nil
}
