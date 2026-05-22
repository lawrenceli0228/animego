//go:build integration

// queue_control_smoke_test.go — integration smoke for the queue
// control surface (PauseV3 / ResumeV3 / Status) in internal/queue
// against a real *river.Client[pgx.Tx] backed by the testcontainers
// Postgres.
//
// Container lifecycle is owned by TestMain in migrate_test.go; this
// file reuses pgURIGlobal and opens its own pgxpool per test.
//
// What this asserts:
//  1. queue.Status returns river.ErrNotFound when the bangumi_v3
//     queue is not in the Boot config (current default).  Documents
//     the wiring-phase TODO from control.go.
//  2. With a "bangumi_v3" queue declared in queue.Config.Queues, a
//     round-trip Pause → Status (paused) → Resume → Status
//     (unpaused) works end-to-end through the real river client.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestQueueControl_StatusOnUnknownQueue — Status against the default
// boot config (no bangumi_v3 queue declared) returns river.ErrNotFound
// wrapped with the queue name.  Documents the wiring-phase TODO.
func TestQueueControl_StatusOnUnknownQueue(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	// Boot WITHOUT declaring the bangumi_v3 queue — the default config
	// only has river.QueueDefault.  Status must fail loudly.
	c, err := queue.Boot(pool, queue.Config{})
	require.NoError(t, err)
	require.NoError(t, c.Start(ctx))
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopCancel()
		_ = c.Stop(stopCtx)
	})

	_, err = queue.Status(ctx, c)
	require.Error(t, err, "Status against undeclared queue must fail")
	assert.Contains(t, err.Error(), queue.BangumiV3QueueName,
		"error must include the queue name so operators know which queue is missing")
	assert.True(t, errors.Is(err, river.ErrNotFound),
		"unwrap chain must lead to river.ErrNotFound, got: %v", err)
}

// TestQueueControl_PauseResumeStatusRoundTrip — with the bangumi_v3
// queue declared, Pause → Status(paused) → Resume → Status(unpaused)
// works end-to-end through the real river client + Postgres.
func TestQueueControl_PauseResumeStatusRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)
	testutil.TruncateAll(t, ctx, pool)

	c, err := queue.Boot(pool, queue.Config{
		Workers: queue.WorkersWithBangumi(noHitBangumi{}, emptyAniList{}, noRowV12DB{}, queue.NoopEnqueuer{}),
		Queues: map[string]river.QueueConfig{
			river.QueueDefault:       {MaxWorkers: 1},
			queue.BangumiV3QueueName: {MaxWorkers: 1},
		},
	})
	require.NoError(t, err, "queue.Boot with bangumi_v3 declared")
	require.NoError(t, c.Start(ctx))
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopCancel()
		_ = c.Stop(stopCtx)
	})

	// river creates the queue row lazily on first activity.  Give the
	// client a beat to register the queue in river_queue before we
	// touch it (river's queue maintainer wakes shortly after Start).
	// Poll up to 5s rather than sleeping a fixed interval.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, gErr := c.QueueGet(ctx, queue.BangumiV3QueueName); gErr == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	// 1. Initial status — queue exists and is unpaused.
	s, err := queue.Status(ctx, c)
	require.NoError(t, err, "Status against declared queue must succeed once river registers it")
	assert.False(t, s.V3Paused, "freshly-declared queue must start unpaused")

	// 2. Pause and re-check.
	require.NoError(t, queue.PauseV3(ctx, c), "PauseV3 must succeed against declared queue")

	s, err = queue.Status(ctx, c)
	require.NoError(t, err)
	assert.True(t, s.V3Paused, "after PauseV3, river_queue.paused_at must be non-nil")

	// 3. Resume and re-check.
	require.NoError(t, queue.ResumeV3(ctx, c), "ResumeV3 must succeed against declared queue")

	s, err = queue.Status(ctx, c)
	require.NoError(t, err)
	assert.False(t, s.V3Paused, "after ResumeV3, river_queue.paused_at must clear to nil")
}
