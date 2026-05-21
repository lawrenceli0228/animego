// bangumi_v1_test.go — unit tests for the Phase 1 Bangumi worker.
//
// No real Bangumi HTTP server, no real DB.  Each test wires a stub
// BangumiSearcher + V1DB to assert the Work() decision tree:
//
//   - keyword selection (titleNative first, romaji fallback, empty → no-op)
//   - hit selection (exact native match wins; falls back to list[0])
//   - titleChinese gating (only on exact match + real CN translation)
//   - error handling (ErrNotFound + empty list → nil; other errors retry)
//
// In-package tests so we can inspect un-exported helpers (pickKeyword,
// selectHit) if a regression demands it without widening the export
// surface.
package queue

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeBangumi is a programmable stand-in for *bangumi.Client.  Each
// test sets searchFn to control the response; the calls counter lets
// negative assertions ("must NOT call Search") stay precise.
type fakeBangumi struct {
	searchFn func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error)
	calls    int
	lastKW   string
}

func (f *fakeBangumi) Search(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
	f.calls++
	f.lastKW = keyword
	if f.searchFn == nil {
		return &bangumi.SearchResponse{}, nil
	}
	return f.searchFn(ctx, keyword)
}

// fakeV1DB is a programmable V1DB.  Each test sets the two fn fields;
// the lastUpdate snapshot lets assertions inspect what was written
// without smuggling globals.
type fakeV1DB struct {
	getFn    func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error)
	updateFn func(ctx context.Context, anilistID int32, bgmID *int32, titleChinese *string) error

	updateCalls int
	lastUpdate  struct {
		anilistID    int32
		bgmID        *int32
		titleChinese *string
	}
}

// fakeV1Enqueuer records EnqueueV2Many calls so chain tests can
// assert which {anilistId, bgmId} pairs were dispatched after a
// successful V1 update.  EnqueueV1Many is a no-op (V1 worker never
// calls it on itself) but must be implemented to satisfy Enqueuer.
type fakeV1Enqueuer struct {
	v2Fn    func(ctx context.Context, jobs []BangumiV2Args) error
	v2Calls [][]BangumiV2Args
}

func (f *fakeV1Enqueuer) EnqueueV1Many(_ context.Context, _ []int32) error {
	return nil
}

func (f *fakeV1Enqueuer) EnqueueV2Many(ctx context.Context, jobs []BangumiV2Args) error {
	dup := make([]BangumiV2Args, len(jobs))
	copy(dup, jobs)
	f.v2Calls = append(f.v2Calls, dup)
	if f.v2Fn == nil {
		return nil
	}
	return f.v2Fn(ctx, jobs)
}

func (f *fakeV1DB) GetAnimeForBangumiSearch(ctx context.Context, anilistID int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
	if f.getFn == nil {
		return dbgen.GetAnimeForBangumiSearchRow{}, nil
	}
	return f.getFn(ctx, anilistID)
}

func (f *fakeV1DB) UpdateBangumiV1(ctx context.Context, anilistID int32, bgmID *int32, titleChinese *string) error {
	f.updateCalls++
	f.lastUpdate.anilistID = anilistID
	f.lastUpdate.bgmID = bgmID
	f.lastUpdate.titleChinese = titleChinese
	if f.updateFn == nil {
		return nil
	}
	return f.updateFn(ctx, anilistID, bgmID, titleChinese)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ptr is a tiny generic to make *string / *int32 literals readable
// in test setup.  Avoids the noisy `func() *string { s := "x"; return &s }()`
// pattern.
func ptr[T any](v T) *T { return &v }

// runV1 constructs the worker + a stock job and dispatches it through
// Work().  Returns whatever Work() returns so the caller can assert.
// Uses NoopEnqueuer{} so tests that don't care about the V2 chain
// don't have to wire one.  Tests that DO care about the chain should
// call runV1WithEnq instead.
func runV1(t *testing.T, b BangumiSearcher, d V1DB, anilistID int) error {
	t.Helper()
	return runV1WithEnq(t, b, d, NoopEnqueuer{}, anilistID)
}

// runV1WithEnq is the explicit-enqueuer variant used by chain tests.
// The V1 worker chain-enqueues a V2 job after a successful update;
// these tests capture and assert on what got enqueued.
func runV1WithEnq(t *testing.T, b BangumiSearcher, d V1DB, e Enqueuer, anilistID int) error {
	t.Helper()
	w := NewBangumiV1Worker(b, d, e)
	return w.Work(context.Background(), &river.Job[BangumiV1Args]{
		Args: BangumiV1Args{AnilistID: anilistID},
	})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestBangumiV1_NoRow_ReturnsNil(t *testing.T) {
	t.Parallel()

	b := &fakeBangumi{}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{}, pgx.ErrNoRows
		},
	}

	err := runV1(t, b, db, 1234)
	require.NoError(t, err, "ErrNoRows is permanent — must not retry")
	assert.Equal(t, 0, b.calls, "no DB row → Search must NOT be called")
	assert.Equal(t, 0, db.updateCalls, "no DB row → Update must NOT be called")
}

