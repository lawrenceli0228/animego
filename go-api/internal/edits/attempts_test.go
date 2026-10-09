package edits

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
)

func TestAttemptCounter(t *testing.T) {
	t.Parallel()
	c := newAttemptCounter(time.Minute, 2)
	u, v := uuid.New(), uuid.New()
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	assert.True(t, c.allow(u, now))
	assert.True(t, c.allow(u, now.Add(time.Second)))
	assert.False(t, c.allow(u, now.Add(59*time.Second)), "the third in the window")
	assert.True(t, c.allow(v, now), "each person has their own")
	assert.True(t, c.allow(u, now.Add(time.Minute)), "a new window")
}

// Windows that have run out are dropped once the counter tracks many
// people, so it does not grow with everyone who ever tried.
func TestAttemptCounter_DropsWindowsThatRanOut(t *testing.T) {
	t.Parallel()
	c := newAttemptCounter(time.Minute, 2)
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	for i := 0; i < attemptSweepAt; i++ {
		c.allow(uuid.New(), now)
	}
	fresh := uuid.New()
	c.allow(fresh, now.Add(2*time.Minute))
	assert.Len(t, c.seen, 1, "only the one still in its window")
}
