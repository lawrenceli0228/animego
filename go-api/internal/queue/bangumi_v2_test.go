// bangumi_v2_test.go — unit tests for the Phase 2 Bangumi worker.
//
// No real Bangumi HTTP server, no real DB.  Each test wires a fake
// BangumiV2Client + V2DB and asserts:
//
//   - Subject + Characters fetched in parallel, results combined.
//   - ErrNotFound on subject → permanent skip (return nil, no writes).
//   - ErrNotFound on characters → still update subject (no char writes).
//   - Other errors → wrapped, surfaced for river retry.
//   - Nullable fields (Rating, NameCN, NameCN per char, Images, Actors)
//     all pass nil through to the SQL layer when upstream is missing.
//   - Per-char update errors below threshold → non-fatal completion.
//   - Per-char update errors at-or-above threshold → return error.
//
// In-package tests so we can inspect helpers and reuse the ptr[T]
// generic from bangumi_v1_test.go.
package queue

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeBangumiV2 is a programmable BangumiV2Client.  Each test wires
// subjectFn / charactersFn to control the upstream behaviour.  Calls
// are recorded so negative assertions stay precise.
type fakeBangumiV2 struct {
	mu sync.Mutex

	subjectFn    func(ctx context.Context, bgmID int) (*bangumi.Subject, error)
	charactersFn func(ctx context.Context, bgmID int) ([]bangumi.Character, error)
	episodesFn   func(ctx context.Context, bgmID int) (*bangumi.EpisodesResponse, error)

	subjectCalls    int
	charactersCalls int
	episodesCalls   int
	lastSubjectID   int
	lastCharsID     int
}

func (f *fakeBangumiV2) Subject(ctx context.Context, bgmID int) (*bangumi.Subject, error) {
	f.mu.Lock()
	f.subjectCalls++
	f.lastSubjectID = bgmID
	fn := f.subjectFn
	f.mu.Unlock()
	if fn == nil {
		return &bangumi.Subject{ID: bgmID}, nil
	}
	return fn(ctx, bgmID)
}

func (f *fakeBangumiV2) Characters(ctx context.Context, bgmID int) ([]bangumi.Character, error) {
	f.mu.Lock()
	f.charactersCalls++
	f.lastCharsID = bgmID
	fn := f.charactersFn
	f.mu.Unlock()
	if fn == nil {
		return nil, nil
	}
	return fn(ctx, bgmID)
}

func (f *fakeBangumiV2) Episodes(ctx context.Context, bgmID int) (*bangumi.EpisodesResponse, error) {
	f.mu.Lock()
	f.episodesCalls++
	fn := f.episodesFn
	f.mu.Unlock()
	if fn == nil {
		// Default: no episodes → worker writes nothing, existing tests
		// that don't exercise episode titles stay unaffected.
		return &bangumi.EpisodesResponse{}, nil
	}
	return fn(ctx, bgmID)
}

// v2UpdateCall snapshots one UpdateBangumiV2 invocation.
type v2UpdateCall struct {
	anilistID    int32
	bangumiScore *float64
	bangumiVotes *int32
	titleChinese *string
}

// v2CharCall snapshots one UpdateAnimeCharacterCN invocation.
type v2CharCall struct {
	animeID            int32
	nameEn             *string
	nameCN             *string
	voiceActorCN       *string
	voiceActorImageURL *string
}

// v2EpTitleCall snapshots one UpsertEpisodeTitleSourced invocation.
//
// source and bgmID are recorded because they are the two halves of the fix in
// 0030: the source is what makes the value's provenance survive the write, and
// the bgm id is the binding the query pins to.  A worker that stopped supplying
// either would keep passing every assertion about names.
type v2EpTitleCall struct {
	animeID int32
	episode int32
	nameCN  *string
	name    *string
	source  string
	bgmID   int32
}

// v2DescCnCall snapshots one UpdateDescriptionCn invocation.
type v2DescCnCall struct {
	anilistID     int32
	descriptionCn *string
	// bgmID pins the write to the binding the job fetched; the SQL uses it
	// so a rebind mid-job cannot file this synopsis against another show.
	bgmID *int32
}

// fakeV2DB is a programmable V2DB.  Hooks let each test inject an
// error for the retry/non-retry paths; call snapshots let assertions
// inspect what got written without smuggling globals.
// v2MarkUnreadableCall records one MarkBangumiSubjectUnreadable call.  The
// bgmID is recorded and asserted on because the real statement is pinned to
// it: a worker that passed the wrong id would file a not-found verdict
// against a binding nobody probed.
type v2MarkUnreadableCall struct {
	anilistID int32
	bgmID     int32
}

type fakeV2DB struct {
	mu sync.Mutex

	updateV2Fn       func(ctx context.Context, c v2UpdateCall) error
	updateCharFn     func(ctx context.Context, c v2CharCall) error
	upsertEpFn       func(ctx context.Context, c v2EpTitleCall) error
	updateDescCnFn   func(ctx context.Context, c v2DescCnCall) error
	markUnreadableFn func(ctx context.Context, c v2MarkUnreadableCall) (int64, error)

	updateV2Calls       []v2UpdateCall
	updateCharCalls     []v2CharCall
	upsertEpCalls       []v2EpTitleCall
	updateDescCnCalls   []v2DescCnCall
	markUnreadableCalls []v2MarkUnreadableCall
}

func (f *fakeV2DB) MarkBangumiSubjectUnreadable(ctx context.Context, anilistID int32, bgmID int32) (int64, error) {
	call := v2MarkUnreadableCall{anilistID: anilistID, bgmID: bgmID}
	f.mu.Lock()
	f.markUnreadableCalls = append(f.markUnreadableCalls, call)
	fn := f.markUnreadableFn
	f.mu.Unlock()
	// One row affected is the success shape; the real statement returns 0
	// when the binding moved between the fetch and the write.
	if fn == nil {
		return 1, nil
	}
	return fn(ctx, call)
}

