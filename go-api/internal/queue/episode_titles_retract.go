// episode_titles_retract.go — the withdrawal half of the Bangumi episode-title
// write, and the guard that decides how much of it may happen unattended.
//
// # What was missing
//
// An upsert states what a source now holds and says nothing about what it used
// to hold.  internal/episodetitles.Apply has closed that gap on the dandanplay
// side since it was written: upsert, then ClearEpisodeTitlesBySourceOutside to
// withdraw this source's rows the fetch no longer covers, then
// DeleteEmptyEpisodeTitles for the rows the withdrawal emptied.  The Bangumi
// writer (episode_titles_write.go) only ever upserted.  So a Bangumi list that
// shrank left its old tail sitting under the fresh rows, invisible to the
// writer and indistinguishable, in the table, from titles we had confirmed.
//
// That tail is not hypothetical.  On 2026-09-05 production held 21,001 rows
// across 960 anime past their own season's episode count, 13,426 of them from
// the Bangumi side; removing them took a hand-written DELETE because no writer
// could reach them.  #156 stopped new ones being made.  This file is what
// stops the next batch needing a human.
//
// # Why the withdrawal cannot simply be copied over from the dandanplay side
//
// Apply's rule is "everything this source owns and the fetch did not re-state
// is withdrawn".  That is sound for a writer whose fetch is either whole or
// obviously absent.  The Bangumi list is neither.  Measured 2026-09-06 over
// the 90,241 Bangumi-sourced rows on 6,041 anime: 1,219 anime already hold
// FEWER rows than their season's episode count, 466 do not start at episode 1,
// and 282 have holes in the middle.  Sparse is the normal shape of this data,
// not a symptom.  A fetch that comes back with six episodes of twelve is
// therefore not evidence that the other six stopped existing — it is the same
// answer a healthy sparse subject gives, and cardinality(kept) > 0, the guard
// the query already carries, cannot see the difference because both are
// non-empty.
//
// # The guard is the window, not a threshold
//
// The tempting guard is a count: refuse when the new set is materially smaller
// than what we hold.  It is the wrong instrument twice over.  It would refuse
// exactly the repair this file exists to perform — a four-episode ONA bound to
// a 3,528-episode subject shrinks by 99% and that shrink is the fix — and a
// cardinality comparison is an idiom this codebase does not otherwise use:
// every existing guard compares a RANK (source label, bangumi_version) or a
// SET (GREATEST over a union), never a count.
//
// So the question a row is asked is not "how many" but "could this episode
// belong to this entry at all":
//
//	outside the kept-set AND above the season's episode count
//	    → cannot be this entry's whatever upstream is doing today, because
//	      the grid renders 1..episodes and the writer will not produce it
//	      again.  Withdrawn.
//	outside the kept-set and INSIDE the window
//	    → this is precisely the row a partial fetch erases.  Added back to
//	      the kept-set, so the retraction passes over it, and counted so the
//	      pass can say how often it happened.
//	window unknown (anime_cache.episodes IS NULL)
//	    → no question can be asked, so none is answered: every held row is
//	      shielded and the withdrawal degenerates to a no-op.  This is the
//	      whole population the episodes_bgm worker writes, which is why that
//	      writer is deliberately not wired to this file.
//
// The shape is borrowed from MarkEpisodesBgmAttempted (anime_cache.sql), which
// clears a stored count only for the outcome that positively repudiates it and
// leaves it alone for the three that are merely absence of evidence.  A short
// list is absence of evidence.  The cost of being wrong in the conservative
// direction is one stale title on an episode the entry does not have; the cost
// in the other direction is deleting rows nobody can tell were ever there.
//
// # Why its own transaction
//
// The Bangumi title write is best-effort by contract: both callers reach it
// after their authoritative write has committed, and failing the job there
// would re-spend the upstream requests that produced it.  Adopting Apply's
// all-or-nothing transaction would change that — a failure at the withdrawal
// would roll the upserts back too.  So the withdrawal is its own transaction,
// after the upserts, and a failure costs the withdrawal only.  The pairing of
// clear and delete does need to be atomic: a clear without its delete leaves
// rows holding two NULLs and no source, which no later retraction can reach,
// because the WHERE that finds them matches on the source it just erased.
// That is how the 2,369 orphan rows the 2026-09-05 audit found were made.
package queue

