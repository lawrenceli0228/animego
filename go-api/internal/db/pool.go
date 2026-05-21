// Package db owns the runtime pgxpool used by the chi HTTP server.
//
// The migration tool has its own pool in internal/migrate/pg_conn.go (sized
// for batch workloads, MaxConns=10).  This pool is web-tier (MaxConns=20)
// and lives for the lifetime of the cmd/server binary.
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// MaxConns sized for web tier serving P2.x endpoints.  Postgres default
	// max_connections=100 leaves room for testcontainers + migration tool +
	// admin tools running in parallel.  Tune in P8 once staging QPS is known.
	MaxConns = 20

	// HealthCheckPeriod is pgxpool's interval for ping-ing idle connections.
	HealthCheckPeriod = 30 * time.Second

	// MaxConnLifetime caps how long a single connection can live before it is
	// recycled — protects against gradual server-side state buildup and lets
	// rolling Postgres restarts drain cleanly.
	MaxConnLifetime = 1 * time.Hour

	// MaxConnIdleTime evicts unused connections to keep the steady-state
	// connection count low.
	MaxConnIdleTime = 30 * time.Minute

	// ConnectTimeout bounds NewPool's blocking on the initial dial + ping.
	ConnectTimeout = 10 * time.Second

	// PingTimeout bounds /health pool.Ping().  Two seconds is generous for
	// a colocated Postgres but tight enough that the healthcheck reports
	// degradation before docker's 30s probe interval lapses.
	PingTimeout = 2 * time.Second
)

// NewPool parses databaseURL, opens a pgxpool with web-tier sizing, and
// ping-verifies the connection before returning.  The caller owns the pool
// lifecycle and must call pool.Close() when done.
//
// The supplied ctx bounds the connect + ping attempt; once NewPool returns
// successfully, the pool uses its own internal context for subsequent work.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("database url is empty")
	}

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = MaxConns
	cfg.HealthCheckPeriod = HealthCheckPeriod
	cfg.MaxConnLifetime = MaxConnLifetime
	cfg.MaxConnIdleTime = MaxConnIdleTime

	connectCtx, cancel := context.WithTimeout(ctx, ConnectTimeout)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(connectCtx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open postgres pool: %w", err)
	}

	pingCtx, cancel2 := context.WithTimeout(ctx, ConnectTimeout)
	defer cancel2()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return pool, nil
}
