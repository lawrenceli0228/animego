package queue

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type profilesSave[R any] struct {
	rows   []R
	absent []int32
	at     time.Time
}

type profilesStamp struct {
	at     time.Time
	absent bool
	ids    []int32
}

type fakeProfilesStore struct {
	peopleIDs, characterIDs     []int32
	peopleLimit, characterLimit int32
	staleAfter                  pgtype.Interval
	listed                      []string
	peopleListErr, charListErr  error
	saveErr                     error

	peopleSaves     []profilesSave[dbgen.UpsertPersonParams]
	characterSaves  []profilesSave[dbgen.UpsertCharacterParams]
	peopleStamps    []profilesStamp
	characterStamps []profilesStamp
}

func (f *fakeProfilesStore) ListPeopleCandidates(_ context.Context, rowLimit int32, staleAfter pgtype.Interval) ([]int32, error) {
	f.listed = append(f.listed, "people")
	f.peopleLimit, f.staleAfter = rowLimit, staleAfter
	if f.peopleListErr != nil {
		return nil, f.peopleListErr
	}
	return headOf(f.peopleIDs, rowLimit), nil
}

func (f *fakeProfilesStore) ListCharacterCandidates(_ context.Context, rowLimit int32, staleAfter pgtype.Interval) ([]int32, error) {
	f.listed = append(f.listed, "characters")
	f.characterLimit, f.staleAfter = rowLimit, staleAfter
	if f.charListErr != nil {
		return nil, f.charListErr
	}
	return headOf(f.characterIDs, rowLimit), nil
}

func headOf(ids []int32, n int32) []int32 {
	if int(n) < len(ids) {
		return ids[:n]
	}
	return ids
}

func (f *fakeProfilesStore) SavePeople(_ context.Context, rows []dbgen.UpsertPersonParams, absent []int32, at time.Time) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.peopleSaves = append(f.peopleSaves, profilesSave[dbgen.UpsertPersonParams]{rows: rows, absent: absent, at: at})
	return nil
}

func (f *fakeProfilesStore) SaveCharacters(_ context.Context, rows []dbgen.UpsertCharacterParams, absent []int32, at time.Time) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.characterSaves = append(f.characterSaves, profilesSave[dbgen.UpsertCharacterParams]{rows: rows, absent: absent, at: at})
	return nil
}

func (f *fakeProfilesStore) StampPeopleChecked(_ context.Context, at pgtype.Timestamptz, absent bool, ids []int32) error {
	f.peopleStamps = append(f.peopleStamps, profilesStamp{at: at.Time, absent: absent, ids: ids})
	return nil
}

func (f *fakeProfilesStore) StampCharactersChecked(_ context.Context, at pgtype.Timestamptz, absent bool, ids []int32) error {
	f.characterStamps = append(f.characterStamps, profilesStamp{at: at.Time, absent: absent, ids: ids})
	return nil
}

// fakeProfilesAniList answers every asked id with a profile, except the
// ids in missing; extra ids are returned whether asked or not.  err, when
// it returns non-nil for a call, wins.
type fakeProfilesAniList struct {
	missing map[int]bool
	extra   []int
	err     func(kind string, ids []int, call int) error
	calls   []string
	asked   [][]int
}

func (f *fakeProfilesAniList) record(kind string, ids []int) error {
	f.calls = append(f.calls, fmt.Sprintf("%s %d-%d (%d)", kind, ids[0], ids[len(ids)-1], len(ids)))
	f.asked = append(f.asked, ids)
	if f.err != nil {
		return f.err(kind, ids, len(f.calls))
	}
	return nil
}

func (f *fakeProfilesAniList) answer(ids []int) []int {
	var out []int
	for _, id := range ids {
		if !f.missing[id] {
			out = append(out, id)
		}
	}
	return append(out, f.extra...)
}

func (f *fakeProfilesAniList) StaffProfilesNoWait(_ context.Context, ids []int) ([]anilist.StaffProfile, error) {
	if err := f.record("people", ids); err != nil {
		return nil, err
	}
	out := []anilist.StaffProfile{}
	for _, id := range f.answer(ids) {
		name := fmt.Sprintf("  person %d ", id)
		out = append(out, anilist.StaffProfile{ID: id, Name: &anilist.StaffName{Full: &name}})
	}
	return out, nil
}