func (f *fakeV2DB) snapshotMarkUnreadableCalls() []v2MarkUnreadableCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]v2MarkUnreadableCall, len(f.markUnreadableCalls))
	copy(dup, f.markUnreadableCalls)
	return dup
}

func (f *fakeV2DB) UpdateBangumiV2(ctx context.Context, anilistID int32, bangumiScore *float64, bangumiVotes *int32, titleChinese *string) error {
	call := v2UpdateCall{
		anilistID:    anilistID,
		bangumiScore: bangumiScore,
		bangumiVotes: bangumiVotes,
		titleChinese: titleChinese,
	}
	f.mu.Lock()
	f.updateV2Calls = append(f.updateV2Calls, call)
	fn := f.updateV2Fn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, call)
}

func (f *fakeV2DB) UpdateAnimeCharacterCN(ctx context.Context, animeID int32, nameEn *string, nameCN *string, voiceActorCN *string, voiceActorImageURL *string) error {
	call := v2CharCall{
		animeID:            animeID,
		nameEn:             nameEn,
		nameCN:             nameCN,
		voiceActorCN:       voiceActorCN,
		voiceActorImageURL: voiceActorImageURL,
	}
	f.mu.Lock()
	f.updateCharCalls = append(f.updateCharCalls, call)
	fn := f.updateCharFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, call)
}

func (f *fakeV2DB) UpsertEpisodeTitleSourced(ctx context.Context, arg dbgen.UpsertEpisodeTitleSourcedParams) (int64, error) {
	call := v2EpTitleCall{animeID: arg.AnimeID, episode: arg.Episode, nameCN: epStrPtr(arg.NameCn), name: epStrPtr(arg.Name), source: arg.Source, bgmID: arg.BgmID}
	f.mu.Lock()
	f.upsertEpCalls = append(f.upsertEpCalls, call)
	fn := f.upsertEpFn
	f.mu.Unlock()
	// 1 row affected is the success shape; the real query returns 0 when the
	// binding moved, which the worker counts as a failure.
	if fn == nil {
		return 1, nil
	}
	return 1, fn(ctx, call)
}

// epStrPtr turns the plain strings UpsertEpisodeTitleSourcedParams carries back
// into the nil-able form the recorded call shapes use, so assertions written
// against the pre-0029 signature keep meaning the same thing.
func epStrPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// UpdateDescriptionCn records the Chinese-description write.  Note the
// sqlc-generated argument order: (ctx, descriptionCn, anilistID).
func (f *fakeV2DB) UpdateDescriptionCn(ctx context.Context, descriptionCn *string, anilistID int32, bgmID *int32) error {
	call := v2DescCnCall{anilistID: anilistID, descriptionCn: descriptionCn, bgmID: bgmID}
	f.mu.Lock()
	f.updateDescCnCalls = append(f.updateDescCnCalls, call)
	fn := f.updateDescCnFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, call)
}

func (f *fakeV2DB) snapshotDescCnCalls() []v2DescCnCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]v2DescCnCall, len(f.updateDescCnCalls))
	copy(dup, f.updateDescCnCalls)
	return dup
}

func (f *fakeV2DB) snapshotEpTitleCalls() []v2EpTitleCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]v2EpTitleCall, len(f.upsertEpCalls))
	copy(dup, f.upsertEpCalls)
	return dup
}

func (f *fakeV2DB) snapshotV2Calls() []v2UpdateCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]v2UpdateCall, len(f.updateV2Calls))
	copy(dup, f.updateV2Calls)
	return dup
}

func (f *fakeV2DB) snapshotCharCalls() []v2CharCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]v2CharCall, len(f.updateCharCalls))
	copy(dup, f.updateCharCalls)
	return dup
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// runV2 constructs the worker + a stock job and dispatches via Work().
// Uses NoopEnqueuer{} so tests that don't care about the V3 chain
// don't have to wire one.  Tests that DO care about the chain should
// call runV2WithEnq instead.
func runV2(t *testing.T, b BangumiV2Client, d V2DB, anilistID, bgmID int) error {
	t.Helper()
	return runV2WithEnq(t, b, d, NoopEnqueuer{}, anilistID, bgmID)
}

// runV2WithEnq is the explicit-enqueuer variant used by chain tests.
// The V2 worker chain-enqueues a V3 job when this run's Subject did
// not supply a Chinese title; these tests capture and assert on what
// got enqueued.
func runV2WithEnq(t *testing.T, b BangumiV2Client, d V2DB, e Enqueuer, anilistID, bgmID int) error {
	t.Helper()
	w := NewBangumiV2Worker(b, d, e)
	return w.Work(context.Background(), &river.Job[BangumiV2Args]{
		Args: BangumiV2Args{AnilistID: anilistID, BgmID: bgmID},
	})
}

// fakeV2Enqueuer records EnqueueV3Many calls so chain tests can
// assert which {anilistId, bgmId} pairs were dispatched after a
// successful V2 update.  EnqueueV1Many and EnqueueV2Many are no-ops
// (V2 worker never calls those on itself) but must be implemented to
// satisfy Enqueuer.
type fakeV2Enqueuer struct {
	mu      sync.Mutex
	v3Fn    func(ctx context.Context, jobs []BangumiV3Args) error
	v3Calls [][]BangumiV3Args
}

func (f *fakeV2Enqueuer) EnqueueV1Many(_ context.Context, _ []int32) error { return nil }
func (f *fakeV2Enqueuer) EnqueueV2Many(_ context.Context, _ []BangumiV2Args) error {
	return nil
}

// EnqueueWarmSeasonNow — V2 worker never triggers warm-season jobs.
// No-op to satisfy the Enqueuer interface.
func (f *fakeV2Enqueuer) EnqueueWarmSeasonNow(_ context.Context, _ WarmSeasonArgs) error {
	return nil
}

// EnqueueHantBackfillNow is a no-op stub: nothing in this test
// touches the zh-Hant sweep, and reporting "inserted" would be a lie
// no assertion here is watching for.
func (f *fakeV2Enqueuer) EnqueueHantBackfillNow(_ context.Context) (bool, error) {
	return false, nil
}