func TestBangumiV1_EmptyKeyword_ReturnsNil(t *testing.T) {
	t.Parallel()

	b := &fakeBangumi{}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			// Both titles missing — the JS service returns null too.
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: nil, TitleRomaji: nil}, nil
		},
	}

	err := runV1(t, b, db, 1234)
	require.NoError(t, err)
	assert.Equal(t, 0, b.calls, "empty keyword → Search must NOT be called")
	assert.Equal(t, 0, db.updateCalls, "empty keyword → Update must NOT be called")
}

func TestBangumiV1_EmptyKeyword_EmptyStringTreatedAsMissing(t *testing.T) {
	t.Parallel()

	b := &fakeBangumi{}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			empty := ""
			return dbgen.GetAnimeForBangumiSearchRow{
				TitleNative: &empty,
				TitleRomaji: &empty,
			}, nil
		},
	}

	err := runV1(t, b, db, 1234)
	require.NoError(t, err)
	assert.Equal(t, 0, b.calls, "empty string keyword must be treated as missing")
	assert.Equal(t, 0, db.updateCalls)
}

func TestBangumiV1_HappyPath_ExactMatch(t *testing.T) {
	t.Parallel()

	native := "ナルト"
	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			require.Equal(t, "ナルト", keyword, "keyword must be the native title")
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 9999, Name: "ナルト", NameCN: "火影忍者"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{
				TitleNative: &native,
				TitleRomaji: ptr("Naruto"),
			}, nil
		},
	}

	err := runV1(t, b, db, 1234)
	require.NoError(t, err)
	require.Equal(t, 1, db.updateCalls, "happy path must write once")

	assert.Equal(t, int32(1234), db.lastUpdate.anilistID)
	require.NotNil(t, db.lastUpdate.bgmID, "bgmID must be set on hit")
	assert.Equal(t, int32(9999), *db.lastUpdate.bgmID)
	require.NotNil(t, db.lastUpdate.titleChinese, "exact match with real CN must populate titleChinese")
	assert.Equal(t, "火影忍者", *db.lastUpdate.titleChinese)
}

func TestBangumiV1_HappyPath_NoExactMatch_OnlyBgmId(t *testing.T) {
	t.Parallel()

	native := "進撃の巨人"
	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			// list[0].name differs from titleNative — no exact match.
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 5555, Name: "Different Title", NameCN: "巨人之翼"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: &native}, nil
		},
	}

	err := runV1(t, b, db, 22)
	require.NoError(t, err)
	require.Equal(t, 1, db.updateCalls)

	require.NotNil(t, db.lastUpdate.bgmID)
	assert.Equal(t, int32(5555), *db.lastUpdate.bgmID, "bgmId must be written even without exact match")
	assert.Nil(t, db.lastUpdate.titleChinese,
		"no exact match → titleChinese must stay nil (skip the CN translation)")
}

func TestBangumiV1_NameCnEqualsName_SkipsTitleChinese(t *testing.T) {
	t.Parallel()

	native := "Title"
	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			// Exact match but name_cn == name — that's not a real CN
			// translation, just Bangumi mirroring the source language.
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 42, Name: "Title", NameCN: "Title"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: &native}, nil
		},
	}

	err := runV1(t, b, db, 1)
	require.NoError(t, err)
	require.Equal(t, 1, db.updateCalls)

	require.NotNil(t, db.lastUpdate.bgmID)
	assert.Equal(t, int32(42), *db.lastUpdate.bgmID)
	assert.Nil(t, db.lastUpdate.titleChinese,
		"name_cn == name → no real translation; titleChinese must stay nil")
}