func (f *fakeProfilesAniList) CharacterProfilesNoWait(_ context.Context, ids []int) ([]anilist.CharacterProfile, error) {
	if err := f.record("characters", ids); err != nil {
		return nil, err
	}
	out := []anilist.CharacterProfile{}
	for _, id := range f.answer(ids) {
		name := fmt.Sprintf("character %d", id)
		out = append(out, anilist.CharacterProfile{ID: id, Name: &anilist.CharacterName{Full: &name}})
	}
	return out, nil
}

var profilesNow = time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)

// newProfilesWorker wires the fakes with a frozen clock, a sleep that
// records instead of waiting, and the switch on (see
// TestProfiles_OffUnlessEnabled for the switch itself).
func newProfilesWorker(al AniListProfilesFetcher, store ProfilesStore) (*ProfilesWorker, *[]time.Duration) {
	var slept []time.Duration
	w := NewProfilesWorker(al, store)
	w.enabled = func() bool { return true }
	w.now = func() time.Time { return profilesNow }
	w.sleep = func(_ context.Context, d time.Duration) error {
		slept = append(slept, d)
		return nil
	}
	return w, &slept
}

func profilesJob() *river.Job[ProfilesArgs] { return &river.Job[ProfilesArgs]{} }

// idRange is lo..hi inclusive.
func idRange(lo, hi int32) []int32 {
	out := make([]int32, 0, hi-lo+1)
	for id := lo; id <= hi; id++ {
		out = append(out, id)
	}
	return out
}

func savedPeopleIDs(saves []profilesSave[dbgen.UpsertPersonParams]) []int32 {
	var out []int32
	for _, s := range saves {
		for _, r := range s.rows {
			out = append(out, r.AnilistID)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestProfiles_OffUnlessEnabled — the sweep runs only when
// PROFILES_SWEEP_ENABLED parses as true.  Absent, false or a typo is a
// pass that reads no candidate and asks AniList nothing: a variable that
// gates writes to production fails closed, like the other sweeps' flags.
func TestProfiles_OffUnlessEnabled(t *testing.T) {
	for _, tc := range []struct {
		value string
		on    bool
	}{
		{"", false}, {"false", false}, {"0", false}, {"yes", false}, {"ture", false},
		{"true", true}, {"1", true}, {"TRUE", true},
	} {
		t.Run(fmt.Sprintf("%q", tc.value), func(t *testing.T) {
			t.Setenv(profilesEnabledEnv, tc.value)
			store := &fakeProfilesStore{peopleIDs: idRange(1, 3)}
			al := &fakeProfilesAniList{}
			w := NewProfilesWorker(al, store)
			w.sleep = func(context.Context, time.Duration) error { return nil }

			require.NoError(t, w.Work(context.Background(), profilesJob()))
			if tc.on {
				assert.NotEmpty(t, store.listed)
				assert.NotEmpty(t, al.calls)
			} else {
				assert.Empty(t, store.listed, "no candidate read")
				assert.Empty(t, al.calls, "no AniList request")
			}
		})
	}
}

// TestProfiles_AlternatesKindsUpToTheCap — both lists are cut into
// requests of fifty and taken in turn, people first, until the pass has
// made profilesRequestsPerPass requests; a list that runs out leaves its
// turns to the other.  Each list is read with room for a whole pass.
func TestProfiles_AlternatesKindsUpToTheCap(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: idRange(1, 120), characterIDs: idRange(1001, 1030)}
	al := &fakeProfilesAniList{}
	w, _ := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))

	assert.Equal(t, []string{
		"people 1-50 (50)",
		"characters 1001-1030 (30)",
		"people 51-100 (50)",
		"people 101-120 (20)",
	}, al.calls)
	assert.Equal(t, int32(profilesRequestsPerPass*anilist.MaxProfileIDs), store.peopleLimit)
	assert.Equal(t, int32(profilesRequestsPerPass*anilist.MaxProfileIDs), store.characterLimit)
	assert.Equal(t, pgtype.Interval{Microseconds: int64(profilesStaleAfter / time.Microsecond), Valid: true}, store.staleAfter)

	assert.Equal(t, idRange(1, 120), savedPeopleIDs(store.peopleSaves))
	require.Len(t, store.characterSaves, 1)
	assert.Len(t, store.characterSaves[0].rows, 30)
	assert.Empty(t, store.peopleStamps)
	assert.Empty(t, store.characterStamps)
}

