package edits

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// attemptCounter counts each person's submission attempts in a fixed
// window (attemptWindow, attemptMax: submit.go).
type attemptCounter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	seen   map[uuid.UUID]attemptWindowCount
	swept  time.Time
}

type attemptWindowCount struct {
	n     int
	reset time.Time
}

// attemptSweepAt is how many people the counter tracks before it drops the
// windows that have run out (at most once a window), so it holds roughly
// the people who tried lately and no more.
const attemptSweepAt = 1024

func newAttemptCounter(window time.Duration, max int) *attemptCounter {
	return &attemptCounter{window: window, max: max, seen: map[uuid.UUID]attemptWindowCount{}}
}

// allow counts an attempt by user and reports whether it is within the
// limit.
func (c *attemptCounter) allow(user uuid.UUID, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.seen) >= attemptSweepAt && now.Sub(c.swept) >= c.window {
		for id, w := range c.seen {
			if !now.Before(w.reset) {
				delete(c.seen, id)
			}
		}
		c.swept = now
	}
	w, ok := c.seen[user]
	if !ok || !now.Before(w.reset) {
		w = attemptWindowCount{reset: now.Add(c.window)}
	}
	if w.n >= c.max {
		return false
	}
	c.seen[user] = attemptWindowCount{n: w.n + 1, reset: w.reset}
	return true
}
