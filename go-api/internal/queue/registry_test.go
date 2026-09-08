// registry_test.go — unit coverage for the declarations and the invariants
// that keep them honest.
//
// Split in two.  The first half exercises the Registry machinery against
// small hand-built declaration sets, because that is the only way to see the
// error messages somebody adding the ninth sweep will actually hit.  The
// second half asserts facts about the PRODUCTION registry, which is the set
// that ships.
//
// What is deliberately NOT here: any assertion that a UniqueOpts state set
// contains the four states river requires.  Those constants are private to
// river (insert_opts.go requiredV3states) and hand-copying them would produce
// a gate that reports green while river reports an error — the exact failure
// shape this whole change exists to remove, with a reassuring test on top.
// The real check is the integration test, which runs river's own validate.
package queue

import (
	"reflect"
	"testing"
	"time"
	"unsafe"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// fakeArgs is a job type the tests can point anywhere.
type fakeArgs struct {
	kind  string
	queue string
}

func (a fakeArgs) Kind() string { return a.kind }
func (a fakeArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: a.queue}
}

// noOptsArgs declares no InsertOpts at all, so river routes it to default.
type noOptsArgs struct{}

func (noOptsArgs) Kind() string { return "no_opts" }

func okQueues() map[string]Concurrency {
	return map[string]Concurrency{
		"alpha": FixedConcurrency(1, "shared bucket"),
	}
}

