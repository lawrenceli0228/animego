// bangumi_episodes.go — the sweep that infers an episode count for rows
// AniList has none for, and the identity gate that decides whether the row's
// Bangumi binding may be believed at all.
//
// AniList leaves anime_cache.episodes NULL for a large slice of the catalogue:
// most of what is currently airing, plus assorted ONAs and shorts.  Bangumi
// usually knows a total for those titles, and migration 0023 added the columns
// to hold an inferred one — separately from `episodes`, which stays
// authoritative.  This file is what fills them.
//
// # Why not reuse BangumiV2Worker
//
// V2 exists to enrich a row: it rewrites bangumi_score, bangumi_votes and
// title_chinese on every run, hands the subject's summary to
// persistDescriptionCn, and may chain a V3 heal.  The rows this sweep targets
// finished enrichment long ago.  Putting them back through that pipeline to
// collect one integer would re-open every write V2 owns — including the ones
// the description sweep and the dandanplay heal deliberately went and fixed —
// for a gain that does not need any of it.  So this worker reads the episode
// list, writes the count and the episode titles, and touches nothing else.
//
// # The identity gate
//
// A meaningful share of non-NULL bgm_id values carry no recorded match source:
// they were bound before bgm_match_source existed, or by a fuzzy matcher, and
// nothing has re-checked them since.  Some of those bindings are simply wrong,
// and a wrong one is not inert — fetching /subject/{bgm_id}/ep returns the
// WRONG SHOW'S episode titles, in Chinese, and this worker would write them to
// anime_episode_titles, from where they render on a public, indexed page.
//
// So every row is gated before anything is written, in this order:
//
//	(1) bgm_match_source = 'manual', or bgm_id_map lists this exact pair
//	      -> accept.  A human or an independent authority outranks
//	         similarity, and forcing a title comparison here would falsely
//	         reject legitimate aliases and localised renamings.
//	(2) current anime_cache.bgm_id != the id in the job payload
//	      -> discard the run.  The binding changed underneath it.
//	(3) title similarity below the floor           -> rejected
//	(4) season / part markers disagree             -> rejected
//	(5) no comparable title on one side            -> undecided, with a reason
//	(6) otherwise                                  -> accept
//
// Two rules inside that are load-bearing:
//
// NEVER compare against title_chinese.  On a mis-bound row it has ALREADY been
// overwritten with the wrong show's Chinese name by earlier enrichment, so
// comparing it against that same subject's name_cn scores ~1.0 every time.  It
// would validate the error with the error.  GetEpisodesBgmGateInputs does not
// even return the column.
//
// Similarity and season are TWO INDEPENDENT SIGNALS and are asked separately.
// bangumi.NormalizeTitle strips season markers, so consecutive seasons of one
// franchise score around 0.85 against each other and no floor can separate
// them; the marker comparison is a hard gate, not a weight.  See the
// internal/titlematch package doc.
//
// There is deliberately no LLM adjudication layer.  Ambiguity is recorded as
// 'undecided' with a reason and shipped; whether that pile is ever big enough
// to justify building one is a question the recorded outcomes can answer and
// speculation cannot.
//
// # Why the sweep can finish
//
// The predicate this work was specified with —
//
//	episodes IS NULL
//	AND (episodes_bgm IS NULL
//	     OR (status='RELEASING' AND episodes_bgm_at < now() - interval '20 hours'))
//
// — never terminates.  A row the gate rejects, and a row whose episode list
// comes back empty, both produce no count, so `episodes_bgm IS NULL` stays true
// and they hold the front of every later batch forever.  That is the stall
// migration 0015 documents already happening once on this same table, and the
// state columns 0023 added exist to prevent the repeat.  The corrected
// predicate lives in ListEpisodesBgmCandidates and turns on the attempt stamp;
// the cooldowns it takes are the constants below.
package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"golang.org/x/sync/errgroup"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/titlematch"
)

// episodesBgmScanBatchSize is how many candidate rows one scan pass turns into
// jobs.
//
// Each row costs TWO upstream requests — the subject, which the identity gate
// needs for its title, and the episode list, which carries the count.  At the
// shared client's 800ms interval that is ~1.6s per row, so 150 rows is about
// four minutes of the hour before the next pass.  That is the same slice of
// the budget descriptionBackfillScanBatchSize buys with 300 single-request
// rows, and it is chosen the same way: leave the bucket to live enrichment the
// rest of the time.
const episodesBgmScanBatchSize int32 = 150

