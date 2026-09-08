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
// QUEUE NAMING:  each *QueueName constant below declares the river queue
// one workload rides.  That wiring is live — the Args types carry the
// queue in their InsertOpts and registry_default.go configures a worker
// pool for each — so pausing one of these pauses that workload and
// nothing else.
//
// SCOPE: this surface used to be V3-only, with this note explaining why:
//
//	this package intentionally keeps the surface targeted to V3 so the
//	admin endpoint can't accidentally freeze the whole queue subsystem
//
// The constraint stands; only its implementation has moved.  PauseQueue
// takes any name, validates it against the registry, and refuses
// river.QueueDefault — which is the queue that constraint was really
// about, because default carries V1, V2, warm_season and orphan_scan at
// once.  river's "*" wildcard is refused by the same check.
//
// Widening the surface is what makes the other eight queues reachable at
// three in the morning without a deploy, which is the whole reason they
// were given dedicated queues in the first place.

package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

// BangumiV3QueueName is the river queue V3 enrichment jobs route to.
// BangumiV3Args.InsertOpts pins them to it and the registry configures its
// worker pool, so pausing it isolates heal-CN from V1/V2 and seasonal
// warming.
const BangumiV3QueueName = "bangumi_v3"

// DescriptionBackfillQueueName isolates the Chinese-description sweep from
// live enrichment.
//
// The sweep has thousands of rows to get through and no deadline, while V1/V2
// run in response to somebody loading a page. Sharing a queue would let the
// backlog sit in front of that work. Separate queues also make the sweep
// independently pausable, which matters because it is the one job here that
// can be safely stopped for a week without anybody noticing.
//
// Note this does NOT double the upstream request rate: the Bangumi rate
// limiter is a token bucket on the shared *bangumi.Client, so all queues draw
// from the same allowance and simply divide it.
const DescriptionBackfillQueueName = "description_backfill"

// DescriptionLlmQueueName isolates the LLM translation fallback from both
// live enrichment AND the Bangumi description sweep.
//
// Its resource is different in kind: the Bangumi queues are metered by the
// shared 800ms token bucket, while this one spends DeepSeek API tokens
// (money) and network round-trips of a few seconds each.  A separate queue
// makes it independently pausable — the one lever an operator wants if
// translation quality or spend ever needs a second look — and lets it run
// more than one worker without touching the Bangumi budget at all.
const DescriptionLlmQueueName = "description_llm"

// HantBackfillQueueName isolates the zh-Hant sweep from live enrichment.
//
// Same isolation argument as the description sweep, different resource:
// this job spends no upstream budget at all (both datasets and the
// conversion table are vendored files), it spends Postgres.  One pass
// reads every row in anime_cache including description_cn and can issue
// two dozen 500-row UPDATEs.  On the default queue that would sit in
// front of the V1/V2 jobs a page load is waiting on.
//
// A separate queue also makes it independently pausable, which is the
// lever an operator wants if a bad dataset ever gets vendored: pause the
// queue, and the in-flight sweep stops at a batch boundary without
// touching enrichment.
const HantBackfillQueueName = "hant_backfill"

// EpisodesBgmQueueName isolates the inferred-episode-count sweep from live
// enrichment.
//
// Same isolation argument as the description sweep, and the same resource:
// this job spends the shared Bangumi token bucket, two requests per row
// (subject for the identity gate, episode list for the count).  On the default
// queue a batch of those would sit in front of the V1/V2 jobs a page load is
// waiting on.
//
// The independent pause lever matters more here than for the other sweeps.
// This is the one worker whose output can reach a public, indexed page through
// a binding it did not itself create, so "stop it now, look at the data, decide
// later" has to be one call and not a deploy.
const EpisodesBgmQueueName = "episodes_bgm"

// EpisodeTitlesQueueName isolates the airing-show episode-title top-up.
//
// Its own queue for two reasons.  One pass can run for minutes -- one upstream
// request per candidate through a shared 800ms bucket -- and on the default
// queue that would hold the single worker slot away from the V1/V2 enrichment
// a page load is waiting on.
//
// The other is the kill switch.  EPISODE_TITLES_SWEEP_ENABLED gates the worker
// but only takes effect on restart; a queue of its own means river's runtime
// pause can stop this sweep, and only this sweep, without a deploy.  Same
// argument EpisodesBgmQueueName makes above, and for the same kind of output:
// rows that render on a public, indexed page.
const EpisodeTitlesQueueName = "episode_titles"

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
	//
	// Kept as its own field, spelled the way Express spelled it, because
	// the admin frontend already reads it.  It is the same value as
	// Paused[BangumiV3QueueName] when both are populated.
	V3Paused bool `json:"v3Paused"`

	// Paused reports the flag for every pausable queue, keyed by name.
	//
	// A queue river has no row for is ABSENT rather than false.  river
	// creates river_queue rows when a producer starts, so a missing entry
	// means "this process has not started that queue yet" — which is a
	// different thing from "running", and collapsing the two would put a
	// confident `false` next to a queue nobody is draining.
	Paused map[string]bool `json:"paused,omitempty"`
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

// ErrQueueNotPausable is returned for a queue name the admin surface must
// not act on: one the registry does not declare, and river.QueueDefault.
//
// A sentinel rather than a formatted string because the HTTP layer has to
// tell it apart from a river failure — this one is a 400 (the operator asked
// for something that does not exist) and everything else is a 500.
var ErrQueueNotPausable = errors.New("queue is not pausable")

