// episode_titles_releasing.go — the periodic top-up for shows still airing.
//
// # Why only airing shows
//
// A finished show's episode titles are settled: filling them is a backlog, and
// a backlog is drained once, by `bgmbackfill --heal-episode-titles`, where a
// human can read the classification before anything is written.  What a
// one-shot pass structurally cannot finish is a show mid-broadcast — episode
// 9's name appears upstream in the week episode 9 airs — so that slice, and
// only that slice, needs a timer behind it.
//
// Restricting the candidate set to status='RELEASING' is also what lets this
// sweep run on a single timestamp with no outcome bookkeeping.  Migrations
// 0015 and 0023 both had to add attempt/outcome columns because their sweeps
// scanned the whole catalogue and decided candidacy on "the value is still
// missing", so a row that could never produce a value held the front of every
// batch forever.  Neither ingredient is present here: candidacy is the attempt
// stamp, which is written whether or not the pass produced anything, and the
// candidate set shrinks on its own as AniList sync flips shows to FINISHED.
// 0029's section C records the argument and the guard on it.
//
// # Why the freshness window is longer than the interval
//
// The dandanplay client caches an episode response for 24h.  Re-asking sooner
// than that returns the cached body, writes nothing new, and stamps the row as
// attempted — a pass that consumes a slot and cannot make progress.  So the
// candidate query's window (26h) is deliberately longer than the cache TTL,
// and the fire interval (6h) is shorter than the window: the sweep wakes often
// enough to spread its work and to pick up rows whose stamp has just aged out,
// while no individual row is asked about more than once a day.
//
// # Two ways to stop it
//
// EPISODE_TITLES_SWEEP_ENABLED is read at WORK time, not at registration time.
// Gating registration alone would leave any job already enqueued to run
// anyway, so the flag would not describe the running system.  Reading it here
// means a restart with the flag off silences the sweep completely, including
// anything river had queued.
//
// The flag still needs a restart to change, so the sweep also gets its own
// queue.  That makes river's runtime pause apply to it alone — the same
// mechanism the admin surface already uses to freeze heal-CN without touching
// enrichment — and a queue pause needs no deploy.  The env flag is the switch
// you set before a release; the queue pause is the one you reach for at 3am.
package queue

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/episodetitles"
)

// episodeTitlesInterval is how often the sweep fires.  Shorter than the
// per-row freshness window on purpose: it spreads a day's work over four
// wake-ups instead of one and picks up rows as their stamps age out, without
// any row being asked about more than once a day.
const episodeTitlesInterval = 6 * time.Hour

// episodeTitlesStaleAfter is how old a row's attempt stamp must be before it
// is offered again.  MUST stay above the dandanplay client's 24h episode cache
// TTL; below it the sweep re-reads its own cached response and burns a pass.
const episodeTitlesStaleAfter = 26 * time.Hour

// episodeTitlesBatch caps one pass.  The airing slice of the catalogue is
// small — tens of rows, not thousands — so this is a ceiling against an
// unexpected status flood rather than a throttle in normal operation.
const episodeTitlesBatch int32 = 200

// episodeTitlesWorkTimeout bounds the whole pass.  One row costs one upstream
// request through the shared 800ms bucket, so a full batch is a few minutes;
// the timeout is set well above that because being cut off mid-batch is
// harmless — every row this pass did not reach is still a candidate on the
// next one.
const episodeTitlesWorkTimeout = 10 * time.Minute

// episodeTitlesEnabledEnv gates the sweep.  Absent or falsey means the worker
// returns immediately; see the file comment for why this is read per job
// rather than at registration.
const episodeTitlesEnabledEnv = "EPISODE_TITLES_SWEEP_ENABLED"

// EpisodeTitlesReader is the read surface the sweep needs.
type EpisodeTitlesReader interface {
	ListReleasingEpisodeTitleCandidates(ctx context.Context, staleAfter pgtype.Interval, rowLimit int32) ([]dbgen.ListReleasingEpisodeTitleCandidatesRow, error)
	LookupBgmIdMap(ctx context.Context, anilistID int32) (int32, error)
}

