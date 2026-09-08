// Package obs holds the small observability adapters that sit between the
// standard library and the vendors we report to.
//
// Its first inhabitant exists because of a specific outage.  On 2026-09-08 a
// change removed rivertype.JobStateRunning from one of four *UniqueStates
// slices.  river's UniqueOpts.validate requires that state, so
// PeriodicJobEnqueuer failed for that kind — and reported it like this
// (internal/maintenance/periodic_job_enqueuer.go:572):
//
//	s.Logger.ErrorContext(ctx, s.Name+": Internal error generating periodic job", "error", err.Error())
//
// One ERROR line, and nothing else.  The service started, served traffic, and
// simply never enqueued that sweep again.  river's Logger is a *slog.Logger,
// and ours was a bare JSONHandler writing to stdout, so the line went to the
// container log and no further.
//
// SentryErrorHandler closes that gap for every river background failure at
// once — the enqueuer swallows insert conflicts, transaction errors and
// constructor errors the same way, and no static gate can see any of them.
package obs

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
)

// Capturer is the one Sentry method this package needs.  Declared at the
// use-site so tests can inject a recorder without an SDK transport, and so
// the dependency direction stays one-way.  *sentry.Hub satisfies it.
type Capturer interface {
	CaptureEvent(event *sentry.Event) *sentry.EventID
}

// Compile-time guard: the SDK type we actually pass must satisfy Capturer.
// Catches a signature change in the sentry-go upgrade path.
var _ Capturer = (*sentry.Hub)(nil)

const (
	// DefaultRateWindow / DefaultRateBurst cap what one process can send.
	//
	// Sentry quota is finite and an ERROR is not necessarily rare: a wedged
	// upstream can produce one per job attempt.  The cap is per window rather
	// than per unique message because the failure this exists for repeats the
	// SAME message once per enqueuer tick, and one alert is enough to act on.
	//
	// 20/minute is well above any healthy rate here (the whole service logged
	// single-digit ERRORs a day before this) and well below a quota problem.
	DefaultRateWindow = time.Minute
	DefaultRateBurst  = 20

	// droppedAttrKey names the extra that tells a reader the event they are
	// looking at is standing in for others.  Without it a rate limiter turns a
	// storm into a trickle and says nothing — which is the same silence this
	// package was written to remove, one level up.
	droppedAttrKey = "slog_events_dropped"

	// slogContextKey names the Sentry context that carries the record's
	// attributes.
	slogContextKey = "slog"
)

// Options tunes SentryErrorHandler.  The zero value is the production
// configuration: forward slog.LevelError and above, through the hub attached
// to the record's context (or the current hub), at DefaultRateBurst per
// DefaultRateWindow.
type Options struct {
	// Level is the threshold at or above which a record is forwarded.
	// Zero means slog.LevelError.
	Level slog.Level

	// Capturer, when non-nil, receives every forwarded event.  Nil means
	// resolve the hub per record: sentry.GetHubFromContext(ctx) if the
	// context carries one, else sentry.CurrentHub().
	//
	// Resolving per record rather than capturing a hub at construction is
	// what lets the HTTP middleware's request-scoped hub (with its user and
	// request tags) receive errors logged inside a handler.
	Capturer Capturer

	// RateWindow / RateBurst cap forwarding.  Zero means the defaults above.
	// A negative RateBurst disables the limiter entirely.
	RateWindow time.Duration
	RateBurst  int
}

// SentryErrorHandler passes every record through to a wrapped handler and
// additionally forwards the ones at or above Options.Level to Sentry.
//
// Pass-through is unconditional and happens FIRST: the container log stays
// exactly what it was, so this cannot make an incident harder to read even if
// the Sentry half is misconfigured, rate-limited, or the SDK was never
// initialised (an uninitialised hub drops events and returns nil).
type SentryErrorHandler struct {
	inner    slog.Handler
	level    slog.Level
	capturer Capturer
	limiter  *limiter

	// attrs are the WithAttrs-accumulated attributes, already qualified by
	// whatever groups were open when they were added.  slog requires that
	// WithAttrs/WithGroup return a NEW handler and leave the receiver alone,
	// so these slices are copied on write and never appended to in place.
	attrs  []slog.Attr
	groups []string
}

// Compile-time guard: this must remain a slog.Handler.
var _ slog.Handler = (*SentryErrorHandler)(nil)

// NewSentryErrorHandler wraps inner.  A nil inner is a programming error and
// panics at construction — the alternative is a logger that silently drops
// every line, which is the failure mode this whole package exists to remove.
func NewSentryErrorHandler(inner slog.Handler, opts Options) *SentryErrorHandler {
	if inner == nil {
		panic("obs.NewSentryErrorHandler: inner handler is required")
	}

	level := opts.Level
	if level == 0 {
		level = slog.LevelError
	}

	var lim *limiter
	switch {
	case opts.RateBurst < 0:
		lim = nil
	default:
		burst := opts.RateBurst
		if burst == 0 {
			burst = DefaultRateBurst
		}
		window := opts.RateWindow
		if window <= 0 {
			window = DefaultRateWindow
		}
		lim = &limiter{window: window, burst: burst}
	}

	return &SentryErrorHandler{
		inner:    inner,
		level:    level,
		capturer: opts.Capturer,
		limiter:  lim,
	}
}