// episodesBgmScanInterval is how often the sweep re-fires.  One hour, matching
// the other two sweeps; the scan itself is a single indexed SELECT, so the
// cadence is set by how fast we want to spend the shared request budget.  It
// also has to stay well above the ~4 minutes a full batch takes to drain so a
// pass never lands on a queue still working the last one.
const episodesBgmScanInterval = time.Hour

// episodesBgmWorkTimeout bounds one subject fetch, one episode-list fetch and
// the writes that follow.
//
// 30s rather than the 15s the description sweep uses, because this worker
// makes two upstream calls where that one makes a single call — and each can
// sit behind an 800ms throttle wait in front of a request that has been
// observed to take several seconds.  Still tight enough to free the queue's
// only worker slot promptly when upstream is wedged.
const episodesBgmWorkTimeout = 30 * time.Second

// episodesBgmAiringRecheck is how long an airing row that produced a real
// answer sits out before being asked again.
//
// A show that is still RELEASING gains episodes, so any count derived from it
// is provisional by construction and has to be re-read; the only question is
// how often.  20 hours re-reaches such a row about once a day, which is as
// fine-grained as a weekly-broadcast medium can justify, and being UNDER 24
// hours matters: with an hourly sweep, a 24-hour cooldown would drift a little
// later every day and eventually skip a day entirely, while 20 leaves slack
// for the sweep's own phase.
//
// It applies to 'ok' and 'empty' only.  A row the gate REJECTED is not
// provisional just because the show is still airing — the binding is wrong
// whatever week it is — and re-asking daily would spend an upstream request a
// day to re-derive the same refusal.
const episodesBgmAiringRecheck = 20 * time.Hour

// episodesBgmUndecidedRetryDays is how long an undecided row sits out.
//
// 'undecided' means the gate had nothing to decide with — no native title on
// our side, or no name on the subject.  What changes that is data arriving
// from somewhere else: a weekly bgm_id_map refresh, an admin correction, an
// AniList sync filling in a title.  Two weeks is two map refreshes, which is
// prompt enough to pick up a corrected binding within a sprint and slow enough
// that the undecided pile is not re-fetched daily to learn nothing.
const episodesBgmUndecidedRetryDays = 14

// episodesBgmRejectedRetryDays is how long a rejected row sits out.
//
// 'rejected' is a positive finding: the subject names a different work.  What
// makes that stop being true is a RE-BINDING — an admin PATCH, a flag, a
// reset, a map refresh landing a different id — and every one of those paths
// clears the episodes_bgm* columns outright (admin.sql ResetAnimeEnrichment /
// FlagAnimeEnrichment / UpdateAnimeEnrichmentSelective), which returns the row
// to attempted_at IS NULL and the front of the very next sweep.  So this
// cooldown is not the repair mechanism;
// it is the backstop for a re-binding that arrived by some path nobody
// remembered to wire.  90 days makes that backstop nearly free while the
// repair stays immediate.
const episodesBgmRejectedRetryDays = 90

// episodesBgmErrorRetryDays covers a value nothing currently writes.
//
// Transport failures are left UNSTAMPED so river retries them under its own
// policy — a timeout says nothing about the row, and stamping would file a
// transient upstream problem as a decided outcome.  The 'error' outcome is
// still in migration 0023's CHECK, though, so a row could acquire it from some
// future path; without a matching arm in the candidate query such a row would
// match nothing and freeze permanently, which is precisely the failure these
// columns exist to prevent.  One day, so the arm is a speed bump rather than a
// sentence.
const episodesBgmErrorRetryDays = 1

// episodesBgmOutcome is the vocabulary migration 0023's CHECK admits.  Typed
// rather than left as bare strings so a typo is a compile error instead of a
// constraint violation at 3am — the CHECK would reject the write, the stamp
// would fail, and the row would silently re-select forever.
type episodesBgmOutcome string

const (
	// episodesBgmOK — a count was derived and written.
	episodesBgmOK episodesBgmOutcome = "ok"
	// episodesBgmRejected — the identity gate refused the binding.
	episodesBgmRejected episodesBgmOutcome = "rejected"
	// episodesBgmUndecided — the gate could not tell either way.
	episodesBgmUndecided episodesBgmOutcome = "undecided"
	// episodesBgmEmpty — upstream answered, with no main episodes.
	episodesBgmEmpty episodesBgmOutcome = "empty"
)

