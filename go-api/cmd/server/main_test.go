// Tests for the river_job aggregate bucketing behind /api/admin/stats'
// `queue` object.
//
// Everything here is a way the dashboard could report a broken Chinese-
// description sweep as a healthy one.  That is the only reason the panel
// splits river states at all (D4), so the split is worth pinning down:
// the SQL is verifiable by hand (the query is quoted in main.go), but the
// Go-side bucketing is not, and it is where "retryable counts as queued"
// would silently creep back in.
package main

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/lawrenceli0228/animego/go-api/internal/admin"
)

// row mirrors one output row of the `GROUP BY kind, state` aggregate.
type row struct {
	kind  string
	state string
	cnt   int64
}

func fold(rows []row) admin.QueueSnapshot {
	var d queueDepths
	for _, r := range rows {
		d.add(r.kind, r.state, r.cnt)
	}
	var snap admin.QueueSnapshot
	d.publish(&snap)
	return snap
}

// A failing upstream must NOT look like a busy-but-healthy queue.  This is
// the whole point of the state split: with the old single depth number,
// 40 jobs sitting in backoff after a bgm.tv outage and 40 jobs waiting
// their turn produced the identical reading.
func TestQueueDepths_RetryableIsNotQueued(t *testing.T) {
	snap := fold([]row{
		{"description_backfill", "retryable", 40},
	})

	assert.EqualValues(t, 0, snap.DescriptionBackfill.Queued,
		"retryable is work that already FAILED — counting it as queued makes an upstream outage read as a healthy backlog")
	assert.EqualValues(t, 40, snap.DescriptionBackfill.Retrying)
	assert.EqualValues(t, 0, snap.DescriptionBackfill.Discarded)
}

// Rows we have permanently given up on get their own counter.  Folded into
// either of the other two they would look like work still in flight, and
// nothing on the page would ever say "these need a manual re-enqueue".
func TestQueueDepths_DiscardedIsItsOwnBucket(t *testing.T) {
	snap := fold([]row{
		{"description_backfill", "discarded", 7},
	})

	assert.EqualValues(t, 7, snap.DescriptionBackfill.Discarded)
	assert.EqualValues(t, 0, snap.DescriptionBackfill.Queued)
	assert.EqualValues(t, 0, snap.DescriptionBackfill.Retrying)
}

// The four live states collapse into one queued number, and they add up
// rather than overwrite — one kind now yields several rows, so an `=`
// assignment would report only whichever state the planner emitted last.
func TestQueueDepths_LiveStatesAccumulateIntoQueued(t *testing.T) {
	snap := fold([]row{
		{"description_backfill", "available", 100},
		{"description_backfill", "running", 1},
		{"description_backfill", "pending", 2},
		{"description_backfill", "scheduled", 3},
	})

	assert.EqualValues(t, 106, snap.DescriptionBackfill.Queued)
	assert.EqualValues(t, 0, snap.DescriptionBackfill.Retrying)
	assert.EqualValues(t, 0, snap.DescriptionBackfill.Discarded)
}

// The regression this change could plausibly have introduced: 'discarded'
// was added to the SQL WHERE clause for the backfill split, and the legacy
// phase gauges mean "outstanding work".  A pile of dead bangumi_v1 jobs
// must not show up as a phase-1 backlog that never drains.
func TestQueueDepths_TerminalStatesNeverInflateLegacyGauges(t *testing.T) {
	snap := fold([]row{
		{"bangumi_v1", "available", 5},
		{"bangumi_v1", "discarded", 900},
		{"bangumi_v2", "cancelled", 900},
		{"bangumi_v3", "completed", 900},
		{"bangumi_v3", "running", 1},
	})

	assert.EqualValues(t, 5, snap.Phase1, "discarded bangumi_v1 jobs are finished, badly — not outstanding work")
	assert.EqualValues(t, 0, snap.Phase4)
	assert.EqualValues(t, 1, snap.V3)
}

// retryable is still live work for the legacy gauges — their contract is
// "how much is outstanding", and a job in backoff will be attempted again.
// Only the backfill block splits it out, because only it has somewhere to
// put the distinction.
func TestQueueDepths_LegacyGaugesKeepRetryable(t *testing.T) {
	snap := fold([]row{
		{"bangumi_v1", "available", 2},
		{"bangumi_v1", "retryable", 3},
	})

	assert.EqualValues(t, 5, snap.Phase1)
}

// 'description_backfill_scan' is a DIFFERENT kind from
// 'description_backfill'.  A prefix match instead of an equality check
// would fold the hourly scan into the per-row queue depth and make an
// idle-but-alive sweep look like it has work in front of it.  The scan's
// health is reported by LastScanAt instead.
func TestQueueDepths_ScanKindIsNotTheBackfillQueue(t *testing.T) {
	snap := fold([]row{
		{"description_backfill_scan", "available", 1},
		{"description_backfill_scan", "retryable", 1},
	})

	assert.EqualValues(t, 0, snap.DescriptionBackfill.Queued)
	assert.EqualValues(t, 0, snap.DescriptionBackfill.Retrying)
	assert.EqualValues(t, 0, snap.Phase1)
	assert.EqualValues(t, 0, snap.Phase4)
	assert.EqualValues(t, 0, snap.V3)
}

// Kinds that share the queue but not this panel (warm_season, orphan_scan)
// must not leak into any counter.
func TestQueueDepths_UnrelatedKindsIgnored(t *testing.T) {
	snap := fold([]row{
		{"warm_season", "available", 4},
		{"orphan_scan", "running", 1},
	})

	assert.Equal(t, admin.QueueSnapshot{}, snap)
}

// A mixed, realistic result set: every counter reads independently and
// nothing bleeds between kinds.
func TestQueueDepths_MixedAggregate(t *testing.T) {
	snap := fold([]row{
		{"bangumi_v1", "available", 12},
		{"bangumi_v2", "retryable", 4},
		{"bangumi_v3", "running", 1},
		{"bangumi_v3", "discarded", 50},
		{"description_backfill", "available", 287},
		{"description_backfill", "running", 1},
		{"description_backfill", "retryable", 9},
		{"description_backfill", "discarded", 3},
		{"description_backfill_scan", "available", 1},
		{"warm_season", "scheduled", 2},
	})

	assert.EqualValues(t, 12, snap.Phase1)
	assert.EqualValues(t, 4, snap.Phase4)
	assert.EqualValues(t, 1, snap.V3)
	assert.EqualValues(t, 288, snap.DescriptionBackfill.Queued)
	assert.EqualValues(t, 9, snap.DescriptionBackfill.Retrying)
	assert.EqualValues(t, 3, snap.DescriptionBackfill.Discarded)
	assert.Nil(t, snap.DescriptionBackfill.LastScanAt,
		"depth folding must not invent heartbeats — those are separate queries")
	assert.Nil(t, snap.DescriptionBackfill.LastWriteAt)
}

// An empty aggregate is the steady state of a drained sweep, not an error.
// It must produce the same zero shape the handler emits when the query
// fails outright, so the wire contract has exactly one zero form.
func TestQueueDepths_EmptyAggregateIsZeroSnapshot(t *testing.T) {
	assert.Equal(t, admin.QueueSnapshot{}, fold(nil))
}
