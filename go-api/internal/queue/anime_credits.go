// anime_credits.go — the sweep that completes a title's characters and
// staff beyond AniList's first page.
//
// # What was wrong
//
// The detail document fetches one page of each list -- 25, AniList's
// ceiling on a nested connection page -- and that page was all a title
// ever held.  For anything with a real cast that is a fraction of it, and
// the voice actors of every character past the 25th were simply absent.
// The detail refresh now keeps rows beyond the first page instead of
// replacing the table (credits.WriteCast), and records whether AniList has
// a second page (cast_has_more / staff_has_more).  This sweep is the
// writer those two changes make room for: it fetches the rest.
//
// # What one title costs
//
// One request carries up to eight pages of one list, aliased p1..p8 on a
// single Media (anilist.CharacterPagesQuery).  If page 8 still has a next
// page, a second request fetches pages 9..16.  That is the hard cap: 400
// characters or 400 staff entries a title, two requests at most per list.
// Most titles past the first page fit in the first request.
//
// # Pacing, and why it is the design rather than a tuning detail
//
// AniList grants this process about 30 requests a minute, one token
// bucket for everything -- and the caller that must not lose is a cold
// detail request (a user or a crawler asking for a title we have never
// cached), which has nothing to fall back on and five seconds to answer.
// A background pass that queued on the limiter would put itself in front
// of those requests; that is how the facts and ratings sweeps learned to
// cap themselves.  This sweep goes further and never queues at all:
//
//   - every request is no-wait (anilist.Client.CharacterPagesNoWait): it
//     takes a token only if one is idle right now, else ErrBudgetBusy;
//   - requests are spaced creditsRequestGap apart, so a pass never takes
//     two tokens in a row and a request waiting on the limiter always has
//     a refill between the sweep's;
//   - a busy budget is retried a few times, a gap apart, and then the pass
//     ends -- someone else needs the budget more, and the titles left are
//     the head of the next pass;
//   - a 429 or an open breaker ends the pass at once.
//
// A pass is at most creditsTitlesPerPass titles, every creditsInterval.
// In requests that is roughly 6-8 a pass and 70-100 an hour -- about 5% of
// the budget, taken only from tokens nobody was waiting for.
//
// Expected drain, from the shape of the catalogue when this was written: a
// few thousand titles have more characters than one page and several
// thousand more have more staff.  At three cast titles a pass (staff gets
// the rest of the six, and all six once cast candidates run out) the cast
// backlog clears in about two and a half days and staff in four to five,
// most popular first.  After that a pass finds only titles whose 30-day
// stamp has lapsed and titles whose has_more has just turned true.
//
// # Why a pass never returns an error for a title
//
// The rule the other sweeps follow: river retries a failed job on a
// backoff measured in minutes to days, and for a sweep that re-fires every
// five minutes the next pass is the retry.  A title is either written and
// stamped (one transaction), stamped as absent, stamped back-dated after a
// failure (creditsRetryAfterFailure) or after its second request found no
// budget (creditsDeferAfterBusy), or left alone for the next pass.  Only a
// failure to read a candidate list is returned.
package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/credits"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

const (
	// creditsInterval is how often a pass fires.  Short, because a pass is
	// small: the backlog is drained by frequency, not by batch size, so no
	// single pass holds the ratings queue's one slot for long.
	creditsInterval = 5 * time.Minute

	// creditsTimeout bounds one pass.  A normal pass is under a minute;
	// the bound covers a pass that spends its busy retries, and is below
	// creditsInterval so passes cannot overlap even if uniqueness let them.
	creditsTimeout = 4 * time.Minute

	// creditsTitlesPerPass is how many titles one pass looks at, cast and
	// staff together.  creditsCastPerPass of them go to characters first;
	// staff takes what cast leaves, so once the cast backlog is done the
	// whole pass works on staff.
	creditsTitlesPerPass = 6
	creditsCastPerPass   = 3

	// creditsRequestGap is the pause before every request a pass makes,
	// including a retry after ErrBudgetBusy.  About three refill intervals
	// of the AniList limiter (anilist.minInterval is 2.1s): the sweep can
	// never take two tokens in a row, and a pass of eight requests spreads
	// over most of a minute.
	creditsRequestGap = 6 * time.Second

	// creditsBusyRetries is how many more times one request is tried after
	// ErrBudgetBusy before the pass gives up and ends.
	creditsBusyRetries = 3

	// creditsStaleAfter is how long a swept title stays swept.  AniList's
	// casts keep growing after a show ends -- dub casts arrive, editors add
	// side characters -- so a finished title is re-read too, monthly.
	creditsStaleAfter = 30 * 24 * time.Hour

	// creditsRetryAfterFailure is when a title whose fetch or write failed
	// comes round again.  Not at once: a title that fails every time (a
	// document AniList refuses for that title alone) would otherwise head
	// every pass and starve the rest.  Not in creditsStaleAfter either:
	// most failures are transient.  The stamp is back-dated by the
	// difference, so the candidate query needs no second column.
	creditsRetryAfterFailure = 24 * time.Hour

	// creditsMaxPages is the hard cap: two requests of eight pages, 400
	// rows of each list.
	creditsMaxPages = 2 * anilist.MaxCreditPagesPerRequest

	// creditsDeferAfterBusy is how long a title steps back when its first
	// request went through and its second could not get a token.  A busy
	// budget says nothing about a title, so it is normally not stamped at
	// all -- but this title has already cost a request, would cost it again
	// at the head of every pass for as long as the budget stays that
	// contended, and would hold up every title behind it while it did.
	creditsDeferAfterBusy = time.Hour
)