// TestProfiles_ThePassCapHolds — a backlog longer than a pass is a pass
// of profilesRequestsPerPass requests; the rest waits for the next one.
func TestProfiles_ThePassCapHolds(t *testing.T) {
	store := &fakeProfilesStore{characterIDs: idRange(1, 500)}
	al := &fakeProfilesAniList{}
	w, _ := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))

	assert.Equal(t, []string{
		"characters 1-50 (50)", "characters 51-100 (50)", "characters 101-150 (50)", "characters 151-200 (50)",
	}, al.calls, "with no people due, characters take every turn")
	assert.Len(t, store.characterSaves, profilesRequestsPerPass)
}

// TestProfiles_RowsAreTheNormalisersAndCarryTheFetchTime — what reaches
// the store is internal/profiles' row for each profile, stamped now, in
// the order the ids were asked.
func TestProfiles_RowsAreTheNormalisersAndCarryTheFetchTime(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: []int32{7, 3}}
	w, _ := newProfilesWorker(&fakeProfilesAniList{}, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))

	require.Len(t, store.peopleSaves, 1)
	save := store.peopleSaves[0]
	require.Len(t, save.rows, 2)
	assert.Equal(t, int32(7), save.rows[0].AnilistID)
	assert.Equal(t, "person 7", *save.rows[0].NameFull, "trimmed by the normaliser")
	assert.Equal(t, pgtype.Timestamptz{Time: profilesNow, Valid: true}, save.rows[0].FetchedAt)
	assert.Equal(t, profilesNow, save.at)
	assert.NotNil(t, save.rows[1].NameAlternative, "lists are never nil")
}

// TestProfiles_PacesEveryRequest — every request, the first included, is
// preceded by the gap, so the sweep never takes two tokens in a row.
func TestProfiles_PacesEveryRequest(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: idRange(1, 60), characterIDs: idRange(1001, 1010)}
	al := &fakeProfilesAniList{}
	w, slept := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))

	require.Len(t, al.calls, 3)
	assert.Equal(t, []time.Duration{profilesRequestGap, profilesRequestGap, profilesRequestGap}, *slept)
}

// TestProfiles_AbsentIdsAreSavedWithTheBatch — an id AniList did not
// return is deleted or merged upstream; it is stamped absent in the same
// save as the batch's rows, and the pass goes on.
func TestProfiles_AbsentIdsAreSavedWithTheBatch(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: idRange(1, 5), characterIDs: []int32{1001, 1002}}
	al := &fakeProfilesAniList{missing: map[int]bool{2: true, 4: true, 1002: true}}
	w, _ := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))

	require.Len(t, store.peopleSaves, 1)
	assert.Equal(t, []int32{1, 3, 5}, savedPeopleIDs(store.peopleSaves))
	assert.Equal(t, []int32{2, 4}, store.peopleSaves[0].absent)
	assert.Equal(t, profilesNow, store.peopleSaves[0].at)
	require.Len(t, store.characterSaves, 1, "the pass went on to the next batch")
	assert.Equal(t, []int32{1002}, store.characterSaves[0].absent)
	assert.Empty(t, store.peopleStamps, "absences ride the save's transaction, not a stamp of their own")
}

// TestProfiles_UnaskedIdsAreIgnored — a profile for an id the batch did
// not ask about is not written (and does not stand in for an asked one).
func TestProfiles_UnaskedIdsAreIgnored(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: []int32{1, 2}}
	al := &fakeProfilesAniList{missing: map[int]bool{2: true}, extra: []int{99, 1}}
	w, _ := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))

	require.Len(t, store.peopleSaves, 1)
	assert.Equal(t, []int32{1}, savedPeopleIDs(store.peopleSaves), "99 was not asked for; 1's repeat is dropped")
	assert.Equal(t, []int32{2}, store.peopleSaves[0].absent)
}

