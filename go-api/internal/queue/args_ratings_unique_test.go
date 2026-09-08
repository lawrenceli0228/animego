package queue

import (
	"testing"

	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/assert"
)

// TestRatingsUniqueStatesExcludeRunning pins the one entry that is absent
// on purpose, because absence is not something a reader can see.
//
// A `running` row does not mean a pass is running -- it means one was
// running when the row was last written, and a deploy kills the process
// without changing it.  River reclaims such a row only through its
// rescuer, an hour later by default.  With `running` in this set, the
// boot-time RunOnStart insert suppresses itself against the corpse of the
// pass the deploy just killed: measured on prod 2026-09-08, both sweeps
// sat in `running` for 59 minutes producing nothing, which is also what a
// caught-up sweep looks like, so nothing reported it.
//
// Adding it back is a one-word edit that reads like tightening the
// constraint.  This test is what says otherwise.
func TestRatingsUniqueStatesExcludeRunning(t *testing.T) {
	assert.NotContains(t, ratingsUniqueStates, rivertype.JobStateRunning,
		"a `running` row can be an orphan from a killed deploy for up to an hour; "+
			"suppressing on it silently stops the sweep for that hour. "+
			"Concurrency is prevented by the ratings queue's MaxWorkers=1, not by this set")

	// The rest of the set is the point of having one at all: without
	// these, a periodic insert would stack a second pass behind one that
	// has not started yet.
	for _, want := range []rivertype.JobState{
		rivertype.JobStateAvailable,
		rivertype.JobStatePending,
		rivertype.JobStateRetryable,
		rivertype.JobStateScheduled,
	} {
		assert.Contains(t, ratingsUniqueStates, want)
	}

	// river validates that its four required states are present; a set
	// missing one is rejected at insert time, in production, not here.
	assert.Len(t, ratingsUniqueStates, 4)
}
