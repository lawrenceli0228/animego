// workers_test.go — the gate that every registered job kind has a worker.
//
// This check has to live somewhere, and river will not do it.  The registry
// gives a kind a queue and a schedule; river's PERIODIC insert path
// (insertParamsFromConfigArgsAndOptions) never consults the workers bundle,
// so a scheduled kind with no worker is inserted happily and only fails later
// when a producer tries to run it — as a job that errors and retries, which
// looks like a flaky upstream rather than a wiring mistake.
//
// client.Insert does check, which is why the integration suite can pin that
// behaviour; but nothing on the boot path exercises Insert for these kinds.
// So the check is here, against the real bundle main() builds.
package main

import (
	"reflect"
	"testing"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// TestBuildWorkers_CoversEveryRegisteredKind is the whole point of extracting
// buildWorkers out of main().
//
// Every dependency is nil.  Registration only constructs the workers; nothing
// here runs one, so no client is ever dialled.  That is what makes the check
// cheap enough to be a unit test.
func TestBuildWorkers_CoversEveryRegisteredKind(t *testing.T) {
	t.Parallel()

	workers := buildWorkers(workerDeps{})
	require.NotNil(t, workers)

	registered := registeredKinds(t, workers)
	for _, kind := range queue.Default().Kinds() {
		assert.Contains(t, registered, kind,
			"kind %q is in the queue registry — so it gets a queue and, if scheduled, "+
				"river will enqueue it — but buildWorkers registers no worker for it. "+
				"The job would be created and then fail at dispatch.", kind)
	}
}

// TestBuildWorkers_RegistersNothingUnknown catches the other direction: a
// worker for a kind the registry does not know about gets no queue
// configuration, so its jobs sit unfetched on a queue river never starts a
// producer for.
func TestBuildWorkers_RegistersNothingUnknown(t *testing.T) {
	t.Parallel()

	declared := make(map[string]bool)
	for _, kind := range queue.Default().Kinds() {
		declared[kind] = true
	}

	for _, kind := range registeredKinds(t, buildWorkers(workerDeps{})) {
		assert.True(t, declared[kind],
			"a worker is registered for kind %q but the registry does not declare it, "+
				"so no queue is configured for its jobs", kind)
	}
}

// registeredKinds reads the kinds out of a river.Workers bundle.
//
// river keeps the map unexported and offers no accessor, so this is
// reflection — the same deliberate coupling the periodic-job tests take, and
// for the same reason: river is version-pinned, and an upgrade that reshapes
// Workers should stop and make somebody re-confirm this rather than let the
// check quietly become a no-op.
//
// The require below is what stops that.  A rename would otherwise leave this
// test iterating an empty list and passing.
func registeredKinds(t *testing.T, w *river.Workers) []string {
	t.Helper()

	field := reflect.ValueOf(w).Elem().FieldByName("workersMap")
	require.True(t, field.IsValid(),
		"river.Workers no longer has a `workersMap` field — this check has become "+
			"a no-op and needs rewriting against the new shape")
	require.Equal(t, reflect.Map, field.Kind())
	require.NotZero(t, field.Len(),
		"the bundle registered no workers at all, which means this check would pass "+
			"vacuously")

	out := make([]string, 0, field.Len())
	for _, key := range field.MapKeys() {
		out = append(out, key.String())
	}
	return out
}