// TestProfiles_AnEmptyAnswerToABigBatchIsNotBelieved — AniList answering
// ten or more ids with none of them is a broken answer, not ten
// deletions: stamping them absent would hide them for the whole re-check
// interval.  It is a failure (back-dated stamp, pass over).  A small batch
// that comes back empty is believed.
func TestProfiles_AnEmptyAnswerToABigBatchIsNotBelieved(t *testing.T) {
	t.Run("big batch", func(t *testing.T) {
		ids := idRange(1, profilesEmptyAnswerFloor)
		missing := map[int]bool{}
		for _, id := range ids {
			missing[int(id)] = true
		}
		store := &fakeProfilesStore{peopleIDs: ids, characterIDs: []int32{1001}}
		al := &fakeProfilesAniList{missing: missing}
		w, _ := newProfilesWorker(al, store)

		require.NoError(t, w.Work(context.Background(), profilesJob()))

		assert.Empty(t, store.peopleSaves)
		require.Len(t, store.peopleStamps, 1)
		assert.Equal(t, profilesStamp{at: profilesNow.Add(profilesRetryAfterFailure - profilesStaleAfter), absent: false, ids: ids},
			store.peopleStamps[0])
		assert.Len(t, al.calls, 1, "the pass ends at the failed batch")
	})
	t.Run("small batch", func(t *testing.T) {
		ids := idRange(1, profilesEmptyAnswerFloor-1)
		missing := map[int]bool{}
		for _, id := range ids {
			missing[int(id)] = true
		}
		store := &fakeProfilesStore{peopleIDs: ids}
		w, _ := newProfilesWorker(&fakeProfilesAniList{missing: missing}, store)

		require.NoError(t, w.Work(context.Background(), profilesJob()))

		require.Len(t, store.peopleSaves, 1)
		assert.Empty(t, store.peopleSaves[0].rows)
		assert.Equal(t, ids, store.peopleSaves[0].absent)
		assert.Empty(t, store.peopleStamps)
	})
}

// TestProfiles_BusyBudgetYields — a no-wait request that keeps finding the
// bucket empty is retried profilesBusyRetries times, a gap apart, and then
// the pass ends with nothing written and nothing stamped: the batch heads
// the next pass.
func TestProfiles_BusyBudgetYields(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: idRange(1, 60), characterIDs: idRange(1001, 1010)}
	al := &fakeProfilesAniList{err: func(string, []int, int) error { return anilist.ErrBudgetBusy }}
	w, slept := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))

	assert.Len(t, al.calls, 1+profilesBusyRetries, "one batch, its retries, then the pass stops")
	assert.Len(t, *slept, 1+profilesBusyRetries)
	assert.Empty(t, store.peopleSaves)
	assert.Empty(t, store.peopleStamps, "busy says nothing about the ids")
	assert.Empty(t, store.characterStamps)
}

// TestProfiles_BusyThenFree — a busy answer followed by a free token is
// just a slower request.
func TestProfiles_BusyThenFree(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: idRange(1, 3)}
	al := &fakeProfilesAniList{err: func(_ string, _ []int, call int) error {
		if call <= 2 {
			return anilist.ErrBudgetBusy
		}
		return nil
	}}
	w, _ := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))
	assert.Equal(t, idRange(1, 3), savedPeopleIDs(store.peopleSaves))
}

// TestProfiles_RateLimitedEndsThePass — a 429 or an open breaker ends the
// pass at once, without a retry and without a stamp.
func TestProfiles_RateLimitedEndsThePass(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: idRange(1, 60), characterIDs: idRange(1001, 1010)}
	al := &fakeProfilesAniList{err: func(string, []int, int) error { return anilist.ErrRateLimited }}
	w, _ := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))
	assert.Len(t, al.calls, 1)
	assert.Empty(t, store.peopleStamps)
	assert.Empty(t, store.characterStamps)
}

// TestProfiles_FailureIsRetriedTomorrowAndEndsThePass — any other failure,
// upstream or in the database, stamps the batch back-dated so it is due
// again in a day rather than heading every pass, and ends the pass: an
// outage costs one stamped batch per pass, not every batch it could reach.
func TestProfiles_FailureIsRetriedTomorrowAndEndsThePass(t *testing.T) {
	for name, cause := range map[string]struct {
		upstream error
		store    error
	}{
		"upstream error": {upstream: &anilist.ErrUpstream{Status: http.StatusInternalServerError, Message: "AniList API error: 500"}},
		"database error": {store: errors.New("connection reset")},
	} {
		t.Run(name, func(t *testing.T) {
			store := &fakeProfilesStore{peopleIDs: idRange(1, 60), characterIDs: idRange(1001, 1010), saveErr: cause.store}
			al := &fakeProfilesAniList{err: func(string, []int, int) error { return cause.upstream }}
			w, _ := newProfilesWorker(al, store)

			require.NoError(t, w.Work(context.Background(), profilesJob()), "a batch's failure is never the job's")

			require.Len(t, store.peopleStamps, 1)
			stamp := store.peopleStamps[0]
			assert.False(t, stamp.absent, "a failed ask says nothing about AniList")
			assert.Equal(t, idRange(1, 50), stamp.ids)
			assert.Equal(t, profilesNow.Add(profilesRetryAfterFailure), stamp.at.Add(profilesStaleAfter),
				"due again after the retry delay, not after the re-check interval")
			assert.Len(t, al.calls, 1, "the pass ends at the failed batch")
			assert.Empty(t, store.characterStamps)
		})
	}
}