// episodesBgmCandidateParams builds the cooldown bounds for the candidate
// query.  Constructed per call because pgtype.Interval is a mutable struct and
// a shared package-level value could be scribbled on by a caller.
//
// ids EMPTY means "the whole catalogue"; a non-empty slice narrows the same
// predicate to those rows.  Passing nil would work identically —
// cardinality(NULL) is NULL, not 0 — so the empty slice is materialised rather
// than left nil, and the query says `cardinality(...) = 0` on a value it can
// count.
func episodesBgmCandidateParams(ids []int32, limit int32) dbgen.ListEpisodesBgmCandidatesParams {
	if ids == nil {
		ids = []int32{}
	}
	return dbgen.ListEpisodesBgmCandidatesParams{
		AnilistIds:     ids,
		AiringRecheck:  pgtype.Interval{Microseconds: episodesBgmAiringRecheck.Microseconds(), Valid: true},
		UndecidedRetry: pgtype.Interval{Days: episodesBgmUndecidedRetryDays, Valid: true},
		RejectedRetry:  pgtype.Interval{Days: episodesBgmRejectedRetryDays, Valid: true},
		ErrorRetry:     pgtype.Interval{Days: episodesBgmErrorRetryDays, Valid: true},
		RowLimit:       limit,
	}
}

// EpisodesBgmReader is the candidate query, declared at the use site so a test
// stubs one method rather than owning the full querier surface.
// dbgen.Queries satisfies it.
//
// The rows it returns have NOT passed the identity gate — unlike the
// description sweep, whose trust test is a SQL predicate, this one needs the
// subject's title and therefore an upstream fetch.  Callers must run
// evaluateBinding before writing anything.
type EpisodesBgmReader interface {
	ListEpisodesBgmCandidates(ctx context.Context, arg dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error)
}

// EpisodesBgmEnqueuer is the dispatch surface both producers need: one batched
// insert of per-row jobs.
//
// Narrow on purpose, and deliberately NOT folded into the Enqueuer interface.
// The scan has no business reaching the V1/V2/V3 chain, and widening Enqueuer
// would oblige every test double of it — across three packages, most of which
// have nothing to do with enrichment — to grow a stub for a method they never
// call.  RealEnqueuer, NoopEnqueuer and LateBoundEnqueuer all carry it, with
// compile-time guards in enqueue.go.
type EpisodesBgmEnqueuer interface {
	EnqueueEpisodesBgmMany(ctx context.Context, jobs []EpisodesBgmArgs) error
}

// episodesBgmEnqueuerFrom extracts the episode-count dispatch capability from a
// general Enqueuer, or returns a no-op when the value does not carry it.
//
// The three production implementations all do, and enqueue.go asserts that at
// compile time, so in a running server this never takes the fallback.  What CAN
// take it is a test double of Enqueuer that predates this capability — and the
// right behaviour there is "the seed does nothing", not a nil panic in a worker
// under test for something else.
func episodesBgmEnqueuerFrom(enq Enqueuer) EpisodesBgmEnqueuer {
	if e, ok := enq.(EpisodesBgmEnqueuer); ok && e != nil {
		return e
	}
	return NoopEnqueuer{}
}

// EpisodesBgmWriter is everything the per-row worker touches.
//
// UpsertEpisodeTitle is shared with V2Writer on purpose: the episode titles
// arrive in the same response body as the count, and growing a second
// normalise-then-write path for them would be two implementations of one
// mapping.
type EpisodesBgmWriter interface {
	GetEpisodesBgmGateInputs(ctx context.Context, anilistID int32) (dbgen.GetEpisodesBgmGateInputsRow, error)
	UpdateEpisodesBgm(ctx context.Context, episodesBgm *int32, anilistID int32, bgmID *int32) (int64, error)
	MarkEpisodesBgmAttempted(ctx context.Context, outcome string, reason *string, anilistID int32, bgmID *int32) (int64, error)
	UpsertEpisodeTitle(ctx context.Context, animeID int32, episode int32, nameCN *string, name *string) error
}

// EpisodesBgmSubjectClient is the upstream surface: the subject (for the
// gate's title) and the episode list (for the count).  Both halves are already
// declared as one-method interfaces in bangumi_v2.go, so this composes them
// rather than restating either.
type EpisodesBgmSubjectClient interface {
	BangumiSubjector
	BangumiEpisodesFetcher
}

// ---------------------------------------------------------------------------
// Scan worker
// ---------------------------------------------------------------------------

