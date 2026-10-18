// bgm_rebind_search.go — weekly re-search of airing and upcoming rows that V1
// could not bind to a Bangumi subject.
//
// # The gap this fills
//
// V1 searches Bangumi once per row (bangumi_v1.go).  A row it cannot bind --
// no hit, or a best candidate below the confidence floor -- is parked at
// bangumi_version 2, and every V1 producer selects version 0, so the row is
// never searched again.  For a finished show that is right.  For a show that
// has not aired it is wrong in the commonest case: AniList lists it months
// ahead, it is enriched the day it appears, and Bangumi's subject is created
// or renamed later.  The single search came too early, and the row keeps
// AniList's romaji -- no Chinese title, unreachable by a Chinese search --
// until the vendored id map catches up, which for a new season is months.
//
// Migration 0051 carries the measurement.  The short version: re-running
// V1's own search and scorer over 2025-2027 rows with no binding bound 44 of
// 215 today, Cyberpunk: Edgerunners 2 among them.
//
// This is the fourth patch over the version ratchet TODOS.md tracks, after
// the id-map sweep (bgm_bind_idmap.go), the episode-title sweep and the
// description backfill.  It is scoped to the one population where the
// ratchet's answer is known to go stale on a timescale of weeks.
//
// # What a pass does
//
// Up to rebindSearchBatch candidates (ListBgmRebindCandidates: unbound,
// past V1, RELEASING or NOT_YET_RELEASED, not adult, not hand-corrected, not
// named by the vendored id map, not searched in the last week), each through
// the steps V1 takes:
// search by native-or-romaji title, score with bangumi.PickBest, refuse
// anything short of TierHigh, refuse a subject another row holds.  Then one
// step V1 does not take, below.  A bind and its V2 dispatch commit together.
//
// Every row the pass settles is stamped (bgm_rebind_checked_at), bound or
// not, so it waits out the week.  A row the pass could not settle -- the
// search failed, a read failed, the transaction rolled back -- is left
// unstamped and comes back on the next fire.
//
// # The step V1 does not take: the season gate
//
// bangumi.NormalizeTitle strips season markers before comparing titles, so
// 葬送のフリーレン 第3期 and 葬送のフリーレン 第2期 score as identical, and a
// one-year gap only discounts the year.  While season 3 has no subject of
// its own, season 2's comes back first and V1's rules bind it.  V1 is saved
// in that case only when season 2's row already holds the subject.
//
// A weekly sweep over exactly the shows that are about to air is the place
// that gap would be hit most, so this sweep also requires the row's and the
// subject's season and part markers to agree (titlematch.MarkerFor on each
// side, compared with SameEntry).  legacy_binding.go declines to use the same
// markers because its verdict DELETES data and the extractor misreads some
// forms.  Here a misreading costs a bind, and the row stays as it is -- the
// direction to err in.
//
// # Why a pass never returns an error
//
// Same rule as the id-map sweep on this queue: river retries a failed job
// with attempt⁴ backoff out to ~20 days, while the next scheduled fire is six
// hours away.
//
// # Why the bgm_bind queue
//
// It writes anime_cache.bgm_id, and every writer of that column that runs as
// a sweep shares the one-slot bgm_bind queue so two of them cannot bind the
// same subject to two rows at once (see BgmBindQueueName).  The slot also
// gives the sweep a pause lever that needs no deploy.
package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/titlematch"
)

const (
	// rebindSearchEnabledEnv gates the sweep at WORK time, for the reason
	// bindIdMapEnabledEnv gives: gating registration would let jobs already
	// queued run anyway.  Fails closed, like every flag gating writes here.
	rebindSearchEnabledEnv = "BGM_REBIND_SWEEP_ENABLED"

	// rebindSearchInterval paces the BACKLOG, not the per-row cycle -- the
	// distinction ratingsInterval draws.  The cycle is rebindSearchStaleAfter.
	// Six hours drains a first pass over ~250 candidates in under a day at
	// rebindSearchBatch, and once drained a fire finds the rows whose week
	// is up, roughly a seventh of the population per day.
	rebindSearchInterval = 6 * time.Hour

	// rebindSearchStaleAfter is how long a searched row waits before it is
	// searched again: the weekly cycle the sweep was asked for.  A new
	// season's subjects appear and get named over weeks, not hours.
	rebindSearchStaleAfter = 7 * 24 * time.Hour

	// rebindSearchBatch caps one pass, in rows.  One search per row through
	// the 800ms bucket user-facing /match and the enrichment workers also
	// draw on: 100 rows is under a minute and a half of it, plus one V2 job
	// per bind.  Sized to be absorbed, as bindIdMapBatch is.
	rebindSearchBatch int32 = 100

	// rebindSearchTimeout bounds one pass.  A full batch is ~80s of bucket
	// time; the margin is for upstream latency.  Being cut off is harmless:
	// rows not reached are unstamped and lead the next pass.
	rebindSearchTimeout = 10 * time.Minute
)

