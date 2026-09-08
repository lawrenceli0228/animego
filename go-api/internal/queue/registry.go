// registry.go — the single declaration of every background job this service
// runs: which queue it rides, how many slots that queue gets and why, and
// whether river fires it on a schedule.
//
// # WHY THIS EXISTS
//
// The same facts used to live in three places that had no way of disagreeing
// out loud.  A queue name was declared in control.go, its worker count in a
// 90-line map literal in cmd/server/main.go, and its schedule in a
// Periodic<Name>Job constructor next to the worker — ten of those, differing
// only in an interval constant and a RunOnStart bool.  Adding a sweep meant
// touching all three and there was nothing that noticed when you touched two.
//
// The cost of that is not repetition, it is silence.  On 2026-09-08 a change
// to one of four byte-identical *UniqueStates slices made
// PeriodicJobEnqueuer fail for one kind.  river reports that as a single
// ERROR line and keeps running, so the service started, served traffic, and
// stopped enqueueing the sweep — for 23 minutes, with no other symptom.
//
// # WHAT THIS DOES AND DOES NOT OWN
//
// It owns the wiring: queue names, worker counts, schedules.  It does NOT own
// InsertOpts.  river calls InsertOpts() on the Args type itself, and one of
// those calls happens inside bgm_bind_idmap.go's bind-and-enqueue
// transaction; turning a static method into a registry map lookup would put a
// panic surface on that path for nothing.
//
// So the direction is: the registry READS InsertOpts() and checks it against
// what the entry declares (see validate).  A queue named here that the Args
// type does not actually route to fails at process start, in the same
// compile-time-guard spirit as the `var _ river.JobArgs = ...` lines in
// args.go — but it never becomes the source of the routing itself.
package queue

import (
	"fmt"
	"sort"
	"time"

	"github.com/riverqueue/river"
)

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

// Concurrency is a queue's worker count together with the reason it has that
// value, and whether the value may be changed without re-deriving the reason.
//
// A bare int cannot carry the distinction that matters here.  Four of these
// numbers are 1 because a second worker would break something — a shared
// upstream token bucket that extra workers only queue up on, or a
// check-then-update race that a single slot is what makes unreachable.  One
// of them is 4 because DeepSeek round-trips genuinely parallelise.  Read as
// ints they are indistinguishable, and the standing invitation to "just try
// 2" applies equally to both.
type Concurrency struct {
	max    int
	fixed  bool
	reason string
}

// FixedConcurrency declares a worker count that is load-bearing: something
// other than throughput depends on it, and the reason says what.
//
// Caveat worth stating where somebody will read it: MaxWorkers is a
// PER-PROCESS guarantee.  It serialises workers inside this river client and
// nothing else.  cmd/bgmbackfill and cmd/hantbackfill are separate processes
// that write some of the same tables, so a reason phrased as an absolute
// ("only one writer can exist") would be false for those kinds.  Phrase the
// reason as what the slot actually buys.
func FixedConcurrency(max int, reason string) Concurrency {
	return Concurrency{max: max, fixed: true, reason: reason}
}

// TunableConcurrency declares a worker count that is a throughput knob: the
// value is a starting point and raising it costs only the resource named in
// the reason.
func TunableConcurrency(max int, reason string) Concurrency {
	return Concurrency{max: max, fixed: false, reason: reason}
}

// Max returns the worker count.
func (c Concurrency) Max() int { return c.max }

// Fixed reports whether the count is load-bearing rather than a knob.
func (c Concurrency) Fixed() bool { return c.fixed }

// Reason returns the prose recorded with the count.
func (c Concurrency) Reason() string { return c.reason }

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

// PeriodicSpec is the schedule half of an entry: what river's
// PeriodicJobEnqueuer does with this kind.
type PeriodicSpec struct {
	// Interval is how often river re-fires the job.
	Interval time.Duration

	// RunOnStart fires the job once at client Start, in addition to the
	// interval.
	//
	// True for every hourly sweep here, and that is not a preference.
	// river's OSS scheduler recomputes nextRunAt as now+Interval at every
	// Start, so a service that deploys more often than its interval would
	// otherwise never run the job at all.  False belongs to the two jobs
	// main.go enqueues by hand at boot (warm_season, orphan_scan) and to the
	// quarterly zh-Hant sweep, where a per-deploy whole-table pass is the
	// expensive mistake rather than the safe one.
	RunOnStart bool

	// Args builds the payload for one firing.  Nil means "the entry's own
	// zero-value Args", which is the common case — most sweeps read their
	// work list from the database and carry no payload at all.
	//
	// Non-nil exists for warm_season, whose payload is the CURRENT season:
	// computing it at firing time rather than at boot is what stops a
	// long-lived process from warming last quarter forever.
	Args func() river.JobArgs
}

