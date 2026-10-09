//go:build integration

// queue_shutdown_test.go — queue.Shutdown against a real river and Postgres.
//
// The contract: a job still running when the soft stop runs out is
// cancelled, returns, and is recorded, so no row is left 'running' for the
// rescuer to find an hour later.  A row left 'running' is a duplicate of
// every later run of a unique job, which is what a deploy used to do to the
// image warm pass: killed mid-pass, it kept every pass after it, RunOnStart
// included, from starting for an hour.
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// shutdownTestQueue keeps this test's client off every other test's jobs.
const shutdownTestQueue = "shutdown_test"

type blockingArgs struct{}

func (blockingArgs) Kind() string { return "shutdown_test_blocking" }

// blockingWorker runs until its context is cancelled and then returns nil,
// as the image warm pass does: a pass cut short by a stop is not an error.
type blockingWorker struct {
	river.WorkerDefaults[blockingArgs]
	started chan<- struct{}
}

func (w *blockingWorker) Work(ctx context.Context, _ *river.Job[blockingArgs]) error {
	w.started <- struct{}{}
	<-ctx.Done()
	return nil
}

func TestQueueShutdown_CancelsAJobThatOutlivesTheSoftStop(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)

	started := make(chan struct{}, 1)
	workers := river.NewWorkers()
	river.AddWorker(workers, &blockingWorker{started: started})
	c, err := queue.Boot(pool, queue.Config{
		Workers: workers,
		Queues:  map[string]river.QueueConfig{shutdownTestQueue: {MaxWorkers: 1}},
	})
	require.NoError(t, err)
	require.NoError(t, c.Start(ctx))

	res, err := c.Insert(ctx, blockingArgs{}, &river.InsertOpts{Queue: shutdownTestQueue})
	require.NoError(t, err)
	select {
	case <-started:
	case <-time.After(15 * time.Second):
		t.Fatal("the job never started")
	}

	begin := time.Now()
	require.NoError(t, queue.Shutdown(c, 200*time.Millisecond, 10*time.Second))
	assert.Less(t, time.Since(begin), 5*time.Second,
		"the second step cancels the job rather than waiting it out")

	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state::text FROM river_job WHERE id = $1`, res.Job.ID).Scan(&state))
	assert.Equal(t, "completed", state,
		"cancelled, the job returned and was recorded; 'running' would block its kind until the rescuer")
}

func TestQueueShutdown_ASoftStopIsEnoughForAJobThatFinishes(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURIGlobal)

	c, err := queue.Boot(pool, queue.Config{
		Queues: map[string]river.QueueConfig{shutdownTestQueue: {MaxWorkers: 1}},
	})
	require.NoError(t, err)
	require.NoError(t, c.Start(ctx))

	begin := time.Now()
	require.NoError(t, queue.Shutdown(c, 5*time.Second, 5*time.Second))
	assert.Less(t, time.Since(begin), 5*time.Second, "with nothing running, the soft stop returns at once")
}