// EnqueueDescriptionBackfillMany — V2 harvests description_cn inline from
// the Subject payload it already holds, so it never enqueues sweep jobs.
// No-op to satisfy the Enqueuer interface.
func (f *fakeV2Enqueuer) EnqueueDescriptionBackfillMany(_ context.Context, _ []DescriptionBackfillArgs) error {
	return nil
}

func (f *fakeV2Enqueuer) EnqueueDescriptionLlmBackfillMany(_ context.Context, _ []DescriptionLlmBackfillArgs) error {
	return nil
}

func (f *fakeV2Enqueuer) EnqueueV3Many(ctx context.Context, jobs []BangumiV3Args) error {
	dup := make([]BangumiV3Args, len(jobs))
	copy(dup, jobs)
	f.mu.Lock()
	f.v3Calls = append(f.v3Calls, dup)
	fn := f.v3Fn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, jobs)
}

func (f *fakeV2Enqueuer) snapshotV3Calls() [][]BangumiV3Args {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([][]BangumiV3Args, len(f.v3Calls))
	copy(dup, f.v3Calls)
	return dup
}

// makeSubject builds a Subject with optional rating + NameCN.  Saves
// boilerplate in tests that don't care about Tags / Images / etc.
func makeSubject(id int, nameCN string, score float64, votes int) *bangumi.Subject {
	s := &bangumi.Subject{ID: id, NameCN: nameCN}
	if score > 0 || votes > 0 {
		s.Rating = &struct {
			Score float64 `json:"score"`
			Count int     `json:"total"`
		}{Score: score, Count: votes}
	}
	return s
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestBangumiV2_HappyPath_FullUpdate — subject + 2 chars → 1
// UpdateBangumiV2 + 2 UpdateAnimeCharacterCN calls, all args correct.
func TestBangumiV2_HappyPath_FullUpdate(t *testing.T) {
	t.Parallel()

	chars := []bangumi.Character{
		{
			Name:   "Naruto Uzumaki",
			NameCN: "漩涡鸣人",
			Images: &struct {
				Medium string `json:"medium"`
			}{Medium: "https://example.com/naruto.jpg"},
			Actors: []struct {
				ID     int    `json:"id"`
				Name   string `json:"name"`
				NameCN string `json:"name_cn"`
			}{
				{ID: 1, Name: "Junko Takeuchi", NameCN: "竹内顺子"},
			},
		},
		{
			Name:   "Sasuke Uchiha",
			NameCN: "宇智波佐助",
			Actors: []struct {
				ID     int    `json:"id"`
				Name   string `json:"name"`
				NameCN string `json:"name_cn"`
			}{
				{ID: 2, Name: "Noriaki Sugiyama", NameCN: "杉山纪彰"},
			},
		},
	}

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, bgmID int) (*bangumi.Subject, error) {
			require.Equal(t, 9999, bgmID)
			return makeSubject(9999, "火影忍者", 8.7, 5000), nil
		},
		charactersFn: func(_ context.Context, bgmID int) ([]bangumi.Character, error) {
			require.Equal(t, 9999, bgmID)
			return chars, nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1234, 9999)
	require.NoError(t, err)

	v2Calls := db.snapshotV2Calls()
	require.Len(t, v2Calls, 1, "exactly one UpdateBangumiV2 call expected")
	assert.Equal(t, int32(1234), v2Calls[0].anilistID)
	require.NotNil(t, v2Calls[0].bangumiScore)
	assert.InDelta(t, 8.7, *v2Calls[0].bangumiScore, 1e-9)
	require.NotNil(t, v2Calls[0].bangumiVotes)
	assert.Equal(t, int32(5000), *v2Calls[0].bangumiVotes)
	require.NotNil(t, v2Calls[0].titleChinese)
	assert.Equal(t, "火影忍者", *v2Calls[0].titleChinese)

	charCalls := db.snapshotCharCalls()
	require.Len(t, charCalls, 2, "two character UPDATEs expected")

	// First char.
	assert.Equal(t, int32(1234), charCalls[0].animeID)
	require.NotNil(t, charCalls[0].nameEn)
	assert.Equal(t, "Naruto Uzumaki", *charCalls[0].nameEn)
	require.NotNil(t, charCalls[0].nameCN)
	assert.Equal(t, "漩涡鸣人", *charCalls[0].nameCN)
	require.NotNil(t, charCalls[0].voiceActorCN)
	assert.Equal(t, "竹内顺子", *charCalls[0].voiceActorCN)
	require.NotNil(t, charCalls[0].voiceActorImageURL)
	assert.Equal(t, "https://example.com/naruto.jpg", *charCalls[0].voiceActorImageURL)

	// Second char (no image → voiceActorImageURL nil).
	assert.Equal(t, int32(1234), charCalls[1].animeID)
	require.NotNil(t, charCalls[1].nameEn)
	assert.Equal(t, "Sasuke Uchiha", *charCalls[1].nameEn)
	require.NotNil(t, charCalls[1].voiceActorCN)
	assert.Equal(t, "杉山纪彰", *charCalls[1].voiceActorCN)
	assert.Nil(t, charCalls[1].voiceActorImageURL, "no Images.Medium → nil")
}

// notFoundSubject builds the upstream shape an R18 binding actually produces:
// the subject endpoint refuses, and so do its two siblings, because the gate
// is on the subject and not on the sub-resources.  Using the real shape
// matters — a fixture where only the subject 404s would let an implementation
// that marks on ANY not-found pass.
func notFoundSubject() *fakeBangumiV2 {
	return &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, bangumi.ErrNotFound
		},
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return nil, bangumi.ErrNotFound
		},
		episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
			return nil, bangumi.ErrNotFound
		},
	}
}