// Enabled defers entirely to the wrapped handler.
//
// Deliberately NOT `inner.Enabled(...) || level >= h.level`: a record the
// inner handler drops is one nobody can correlate against the container log,
// and widening the level here would make Sentry the only place a class of
// line exists.  If an ERROR needs forwarding, the base handler has to be
// configured to keep it.
func (h *SentryErrorHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

// Handle writes the record through the wrapped handler and, for records at or
// above the threshold, sends a Sentry event carrying the message and every
// attribute in scope.
//
// The inner handler's error is returned unchanged; a Sentry failure is never
// allowed to turn into a logging failure.
func (h *SentryErrorHandler) Handle(ctx context.Context, rec slog.Record) error {
	err := h.inner.Handle(ctx, rec)
	if rec.Level < h.level {
		return err
	}
	h.forward(ctx, rec)
	return err
}

// WithAttrs returns a copy carrying attrs, qualified by the open groups.
func (h *SentryErrorHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	out := h.clone()
	out.inner = h.inner.WithAttrs(attrs)
	for _, a := range attrs {
		out.attrs = append(out.attrs, slog.Attr{Key: qualify(h.groups, a.Key), Value: a.Value})
	}
	return out
}

// WithGroup returns a copy with name pushed onto the group prefix.
func (h *SentryErrorHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	out := h.clone()
	out.inner = h.inner.WithGroup(name)
	out.groups = append(out.groups, name)
	return out
}

// clone copies the handler with its slices detached, so the returned handler
// can append without writing through to the receiver's backing arrays.
func (h *SentryErrorHandler) clone() *SentryErrorHandler {
	return &SentryErrorHandler{
		inner:    h.inner,
		level:    h.level,
		capturer: h.capturer,
		limiter:  h.limiter,
		attrs:    append(([]slog.Attr)(nil), h.attrs...),
		groups:   append(([]string)(nil), h.groups...),
	}
}

// forward builds and sends the Sentry event for one record.
func (h *SentryErrorHandler) forward(ctx context.Context, rec slog.Record) {
	capturer := h.capturer
	if capturer == nil {
		capturer = hubFor(ctx)
	}
	if capturer == nil {
		return
	}

	dropped := 0
	if h.limiter != nil {
		var allowed bool
		allowed, dropped = h.limiter.allow(rec.Time)
		if !allowed {
			return
		}
	}

	event := sentry.NewEvent()
	event.Level = sentryLevel(rec.Level)
	event.Message = rec.Message
	event.Logger = "slog"
	if !rec.Time.IsZero() {
		event.Timestamp = rec.Time
	}

	// Attributes ride in a named context rather than the old top-level
	// Extra map, which sentry-go dropped from Event before v0.46.  Grouping
	// them under one key also keeps them together in the UI instead of
	// scattered among the SDK's own contexts.
	fields := make(sentry.Context, rec.NumAttrs()+len(h.attrs)+1)
	for _, a := range h.attrs {
		fields[a.Key] = a.Value.Resolve().Any()
	}
	rec.Attrs(func(a slog.Attr) bool {
		fields[qualify(h.groups, a.Key)] = a.Value.Resolve().Any()
		return true
	})
	if dropped > 0 {
		fields[droppedAttrKey] = dropped
	}
	if len(fields) > 0 {
		event.Contexts[slogContextKey] = fields
	}

	capturer.CaptureEvent(event)
}

// hubFor picks the request-scoped hub when the context carries one and falls
// back to the process hub.  Returns nil only if the SDK handed back nil, which
// it does not do today — the guard is here so a future SDK change degrades to
// "no forwarding" rather than a nil dereference inside a log call.
func hubFor(ctx context.Context) Capturer {
	if hub := sentry.GetHubFromContext(ctx); hub != nil {
		return hub
	}
	if hub := sentry.CurrentHub(); hub != nil {
		return hub
	}
	return nil
}

// sentryLevel maps slog levels onto Sentry's.  Anything at or above Error is
// reported as an error; the intermediate levels are mapped for the benefit of
// callers that lower Options.Level.
func sentryLevel(l slog.Level) sentry.Level {
	switch {
	case l >= slog.LevelError:
		return sentry.LevelError
	case l >= slog.LevelWarn:
		return sentry.LevelWarning
	case l >= slog.LevelInfo:
		return sentry.LevelInfo
	default:
		return sentry.LevelDebug
	}
}

// qualify joins an attribute key to the open group prefix the way slog's own
// handlers do, so an extra reads the same as the corresponding JSON path.
func qualify(groups []string, key string) string {
	if len(groups) == 0 {
		return key
	}
	out := make([]byte, 0, len(key)+8*len(groups))
	for _, g := range groups {
		out = append(out, g...)
		out = append(out, '.')
	}
	return string(append(out, key...))
}

// limiter is a fixed-window counter.  Fixed window rather than a token bucket
// because the quantity being protected is a per-interval quota, and because
// the count of what it suppressed has to survive to the next allowed event —
// a bucket that only says yes or no would lose it.
type limiter struct {
	mu     sync.Mutex
	window time.Duration
	burst  int

	windowStart time.Time
	sent        int
	dropped     int
}

// allow reports whether an event may be sent at now, and — when it may — how
// many were dropped since the previous allowed one.  Callers attach that count
// to the event so a suppressed storm is visible rather than merely quiet.
//
// A zero now (slog leaves Record.Time zero only for hand-built records) is
// treated as "same window", which fails toward sending.
func (l *limiter) allow(now time.Time) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if !now.IsZero() && now.Sub(l.windowStart) >= l.window {
		l.windowStart = now
		l.sent = 0
	}
	if l.sent >= l.burst {
		l.dropped++
		return false, 0
	}
	l.sent++
	dropped := l.dropped
	l.dropped = 0
	return true, dropped
}
