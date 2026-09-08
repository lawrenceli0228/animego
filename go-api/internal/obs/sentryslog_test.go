// sentryslog_test.go — unit coverage for the slog → Sentry bridge.
//
// The load-bearing case is TestSentryErrorHandler_ForwardsRiverEnqueuerError:
// it drives the handler with the exact call river makes when a periodic job's
// UniqueOpts fail validation, because that line going nowhere is the whole
// reason this package exists.
package obs

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// recorder is a Capturer that keeps every event it is handed.
type recorder struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (r *recorder) CaptureEvent(event *sentry.Event) *sentry.EventID {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
	id := sentry.EventID("test")
	return &id
}

func (r *recorder) all() []*sentry.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append(([]*sentry.Event)(nil), r.events...)
}

// newTestLogger returns a logger whose records go to both a JSON buffer (the
// stand-in for the container log) and rec.
func newTestLogger(t *testing.T, rec *recorder, opts Options) (*slog.Logger, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	opts.Capturer = rec
	base := slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(NewSentryErrorHandler(base, opts)), &buf
}

// slogFields pulls the attribute context off an event, or nil when absent.
func slogFields(t *testing.T, e *sentry.Event) sentry.Context {
	t.Helper()
	return e.Contexts[slogContextKey]
}

// ---------------------------------------------------------------------------
// The incident
// ---------------------------------------------------------------------------

// TestSentryErrorHandler_ForwardsRiverEnqueuerError reproduces the log call
// from river's PeriodicJobEnqueuer (periodic_job_enqueuer.go:572) that
// reported the 2026-09-08 stall and was seen by nobody.
func TestSentryErrorHandler_ForwardsRiverEnqueuerError(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	logger, buf := newTestLogger(t, rec, Options{})

	logger.ErrorContext(context.Background(),
		"maintenance.PeriodicJobEnqueuer: Internal error generating periodic job",
		"error", "UniqueOpts.ByState must contain all required states, missing: running")

	events := rec.all()
	require.Len(t, events, 1, "the one ERROR river emits must reach Sentry")
	assert.Equal(t, sentry.LevelError, events[0].Level)
	assert.Contains(t, events[0].Message, "Internal error generating periodic job")
	assert.Equal(t, "slog", events[0].Logger)
	assert.Equal(t,
		"UniqueOpts.ByState must contain all required states, missing: running",
		slogFields(t, events[0])["error"],
		"the attribute naming the missing state is the whole diagnostic")

	// The container log must be untouched by the forwarding.
	assert.Contains(t, buf.String(), "Internal error generating periodic job")
}

// ---------------------------------------------------------------------------
// Level threshold
// ---------------------------------------------------------------------------

func TestSentryErrorHandler_IgnoresBelowThreshold(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	logger, buf := newTestLogger(t, rec, Options{})

	logger.Info("postgres pool ready", "max_conns", 10)
	logger.Warn("sentry init failed", "err", "bad dsn")

	assert.Empty(t, rec.all(), "INFO and WARN must not spend Sentry quota")
	assert.Contains(t, buf.String(), "postgres pool ready",
		"pass-through must be unconditional")
	assert.Contains(t, buf.String(), "sentry init failed")
}

func TestSentryErrorHandler_HonoursCustomLevel(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	logger, _ := newTestLogger(t, rec, Options{Level: slog.LevelWarn})

	logger.Warn("river queue stop", "err", "context deadline exceeded")

	events := rec.all()
	require.Len(t, events, 1)
	assert.Equal(t, sentry.LevelWarning, events[0].Level,
		"a forwarded WARN must not be reported as an error")
}

// ---------------------------------------------------------------------------
// Pass-through fidelity
// ---------------------------------------------------------------------------

// TestSentryErrorHandler_PassThroughIsByteIdentical pins the property that
// makes this handler safe to wrap the production logger with: the JSON line
// written to stdout is exactly what the bare handler would have written.
func TestSentryErrorHandler_PassThroughIsByteIdentical(t *testing.T) {
	t.Parallel()

	var wrapped, bare bytes.Buffer
	opts := &slog.HandlerOptions{
		Level: slog.LevelInfo,
		// Strip the timestamp so the two runs are comparable.
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return a
		},
	}
	wrappedLogger := slog.New(NewSentryErrorHandler(
		slog.NewJSONHandler(&wrapped, opts), Options{Capturer: &recorder{}}))
	bareLogger := slog.New(slog.NewJSONHandler(&bare, opts))

	for _, l := range []*slog.Logger{wrappedLogger, bareLogger} {
		l.With("service", "go-api").WithGroup("queue").
			Error("river queue boot failed", "err", "queue not found", "attempt", 2)
	}

	assert.Equal(t, bare.String(), wrapped.String(),
		"wrapping must not change a single byte of the container log")
}