// BgmRebindArgs is the river job payload.  The candidate set is entirely a
// function of anime_cache, so the job carries nothing.
type BgmRebindArgs struct{}

// Kind implements river.JobArgs.
func (BgmRebindArgs) Kind() string { return "bgm_rebind_search" }

// InsertOpts pins the job to the binding queue.
func (BgmRebindArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: BgmBindQueueName}
}

// BgmRebindDB is the sqlc subset the sweep reads and stamps through.
// *dbgen.Queries satisfies it.
type BgmRebindDB interface {
	ListBgmRebindCandidates(ctx context.Context, staleAfter pgtype.Interval, lim int32) ([]dbgen.ListBgmRebindCandidatesRow, error)
	MarkBgmRebindChecked(ctx context.Context, anilistID int32) (int64, error)
	CountAnimeBoundToBgmID(ctx context.Context, bgmID int32, excludeAnilistID int32) (int64, error)
}

// rebindBinder writes one bind together with its V2 dispatch.  bound=false
// with a nil error means the statement refused -- the row was bound or
// hand-corrected, or the subject taken, between the read and the write.
type rebindBinder interface {
	BindAndEnqueue(ctx context.Context, anilistID, bgmID int32, titleChinese *string) (bound bool, err error)
}

// BgmRebindWorker runs the sweep.
type BgmRebindWorker struct {
	river.WorkerDefaults[BgmRebindArgs]
	bgm    BangumiSearcher
	db     BgmRebindDB
	binder rebindBinder
}

// NewBgmRebindWorker builds the production worker.  bgm must be the shared
// client so the sweep's searches draw on the one token bucket; enq must be
// able to enqueue inside the bind's transaction.
func NewBgmRebindWorker(pool *pgxpool.Pool, q *dbgen.Queries, bgm BangumiSearcher, enq bindIdMapV2Enqueuer) *BgmRebindWorker {
	return newBgmRebindWorker(bgm, q, txRebindBinder{pool: pool, q: q, enq: enq})
}

// newBgmRebindWorker is the seam the unit tests use.
func newBgmRebindWorker(bgm BangumiSearcher, db BgmRebindDB, binder rebindBinder) *BgmRebindWorker {
	return &BgmRebindWorker{bgm: bgm, db: db, binder: binder}
}

// Timeout bounds one pass.
func (w *BgmRebindWorker) Timeout(*river.Job[BgmRebindArgs]) time.Duration {
	return rebindSearchTimeout
}

// Work runs one pass.  It always returns nil; see the file header.
func (w *BgmRebindWorker) Work(ctx context.Context, _ *river.Job[BgmRebindArgs]) error {
	if !rebindSweepEnabled() {
		slog.DebugContext(ctx, "bgm_rebind_search sweep disabled", "env", rebindSearchEnabledEnv)
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, rebindSearchTimeout)
	defer cancel()
	start := time.Now()

	rows, err := w.db.ListBgmRebindCandidates(ctx, rebindStaleInterval(), rebindSearchBatch)
	if err != nil {
		slog.ErrorContext(ctx, "bgm_rebind_search list candidates failed", "err", err)
		return nil
	}
	if len(rows) == 0 {
		slog.DebugContext(ctx, "bgm_rebind_search nothing due")
		return nil
	}

	tally := map[rebindOutcome]int{}
	for _, row := range rows {
		tally[w.rebindOne(ctx, row)]++
		if ctx.Err() != nil {
			break // out of budget: every remaining search would fail the same way
		}
	}

	slog.InfoContext(ctx, "bgm_rebind_search pass done",
		"candidates", len(rows),
		"bound", tally[rebindOutcomeBound],
		"noHit", tally[rebindOutcomeNoHit],
		"lowConfidence", tally[rebindOutcomeLowConfidence],
		"seasonMismatch", tally[rebindOutcomeSeasonMismatch],
		"taken", tally[rebindOutcomeTaken],
		"refused", tally[rebindOutcomeRefused],
		"failed", tally[rebindOutcomeFailed],
		"duration", time.Since(start))
	return nil
}

