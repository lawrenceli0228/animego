// ratings_refresh.go — the two sweeps that keep score figures current.
//
// # What was wrong
//
// anime_cache learns a rating once, when a row is first enriched, and
// never again.  Nothing in the system re-reads one: the four AniList
// paths that write average_score are all request-driven, and Bangumi's
// score and vote count are written by the tail of V2, which runs once
// per row for good.
//
// Measured on prod 2026-09-07, the shape that produces is unmistakable.
// Across 2026's four seasons, mean Bangumi votes per row:
//
//	SUMMER 2026 (airing now)      8      max    257
//	SPRING 2026                 262      max  8,855
//	WINTER 2026               1,270      max 18,720
//
// The currently-airing season is not less popular than the one before
// it.  Every row in it was read at announcement and has been frozen
// since, and the only thing those three numbers measure is how long ago
// each season's rows happened to be enriched.
//
// # The cadence
//
// Rows from the current year and later are re-read on a cycle; the back
// catalogue is read once and then left alone.  ListAnilistRatingCandidates
// carries the argument for the split and for the >= .  What matters here
// is that both halves are the same query and the same worker — the only
// difference between "refresh quarterly" and "collect once" is whether
// the row's stamp is allowed to age out, so turning the back catalogue
// into a slower cycle later is a WHERE clause, not a second sweep.
//
// # Why two workers and not one
//
// See BangumiRatingsArgs.  The short version is that a pass costs 370
// AniList requests or 13,233 Bangumi ones, and those cannot share a
// timeout, a batch cap, or a failure.
//
// # Why a pass never returns an error for a row
//
// Same rule the episode-titles sweep follows: river retries a failed job
// with a backoff measured in days, which for a sweep that re-fires every
// hour is strictly worse than letting the next pass pick the row up.
// Rows this pass reached have already committed.  Only a failure to read
// the candidate list at all is returned, because a pass that cannot see
// its work list has not started.
package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ratingsInterval is how often each sweep fires.
//
// Hourly, which is far shorter than the 90-day freshness window, and
// deliberately so: the interval paces the BACKLOG, not the refresh.  A
// pass takes only the rows that are due, so once the back catalogue is
// collected an hourly wake-up finds a handful of rows or none.  Until
// then it is what turns an 18,458-row backfill into something that
// drains on its own in a day or two instead of a single job that has to
// survive for hours.
const ratingsInterval = time.Hour

// ratingsStaleAfter is how old a row's read stamp must be before that
// row is offered again.  90 days — the quarterly cadence this feature
// was asked for, expressed as the only thing that actually enforces it.
//
// It applies only to the current-year-and-later population; the back
// catalogue's stamp never ages out.  See ListAnilistRatingCandidates.
const ratingsStaleAfter = 90 * 24 * time.Hour

// anilistRatingsBatch caps one AniList pass, in rows.
//
// The number this cap is set against is NOT "how fast can the backfill
// finish".  It is "how long may one pass hold the shared rate limiter",
// because that window is when user-facing AniList calls get slower and
// some of them stop fitting in their budget.
//
// 2,000 rows was the first value here, chosen when minInterval was 700ms
// -- 40 requests, ~28s.  At the real interval (2.1s, see
// anilist.rateLimitPerMinute) the same 2,000 rows held the limiter for
// 130 seconds, and prod recorded what that costs: /api/anime/schedule
// answered 500 after 19.568s, twenty seconds into a pass.  That endpoint
// paginates, so it is not one request waiting one interval -- it is N
// requests each queued behind one of this sweep's, which turns its 20s
// budget into roughly N * 4.2s and puts five pages over the line.
//
// 500 rows is 10 requests, ~33 seconds -- under 1% of the hour rather
// than 3.6%.  The cost is wall-clock on a ONE-TIME drain: the 18,458-row
// catalogue takes ~37 hours instead of ~10.  Steady state is unaffected,
// because once the back catalogue is collected a pass finds only the
// current-year population, which is 458 rows.
//
// So: raising this to make the backfill finish sooner trades a user-
// facing 500 for wall-clock on a job that runs once.  The contention is
// the constraint; the drain time is not.  TODOS.md carries the fix that
// would remove the trade -- giving background work its own share of the
// budget instead of the same FIFO queue the request path uses.
const anilistRatingsBatch int32 = 500

