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
	"github.com/lawrenceli0228/animego/go-api/internal/credits"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type creditsStamp struct {
	id      int32
	at      time.Time
	hasMore *bool
}

type creditsReplace struct {
	cast    credits.Cast
	staff   []credits.Staff
	hasMore bool
	at      time.Time
}

type fakeCreditsStore struct {
	castIDs, staffIDs     []int32
	castLimit, staffLimit int32
	fullPage              int32
	staffListed           bool
	replaceErr            error

	castStamps, staffStamps []creditsStamp
	castWrites, staffWrites map[int32]creditsReplace
}

func newFakeCreditsStore() *fakeCreditsStore {
	return &fakeCreditsStore{castWrites: map[int32]creditsReplace{}, staffWrites: map[int32]creditsReplace{}}
}

func (f *fakeCreditsStore) ListAnimeCastCandidates(_ context.Context, _ pgtype.Interval, fullPage, limit int32) ([]int32, error) {
	f.fullPage, f.castLimit = fullPage, limit
	if int(limit) < len(f.castIDs) {
		return f.castIDs[:limit], nil
	}
	return f.castIDs, nil
}

func (f *fakeCreditsStore) ListAnimeStaffCandidates(_ context.Context, _ pgtype.Interval, _ int32, limit int32) ([]int32, error) {
	f.staffListed, f.staffLimit = true, limit
	if int(limit) < len(f.staffIDs) {
		return f.staffIDs[:limit], nil
	}
	return f.staffIDs, nil
}

func (f *fakeCreditsStore) StampAnimeCastChecked(_ context.Context, at pgtype.Timestamptz, hasMore *bool, id int32) error {
	f.castStamps = append(f.castStamps, creditsStamp{id: id, at: at.Time, hasMore: hasMore})
	return nil
}

func (f *fakeCreditsStore) StampAnimeStaffChecked(_ context.Context, at pgtype.Timestamptz, hasMore *bool, id int32) error {
	f.staffStamps = append(f.staffStamps, creditsStamp{id: id, at: at.Time, hasMore: hasMore})
	return nil
}

func (f *fakeCreditsStore) ReplaceCast(_ context.Context, id int32, cast credits.Cast, hasMore bool, at time.Time) error {
	if f.replaceErr != nil {
		return f.replaceErr
	}
	f.castWrites[id] = creditsReplace{cast: cast, hasMore: hasMore, at: at}
	return nil
}

func (f *fakeCreditsStore) ReplaceStaff(_ context.Context, id int32, staff []credits.Staff, hasMore bool, at time.Time) error {
	if f.replaceErr != nil {
		return f.replaceErr
	}
	f.staffWrites[id] = creditsReplace{staff: staff, hasMore: hasMore, at: at}
	return nil
}

// fakeCreditsAniList answers from per-title page lengths: a title with n
// characters gets pages of 25 with hasNextPage set the way AniList sets
// it.  err, when it returns non-nil for a call, wins.
type fakeCreditsAniList struct {
	castLen, staffLen map[int]int
	country           map[int]string
	err               func(kind string, v anilist.CreditPagesVars, call int) error
	calls             []string
}

func (f *fakeCreditsAniList) record(kind string, v anilist.CreditPagesVars) (int, error) {
	f.calls = append(f.calls, fmt.Sprintf("%s %d p%d-%d", kind, v.ID, v.FirstPage, v.LastPage))
	if f.err != nil {
		if err := f.err(kind, v, len(f.calls)); err != nil {
			return 0, err
		}
	}
	return len(f.calls), nil
}

// pageSpan returns, for page p of a list of n, how many entries it holds
// and whether a page follows.
func pageSpan(n, p int) (count int, more bool) {
	start := (p - 1) * anilist.CreditsPerPage
	if start >= n {
		return 0, false
	}
	count = min(anilist.CreditsPerPage, n-start)
	return count, start+count < n
}

