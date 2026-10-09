package community

import (
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/auth"
)

// Limit is one write budget: at most Max writes per user in each Window.
// Max 0 turns the limit off.
type Limit struct {
	Max    int
	Window time.Duration
}

// Limits are the per-user write budgets.  They sit behind the per-IP
// limiter every /api/ request already passes (httpmw), which cannot tell two
// accounts on one address apart, nor one account across addresses.
type Limits struct {
	// Reviews covers writing and editing.  A review is at least 300
	// characters, so a person who means it spends minutes on each.
	Reviews Limit
	// Threads is starting a thread.
	Threads Limit
	// Replies covers thread and activity replies together — each one can
	// notify somebody.
	Replies Limit
	// Reactions covers helpful votes and likes, which are cheap to toggle
	// and are only limited so a script cannot churn them.
	Reactions Limit
}

// DefaultLimits are the production budgets.
func DefaultLimits() Limits {
	return Limits{
		Reviews:   Limit{Max: 10, Window: time.Hour},
		Threads:   Limit{Max: 5, Window: time.Hour},
		Replies:   Limit{Max: 20, Window: 10 * time.Minute},
		Reactions: Limit{Max: 60, Window: 10 * time.Minute},
	}
}

// allower is the slice of auth.RateLimiter the handlers use.
type allower interface {
	Allow(key string) bool
}

// writeLimits holds one fixed-window counter per budget, keyed by user id.
// It reuses auth.RateLimiter — the same in-memory counter the login limiter
// is, keyed here by user rather than by address.  Counts live in this
// process: a restart forgets them, which on a single-instance deploy only
// ever errs towards letting a write through.
type writeLimits struct {
	reviews, threads, replies, reactions *auth.RateLimiter
}

func newWriteLimits(l Limits) *writeLimits {
	return &writeLimits{
		reviews:   auth.NewRateLimiter(l.Reviews.Max, l.Reviews.Window),
		threads:   auth.NewRateLimiter(l.Threads.Max, l.Threads.Window),
		replies:   auth.NewRateLimiter(l.Replies.Max, l.Replies.Window),
		reactions: auth.NewRateLimiter(l.Reactions.Max, l.Reactions.Window),
	}
}

func (w *writeLimits) stop() {
	w.reviews.Stop()
	w.threads.Stop()
	w.replies.Stop()
	w.reactions.Stop()
}