// bangumiRatingsBatch caps one Bangumi pass, in rows.
//
// Two orders of magnitude below the AniList cap, because the cost is two
// orders of magnitude higher: one request per row through the 800ms
// bucket that user-facing /match and danmaku lookups also draw on.  300
// rows is four minutes of that bucket per hour — roughly 7% of it — and
// drains the 13,233 bound rows in about two days.
const bangumiRatingsBatch int32 = 300

// anilistRatingsTimeout bounds one AniList pass.  A full batch is ~28s
// of upstream time; the margin covers a 429 retry cycle (up to three
// waits of Retry-After) without the pass being cut off in the middle of
// a batch it has already paid for.
const anilistRatingsTimeout = 10 * time.Minute

// bangumiRatingsTimeout bounds one Bangumi pass.  A full batch is ~4
// minutes; the margin is for upstream latency, not for more rows.  Being
// cut off is harmless — every row not reached is still a candidate on
// the next pass, and every row reached has committed.
const bangumiRatingsTimeout = 15 * time.Minute

// ---------------------------------------------------------------------------
// Shared surfaces
// ---------------------------------------------------------------------------

// AniListRatingsFetcher is the upstream surface the AniList sweep needs.
// *anilist.Client satisfies it.  Declared at the use site so tests can
// supply a stub without standing up the HTTP client.
type AniListRatingsFetcher interface {
	Ratings(ctx context.Context, v anilist.RatingsVars) (*anilist.MediaRatingsResponse, error)
}

// AnilistRatingsDB is the sqlc subset the AniList sweep uses.
type AnilistRatingsDB interface {
	ListAnilistRatingCandidates(ctx context.Context, currentYear int32, staleAfter pgtype.Interval, rowLimit int32) ([]int32, error)
	UpdateAnilistRating(ctx context.Context, averageScore *float64, scoreVotes *int32, anilistID int32) (int64, error)
	MarkAnilistRatingChecked(ctx context.Context, anilistID int32) (int64, error)
}

// BangumiRatingsFetcher is the upstream surface the Bangumi sweep needs.
// *bangumi.Client satisfies it.
type BangumiRatingsFetcher interface {
	Subject(ctx context.Context, bgmID int) (*bangumi.Subject, error)
}

// BangumiRatingsDB is the sqlc subset the Bangumi sweep uses.
type BangumiRatingsDB interface {
	ListBangumiRatingCandidates(ctx context.Context, currentYear int32, staleAfter pgtype.Interval, rowLimit int32) ([]dbgen.ListBangumiRatingCandidatesRow, error)
	UpdateBangumiRating(ctx context.Context, bangumiScore *float64, bangumiVotes *int32, anilistID int32, bgmID int32) (int64, error)
	MarkBangumiRatingChecked(ctx context.Context, anilistID int32, bgmID int32) (int64, error)
}

// ratingsStaleInterval renders ratingsStaleAfter as the pgtype.Interval
// both candidate queries take.  One helper rather than the expression
// twice, so the two sweeps cannot drift to different windows.
func ratingsStaleInterval() pgtype.Interval {
	return pgtype.Interval{Microseconds: int64(ratingsStaleAfter / time.Microsecond), Valid: true}
}

// ratingsCurrentYear is the year the candidate queries treat as "still
// moving".  Taken from the clock at pass time rather than pinned at boot
// so a long-lived process rolls over on 1 January by itself.
//
// now is a parameter so tests can pin it; production passes time.Now().
func ratingsCurrentYear(now time.Time) int32 { return int32(now.Year()) }

// ---------------------------------------------------------------------------
// AniList sweep
// ---------------------------------------------------------------------------