// rebindOutcome classifies what one row's pass produced.
type rebindOutcome int

const (
	// rebindOutcomeFailed — transport, database or rollback.  Unstamped.
	rebindOutcomeFailed rebindOutcome = iota
	// rebindOutcomeBound — bound and V2 queued; the bind stamps the row.
	rebindOutcomeBound
	// rebindOutcomeNoHit — no title to search by, or Bangumi had nothing.
	rebindOutcomeNoHit
	// rebindOutcomeLowConfidence — the best candidate fell short of TierHigh.
	rebindOutcomeLowConfidence
	// rebindOutcomeSeasonMismatch — confident, but another season's subject.
	rebindOutcomeSeasonMismatch
	// rebindOutcomeTaken — another row already holds the subject.
	rebindOutcomeTaken
	// rebindOutcomeRefused — the bind statement wrote nothing.
	rebindOutcomeRefused
)

// rebindOne takes one row through search, decision and write.
func (w *BgmRebindWorker) rebindOne(ctx context.Context, row dbgen.ListBgmRebindCandidatesRow) rebindOutcome {
	id := row.AnilistID

	keyword := pickKeyword(row.TitleNative, row.TitleRomaji)
	if keyword == "" {
		return w.stamp(ctx, id, rebindOutcomeNoHit)
	}

	var list []bangumi.SearchResult
	resp, err := w.bgm.Search(ctx, keyword)
	switch {
	case errors.Is(err, bangumi.ErrNotFound):
		// The legacy endpoint answers "no results" with a 404.
	case err != nil:
		slog.WarnContext(ctx, "bgm_rebind_search search failed", "anilistId", id, "keyword", keyword, "err", err)
		return rebindOutcomeFailed
	default:
		list = resp.List
	}

	d := decideRebind(row, list)
	switch d.verdict {
	case rebindNoHit:
		return w.stamp(ctx, id, rebindOutcomeNoHit)
	case rebindLowConfidence:
		return w.stamp(ctx, id, rebindOutcomeLowConfidence)
	case rebindSeasonMismatch:
		slog.InfoContext(ctx, "bgm_rebind_search season mismatch",
			"anilistId", id, "bgmId", d.best.ID, "subject", d.best.Name, "score", d.score)
		return w.stamp(ctx, id, rebindOutcomeSeasonMismatch)
	}

	bgmID := int32(d.best.ID)
	taken, err := w.db.CountAnimeBoundToBgmID(ctx, bgmID, id)
	if err != nil {
		// A failed read must not become a licence to bind, nor a verdict.
		slog.WarnContext(ctx, "bgm_rebind_search collision check failed", "anilistId", id, "bgmId", bgmID, "err", err)
		return rebindOutcomeFailed
	}
	if taken > 0 {
		slog.InfoContext(ctx, "bgm_rebind_search subject taken", "anilistId", id, "bgmId", bgmID, "heldBy", taken)
		return w.stamp(ctx, id, rebindOutcomeTaken)
	}

	bound, err := w.binder.BindAndEnqueue(ctx, id, bgmID, subjectChineseTitle(d.best))
	if err != nil {
		slog.WarnContext(ctx, "bgm_rebind_search bind failed", "anilistId", id, "bgmId", bgmID, "err", err)
		return rebindOutcomeFailed
	}
	if !bound {
		slog.InfoContext(ctx, "bgm_rebind_search bind refused", "anilistId", id, "bgmId", bgmID)
		return w.stamp(ctx, id, rebindOutcomeRefused)
	}
	slog.InfoContext(ctx, "bgm_rebind_search bound",
		"anilistId", id, "bgmId", bgmID, "score", d.score, "hasChinese", subjectChineseTitle(d.best) != nil)
	return rebindOutcomeBound
}

// stamp records a settled search and returns outcome, or rebindOutcomeFailed
// when the stamp cannot be written -- an unstamped row is searched again on
// the next fire, which is the honest consequence of not having recorded it.
func (w *BgmRebindWorker) stamp(ctx context.Context, anilistID int32, outcome rebindOutcome) rebindOutcome {
	if _, err := w.db.MarkBgmRebindChecked(ctx, anilistID); err != nil {
		slog.WarnContext(ctx, "bgm_rebind_search stamp failed", "anilistId", anilistID, "err", err)
		return rebindOutcomeFailed
	}
	return outcome
}

