// MongoDB client construction for the migration tool.
//
// The Mongo driver is only used by cmd/migrate-mongo — the live HTTP
// server in cmd/server never talks to Mongo.  Keeping this in its own
// file means the rest of the migrate package compiles even if a future
// build tag excludes the driver.
package migrate

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

// Mongo timeouts.  These are deliberately generous because the migration
// runs against the production Mongo dump on the same VPS; we'd rather
// wait than fail a multi-hour run on a transient pause.
const (
	mongoServerSelectionTimeout = 10 * time.Second
	mongoConnectTimeout         = 10 * time.Second
	// SocketTimeout removed from ClientOptions in mongo-driver v2.
	// Per-operation deadlines come from context.WithTimeout — see
	// orchestrator.go where the cursor iteration carries the parent ctx.
)

// ConnectMongo opens a Mongo client against uri with read-preference
// primary and ping-verifies the connection before returning.  The caller
// owns the client lifecycle and must call Disconnect when done.
func ConnectMongo(ctx context.Context, uri string) (*mongo.Client, error) {
	if uri == "" {
		return nil, fmt.Errorf("mongo uri is empty")
	}

	opts := options.Client().
		ApplyURI(uri).
		SetServerSelectionTimeout(mongoServerSelectionTimeout).
		SetConnectTimeout(mongoConnectTimeout).
		SetReadPreference(readpref.Primary())

	client, err := mongo.Connect(opts)
	if err != nil {
		return nil, fmt.Errorf("mongo connect: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, mongoServerSelectionTimeout)
	defer cancel()
	if err := client.Ping(pingCtx, readpref.Primary()); err != nil {
		// Best-effort cleanup; ignore disconnect error since we're already failing.
		_ = client.Disconnect(context.Background())
		return nil, fmt.Errorf("mongo ping: %w", err)
	}
	return client, nil
}