// EpisodeTitlesClient is the upstream surface the sweep needs.
type EpisodeTitlesClient interface {
	FetchEpisodesByBgmID(ctx context.Context, bgmID int32) (*dandanplay.EpisodeData, error)
}

// EpisodeTitlesWorker re-asks dandanplay about airing shows.
//
// It holds the pool and the concrete *dbgen.Queries because the write is a
// four-statement transaction shared with the CLI (internal/episodetitles), and
// that sequence is the thing that must not be reimplemented per caller.  The
// consequence is that this worker is exercised by the integration suite rather
// than by an in-memory double, which is the right trade for a job whose entire
// behaviour is database state.
type EpisodeTitlesWorker struct {
	river.WorkerDefaults[EpisodeTitlesArgs]
	pool   *pgxpool.Pool
	q      *dbgen.Queries
	db     EpisodeTitlesReader
	client EpisodeTitlesClient
}

// NewEpisodeTitlesWorker builds the worker.
func NewEpisodeTitlesWorker(pool *pgxpool.Pool, q *dbgen.Queries, client EpisodeTitlesClient) *EpisodeTitlesWorker {
	return &EpisodeTitlesWorker{pool: pool, q: q, db: q, client: client}
}

// Timeout bounds one pass.
func (w *EpisodeTitlesWorker) Timeout(*river.Job[EpisodeTitlesArgs]) time.Duration {
	return episodeTitlesWorkTimeout
}

// Work runs one pass over the airing slice.
//
// Per-row failures are logged and counted, never returned.  A pass that
// returns an error is retried by river with an exponential backoff measured in
// days, which for a sweep that re-fires every six hours is strictly worse than
// simply letting the next pass pick the row up — and the rows this one did
// reach have already committed.
func (w *EpisodeTitlesWorker) Work(ctx context.Context, _ *river.Job[EpisodeTitlesArgs]) error {
	if !episodeTitlesSweepEnabled() {
		slog.InfoContext(ctx, "episode_titles sweep disabled", "env", episodeTitlesEnabledEnv)
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, episodeTitlesWorkTimeout)
	defer cancel()
	start := time.Now()

	rows, err := w.db.ListReleasingEpisodeTitleCandidates(
		ctx,
		pgtype.Interval{Microseconds: int64(episodeTitlesStaleAfter / time.Microsecond), Valid: true},
		episodeTitlesBatch,
	)
	if err != nil {
		return fmt.Errorf("episode_titles list candidates: %w", err)
	}
	if len(rows) == 0 {
		slog.InfoContext(ctx, "episode_titles nothing due")
		return nil
	}

	var accepted, written, retracted, rejected, empty, failed int
	for _, row := range rows {
		if row.BgmID == nil {
			continue // the query's predicate guarantees this
		}
		res := w.sweepOne(ctx, row.AnilistID, *row.BgmID)
		switch res.class {
		case sweepWritten:
			accepted++
			written += res.written
			retracted += res.retracted
		case sweepRejected:
			rejected++
		case sweepEmpty:
			empty++
		default:
			failed++
		}
	}

	slog.InfoContext(ctx, "episode_titles pass done",
		"candidates", len(rows),
		"accepted", accepted,
		"titlesWritten", written,
		"rowsRetracted", retracted,
		"rejected", rejected,
		"empty", empty,
		"failed", failed,
		"duration", time.Since(start))
	return nil
}

type sweepClass int

const (
	sweepWritten sweepClass = iota
	sweepRejected
	sweepEmpty
	sweepFailed
)

type sweepResult struct {
	class     sweepClass
	written   int
	retracted int
}

