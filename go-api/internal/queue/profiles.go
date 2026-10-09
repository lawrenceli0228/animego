// profiles.go — the sweep that collects AniList's profiles of the people
// and characters the site lists.
//
// # What is missing
//
// The credit tables hold AniList's id for every person and character on a
// title, and beside it only what a credit line shows: a name and an image
// (0037, 0042).  A person or character page -- what those ids are for --
// needs the profile behind them: the other names, the description, the
// birthday, a person's occupations and years active.  AniList serves that
// as Staff and Character, fifty ids to a request
// (anilist.StaffProfilesQuery), and this sweep stores it in the people and
// characters tables (0044), one row per id.
//
// # Which ids, and in what order
//
// Every Staff id a credit row names -- anime_staff.staff_id,
// anime_characters.voice_actor_id, anime_character_voices.staff_id -- and
// every anime_characters.character_id.  Ids never asked about come first,
// then ids last asked longer ago than profilesStaleAfter; an id no credit
// names any more is not asked about again.
//
// Among the never-asked, the highest popularity of the titles that credit
// an id leads, and the number of credit rows only breaks ties.  The
// backlog is worth clearing in the order its profiles will be read, and a
// profile is reached from the title pages that link to it: a supporting
// voice in a title everyone opens is wanted before a key animator credited
// on two hundred titles nobody does.  The credit count would also say
// almost nothing about characters, nearly all of whom are on one title.
//
// # Pacing, which is the credits sweep's
//
// AniList grants this process about 30 requests a minute through one
// limiter, and the caller that must not lose is a cold detail request,
// which has nothing to fall back on (see anime_credits.go).  So, exactly
// as there:
//
//   - every request is no-wait (anilist.Client.StaffProfilesNoWait): it
//     takes a token only if one is idle right now, else ErrBudgetBusy;
//   - requests are profilesRequestGap apart, the first included, so a pass
//     never takes two tokens in a row;
//   - a busy budget is retried profilesBusyRetries times, a gap apart, and
//     then the pass ends -- the batch heads the next pass;
//   - a 429 or an open breaker ends the pass at once.
//
// A pass is at most profilesRequestsPerPass requests, every
// profilesInterval: at most 4 requests every 5 minutes, 48 an hour, and
// 2,400 profiles an hour -- under 3% of the budget, only ever tokens
// nobody was waiting for.  The two lists take turns, so neither waits for
// the other's backlog.  Every 10,000 ids in a backlog is a little over
// four hours of passes; once it is clear, a pass finds only the ids new
// credits bring in and the ones whose 90 days have run out.
//
// The sweep runs on the ratings queue (see ProfilesArgs), whose single
// slot keeps it from ever running beside the credits, facts and ratings
// sweeps.  Their requests add up in turns, never at once: together the
// AniList sweeps on that queue stay under a tenth of the budget.
//
// # Why a pass never returns an error for a batch
//
// The rule every sweep here follows: river retries a failed job on a
// backoff measured in minutes to days, and for a sweep that re-fires every
// five minutes the next pass is the retry.  A batch is written whole with
// its absent ids stamped (one transaction); or, after a failure, stamped
// back-dated (profilesRetryAfterFailure) and the pass ends; or, after a
// busy budget, a 429 or the pass's own deadline, left alone.  Only a
// failure to read a candidate list is returned.
//
// # The switch
//
// PROFILES_SWEEP_ENABLED gates every pass, read at work time and failing
// closed, like ANIME_CREDITS_SWEEP_ENABLED: a release can ship with it
// off, and turning it off again is an env change and a restart, not a
// deploy.  Like the credits sweep this one has no queue of its own to
// pause, so the flag is its own stop lever.
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

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/profiles"
)

