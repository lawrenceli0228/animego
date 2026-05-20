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
)

// Config holds runtime values read from the process environment.
// Zero values are safe defaults for local dev only.
type Config struct {
	// Port for the HTTP server.  Default 8080.
	Port int

	// DatabaseURL is the libpq-style connection string consumed by pgxpool.
	// Default points at the dev docker-compose Postgres.
	DatabaseURL string

	// JWTSecret is the HS256 signing secret shared with the Next.js middleware
	// (which verifies tokens) and the ws-server (which verifies socket auth).
	// P0 is allowed to start without this; P2.2 onward requires it.
	JWTSecret string

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

	return &Config{
		Port:         port,
		DatabaseURL:  dbURL,
		JWTSecret:    os.Getenv("JWT_SECRET"), // empty OK at P0; P2.2 will validate
		ClientOrigin: getEnv("CLIENT_ORIGIN", "http://localhost:3000"),
	}, nil
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
