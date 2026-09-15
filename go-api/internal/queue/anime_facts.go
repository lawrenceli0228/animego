// anime_facts.go — the sweep that fills in start_date, end_date, duration
// and source across the catalogue.
//
// # What was wrong
//
// AnimeDetailQuery has selected these four since the port and the
// columns have existed since 0001, but UpsertAnimeCache did not write
// them until migration 0034.  Fixing the upsert fixed the future: a row
// gets its facts the next time something fetches it.  It did nothing
// for the present, because "the next time something fetches it" is a
// detail view past the row's 24h cached_at, and most of the catalogue is
// not viewed in any given day.  Left alone, the facts arrive at the rate
// people visit, and the rows nobody visits never get them.
//
// # Why a sweep and not a warm-all
//
// A warm-all runs AnimeDetailQuery once per row: one request, children
// and all, for a payload of which four scalars are wanted.  MediaFactsQuery
// asks for those four scalars for 50 ids at once, so the same catalogue
// costs a few hundred requests instead of many thousands.  This is the
// ratings sweep's argument (ratings_refresh.go) and this worker is that
// worker with a different document.
//
// # Pacing
//
// Same constants as the AniList ratings pass, for the same reason: what
// the cap protects is not the drain time but the shared rate limiter.
// A pass that holds it for two minutes makes user-facing AniList calls
// wait behind it, and prod has recorded a 500 from exactly that.  Ten
// requests an hour is invisible; the whole catalogue drains in under two
// days; and once it has, a pass finds only the still-airing rows whose
// stamps are allowed to age out.
//
// # Why a pass never returns an error for a row
//
// The rule the ratings and episode-titles sweeps follow: river retries
// a failed job on a backoff measured in days, and for a sweep that
// re-fires hourly the next pass is the retry.  Rows this pass reached
// have committed; only a failure to read the candidate list is
// returned, because a pass that cannot see its work has not started.
package queue

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// factsStaleAfter is how old a still-moving row's stamp must be before
// the row is offered again.  Thirty days: an airing show acquires its
// end date when it finishes, and a month is well inside how long a
// finished show stays interesting.  Finished rows never age out -- see
// ListAnimeFactsCandidates.
const factsStaleAfter = 30 * 24 * time.Hour

// AniListFactsFetcher is the upstream surface the sweep needs.
// *anilist.Client satisfies it.
type AniListFactsFetcher interface {
	Facts(ctx context.Context, v anilist.FactsVars) (*anilist.MediaFactsResponse, error)
}

// AnimeFactsDB is the sqlc subset the sweep uses.
type AnimeFactsDB interface {
	ListAnimeFactsCandidates(ctx context.Context, staleAfter pgtype.Interval, rowLimit int32) ([]int32, error)
	UpdateAnimeFacts(ctx context.Context, arg dbgen.UpdateAnimeFactsParams) (int64, error)
	MarkAnimeFactsChecked(ctx context.Context, anilistID int32) (int64, error)
	DeleteAnimeSynonyms(ctx context.Context, animeID int32) error
	InsertAnimeSynonym(ctx context.Context, animeID int32, synonym string) error
}

// AnimeFactsWorker fills in the four facts in id batches.
type AnimeFactsWorker struct {
	river.WorkerDefaults[AnimeFactsArgs]
	anilist AniListFactsFetcher
	db      AnimeFactsDB
	now     func() time.Time
}

// NewAnimeFactsWorker builds the worker.
func NewAnimeFactsWorker(client AniListFactsFetcher, db AnimeFactsDB) *AnimeFactsWorker {
	return &AnimeFactsWorker{anilist: client, db: db, now: time.Now}
}

// Timeout bounds one pass.  Shares the ratings budget: a full batch is
// ten requests, and the margin is for a 429 retry cycle.
func (w *AnimeFactsWorker) Timeout(*river.Job[AnimeFactsArgs]) time.Duration {
	return anilistRatingsTimeout
}

// Work runs one pass.
func (w *AnimeFactsWorker) Work(ctx context.Context, _ *river.Job[AnimeFactsArgs]) error {
	ctx, cancel := context.WithTimeout(ctx, anilistRatingsTimeout)
	defer cancel()
	start := w.clock()

	staleAfter := pgtype.Interval{Microseconds: int64(factsStaleAfter / time.Microsecond), Valid: true}
	ids, err := w.db.ListAnimeFactsCandidates(ctx, staleAfter, anilistRatingsBatch)
	if err != nil {
		return fmt.Errorf("anime_facts list candidates: %w", err)
	}
	if len(ids) == 0 {
		slog.InfoContext(ctx, "anime_facts nothing due")
		return nil
	}

	var batches, written, absent, failed int
	for chunk := range chunkIDs(ids, anilist.MaxRatingIDs) {
		// A batch that fails upstream is left entirely unstamped: its
		// rows stay candidates at the head of the next pass.
		res, err := w.anilist.Facts(ctx, anilist.FactsVars{IDs: chunk})
		if err != nil {
			failed += len(chunk)
			slog.WarnContext(ctx, "anime_facts batch failed", "ids", len(chunk), "err", err)
			if ctx.Err() != nil {
				break // out of budget: the remaining batches would all fail the same way
			}
			continue
		}
		batches++
		w.applyBatch(ctx, chunk, res.Page.Media, &written, &absent)
	}

	slog.InfoContext(ctx, "anime_facts pass done",
		"candidates", len(ids),
		"batches", batches,
		"rowsWritten", written,
		"rowsAbsentUpstream", absent,
		"rowsFailed", failed,
		"duration", w.clock().Sub(start))
	return nil
}