// EpisodesBgmScanWorker turns candidate rows into per-row jobs.  Embeds
// river.WorkerDefaults so only Work has to be overridden.
type EpisodesBgmScanWorker struct {
	river.WorkerDefaults[EpisodesBgmScanArgs]
	db  EpisodesBgmReader
	enq EpisodesBgmEnqueuer
}

// NewEpisodesBgmScanWorker constructs a scan worker bound to the given reader
// and enqueuer.  Both are required; nil panics on the first job, which is
// intentional and follows NewDescriptionBackfillScanWorker: a sweep that
// silently enqueues nothing looks exactly like a finished one, so
// misconfiguration has to be loud.  River recovers worker panics and retries
// the job, so this is loud rather than fatal.
func NewEpisodesBgmScanWorker(db EpisodesBgmReader, enq EpisodesBgmEnqueuer) *EpisodesBgmScanWorker {
	return &EpisodesBgmScanWorker{db: db, enq: enq}
}

// Work reads one batch of candidates and enqueues a job per row.
//
// No cursor is kept: ordering by the attempt stamp is self-advancing, because
// every decided outcome stamps the row and moves it behind everything not yet
// tried.  That is the whole reason the sweep terminates — see the file header.
//
// A read or enqueue failure is returned so river retries the scan; re-running
// it is harmless, since the query is a pure read and EpisodesBgmArgs
// deduplicates by payload.  Finding nothing is a success: it is what the
// steady state looks like once the backlog is gone.
func (w *EpisodesBgmScanWorker) Work(ctx context.Context, _ *river.Job[EpisodesBgmScanArgs]) error {
	rows, err := w.db.ListEpisodesBgmCandidates(ctx, episodesBgmCandidateParams(nil, episodesBgmScanBatchSize))
	if err != nil {
		return fmt.Errorf("episodes_bgm_scan list (limit=%d): %w", episodesBgmScanBatchSize, err)
	}
	if len(rows) == 0 {
		slog.InfoContext(ctx, "episodes_bgm_scan idle", "candidates", 0)
		return nil
	}

	jobs, skipped := episodesBgmJobsFromRows(rows)
	if len(jobs) == 0 {
		slog.WarnContext(ctx, "episodes_bgm_scan no usable rows",
			"candidates", len(rows),
			"skippedNoBgmId", skipped)
		return nil
	}

	if err := w.enq.EnqueueEpisodesBgmMany(ctx, jobs); err != nil {
		return fmt.Errorf("episodes_bgm_scan enqueue (n=%d): %w", len(jobs), err)
	}

	// "submitted", not "enqueued": UniqueOpts{ByArgs} means a row already
	// queued (or completed within river's 24h retention) is skipped, so this
	// count is what we handed the enqueuer, not what was inserted.  A stalled
	// sweep submits a full batch and inserts none of it, and a line reading
	// "enqueued=150" would make that look healthy.
	slog.InfoContext(ctx, "episodes_bgm_scan done",
		"candidates", len(rows),
		"submitted", len(jobs),
		"skippedNoBgmId", skipped)
	return nil
}

// episodesBgmJobsFromRows maps candidate rows to job payloads, reporting how
// many carried no bgm_id.
//
// The query already filters bgm_id IS NOT NULL, so a nil here would mean the
// query and this loop have drifted apart.  Skip rather than dereference: one
// silently dropped row beats a panic that takes the worker down, and the count
// surfaces the drift in the caller's log line.
//
// Shared by the scan worker and the warm-season seed so both produce identical
// payloads from identical rows.
func episodesBgmJobsFromRows(rows []dbgen.ListEpisodesBgmCandidatesRow) (jobs []EpisodesBgmArgs, skippedNoBgmID int) {
	jobs = make([]EpisodesBgmArgs, 0, len(rows))
	for _, row := range rows {
		if row.BgmID == nil {
			skippedNoBgmID++
			continue
		}
		jobs = append(jobs, EpisodesBgmArgs{
			AnilistID: int(row.AnilistID),
			BgmID:     int(*row.BgmID),
		})
	}
	return jobs, skippedNoBgmID
}

// ---------------------------------------------------------------------------
// Per-row worker
// ---------------------------------------------------------------------------

// EpisodesBgmWorker derives one row's episode count.  Embeds
// river.WorkerDefaults so only Work has to be overridden.
type EpisodesBgmWorker struct {
	river.WorkerDefaults[EpisodesBgmArgs]
	bangumi EpisodesBgmSubjectClient
	db      EpisodesBgmWriter
}