// AniListCreditsFetcher is the upstream surface the sweep needs; both
// methods are no-wait.  *anilist.Client satisfies it.
type AniListCreditsFetcher interface {
	CharacterPagesNoWait(ctx context.Context, v anilist.CreditPagesVars) (*anilist.CharacterPages, error)
	StaffPagesNoWait(ctx context.Context, v anilist.CreditPagesVars) (*anilist.StaffPages, error)
}

// AnimeCreditsStore is the database surface: the candidate lists, the
// stamps for titles not written, and a write-and-stamp that is one
// transaction.  pgCreditsStore is the production implementation.
type AnimeCreditsStore interface {
	ListAnimeCastCandidates(ctx context.Context, staleAfter pgtype.Interval, fullPage int32, rowLimit int32) ([]int32, error)
	ListAnimeStaffCandidates(ctx context.Context, staleAfter pgtype.Interval, fullPage int32, rowLimit int32) ([]int32, error)
	StampAnimeCastChecked(ctx context.Context, checkedAt pgtype.Timestamptz, hasMore *bool, anilistID int32) error
	StampAnimeStaffChecked(ctx context.Context, checkedAt pgtype.Timestamptz, hasMore *bool, anilistID int32) error
	ReplaceCast(ctx context.Context, animeID int32, cast credits.Cast, hasMore bool, checkedAt time.Time) error
	ReplaceStaff(ctx context.Context, animeID int32, staff []credits.Staff, hasMore bool, checkedAt time.Time) error
}

// AnimeCreditsWorker runs the sweep.
type AnimeCreditsWorker struct {
	river.WorkerDefaults[AnimeCreditsArgs]
	anilist AniListCreditsFetcher
	store   AnimeCreditsStore
	now     func() time.Time
	// sleep is the pause between requests; tests replace it.
	sleep func(context.Context, time.Duration) error
}

// NewAnimeCreditsWorker builds the worker.
func NewAnimeCreditsWorker(client AniListCreditsFetcher, store AnimeCreditsStore) *AnimeCreditsWorker {
	return &AnimeCreditsWorker{anilist: client, store: store, now: time.Now, sleep: sleepCtx}
}

// Timeout bounds one pass.
func (w *AnimeCreditsWorker) Timeout(*river.Job[AnimeCreditsArgs]) time.Duration {
	return creditsTimeout
}

// creditsPass is one pass's state: what it did, and whether it has to
// stop.
type creditsPass struct {
	w *AnimeCreditsWorker

	castTitles, staffTitles int
	written, capped, absent int
	failed, requests, busy  int
	// stop is set when the pass must end: the budget is someone else's, or
	// a failure said not to push on.  stopReason is for the log.
	stop       bool
	stopReason string
}