// TestBangumiV2_SubjectNotFound_MarksRowTerminal — Subject 404 is permanent,
// and permanent has to be WRITTEN somewhere.
//
// The old contract here was "return nil, no DB writes", and it read as
// correct: retrying an anonymous request against a subject Bangumi hides
// from anonymous requests cannot succeed, so skipping is right.  What it
// missed is that skipping without a write leaves the row at
// bangumi_version = 1, and 1 is selected for by no producer in the system —
// the orphan scan takes 0, heal-CN takes 2.  The row becomes unreachable
// and stays counted as outstanding, which is how 811 of them accumulated.
//
// So the assertion this test exists for is not "does it return nil" but
// "does the row leave version 1", and the only evidence of that available at
// this layer is the mark call, pinned to the binding it was fetched under.
func TestBangumiV2_SubjectNotFound_MarksRowTerminal(t *testing.T) {
	t.Parallel()

	db := &fakeV2DB{}

	err := runV2(t, notFoundSubject(), db, 1, 100)
	require.NoError(t, err, "ErrNotFound subject is permanent — must not retry")

	marks := db.snapshotMarkUnreadableCalls()
	require.Len(t, marks, 1, "subject 404 must move the row out of version 1, not just skip it")
	assert.Equal(t, int32(1), marks[0].anilistID)
	assert.Equal(t, int32(100), marks[0].bgmID,
		"the verdict is about one subject id; passing another would file it against a binding nobody probed")

	assert.Empty(t, db.snapshotV2Calls(), "subject 404 → no UpdateBangumiV2")
	assert.Empty(t, db.snapshotCharCalls(), "subject 404 → no char UPDATEs")
	assert.Empty(t, db.snapshotEpTitleCalls(), "subject 404 → no episode title writes")
	assert.Empty(t, db.snapshotDescCnCalls(), "subject 404 → no synopsis write")
}

// TestBangumiV2_SubjectNotFound_MarkFailureRetries — a DB error on the mark
// must surface so river brings the job back.
//
// Returning nil here would be the same defect the mark exists to fix, just
// reached through a different door: the 404 is permanent, but a failed write
// about it is not, and swallowing one strands the row exactly as before.
func TestBangumiV2_SubjectNotFound_MarkFailureRetries(t *testing.T) {
	t.Parallel()

	db := &fakeV2DB{
		markUnreadableFn: func(_ context.Context, _ v2MarkUnreadableCall) (int64, error) {
			return 0, errors.New("connection reset")
		},
	}

	err := runV2(t, notFoundSubject(), db, 2, 200)
	require.Error(t, err, "a failed terminal write must retry, or the row is stranded again")
	assert.Contains(t, err.Error(), "mark unreadable")
	assert.Contains(t, err.Error(), "connection reset", "the cause must survive the wrap")
}

// TestBangumiV2_SubjectNotFound_RebindAffectsNoRows — zero rows affected is
// not an error.
//
// The statement is pinned to the binding, so zero means the row was rebound
// between the fetch and the write and this verdict is about a subject the
// row no longer holds.  Refusing it is the statement working; whoever moved
// the binding owns enqueueing the new one's V2, so the job is done.
func TestBangumiV2_SubjectNotFound_RebindAffectsNoRows(t *testing.T) {
	t.Parallel()

	db := &fakeV2DB{
		markUnreadableFn: func(_ context.Context, _ v2MarkUnreadableCall) (int64, error) {
			return 0, nil
		},
	}

	err := runV2(t, notFoundSubject(), db, 3, 300)
	require.NoError(t, err, "a moved binding is a completed job, not a failed one")
	assert.Len(t, db.snapshotMarkUnreadableCalls(), 1)
	assert.Empty(t, db.snapshotV2Calls(), "still no V2 write — the subject was never read")
}

// TestBangumiV2_CharactersNotFound_ContinuesWithSubject — characters
// 404 is benign; the subject-only write still happens.
func TestBangumiV2_CharactersNotFound_ContinuesWithSubject(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "测试", 7.5, 200), nil
		},
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return nil, bangumi.ErrNotFound
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 7, 100)
	require.NoError(t, err)

	v2Calls := db.snapshotV2Calls()
	require.Len(t, v2Calls, 1, "subject-only update should still happen")
	require.NotNil(t, v2Calls[0].bangumiScore)
	assert.InDelta(t, 7.5, *v2Calls[0].bangumiScore, 1e-9)

	assert.Empty(t, db.snapshotCharCalls(), "characters 404 → no char UPDATEs")
	assert.Empty(t, db.snapshotMarkUnreadableCalls(),
		"the gate is on the subject: a readable subject with no character rows is a normal row, not an unreadable binding")
}

// TestBangumiV2_SubjectError_RetriesUp — non-NotFound subject errors
// must surface so river retries the whole job.
func TestBangumiV2_SubjectError_RetriesUp(t *testing.T) {
	t.Parallel()

	upstream := &bangumi.ErrUpstream{Status: 503, Message: "Bangumi API error"}
	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, upstream
		},
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return nil, nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.Error(t, err, "subject 503 must surface")
	assert.ErrorIs(t, err, upstream)
	assert.Empty(t, db.snapshotV2Calls(), "subject failure → no DB write")
}

// TestBangumiV2_CharactersError_RetriesUp — non-NotFound characters
// errors must surface so river retries (no half-update of the row).
func TestBangumiV2_CharactersError_RetriesUp(t *testing.T) {
	t.Parallel()

	upstream := &bangumi.ErrUpstream{Status: 500, Message: "Bangumi API error"}
	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "标题", 8.0, 100), nil
		},
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return nil, upstream
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.Error(t, err, "characters 500 must surface")
	assert.ErrorIs(t, err, upstream)
	assert.Empty(t, db.snapshotV2Calls(),
		"characters transport failure → don't half-update the row")
}