// ---------------------------------------------------------------------------
// Attributes, With, and groups
// ---------------------------------------------------------------------------

func TestSentryErrorHandler_CarriesWithAttrsAndGroups(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	logger, _ := newTestLogger(t, rec, Options{})

	logger.With("service", "go-api").
		WithGroup("queue").
		With("name", "ratings").
		Error("sweep failed", "err", "boom")

	events := rec.all()
	require.Len(t, events, 1)
	fields := slogFields(t, events[0])
	assert.Equal(t, "go-api", fields["service"], "ungrouped With attr")
	assert.Equal(t, "ratings", fields["queue.name"], "With attr inside a group")
	assert.Equal(t, "boom", fields["queue.err"], "record attr inside a group")
}

// TestSentryErrorHandler_WithDoesNotMutateParent guards the slog.Handler
// contract that WithAttrs/WithGroup return a new handler: a shared backing
// array would leak one request's fields onto another's events.
func TestSentryErrorHandler_WithDoesNotMutateParent(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	var buf bytes.Buffer
	root := NewSentryErrorHandler(
		slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}),
		Options{Capturer: rec})

	// Three attrs, added one at a time, is the shape that matters: append's
	// growth leaves len=3 cap=4, so a handler that does NOT copy its slice
	// hands both children the same backing array with one free slot — and the
	// second child's attr overwrites the first's in place.  A parent with one
	// attr cannot catch it: len==cap forces a reallocation and the bug hides.
	parent := slog.New(root).With("shared", 1).With("shared2", 2).With("shared3", 3)
	childA := parent.With("only_a", "a")
	childB := parent.With("only_b", "b")

	childA.Error("a")
	childB.Error("b")
	parent.Error("p")

	events := rec.all()
	require.Len(t, events, 3)

	assert.Equal(t, "a", slogFields(t, events[0])["only_a"])
	assert.NotContains(t, slogFields(t, events[0]), "only_b")

	assert.Equal(t, "b", slogFields(t, events[1])["only_b"])
	assert.NotContains(t, slogFields(t, events[1]), "only_a",
		"sibling loggers must not see each other's attributes")

	assert.NotContains(t, slogFields(t, events[2]), "only_a",
		"the parent must not inherit a child's attributes")
	assert.NotContains(t, slogFields(t, events[2]), "only_b")
	assert.EqualValues(t, 1, slogFields(t, events[2])["shared"])
	assert.EqualValues(t, 3, slogFields(t, events[2])["shared3"])
}

// TestSentryErrorHandler_ResolvesLazyValues asserts LogValuer attributes are
// resolved before they are handed to Sentry — an unresolved slog.Value
// serialises as an opaque struct in the payload.
func TestSentryErrorHandler_ResolvesLazyValues(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	logger, _ := newTestLogger(t, rec, Options{})

	// Both paths: an attr attached via With (stored on the handler) and one
	// passed on the call (read off the record).  They resolve in different
	// loops, so covering only one lets the other rot.
	logger.With("owner", lazyUser{ID: 7}).Error("token refused", "user", lazyUser{ID: 42})

	events := rec.all()
	require.Len(t, events, 1)
	assert.Equal(t, "user-42", slogFields(t, events[0])["user"], "record attr")
	assert.Equal(t, "user-7", slogFields(t, events[0])["owner"], "With attr")

	// And the value must survive JSON encoding, which is what the SDK does
	// to it on the way out.
	raw, err := json.Marshal(events[0].Contexts)
	require.NoError(t, err)
	assert.Contains(t, string(raw), "user-42")
}

type lazyUser struct{ ID int }

func (u lazyUser) LogValue() slog.Value {
	return slog.StringValue("user-" + strings.TrimSpace(itoa(u.ID)))
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// TestSentryErrorHandler_RateLimitsAndReportsDrops covers the failure mode the
// plan flagged for this task: a hot error loop burning the Sentry quota.  The
// suppression must not itself be silent.
func TestSentryErrorHandler_RateLimitsAndReportsDrops(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	var buf bytes.Buffer
	h := NewSentryErrorHandler(
		slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}),
		Options{Capturer: rec, RateBurst: 2, RateWindow: time.Minute})

	base := time.Date(2026, 9, 8, 22, 0, 0, 0, time.UTC)
	emit := func(at time.Time, msg string) {
		r := slog.NewRecord(at, slog.LevelError, msg, 0)
		require.NoError(t, h.Handle(context.Background(), r))
	}

	emit(base, "one")
	emit(base.Add(time.Second), "two")
	emit(base.Add(2*time.Second), "three")
	emit(base.Add(3*time.Second), "four")

	require.Len(t, rec.all(), 2, "burst of 2 must cap the window at 2 events")
	assert.Equal(t, 4, strings.Count(buf.String(), "level"),
		"every record must still reach the container log")

	// Next window: the first event through carries the suppressed count.
	emit(base.Add(2*time.Minute), "five")
	events := rec.all()
	require.Len(t, events, 3)
	assert.EqualValues(t, 2, slogFields(t, events[2])[droppedAttrKey],
		"a suppressed storm must say how much it suppressed")

	// And the counter resets, so the next event does not re-report them.
	emit(base.Add(2*time.Minute).Add(time.Second), "six")
	events = rec.all()
	require.Len(t, events, 4)
	assert.NotContains(t, slogFields(t, events[3]), droppedAttrKey)
}