func TestBangumiV1_NameCnEmpty_SkipsTitleChinese(t *testing.T) {
	t.Parallel()

	native := "Solo Leveling"
	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 88, Name: "Solo Leveling", NameCN: ""},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: &native}, nil
		},
	}

	err := runV1(t, b, db, 2)
	require.NoError(t, err)
	require.Equal(t, 1, db.updateCalls)

	require.NotNil(t, db.lastUpdate.bgmID)
	assert.Equal(t, int32(88), *db.lastUpdate.bgmID)
	assert.Nil(t, db.lastUpdate.titleChinese,
		"empty name_cn → titleChinese must stay nil")
}

func TestBangumiV1_RomajiFallback_NoNative(t *testing.T) {
	t.Parallel()

	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			require.Equal(t, "Naruto", keyword, "romaji must be used when native is missing")
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					// Even though romaji is the keyword, Bangumi may
					// surface the native name in the response.  No
					// exact match against the (nil) titleNative.
					{ID: 9, Name: "ナルト", NameCN: "火影忍者"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{
				TitleNative: nil,
				TitleRomaji: ptr("Naruto"),
			}, nil
		},
	}

	err := runV1(t, b, db, 3)
	require.NoError(t, err)
	assert.Equal(t, 1, b.calls)
	assert.Equal(t, "Naruto", b.lastKW)
	require.Equal(t, 1, db.updateCalls)
	require.NotNil(t, db.lastUpdate.bgmID)
	assert.Equal(t, int32(9), *db.lastUpdate.bgmID)
	assert.Nil(t, db.lastUpdate.titleChinese,
		"no titleNative → exactMatch can never be true → no CN write")
}

func TestBangumiV1_NotFound_ReturnsNil(t *testing.T) {
	t.Parallel()

	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			return nil, bangumi.ErrNotFound
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: ptr("Whatever")}, nil
		},
	}

	err := runV1(t, b, db, 4)
	require.NoError(t, err, "ErrNotFound is permanent — must not retry")
	assert.Equal(t, 1, b.calls)
	assert.Equal(t, 0, db.updateCalls, "no hit → no DB write")
}

func TestBangumiV1_EmptyList_ReturnsNil(t *testing.T) {
	t.Parallel()

	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			// 200 OK but no hits — Bangumi sometimes returns this.
			return &bangumi.SearchResponse{List: nil}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: ptr("Whatever")}, nil
		},
	}

	err := runV1(t, b, db, 5)
	require.NoError(t, err, "empty list must be treated as no-hit, not error")
	assert.Equal(t, 1, b.calls)
	assert.Equal(t, 0, db.updateCalls, "empty list → no DB write")
}

func TestBangumiV1_BangumiTransientError_Retries(t *testing.T) {
	t.Parallel()

	upstream := &bangumi.ErrUpstream{Status: 503, Message: "Bangumi API error"}
	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			return nil, upstream
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: ptr("Whatever")}, nil
		},
	}

	err := runV1(t, b, db, 6)
	require.Error(t, err, "non-NotFound errors must surface so river retries")
	assert.ErrorIs(t, err, upstream, "wrapped error must preserve the underlying cause")
	assert.Equal(t, 0, db.updateCalls, "Search failure → no DB write")
}

func TestBangumiV1_DBReadError_Propagates(t *testing.T) {
	t.Parallel()

	dbErr := errors.New("connection reset by peer")
	b := &fakeBangumi{}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{}, dbErr
		},
	}

	err := runV1(t, b, db, 7)
	require.Error(t, err, "non-ErrNoRows read errors must surface so river retries")
	assert.ErrorIs(t, err, dbErr)
	assert.Equal(t, 0, b.calls, "DB read fail → Search must NOT be called")
}

func TestBangumiV1_DBUpdateError_Propagates(t *testing.T) {
	t.Parallel()

	native := "Tower of God"
	dbErr := errors.New("write conflict")

	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 11, Name: "Tower of God", NameCN: "神之塔"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: &native}, nil
		},
		updateFn: func(ctx context.Context, anilistID int32, bgmID *int32, titleChinese *string) error {
			return dbErr
		},
	}

	err := runV1(t, b, db, 8)
	require.Error(t, err, "DB update failure must surface so river retries")
	assert.ErrorIs(t, err, dbErr)
	assert.Equal(t, 1, db.updateCalls, "Update should be attempted once before failing")
}

