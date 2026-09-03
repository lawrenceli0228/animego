// Package queue — V1 enrichment trigger surface.
//
// Enqueuer is the small interface services consume to dispatch V1 jobs.
// *RealEnqueuer wraps a *river.Client[pgx.Tx] and uses InsertMany for
// batched enqueue (cheaper than per-row Insert).
//
// Pass a *NoopEnqueuer for tests / boot-time when river isn't available.
//
// Three production trigger sources call this surface:
//
//  1. /search post-upsert — after upserting AniList rows the handler
//     filters bangumi_version=0 ids and enqueues V1 jobs.
//  2. /schedule post-lookup — the titleChinese lookup already returns
//     bangumi_version per row, so the handler filters and enqueues.
//  3. Boot-time orphan scan (see orphan.go) — catches anime upserted
//     during a worker outage.
//
// The Enqueuer interface lives here at the consumer-friendly edge of the
// package (services accept the interface, this package implements it)
// per "Accept interfaces, return structs".

package queue

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

// Enqueuer is the enrichment dispatch interface.  Tests inject mocks;
// production wires *RealEnqueuer.  Callers may pass a NoopEnqueuer{}
// (or nil — services swap nil for NoopEnqueuer{}) to skip enqueue
// during boot before river is started.
//
// V1 jobs are seeded by the upsert paths (/search, /schedule, boot
// orphan scan).  V2 jobs are chained from the V1 worker when a
// Bangumi hit produced a bgm_id — services do NOT call EnqueueV2Many
// directly.  V3 jobs are chained from the V2 worker when V2's Subject
// didn't supply a Chinese title; services do NOT call EnqueueV3Many
// directly.  All three methods live on the same interface so each
// worker can hold a single dependency rather than three narrow ones.
//
// EnqueueDescriptionBackfillMany sits outside that chain entirely:
// it is fed by the periodic description_backfill_scan worker sweeping
// rows that already exist, not by any stage of the V1→V2→V3
// lifecycle.  It joins this interface for the same reason the others
// share it — one dependency per worker beats a second narrow one.
type Enqueuer interface {
	EnqueueV1Many(ctx context.Context, anilistIDs []int32) error
	EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error
	EnqueueV3Many(ctx context.Context, jobs []BangumiV3Args) error
	// EnqueueDescriptionBackfillMany seeds the Chinese-description
	// sweep.  Unlike the V1→V2→V3 chain this is NOT chained from a
	// worker in the enrichment lifecycle — the periodic scan worker
	// (description_backfill_scan) is its only production caller, and
	// it feeds rows the sweep query already vetted.
	EnqueueDescriptionBackfillMany(ctx context.Context, jobs []DescriptionBackfillArgs) error
	// EnqueueDescriptionLlmBackfillMany seeds the LLM translation
	// fallback sweep.  Same shape and stance as the Bangumi sweep's
	// method above: fed only by its periodic scan worker, rows already
	// vetted by the candidate query.
	EnqueueDescriptionLlmBackfillMany(ctx context.Context, jobs []DescriptionLlmBackfillArgs) error
	//
	// NOTE: EnqueueEpisodesBgmMany is deliberately NOT a member here.  It
	// is declared as the one-method EpisodesBgmEnqueuer in
	// bangumi_episodes.go and carried on the same three implementations
	// as everything above.  Widening this interface would oblige every
	// test double of it — in three packages, several of which have
	// nothing to do with enrichment — to grow a stub for a capability
	// they never exercise.  See episodesBgmEnqueuerFrom for how the warm
	// worker reaches it and what happens when a double lacks it.
	// EnqueueWarmSeasonNow inserts a single WarmSeasonArgs job for
	// immediate dispatch.  Used at boot time to seed the initial
	// current + next season pair; the 24h periodic schedule (configured
	// via queue.Config.PeriodicJobs) handles steady-state re-warm.
	EnqueueWarmSeasonNow(ctx context.Context, args WarmSeasonArgs) error
	// EnqueueHantBackfillNow inserts the zh-Hant sweep for immediate
	// dispatch.  Its only production caller is the admin button
	// (POST /api/admin/hant/backfill); the 90-day periodic schedule
	// inserts the same job through river's own scheduler.
	//
	// Returns whether a job was actually inserted, because "no" is the
	// normal answer rather than an error: HantBackfillArgs is unique
	// across every non-terminal state, so pressing the button while a
	// sweep is queued or running collapses into the one already there.
	// A caller that reported "enqueued" either way would let an operator
	// believe a second pass had been scheduled.
	EnqueueHantBackfillNow(ctx context.Context) (inserted bool, err error)
}