// NewEpisodesBgmWorker constructs a worker bound to the given bangumi client
// and writer.  Both are required; nil panics on the first job, the same
// deliberate loud-failure stance NewDescriptionBackfillWorker takes.
func NewEpisodesBgmWorker(bangumiClient EpisodesBgmSubjectClient, db EpisodesBgmWriter) *EpisodesBgmWorker {
	return &EpisodesBgmWorker{bangumi: bangumiClient, db: db}
}

// Work gates the binding and, if it holds, writes the count and the episode
// titles.
//
// Outcomes:
//   - The current bgm_id differs from the payload — discard without stamping.
//     The binding changed under this job, so neither its fetch nor its verdict
//     describes the row as it now stands, and stamping would file a conclusion
//     about the old binding against the new one.
//   - Subject ErrNotFound — the binding points at a subject Bangumi does not
//     have.  Recorded as 'rejected': it is a decided, negative finding about
//     the binding, and no number of retries changes it.
//   - Either fetch fails otherwise — wrapped and returned so river retries.
//     Deliberately NOT stamped; see episodesBgmErrorRetryDays.
//   - Gate refuses or cannot decide — stamped, nothing written.
//   - No main episodes — stamped 'empty'.  A correct answer that yields
//     nothing, which is why it is distinguishable from the two above.
func (w *EpisodesBgmWorker) Work(ctx context.Context, job *river.Job[EpisodesBgmArgs]) error {
	anilistID := int32(job.Args.AnilistID)
	bgmID := job.Args.BgmID

	// Bound both fetches and the writes together so a wedged upstream cannot
	// hold the queue's only worker slot while the rest of the sweep queues up.
	ctx, cancel := context.WithTimeout(ctx, episodesBgmWorkTimeout)
	defer cancel()

	gate, err := w.db.GetEpisodesBgmGateInputs(ctx, anilistID)
	if err != nil {
		return fmt.Errorf("episodes_bgm gate inputs %d (bgmId=%d): %w", anilistID, bgmID, err)
	}

	// Step 2 of the gate, and the reason the payload is never the authority:
	// the scan wrote this bgmID, an admin PATCH or reset can have landed since,
	// and a job that trusted its own arguments would file one subject's episode
	// list against a different binding.
	if gate.BgmID == nil || int(*gate.BgmID) != bgmID {
		// Logged as a value, not the pointer: slog would otherwise render an
		// address, and this line is the only record that a rebind voided a run.
		current := "null"
		if gate.BgmID != nil {
			current = strconv.Itoa(int(*gate.BgmID))
		}
		slog.InfoContext(ctx, "episodes_bgm binding changed",
			"anilistId", anilistID,
			"jobBgmId", bgmID,
			"currentBgmId", current)
		return nil
	}
	pinnedBgmID := gate.BgmID

	subject, episodes, err := w.fetch(ctx, bgmID)
	if errors.Is(err, bangumi.ErrNotFound) {
		w.stamp(ctx, anilistID, pinnedBgmID, episodesBgmRejected, "subject not found upstream")
		slog.InfoContext(ctx, "episodes_bgm subject not_found",
			"anilistId", anilistID, "bgmId", bgmID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("episodes_bgm fetch %d (bgmId=%d): %w", anilistID, bgmID, err)
	}

	verdict := evaluateBinding(gate, subject.Name)
	if verdict.outcome != episodesBgmOK {
		w.stamp(ctx, anilistID, pinnedBgmID, verdict.outcome, verdict.reason)
		slog.InfoContext(ctx, "episodes_bgm binding not accepted",
			"anilistId", anilistID,
			"bgmId", bgmID,
			"outcome", string(verdict.outcome),
			"reason", verdict.reason)
		return nil
	}

	titles := normalizeEpisodeTitles(episodes.Eps)
	count := episodesBgmCount(titles)
	if count <= 0 {
		w.stamp(ctx, anilistID, pinnedBgmID, episodesBgmEmpty, "no main episodes upstream")
		slog.InfoContext(ctx, "episodes_bgm empty",
			"anilistId", anilistID, "bgmId", bgmID, "entries", len(titles))
		return nil
	}

	// Count first, and only write titles if it landed.  The bgm_id in the
	// UPDATE's WHERE clause is the last line of defence against a re-binding
	// that arrived between the gate read and here; a zero-row result means it
	// did, and the episode titles that would have followed belong to a binding
	// this row no longer holds.
	affected, err := w.db.UpdateEpisodesBgm(ctx, &count, anilistID, pinnedBgmID)
	if err != nil {
		return fmt.Errorf("episodes_bgm update %d (bgmId=%d): %w", anilistID, bgmID, err)
	}
	if affected == 0 {
		slog.WarnContext(ctx, "episodes_bgm write skipped, binding moved",
			"anilistId", anilistID, "bgmId", bgmID)
		return nil
	}

	// Episode titles are best-effort, matching the stance V2 takes on the same
	// write: the count has already committed, and failing the job here would
	// re-spend two upstream requests to retry an optional column.
	written, failures := w.writeTitles(ctx, anilistID, titles)
	if failures > 0 {
		slog.WarnContext(ctx, "episodes_bgm title write failures",
			"anilistId", anilistID, "bgmId", bgmID,
			"failures", failures, "total", len(titles))
	}

	slog.InfoContext(ctx, "episodes_bgm done",
		"anilistId", anilistID,
		"bgmId", bgmID,
		"episodesBgm", count,
		"entries", len(titles),
		"titlesWritten", written)
	return nil
}

// fetch pulls the subject and the episode list in parallel.
//
// Both are needed and neither substitutes for the other: the subject carries
// the name the identity gate compares, the episode list carries the count.
// Fetching them in sequence would double the wall-clock cost of a row for no
// benefit — they share a token bucket, so the throttle serialises the requests
// anyway, but the round-trips overlap.
//
// An episode-list 404 is tolerated and returns an empty list: Bangumi has
// subjects with no episode rows, and that is the 'empty' outcome, not a
// failure.  A subject 404 is returned as ErrNotFound for the caller to record.
func (w *EpisodesBgmWorker) fetch(ctx context.Context, bgmID int) (*bangumi.Subject, *bangumi.EpisodesResponse, error) {
	var (
		subject  *bangumi.Subject
		episodes *bangumi.EpisodesResponse
		subErr   error
		epErr    error
	)

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		s, err := w.bangumi.Subject(gctx, bgmID)
		subject, subErr = s, err
		// Never return the error: that would cancel the peer goroutine on a
		// benign 404, and the joint inspection below is what decides retryable
		// from permanent.  Same shape BangumiV2Worker uses.
		return nil
	})
	g.Go(func() error {
		eps, err := w.bangumi.Episodes(gctx, bgmID)
		episodes, epErr = eps, err
		return nil
	})
	_ = g.Wait()

	if subErr != nil {
		return nil, nil, subErr
	}
	if subject == nil {
		// A client that returns (nil, nil) would otherwise panic in the gate.
		return nil, nil, fmt.Errorf("bangumi returned no subject for bgmId=%d", bgmID)
	}
	if epErr != nil {
		if !errors.Is(epErr, bangumi.ErrNotFound) {
			return nil, nil, epErr
		}
		episodes = &bangumi.EpisodesResponse{}
	}
	if episodes == nil {
		episodes = &bangumi.EpisodesResponse{}
	}
	return subject, episodes, nil
}

