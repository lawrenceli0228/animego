// PostgreSQL pgxpool construction for the migration tool.
//
// Pool size is fixed at 10 — enough for the migration's concurrent
// reader goroutines plus the serialized writer per collection, with a
// few connections in reserve for batched UPSERTs.  Statement cache uses
// the pgx default.
package migrate

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	pgMaxConns         = 10
	pgConnectTimeout   = 10 * time.Second
	pgHealthcheckEvery = 30 * time.Second
)

// ConnectPG opens a pgx connection pool against uri and ping-verifies
// the connection before returning.  The caller owns the pool lifecycle
// and must call Close when done.
func ConnectPG(ctx context.Context, uri string) (*pgxpool.Pool, error) {
	if uri == "" {
		return nil, fmt.Errorf("postgres uri is empty")
	}

	cfg, err := pgxpool.ParseConfig(uri)
	if err != nil {
		return nil, fmt.Errorf("parse postgres uri: %w", err)
	}
	cfg.MaxConns = pgMaxConns
	cfg.HealthCheckPeriod = pgHealthcheckEvery

	connectCtx, cancel := context.WithTimeout(ctx, pgConnectTimeout)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(connectCtx, cfg)
	if err != nil {
		return nil, fmt.Errorf("postgres pool: %w", err)
	}

	pingCtx, cancel2 := context.WithTimeout(ctx, pgConnectTimeout)
	defer cancel2()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres ping: %w", err)
	}
	return pool, nil
}
