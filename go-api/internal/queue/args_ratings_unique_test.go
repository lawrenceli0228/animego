package queue

import (
	"testing"

	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/assert"
)

// TestRatingsUniqueStatesMatchRiver pins the four states river's
// UniqueOpts.validate refuses to run without.
//
// This test exists because removing one of them is an attractive idea
// with a silent failure.  `running` looks like the cause of a real
// problem — a deploy that kills a pass leaves the row behind and the
// next boot's insert suppresses itself against it for the hour it takes
// river's rescuer to reclaim the orphan — so taking it out reads like
// the fix.  It is not: PeriodicJobEnqueuer then fails for this kind
// entirely, at ERROR level in the log and nowhere else.  The service
// starts, serves traffic, and never enqueues the sweep again.
//
// That was done on production on 2026-09-08 and turned a one-hour
// suppression into a permanent one.  Nothing caught it: the previous
// version of this test asserted the slice had four entries, which was
// true of the broken set — it kept the optional `retryable` and dropped
// the required `running`.  Counting is not the property; membership is.
func TestRatingsUniqueStatesMatchRiver(t *testing.T) {
	for _, required := range []rivertype.JobState{
		rivertype.JobStateAvailable,
		rivertype.JobStatePending,
		rivertype.JobStateRunning,
		rivertype.JobStateScheduled,
	} {
		assert.Contains(t, ratingsUniqueStates, required,
			"river's UniqueOpts.validate requires %s; without it PeriodicJobEnqueuer "+
				"fails for this kind and the sweep is never enqueued again — an ERROR "+
				"log line and no other symptom", required)
	}

	// retryable is ours, not river's: a pass in backoff after a failed
	// attempt is still this sweep in flight.
	assert.Contains(t, ratingsUniqueStates, rivertype.JobStateRetryable)

	// completed is deliberately absent — river keeps completed rows for
	// 24h, so including it would let an hourly job fire once a day.
	assert.NotContains(t, ratingsUniqueStates, rivertype.JobStateCompleted,
		"river keeps completed rows for 24h; suppressing on them would make an hourly sweep daily")
}