func okEntries() []Entry {
	return []Entry{{Args: fakeArgs{kind: "a", queue: "alpha"}, Queue: "alpha"}}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

func TestNewRegistry_AcceptsAWellFormedSet(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(okQueues(), okEntries())
	require.NoError(t, err)
	assert.Equal(t, []string{"alpha"}, r.Names())
}

// TestNewRegistry_RejectsKindOnUndeclaredQueue is the "added the ninth sweep
// and forgot the queue" case.  Before the registry this produced a river
// client that accepted the insert and never dispatched it.
func TestNewRegistry_RejectsKindOnUndeclaredQueue(t *testing.T) {
	t.Parallel()

	_, err := NewRegistry(okQueues(), []Entry{
		{Args: fakeArgs{kind: "b", queue: "beta"}, Queue: "beta"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), `kind "b" rides undeclared queue "beta"`)
}

// TestNewRegistry_RejectsDeclaredQueueNoKindRides catches the other half of a
// half-finished rename: a worker pool river starts and keeps idle forever.
func TestNewRegistry_RejectsDeclaredQueueNoKindRides(t *testing.T) {
	t.Parallel()

	queues := okQueues()
	queues["orphaned"] = FixedConcurrency(1, "nothing rides this")

	_, err := NewRegistry(queues, okEntries())
	require.Error(t, err)
	assert.Contains(t, err.Error(), `queue "orphaned" is declared but no kind rides it`)
}

// TestNewRegistry_RejectsQueueDisagreeingWithInsertOpts is the invariant that
// makes this file a mirror of InsertOpts rather than a second opinion about
// it.  river routes by InsertOpts; a registry that says otherwise is
// configuring a queue the job never lands on.
func TestNewRegistry_RejectsQueueDisagreeingWithInsertOpts(t *testing.T) {
	t.Parallel()

	queues := okQueues()
	queues["beta"] = FixedConcurrency(1, "declared")

	_, err := NewRegistry(queues, []Entry{
		{Args: fakeArgs{kind: "a", queue: "alpha"}, Queue: "alpha"},
		// Declares beta, routes to alpha.
		{Args: fakeArgs{kind: "b", queue: "alpha"}, Queue: "beta"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(),
		`kind "b" declares queue "beta" but its InsertOpts() routes to "alpha"`)
}

// TestNewRegistry_TreatsMissingInsertOptsAsDefault pins river's own fallback:
// an Args type with no InsertOpts rides the default queue.  Three production
// kinds rely on this.
func TestNewRegistry_TreatsMissingInsertOptsAsDefault(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(
		map[string]Concurrency{river.QueueDefault: FixedConcurrency(1, "shared bucket")},
		[]Entry{{Args: noOptsArgs{}, Queue: river.QueueDefault}},
	)
	require.NoError(t, err)
	assert.Equal(t, []string{river.QueueDefault}, r.Names())
}

// TestNewRegistry_TreatsEmptyQueueInInsertOptsAsDefault covers the other
// spelling: a type that implements InsertOpts but leaves Queue blank.
func TestNewRegistry_TreatsEmptyQueueInInsertOptsAsDefault(t *testing.T) {
	t.Parallel()

	_, err := NewRegistry(
		map[string]Concurrency{river.QueueDefault: FixedConcurrency(1, "shared bucket")},
		[]Entry{{Args: fakeArgs{kind: "blank", queue: ""}, Queue: river.QueueDefault}},
	)
	require.NoError(t, err)
}

func TestNewRegistry_RejectsDuplicateKind(t *testing.T) {
	t.Parallel()

	_, err := NewRegistry(okQueues(), []Entry{
		{Args: fakeArgs{kind: "a", queue: "alpha"}, Queue: "alpha"},
		{Args: fakeArgs{kind: "a", queue: "alpha"}, Queue: "alpha"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), `kind "a" declared twice`)
}

func TestNewRegistry_RejectsZeroMaxWorkers(t *testing.T) {
	t.Parallel()

	_, err := NewRegistry(
		map[string]Concurrency{"alpha": FixedConcurrency(0, "oops")},
		okEntries(),
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "must be at least 1")
}

// TestNewRegistry_RejectsUnexplainedConcurrency is the point of the type.  A
// number with no reason is the thing that got copied eight times.
func TestNewRegistry_RejectsUnexplainedConcurrency(t *testing.T) {
	t.Parallel()

	_, err := NewRegistry(
		map[string]Concurrency{"alpha": FixedConcurrency(1, "")},
		okEntries(),
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "declares no reason")
}

func TestNewRegistry_RejectsNonPositivePeriodicInterval(t *testing.T) {
	t.Parallel()

	_, err := NewRegistry(okQueues(), []Entry{{
		Args:     fakeArgs{kind: "a", queue: "alpha"},
		Queue:    "alpha",
		Periodic: &PeriodicSpec{Interval: 0, RunOnStart: true},
	}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "periodic schedule with interval")
}

func TestNewRegistry_RejectsNilArgs(t *testing.T) {
	t.Parallel()

	_, err := NewRegistry(okQueues(), []Entry{{Queue: "alpha"}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no Args prototype")
}

// TestNewRegistry_CopiesInputs pins that a caller mutating the maps and slices
// it passed in cannot reach inside a validated registry afterwards.
func TestNewRegistry_CopiesInputs(t *testing.T) {
	t.Parallel()

	queues := okQueues()
	entries := okEntries()
	r, err := NewRegistry(queues, entries)
	require.NoError(t, err)

	queues["beta"] = FixedConcurrency(9, "snuck in")
	entries[0].Queue = "beta"

	assert.Equal(t, []string{"alpha"}, r.Names(), "queue map must be copied")
	assert.Equal(t, "alpha", r.Entries()[0].Queue, "entry slice must be copied")
}

// ---------------------------------------------------------------------------
// Concurrency: fixed vs tunable
// ---------------------------------------------------------------------------

func TestQueueConfigs_CarriesDeclaredMaxWorkers(t *testing.T) {
	t.Parallel()

	queues := map[string]Concurrency{
		"alpha": FixedConcurrency(1, "shared bucket"),
		"beta":  TunableConcurrency(4, "round-trips parallelise"),
	}
	r, err := NewRegistry(queues, []Entry{
		{Args: fakeArgs{kind: "a", queue: "alpha"}, Queue: "alpha"},
		{Args: fakeArgs{kind: "b", queue: "beta"}, Queue: "beta"},
	})
	require.NoError(t, err)

	cfgs := r.QueueConfigs()
	assert.Equal(t, 1, cfgs["alpha"].MaxWorkers)
	assert.Equal(t, 4, cfgs["beta"].MaxWorkers)
}

// TestWithConcurrency_RefusesFixedAndNamesTheReason is what makes Fixed more
// than a label: the number cannot be changed without reading why it is what
// it is.
func TestWithConcurrency_RefusesFixedAndNamesTheReason(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(okQueues(), okEntries())
	require.NoError(t, err)

	_, err = r.WithConcurrency("alpha", 4)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "fixed concurrency 1")
	assert.Contains(t, err.Error(), "shared bucket",
		"the refusal must carry the reason, not just the refusal")
}

func TestWithConcurrency_AllowsTunable(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(
		map[string]Concurrency{"beta": TunableConcurrency(4, "round-trips parallelise")},
		[]Entry{{Args: fakeArgs{kind: "b", queue: "beta"}, Queue: "beta"}},
	)
	require.NoError(t, err)

	tuned, err := r.WithConcurrency("beta", 8)
	require.NoError(t, err)
	assert.Equal(t, 8, tuned.QueueConfigs()["beta"].MaxWorkers)
	assert.Equal(t, 4, r.QueueConfigs()["beta"].MaxWorkers,
		"WithConcurrency must return a copy, not edit the receiver")
}

func TestWithConcurrency_RejectsUnknownQueue(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(okQueues(), okEntries())
	require.NoError(t, err)

	_, err = r.WithConcurrency("nope", 2)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `unknown queue "nope"`)
}

func TestWithConcurrency_RejectsZero(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(
		map[string]Concurrency{"beta": TunableConcurrency(4, "round-trips parallelise")},
		[]Entry{{Args: fakeArgs{kind: "b", queue: "beta"}, Queue: "beta"}},
	)
	require.NoError(t, err)

	_, err = r.WithConcurrency("beta", 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "must be at least 1")
}

// ---------------------------------------------------------------------------
// Pause whitelist
// ---------------------------------------------------------------------------

// TestPausableNames_ExcludesDefault pins the safety constraint the old
// V3-only surface was narrowed to enforce.  default carries V1, V2,
// warm_season and orphan_scan; pausing it freezes the enrichment a page load
// is waiting on.
func TestPausableNames_ExcludesDefault(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(
		map[string]Concurrency{
			river.QueueDefault: FixedConcurrency(1, "four workloads share it"),
			"alpha":            FixedConcurrency(1, "shared bucket"),
		},
		[]Entry{
			{Args: noOptsArgs{}, Queue: river.QueueDefault},
			{Args: fakeArgs{kind: "a", queue: "alpha"}, Queue: "alpha"},
		},
	)
	require.NoError(t, err)

	assert.Equal(t, []string{"alpha"}, r.PausableNames())
	assert.False(t, r.Pausable(river.QueueDefault),
		"default must never be pausable through the admin surface")
	assert.True(t, r.Pausable("alpha"))
	assert.Contains(t, r.Names(), river.QueueDefault,
		"Names() still reports default; only the pause whitelist excludes it")
}

func TestPausable_RejectsUnknownName(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(okQueues(), okEntries())
	require.NoError(t, err)

	assert.False(t, r.Pausable("does_not_exist"))
	assert.False(t, r.Pausable(""))
	assert.False(t, r.Pausable("*"),
		"river's all-queues wildcard must not reach the admin surface")
}

// ---------------------------------------------------------------------------
// Periodic jobs
// ---------------------------------------------------------------------------

func TestPeriodicJobs_SkipsUnscheduledKinds(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(okQueues(), []Entry{
		{Args: fakeArgs{kind: "a", queue: "alpha"}, Queue: "alpha"},
		{Args: fakeArgs{kind: "b", queue: "alpha"}, Queue: "alpha",
			Periodic: &PeriodicSpec{Interval: time.Hour}},
	})
	require.NoError(t, err)

	assert.Len(t, r.PeriodicJobs(), 1)
}

// TestPeriodicJobs_ConstructorsAreBoundPerEntry catches the classic loop-
// variable capture: every constructor returning the last entry's Args would
// leave nine kinds unscheduled and one scheduled ten times.
func TestPeriodicJobs_ConstructorsAreBoundPerEntry(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(okQueues(), []Entry{
		{Args: fakeArgs{kind: "a", queue: "alpha"}, Queue: "alpha",
			Periodic: &PeriodicSpec{Interval: time.Hour}},
		{Args: fakeArgs{kind: "b", queue: "alpha"}, Queue: "alpha",
			Periodic: &PeriodicSpec{Interval: time.Hour}},
	})
	require.NoError(t, err)

	jobs := r.PeriodicJobs()
	require.Len(t, jobs, 2)
	assert.Equal(t, []string{"a", "b"}, []string{
		periodicKind(t, jobs[0]), periodicKind(t, jobs[1]),
	})
}

// TestPeriodicJobs_UsesTheSpecArgsConstructorWhenGiven covers warm_season,
// whose payload is the CURRENT season and must be computed at firing time.
func TestPeriodicJobs_UsesTheSpecArgsConstructorWhenGiven(t *testing.T) {
	t.Parallel()

	calls := 0
	r, err := NewRegistry(okQueues(), []Entry{{
		Args:  fakeArgs{kind: "a", queue: "alpha"},
		Queue: "alpha",
		Periodic: &PeriodicSpec{Interval: time.Hour, Args: func() river.JobArgs {
			calls++
			return fakeArgs{kind: "computed", queue: "alpha"}
		}},
	}})
	require.NoError(t, err)

	jobs := r.PeriodicJobs()
	require.Len(t, jobs, 1)

	assert.Equal(t, "computed", periodicKind(t, jobs[0]))
	assert.Equal(t, "computed", periodicKind(t, jobs[0]))
	assert.Equal(t, 2, calls,
		"the constructor must run per firing, not once at registry build")
}

// TestPeriodicJobs_ReturnsNilInsertOpts pins the boundary decision: the
// schedule does not restate routing or uniqueness, because the Args type's
// own InsertOpts() already carries both and a second copy is the drift.
func TestPeriodicJobs_ReturnsNilInsertOpts(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(okQueues(), []Entry{{
		Args:     fakeArgs{kind: "a", queue: "alpha"},
		Queue:    "alpha",
		Periodic: &PeriodicSpec{Interval: time.Hour},
	}})
	require.NoError(t, err)

	_, opts := periodicConstructor(t, r.PeriodicJobs()[0])()
	assert.Nil(t, opts)
}

// ---------------------------------------------------------------------------
// The production registry
// ---------------------------------------------------------------------------

// TestDefaultRegistry_Validates is the guard on the guard.  Every assertion
// below it, and every boot of the server, depends on Default() having been
// constructible — and it is built in a package-level var, so a mistake in the
// declarations takes the process down at start.  This test is where that is
// meant to be caught instead.
func TestDefaultRegistry_Validates(t *testing.T) {
	t.Parallel()

	r, err := NewRegistry(productionQueues, productionEntries)
	require.NoError(t, err, "the production declarations must validate")
	require.NotNil(t, r)
	assert.Same(t, defaultRegistry, Default())
}

// TestDefaultRegistry_QueueNames pins the exact set.  A new queue is a
// deliberate act; arriving here by accident (a typo'd constant creating a
// ninth queue with one job on it) is not.
func TestDefaultRegistry_QueueNames(t *testing.T) {
	t.Parallel()

	assert.Equal(t, []string{
		BangumiV3QueueName,
		BgmBindQueueName,
		river.QueueDefault,
		DescriptionBackfillQueueName,
		DescriptionLlmQueueName,
		EpisodeTitlesQueueName,
		EpisodesBgmQueueName,
		HantBackfillQueueName,
		RatingsQueueName,
	}, Default().Names())
}

// TestDefaultRegistry_EveryKindIsDeclared pins the full kind list against the
// Args types that exist.  A kind added to args.go and not to the registry gets
// no queue configuration and no schedule — which is the shape of "the sweep
// silently never runs".
func TestDefaultRegistry_EveryKindIsDeclared(t *testing.T) {
	t.Parallel()

	declared := map[string]bool{}
	for _, k := range Default().Kinds() {
		declared[k] = true
	}

	// Every river.JobArgs implementation in this package.  Adding one here is
	// the deliberate half of adding a job; the compiler enforces the type and
	// this enforces the registration.
	for _, args := range []river.JobArgs{
		BangumiV1Args{},
		BangumiV2Args{},
		BangumiV3Args{},
		WarmSeasonArgs{},
		OrphanScanArgs{},
		DescriptionBackfillScanArgs{},
		DescriptionBackfillArgs{},
		DescriptionLlmBackfillScanArgs{},
		DescriptionLlmBackfillArgs{},
		EpisodesBgmScanArgs{},
		EpisodesBgmArgs{},
		EpisodeTitlesArgs{},
		BindIdMapArgs{},
		HantBackfillArgs{},
		AnilistRatingsArgs{},
		BangumiRatingsArgs{},
	} {
		assert.True(t, declared[args.Kind()],
			"kind %q implements river.JobArgs but is not in the registry: it would get "+
				"no queue configuration and no schedule", args.Kind())
	}
	assert.Len(t, Default().Kinds(), 16,
		"a kind was added to or removed from the registry without updating this list")
}

// TestDefaultRegistry_RunOnStartSplit pins which sweeps fire at boot.
//
// Getting this wrong is silent in both directions.  A missing RunOnStart on an
// hourly sweep means a service that deploys more often than hourly never
// sweeps at all, because river's OSS scheduler recomputes nextRunAt at every
// Start.  A spurious one on the quarterly zh-Hant sweep means a whole-table
// pass per deploy.
func TestDefaultRegistry_RunOnStartSplit(t *testing.T) {
	t.Parallel()

	runOnStart := map[string]bool{}
	for _, e := range Default().Entries() {
		if e.Periodic == nil {
			continue
		}
		runOnStart[e.Kind()] = e.Periodic.RunOnStart
	}

	assert.Equal(t, map[string]bool{
		// Boot-fired: hourly or six-hourly sweeps that a redeploying
		// service would otherwise never reach.
		"description_backfill_scan":     true,
		"description_llm_backfill_scan": true,
		"episodes_bgm_scan":             true,
		"episode_titles_releasing":      true,
		"bgm_bind_idmap":                true,
		"anilist_ratings":               true,
		"bangumi_ratings":               true,

		// Not boot-fired: main.go enqueues these two by hand at boot with
		// payloads the single-payload schedule cannot express...
		"warm_season": false,
		"orphan_scan": false,
		// ...and this one is a quarterly whole-table pass that must not
		// run once per deploy.
		"hant_backfill": false,
	}, runOnStart)
}

// TestDefaultRegistry_PeriodicJobsMatchDeclarations asserts the built river
// objects agree with the declarations, through river's own (unexported)
// fields rather than through the struct we just read.
func TestDefaultRegistry_PeriodicJobsMatchDeclarations(t *testing.T) {
	t.Parallel()

	jobs := Default().PeriodicJobs()
	require.Len(t, jobs, 10, "ten scheduled kinds")

	var want []Entry
	for _, e := range Default().Entries() {
		if e.Periodic != nil {
			want = append(want, e)
		}
	}
	require.Len(t, want, len(jobs))

	for i, job := range jobs {
		entry := want[i]
		assert.Equal(t, entry.Kind(), periodicKind(t, job),
			"PeriodicJobs must preserve declaration order")

		optsField := reflect.ValueOf(job).Elem().FieldByName("opts")
		require.True(t, optsField.IsValid(),
			"river.PeriodicJob no longer has an `opts` field — re-verify RunOnStart is still set")

		if !entry.Periodic.RunOnStart {
			assert.True(t, optsField.IsNil(),
				"kind %q declares RunOnStart=false but river was handed opts", entry.Kind())
			continue
		}

		require.False(t, optsField.IsNil(),
			"kind %q declares RunOnStart=true but river was handed nil opts, which defaults it to false",
			entry.Kind())
		runOnStart := optsField.Elem().FieldByName("RunOnStart")
		require.True(t, runOnStart.IsValid(),
			"river.PeriodicJobOpts no longer has RunOnStart — re-verify what these sweeps do at boot")
		assert.True(t, runOnStart.Bool(), "kind %q must fire at boot", entry.Kind())
	}
}

// TestDefaultRegistry_WarmSeasonPayloadIsBuiltAtFiringTime pins the one
// schedule with a computed payload.  A constant payload would pin a
// long-lived process to whichever season it booted in.
func TestDefaultRegistry_WarmSeasonPayloadIsBuiltAtFiringTime(t *testing.T) {
	t.Parallel()

	var warm *river.PeriodicJob
	for _, job := range Default().PeriodicJobs() {
		if periodicKind(t, job) == "warm_season" {
			warm = job
			break
		}
	}
	require.NotNil(t, warm)

	args, _ := periodicConstructor(t, warm)()
	payload, ok := args.(WarmSeasonArgs)
	require.True(t, ok)

	wantSeason, wantYear := CurrentSeason(time.Now())
	assert.Equal(t, wantSeason, payload.Season)
	assert.Equal(t, wantYear, payload.Year)
}

// TestDefaultRegistry_ConcurrencyIsExplained asserts every worker count in
// production carries prose.  These numbers were copied eight times across a
// 90-line map literal, and four of them are 1 for reasons that are not
// throughput.
func TestDefaultRegistry_ConcurrencyIsExplained(t *testing.T) {
	t.Parallel()

	for _, name := range Default().Names() {
		c, ok := Default().Concurrency(name)
		require.True(t, ok)
		assert.NotEmpty(t, c.Reason(), "queue %q must record why MaxWorkers is %d", name, c.Max())
		assert.GreaterOrEqual(t, c.Max(), 1)
	}
}

// TestDefaultRegistry_OnlyTheLlmQueueIsTunable pins the split.  Every other
// count is load-bearing: a shared upstream token bucket that extra workers
// only queue on, or a check-then-update race a single slot makes unreachable.
func TestDefaultRegistry_OnlyTheLlmQueueIsTunable(t *testing.T) {
	t.Parallel()

	var tunable []string
	for _, name := range Default().Names() {
		c, _ := Default().Concurrency(name)
		if !c.Fixed() {
			tunable = append(tunable, name)
		}
	}
	assert.Equal(t, []string{DescriptionLlmQueueName}, tunable)
}

// TestDefaultRegistry_MaxWorkersUnchanged pins the shipped numbers, so a
// change to one is a deliberate diff on a line that says what it costs.
func TestDefaultRegistry_MaxWorkersUnchanged(t *testing.T) {
	t.Parallel()

	cfgs := Default().QueueConfigs()
	assert.Equal(t, map[string]river.QueueConfig{
		river.QueueDefault:           {MaxWorkers: 1},
		BangumiV3QueueName:           {MaxWorkers: 1},
		DescriptionBackfillQueueName: {MaxWorkers: 1},
		DescriptionLlmQueueName:      {MaxWorkers: 4},
		HantBackfillQueueName:        {MaxWorkers: 1},
		EpisodesBgmQueueName:         {MaxWorkers: 1},
		EpisodeTitlesQueueName:       {MaxWorkers: 1},
		BgmBindQueueName:             {MaxWorkers: 1},
		RatingsQueueName:             {MaxWorkers: 1},
	}, cfgs)
}

// TestDefaultRegistry_DefaultQueueIsNotPausable is the production instance of
// the constraint control.go's package doc records: "so the admin endpoint
// can't accidentally freeze the whole queue subsystem".  Widening the pause
// surface from V3-only to every queue is safe only while this holds.
func TestDefaultRegistry_DefaultQueueIsNotPausable(t *testing.T) {
	t.Parallel()

	assert.False(t, Default().Pausable(river.QueueDefault))
	assert.NotContains(t, Default().PausableNames(), river.QueueDefault)
	assert.Len(t, Default().PausableNames(), 8,
		"eight dedicated queues are pausable; default is the ninth and stays out")
}

// ---------------------------------------------------------------------------
// Reflection helpers
// ---------------------------------------------------------------------------
//
// river keeps PeriodicJob's fields unexported and exposes no accessor, so
// reading them means reflection.  That couples these tests to river's
// internals on purpose: river is version-pinned, and an upgrade that reshapes
// PeriodicJob should stop and make somebody re-confirm these facts rather
// than silently carry an unverified assumption forward.

// periodicConstructor returns the job's constructor func.
func periodicConstructor(t *testing.T, job *river.PeriodicJob) river.PeriodicJobConstructor {
	t.Helper()

	field := reflect.ValueOf(job).Elem().FieldByName("constructorFunc")
	require.True(t, field.IsValid(),
		"river.PeriodicJob no longer has a `constructorFunc` field — re-verify these assertions")

	fn, ok := reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).
		Elem().Interface().(river.PeriodicJobConstructor)
	require.True(t, ok, "constructorFunc is no longer a river.PeriodicJobConstructor")
	return fn
}

// periodicKind runs the constructor and reports the kind it produced.
func periodicKind(t *testing.T, job *river.PeriodicJob) string {
	t.Helper()

	args, _ := periodicConstructor(t, job)()
	require.NotNil(t, args, "a periodic constructor must not return nil args")
	return args.Kind()
}
