// Package config loads runtime configuration from environment variables.
//
// P0 scope: just PORT_GO + DATABASE_URL + JWT_SECRET placeholders.  Each
// phase adds the fields it actually consumes:
//   - P2.1 anime endpoints: ANILIST_TOKEN, ristretto sizing
//   - P2.2 auth: JWT_REFRESH_SECRET, JWT_EXPIRES_IN, GMAIL_USER/PASSWORD
//   - P2.6 dandanplay: DANDANPLAY_APP_ID, DANDANPLAY_APP_SECRET
//   - P8 prod: SENTRY_DSN, R2 backup creds (in /etc/secrets, not env)
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds runtime values read from the process environment.
// Zero values are safe defaults for local dev only.
type Config struct {
	// Port for the HTTP server.  Default 8080.
	Port int

	// DatabaseURL is the libpq-style connection string consumed by pgxpool.
	// Default points at the dev docker-compose Postgres.
	DatabaseURL string

	// JWTSecret is the HS256 signing secret for access tokens — shared
	// with the Next.js middleware (which verifies tokens) and the
	// ws-server (which verifies socket auth).  P2.2 requires this.
	JWTSecret string

	// JWTRefreshSecret is a separate HS256 secret for refresh tokens.
	// Using a distinct secret means a leaked access token can't be
	// re-signed as a refresh.  Required from P2.2 onward.
	JWTRefreshSecret string

	// JWTExpiresIn is the access-token lifetime.  Default 15 minutes
	// (matches Express JWT_EXPIRES_IN default).  Override via env to
	// shorten in prod or extend during local dev.
	JWTExpiresIn time.Duration

	// JWTRefreshExpiresIn is the refresh-token lifetime.  Default 7
	// days.  Same cookie maxAge is set when the token is issued.
	JWTRefreshExpiresIn time.Duration

	// GmailUser + GmailAppPassword — credentials for transactional
	// email (password reset).  Both empty → email sending is skipped
	// (forgot-password still returns 200 to avoid enumeration), matches
	// Express's behavior when env vars are unset.
	GmailUser        string
	GmailAppPassword string

	// ClientOrigin is the CORS allow-list for dev.  Production overrides via env.
	ClientOrigin string
}

// Load reads environment variables and returns a Config.
// Returns an error if a required value fails to parse.  Missing optional
// values fall back to dev defaults.
func Load() (*Config, error) {
	port, err := envInt("PORT_GO", 8080)
	if err != nil {
		return nil, err
	}

	dbURL := getEnv(
		"DATABASE_URL",
		"postgres://animego:devpassword@localhost:5432/animego?sslmode=disable",
	)

	accessTTL, err := envDuration("JWT_EXPIRES_IN", 15*time.Minute)
	if err != nil {
		return nil, err
	}
	refreshTTL, err := envDuration("JWT_REFRESH_EXPIRES_IN", 7*24*time.Hour)
	if err != nil {
		return nil, err
	}

	return &Config{
		Port:                port,
		DatabaseURL:         dbURL,
		JWTSecret:           os.Getenv("JWT_SECRET"),
		JWTRefreshSecret:    os.Getenv("JWT_REFRESH_SECRET"),
		JWTExpiresIn:        accessTTL,
		JWTRefreshExpiresIn: refreshTTL,
		GmailUser:           os.Getenv("GMAIL_USER"),
		GmailAppPassword:    os.Getenv("GMAIL_APP_PASSWORD"),
		ClientOrigin:        getEnv("CLIENT_ORIGIN", "http://localhost:3000"),
	}, nil
}

// envDuration parses a Go duration string ("15m", "7d" via custom 'd' handling).
// time.ParseDuration doesn't understand 'd' for days — special-case it
// since Express uses '7d' / '15m' shorthand and shipping the same env
// var across both runtimes is a hard requirement during dual-accept.
func envDuration(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	// Handle '7d' shorthand: convert to '168h'.
	if len(v) > 1 && v[len(v)-1] == 'd' {
		days, derr := strconv.Atoi(v[:len(v)-1])
		if derr != nil {
			return 0, fmt.Errorf("env %s = %q: %w", key, v, derr)
		}
		return time.Duration(days) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("env %s = %q: %w", key, v, err)
	}
	return d, nil
}

func envInt(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("env %s = %q: %w", key, v, err)
	}
	return n, nil
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