// RealEnqueuer wraps a river client and batches V1 inserts via
// river.Client.InsertMany so each batch is one statement round-trip
// rather than len(ids) inserts.
type RealEnqueuer struct {
	client *river.Client[pgx.Tx]
}

// NewEnqueuer returns a real river-backed enqueuer.  The caller owns
// the river client lifecycle (Boot + Start + Stop); this wrapper just
// borrows it for dispatch.
func NewEnqueuer(c *river.Client[pgx.Tx]) *RealEnqueuer {
	return &RealEnqueuer{client: c}
}

// EnqueueV1Many inserts V1 jobs for each anilistID.  Empty slice → noop
// (no error, no river call).  Uses river.Client.InsertMany so the
// round-trip is one statement per batch.  Errors are wrapped with the
// batch size so logs at the call site can distinguish "1 of 100 failed"
// from "all 100 failed" without re-deriving from the underlying pg
// error.
func (e *RealEnqueuer) EnqueueV1Many(ctx context.Context, anilistIDs []int32) error {
	if len(anilistIDs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(anilistIDs))
	for i, id := range anilistIDs {
		params[i] = river.InsertManyParams{Args: BangumiV1Args{AnilistID: int(id)}}
	}
	if _, err := e.client.InsertMany(ctx, params); err != nil {
		return fmt.Errorf("queue.EnqueueV1Many (n=%d): %w", len(anilistIDs), err)
	}
	return nil
}

// EnqueueV2Many inserts V2 jobs for each {anilistId, bgmId} pair.
// Empty slice → noop.  Uses river.Client.InsertMany so the round-trip
// is one statement per batch.  Errors are wrapped with the batch
// size so the call site (V1 worker chain) can distinguish "1 of N
// failed" from "all N failed" without re-deriving from pg error.
//
// Production: only the V1 worker calls this (after a Bangumi search
// hit produces a bgm_id).  Services that seed V1 jobs do NOT touch
// V2 — keeps the lifecycle one-way (V1 → V2 → V3) at the queue level.
func (e *RealEnqueuer) EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error {
	if len(jobs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(jobs))
	for i, j := range jobs {
		params[i] = river.InsertManyParams{Args: j}
	}
	if _, err := e.client.InsertMany(ctx, params); err != nil {
		return fmt.Errorf("queue.EnqueueV2Many (n=%d): %w", len(jobs), err)
	}
	return nil
}

// EnqueueV2ManyTx is EnqueueV2Many inside a caller-supplied transaction.
//
// It exists for one caller: the id-map bind sweep, which writes a binding and
// dispatches that binding's enrichment as a single unit.  Doing those in two
// transactions has a failure mode with no recovery path -- the bind commits,
// the insert fails, and the row now has a bgm_id, so the sweep's own candidate
// query (bgm_id IS NULL) never returns it again.  The enrichment for that row
// is then lost permanently and silently.  Sharing the transaction makes the
// two outcomes the only two possible: bound and queued, or neither.
//
// Every other enqueue path is deliberately NOT transactional.  The V1→V2 and
// V2→V3 chains enqueue AFTER their own write has committed, where a failed
// insert costs a re-run rather than a lost row, so they take the simpler
// non-transactional call and swallow the error.
func (e *RealEnqueuer) EnqueueV2ManyTx(ctx context.Context, tx pgx.Tx, jobs []BangumiV2Args) error {
	if len(jobs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(jobs))
	for i, j := range jobs {
		params[i] = river.InsertManyParams{Args: j}
	}
	if _, err := e.client.InsertManyTx(ctx, tx, params); err != nil {
		return fmt.Errorf("queue.EnqueueV2ManyTx (n=%d): %w", len(jobs), err)
	}
	return nil
}

// EnqueueV3Many inserts V3 heal-CN jobs for each {anilistId, bgmId}
// pair.  Empty slice → noop.  Uses river.Client.InsertMany so the
// round-trip is one statement per batch.  Errors are wrapped with
// the batch size so the call site (V2 worker chain) can distinguish
// "1 of N failed" from "all N failed" without re-deriving from pg
// error.
//
// Production: only the V2 worker calls this (after a successful
// UpdateBangumiV2 where Subject.NameCN was empty — the row may still
// be NULL on title_chinese).  Services that seed V1 jobs do NOT
// touch V3 — keeps the lifecycle one-way (V1 → V2 → V3).
func (e *RealEnqueuer) EnqueueV3Many(ctx context.Context, jobs []BangumiV3Args) error {
	if len(jobs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(jobs))
	for i, j := range jobs {
		params[i] = river.InsertManyParams{Args: j}
	}
	if _, err := e.client.InsertMany(ctx, params); err != nil {
		return fmt.Errorf("queue.EnqueueV3Many (n=%d): %w", len(jobs), err)
	}
	return nil
}