const (
	// profilesInterval is how often a pass fires: the credits sweep's
	// cadence, for its reason -- small frequent passes, so the backlog is
	// drained by frequency and no pass holds the ratings queue's one slot
	// for long.
	profilesInterval = 5 * time.Minute

	// profilesTimeout bounds one pass.  A normal pass is well under a
	// minute; the bound covers one that spends every busy retry, and is
	// below profilesInterval so passes cannot overlap even if uniqueness
	// let them.
	profilesTimeout = 4 * time.Minute

	// profilesRequestsPerPass is how many requests one pass makes, people
	// and characters together, each of up to anilist.MaxProfileIDs ids.
	profilesRequestsPerPass = 4

	// profilesRequestGap is the pause before every request, a retry after
	// ErrBudgetBusy included: the credits sweep's gap, about three refills
	// of the AniList limiter.
	profilesRequestGap = 6 * time.Second

	// profilesBusyRetries is how many more times one request is tried after
	// ErrBudgetBusy before the pass gives up and ends.
	profilesBusyRetries = 3

	// profilesStaleAfter is how long a profile stays fresh.  Ninety days,
	// the ratings sweep's cadence: names, birthdays and blood types do not
	// move, and what does -- favourites, years active, a description, a
	// date of death -- is not something a profile page needs to the day.
	// The re-check costs one request per fifty ids per quarter, a small
	// share of the sweep's 48 an hour once the backlog is clear.
	profilesStaleAfter = 90 * 24 * time.Hour

	// profilesRetryAfterFailure is when a batch whose fetch or write failed
	// comes round again.  Not at once: a batch that fails every time would
	// otherwise head every pass and starve the rest.  Not in
	// profilesStaleAfter either: most failures are transient.  The stamp is
	// back-dated by the difference, so the candidate query needs no second
	// column.
	profilesRetryAfterFailure = 24 * time.Hour

	// profilesEmptyAnswerFloor is the batch size from which an answer with
	// none of the asked ids in it is not believed.  Deleted and merged ids
	// are rare, so AniList returning nothing for ten or more ids is a
	// broken answer -- an id filter it did not apply, a page it lost --
	// and stamping them all absent would hide them for profilesStaleAfter.
	// It is a failure instead.  A smaller batch is believed: the tail of a
	// pass can legitimately be a few ids AniList has dropped.
	profilesEmptyAnswerFloor = 10
)

// profilesEnabledEnv names the switch; see the file comment.
const profilesEnabledEnv = "PROFILES_SWEEP_ENABLED"

// AniListProfilesFetcher is the upstream surface the sweep needs; both
// methods are no-wait.  *anilist.Client satisfies it.
type AniListProfilesFetcher interface {
	StaffProfilesNoWait(ctx context.Context, ids []int) ([]anilist.StaffProfile, error)
	CharacterProfilesNoWait(ctx context.Context, ids []int) ([]anilist.CharacterProfile, error)
}

// ProfilesStore is the database surface: the two candidate lists, a save
// per kind that is one transaction (the rows and the batch's absent
// stamps), and the stamps a failed batch is given.  pgProfilesStore is the
// production implementation.
type ProfilesStore interface {
	ListPeopleCandidates(ctx context.Context, rowLimit int32, staleAfter pgtype.Interval) ([]int32, error)
	ListCharacterCandidates(ctx context.Context, rowLimit int32, staleAfter pgtype.Interval) ([]int32, error)
	SavePeople(ctx context.Context, rows []dbgen.UpsertPersonParams, absent []int32, at time.Time) error
	SaveCharacters(ctx context.Context, rows []dbgen.UpsertCharacterParams, absent []int32, at time.Time) error
	StampPeopleChecked(ctx context.Context, checkedAt pgtype.Timestamptz, absent bool, ids []int32) error
	StampCharactersChecked(ctx context.Context, checkedAt pgtype.Timestamptz, absent bool, ids []int32) error
}

// ProfilesWorker runs the sweep.
type ProfilesWorker struct {
	river.WorkerDefaults[ProfilesArgs]
	anilist AniListProfilesFetcher
	store   ProfilesStore
	now     func() time.Time
	// sleep is the pause between requests; tests replace it.
	sleep func(context.Context, time.Duration) error
	// enabled reports whether a pass may run (profilesSweepEnabled); tests
	// replace it.
	enabled func() bool
}

// NewProfilesWorker builds the worker.
func NewProfilesWorker(client AniListProfilesFetcher, store ProfilesStore) *ProfilesWorker {
	return &ProfilesWorker{anilist: client, store: store, now: time.Now, sleep: sleepCtx, enabled: profilesSweepEnabled}
}

// profilesSweepEnabled reads the switch.  Only a value strconv.ParseBool
// reads as true turns the sweep on; anything else, a typo included, is off.
func profilesSweepEnabled() bool {
	on, err := strconv.ParseBool(os.Getenv(profilesEnabledEnv))
	return err == nil && on
}