// AnilistRatingsWorker re-reads AniList score + rater count in id batches.
type AnilistRatingsWorker struct {
	river.WorkerDefaults[AnilistRatingsArgs]
	anilist AniListRatingsFetcher
	db      AnilistRatingsDB
	now     func() time.Time
}

// NewAnilistRatingsWorker builds the worker.  A nil clock is replaced
// with time.Now.
func NewAnilistRatingsWorker(client AniListRatingsFetcher, db AnilistRatingsDB) *AnilistRatingsWorker {
	return &AnilistRatingsWorker{anilist: client, db: db, now: time.Now}
}

// Timeout bounds one pass.
func (w *AnilistRatingsWorker) Timeout(*river.Job[AnilistRatingsArgs]) time.Duration {
	return anilistRatingsTimeout
}

// Work runs one AniList pass.
func (w *AnilistRatingsWorker) Work(ctx context.Context, _ *river.Job[AnilistRatingsArgs]) error {
	ctx, cancel := context.WithTimeout(ctx, anilistRatingsTimeout)
	defer cancel()
	start := w.clock()

	ids, err := w.db.ListAnilistRatingCandidates(
		ctx, ratingsCurrentYear(w.clock()), ratingsStaleInterval(), anilistRatingsBatch)
	if err != nil {
		return fmt.Errorf("anilist_ratings list candidates: %w", err)
	}
	if len(ids) == 0 {
		slog.InfoContext(ctx, "anilist_ratings nothing due")
		return nil
	}

	var batches, written, absent, failed int
	for chunk := range chunkIDs(ids, anilist.MaxRatingIDs) {
		// A batch that fails upstream is left entirely unstamped.  Its
		// rows are still candidates, still at the head of the next
		// pass's ordering, and an hour is a shorter wait than river's
		// backoff would be — so the pass moves on rather than returning.
		res, err := w.anilist.Ratings(ctx, anilist.RatingsVars{IDs: chunk})
		if err != nil {
			failed += len(chunk)
			slog.WarnContext(ctx, "anilist_ratings batch failed", "ids", len(chunk), "err", err)
			if ctx.Err() != nil {
				break // out of budget: the remaining batches would all fail the same way
			}
			continue
		}
		batches++
		w.applyBatch(ctx, chunk, res.Page.Media, &written, &absent)
	}

	slog.InfoContext(ctx, "anilist_ratings pass done",
		"candidates", len(ids),
		"batches", batches,
		"rowsWritten", written,
		"rowsAbsentUpstream", absent,
		"rowsFailed", failed,
		"duration", w.clock().Sub(start))
	return nil
}

// applyBatch writes the media AniList returned and stamps the ids it did
// not.  The second half is the load-bearing one — see
// MarkAnilistRatingChecked for what an unstamped absent id does to every
// subsequent pass.
func (w *AnilistRatingsWorker) applyBatch(ctx context.Context, requested []int, media []anilist.Media, written, absent *int) {
	seen := make(map[int]struct{}, len(media))
	for _, m := range media {
		seen[m.ID] = struct{}{}
		votes := m.ScoreVotes()
		if votes == nil {
			// Unreachable through MediaRatingsQuery, which selects
			// stats.  Reaching it means the document changed without
			// this call site changing, and writing NULL would trip the
			// column's CHECK from inside a swallowed error — so refuse
			// here, where it can be seen, and leave the row a candidate.
			slog.WarnContext(ctx, "anilist_ratings media carried no stats", "anilistId", m.ID)
			continue
		}
		if _, err := w.db.UpdateAnilistRating(ctx, scoreToFloat(m.AverageScore), int32Ptr(*votes), int32(m.ID)); err != nil {
			slog.WarnContext(ctx, "anilist_ratings update failed", "anilistId", m.ID, "err", err)
			continue
		}
		*written++
	}
	for _, id := range requested {
		if _, ok := seen[id]; ok {
			continue
		}
		if _, err := w.db.MarkAnilistRatingChecked(ctx, int32(id)); err != nil {
			slog.WarnContext(ctx, "anilist_ratings stamp failed", "anilistId", id, "err", err)
			continue
		}
		*absent++
	}
}