// TestBangumiV2_RatingNil_PassesNilScore — when subject.Rating is nil
// the worker must pass nil for both score and votes.
func TestBangumiV2_RatingNil_PassesNilScore(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			// No Rating field populated.
			return &bangumi.Subject{ID: 100, NameCN: "标题"}, nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.NoError(t, err)

	v2Calls := db.snapshotV2Calls()
	require.Len(t, v2Calls, 1)
	assert.Nil(t, v2Calls[0].bangumiScore, "Rating=nil → nil score")
	assert.Nil(t, v2Calls[0].bangumiVotes, "Rating=nil → nil votes")
	require.NotNil(t, v2Calls[0].titleChinese, "NameCN populated → titleChinese set")
	assert.Equal(t, "标题", *v2Calls[0].titleChinese)
}

// TestBangumiV2_NameCNEmpty_PassesNilTitleChinese — when subject.NameCN
// is "" the SQL must receive nil so COALESCE leaves the column alone.
func TestBangumiV2_NameCNEmpty_PassesNilTitleChinese(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "", 8.0, 100), nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.NoError(t, err)

	v2Calls := db.snapshotV2Calls()
	require.Len(t, v2Calls, 1)
	assert.Nil(t, v2Calls[0].titleChinese,
		"empty NameCN → nil titleChinese (let COALESCE preserve existing)")
}

// TestBangumiV2_CharacterNameCNEmpty_PassesNilNameCN — character
// NameCN="" must pass nil to the SQL.
func TestBangumiV2_CharacterNameCNEmpty_PassesNilNameCN(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return []bangumi.Character{
				{Name: "Some Char", NameCN: ""},
			}, nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.NoError(t, err)

	charCalls := db.snapshotCharCalls()
	require.Len(t, charCalls, 1)
	require.NotNil(t, charCalls[0].nameEn)
	assert.Equal(t, "Some Char", *charCalls[0].nameEn)
	assert.Nil(t, charCalls[0].nameCN, "empty NameCN → nil")
}

// TestBangumiV2_ActorMissing_PassesNilVoiceActorCN — char with no
// Actors → voiceActorCN nil.
func TestBangumiV2_ActorMissing_PassesNilVoiceActorCN(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return []bangumi.Character{
				{Name: "No Voice", NameCN: "无声", Actors: nil},
			}, nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.NoError(t, err)

	charCalls := db.snapshotCharCalls()
	require.Len(t, charCalls, 1)
	assert.Nil(t, charCalls[0].voiceActorCN, "no Actors → nil voiceActorCN")
}

// TestBangumiV2_ImageMissing_PassesNilImage — char.Images nil → image
// param nil.
func TestBangumiV2_ImageMissing_PassesNilImage(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return []bangumi.Character{
				{Name: "No Image", NameCN: "无图", Images: nil},
			}, nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.NoError(t, err)

	charCalls := db.snapshotCharCalls()
	require.Len(t, charCalls, 1)
	assert.Nil(t, charCalls[0].voiceActorImageURL, "Images=nil → nil")
}

// TestBangumiV2_DBUpdateError_NonFatal — one char UPDATE errors but
// the rest succeed.  Worker returns nil (best-effort partial success).
func TestBangumiV2_DBUpdateError_NonFatal(t *testing.T) {
	t.Parallel()

	chars := make([]bangumi.Character, 4)
	for i := range chars {
		chars[i] = bangumi.Character{
			Name:   fmt.Sprintf("Char%d", i),
			NameCN: "CN",
		}
	}

	b := &fakeBangumiV2{
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return chars, nil
		},
	}

	failOnce := errors.New("transient")
	calls := 0
	db := &fakeV2DB{
		updateCharFn: func(_ context.Context, _ v2CharCall) error {
			calls++
			if calls == 1 {
				return failOnce
			}
			return nil
		},
	}

	err := runV2(t, b, db, 1, 100)
	require.NoError(t, err, "1/4 failures = 25% — below threshold, worker returns nil")
	assert.Len(t, db.snapshotCharCalls(), 4, "all 4 char UPDATEs attempted")
}

// TestBangumiV2_AllCharsErrored_Retries — half-or-more chars fail →
// return error so river retries.
func TestBangumiV2_AllCharsErrored_Retries(t *testing.T) {
	t.Parallel()

	chars := make([]bangumi.Character, 4)
	for i := range chars {
		chars[i] = bangumi.Character{Name: fmt.Sprintf("Char%d", i)}
	}

	b := &fakeBangumiV2{
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return chars, nil
		},
	}
	db := &fakeV2DB{
		updateCharFn: func(_ context.Context, _ v2CharCall) error {
			return errors.New("db wedged")
		},
	}

	err := runV2(t, b, db, 1, 100)
	require.Error(t, err, "all chars failed → retry the whole job")
	assert.Contains(t, err.Error(), "too many char failures")
	assert.Len(t, db.snapshotCharCalls(), 4,
		"all 4 char UPDATEs attempted even though they all error")
}

// TestBangumiV2_ZeroCharacters_StillUpdatesSubject — empty characters
// slice still triggers UpdateBangumiV2 (subject side), no char calls.
func TestBangumiV2_ZeroCharacters_StillUpdatesSubject(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "标题", 7.0, 50), nil
		},
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return []bangumi.Character{}, nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.NoError(t, err)

	v2Calls := db.snapshotV2Calls()
	require.Len(t, v2Calls, 1)
	assert.Empty(t, db.snapshotCharCalls(), "no chars → no char UPDATEs")
}

// TestBangumiV2_DBSubjectUpdateError_Surfaces — UpdateBangumiV2 errors
// must surface so river retries (don't silently drop enrichment).
func TestBangumiV2_DBSubjectUpdateError_Surfaces(t *testing.T) {
	t.Parallel()

	dbErr := errors.New("write conflict")
	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "标题", 8.0, 100), nil
		},
	}
	db := &fakeV2DB{
		updateV2Fn: func(_ context.Context, _ v2UpdateCall) error {
			return dbErr
		},
	}

	err := runV2(t, b, db, 1, 100)
	require.Error(t, err, "UpdateBangumiV2 failure must surface")
	assert.ErrorIs(t, err, dbErr)
	assert.Empty(t, db.snapshotCharCalls(),
		"subject update failed → char UPDATEs must NOT proceed")
}