// writeTitles upserts the normalised episode titles, returning how many landed
// and how many failed.
func (w *EpisodesBgmWorker) writeTitles(ctx context.Context, anilistID int32, titles []epTitle) (written, failures int) {
	for _, t := range titles {
		if err := w.db.UpsertEpisodeTitle(ctx, anilistID, t.episode, t.nameCN, t.name); err != nil {
			failures++
			continue
		}
		written++
	}
	return written, failures
}

// stamp records a decided non-'ok' outcome so the sweep can move past the row.
//
// Failures are logged rather than returned: the stamp is bookkeeping, and
// failing the job over it would re-spend two upstream requests on a row already
// decided.  A row that misses its stamp is simply picked up again on a later
// pass, which is the safe direction to fail in.
func (w *EpisodesBgmWorker) stamp(ctx context.Context, anilistID int32, bgmID *int32, outcome episodesBgmOutcome, reason string) {
	var reasonArg *string
	if reason != "" {
		reasonArg = &reason
	}
	affected, err := w.db.MarkEpisodesBgmAttempted(ctx, string(outcome), reasonArg, anilistID, bgmID)
	if err != nil {
		slog.WarnContext(ctx, "episodes_bgm attempt stamp failed",
			"anilistId", anilistID,
			"outcome", string(outcome),
			"err", err)
		return
	}
	if affected == 0 {
		// The bgm_id pin matched nothing, i.e. the binding moved between the
		// gate read and here.  Not an error — the verdict was about a binding
		// this row no longer holds, and refusing to stamp it is correct.
		slog.InfoContext(ctx, "episodes_bgm stamp skipped, binding moved",
			"anilistId", anilistID,
			"outcome", string(outcome))
	}
}