// Entry is one job kind: what it is, where it runs, and when.
type Entry struct {
	// Args is a zero-value prototype of the job's payload type.  The
	// registry reads Kind() and InsertOpts() off it; it is never inserted.
	Args river.JobArgs

	// Queue is the river queue this kind is expected to ride.  Declared
	// rather than derived so that validate can cross-check it against what
	// Args.InsertOpts() actually returns — a mismatch between the two is
	// precisely the drift this file exists to make loud.
	Queue string

	// Periodic is the schedule, or nil for a kind that is only ever
	// enqueued by other code (per-row workers, and the chained enrichment
	// phases).
	Periodic *PeriodicSpec
}

// Kind returns the river kind string, read from the prototype.
func (e Entry) Kind() string { return e.Args.Kind() }

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// Registry is the whole set of queue and job declarations.  Build one with
// NewRegistry (which validates) and read river configuration off it.
//
// Treat instances as immutable: WithConcurrency returns a copy rather than
// editing in place, so a handler holding a registry cannot have it changed
// underneath.
type Registry struct {
	queues  map[string]Concurrency
	entries []Entry
}

// NewRegistry validates the declarations and returns a Registry, or an error
// naming the first problem.
//
// Production uses Default(), which panics on that error at package init.  The
// constructor returns it instead so tests can assert on the message.
func NewRegistry(queues map[string]Concurrency, entries []Entry) (*Registry, error) {
	r := &Registry{
		queues:  make(map[string]Concurrency, len(queues)),
		entries: append(([]Entry)(nil), entries...),
	}
	for name, c := range queues {
		r.queues[name] = c
	}
	if err := r.validate(); err != nil {
		return nil, err
	}
	return r, nil
}

// validate enforces the invariants that keep the registry honest.
//
// Every one of these is a mistake somebody can make in a hurry while adding
// the ninth sweep, and every one of them would otherwise show up as a job
// that quietly never runs.
func (r *Registry) validate() error {
	if len(r.queues) == 0 {
		return fmt.Errorf("queue registry: no queues declared")
	}

	for name, c := range r.queues {
		if name == "" {
			return fmt.Errorf("queue registry: queue name must not be empty")
		}
		if c.max < 1 {
			return fmt.Errorf("queue registry: queue %q has MaxWorkers %d, must be at least 1", name, c.max)
		}
		if c.reason == "" {
			return fmt.Errorf("queue registry: queue %q declares no reason for MaxWorkers %d", name, c.max)
		}
	}

	seen := make(map[string]struct{}, len(r.entries))
	used := make(map[string]struct{}, len(r.queues))

	for _, e := range r.entries {
		if e.Args == nil {
			return fmt.Errorf("queue registry: entry for queue %q has no Args prototype", e.Queue)
		}
		kind := e.Kind()
		if kind == "" {
			return fmt.Errorf("queue registry: entry on queue %q has an empty Kind()", e.Queue)
		}
		if _, dup := seen[kind]; dup {
			return fmt.Errorf("queue registry: kind %q declared twice", kind)
		}
		seen[kind] = struct{}{}

		if _, ok := r.queues[e.Queue]; !ok {
			return fmt.Errorf("queue registry: kind %q rides undeclared queue %q", kind, e.Queue)
		}
		used[e.Queue] = struct{}{}

		// The cross-check that makes this file a mirror rather than a
		// second opinion.  river routes by InsertOpts(), so if the two
		// disagree the registry's queue map is configuring a queue the job
		// never lands on.
		if actual := insertQueue(e.Args); actual != e.Queue {
			return fmt.Errorf(
				"queue registry: kind %q declares queue %q but its InsertOpts() routes to %q",
				kind, e.Queue, actual)
		}

		if e.Periodic != nil && e.Periodic.Interval <= 0 {
			return fmt.Errorf("queue registry: kind %q has a periodic schedule with interval %v", kind, e.Periodic.Interval)
		}
	}

	// A queue with no kind on it is a worker pool river will start and keep
	// idle forever — the shape left behind by a sweep that was removed, or
	// by a rename that landed on one side only.
	for name := range r.queues {
		if _, ok := used[name]; !ok {
			return fmt.Errorf("queue registry: queue %q is declared but no kind rides it", name)
		}
	}

	return nil
}