// rebindVerdict is decideRebind's answer.
type rebindVerdict int

const (
	rebindNoHit rebindVerdict = iota
	rebindLowConfidence
	rebindSeasonMismatch
	rebindBind
)

// rebindDecision is a verdict plus the candidate it is about.  best is set
// for rebindBind and rebindSeasonMismatch.
type rebindDecision struct {
	verdict rebindVerdict
	best    *bangumi.SearchResult
	score   float64
}

// decideRebind applies V1's scorer and confidence gate, then the season gate
// described in the file header.  Pure.
func decideRebind(row dbgen.ListBgmRebindCandidatesRow, list []bangumi.SearchResult) rebindDecision {
	if len(list) == 0 {
		return rebindDecision{verdict: rebindNoHit}
	}

	native, romaji, english := strDeref(row.TitleNative), strDeref(row.TitleRomaji), strDeref(row.TitleEnglish)
	best, score, tier := bangumi.PickBest(bangumi.MatchInput{
		TitleNative:  native,
		TitleRomaji:  romaji,
		TitleEnglish: english,
		SeasonYear:   i32Deref(row.SeasonYear),
		Episodes:     i32Deref(row.Episodes),
	}, list)
	if tier != bangumi.TierHigh || best == nil {
		return rebindDecision{verdict: rebindLowConfidence, score: score}
	}

	rowMarker := titlematch.MarkerFor(native, romaji, english)
	subjectMarker := titlematch.MarkerFor(best.Name, best.NameCN)
	if !rowMarker.SameEntry(subjectMarker) {
		return rebindDecision{verdict: rebindSeasonMismatch, best: best, score: score}
	}
	return rebindDecision{verdict: rebindBind, best: best, score: score}
}

// subjectChineseTitle is the Chinese title a search hit carries, or nil when
// it carries none: an empty name_cn, or one that only repeats the native
// name.  Shared with V1, which writes the same column from the same field.
func subjectChineseTitle(r *bangumi.SearchResult) *string {
	if r == nil || r.NameCN == "" || r.NameCN == r.Name {
		return nil
	}
	cn := r.NameCN
	return &cn
}

// txRebindBinder is the production rebindBinder: the bind and the V2 job in
// one transaction, for the reason bindBatch gives -- a bound row with no V2
// queued leaves the candidate set and is never enriched.
type txRebindBinder struct {
	pool *pgxpool.Pool
	q    *dbgen.Queries
	enq  bindIdMapV2Enqueuer
}

// BindAndEnqueue implements rebindBinder.
func (b txRebindBinder) BindAndEnqueue(ctx context.Context, anilistID, bgmID int32, titleChinese *string) (bool, error) {
	tx, err := b.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	n, err := b.q.WithTx(tx).BindBgmIdFromRebindSearch(ctx, bgmID, titleChinese, anilistID)
	if err != nil {
		return false, fmt.Errorf("bind: %w", err)
	}
	if n == 0 {
		return false, nil
	}
	if err := b.enq.EnqueueV2ManyTx(ctx, tx, []BangumiV2Args{{AnilistID: int(anilistID), BgmID: int(bgmID)}}); err != nil {
		return false, fmt.Errorf("enqueue v2: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}

// rebindStaleInterval renders rebindSearchStaleAfter for the candidate query.
func rebindStaleInterval() pgtype.Interval {
	return pgtype.Interval{Microseconds: rebindSearchStaleAfter.Microseconds(), Valid: true}
}

// rebindSweepEnabled reads the kill switch.  Anything unparseable is OFF.
func rebindSweepEnabled() bool {
	v := os.Getenv(rebindSearchEnabledEnv)
	if v == "" {
		return false
	}
	on, err := strconv.ParseBool(v)
	return err == nil && on
}

// AddBgmRebindWorker registers the sweep on an existing bundle.
func AddBgmRebindWorker(w *river.Workers, pool *pgxpool.Pool, q *dbgen.Queries, bgm BangumiSearcher, enq bindIdMapV2Enqueuer) {
	river.AddWorker(w, NewBgmRebindWorker(pool, q, bgm, enq))
}

// Compile-time guards.
var (
	_ river.Worker[BgmRebindArgs] = (*BgmRebindWorker)(nil)
	_ BgmRebindDB                 = (*dbgen.Queries)(nil)
	_ rebindBinder                = txRebindBinder{}
)