// ---------------------------------------------------------------------------
// The identity gate
// ---------------------------------------------------------------------------

// bindingVerdict is the gate's answer.  outcome == episodesBgmOK means accept;
// reason is free text for the columns and the log, and is empty on accept via
// an authoritative source because there is nothing to explain.
type bindingVerdict struct {
	outcome episodesBgmOutcome
	reason  string
}

// evaluateBinding decides whether a row's Bangumi binding may be believed,
// given the subject name that binding actually resolved to.
//
// Pure: no I/O, no clock, no database.  Everything it needs is in the two
// arguments, which is what makes the production mis-binding usable verbatim as
// a test fixture.
//
// The order of the checks is the order in the file header, and it is not
// arbitrary:
//
//   - Authoritative bindings are checked FIRST and skip the comparison
//     entirely.  A human override and an independent id map both outrank
//     similarity, and running a title comparison over them would falsely
//     reject legitimate aliases — a localised title, a rename between
//     broadcast and release — that the authority already resolved.
//   - The comparison uses title_native and title_romaji, NEVER title_chinese.
//     See the file header; GetEpisodesBgmGateInputs does not return it.
//   - Similarity and season are asked as two separate questions, because
//     NormalizeTitle strips season markers and consecutive seasons therefore
//     score around 0.85 against each other.  Marker.SameEntry, not ==, so an
//     unstated season reads as season 1.
//
// The grey-zone arm is worth stating outright.  When we hold no native title,
// the only comparison available is romaji against whatever script the subject
// is named in, and a legitimate binding routinely scores near zero there.
// Positive evidence still accepts — a romaji match that also agrees on season
// is a match — but the ABSENCE of it is not evidence of a wrong binding, so it
// records 'undecided' rather than 'rejected'.
func evaluateBinding(gate dbgen.GetEpisodesBgmGateInputsRow, subjectName string) bindingVerdict {
	// 1. Authoritative bindings outrank similarity.
	if gate.BgmMatchSource != nil && *gate.BgmMatchSource == "manual" {
		return bindingVerdict{outcome: episodesBgmOK}
	}
	if gate.IDMapAgrees {
		return bindingVerdict{outcome: episodesBgmOK}
	}

	// A bgm_id_map entry naming a DIFFERENT bgm_id lands here rather than in
	// the branch above, which is the correct reading: it is evidence against
	// the binding, so it must not read as confirmation of it.  It is not
	// promoted to an immediate rejection either, because the title comparison
	// below answers the same question with the same data and one rule is
	// easier to reason about than two that can disagree.

	name := strings.TrimSpace(subjectName)
	if name == "" {
		return bindingVerdict{
			outcome: episodesBgmUndecided,
			reason:  "subject has no name to compare",
		}
	}

	native := trimPtr(gate.TitleNative)
	romaji := trimPtr(gate.TitleRomaji)
	if native == "" && romaji == "" {
		return bindingVerdict{
			outcome: episodesBgmUndecided,
			reason:  "no anilist title to compare",
		}
	}

	sim := titlematch.BestSimilarity(name, native, romaji)
	sameEntry := titlematch.MarkerFor(native, romaji).SameEntry(titlematch.ExtractMarker(name))

	if sim >= titlematch.SimilarityFloor && sameEntry {
		return bindingVerdict{outcome: episodesBgmOK}
	}

	// Grey zone: romaji was the only thing to compare, and it disagreeing with
	// a subject named in another script proves nothing.
	if native == "" {
		return bindingVerdict{
			outcome: episodesBgmUndecided,
			reason:  fmt.Sprintf("no native title; romaji comparison inconclusive (similarity %.2f)", sim),
		}
	}

	if sim < titlematch.SimilarityFloor {
		return bindingVerdict{
			outcome: episodesBgmRejected,
			reason: fmt.Sprintf("title similarity %.2f below floor %.2f",
				sim, titlematch.SimilarityFloor),
		}
	}
	return bindingVerdict{
		outcome: episodesBgmRejected,
		reason:  "season or part markers disagree",
	}
}