func (f *fakeCreditsAniList) CharacterPagesNoWait(_ context.Context, v anilist.CreditPagesVars) (*anilist.CharacterPages, error) {
	if _, err := f.record("cast", v); err != nil {
		return nil, err
	}
	out := &anilist.CharacterPages{MediaID: v.ID}
	if c, ok := f.country[v.ID]; ok {
		out.CountryOfOrigin = &c
	}
	for p := v.FirstPage; p <= v.LastPage; p++ {
		count, more := pageSpan(f.castLen[v.ID], p)
		conn := anilist.CharacterConnection{PageInfo: &anilist.PageInfo{HasNextPage: more}}
		for i := 0; i < count; i++ {
			id := (p-1)*anilist.CreditsPerPage + i + 1
			lang := "Japanese"
			conn.Edges = append(conn.Edges, anilist.CharacterEdge{
				Node: anilist.CharacterNode{ID: id},
				VoiceActorRoles: []anilist.VoiceActorRole{
					{VoiceActor: &anilist.VoiceActor{ID: 1000 + id, LanguageV2: &lang}},
				},
			})
		}
		out.Pages = append(out.Pages, conn)
	}
	return out, nil
}

func (f *fakeCreditsAniList) StaffPagesNoWait(_ context.Context, v anilist.CreditPagesVars) (*anilist.StaffPages, error) {
	if _, err := f.record("staff", v); err != nil {
		return nil, err
	}
	out := &anilist.StaffPages{MediaID: v.ID}
	for p := v.FirstPage; p <= v.LastPage; p++ {
		count, more := pageSpan(f.staffLen[v.ID], p)
		conn := anilist.StaffConnection{PageInfo: &anilist.PageInfo{HasNextPage: more}}
		for i := 0; i < count; i++ {
			role := "Key Animation"
			conn.Edges = append(conn.Edges, anilist.StaffEdge{Role: &role, Node: anilist.StaffNode{ID: (p-1)*anilist.CreditsPerPage + i + 1}})
		}
		out.Pages = append(out.Pages, conn)
	}
	return out, nil
}

var creditsNow = time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

// newCreditsWorker wires the fakes with a frozen clock and a sleep that
// records instead of waiting.
func newCreditsWorker(al AniListCreditsFetcher, store *fakeCreditsStore) (*AnimeCreditsWorker, *[]time.Duration) {
	var slept []time.Duration
	w := NewAnimeCreditsWorker(al, store)
	w.now = func() time.Time { return creditsNow }
	w.sleep = func(_ context.Context, d time.Duration) error {
		slept = append(slept, d)
		return nil
	}
	return w, &slept
}

func creditsJob() *river.Job[AnimeCreditsArgs] { return &river.Job[AnimeCreditsArgs]{} }