// EnqueueDescriptionBackfillMany inserts one description-backfill job
// per {anilistId, bgmId} pair.  Empty slice → noop.  Same InsertMany
// shape and error wrapping as EnqueueV2Many / EnqueueV3Many.
//
// Duplicates are EXPECTED here, unlike on the V2/V3 chains.  The scan
// re-runs on a fixed interval while the previous batch may still be
// draining, so it will hand us rows that are already queued;
// DescriptionBackfillArgs.InsertOpts carries UniqueOpts{ByArgs:true}
// and river's InsertMany resolves those conflicts gracefully (the
// duplicate is skipped, not errored — InsertManyFast is the variant
// that can't, which is why this uses InsertMany).  The debug log
// reports the skipped count so an operator can confirm the dedupe is
// doing its job rather than inferring it from a flat queue depth.
func (e *RealEnqueuer) EnqueueDescriptionBackfillMany(ctx context.Context, jobs []DescriptionBackfillArgs) error {
	if len(jobs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(jobs))
	for i, j := range jobs {
		params[i] = river.InsertManyParams{Args: j}
	}
	res, err := e.client.InsertMany(ctx, params)
	if err != nil {
		return fmt.Errorf("queue.EnqueueDescriptionBackfillMany (n=%d): %w", len(jobs), err)
	}
	skipped := 0
	for _, r := range res {
		if r.UniqueSkippedAsDuplicate {
			skipped++
		}
	}
	slog.DebugContext(ctx, "queue.description_backfill enqueued",
		"n", len(jobs),
		"inserted", len(jobs)-skipped,
		"skippedDuplicate", skipped)
	return nil
}

// EnqueueDescriptionLlmBackfillMany batch-inserts LLM translation jobs.
// Same InsertMany-not-InsertManyFast reasoning as the Bangumi sweep's
// method directly above: ByArgs dedupe conflicts must be skipped, not
// errored.
func (e *RealEnqueuer) EnqueueDescriptionLlmBackfillMany(ctx context.Context, jobs []DescriptionLlmBackfillArgs) error {
	if len(jobs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(jobs))
	for i, j := range jobs {
		params[i] = river.InsertManyParams{Args: j}
	}
	res, err := e.client.InsertMany(ctx, params)
	if err != nil {
		return fmt.Errorf("queue.EnqueueDescriptionLlmBackfillMany (n=%d): %w", len(jobs), err)
	}
	skipped := 0
	for _, r := range res {
		if r.UniqueSkippedAsDuplicate {
			skipped++
		}
	}
	slog.DebugContext(ctx, "queue.description_llm enqueued",
		"n", len(jobs),
		"inserted", len(jobs)-skipped,
		"skippedDuplicate", skipped)
	return nil
}

// EnqueueEpisodesBgmMany batch-inserts episode-count jobs.  Same
// InsertMany-not-InsertManyFast reasoning as the two sweeps above:
// ByArgs dedupe conflicts must be skipped, not errored.  Duplicates are
// expected here for one extra reason — two producers feed this job, so a
// row the hourly scan queued can be handed over again by the next
// seasonal warm before the first copy has drained.
func (e *RealEnqueuer) EnqueueEpisodesBgmMany(ctx context.Context, jobs []EpisodesBgmArgs) error {
	if len(jobs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(jobs))
	for i, j := range jobs {
		params[i] = river.InsertManyParams{Args: j}
	}
	res, err := e.client.InsertMany(ctx, params)
	if err != nil {
		return fmt.Errorf("queue.EnqueueEpisodesBgmMany (n=%d): %w", len(jobs), err)
	}
	skipped := 0
	for _, r := range res {
		if r.UniqueSkippedAsDuplicate {
			skipped++
		}
	}
	slog.DebugContext(ctx, "queue.episodes_bgm enqueued",
		"n", len(jobs),
		"inserted", len(jobs)-skipped,
		"skippedDuplicate", skipped)
	return nil
}

// EnqueueWarmSeasonNow inserts a single WarmSeasonArgs job for
// immediate dispatch.  Used by main.go at boot time (current +
// next season pair) — periodic re-fire is configured separately
// via queue.Config.PeriodicJobs + PeriodicWarmSeasonJob().
func (e *RealEnqueuer) EnqueueWarmSeasonNow(ctx context.Context, args WarmSeasonArgs) error {
	if _, err := e.client.Insert(ctx, args, nil); err != nil {
		return fmt.Errorf("queue.EnqueueWarmSeasonNow (%s %d): %w", args.Season, args.Year, err)
	}
	return nil
}