func TestSentryErrorHandler_RateLimitCanBeDisabled(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	logger, _ := newTestLogger(t, rec, Options{RateBurst: -1})

	for i := 0; i < DefaultRateBurst+5; i++ {
		logger.Error("boom")
	}
	assert.Len(t, rec.all(), DefaultRateBurst+5,
		"a negative burst must disable the limiter outright")
}

// TestSentryErrorHandler_DefaultBurstApplies pins that the zero Options value
// is the production configuration rather than an unlimited one.
func TestSentryErrorHandler_DefaultBurstApplies(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	logger, _ := newTestLogger(t, rec, Options{})

	for i := 0; i < DefaultRateBurst+5; i++ {
		logger.Error("boom")
	}
	assert.Len(t, rec.all(), DefaultRateBurst,
		"the zero value must carry the default cap")
}

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

// TestSentryErrorHandler_NoHubDoesNotPanic covers the deployment where
// SENTRY_DSN is unset: the process hub has no client and CaptureEvent is a
// no-op.  Logging must be unaffected.
func TestSentryErrorHandler_NoHubDoesNotPanic(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := slog.New(NewSentryErrorHandler(
		slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}),
		Options{})) // no Capturer: resolves the real (uninitialised) hub

	assert.NotPanics(t, func() {
		logger.Error("config load failed", "err", "missing DATABASE_URL")
	})
	assert.Contains(t, buf.String(), "config load failed")
}

// TestSentryErrorHandler_PrefersHubFromContext pins that an error logged
// inside an HTTP handler is captured on the request-scoped hub, so it keeps
// the request tags the Sentry middleware attached.
func TestSentryErrorHandler_PrefersHubFromContext(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := slog.New(NewSentryErrorHandler(
		slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}),
		Options{}))

	transport := &captureTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{
		Dsn:       "https://key@example.invalid/1",
		Transport: transport,
	})
	require.NoError(t, err)
	hub := sentry.NewHub(client, sentry.NewScope())
	hub.Scope().SetTag("route", "/api/admin/queues")

	logger.ErrorContext(sentry.SetHubOnContext(context.Background(), hub),
		"admin: queue.Status failed", "err", "queue not found")

	events := transport.all()
	require.Len(t, events, 1, "the context hub must receive the event")
	assert.Equal(t, "/api/admin/queues", events[0].Tags["route"],
		"the request-scoped hub's tags are the reason to prefer it")
}

// captureTransport records events instead of sending them.
type captureTransport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (t *captureTransport) Configure(sentry.ClientOptions) {}
func (t *captureTransport) Flush(time.Duration) bool       { return true }
func (t *captureTransport) FlushWithContext(context.Context) bool {
	return true
}
func (t *captureTransport) Close() {}
func (t *captureTransport) SendEvent(event *sentry.Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.events = append(t.events, event)
}

func (t *captureTransport) all() []*sentry.Event {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append(([]*sentry.Event)(nil), t.events...)
}

// TestNewSentryErrorHandler_RejectsNilInner pins the loud failure: a nil inner
// handler would produce a logger that drops every line.
func TestNewSentryErrorHandler_RejectsNilInner(t *testing.T) {
	t.Parallel()

	assert.Panics(t, func() { NewSentryErrorHandler(nil, Options{}) })
}

// TestSentryErrorHandler_EnabledFollowsInner pins that the wrapper does not
// widen the level filter: a record the base handler drops must not exist in
// Sentry alone, where nobody could correlate it against the container log.
func TestSentryErrorHandler_EnabledFollowsInner(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	h := NewSentryErrorHandler(
		slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelError + 1}),
		Options{Capturer: &recorder{}})

	assert.False(t, h.Enabled(context.Background(), slog.LevelError),
		"the wrapper must not re-enable a level the base handler filters out")
}
