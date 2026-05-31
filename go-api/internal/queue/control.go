// control.go — admin queue-control surface (pause / resume / status).
//
// Express equivalent: server/services/bangumi.service.js exports
// pauseV3() / resumeV3() / getQueueStatus().  Those functions held a
// module-level v3Paused bool that the in-process V3 loop checked on
// every dispatch.  Go uses river's native QueuePause / QueueResume /
// QueueGet against a named queue instead — river persists the
// PausedAt timestamp in river_queue so the state survives a process
// restart, which the Express in-memory flag never did.
//
// QUEUE NAMING:  the BangumiV3QueueName constant declares the queue
// that V3 enrichment jobs should ride on ("bangumi_v3").  At the time
// of this writing all four worker kinds (V1, V2, V3, warm_season)
// route to river.QueueDefault — see worker.go's default Queues map.
// The next wiring phase (P2.3.2 admin handler) will add InsertOpts to
// BangumiV3Args + register a "bangumi_v3" queue config so this pause
// surface actually pauses V3 jobs in isolation.  Until then, calling
// PauseV3 against the default boot config returns river's
// "queue not found" error (river.ErrNotFound) — the right failure
// mode (loud, observable) rather than silently pausing "default"
// (which would freeze V1+V2+warm_season too).
//
// Callers that want to pause all queues at once (the "*" wildcard
// supported by river.QueuePause) can do so via the underlying client
// directly — this package intentionally keeps the surface targeted
// to V3 so the admin endpoint can't accidentally freeze the whole
// queue subsystem.

package queue

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

// BangumiV3QueueName is the river queue name V3 enrichment jobs route
// to.  See the package doc for the wiring-phase TODO; today V3 still
// rides on river.QueueDefault — this constant declares the target
// queue so the admin pause/resume API has a stable contract that the
// wiring phase can flip on without touching call sites.
const BangumiV3QueueName = "bangumi_v3"

// Stats is the response shape for Status — the admin endpoint
// marshals this to JSON.  Mirrors the relevant subset of Express
// getQueueStatus() (which also reported in-memory queue depths from
// the now-deleted in-process maps).  In Go we expose only the V3
// pause flag here because depth + progress are observable via river's
// JobList surface from the admin handler when needed — keeping Stats
// small means the pause/resume control plane has one obvious truth.
//
// JSON field is "v3Paused" to match the Express camelCase contract
// the existing frontend already consumes.
type Stats struct {
	// V3Paused is true when the BangumiV3 queue (BangumiV3QueueName)
	// has a non-nil PausedAt timestamp in river_queue.  Survives
	// process restart because river persists pause state.
	V3Paused bool `json:"v3Paused"`
}

// QueueController is the small subset of *river.Client[pgx.Tx]
// surface this package needs.  Declared at the use-site (Accept
// interfaces, return structs) so unit tests can inject a fake without
// standing up Postgres + river.  *river.Client[pgx.Tx] satisfies it
// out of the box.
//
// All three methods take the queue name as a plain string so callers
// can target any queue (e.g. "*" for all-pause) — the package-level
// PauseV3 / ResumeV3 / Status helpers below pin the queue to
// BangumiV3QueueName.
type QueueController interface {
	QueuePause(ctx context.Context, name string, opts *river.QueuePauseOpts) error
	QueueResume(ctx context.Context, name string, opts *river.QueuePauseOpts) error
	QueueGet(ctx context.Context, name string) (*rivertype.Queue, error)
}

// Compile-time guard: *river.Client[pgx.Tx] must implement
// QueueController.  Catches API drift in the river dependency
// upgrade path (e.g. QueuePauseOpts → QueuePauseParams renames).
var _ QueueController = (*river.Client[pgx.Tx])(nil)

// PauseV3 pauses the V3 enrichment queue via river.QueuePause.
// No-op when the queue is already paused (river treats QueuePause as
// idempotent — a second pause just refreshes PausedAt).
//
// Returns the underlying river error wrapped with the queue name when
// the queue does not exist (river.ErrNotFound) — see package doc for
// the wiring-phase caveat.
func PauseV3(ctx context.Context, qc QueueController) error {
	slog.InfoContext(ctx, "queue: pauseV3", "queue", BangumiV3QueueName)
	if err := qc.QueuePause(ctx, BangumiV3QueueName, nil); err != nil {
		return fmt.Errorf("queue.PauseV3 (%s): %w", BangumiV3QueueName, err)
	}
	return nil
}

// ResumeV3 resumes the V3 enrichment queue via river.QueueResume.
// No-op when the queue is not paused — river clears PausedAt
// unconditionally.
//
// Returns the underlying river error wrapped with the queue name
// when the queue does not exist (river.ErrNotFound).
func ResumeV3(ctx context.Context, qc QueueController) error {
	slog.InfoContext(ctx, "queue: resumeV3", "queue", BangumiV3QueueName)
	if err := qc.QueueResume(ctx, BangumiV3QueueName, nil); err != nil {
		return fmt.Errorf("queue.ResumeV3 (%s): %w", BangumiV3QueueName, err)
	}
	return nil
}

// Status returns the current pause flag for the V3 queue.  Reads via
// river.QueueGet (river_queue table lookup) — does NOT count depth
// or JobList — that's a separate surface the admin handler can call
// directly when it needs it.
//
// Returns the underlying river error wrapped with the queue name
// when the queue does not exist (river.ErrNotFound).  Status is the
// only function callers can use to discover whether the queue exists
// at all in the river config, so propagating that error is
// intentional.
func Status(ctx context.Context, qc QueueController) (Stats, error) {
	slog.InfoContext(ctx, "queue: status", "queue", BangumiV3QueueName)
	q, err := qc.QueueGet(ctx, BangumiV3QueueName)
	if err != nil {
		return Stats{}, fmt.Errorf("queue.Status (%s): %w", BangumiV3QueueName, err)
	}
	return Stats{V3Paused: q.PausedAt != nil}, nil
}