func characterIDs(cast credits.Cast) []int32 {
	out := make([]int32, 0, len(cast.Characters))
	for _, c := range cast.Characters {
		out = append(out, *c.CharacterID)
	}
	return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestAnimeCredits_OneRequestCoversEightPages — a 100-character title is
// four pages; one request for pages 1-8 covers it, the empty pages past
// the end are ignored, and the whole list is written in AniList's order
// with page 1's answer about page 2 as has_more.
func TestAnimeCredits_OneRequestCoversEightPages(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{154587}
	al := &fakeCreditsAniList{castLen: map[int]int{154587: 100}}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	assert.Equal(t, []string{"cast 154587 p1-8"}, al.calls)
	got, ok := store.castWrites[154587]
	require.True(t, ok)
	require.Len(t, got.cast.Characters, 100)
	assert.Equal(t, int32(1), *got.cast.Characters[0].CharacterID)
	assert.Equal(t, int32(100), *got.cast.Characters[99].CharacterID)
	assert.Equal(t, int32(99), got.cast.Characters[99].DisplayOrder)
	assert.Len(t, got.cast.Voices, 100)
	assert.True(t, got.hasMore, "page 1 had a next page")
	assert.Equal(t, creditsNow, got.at)
	assert.Equal(t, int32(anilist.CreditsPerPage), store.fullPage)
	assert.Equal(t, int32(creditsCastPerPass), store.castLimit)
}

// TestAnimeCredits_SecondRequestWhenPageEightHasMore — 205 staff entries
// run past page 8, so pages 9-16 are fetched in a second request and the
// two are stitched in order.
func TestAnimeCredits_SecondRequestWhenPageEightHasMore(t *testing.T) {
	store := newFakeCreditsStore()
	store.staffIDs = []int32{7}
	al := &fakeCreditsAniList{staffLen: map[int]int{7: 205}}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	assert.Equal(t, []string{"staff 7 p1-8", "staff 7 p9-16"}, al.calls)
	got := store.staffWrites[7]
	require.Len(t, got.staff, 205)
	for i, s := range got.staff {
		assert.Equal(t, int32(i+1), *s.StaffID, "position %d", i)
	}
	assert.True(t, got.hasMore)
}

// TestAnimeCredits_HardCapIs400 — a list longer than sixteen pages is
// stored as its first 400, in two requests and no more.
func TestAnimeCredits_HardCapIs400(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{21}
	al := &fakeCreditsAniList{castLen: map[int]int{21: 1000}}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	assert.Equal(t, []string{"cast 21 p1-8", "cast 21 p9-16"}, al.calls)
	got := store.castWrites[21]
	require.Len(t, got.cast.Characters, 400)
	assert.Equal(t, int32(400), *got.cast.Characters[399].CharacterID)
}

// TestAnimeCredits_ShortListIsWrittenAsComplete — a title flagged by the
// "full first page" rule that turns out to have exactly 25 is written and
// recorded as having no more, so it leaves the candidate list for good.
func TestAnimeCredits_ShortListIsWrittenAsComplete(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{3}
	al := &fakeCreditsAniList{castLen: map[int]int{3: 25}}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	assert.Equal(t, []string{"cast 3 p1-8"}, al.calls)
	assert.Len(t, store.castWrites[3].cast.Characters, 25)
	assert.False(t, store.castWrites[3].hasMore)
}

// TestAnimeCredits_CountryPicksTheVoice — the country AniList sends with
// the pages reaches the voice choice: a Chinese title's row carries the
// Chinese voice.
func TestAnimeCredits_CountryPicksTheVoice(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{101972}
	al := &fakeCreditsAniList{castLen: map[int]int{101972: 1}, country: map[int]string{101972: "CN"}}
	// Swap in a two-language cast for the one character.
	w, _ := newCreditsWorker(&countryFetcher{fakeCreditsAniList: al}, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	got := store.castWrites[101972]
	require.Len(t, got.cast.Characters, 1)
	assert.Equal(t, int32(22), *got.cast.Characters[0].VoiceActorID, "the Chinese voice, though the Japanese one is listed first")
}

// countryFetcher answers one character voiced in Japanese (listed first)
// and Chinese.
type countryFetcher struct{ *fakeCreditsAniList }

func (f *countryFetcher) CharacterPagesNoWait(ctx context.Context, v anilist.CreditPagesVars) (*anilist.CharacterPages, error) {
	res, err := f.fakeCreditsAniList.CharacterPagesNoWait(ctx, v)
	if err != nil {
		return nil, err
	}
	ja, zh := "Japanese", "Chinese"
	res.Pages[0].Edges[0].VoiceActorRoles = []anilist.VoiceActorRole{
		{VoiceActor: &anilist.VoiceActor{ID: 21, LanguageV2: &ja}},
		{VoiceActor: &anilist.VoiceActor{ID: 22, LanguageV2: &zh}},
	}
	return res, nil
}

// TestAnimeCredits_StaffTakesTheSlotsCastLeaves — a pass is six titles;
// with one cast candidate, staff gets five.
func TestAnimeCredits_StaffTakesTheSlotsCastLeaves(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{1}
	store.staffIDs = []int32{11, 12, 13, 14, 15, 16, 17}
	al := &fakeCreditsAniList{castLen: map[int]int{1: 30}, staffLen: map[int]int{11: 30, 12: 30, 13: 30, 14: 30, 15: 30, 16: 30, 17: 30}}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	assert.Equal(t, int32(creditsTitlesPerPass-1), store.staffLimit)
	assert.Len(t, store.staffWrites, 5)
	assert.NotContains(t, store.staffWrites, int32(16))
}

// TestAnimeCredits_PacesEveryRequest — every request, the first included,
// is preceded by the gap, so the sweep never takes two tokens in a row.
func TestAnimeCredits_PacesEveryRequest(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{1, 2}
	store.staffIDs = []int32{3}
	al := &fakeCreditsAniList{castLen: map[int]int{1: 30, 2: 300}, staffLen: map[int]int{3: 30}}
	w, slept := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	require.Len(t, al.calls, 4, "1 + 2 (title 2 runs past page 8) + 1")
	assert.Equal(t, []time.Duration{creditsRequestGap, creditsRequestGap, creditsRequestGap, creditsRequestGap}, *slept)
}

// TestAnimeCredits_BusyBudgetYields — a no-wait request that keeps finding
// the bucket empty is retried creditsBusyRetries times, a gap apart, and
// then the pass ends with nothing written and nothing stamped: the title
// heads the next pass.
func TestAnimeCredits_BusyBudgetYields(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{1, 2}
	store.staffIDs = []int32{3}
	al := &fakeCreditsAniList{
		castLen: map[int]int{1: 30, 2: 30},
		err: func(string, anilist.CreditPagesVars, int) error {
			return anilist.ErrBudgetBusy
		},
	}
	w, slept := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	assert.Len(t, al.calls, 1+creditsBusyRetries, "one title, its retries, then the pass stops")
	assert.Len(t, *slept, 1+creditsBusyRetries)
	assert.Empty(t, store.castWrites)
	assert.Empty(t, store.castStamps, "busy says nothing about the title")
	assert.False(t, store.staffListed, "a pass that yielded does not start on staff")
}

// TestAnimeCredits_BusyThenFree — a busy answer followed by a free token
// is just a slower request.
func TestAnimeCredits_BusyThenFree(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{1}
	al := &fakeCreditsAniList{
		castLen: map[int]int{1: 30},
		err: func(_ string, _ anilist.CreditPagesVars, call int) error {
			if call <= 2 {
				return anilist.ErrBudgetBusy
			}
			return nil
		},
	}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))
	assert.Len(t, store.castWrites[1].cast.Characters, 30)
}