// Work runs one pass.
func (w *AnimeCreditsWorker) Work(ctx context.Context, _ *river.Job[AnimeCreditsArgs]) error {
	ctx, cancel := context.WithTimeout(ctx, creditsTimeout)
	defer cancel()
	start := w.clock()
	p := &creditsPass{w: w}
	stale := pgtype.Interval{Microseconds: int64(creditsStaleAfter / time.Microsecond), Valid: true}

	castIDs, err := w.store.ListAnimeCastCandidates(ctx, stale, anilist.CreditsPerPage, creditsCastPerPass)
	if err != nil {
		return fmt.Errorf("anime_credits list cast candidates: %w", err)
	}
	for _, id := range castIDs {
		if p.stop {
			break
		}
		p.castTitles++
		p.sweepCast(ctx, id)
	}

	if !p.stop {
		staffIDs, err := w.store.ListAnimeStaffCandidates(ctx, stale, anilist.CreditsPerPage, int32(creditsTitlesPerPass-p.castTitles))
		if err != nil {
			return fmt.Errorf("anime_credits list staff candidates: %w", err)
		}
		for _, id := range staffIDs {
			if p.stop {
				break
			}
			p.staffTitles++
			p.sweepStaff(ctx, id)
		}
	}

	if p.castTitles+p.staffTitles == 0 {
		slog.InfoContext(ctx, "anime_credits nothing due")
		return nil
	}
	slog.InfoContext(ctx, "anime_credits pass done",
		"castTitles", p.castTitles,
		"staffTitles", p.staffTitles,
		"written", p.written,
		"capped", p.capped,
		"absentUpstream", p.absent,
		"failed", p.failed,
		"requests", p.requests,
		"budgetBusy", p.busy,
		"stopped", p.stopReason,
		"duration", w.clock().Sub(start))
	return nil
}

// errShortCreditPages is a credit response that does not carry one page
// per page asked for.  The client refuses to produce one (an omitted
// page is an upstream error there); this is the sweep's own guard, so a
// list it cannot vouch for is never written as the whole list.
var errShortCreditPages = errors.New("anime_credits: response does not carry every requested page")

// checkPages verifies a response carried a full request's pages.
func checkPages(n int) error {
	if n != anilist.MaxCreditPagesPerRequest {
		return fmt.Errorf("%w: got %d of %d", errShortCreditPages, n, anilist.MaxCreditPagesPerRequest)
	}
	return nil
}

// sweepCast fetches one title's characters in full and replaces what is
// stored.
func (p *creditsPass) sweepCast(ctx context.Context, id int32) {
	first, err := fetchPages(ctx, p, id, 1, p.w.anilist.CharacterPagesNoWait)
	if err == nil {
		err = checkPages(len(first.Pages))
	}
	if err != nil {
		p.titleFailed(ctx, "cast", id, err, p.w.store.StampAnimeCastChecked)
		return
	}
	pages := first.Pages
	if more, _ := lastPage(pages).NextPage(); more {
		second, err := fetchPages(ctx, p, id, len(pages)+1, p.w.anilist.CharacterPagesNoWait)
		if err == nil {
			err = checkPages(len(second.Pages))
		}
		if err != nil {
			// Half a list is not written: the rows the first request
			// would replace are no worse than they were.
			p.secondRequestFailed(ctx, "cast", id, err, p.w.store.StampAnimeCastChecked)
			return
		}
		pages = append(pages, second.Pages...)
	}

	edges, capped := stitchPages(len(pages), func(i int) ([]anilist.CharacterEdge, bool) {
		more, _ := pages[i].NextPage()
		return pages[i].Edges, more
	})
	hasMore, _ := pages[0].NextPage()
	cast := credits.CastFromEdges(edges, first.CountryOfOrigin)
	if err := p.w.store.ReplaceCast(ctx, id, cast, hasMore, p.w.clock()); err != nil {
		p.titleFailed(ctx, "cast", id, err, p.w.store.StampAnimeCastChecked)
		return
	}
	p.written++
	if capped {
		p.capped++
	}
}

// sweepStaff is sweepCast for staff.
func (p *creditsPass) sweepStaff(ctx context.Context, id int32) {
	first, err := fetchPages(ctx, p, id, 1, p.w.anilist.StaffPagesNoWait)
	if err == nil {
		err = checkPages(len(first.Pages))
	}
	if err != nil {
		p.titleFailed(ctx, "staff", id, err, p.w.store.StampAnimeStaffChecked)
		return
	}
	pages := first.Pages
	if more, _ := lastPage(pages).NextPage(); more {
		second, err := fetchPages(ctx, p, id, len(pages)+1, p.w.anilist.StaffPagesNoWait)
		if err == nil {
			err = checkPages(len(second.Pages))
		}
		if err != nil {
			p.secondRequestFailed(ctx, "staff", id, err, p.w.store.StampAnimeStaffChecked)
			return
		}
		pages = append(pages, second.Pages...)
	}

	edges, capped := stitchPages(len(pages), func(i int) ([]anilist.StaffEdge, bool) {
		more, _ := pages[i].NextPage()
		return pages[i].Edges, more
	})
	hasMore, _ := pages[0].NextPage()
	if err := p.w.store.ReplaceStaff(ctx, id, credits.StaffFromEdges(edges), hasMore, p.w.clock()); err != nil {
		p.titleFailed(ctx, "staff", id, err, p.w.store.StampAnimeStaffChecked)
		return
	}
	p.written++
	if capped {
		p.capped++
	}
}