// clock reads the injected time source, defaulting to time.Now.
func (w *AnilistRatingsWorker) clock() time.Time {
	if w.now == nil {
		return time.Now()
	}
	return w.now()
}

// ---------------------------------------------------------------------------
// Bangumi sweep
// ---------------------------------------------------------------------------

// BangumiRatingsWorker re-reads Bangumi score + vote count, one subject
// request per row.
type BangumiRatingsWorker struct {
	river.WorkerDefaults[BangumiRatingsArgs]
	bgm BangumiRatingsFetcher
	db  BangumiRatingsDB
	now func() time.Time
}

// NewBangumiRatingsWorker builds the worker.
//
// The client is passed in rather than constructed here so the sweep
// draws from the SAME 800ms token bucket as user-facing /match and the
// enrichment workers.  A second client would open a second bucket and
// double the real rate against one caller identity — the argument
// AddEpisodeTitlesWorker makes, for the same bucket.
func NewBangumiRatingsWorker(client BangumiRatingsFetcher, db BangumiRatingsDB) *BangumiRatingsWorker {
	return &BangumiRatingsWorker{bgm: client, db: db, now: time.Now}
}

// Timeout bounds one pass.
func (w *BangumiRatingsWorker) Timeout(*river.Job[BangumiRatingsArgs]) time.Duration {
	return bangumiRatingsTimeout
}

// Work runs one Bangumi pass.
func (w *BangumiRatingsWorker) Work(ctx context.Context, _ *river.Job[BangumiRatingsArgs]) error {
	ctx, cancel := context.WithTimeout(ctx, bangumiRatingsTimeout)
	defer cancel()
	start := w.clock()

	rows, err := w.db.ListBangumiRatingCandidates(
		ctx, ratingsCurrentYear(w.clock()), ratingsStaleInterval(), bangumiRatingsBatch)
	if err != nil {
		return fmt.Errorf("bangumi_ratings list candidates: %w", err)
	}
	if len(rows) == 0 {
		slog.InfoContext(ctx, "bangumi_ratings nothing due")
		return nil
	}

	var written, unreadable, failed int
	for _, row := range rows {
		if row.BgmID == nil {
			continue // the query's predicate guarantees this
		}
		switch w.refreshOne(ctx, row.AnilistID, *row.BgmID) {
		case ratingWritten:
			written++
		case ratingUnreadable:
			unreadable++
		default:
			failed++
		}
		if ctx.Err() != nil {
			break
		}
	}

	slog.InfoContext(ctx, "bangumi_ratings pass done",
		"candidates", len(rows),
		"rowsWritten", written,
		"rowsUnreadable", unreadable,
		"rowsFailed", failed,
		"duration", w.clock().Sub(start))
	return nil
}

// ratingOutcome classifies what one row's refresh produced.
type ratingOutcome int

const (
	// ratingWritten — the subject answered and its figures are stored.
	ratingWritten ratingOutcome = iota
	// ratingUnreadable — Bangumi will not serve us this subject.  The
	// row is stamped so it stops leading every pass; see
	// MarkBangumiRatingChecked for why that is not the same as V2's
	// bangumi_subject_unreadable_at.
	ratingUnreadable
	// ratingFailed — transport or database.  Nothing is stamped, so the
	// row is a candidate again on the next pass.
	ratingFailed
)