// EnqueueHantBackfillNow inserts the zh-Hant sweep and reports whether
// river actually took it.
//
// Insert, not InsertMany: there is exactly one job, and Insert is the
// variant that returns the UniqueSkippedAsDuplicate flag the admin
// endpoint needs to tell "scheduled" from "already in flight".
func (e *RealEnqueuer) EnqueueHantBackfillNow(ctx context.Context) (bool, error) {
	res, err := e.client.Insert(ctx, HantBackfillArgs{}, nil)
	if err != nil {
		return false, fmt.Errorf("queue.EnqueueHantBackfillNow: %w", err)
	}
	inserted := !res.UniqueSkippedAsDuplicate
	slog.InfoContext(ctx, "queue.hant_backfill enqueued",
		"inserted", inserted,
		"jobId", res.Job.ID,
		"state", res.Job.State)
	return inserted, nil
}

// NoopEnqueuer satisfies Enqueuer without doing anything.  Use as a
// safe default when callers haven't wired river yet (e.g. server is
// in unit-test mode, or a boot stage runs before river.Start).
type NoopEnqueuer struct{}

// EnqueueV1Many returns nil regardless of input.
func (NoopEnqueuer) EnqueueV1Many(ctx context.Context, anilistIDs []int32) error {
	return nil
}

// EnqueueV2Many returns nil regardless of input.
func (NoopEnqueuer) EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error {
	return nil
}

// EnqueueV3Many returns nil regardless of input.
func (NoopEnqueuer) EnqueueV3Many(ctx context.Context, jobs []BangumiV3Args) error {
	return nil
}

// EnqueueDescriptionBackfillMany returns nil regardless of input.
func (NoopEnqueuer) EnqueueDescriptionBackfillMany(ctx context.Context, jobs []DescriptionBackfillArgs) error {
	return nil
}

// EnqueueDescriptionLlmBackfillMany returns nil regardless of input.
func (NoopEnqueuer) EnqueueDescriptionLlmBackfillMany(ctx context.Context, jobs []DescriptionLlmBackfillArgs) error {
	return nil
}

// EnqueueEpisodesBgmMany returns nil regardless of input.
func (NoopEnqueuer) EnqueueEpisodesBgmMany(ctx context.Context, jobs []EpisodesBgmArgs) error {
	return nil
}

// EnqueueWarmSeasonNow returns nil regardless of input.
func (NoopEnqueuer) EnqueueWarmSeasonNow(ctx context.Context, args WarmSeasonArgs) error {
	return nil
}

// EnqueueHantBackfillNow reports that nothing was inserted, because
// nothing was.  Claiming true here would make an admin endpoint wired to
// a Noop tell an operator a sweep had been scheduled.
func (NoopEnqueuer) EnqueueHantBackfillNow(ctx context.Context) (bool, error) {
	return false, nil
}

// LateBoundEnqueuer is an Enqueuer whose underlying river-backed
// implementation is bound AFTER construction.  Solves the chicken-egg
// between WorkersWithBangumi (needs an Enqueuer at worker-registration
// time so V1 can chain V2) and Boot (creates the *river.Client after
// the workers bundle is built).
//
// Usage in main.go:
//
//	lbe := &queue.LateBoundEnqueuer{}
//	workers := queue.WorkersWithBangumi(bgClient, db, lbe)
//	rc, _ := queue.Boot(pool, queue.Config{Workers: workers})
//	lbe.Bind(rc)  // now V1→V2 chain works
//
// Before Bind is called both EnqueueV1Many and EnqueueV2Many silently
// no-op (same shape as NoopEnqueuer).  After Bind they forward to a
// RealEnqueuer.  Re-Bind is supported but rare in practice.
//
// Concurrency: sync.RWMutex protects the inner pointer.  EnqueueV*Many
// take an RLock so multiple enqueuers can dispatch in parallel; Bind
// takes the write lock (called at most a handful of times at boot).
type LateBoundEnqueuer struct {
	mu    sync.RWMutex
	inner *RealEnqueuer
}

// Bind wires the underlying river client.  Call once after Boot.
func (l *LateBoundEnqueuer) Bind(c *river.Client[pgx.Tx]) {
	l.mu.Lock()
	l.inner = NewEnqueuer(c)
	l.mu.Unlock()
}

// EnqueueV1Many delegates to the bound RealEnqueuer, or no-ops when unbound.
func (l *LateBoundEnqueuer) EnqueueV1Many(ctx context.Context, anilistIDs []int32) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueV1Many(ctx, anilistIDs)
}