// fetchPages makes one paced, no-wait request for pages first..first+7
// of one list.  The page count is fixed at a full request: a title's
// length is not known until its pages say so, and the empty pages past
// the end cost nothing that matters.
func fetchPages[R any](
	ctx context.Context,
	p *creditsPass,
	id int32,
	first int,
	fetch func(context.Context, anilist.CreditPagesVars) (*R, error),
) (*R, error) {
	vars := anilist.CreditPagesVars{ID: int(id), FirstPage: first, LastPage: first + anilist.MaxCreditPagesPerRequest - 1}
	var res *R
	err := p.paced(ctx, func() error {
		var err error
		res, err = fetch(ctx, vars)
		return err
	})
	if err == nil && res == nil {
		err = errShortCreditPages
	}
	return res, err
}

// paced waits creditsRequestGap and sends the request; on ErrBudgetBusy
// it waits again and retries, up to creditsBusyRetries times.  The wait
// comes before every attempt, the first included, so consecutive requests
// are always a gap apart whichever titles they belong to.
func (p *creditsPass) paced(ctx context.Context, request func() error) error {
	for attempt := 0; ; attempt++ {
		if err := p.w.pause(ctx, creditsRequestGap); err != nil {
			return err
		}
		err := request()
		if !errors.Is(err, anilist.ErrBudgetBusy) {
			p.requests++
			return err
		}
		p.busy++
		if attempt >= creditsBusyRetries {
			return err
		}
	}
}

// titleFailed decides what a failed title is stamped with and whether the
// pass goes on.
//
//   - Busy budget, 429, open breaker, or the pass's own deadline: nothing
//     is stamped, the pass ends, and the title heads the next one.  None of
//     these says anything about the title.
//   - AniList does not serve the title (404, or Media null): stamped as
//     read now, so it is asked again in creditsStaleAfter.  Its stored
//     rows are kept -- AniList dropping a title is not a reason for the
//     page to lose its cast.
//   - Anything else (a refused document, a 5xx, a decode or database
//     error): stamped back-dated so it is due again in
//     creditsRetryAfterFailure, and the pass ends.  Ending is what bounds
//     an outage to one stamped title per pass rather than every title the
//     pass could reach.
func (p *creditsPass) titleFailed(
	ctx context.Context,
	list string,
	id int32,
	err error,
	stamp func(context.Context, pgtype.Timestamptz, *bool, int32) error,
) {
	var up *anilist.ErrUpstream
	switch {
	case errors.Is(err, anilist.ErrBudgetBusy), errors.Is(err, anilist.ErrRateLimited), ctx.Err() != nil:
		p.stop, p.stopReason = true, "budget"
		slog.DebugContext(ctx, "anime_credits budget not available, ending pass", "list", list, "anilistId", id, "err", err)
		return
	case errors.As(err, &up) && up.Status == http.StatusNotFound:
		p.absent++
		at := p.w.clock()
		if err := stamp(ctx, pgtype.Timestamptz{Time: at, Valid: true}, nil, id); err != nil {
			slog.WarnContext(ctx, "anime_credits stamp failed", "list", list, "anilistId", id, "err", err)
		}
		return
	default:
		p.failed++
		p.stop, p.stopReason = true, "failure"
		slog.WarnContext(ctx, "anime_credits title failed, retrying it later", "list", list, "anilistId", id, "err", err)
		at := p.w.clock().Add(creditsRetryAfterFailure - creditsStaleAfter)
		if err := stamp(ctx, pgtype.Timestamptz{Time: at, Valid: true}, nil, id); err != nil {
			slog.WarnContext(ctx, "anime_credits stamp failed", "list", list, "anilistId", id, "err", err)
		}
	}
}

// secondRequestFailed handles a failure of a title's second request
// (pages 9-16).  A busy budget or a 429 there ends the pass as it would
// anywhere, but also steps the title back creditsDeferAfterBusy, because
// unlike a first request this one comes after a request the title has
// already spent.  Every other failure is titleFailed's.
func (p *creditsPass) secondRequestFailed(
	ctx context.Context,
	list string,
	id int32,
	err error,
	stamp func(context.Context, pgtype.Timestamptz, *bool, int32) error,
) {
	if !errors.Is(err, anilist.ErrBudgetBusy) && !errors.Is(err, anilist.ErrRateLimited) {
		p.titleFailed(ctx, list, id, err, stamp)
		return
	}
	p.stop, p.stopReason = true, "budget"
	slog.DebugContext(ctx, "anime_credits second request found no budget, deferring title", "list", list, "anilistId", id, "err", err)
	at := p.w.clock().Add(creditsDeferAfterBusy - creditsStaleAfter)
	if err := stamp(ctx, pgtype.Timestamptz{Time: at, Valid: true}, nil, id); err != nil {
		slog.WarnContext(ctx, "anime_credits stamp failed", "list", list, "anilistId", id, "err", err)
	}
}

