// main_wiring_test.go — the two pieces of boot wiring whose loss is silent.
//
// Everything else in main() fails loudly if it is wrong: a bad DSN exits, an
// unmounted route 404s on first use, a missing handler is a compile error.
// These two do not.  Drop the Sentry forwarder and the logs look identical
// while Sentry stops hearing about background failures.  Drop Queues or
// PeriodicJobs and queue.Boot falls back to {default: 1}, so eight queues get
// no producer and no sweep is ever scheduled — no error, no log line, no
// failed request.
//
// That is the same shape as the incident this whole change exists to prevent,
// which is why these are worth an indirection to test.
package main

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// ---------------------------------------------------------------------------
// newRootLogger
// ---------------------------------------------------------------------------

// TestNewRootLogger_ForwardsErrorsToSentry drives the logger the way river
// does and asserts the record reaches a Sentry capturer.
//
// Through the real handler chain rather than by type assertion: what has to
// hold is that an ERROR gets forwarded, not that a particular type is present.
// A future handler inserted between the two would pass a type check and could
// still swallow the record.
func TestNewRootLogger_ForwardsErrorsToSentry(t *testing.T) {
	var buf bytes.Buffer
	logger := newRootLogger(&buf)

	transport := &recordingTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{
		Dsn:       "https://key@example.invalid/1",
		Transport: transport,
	})
	require.NoError(t, err)
	hub := sentry.NewHub(client, sentry.NewScope())

	logger.ErrorContext(sentry.SetHubOnContext(context.Background(), hub),
		"maintenance.PeriodicJobEnqueuer: Internal error generating periodic job",
		"error", "UniqueOpts.ByState must contain all required states, missing: running")

	events := transport.all()
	require.Len(t, events, 1,
		"the process logger must forward ERROR to Sentry; without it river's "+
			"background failures reach the container log and nothing else")
	assert.Contains(t, events[0].Message, "Internal error generating periodic job")

	assert.Contains(t, buf.String(), "Internal error generating periodic job",
		"and the container log must still get it")
}

// TestNewRootLogger_KeepsStdoutJSON pins that the forwarder did not change the
// log format callers and dashboards parse.
func TestNewRootLogger_KeepsStdoutJSON(t *testing.T) {
	var buf bytes.Buffer
	newRootLogger(&buf).Info("postgres pool ready", "max_conns", 10)

	line := buf.String()
	assert.True(t, strings.HasPrefix(line, "{"), "must stay JSON, got %q", line)
	assert.Contains(t, line, `"msg":"postgres pool ready"`)
	assert.Contains(t, line, `"max_conns":10`)
}

// TestNewRootLogger_DoesNotForwardBelowError pins that routine logging does
// not spend Sentry quota.
func TestNewRootLogger_DoesNotForwardBelowError(t *testing.T) {
	var buf bytes.Buffer
	logger := newRootLogger(&buf)

	transport := &recordingTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{
		Dsn:       "https://key@example.invalid/1",
		Transport: transport,
	})
	require.NoError(t, err)
	ctx := sentry.SetHubOnContext(context.Background(), sentry.NewHub(client, sentry.NewScope()))

	logger.InfoContext(ctx, "river queue ready")
	logger.WarnContext(ctx, "sentry init failed")

	assert.Empty(t, transport.all())
}

// recordingTransport keeps events instead of sending them.
type recordingTransport struct{ events []*sentry.Event }

func (t *recordingTransport) Configure(sentry.ClientOptions)        {}
func (t *recordingTransport) Flush(_ time.Duration) bool            { return true }
func (t *recordingTransport) FlushWithContext(context.Context) bool { return true }
func (t *recordingTransport) Close()                                {}
func (t *recordingTransport) SendEvent(event *sentry.Event)         { t.events = append(t.events, event) }
func (t *recordingTransport) all() []*sentry.Event                  { return t.events }

// ---------------------------------------------------------------------------
// queueBootConfig
// ---------------------------------------------------------------------------

// TestQueueBootConfig_CarriesEveryRegistryQueue is the assertion that would
// have failed on the night: without it, dropping Queues leaves seven
// workloads with no producer and nothing anywhere says so.
func TestQueueBootConfig_CarriesEveryRegistryQueue(t *testing.T) {
	t.Parallel()

	cfg := queueBootConfig(river.NewWorkers())

	assert.Equal(t, queue.Default().QueueConfigs(), cfg.Queues,
		"the boot config must be the registry's queue map, not a subset and not "+
			"river's {default: 1} fallback")
	require.NotEmpty(t, cfg.Queues)
}

// TestQueueBootConfig_SchedulesEveryPeriodicKind pins the other half.  An
// empty PeriodicJobs slice is not an error to river; it just means no sweep
// ever runs again.
func TestQueueBootConfig_SchedulesEveryPeriodicKind(t *testing.T) {
	t.Parallel()

	cfg := queueBootConfig(river.NewWorkers())

	var scheduled int
	for _, e := range queue.Default().Entries() {
		if e.Periodic != nil {
			scheduled++
		}
	}
	require.NotZero(t, scheduled)
	assert.Len(t, cfg.PeriodicJobs, scheduled,
		"every scheduled kind in the registry must reach river")
}

// TestQueueBootConfig_PassesTheWorkerBundle guards the third way this call can
// go wrong: a nil Workers makes queue.Boot fall back to the V2-stub-only
// bundle, so every real worker silently disappears.
func TestQueueBootConfig_PassesTheWorkerBundle(t *testing.T) {
	t.Parallel()

	workers := buildWorkers(workerDeps{})
	cfg := queueBootConfig(workers)

	assert.Same(t, workers, cfg.Workers)
}

// TestQueueBootConfig_UsesTheDefaultLogger ties the two halves of this file
// together: river reports its background failures through this logger, and
// main sets slog's default to newRootLogger's output.  A nil Logger here
// would leave queue.Boot to substitute slog.Default() anyway, so this is
// about the intent being explicit rather than incidental.
func TestQueueBootConfig_UsesTheDefaultLogger(t *testing.T) {
	cfg := queueBootConfig(river.NewWorkers())
	assert.Same(t, slog.Default(), cfg.Logger)
}