// TestBangumiV2_ParallelFetch_BothCalled — under the happy path both
// Bangumi endpoints get hit exactly once.
func TestBangumiV2_ParallelFetch_BothCalled(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "X", 7, 10), nil
		},
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return nil, nil
		},
	}
	db := &fakeV2DB{}

	require.NoError(t, runV2(t, b, db, 1, 100))
	assert.Equal(t, 1, b.subjectCalls, "Subject called exactly once")
	assert.Equal(t, 1, b.charactersCalls, "Characters called exactly once")
	assert.Equal(t, 100, b.lastSubjectID, "bgmId propagated to Subject")
	assert.Equal(t, 100, b.lastCharsID, "bgmId propagated to Characters")
}

// TestBangumiV2_NoSubjectNameCN_ChainsV3 — V2 happy path with
// Subject.NameCN="" → fakeEnq.EnqueueV3Many called exactly once with
// the right {anilistId, bgmId} pair.
func TestBangumiV2_NoSubjectNameCN_ChainsV3(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			// Subject has score but no name_cn — V2's COALESCE leaves
			// title_chinese untouched, so chain V3 to retry.
			return makeSubject(100, "", 8.0, 100), nil
		},
	}
	db := &fakeV2DB{}
	enq := &fakeV2Enqueuer{}

	err := runV2WithEnq(t, b, db, enq, 1234, 9999)
	require.NoError(t, err)

	v3Calls := enq.snapshotV3Calls()
	require.Len(t, v3Calls, 1, "exactly one V3 chain batch expected")
	require.Len(t, v3Calls[0], 1, "batch should carry one V3 job")
	assert.Equal(t, 1234, v3Calls[0][0].AnilistID, "AnilistID propagates to V3")
	assert.Equal(t, 9999, v3Calls[0][0].BgmID, "BgmID propagates to V3")
}

// TestBangumiV2_SubjectHasNameCN_NoV3Chain — V2 happy path with
// Subject.NameCN populated → V3 NOT chained (the title_chinese was
// already supplied this run).
func TestBangumiV2_SubjectHasNameCN_NoV3Chain(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "标题", 8.0, 100), nil
		},
	}
	db := &fakeV2DB{}
	enq := &fakeV2Enqueuer{}

	err := runV2WithEnq(t, b, db, enq, 1234, 9999)
	require.NoError(t, err)

	assert.Empty(t, enq.snapshotV3Calls(),
		"Subject.NameCN populated → V3 must NOT be chained")
}

// TestBangumiV2_V3ChainError_NonFatal — Enqueuer.EnqueueV3Many returns
// error → V2 worker still returns nil (V2 already succeeded, chain
// failure is logged + swallowed).
func TestBangumiV2_V3ChainError_NonFatal(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "", 8.0, 100), nil
		},
	}
	db := &fakeV2DB{}
	enq := &fakeV2Enqueuer{
		v3Fn: func(_ context.Context, _ []BangumiV3Args) error {
			return errors.New("river client unavailable")
		},
	}

	err := runV2WithEnq(t, b, db, enq, 1234, 9999)
	require.NoError(t, err, "V3 chain enqueue failure must NOT bubble up — V2 already succeeded")

	// V3 was attempted exactly once even though it errored.
	assert.Len(t, enq.snapshotV3Calls(), 1)
}

// TestBangumiV2_NilEnqueuer_DoesNotPanic — nil Enqueuer is replaced
// by NoopEnqueuer{} inside the constructor.  Confirms the V3 chain
// path is safe with a nil enqueuer (the chain just no-ops).
func TestBangumiV2_NilEnqueuer_DoesNotPanic(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return makeSubject(100, "", 8.0, 100), nil
		},
	}
	db := &fakeV2DB{}

	require.NotPanics(t, func() {
		w := NewBangumiV2Worker(b, db, nil)
		require.NotNil(t, w)
		err := w.Work(context.Background(), &river.Job[BangumiV2Args]{
			Args: BangumiV2Args{AnilistID: 1, BgmID: 100},
		})
		require.NoError(t, err)
	})
}

// ---------------------------------------------------------------------------
// Compile-time guards: production types must satisfy the interfaces.
// ---------------------------------------------------------------------------

// dbgen.Querier must satisfy V2DB so main.go can pass *Queries directly.
var _ V2DB = (dbgen.Querier)(nil)

// *bangumi.Client must satisfy BangumiV2Client.
var _ BangumiV2Client = (*bangumi.Client)(nil)

// ---------------------------------------------------------------------------
// Episode titles (Express Phase-4 parity)
// ---------------------------------------------------------------------------

func TestNormalizeEpisodeTitles_FiltersAndNulls(t *testing.T) {
	got := normalizeEpisodeTitles([]bangumi.Episode{
		{Sort: 1, Type: 0, Name: "Asteroid Blues", NameCN: "小行星浪人"},
		{Sort: 2, Type: 0, Name: "Stray Dog Strut", NameCN: ""}, // empty CN → nil
		{Sort: 0, Type: 0, Name: "drop: sort 0"},                // sort<=0 dropped
		{Sort: 1, Type: 1, Name: "drop: SP"},                    // type!=0 dropped
	})
	if len(got) != 2 {
		t.Fatalf("want 2 main episodes, got %d: %+v", len(got), got)
	}
	if got[0].episode != 1 || got[0].name == nil || *got[0].name != "Asteroid Blues" ||
		got[0].nameCN == nil || *got[0].nameCN != "小行星浪人" {
		t.Fatalf("ep1 wrong: %+v", got[0])
	}
	if got[1].episode != 2 || got[1].nameCN != nil {
		t.Fatalf("ep2 wrong (empty NameCN should be nil): %+v", got[1])
	}
}

