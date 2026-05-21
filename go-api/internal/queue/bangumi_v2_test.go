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

	subjectCalls    int
	charactersCalls int
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

// fakeV2DB is a programmable V2DB.  Hooks let each test inject an
// error for the retry/non-retry paths; call snapshots let assertions
// inspect what got written without smuggling globals.
type fakeV2DB struct {
	mu sync.Mutex

	updateV2Fn   func(ctx context.Context, c v2UpdateCall) error
	updateCharFn func(ctx context.Context, c v2CharCall) error

	updateV2Calls   []v2UpdateCall
	updateCharCalls []v2CharCall
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
func runV2(t *testing.T, b BangumiV2Client, d V2DB, anilistID, bgmID int) error {
	t.Helper()
	w := NewBangumiV2Worker(b, d)
	return w.Work(context.Background(), &river.Job[BangumiV2Args]{
		Args: BangumiV2Args{AnilistID: anilistID, BgmID: bgmID},
	})
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

// TestBangumiV2_SubjectNotFound_ReturnsNil — Subject 404 → return nil,
// NO DB writes (Express dropped the row the same way).
func TestBangumiV2_SubjectNotFound_ReturnsNil(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV2{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, bangumi.ErrNotFound
		},
		charactersFn: func(_ context.Context, _ int) ([]bangumi.Character, error) {
			return nil, nil
		},
	}
	db := &fakeV2DB{}

	err := runV2(t, b, db, 1, 100)
	require.NoError(t, err, "ErrNotFound subject is permanent — must not retry")
	assert.Empty(t, db.snapshotV2Calls(), "subject 404 → no UpdateBangumiV2")
	assert.Empty(t, db.snapshotCharCalls(), "subject 404 → no char UPDATEs")
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

// ---------------------------------------------------------------------------
// Compile-time guards: production types must satisfy the interfaces.
// ---------------------------------------------------------------------------

// dbgen.Querier must satisfy V2DB so main.go can pass *Queries directly.
var _ V2DB = (dbgen.Querier)(nil)

// *bangumi.Client must satisfy BangumiV2Client.
var _ BangumiV2Client = (*bangumi.Client)(nil)