// trimPtr reads a nullable text column as a trimmed string, with NULL and
// whitespace-only both reading as absent.  The gate has to treat "" and NULL
// identically — a column holding a stray space is not a title.
func trimPtr(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

// ---------------------------------------------------------------------------
// Count derivation
// ---------------------------------------------------------------------------

// episodesBgmCount is the HIGHEST normalised episode number in a list, not the
// number of entries in it.
//
// The two differ in both directions and neither is rare:
//
//   - Bangumi episode lists have gaps.  A subject listing sorts 1,2,3,7 yields
//     four entries whose largest number is 7, and a grid sized by len() would
//     stop at 4 and cut off the tail — the exact failure this value is read
//     downstream to prevent.
//   - Sort is a float and normalizeEpisodeTitles rounds it, so 40.5 and 41 can
//     both land on the same episode number.  That is five entries for four
//     distinct episodes; the (anime_id, episode) primary key then dedupes the
//     rows, and len() would over-count.
//
// Taking the maximum is right in both cases.  The entry count is still worth
// carrying — the caller logs it — because a large gap between the two is the
// signal that a subject's numbering is unusual.
//
// Deliberately computed by scanning rather than by reading the last element:
// normalizeEpisodeTitles does sort ascending and rounding is monotonic, so the
// last element IS the maximum today, but that is an invariant of another
// function which nothing enforces.
func episodesBgmCount(titles []epTitle) int32 {
	var maxEpisode int32
	for _, t := range titles {
		if t.episode > maxEpisode {
			maxEpisode = t.episode
		}
	}
	return maxEpisode
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// PeriodicEpisodesBgmScanJob returns the river PeriodicJob that fires the sweep
// every hour.  Pass it to queue.Config.PeriodicJobs.
//
// InsertOpts is nil in the tuple: EpisodesBgmScanArgs.InsertOpts() already pins
// the job to EpisodesBgmQueueName, and that is all it needs.
//
// Do NOT add UniqueOpts here without setting ByState explicitly.  River's
// default unique states include `completed`, and completed jobs stay in
// river_job for 24h, so a naive UniqueOpts would block the hourly cadence for a
// full day after every successful scan.  A stacked scan is tolerable by
// comparison: it is one indexed SELECT whose rows are then deduplicated by
// UniqueOpts{ByArgs} on the per-row jobs.
//
// RunOnStart is TRUE.  River's OSS scheduler does not persist periodic
// schedules — it recomputes the next run as now+period on every Start — so with
// RunOnStart=false a deploy would push the next sweep a full hour out, and a
// day with several deploys could produce no sweep at all.  That is the failure
// mode PeriodicDescriptionBackfillScanJob's comment records; the cost of
// avoiding it is one extra batch per boot, which UniqueOpts{ByArgs} on
// EpisodesBgmArgs collapses against anything still queued.
func PeriodicEpisodesBgmScanJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(episodesBgmScanInterval),
		func() (river.JobArgs, *river.InsertOpts) {
			return EpisodesBgmScanArgs{}, nil
		},
		&river.PeriodicJobOpts{RunOnStart: true},
	)
}

// EpisodesBgmDB is the union of the two DB surfaces the pair of workers needs.
// dbgen.Queries satisfies it.
type EpisodesBgmDB interface {
	EpisodesBgmReader
	EpisodesBgmWriter
}

// AddEpisodesBgmWorkers registers both workers on an existing bundle.
//
// Separate from WorkersWithBangumi — the same shape AddDescriptionLlmWorkers
// and AddHantBackfillWorker use — so that function's signature, its call sites
// and its test doubles stay untouched for a sweep that shares none of V12DB's
// read surface.
//
// bangumiClient MUST be the same *bangumi.Client every other worker holds.  Its
// rate limiter is an in-process token bucket, so sharing the instance is what
// keeps this sweep's two-requests-per-row inside the same bgm.tv budget as live
// enrichment; a second client would silently double the real rate.
func AddEpisodesBgmWorkers(w *river.Workers, bangumiClient EpisodesBgmSubjectClient, db EpisodesBgmDB, enq EpisodesBgmEnqueuer) {
	river.AddWorker(w, NewEpisodesBgmScanWorker(db, enq))
	river.AddWorker(w, NewEpisodesBgmWorker(bangumiClient, db))
}

// Compile-time guards: both workers must satisfy river.Worker for their args.
var (
	_ river.Worker[EpisodesBgmScanArgs] = (*EpisodesBgmScanWorker)(nil)
	_ river.Worker[EpisodesBgmArgs]     = (*EpisodesBgmWorker)(nil)
)