// TestAnimeCredits_RateLimitedEndsThePass — a 429 or an open breaker ends
// the pass at once, without a retry and without a stamp.
func TestAnimeCredits_RateLimitedEndsThePass(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{1, 2}
	al := &fakeCreditsAniList{err: func(string, anilist.CreditPagesVars, int) error { return anilist.ErrRateLimited }}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))
	assert.Len(t, al.calls, 1)
	assert.Empty(t, store.castStamps)
}

// TestAnimeCredits_AbsentTitleIsStampedAndThePassGoesOn — AniList not
// serving a title is an answer: stamped as read now (has_more left
// alone), and the next title is fetched.
func TestAnimeCredits_AbsentTitleIsStampedAndThePassGoesOn(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{1, 2}
	al := &fakeCreditsAniList{
		castLen: map[int]int{2: 30},
		err: func(_ string, v anilist.CreditPagesVars, _ int) error {
			if v.ID == 1 {
				return &anilist.ErrUpstream{Status: http.StatusNotFound, Message: "AniList returned no media"}
			}
			return nil
		},
	}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))

	require.Len(t, store.castStamps, 1)
	assert.Equal(t, creditsStamp{id: 1, at: creditsNow}, store.castStamps[0])
	assert.Contains(t, store.castWrites, int32(2))
}

// TestAnimeCredits_FailureIsRetriedTomorrowAndEndsThePass — any other
// failure is stamped back-dated so the title is due again in a day rather
// than heading every pass, and the pass ends.
func TestAnimeCredits_FailureIsRetriedTomorrowAndEndsThePass(t *testing.T) {
	for name, cause := range map[string]struct {
		upstream error
		store    error
	}{
		"upstream error": {upstream: &anilist.ErrUpstream{Status: http.StatusBadGateway, Message: "Max query complexity"}},
		"database error": {store: errors.New("connection reset")},
	} {
		t.Run(name, func(t *testing.T) {
			store := newFakeCreditsStore()
			store.castIDs = []int32{1, 2}
			store.replaceErr = cause.store
			al := &fakeCreditsAniList{
				castLen: map[int]int{1: 30, 2: 30},
				err:     func(string, anilist.CreditPagesVars, int) error { return cause.upstream },
			}
			w, _ := newCreditsWorker(al, store)

			require.NoError(t, w.Work(context.Background(), creditsJob()), "a title's failure is never the job's")

			require.Len(t, store.castStamps, 1)
			stamp := store.castStamps[0]
			assert.Equal(t, int32(1), stamp.id)
			assert.Nil(t, stamp.hasMore)
			due := stamp.at.Add(creditsStaleAfter)
			assert.Equal(t, creditsNow.Add(creditsRetryAfterFailure), due, "due again after the retry delay, not after the stale window")
			assert.Len(t, al.calls, 1, "the pass ends at the failed title")
			assert.False(t, store.staffListed)
		})
	}
}

