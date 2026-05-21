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
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

// Enqueuer is the enrichment dispatch interface.  Tests inject mocks;
// production wires *RealEnqueuer.  Callers may pass a NoopEnqueuer{}
// (or nil — services swap nil for NoopEnqueuer{}) to skip enqueue
// during boot before river is started.
//
// V1 jobs are seeded by the upsert paths (/search, /schedule, boot
// orphan scan).  V2 jobs are chained from the V1 worker when a
// Bangumi hit produced a bgm_id — services do NOT call EnqueueV2Many
// directly.  Both methods live on the same interface so the V1
// worker can hold a single dependency rather than two narrow ones.
type Enqueuer interface {
	EnqueueV1Many(ctx context.Context, anilistIDs []int32) error
	EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error
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

// EnqueueV2Many inserts V2 jobs for each {anilistId, bgmId} pair.
// Empty slice → noop.  Uses river.Client.InsertMany so the round-trip
// is one statement per batch.  Errors are wrapped with the batch
// size so the call site (V1 worker chain) can distinguish "1 of N
// failed" from "all N failed" without re-deriving from pg error.
//
// Production: only the V1 worker calls this (after a Bangumi search
// hit produces a bgm_id).  Services that seed V1 jobs do NOT touch
// V2 — keeps the lifecycle one-way (V1 → V2 → V3) at the queue level.
func (e *RealEnqueuer) EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error {
	if len(jobs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(jobs))
	for i, j := range jobs {
		params[i] = river.InsertManyParams{Args: j}
	}
	if _, err := e.client.InsertMany(ctx, params); err != nil {
		return fmt.Errorf("queue.EnqueueV2Many (n=%d): %w", len(jobs), err)
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

// EnqueueV2Many returns nil regardless of input.
func (NoopEnqueuer) EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error {
	return nil
}

// LateBoundEnqueuer is an Enqueuer whose underlying river-backed
// implementation is bound AFTER construction.  Solves the chicken-egg
// between WorkersWithBangumi (needs an Enqueuer at worker-registration
// time so V1 can chain V2) and Boot (creates the *river.Client after
// the workers bundle is built).
//
// Usage in main.go:
//
//	lbe := &queue.LateBoundEnqueuer{}
//	workers := queue.WorkersWithBangumi(bgClient, db, lbe)
//	rc, _ := queue.Boot(pool, queue.Config{Workers: workers})
//	lbe.Bind(rc)  // now V1→V2 chain works
//
// Before Bind is called both EnqueueV1Many and EnqueueV2Many silently
// no-op (same shape as NoopEnqueuer).  After Bind they forward to a
// RealEnqueuer.  Re-Bind is supported but rare in practice.
//
// Concurrency: sync.RWMutex protects the inner pointer.  EnqueueV*Many
// take an RLock so multiple enqueuers can dispatch in parallel; Bind
// takes the write lock (called at most a handful of times at boot).
type LateBoundEnqueuer struct {
	mu    sync.RWMutex
	inner *RealEnqueuer
}

// Bind wires the underlying river client.  Call once after Boot.
func (l *LateBoundEnqueuer) Bind(c *river.Client[pgx.Tx]) {
	l.mu.Lock()
	l.inner = NewEnqueuer(c)
	l.mu.Unlock()
}

// EnqueueV1Many delegates to the bound RealEnqueuer, or no-ops when unbound.
func (l *LateBoundEnqueuer) EnqueueV1Many(ctx context.Context, anilistIDs []int32) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueV1Many(ctx, anilistIDs)
}

// EnqueueV2Many delegates to the bound RealEnqueuer, or no-ops when unbound.
func (l *LateBoundEnqueuer) EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueV2Many(ctx, jobs)
}

// Compile-time guards: all implementations must satisfy Enqueuer.
var (
	_ Enqueuer = (*RealEnqueuer)(nil)
	_ Enqueuer = NoopEnqueuer{}
	_ Enqueuer = (*LateBoundEnqueuer)(nil)
)