func TestBangumiV1_ExactMatchSecondPosition(t *testing.T) {
	t.Parallel()

	native := "鋼の錬金術師 FULLMETAL ALCHEMIST"
	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 1001, Name: "鋼の錬金術師", NameCN: "钢之炼金术师"},                       // list[0]: close but not exact
					{ID: 1002, Name: "鋼の錬金術師 FULLMETAL ALCHEMIST", NameCN: "钢之炼金术师"}, // list[1]: exact match
					{ID: 1003, Name: "鋼の錬金術師 第三部", NameCN: "钢之炼金术师 第三部"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: &native}, nil
		},
	}

	err := runV1(t, b, db, 9)
	require.NoError(t, err)
	require.Equal(t, 1, db.updateCalls)
	require.NotNil(t, db.lastUpdate.bgmID)
	assert.Equal(t, int32(1002), *db.lastUpdate.bgmID,
		"worker must pick the exact native match, not list[0]")
	require.NotNil(t, db.lastUpdate.titleChinese)
	assert.Equal(t, "钢之炼金术师", *db.lastUpdate.titleChinese)
}

// TestBangumiV1_ErrorWrappedWithContext exercises the fmt.Errorf wrap —
// the message must include the anilistId so a log line is grep-able.
func TestBangumiV1_ErrorWrappedWithContext(t *testing.T) {
	t.Parallel()

	upstream := errors.New("upstream boom")
	b := &fakeBangumi{
		searchFn: func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
			return nil, upstream
		},
	}
	db := &fakeV1DB{
		getFn: func(ctx context.Context, id int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: ptr("X")}, nil
		},
	}

	err := runV1(t, b, db, 7777)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "7777", "wrapped error must include anilistID for log grep")
	assert.ErrorIs(t, err, upstream)
}

// TestPickKeyword exercises the small helper directly.  Tied to
// behavior because the worker delegates the whole "which title wins"
// rule here.
func TestPickKeyword(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		native *string
		romaji *string
		want   string
	}{
		{"both_nil", nil, nil, ""},
		{"native_only", ptr("ナルト"), nil, "ナルト"},
		{"romaji_only", nil, ptr("Naruto"), "Naruto"},
		{"native_wins_when_both", ptr("ナルト"), ptr("Naruto"), "ナルト"},
		{"empty_native_falls_through_to_romaji", ptr(""), ptr("Naruto"), "Naruto"},
		{"empty_both", ptr(""), ptr(""), ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := pickKeyword(tc.native, tc.romaji)
			assert.Equal(t, tc.want, got)
		})
	}
}

// TestSelectHit exercises the selection helper.  Important because the
// hit-picking rule is the trickiest piece of the JS-port and the
// integration tests can't see this granularity.
func TestSelectHit(t *testing.T) {
	t.Parallel()

	hits := []bangumi.SearchResult{
		{ID: 1, Name: "A"},
		{ID: 2, Name: "B"},
		{ID: 3, Name: "C"},
	}

	tests := []struct {
		name       string
		native     *string
		wantID     int
		wantExact  bool
	}{
		{"no_native_returns_first", nil, 1, false},
		{"empty_native_returns_first", ptr(""), 1, false},
		{"native_matches_index_1", ptr("B"), 2, true},
		{"native_matches_last", ptr("C"), 3, true},
		{"native_no_match_returns_first", ptr("Z"), 1, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, exact := selectHit(hits, tc.native)
			require.NotNil(t, got)
			assert.Equal(t, tc.wantID, got.ID)
			assert.Equal(t, tc.wantExact, exact)
		})
	}
}

// ---------------------------------------------------------------------------
// V2 chain tests — added in P2.1.7 along with the real V2 worker.
// ---------------------------------------------------------------------------

// TestBangumiV1_HappyPath_ChainsV2 verifies that after a successful
// V1 update (with a bgmID), the worker chain-enqueues exactly one V2
// job carrying the same {anilistId, bgmId} pair.
func TestBangumiV1_HappyPath_ChainsV2(t *testing.T) {
	t.Parallel()

	native := "ナルト"
	b := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 9999, Name: "ナルト", NameCN: "火影忍者"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: &native}, nil
		},
	}
	enq := &fakeV1Enqueuer{}

	err := runV1WithEnq(t, b, db, enq, 1234)
	require.NoError(t, err)

	require.Len(t, enq.v2Calls, 1, "exactly one V2 chain enqueue expected")
	require.Len(t, enq.v2Calls[0], 1, "exactly one V2 args entry")
	assert.Equal(t, BangumiV2Args{AnilistID: 1234, BgmID: 9999}, enq.v2Calls[0][0],
		"V2 chain must carry the same anilistId + bgmId")
}