// TestAnimeCredits_HalfAListIsNotWritten — when the second request of a
// long list fails, nothing is written: the stored rows are no worse than
// they were, and a truncated list must not replace them.
func TestAnimeCredits_HalfAListIsNotWritten(t *testing.T) {
	store := newFakeCreditsStore()
	store.castIDs = []int32{1}
	al := &fakeCreditsAniList{
		castLen: map[int]int{1: 300},
		err: func(_ string, v anilist.CreditPagesVars, _ int) error {
			if v.FirstPage > 1 {
				return anilist.ErrBudgetBusy
			}
			return nil
		},
	}
	w, _ := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))
	assert.Empty(t, store.castWrites)
	assert.Empty(t, store.castStamps)
}

// shortPagesFetcher drops pages from responses: all of them for the first
// request, or the tail of the second.
type shortPagesFetcher struct {
	*fakeCreditsAniList
	keep func(v anilist.CreditPagesVars) int
}

func (f *shortPagesFetcher) CharacterPagesNoWait(ctx context.Context, v anilist.CreditPagesVars) (*anilist.CharacterPages, error) {
	res, err := f.fakeCreditsAniList.CharacterPagesNoWait(ctx, v)
	if err != nil {
		return nil, err
	}
	res.Pages = res.Pages[:f.keep(v)]
	return res, nil
}

// TestAnimeCredits_ShortResponseIsAFailure — a response without one page
// per page asked for is never stitched into "the whole list": with no
// pages it would have nothing to read page 1's flag from, and with a
// truncated second request it would store 200 of a longer list and delete
// the rest.  It is a failure like any other: no write, back-dated stamp,
// pass over.
func TestAnimeCredits_ShortResponseIsAFailure(t *testing.T) {
	for name, keep := range map[string]func(anilist.CreditPagesVars) int{
		"no pages at all": func(anilist.CreditPagesVars) int { return 0 },
		"second request short": func(v anilist.CreditPagesVars) int {
			if v.FirstPage > 1 {
				return 3
			}
			return anilist.MaxCreditPagesPerRequest
		},
	} {
		t.Run(name, func(t *testing.T) {
			store := newFakeCreditsStore()
			store.castIDs = []int32{1, 2}
			al := &shortPagesFetcher{fakeCreditsAniList: &fakeCreditsAniList{castLen: map[int]int{1: 300, 2: 30}}, keep: keep}
			w, _ := newCreditsWorker(al, store)

			require.NotPanics(t, func() { require.NoError(t, w.Work(context.Background(), creditsJob())) })

			assert.Empty(t, store.castWrites)
			require.Len(t, store.castStamps, 1)
			assert.Equal(t, creditsNow.Add(creditsRetryAfterFailure-creditsStaleAfter), store.castStamps[0].at)
		})
	}
}

// TestAnimeCredits_NothingDue is a pass with empty candidate lists.
func TestAnimeCredits_NothingDue(t *testing.T) {
	store := newFakeCreditsStore()
	al := &fakeCreditsAniList{}
	w, slept := newCreditsWorker(al, store)

	require.NoError(t, w.Work(context.Background(), creditsJob()))
	assert.Empty(t, al.calls)
	assert.Empty(t, *slept)
	assert.Equal(t, int32(creditsTitlesPerPass), store.staffLimit)
}

// TestAnimeCredits_CandidateListErrorIsReturned — a pass that cannot see
// its work has not started; that, alone, is the job's error.
func TestAnimeCredits_CandidateListErrorIsReturned(t *testing.T) {
	w, _ := newCreditsWorker(&fakeCreditsAniList{}, nil)
	w.store = failingCandidates{}
	assert.Error(t, w.Work(context.Background(), creditsJob()))
}

type failingCandidates struct{ *fakeCreditsStore }

func (failingCandidates) ListAnimeCastCandidates(context.Context, pgtype.Interval, int32, int32) ([]int32, error) {
	return nil, errors.New("db down")
}

// TestAnimeCredits_PacingFitsTheTimeout — the worst pass that does not
// yield (every title needing two requests, the first attempt of each
// finding a token) must fit inside the job's timeout, or the timeout and
// not the design would decide how much a pass does.
func TestAnimeCredits_PacingFitsTheTimeout(t *testing.T) {
	worst := time.Duration(creditsTitlesPerPass*2) * creditsRequestGap
	assert.Less(t, worst, creditsTimeout)
	assert.Less(t, creditsTimeout, creditsInterval, "passes must not be able to overlap")
}