import (
	"context"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// retractionPlan is the decision taken before any row is touched.
//
// protected is what ClearEpisodeTitlesBySourceOutside is handed as its
// kept-set: the episodes upstream re-stated, plus the ones the guard is
// unwilling to withdraw on this evidence.  Passing the shielded rows through
// the kept-set rather than filtering the retraction afterwards is deliberate —
// the query withdraws everything outside the set it is given, so the only way
// to spare a row is to name it, and naming it keeps the decision in one place
// instead of splitting it between a plan and a second predicate.
type retractionPlan struct {
	protected []int32
	withdraw  int
	shielded  int
}

// planRetraction sorts the rows this source holds into the three answers above.
//
// kept is the episode set upstream listed for this entry after windowing;
// window is the catalogue episode count, 0 when AniList has none.
//
// Worth being exact about what decides the outcome, because the shape invites
// the wrong reading: WHAT IS WITHDRAWN IS DECIDED BY THE WINDOW ALONE.  The
// normaliser windows its list to the season before this function sees it, so
// kept can never contain an episode above the window, so a held row above the
// window is never in kept, so it is withdrawn whether or not this particular
// fetch mentioned it -- and a held row below the window is shielded on the
// same terms.  A mutation that fed the raw kept-set to the retraction instead
// of the protected one survived the first round of tests for exactly this
// reason: on an anime with no tail, the plan returns before the statement runs.
//
// That independence is a feature, not an accident to be tidied away.  It means
// a degraded fetch cannot widen the withdrawal, only narrow it to nothing.
// kept's own composition -- including the episodes upstream listed but has not
// named, which the writer skips because the row would be two NULLs -- is
// therefore a statement of what "this source holds" means rather than a lever
// on today's outcome.  It becomes a lever the moment the guard is loosened to
// allow any withdrawal inside the window, which is why it is stated here and
// pinned by a test rather than left to be re-derived then.
func planRetraction(kept, held []int32, window int32) retractionPlan {
	if len(kept) == 0 {
		return retractionPlan{}
	}

	keptSet := make(map[int32]struct{}, len(kept))
	for _, e := range kept {
		keptSet[e] = struct{}{}
	}

	protected := make([]int32, 0, len(kept)+len(held))
	for e := range keptSet {
		protected = append(protected, e)
	}

	plan := retractionPlan{}
	seen := make(map[int32]struct{}, len(held))
	for _, e := range held {
		if _, ok := keptSet[e]; ok {
			continue
		}
		// The held set comes back ordered and PK-unique, but a duplicate
		// would double-count both the shield and the withdrawal, and the
		// counts are what the pass reports.
		if _, ok := seen[e]; ok {
			continue
		}
		seen[e] = struct{}{}

		if window > 0 && e > window {
			plan.withdraw++
			continue
		}
		plan.shielded++
		protected = append(protected, e)
	}

	sort.Slice(protected, func(i, j int) bool { return protected[i] < protected[j] })
	plan.protected = protected
	return plan
}

// episodeTitleRetractor is the write surface the withdrawal needs.
//
// Concrete rather than an interface on purpose: the pair of statements has to
// run inside one transaction, and WithTx is a method on *dbgen.Queries, not
// something a hand-written double can supply.  The worker that calls this
// already holds both the pool and the generated queries for the same reason —
// see EpisodeTitlesWorker, which was built that way so the sweep is exercised
// by the integration suite rather than by an in-memory double.
type episodeTitleRetractor struct {
	pool *pgxpool.Pool
	q    *dbgen.Queries
}

// retractEpisodeTitles withdraws the Bangumi rows this entry can no longer
// hold, and reports how many it refused to withdraw on the evidence available.
//
// A zero-length kept-set returns immediately: it means the fetch produced
// nothing usable, which is the one case where withdrawing everything would be
// catastrophic and is already the reason the query carries its own cardinality
// guard.  Reaching the query at all in that state would be relying on this
// caller's convention, and a convention is the wrong place for the difference
// between "nothing changed" and "everything erased".
func (r episodeTitleRetractor) retract(
	ctx context.Context,
	anilistID int32,
	kept []int32,
	window int32,
) (withdrawn, shielded int, err error) {
	if len(kept) == 0 {
		return 0, 0, nil
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("episode titles retract: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := r.q.WithTx(tx)

	// Read the held set inside the transaction the withdrawal runs in, so the
	// set the plan was made from is the set the UPDATE sees.
	held, err := qtx.ListEpisodeTitleEpisodesBySource(ctx, anilistID, episodeTitleSourceBangumi)
	if err != nil {
		return 0, 0, fmt.Errorf("episode titles retract: read held: %w", err)
	}

	plan := planRetraction(kept, held, window)
	if plan.withdraw == 0 {
		// Nothing provably stale.  Returning before the UPDATE keeps the
		// no-op case free of write locks on a table the detail page reads.
		return 0, plan.shielded, nil
	}

	cleared, err := qtx.ClearEpisodeTitlesBySourceOutside(
		ctx, episodeTitleSourceBangumi, anilistID, plan.protected)
	if err != nil {
		return 0, 0, fmt.Errorf("episode titles retract: clear: %w", err)
	}
	if len(cleared) > 0 {
		if _, err := qtx.DeleteEmptyEpisodeTitles(ctx, anilistID, cleared); err != nil {
			return 0, 0, fmt.Errorf("episode titles retract: delete emptied: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, fmt.Errorf("episode titles retract: commit: %w", err)
	}
	return len(cleared), plan.shielded, nil
}

// keptEpisodes is the episode set to hand the withdrawal after a write.
//
// Derived from the normalised list rather than from what the upsert actually
// landed: writeEpisodeTitles skips episodes with no title in either language,
// and an episode upstream lists without a name yet is still an episode
// upstream lists.  The sweep runs on airing shows, where that is the ordinary
// state of the next two or three episodes.
//
// Under today's guard the distinction changes no row -- an unnamed episode is
// inside the window and would be shielded anyway (see planRetraction).  It is
// kept honest because the alternative is a definition of "held" that is wrong
// on its own terms and happens to be harmless.
func keptEpisodes(titles []epTitle) []int32 {
	out := make([]int32, 0, len(titles))
	for _, t := range titles {
		out = append(out, t.episode)
	}
	return out
}
