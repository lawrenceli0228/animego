// Package queue — V1 enrichment trigger surface.
//
// Enqueuer is the small interface services consume to dispatch V1 jobs.
// *RealEnqueuer wraps a *river.Client[pgx.Tx] and uses InsertMany for
// batched enqueue (cheaper than per-row Insert).
//
// Pass a *NoopEnqueuer for tests / boot-time when river isn't available.
//
// Three production trigger sources call this surface:
//
//  1. /search post-upsert — after upserting AniList rows the handler
//     filters bangumi_version=0 ids and enqueues V1 jobs.
//  2. /schedule post-lookup — the titleChinese lookup already returns
//     bangumi_version per row, so the handler filters and enqueues.
//  3. Boot-time orphan scan (see orphan.go) — catches anime upserted
//     during a worker outage.
//
// The Enqueuer interface lives here at the consumer-friendly edge of the
// package (services accept the interface, this package implements it)
// per "Accept interfaces, return structs".

package queue

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

// Enqueuer is the V1-enrichment dispatch interface.  Tests inject mocks;
// production wires *RealEnqueuer.  Callers may pass a NoopEnqueuer{}
// (or nil — services swap nil for NoopEnqueuer{}) to skip enqueue
// during boot before river is started.
type Enqueuer interface {
	EnqueueV1Many(ctx context.Context, anilistIDs []int32) error
}

// RealEnqueuer wraps a river client and batches V1 inserts via
// river.Client.InsertMany so each batch is one statement round-trip
// rather than len(ids) inserts.
type RealEnqueuer struct {
	client *river.Client[pgx.Tx]
}

// NewEnqueuer returns a real river-backed enqueuer.  The caller owns
// the river client lifecycle (Boot + Start + Stop); this wrapper just
// borrows it for dispatch.
func NewEnqueuer(c *river.Client[pgx.Tx]) *RealEnqueuer {
	return &RealEnqueuer{client: c}
}

// EnqueueV1Many inserts V1 jobs for each anilistID.  Empty slice → noop
// (no error, no river call).  Uses river.Client.InsertMany so the
// round-trip is one statement per batch.  Errors are wrapped with the
// batch size so logs at the call site can distinguish "1 of 100 failed"
// from "all 100 failed" without re-deriving from the underlying pg
// error.
func (e *RealEnqueuer) EnqueueV1Many(ctx context.Context, anilistIDs []int32) error {
	if len(anilistIDs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(anilistIDs))
	for i, id := range anilistIDs {
		params[i] = river.InsertManyParams{Args: BangumiV1Args{AnilistID: int(id)}}
	}
	if _, err := e.client.InsertMany(ctx, params); err != nil {
		return fmt.Errorf("queue.EnqueueV1Many (n=%d): %w", len(anilistIDs), err)
	}
	return nil
}

// NoopEnqueuer satisfies Enqueuer without doing anything.  Use as a
// safe default when callers haven't wired river yet (e.g. server is
// in unit-test mode, or a boot stage runs before river.Start).
type NoopEnqueuer struct{}

// EnqueueV1Many returns nil regardless of input.
func (NoopEnqueuer) EnqueueV1Many(ctx context.Context, anilistIDs []int32) error {
	return nil
}

// Compile-time guards: both implementations must satisfy Enqueuer.
var (
	_ Enqueuer = (*RealEnqueuer)(nil)
	_ Enqueuer = NoopEnqueuer{}
)