// Timeout bounds one pass.
func (w *ProfilesWorker) Timeout(*river.Job[ProfilesArgs]) time.Duration {
	return profilesTimeout
}

// profileBatch is one request's worth of one list.
type profileBatch struct {
	kind profileSweeper
	ids  []int32
}

// profileSweeper is one of the two lists: profileKind for people or for
// characters.
type profileSweeper interface {
	sweep(ctx context.Context, p *profilesPass, ids []int32)
}

// Work runs one pass.
func (w *ProfilesWorker) Work(ctx context.Context, _ *river.Job[ProfilesArgs]) error {
	if !w.enabled() {
		// Debug, not Info: this fires every five minutes.  AddProfilesWorker
		// says it once, at startup.
		slog.DebugContext(ctx, "profiles sweep disabled", "env", profilesEnabledEnv)
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, profilesTimeout)
	defer cancel()
	start := w.clock()
	stale := pgtype.Interval{Microseconds: int64(profilesStaleAfter / time.Microsecond), Valid: true}
	limit := int32(profilesRequestsPerPass * anilist.MaxProfileIDs)

	peopleIDs, err := w.store.ListPeopleCandidates(ctx, limit, stale)
	if err != nil {
		return fmt.Errorf("profiles list people candidates: %w", err)
	}
	characterIDs, err := w.store.ListCharacterCandidates(ctx, limit, stale)
	if err != nil {
		return fmt.Errorf("profiles list character candidates: %w", err)
	}

	batches := alternate(
		batchesOf(w.peopleKind(), peopleIDs),
		batchesOf(w.characterKind(), characterIDs),
		profilesRequestsPerPass,
	)
	if len(batches) == 0 {
		slog.InfoContext(ctx, "profiles nothing due")
		return nil
	}

	p := &profilesPass{w: w}
	for _, b := range batches {
		if p.stop {
			break
		}
		b.kind.sweep(ctx, p, b.ids)
	}
	slog.InfoContext(ctx, "profiles pass done",
		"peopleCandidates", len(peopleIDs),
		"characterCandidates", len(characterIDs),
		"batches", p.batches,
		"written", p.written,
		"absentUpstream", p.absent,
		"stray", p.stray,
		"failed", p.failed,
		"requests", p.requests,
		"budgetBusy", p.busy,
		"stopped", p.stopReason,
		"duration", w.clock().Sub(start))
	return nil
}

// peopleKind is the people half of a pass: AniList Staff profiles into the
// people table.
func (w *ProfilesWorker) peopleKind() profileKind[anilist.StaffProfile, dbgen.UpsertPersonParams] {
	return profileKind[anilist.StaffProfile, dbgen.UpsertPersonParams]{
		name:  "people",
		fetch: w.anilist.StaffProfilesNoWait,
		id:    func(s anilist.StaffProfile) int { return s.ID },
		row:   profiles.PersonRow,
		save:  w.store.SavePeople,
		stamp: w.store.StampPeopleChecked,
	}
}

// characterKind is the characters half of a pass.
func (w *ProfilesWorker) characterKind() profileKind[anilist.CharacterProfile, dbgen.UpsertCharacterParams] {
	return profileKind[anilist.CharacterProfile, dbgen.UpsertCharacterParams]{
		name:  "characters",
		fetch: w.anilist.CharacterProfilesNoWait,
		id:    func(c anilist.CharacterProfile) int { return c.ID },
		row:   profiles.CharacterRow,
		save:  w.store.SaveCharacters,
		stamp: w.store.StampCharactersChecked,
	}
}

// batchesOf cuts a candidate list into requests of at most
// anilist.MaxProfileIDs ids, in candidate order.
func batchesOf(kind profileSweeper, ids []int32) []profileBatch {
	var out []profileBatch
	for start := 0; start < len(ids); start += anilist.MaxProfileIDs {
		end := min(start+anilist.MaxProfileIDs, len(ids))
		out = append(out, profileBatch{kind: kind, ids: ids[start:end]})
	}
	return out
}

// alternate takes from a and b in turn, a first, up to limit in all; once
// one runs out the other has every turn left.
func alternate[T any](a, b []T, limit int) []T {
	out := make([]T, 0, min(limit, len(a)+len(b)))
	for i := 0; len(out) < limit && (i < len(a) || i < len(b)); i++ {
		if i < len(a) {
			out = append(out, a[i])
		}
		if i < len(b) && len(out) < limit {
			out = append(out, b[i])
		}
	}
	return out
}