// EnqueueV2ManyTx delegates to the bound RealEnqueuer inside the caller's
// transaction, or no-ops when unbound.
//
// Unbound is unreachable for its one caller.  The sweep that uses this runs as
// a river job, and river only dispatches jobs after Start, which main.go calls
// after Bind -- the same ordering the V1 worker's V2 chain already depends on.
// The nil branch is here because the type promises it, not because a bind
// sweep can observe it.
func (l *LateBoundEnqueuer) EnqueueV2ManyTx(ctx context.Context, tx pgx.Tx, jobs []BangumiV2Args) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueV2ManyTx(ctx, tx, jobs)
}

// EnqueueV2Many delegates to the bound RealEnqueuer, or no-ops when unbound.
func (l *LateBoundEnqueuer) EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueV2Many(ctx, jobs)
}

// EnqueueV3Many delegates to the bound RealEnqueuer, or no-ops when unbound.
func (l *LateBoundEnqueuer) EnqueueV3Many(ctx context.Context, jobs []BangumiV3Args) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueV3Many(ctx, jobs)
}

// EnqueueDescriptionBackfillMany delegates to the bound RealEnqueuer,
// or no-ops when unbound.  The description-backfill scan only fires
// from river's periodic scheduler, which cannot run before Bind, so
// the unbound branch is unreachable in production — it exists so unit
// tests can construct a bare LateBoundEnqueuer.
func (l *LateBoundEnqueuer) EnqueueDescriptionBackfillMany(ctx context.Context, jobs []DescriptionBackfillArgs) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueDescriptionBackfillMany(ctx, jobs)
}

// EnqueueDescriptionLlmBackfillMany delegates to the bound RealEnqueuer,
// or no-ops when unbound — same stance as every other method here.
func (l *LateBoundEnqueuer) EnqueueDescriptionLlmBackfillMany(ctx context.Context, jobs []DescriptionLlmBackfillArgs) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueDescriptionLlmBackfillMany(ctx, jobs)
}

// EnqueueEpisodesBgmMany delegates to the bound RealEnqueuer, or no-ops
// when unbound — same stance as every other method here.  The unbound
// branch IS reachable for this one: the warm-season worker calls it, and
// main.go enqueues the boot warm pair immediately after Bind, so a
// pathological ordering would find it unbound.  Losing that seed costs
// nothing — the hourly scan covers the same rows.
func (l *LateBoundEnqueuer) EnqueueEpisodesBgmMany(ctx context.Context, jobs []EpisodesBgmArgs) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueEpisodesBgmMany(ctx, jobs)
}

// EnqueueWarmSeasonNow delegates to the bound RealEnqueuer, or no-ops
// when unbound.  Main.go uses this at boot time to seed the initial
// current + next season warm; binding happens immediately after Boot
// so the unbound window is effectively zero in production.
func (l *LateBoundEnqueuer) EnqueueWarmSeasonNow(ctx context.Context, args WarmSeasonArgs) error {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return nil
	}
	return e.EnqueueWarmSeasonNow(ctx, args)
}

// EnqueueHantBackfillNow delegates to the bound RealEnqueuer, or reports
// "not inserted" when unbound.
//
// Unlike the sweeps above, this one has a caller that can be reached
// before Bind in principle — the admin route is registered on the same
// router — so the unbound branch has to be honest rather than
// convenient: an operator pressing the button against an unbound
// enqueuer is told nothing was scheduled, which is true.
func (l *LateBoundEnqueuer) EnqueueHantBackfillNow(ctx context.Context) (bool, error) {
	l.mu.RLock()
	e := l.inner
	l.mu.RUnlock()
	if e == nil {
		return false, nil
	}
	return e.EnqueueHantBackfillNow(ctx)
}

// Compile-time guards: all implementations must satisfy Enqueuer.
//
// The EpisodesBgmEnqueuer guards are the load-bearing half of the decision to
// keep that method off the Enqueuer interface.  The warm worker reaches it by
// type assertion, which would silently degrade to "no seed" if a production
// implementation ever lost the method — these three lines make that a compile
// error instead.  Only test doubles can miss it, which is the whole point.
var (
	_ Enqueuer = (*RealEnqueuer)(nil)
	_ Enqueuer = NoopEnqueuer{}
	_ Enqueuer = (*LateBoundEnqueuer)(nil)

	_ EpisodesBgmEnqueuer = (*RealEnqueuer)(nil)
	_ EpisodesBgmEnqueuer = NoopEnqueuer{}
	_ EpisodesBgmEnqueuer = (*LateBoundEnqueuer)(nil)
)