// sweepOne handles a single anime, applying the same identity rule the CLI
// uses: bgm_id_map decides wherever it has an entry, and dandanplay's
// cross-link is consulted only where the map is silent.  Keeping the two in
// step matters because they write the same rows through the same source label;
// if they disagreed about which bindings are trustworthy, each pass would
// partially undo the other's judgement.
func (w *EpisodeTitlesWorker) sweepOne(ctx context.Context, anilistID, bgmID int32) sweepResult {
	mapBgm, mapErr := w.db.LookupBgmIdMap(ctx, anilistID)
	mapSpeaks := mapErr == nil
	if mapErr != nil && mapErr != pgx.ErrNoRows {
		slog.WarnContext(ctx, "episode_titles id-map lookup failed",
			"anilistId", anilistID, "err", mapErr)
		return sweepResult{class: sweepFailed}
	}
	if mapSpeaks && mapBgm != bgmID {
		// The authoritative map contradicts the stored binding.  Nothing is
		// written and no upstream request is spent; re-binding is the admin
		// surface's job, not this sweep's.
		return sweepResult{class: sweepRejected}
	}

	data, err := w.client.FetchEpisodesByBgmID(ctx, bgmID)
	if err != nil {
		slog.WarnContext(ctx, "episode_titles fetch failed",
			"anilistId", anilistID, "bgmId", bgmID, "err", err)
		return sweepResult{class: sweepFailed}
	}
	if data == nil {
		return sweepResult{class: sweepEmpty}
	}
	if !mapSpeaks && data.AniListID != anilistID {
		// Includes AniListID == 0, i.e. dandanplay published no cross-link:
		// nothing vouches for this binding, so nothing is written.  Absence of
		// evidence, kept distinct from evidence of absence.
		return sweepResult{class: sweepRejected}
	}

	titles := episodetitles.Usable(data.Episodes)
	if len(titles) == 0 {
		return sweepResult{class: sweepEmpty}
	}

	written, retracted, err := episodetitles.Apply(ctx, w.pool, w.q, anilistID, bgmID, titles)
	if err != nil {
		slog.WarnContext(ctx, "episode_titles apply failed",
			"anilistId", anilistID, "bgmId", bgmID, "err", err)
		return sweepResult{class: sweepFailed}
	}
	return sweepResult{class: sweepWritten, written: written, retracted: retracted}
}

// episodeTitlesSweepEnabled reads the kill switch.
//
// Accepts the shapes an operator actually types.  Anything unparseable is
// treated as OFF: a typo in a variable that gates writes against production
// should fail closed.
func episodeTitlesSweepEnabled() bool {
	v := os.Getenv(episodeTitlesEnabledEnv)
	if v == "" {
		return false
	}
	on, err := strconv.ParseBool(v)
	return err == nil && on
}

// PeriodicEpisodeTitlesJob returns the river PeriodicJob for the sweep.
//
// RunOnStart is true, and the attempt stamp is what makes that safe.  river's
// open-source pilot does not persist periodic schedules — nextRunAt is
// recomputed at every Start — so a service that deploys more often than the
// interval would otherwise never sweep at all (the failure
// PeriodicHantBackfillJob records for its quarterly timer).  Firing on boot
// removes that dependency, and a redeploy ten minutes later costs nothing:
// every row the previous pass touched carries a stamp inside the 26h window
// and is no longer a candidate.
func PeriodicEpisodeTitlesJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(episodeTitlesInterval),
		func() (river.JobArgs, *river.InsertOpts) {
			return EpisodeTitlesArgs{}, nil
		},
		&river.PeriodicJobOpts{RunOnStart: true},
	)
}

// AddEpisodeTitlesWorker registers the sweep on an existing bundle.
//
// Separate from the bundle builder for the same reason AddHantBackfillWorker
// and AddEpisodesBgmWorkers are: it needs the dandanplay client, which no
// other worker holds, and none of V12DB, which every other worker does.
//
// The client is passed in rather than constructed here so the sweep draws from
// the SAME 800ms token bucket as user-facing /match and danmaku lookups.  A
// second client would open a second bucket and double the real rate against
// one AppId — the same argument the comment above WorkersWithBangumiAndNormalizer
// makes for sharing the Bangumi client.
func AddEpisodeTitlesWorker(w *river.Workers, pool *pgxpool.Pool, q *dbgen.Queries, client EpisodeTitlesClient) {
	river.AddWorker(w, NewEpisodeTitlesWorker(pool, q, client))
}

// Compile-time guard: the worker must satisfy river.Worker for its args.
var _ river.Worker[EpisodeTitlesArgs] = (*EpisodeTitlesWorker)(nil)