// TestBangumiV1_NoHit_DoesNotChainV2 — when Search returns ErrNotFound
// there's no bgmID to chain, so EnqueueV2Many must NOT be called.
func TestBangumiV1_NoHit_DoesNotChainV2(t *testing.T) {
	t.Parallel()

	b := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return nil, bangumi.ErrNotFound
		},
	}
	db := &fakeV1DB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: ptr("Whatever")}, nil
		},
	}
	enq := &fakeV1Enqueuer{}

	err := runV1WithEnq(t, b, db, enq, 99)
	require.NoError(t, err)
	assert.Empty(t, enq.v2Calls, "no Bangumi hit → no V2 chain")
}

// TestBangumiV1_EmptyList_DoesNotChainV2 — same as ErrNotFound, but
// the 200/{list:[]} branch.
func TestBangumiV1_EmptyList_DoesNotChainV2(t *testing.T) {
	t.Parallel()

	b := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{List: nil}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: ptr("X")}, nil
		},
	}
	enq := &fakeV1Enqueuer{}

	err := runV1WithEnq(t, b, db, enq, 5)
	require.NoError(t, err)
	assert.Empty(t, enq.v2Calls, "empty list → no V2 chain")
}

// TestBangumiV1_V2ChainError_NonFatal — V1 succeeded but the chain
// enqueue errored.  V1 must still return nil — V1 already updated
// the DB, so river marking this job failed would cause unnecessary
// retries of the V1 work (and another V2 chain attempt that may
// duplicate, etc.).
func TestBangumiV1_V2ChainError_NonFatal(t *testing.T) {
	t.Parallel()

	native := "Title"
	b := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 42, Name: "Title", NameCN: "标题"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: &native}, nil
		},
	}
	enq := &fakeV1Enqueuer{
		v2Fn: func(_ context.Context, _ []BangumiV2Args) error {
			return errors.New("river client transient err")
		},
	}

	err := runV1WithEnq(t, b, db, enq, 8)
	require.NoError(t, err,
		"V2 chain failure must NOT cause V1 to retry — V1 already updated DB")
	require.Equal(t, 1, db.updateCalls, "V1 DB write happened exactly once")
	assert.Len(t, enq.v2Calls, 1, "V2 chain was attempted")
}

// TestBangumiV1_NilEnqueuer_Substitutes — passing nil to the
// constructor must NOT panic; NoopEnqueuer is substituted so the
// chain call is a safe no-op.
func TestBangumiV1_NilEnqueuer_Substitutes(t *testing.T) {
	t.Parallel()

	native := "Title"
	b := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{
				List: []bangumi.SearchResult{
					{ID: 42, Name: "Title"},
				},
			}, nil
		},
	}
	db := &fakeV1DB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeForBangumiSearchRow, error) {
			return dbgen.GetAnimeForBangumiSearchRow{TitleNative: &native}, nil
		},
	}

	w := NewBangumiV1Worker(b, db, nil)
	require.NotNil(t, w, "constructor should never return nil")

	err := w.Work(context.Background(), &river.Job[BangumiV1Args]{
		Args: BangumiV1Args{AnilistID: 1},
	})
	require.NoError(t, err, "nil enq should be substituted with Noop")
	require.Equal(t, 1, db.updateCalls)
}

// Compile-time guard:  dbgen.Querier must satisfy V1DB so production
// main.go can pass the sqlc Queries directly.  Failing this means we'd
// need an adapter on the call-site — better to catch it here.
var _ V1DB = (dbgen.Querier)(nil)

// Compile-time guard:  *bangumi.Client must satisfy BangumiSearcher.
// Same rationale — keeps the production wiring trivial.
var _ BangumiSearcher = (*bangumi.Client)(nil)

// Compile-time guard:  fakeV1Enqueuer must satisfy Enqueuer.  If a
// new method is added to Enqueuer this fixture must be updated too.
var _ Enqueuer = (*fakeV1Enqueuer)(nil)