// checkPausable validates a queue name against the registry.
//
// Two things are refused and only one of them is a typo.  An unknown name is
// the operator's mistake.  river.QueueDefault is OURS to refuse: it carries
// V1, V2, warm_season and orphan_scan, so pausing it freezes the enrichment a
// page load is waiting on, and river's "*" wildcard would freeze everything.
// Neither is something an admin endpoint should be able to reach.
func checkPausable(name string) error {
	if Default().Pausable(name) {
		return nil
	}
	if name == river.QueueDefault {
		return fmt.Errorf("%w: %q carries V1, V2, warm_season and orphan_scan at once", ErrQueueNotPausable, name)
	}
	return fmt.Errorf("%w: %q is not a declared queue", ErrQueueNotPausable, name)
}

// PausableQueues returns the queue names PauseQueue will accept.
func PausableQueues() []string { return Default().PausableNames() }

// PauseQueue pauses one named queue.
//
// Idempotent: river treats a second pause as a refresh of PausedAt, and the
// state is persisted in river_queue so it survives a restart — which the
// Express in-memory flag never did.
func PauseQueue(ctx context.Context, qc QueueController, name string) error {
	if err := checkPausable(name); err != nil {
		return err
	}
	slog.InfoContext(ctx, "queue: pause", "queue", name)
	if err := qc.QueuePause(ctx, name, nil); err != nil {
		return fmt.Errorf("queue.PauseQueue (%s): %w", name, err)
	}
	return nil
}

// ResumeQueue resumes one named queue.  Idempotent: river clears PausedAt
// unconditionally.
func ResumeQueue(ctx context.Context, qc QueueController, name string) error {
	if err := checkPausable(name); err != nil {
		return err
	}
	slog.InfoContext(ctx, "queue: resume", "queue", name)
	if err := qc.QueueResume(ctx, name, nil); err != nil {
		return fmt.Errorf("queue.ResumeQueue (%s): %w", name, err)
	}
	return nil
}

// QueuePaused reports whether one named queue is paused.
//
// Being able to stop a queue without being able to see whether it stopped is
// half a switch, and the half that is missing is the one an operator needs at
// three in the morning.
func QueuePaused(ctx context.Context, qc QueueController, name string) (bool, error) {
	if err := checkPausable(name); err != nil {
		return false, err
	}
	q, err := qc.QueueGet(ctx, name)
	if err != nil {
		return false, fmt.Errorf("queue.QueuePaused (%s): %w", name, err)
	}
	return q.PausedAt != nil, nil
}

// StatusAll reports the pause flag for every pausable queue.
//
// A queue river has no row for is omitted rather than reported false: river
// creates river_queue rows when a producer starts, so its absence means "not
// started here", which is not the same claim as "running".  Any other error
// is returned, because a status surface that hides failures is the shape this
// whole change exists to remove.
func StatusAll(ctx context.Context, qc QueueController) (Stats, error) {
	names := PausableQueues()
	out := Stats{Paused: make(map[string]bool, len(names))}

	for _, name := range names {
		q, err := qc.QueueGet(ctx, name)
		if errors.Is(err, river.ErrNotFound) {
			continue
		}
		if err != nil {
			return Stats{}, fmt.Errorf("queue.StatusAll (%s): %w", name, err)
		}
		paused := q.PausedAt != nil
		out.Paused[name] = paused
		if name == BangumiV3QueueName {
			out.V3Paused = paused
		}
	}
	return out, nil
}

// PauseV3 pauses the V3 enrichment queue via river.QueuePause.
// No-op when the queue is already paused (river treats QueuePause as
// idempotent — a second pause just refreshes PausedAt).
//
// Returns the underlying river error wrapped with the queue name when
// the queue does not exist (river.ErrNotFound) — see package doc for
// the wiring-phase caveat.
func PauseV3(ctx context.Context, qc QueueController) error {
	return PauseQueue(ctx, qc, BangumiV3QueueName)
}

// ResumeV3 resumes the V3 enrichment queue via river.QueueResume.
// No-op when the queue is not paused — river clears PausedAt
// unconditionally.
//
// Returns the underlying river error wrapped with the queue name
// when the queue does not exist (river.ErrNotFound).
func ResumeV3(ctx context.Context, qc QueueController) error {
	return ResumeQueue(ctx, qc, BangumiV3QueueName)
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
	paused, err := QueuePaused(ctx, qc, BangumiV3QueueName)
	if err != nil {
		return Stats{}, err
	}
	return Stats{V3Paused: paused}, nil
}

// RatingsQueueName isolates the two rating-refresh sweeps.
//
// Its own queue for the reason EpisodesBgmQueueName and
// EpisodeTitlesQueueName each give: a Bangumi pass runs for minutes —
// one request per candidate through the 800ms bucket — and on the
// default queue that would hold the single worker slot away from the
// V1/V2 enrichment a page load is waiting on.
//
// It is also the kill switch.  These sweeps write two numbers that
// render on public, indexed pages, and they walk the whole catalogue to
// do it; river's runtime pause can stop them, and only them, without a
// deploy.
//
// Both kinds share one queue rather than taking one each.  They are the
// same feature and are turned off for the same reasons, so a single
// pause is the control an operator actually wants.
//
// The queue is configured with ONE worker slot, so the two sweeps do
// wait for each other: about five minutes of every hour, which is the
// price of making two passes of the same kind unable to overlap.  An
// earlier version of this sentence said two slots and was wrong on
// HEAD -- see the MaxWorkers block in cmd/server/main.go, which is the
// authority.
const RatingsQueueName = "ratings"