// profilesPass is one pass's state: what it did, and whether it has to
// stop.
type profilesPass struct {
	w *ProfilesWorker

	batches, written, absent, stray int
	failed, requests, busy          int
	// stop is set when the pass must end: the budget is someone else's, or
	// a failure said not to push on.  stopReason is for the log.
	stop       bool
	stopReason string
}

// profileKind is one list's half of the sweep: how a batch of its ids is
// asked about, how an answer is read, and where it is written.  P is
// AniList's profile type, R the row the store takes.
type profileKind[P, R any] struct {
	name  string
	fetch func(context.Context, []int) ([]P, error)
	id    func(P) int
	row   func(P, time.Time) R
	save  func(ctx context.Context, rows []R, absent []int32, at time.Time) error
	stamp func(ctx context.Context, checkedAt pgtype.Timestamptz, absent bool, ids []int32) error
}

// sweep asks AniList about one batch and saves the answer: the profiles
// that came back, and an absent stamp for each asked id that did not, in
// one transaction.
func (k profileKind[P, R]) sweep(ctx context.Context, p *profilesPass, ids []int32) {
	asked := make([]int, len(ids))
	for i, id := range ids {
		asked[i] = int(id)
	}
	var got []P
	err := p.paced(ctx, func() error {
		var err error
		got, err = k.fetch(ctx, asked)
		return err
	})
	if err != nil {
		p.batchFailed(ctx, k.name, ids, err, k.stamp)
		return
	}

	at := p.w.clock()
	rows, absent, stray := k.match(ids, got, at)
	if stray > 0 {
		slog.WarnContext(ctx, "profiles answer held profiles it was not asked for", "kind", k.name, "stray", stray)
	}
	if len(rows) == 0 && len(ids) >= profilesEmptyAnswerFloor {
		p.batchFailed(ctx, k.name, ids, errEmptyProfileAnswer, k.stamp)
		return
	}
	if err := k.save(ctx, rows, absent, at); err != nil {
		p.batchFailed(ctx, k.name, ids, err, k.stamp)
		return
	}
	p.batches++
	p.written += len(rows)
	p.absent += len(absent)
	p.stray += stray
}

// errEmptyProfileAnswer is an answer with none of a batch's ids in it; see
// profilesEmptyAnswerFloor.
var errEmptyProfileAnswer = errors.New("profiles: AniList returned none of the ids asked about")

// match pairs an answer with the ids asked: a row for each asked id that
// came back, in the order asked, and the asked ids that did not.  A stray
// profile -- for an id the batch did not ask about, or a second one for an
// id it did -- is counted and dropped: it cannot stand in for anything.
func (k profileKind[P, R]) match(asked []int32, got []P, at time.Time) (rows []R, absent []int32, stray int) {
	want := make(map[int]bool, len(asked))
	for _, id := range asked {
		want[int(id)] = true
	}
	byID := make(map[int]P, len(got))
	for _, g := range got {
		id := k.id(g)
		if _, dup := byID[id]; !want[id] || dup {
			stray++
			continue
		}
		byID[id] = g
	}
	for _, id := range asked {
		g, ok := byID[int(id)]
		if !ok {
			absent = append(absent, id)
			continue
		}
		rows = append(rows, k.row(g, at))
	}
	return rows, absent, stray
}

// paced waits profilesRequestGap and sends the request; on ErrBudgetBusy
// it waits again and retries, up to profilesBusyRetries times.  The wait
// comes before every attempt, the first included, so consecutive requests
// are always a gap apart whichever list they belong to.  (The credits
// sweep's creditsPass.paced, with this sweep's constants.)
func (p *profilesPass) paced(ctx context.Context, request func() error) error {
	for attempt := 0; ; attempt++ {
		if err := p.w.pause(ctx, profilesRequestGap); err != nil {
			return err
		}
		err := request()
		if !errors.Is(err, anilist.ErrBudgetBusy) {
			p.requests++
			return err
		}
		p.busy++
		if attempt >= profilesBusyRetries {
			return err
		}
	}
}