// insertQueue reports the queue an Args type actually routes to, applying
// river's own default for a type that declares no InsertOpts or leaves Queue
// empty.
func insertQueue(args river.JobArgs) string {
	withOpts, ok := args.(river.JobArgsWithInsertOpts)
	if !ok {
		return river.QueueDefault
	}
	if q := withOpts.InsertOpts().Queue; q != "" {
		return q
	}
	return river.QueueDefault
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// QueueConfigs returns the map for river.Config.Queues.
func (r *Registry) QueueConfigs() map[string]river.QueueConfig {
	out := make(map[string]river.QueueConfig, len(r.queues))
	for name, c := range r.queues {
		out[name] = river.QueueConfig{MaxWorkers: c.max}
	}
	return out
}

// PeriodicJobs returns the slice for river.Config.PeriodicJobs, in declaration
// order.
func (r *Registry) PeriodicJobs() []*river.PeriodicJob {
	var out []*river.PeriodicJob
	for _, e := range r.entries {
		if e.Periodic == nil {
			continue
		}
		var opts *river.PeriodicJobOpts
		if e.Periodic.RunOnStart {
			opts = &river.PeriodicJobOpts{RunOnStart: true}
		}

		// The closure captures the range variable, which Go scopes per
		// iteration (1.22+) — so this is one constructor per entry and not
		// ten pointing at the last one.  Hoisting `e` out of the loop would
		// reinstate exactly that bug, which is what the sibling test pins.
		out = append(out, river.NewPeriodicJob(
			river.PeriodicInterval(e.Periodic.Interval),
			func() (river.JobArgs, *river.InsertOpts) {
				if e.Periodic.Args != nil {
					return e.Periodic.Args(), nil
				}
				// nil InsertOpts on purpose: the Args type's own
				// InsertOpts() already pins the queue and the uniqueness,
				// and returning a second set here would be the drift this
				// file exists to prevent.
				return e.Args, nil
			},
			opts,
		))
	}
	return out
}

// Names returns every declared queue name, sorted.
func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.queues))
	for name := range r.queues {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// PausableNames returns the queue names the admin pause surface may target:
// every declared queue EXCEPT river.QueueDefault, sorted.
//
// default is excluded deliberately and permanently.  It is not one workload,
// it is four — V1, V2, warm_season and orphan_scan — so pausing it is the
// "accidentally freeze the whole queue subsystem" outcome the older, V3-only
// surface was narrowed to prevent.  Widening the surface to every queue is
// only safe because this one stays out of it.
func (r *Registry) PausableNames() []string {
	out := make([]string, 0, len(r.queues))
	for name := range r.queues {
		if name == river.QueueDefault {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Pausable reports whether name is a queue the admin surface may pause.
func (r *Registry) Pausable(name string) bool {
	if name == river.QueueDefault {
		return false
	}
	_, ok := r.queues[name]
	return ok
}

// Kinds returns every declared job kind, in declaration order.
func (r *Registry) Kinds() []string {
	out := make([]string, 0, len(r.entries))
	for _, e := range r.entries {
		out = append(out, e.Kind())
	}
	return out
}

// Entries returns a copy of the declarations.
func (r *Registry) Entries() []Entry {
	return append(([]Entry)(nil), r.entries...)
}

// Concurrency returns the declared concurrency for a queue.
func (r *Registry) Concurrency(name string) (Concurrency, bool) {
	c, ok := r.queues[name]
	return c, ok
}

// WithConcurrency returns a copy of the registry with one queue's worker count
// changed.  Refuses a queue that was declared with FixedConcurrency, naming
// the reason — the point of the type is that the number cannot be changed
// without reading why it is what it is.
func (r *Registry) WithConcurrency(name string, max int) (*Registry, error) {
	c, ok := r.queues[name]
	if !ok {
		return nil, fmt.Errorf("queue registry: unknown queue %q", name)
	}
	if c.fixed {
		return nil, fmt.Errorf("queue registry: queue %q has fixed concurrency %d: %s", name, c.max, c.reason)
	}
	if max < 1 {
		return nil, fmt.Errorf("queue registry: queue %q MaxWorkers %d, must be at least 1", name, max)
	}

	queues := make(map[string]Concurrency, len(r.queues))
	for k, v := range r.queues {
		queues[k] = v
	}
	queues[name] = TunableConcurrency(max, c.reason)
	return &Registry{queues: queues, entries: append(([]Entry)(nil), r.entries...)}, nil
}