func TestNormalizeEpisodeTitles_SequelOffset(t *testing.T) {
	// A sequel whose eps start at sort 29 (S1 had 28) maps to 1..N.
	got := normalizeEpisodeTitles([]bangumi.Episode{
		{Sort: 30, Type: 0, Name: "S2E2"},
		{Sort: 29, Type: 0, Name: "S2E1"}, // out of order on purpose
	})
	if len(got) != 2 || got[0].episode != 1 || got[1].episode != 2 {
		t.Fatalf("sequel offset not normalized to 1-based: %+v", got)
	}
}

func TestBangumiV2_WritesEpisodeTitles(t *testing.T) {
	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			return makeSubject(id, "中文名", 80, 100), nil
		},
		episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
			return &bangumi.EpisodesResponse{Eps: []bangumi.Episode{
				{Sort: 1, Type: 0, Name: "E1", NameCN: "第一集"},
				{Sort: 2, Type: 0, Name: "E2", NameCN: "第二集"},
			}}, nil
		},
	}
	d := &fakeV2DB{}
	if err := runV2(t, b, d, 100, 555); err != nil {
		t.Fatalf("Work: %v", err)
	}
	eps := d.snapshotEpTitleCalls()
	if len(eps) != 2 {
		t.Fatalf("want 2 episode-title writes, got %d", len(eps))
	}
	if eps[0].animeID != 100 || eps[0].episode != 1 ||
		eps[0].nameCN == nil || *eps[0].nameCN != "第一集" {
		t.Fatalf("episode write wrong: %+v", eps[0])
	}
}

func TestBangumiV2_EpisodesNotFound_DoesNotFail(t *testing.T) {
	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			return makeSubject(id, "中文名", 80, 100), nil
		},
		episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
			return nil, bangumi.ErrNotFound
		},
	}
	d := &fakeV2DB{}
	if err := runV2(t, b, d, 100, 555); err != nil {
		t.Fatalf("episodes ErrNotFound must be tolerated, got: %v", err)
	}
	if n := len(d.snapshotEpTitleCalls()); n != 0 {
		t.Fatalf("no episode writes expected on not-found, got %d", n)
	}
	if n := len(d.snapshotMarkUnreadableCalls()); n != 0 {
		t.Fatalf("episodes 404 says nothing about whether the subject is readable — it was read; got %d marks", n)
	}
}

// ---------------------------------------------------------------------------
// description_cn — the Chinese-synopsis channel
//
// Shared with bangumi_v3_test.go (same package): both workers hold a Subject
// at the point they call persistDescriptionCn, so both get the same fixtures.
// ---------------------------------------------------------------------------

// testSummaryChinese is a usable Chinese synopsis — comfortably past the
// 40-rune floor, zero kana.
const testSummaryChinese = "漩涡鸣人是木叶隐村的忍者，体内封印着九尾妖狐。他自幼遭到村民疏远，却怀抱着成为火影、让所有人认可自己的梦想，与同伴一同踏上修行与战斗的旅程。"

// testSummaryJapanese is the untranslated original — the shape roughly 37%
// of prod summaries take, because the Chinese one has not been written yet.
// Kana dominate its CJK content, so CleanSummary rejects it and the page
// keeps falling back to the English description.
const testSummaryJapanese = "うずまきナルトは、木ノ葉隠れの里に住むはみだし者の忍者である。体内に九尾の妖狐を封印されているため里の人々から疎まれてきたが、火影になることを夢見て、仲間とともに修行と戦いの日々を送っていく。"

// TestBangumiV2_ChineseSummary_WritesDescriptionCn — a usable Chinese
// summary is cleaned and handed to UpdateDescriptionCn, and doing so costs
// no additional upstream request.
func TestBangumiV2_ChineseSummary_WritesDescriptionCn(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			s := makeSubject(id, "火影忍者", 8.7, 5000)
			s.Summary = testSummaryChinese
			return s, nil
		},
	}
	db := &fakeV2DB{}

	require.NoError(t, runV2(t, b, db, 1234, 9999))

	calls := db.snapshotDescCnCalls()
	require.Len(t, calls, 1, "usable Chinese summary → exactly one UpdateDescriptionCn")
	assert.Equal(t, int32(1234), calls[0].anilistID)
	require.NotNil(t, calls[0].descriptionCn)
	assert.Equal(t, testSummaryChinese, *calls[0].descriptionCn)

	// The write is pinned to the binding this job fetched.  The SQL matches
	// on bgm_id as well as anilist_id, so a rebind landing mid-job cannot
	// file this synopsis against a different show; drop the argument and
	// that guard silently stops applying.
	require.NotNil(t, calls[0].bgmID, "bgmID must be sent so the SQL can pin the binding")
	assert.Equal(t, int32(9999), *calls[0].bgmID)

	// The premise of the whole channel: Summary arrives inside the Subject
	// body the worker already fetched for score / votes / name_cn.  If this
	// ever needs a second fetch, the design has been broken.
	assert.Equal(t, 1, b.subjectCalls, "description_cn must cost zero extra Subject fetches")
}

// TestBangumiV2_SummaryWithDivider_StoresChineseHalfOnly — shape 2 from
// bangumi/summary.go: Chinese prose, "[简介原文]" divider, Japanese original.
// Only the Chinese half may be stored.
func TestBangumiV2_SummaryWithDivider_StoresChineseHalfOnly(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			s := makeSubject(id, "火影忍者", 8.7, 5000)
			s.Summary = testSummaryChinese + "\n\n[简介原文]\n" + testSummaryJapanese
			return s, nil
		},
	}
	db := &fakeV2DB{}

	require.NoError(t, runV2(t, b, db, 1234, 9999))

	calls := db.snapshotDescCnCalls()
	require.Len(t, calls, 1)
	require.NotNil(t, calls[0].descriptionCn)
	assert.Equal(t, testSummaryChinese, *calls[0].descriptionCn,
		"everything from the divider on must be dropped")
}