// refreshOne reads one subject and writes its rating figures.
func (w *BangumiRatingsWorker) refreshOne(ctx context.Context, anilistID, bgmID int32) ratingOutcome {
	subject, err := w.bgm.Subject(ctx, int(bgmID))
	switch {
	case errors.Is(err, bangumi.ErrNotFound):
		if _, err := w.db.MarkBangumiRatingChecked(ctx, anilistID, bgmID); err != nil {
			slog.WarnContext(ctx, "bangumi_ratings stamp failed", "anilistId", anilistID, "err", err)
			return ratingFailed
		}
		return ratingUnreadable
	case err != nil:
		slog.WarnContext(ctx, "bangumi_ratings subject failed", "anilistId", anilistID, "bgmId", bgmID, "err", err)
		return ratingFailed
	}

	// A subject with no rating block leaves both figures alone — the
	// UPDATE's COALESCE turns the nils into "keep what is stored" — while
	// still stamping the read.  That is the right pair: we did ask, and
	// the answer contained nothing to write.
	var score *float64
	var votes *int32
	if subject != nil && subject.Rating != nil {
		s := subject.Rating.Score
		score = &s
		votes = int32Ptr(subject.Rating.Count)
	}
	rows, err := w.db.UpdateBangumiRating(ctx, score, votes, anilistID, bgmID)
	if err != nil {
		slog.WarnContext(ctx, "bangumi_ratings update failed", "anilistId", anilistID, "err", err)
		return ratingFailed
	}
	if rows == 0 {
		// The row was re-bound to a different subject between the scan
		// and this write, so the WHERE found nothing.  Not a failure and
		// not a write: leaving it unstamped is correct, because the next
		// pass will ask about the subject it now holds.
		slog.InfoContext(ctx, "bangumi_ratings binding moved", "anilistId", anilistID, "bgmId", bgmID)
		return ratingFailed
	}
	return ratingWritten
}

// clock reads the injected time source, defaulting to time.Now.
func (w *BangumiRatingsWorker) clock() time.Time {
	if w.now == nil {
		return time.Now()
	}
	return w.now()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// chunkIDs splits ids into slices of at most size, yielding each in
// order.  A range-over-func rather than a returned [][]int so the
// batches are not materialised: the caller consumes one at a time and
// the largest allocation is a single batch.
func chunkIDs(ids []int32, size int) func(func([]int) bool) {
	return func(yield func([]int) bool) {
		for start := 0; start < len(ids); start += size {
			end := start + size
			if end > len(ids) {
				end = len(ids)
			}
			batch := make([]int, 0, end-start)
			for _, id := range ids[start:end] {
				batch = append(batch, int(id))
			}
			if !yield(batch) {
				return
			}
		}
	}
}

// scoreToFloat converts AniList's 0-100 integer score to the *float64
// the numeric(4,2) column takes, preserving nil.
//
// Nil is meaningful here and is why this is not an inline cast: the
// UPDATE COALESCEs it, so "AniList reports no score" leaves the stored
// score intact rather than erasing it catalogue-wide.  See
// UpdateAnilistRating for the asymmetry with the request-driven paths.
func scoreToFloat(score *int) *float64 {
	if score == nil {
		return nil
	}
	f := float64(*score)
	return &f
}

// int32Ptr narrows an int to the *int32 sqlc generated for an integer
// column.  Counts are non-negative and far below 2^31 — AniList's most
// scored work is under two million raters — so the narrowing cannot
// overflow in any shape either upstream produces.
func int32Ptr(v int) *int32 {
	n := int32(v)
	return &n
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// AddRatingsWorkers registers both sweeps on an existing bundle.
//
// Separate from the bundle builder for the reason AddEpisodeTitlesWorker
// is: these need the AniList client, which no other worker in the bundle
// holds, and the Bangumi client is passed through rather than
// constructed so both sweeps share the one token bucket.
func AddRatingsWorkers(w *river.Workers, anilistClient AniListRatingsFetcher, bgmClient BangumiRatingsFetcher, q *dbgen.Queries) {
	river.AddWorker(w, NewAnilistRatingsWorker(anilistClient, q))
	river.AddWorker(w, NewBangumiRatingsWorker(bgmClient, q))
}

// Compile-time guards: each worker must satisfy river.Worker for its args.
var (
	_ river.Worker[AnilistRatingsArgs] = (*AnilistRatingsWorker)(nil)
	_ river.Worker[BangumiRatingsArgs] = (*BangumiRatingsWorker)(nil)
)