// applyBatch writes the media AniList returned and stamps the ids it did
// not.  The second half is what keeps a deleted or merged id from
// leading every subsequent batch -- see MarkAnimeFactsChecked.
func (w *AnimeFactsWorker) applyBatch(ctx context.Context, requested []int, media []anilist.Media, written, absent *int) {
	seen := make(map[int]struct{}, len(media))
	for _, m := range media {
		seen[m.ID] = struct{}{}
		if _, err := w.db.UpdateAnimeFacts(ctx, factsParams(m)); err != nil {
			slog.WarnContext(ctx, "anime_facts update failed", "anilistId", m.ID, "err", err)
			continue
		}
		// Synonyms are a whole-set replace, like genres on the detail
		// path.  A failure here is logged and the row still counts as
		// written: the scalars committed, and the next re-read of a
		// moving row -- or the next detail fetch of any row -- replaces
		// the set again.
		if err := w.replaceSynonyms(ctx, int32(m.ID), m.SynonymSet()); err != nil {
			slog.WarnContext(ctx, "anime_facts synonyms failed", "anilistId", m.ID, "err", err)
		}
		*written++
	}
	for _, id := range requested {
		if _, ok := seen[id]; ok {
			continue
		}
		if _, err := w.db.MarkAnimeFactsChecked(ctx, int32(id)); err != nil {
			slog.WarnContext(ctx, "anime_facts stamp failed", "anilistId", id, "err", err)
			continue
		}
		*absent++
	}
}

// clock reads the injected time source, defaulting to time.Now.
func (w *AnimeFactsWorker) clock() time.Time {
	if w.now == nil {
		return time.Now()
	}
	return w.now()
}

// factsParams projects one Media onto the UpdateAnimeFacts statement.
// The rules are NormalizeMainRow's (internal/anime), restated here
// because that package imports this one: whole dates or NULL, both
// halves of next-airing or neither, is_adult false when AniList did not
// say (this document always does).
func factsParams(m anilist.Media) dbgen.UpdateAnimeFactsParams {
	p := dbgen.UpdateAnimeFactsParams{
		StartDate:       dateColumn(m.StartDate),
		EndDate:         dateColumn(m.EndDate),
		Duration:        int32PtrFromInt(m.Duration),
		Source:          m.Source,
		Popularity:      int32PtrFromInt(m.Popularity),
		Favourites:      int32PtrFromInt(m.Favourites),
		MalID:           int32PtrFromInt(m.IDMal),
		IsAdult:         m.IsAdult != nil && *m.IsAdult,
		CountryOfOrigin: m.CountryOfOrigin,
		AnilistID:       int32(m.ID),
	}
	if at, ep, ok := m.NextAiring(); ok {
		p.NextAiringAt = pgtype.Timestamptz{Time: at, Valid: true}
		p.NextAiringEpisode = int32PtrFromInt(&ep)
	}
	return p
}

// replaceSynonyms writes the row's synonym set: delete, then insert each.
func (w *AnimeFactsWorker) replaceSynonyms(ctx context.Context, anilistID int32, synonyms []string) error {
	if err := w.db.DeleteAnimeSynonyms(ctx, anilistID); err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	for _, syn := range synonyms {
		if err := w.db.InsertAnimeSynonym(ctx, anilistID, syn); err != nil {
			return fmt.Errorf("insert %q: %w", syn, err)
		}
	}
	return nil
}

// dateColumn renders a FuzzyDate for a date column: the whole date or
// NULL.  The rule is FuzzyDate.Whole's; this is the same projection the
// detail upsert applies (anime.dateFromFuzzy), kept here rather than
// imported because internal/anime imports this package.
func dateColumn(f *anilist.FuzzyDate) pgtype.Date {
	t, ok := f.Whole()
	if !ok {
		return pgtype.Date{}
	}
	return pgtype.Date{Time: t, Valid: true}
}

// int32PtrFromInt narrows an optional int for the duration column.  A
// duration is minutes per episode; nothing AniList serves approaches
// the int32 range.
func int32PtrFromInt(v *int) *int32 {
	if v == nil {
		return nil
	}
	n := int32(*v)
	return &n
}

// AddFactsWorker registers the sweep on an existing bundle.  Separate
// from the bundle builder for the reason AddRatingsWorkers is: it needs
// the AniList client, which no worker in the bundle holds.
func AddFactsWorker(w *river.Workers, anilistClient AniListFactsFetcher, q *dbgen.Queries) {
	river.AddWorker(w, NewAnimeFactsWorker(anilistClient, q))
}

// Compile-time guard: the worker must satisfy river.Worker for its args.
var _ river.Worker[AnimeFactsArgs] = (*AnimeFactsWorker)(nil)