// TestBangumiV2_UnusableSummary_SkipsDescriptionCn — the NORMAL rejection
// path.  Japanese-only / empty / too-short summaries write nothing at all
// and the job still succeeds; the primary V2 columns are untouched by the
// decision either way.
func TestBangumiV2_UnusableSummary_SkipsDescriptionCn(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		summary string
	}{
		{"japanese original", testSummaryJapanese},
		{"empty", ""},
		{"too short placeholder", "待补充"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			b := &fakeBangumiV2{
				subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
					s := makeSubject(id, "火影忍者", 8.7, 5000)
					s.Summary = tc.summary
					return s, nil
				},
			}
			db := &fakeV2DB{}

			require.NoError(t, runV2(t, b, db, 1234, 9999),
				"an unusable summary is a normal outcome, never a job failure")
			assert.Empty(t, db.snapshotDescCnCalls(),
				"rejected summary must never reach the DB")
			assert.Len(t, db.snapshotV2Calls(), 1,
				"score / votes / title_chinese still written as before")
		})
	}
}

// TestBangumiV2_DescriptionCnWriteError_DoesNotFailJob — description_cn is
// a bonus on top of V2's real job, so a failed write is logged and
// swallowed rather than re-running writes that already committed.
func TestBangumiV2_DescriptionCnWriteError_DoesNotFailJob(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			s := makeSubject(id, "火影忍者", 8.7, 5000)
			s.Summary = testSummaryChinese
			return s, nil
		},
	}
	db := &fakeV2DB{
		updateDescCnFn: func(_ context.Context, _ v2DescCnCall) error {
			return errors.New("description_cn write blew up")
		},
	}

	require.NoError(t, runV2(t, b, db, 1234, 9999),
		"a description_cn write failure must not fail the job")
	assert.Len(t, db.snapshotV2Calls(), 1, "the primary V2 write still stands")
}

// TestBangumiV2_DescriptionCnWrittenBeforeCharFailureRetry pins the position
// of the description write: it happens right after the subject write, ahead
// of per-character enrichment.
//
// It matters because a wedged character path returns an error, and river
// gives a job a finite number of attempts.  A row whose character UPDATEs
// fail permanently would, if the description write sat after the threshold
// check, exhaust its attempts and end up with score + title committed but no
// synopsis — even though the synopsis was in hand and depends on nothing the
// character loop produces.
func TestBangumiV2_DescriptionCnWrittenBeforeCharFailureRetry(t *testing.T) {
	t.Parallel()

	chars := make([]bangumi.Character, 4)
	for i := range chars {
		chars[i] = bangumi.Character{Name: fmt.Sprintf("Char%d", i)}
	}

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			s := makeSubject(id, "火影忍者", 8.7, 5000)
			s.Summary = testSummaryChinese
			return s, nil
		},
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return chars, nil
		},
	}
	db := &fakeV2DB{
		updateCharFn: func(_ context.Context, _ v2CharCall) error {
			return errors.New("db wedged")
		},
	}

	err := runV2(t, b, db, 1234, 9999)
	require.Error(t, err, "all chars failed → the job itself still retries")

	calls := db.snapshotDescCnCalls()
	require.Len(t, calls, 1, "description_cn must be written before the char loop can abort the job")
	require.NotNil(t, calls[0].descriptionCn)
	assert.Equal(t, testSummaryChinese, *calls[0].descriptionCn)
}

// TestBangumiV2_SubjectUpdateError_SkipsDescriptionCn — the mirror case: when
// the primary V2 write fails the worker returns immediately, so no
// description lands on a row whose score / title write did not.  Avoids a
// second doomed round trip against an already-failing DB.
func TestBangumiV2_SubjectUpdateError_SkipsDescriptionCn(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			s := makeSubject(id, "火影忍者", 8.7, 5000)
			s.Summary = testSummaryChinese
			return s, nil
		},
	}
	db := &fakeV2DB{
		updateV2Fn: func(_ context.Context, _ v2UpdateCall) error {
			return errors.New("write conflict")
		},
	}

	require.Error(t, runV2(t, b, db, 1234, 9999))
	assert.Empty(t, db.snapshotDescCnCalls(),
		"primary write failed → don't attempt the optional one")
}

// TestBangumiV2_EpisodeTitlesCarryBangumiProvenance pins the half of the write
// that has no visible effect until a second source exists.
//
// The regression it guards is not hypothetical.  For one release V2 wrote
// through the pre-0029 statement, which set the two value columns and left the
// source columns untouched; the hourly episodes_bgm sweep then passed over rows
// cmd/bgmbackfill had labelled 'ddp' and replaced their values -- often with
// NULL -- while the 'ddp' label stayed behind.  1,966 production rows ended up
// claiming a source for a column that held nothing, and because the sourced
// upsert scores precedence against that label, every automatic writer was then
// refused on those episodes.
//
// TestBangumiV2_WritesEpisodeTitles above passes just as happily without a
// source or a binding pin, which is exactly why the bug survived a release.
// This one does not.
func TestBangumiV2_EpisodeTitlesCarryBangumiProvenance(t *testing.T) {
	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			return makeSubject(id, "中文名", 80, 100), nil
		},
		episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
			return &bangumi.EpisodesResponse{Eps: []bangumi.Episode{
				{Sort: 1, Type: 0, Name: "E1", NameCN: "第一集"},
				{Sort: 2, Type: 0, Name: "E2"},
			}}, nil
		},
	}
	d := &fakeV2DB{}
	if err := runV2(t, b, d, 100, 555); err != nil {
		t.Fatalf("Work: %v", err)
	}
	eps := d.snapshotEpTitleCalls()
	if len(eps) != 2 {
		t.Fatalf("want 2 episode-title writes, got %d", len(eps))
	}
	for _, e := range eps {
		if e.source != "bangumi" {
			t.Fatalf("episode %d written with source %q, want \"bangumi\": a value "+
				"labelled by nobody is unclaimed, and one wearing another source's "+
				"label blocks the writer that could fill it", e.episode, e.source)
		}
		if e.bgmID != 555 {
			t.Fatalf("episode %d written with bgmID %d, want 555: the query cannot "+
				"refuse a write whose subject moved if the caller does not say which "+
				"subject it fetched", e.episode, e.bgmID)
		}
	}
}