// batchFailed decides what a failed batch is stamped with and ends the
// pass.
//
//   - Busy budget, 429, open breaker, or the pass's own deadline: nothing
//     is stamped and the batch heads the next pass.  None of these says
//     anything about the ids.
//   - Anything else (a refused document, a 5xx, an answer that is not
//     believed, a decode or database error): stamped back-dated so the
//     batch is due again in profilesRetryAfterFailure, with no absence
//     recorded.  Ending the pass is what bounds an outage to one stamped
//     batch per pass rather than every batch the pass could reach.
func (p *profilesPass) batchFailed(
	ctx context.Context,
	kind string,
	ids []int32,
	err error,
	stamp func(context.Context, pgtype.Timestamptz, bool, []int32) error,
) {
	if errors.Is(err, anilist.ErrBudgetBusy) || errors.Is(err, anilist.ErrRateLimited) || ctx.Err() != nil {
		p.stop, p.stopReason = true, "budget"
		slog.DebugContext(ctx, "profiles budget not available, ending pass", "kind", kind, "ids", len(ids), "err", err)
		return
	}
	p.failed += len(ids)
	p.stop, p.stopReason = true, "failure"
	slog.WarnContext(ctx, "profiles batch failed, retrying it later",
		"kind", kind, "ids", len(ids), "firstId", ids[0], "err", err)
	at := p.w.clock().Add(profilesRetryAfterFailure - profilesStaleAfter)
	if err := stamp(ctx, pgtype.Timestamptz{Time: at, Valid: true}, false, ids); err != nil {
		slog.WarnContext(ctx, "profiles stamp failed", "kind", kind, "ids", len(ids), "err", err)
	}
}

// clock reads the injected time source, defaulting to time.Now.
func (w *ProfilesWorker) clock() time.Time {
	if w.now == nil {
		return time.Now()
	}
	return w.now()
}

// pause sleeps d, or returns early with ctx's error.
func (w *ProfilesWorker) pause(ctx context.Context, d time.Duration) error {
	if w.sleep == nil {
		return sleepCtx(ctx, d)
	}
	return w.sleep(ctx, d)
}

// pgProfilesStore is the production ProfilesStore: the generated queries
// for the candidate lists and the stamps, and a transaction per save.
type pgProfilesStore struct {
	*dbgen.Queries
	pool *pgxpool.Pool
}

// SavePeople writes one batch's people and its absent stamps in one
// transaction: a batch is either all written and stamped or untouched and
// still due.  No other table is touched, so there is no lock order to
// keep with any other writer.
func (s pgProfilesStore) SavePeople(ctx context.Context, rows []dbgen.UpsertPersonParams, absent []int32, at time.Time) error {
	return s.inTx(ctx, func(q *dbgen.Queries) error {
		return profiles.WritePeople(ctx, q, rows, absent, at)
	})
}

// SaveCharacters is SavePeople for characters.
func (s pgProfilesStore) SaveCharacters(ctx context.Context, rows []dbgen.UpsertCharacterParams, absent []int32, at time.Time) error {
	return s.inTx(ctx, func(q *dbgen.Queries) error {
		return profiles.WriteCharacters(ctx, q, rows, absent, at)
	})
}

// inTx runs fn on queries bound to one transaction, committing only if it
// returns nil.
func (s pgProfilesStore) inTx(ctx context.Context, fn func(*dbgen.Queries) error) error {
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

// AddProfilesWorker registers the sweep on an existing bundle.  It takes
// the shared AniList client -- the one whose limiter every caller draws
// on, which is what the pacing above is defined against -- and the pool
// for its per-batch transactions.
func AddProfilesWorker(w *river.Workers, anilistClient AniListProfilesFetcher, pool *pgxpool.Pool, q *dbgen.Queries) {
	river.AddWorker(w, NewProfilesWorker(anilistClient, pgProfilesStore{Queries: q, pool: pool}))
	if !profilesSweepEnabled() {
		slog.Info("profiles sweep registered but disabled", "env", profilesEnabledEnv)
	}
}

// Compile-time guards.
var (
	_ river.Worker[ProfilesArgs] = (*ProfilesWorker)(nil)
	_ ProfilesStore              = pgProfilesStore{}
	_ AniListProfilesFetcher     = (*anilist.Client)(nil)
	_ profileSweeper             = profileKind[anilist.StaffProfile, dbgen.UpsertPersonParams]{}
)