// stitchPages concatenates the edges of pages 0..n-1 in order, stopping
// after the first page that says it is the last.  capped reports that the
// last page fetched still had a next one: the list is longer than
// creditsMaxPages, and what is returned is its first 400.
func stitchPages[E any](n int, page func(int) ([]E, bool)) (edges []E, capped bool) {
	for i := 0; i < n; i++ {
		e, more := page(i)
		edges = append(edges, e...)
		if !more {
			return edges, false
		}
	}
	return edges, n > 0
}

// lastPage returns the last page of a non-empty slice, or nil.  NextPage
// on nil answers "no next page", so an empty response ends the title.
func lastPage[C any](pages []C) *C {
	if len(pages) == 0 {
		return nil
	}
	return &pages[len(pages)-1]
}

// clock reads the injected time source, defaulting to time.Now.
func (w *AnimeCreditsWorker) clock() time.Time {
	if w.now == nil {
		return time.Now()
	}
	return w.now()
}

// pause sleeps d, or returns early with ctx's error.
func (w *AnimeCreditsWorker) pause(ctx context.Context, d time.Duration) error {
	if w.sleep == nil {
		return sleepCtx(ctx, d)
	}
	return w.sleep(ctx, d)
}

// sleepCtx is time.Sleep that gives up when ctx does.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// pgCreditsStore is the production AnimeCreditsStore: the generated
// queries for the reads and the stamps, and a transaction per replace.
type pgCreditsStore struct {
	*dbgen.Queries
	pool *pgxpool.Pool
}

// ReplaceCast writes a title's whole character list and its voices, and
// stamps the sweep's read, in one transaction: a title is either fully
// rewritten and stamped or untouched and still a candidate.
//
// The stamp is written FIRST, though it describes the write that follows.
// Inside one transaction the order changes nothing about what commits,
// and it decides the order locks are taken in: the anime_cache row before
// the credit rows, as the admin enrichment reset takes them
// (ResetAnimeEnrichment, then DeleteAnimeCharactersForReset).  The other
// way round, a reset and a sweep pass meeting on one title could each hold
// what the other waits for.
func (s pgCreditsStore) ReplaceCast(ctx context.Context, animeID int32, cast credits.Cast, hasMore bool, checkedAt time.Time) error {
	return s.inTx(ctx, func(q *dbgen.Queries) error {
		if err := q.StampAnimeCastChecked(ctx, pgtype.Timestamptz{Time: checkedAt, Valid: true}, &hasMore, animeID); err != nil {
			return fmt.Errorf("stamp: %w", err)
		}
		return credits.WriteCast(ctx, q, animeID, cast, credits.WholeList)
	})
}

// ReplaceStaff is ReplaceCast for staff, stamp first for the same reason.
func (s pgCreditsStore) ReplaceStaff(ctx context.Context, animeID int32, staff []credits.Staff, hasMore bool, checkedAt time.Time) error {
	return s.inTx(ctx, func(q *dbgen.Queries) error {
		if err := q.StampAnimeStaffChecked(ctx, pgtype.Timestamptz{Time: checkedAt, Valid: true}, &hasMore, animeID); err != nil {
			return fmt.Errorf("stamp: %w", err)
		}
		return credits.WriteStaff(ctx, q, animeID, staff, credits.WholeList)
	})
}

// inTx runs fn on queries bound to one transaction, committing only if
// it returns nil.
func (s pgCreditsStore) inTx(ctx context.Context, fn func(*dbgen.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(s.Queries.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// AddCreditsWorker registers the sweep on an existing bundle.  It takes
// the shared AniList client -- the one whose limiter every caller draws
// on, which is the whole point of the pacing above -- and the pool for
// its per-title transactions.
func AddCreditsWorker(w *river.Workers, anilistClient AniListCreditsFetcher, pool *pgxpool.Pool, q *dbgen.Queries) {
	river.AddWorker(w, NewAnimeCreditsWorker(anilistClient, pgCreditsStore{Queries: q, pool: pool}))
}

// Compile-time guards.
var (
	_ river.Worker[AnimeCreditsArgs] = (*AnimeCreditsWorker)(nil)
	_ AnimeCreditsStore              = pgCreditsStore{}
	_ AniListCreditsFetcher          = (*anilist.Client)(nil)
)