// TestProfiles_CancelledPassEndsUnstamped — the pass's context ending
// mid-pass (its deadline, or a shutdown) stamps nothing: like a busy
// budget, it says nothing about the ids.
func TestProfiles_CancelledPassEndsUnstamped(t *testing.T) {
	store := &fakeProfilesStore{peopleIDs: idRange(1, 60)}
	al := &fakeProfilesAniList{}
	w, _ := newProfilesWorker(al, store)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sleeps := 0
	w.sleep = func(c context.Context, _ time.Duration) error {
		sleeps++
		if sleeps > 1 {
			cancel()
			return c.Err()
		}
		return nil
	}

	require.NoError(t, w.Work(ctx, profilesJob()))
	assert.Len(t, al.calls, 1)
	assert.Len(t, store.peopleSaves, 1)
	assert.Empty(t, store.peopleStamps)
}

// TestProfiles_NothingDue is a pass with empty candidate lists.
func TestProfiles_NothingDue(t *testing.T) {
	store := &fakeProfilesStore{}
	al := &fakeProfilesAniList{}
	w, slept := newProfilesWorker(al, store)

	require.NoError(t, w.Work(context.Background(), profilesJob()))
	assert.Equal(t, []string{"people", "characters"}, store.listed)
	assert.Empty(t, al.calls)
	assert.Empty(t, *slept)
}

// TestProfiles_CandidateListErrorIsReturned — a pass that cannot see its
// work has not started; that, alone, is the job's error.
func TestProfiles_CandidateListErrorIsReturned(t *testing.T) {
	for name, store := range map[string]*fakeProfilesStore{
		"people":     {peopleListErr: errors.New("db down")},
		"characters": {charListErr: errors.New("db down")},
	} {
		t.Run(name, func(t *testing.T) {
			al := &fakeProfilesAniList{}
			w, _ := newProfilesWorker(al, store)
			assert.Error(t, w.Work(context.Background(), profilesJob()))
			assert.Empty(t, al.calls)
		})
	}
}

// TestProfilesArgs_RideTheOneSlotQueue — the sweep's pacing is only half
// the bound on its AniList use; the other half is that it never runs
// beside the credits, facts and ratings sweeps.  That holds because it
// rides the ratings queue and that queue has one fixed slot.  A second
// slot, or a queue of its own, would let two sweeps take turns on the
// limiter at once.
func TestProfilesArgs_RideTheOneSlotQueue(t *testing.T) {
	opts := ProfilesArgs{}.InsertOpts()
	assert.Equal(t, RatingsQueueName, opts.Queue)
	assert.True(t, opts.UniqueOpts.ByArgs, "one pass in flight at a time")
	assert.Equal(t, ratingsUniqueStates, opts.UniqueOpts.ByState)

	slots, ok := Default().Concurrency(RatingsQueueName)
	require.True(t, ok)
	assert.Equal(t, 1, slots.Max())
	assert.True(t, slots.Fixed())

	for _, kind := range []string{"anime_credits", "anime_facts", "anilist_ratings", "profiles"} {
		found := false
		for _, e := range Default().Entries() {
			if e.Kind() == kind {
				found = true
				assert.Equal(t, RatingsQueueName, e.Queue, kind)
			}
		}
		assert.True(t, found, kind)
	}
}

// TestProfiles_PacingFitsTheTimeout — the slowest pass that does not give
// up (every request finding the budget busy on all but its last attempt)
// must fit inside the job's timeout, or the timeout and not the design
// would decide how much a pass does.
func TestProfiles_PacingFitsTheTimeout(t *testing.T) {
	worst := time.Duration(profilesRequestsPerPass*(1+profilesBusyRetries)) * profilesRequestGap
	assert.Less(t, worst, profilesTimeout)
	assert.Less(t, profilesTimeout, profilesInterval, "passes must not be able to overlap")
	assert.LessOrEqual(t, profilesEmptyAnswerFloor, anilist.MaxProfileIDs)
}
