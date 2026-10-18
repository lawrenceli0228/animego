package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Fixtures
//
// Titles are production's, verbatim, for the rows that motivated the sweep
// and for the ones that test its season gate.  Synthetic titles would let the
// gate pass for a reason the real data does not share: these are the forms
// AniList and Bangumi actually write (2クール with no 第, Ⅱ against II,
// "3rd Season" against 第2期).
// ---------------------------------------------------------------------------

func rebindRow(id int32, native, romaji, english string, year, eps int32) dbgen.ListBgmRebindCandidatesRow {
	row := dbgen.ListBgmRebindCandidatesRow{AnilistID: id}
	if native != "" {
		row.TitleNative = &native
	}
	if romaji != "" {
		row.TitleRomaji = &romaji
	}
	if english != "" {
		row.TitleEnglish = &english
	}
	if year != 0 {
		row.SeasonYear = &year
	}
	if eps != 0 {
		row.Episodes = &eps
	}
	return row
}

var (
	edgerunners2 = rebindRow(195539,
		"サイバーパンク: エッジランナーズ2", "Cyberpunk: Edgerunners 2", "Cyberpunk: Edgerunners 2", 2026, 10)
	edgerunners2Subject = bangumi.SearchResult{
		ID: 513878, Name: "Cyberpunk: Edgerunners 2", NameCN: "赛博朋克：边缘行者 2", Date: "2026-10-20", Eps: 10,
	}

	frieren3 = rebindRow(209939, "葬送のフリーレン 第3期", "Sousou no Frieren 3rd Season", "", 2027, 0)
	// What the legacy search returns first for 葬送のフリーレン 第3期 while
	// season 3 has no subject of its own: season 2's.  The scorer strips both
	// season markers before comparing, so it calls this a near-exact title.
	frieren2Subject = bangumi.SearchResult{
		ID: 515759, Name: "葬送のフリーレン 第2期", NameCN: "葬送的芙莉莲 第二季", Date: "2026-01-16", Eps: 10,
	}

	chitosePart2 = rebindRow(198727,
		"千歳くんはラムネ瓶のなか 2クール", "Chitose-kun wa Ramune Bin no Naka Part 2",
		"Chitose Is in the Ramune Bottle 2nd Cour", 2026, 11)
	chitosePart2Subject = bangumi.SearchResult{
		ID: 584847, Name: "千歳くんはラムネ瓶のなか 第2クール", NameCN: "弹珠汽水瓶里的千岁同学 第2部分", Date: "2026-10-13", Eps: 11,
	}

	katainaka2 = rebindRow(194829,
		"片田舎のおっさん、剣聖になるII", "Katainaka no Ossan, Kensei ni Naru II",
		"From Old Country Bumpkin to Master Swordsman II", 2026, 12)
	katainaka2Subject = bangumi.SearchResult{
		ID: 565701, Name: "片田舎のおっさん、剣聖になるⅡ", NameCN: "乡下大叔成为剑圣 第二季", Date: "2026-07-08", Eps: 12,
	}

	yozakura2Part2 = rebindRow(213657,
		"夜桜さんちの大作戦 第2期 第2クール", "Yozakura-san Chi no Daisakusen 2nd Season Part 2",
		"Mission: Yozakura Family Season 2 Part 2", 2026, 0)
	yozakura2Part2Subject = bangumi.SearchResult{
		ID: 664389, Name: "夜桜さんちの大作戦 第2期 第2クール", NameCN: "夜樱家的大作战 第二季 第2部分", Date: "2026-10-11",
	}

	// A subject the scorer rejects outright: nothing in common with the row.
	unrelatedSubject = bangumi.SearchResult{
		ID: 225021, Name: "魔法少女サイト", NameCN: "魔法少女网站", Date: "2018-04-06", Eps: 12,
	}
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeRebindDB is a programmable BgmRebindDB.
type fakeRebindDB struct {
	rows    []dbgen.ListBgmRebindCandidatesRow
	listErr error

	listCalls     int
	lastStale     pgtype.Interval
	lastLimit     int32
	stamped       []int32
	stampErrFor   map[int32]error
	taken         map[int32]int64 // bgm_id -> rows already holding it
	countErr      error
	countedBgmIDs []int32
}

func (f *fakeRebindDB) ListBgmRebindCandidates(_ context.Context, staleAfter pgtype.Interval, lim int32) ([]dbgen.ListBgmRebindCandidatesRow, error) {
	f.listCalls++
	f.lastStale = staleAfter
	f.lastLimit = lim
	return f.rows, f.listErr
}

func (f *fakeRebindDB) MarkBgmRebindChecked(_ context.Context, anilistID int32) (int64, error) {
	if err := f.stampErrFor[anilistID]; err != nil {
		return 0, err
	}
	f.stamped = append(f.stamped, anilistID)
	return 1, nil
}

func (f *fakeRebindDB) CountAnimeBoundToBgmID(_ context.Context, bgmID int32, _ int32) (int64, error) {
	f.countedBgmIDs = append(f.countedBgmIDs, bgmID)
	if f.countErr != nil {
		return 0, f.countErr
	}
	return f.taken[bgmID], nil
}

// rebindBindCall is one BindAndEnqueue invocation.
type rebindBindCall struct {
	anilistID    int32
	bgmID        int32
	titleChinese *string
}

// fakeRebindBinder records binds.  bound is what it reports back: true for
// "the row was bound and its V2 job queued", false for "the statement
// refused" (the row moved, or the subject was taken in the meantime).
type fakeRebindBinder struct {
	calls []rebindBindCall
	bound bool
	err   error
}

func (f *fakeRebindBinder) BindAndEnqueue(_ context.Context, anilistID, bgmID int32, titleChinese *string) (bool, error) {
	f.calls = append(f.calls, rebindBindCall{anilistID: anilistID, bgmID: bgmID, titleChinese: titleChinese})
	return f.bound, f.err
}

// searchByKeyword answers each keyword from a table; a keyword missing from
// it is a test bug and fails loudly rather than returning an empty list.
func searchByKeyword(t *testing.T, answers map[string]func() (*bangumi.SearchResponse, error)) *fakeBangumi {
	t.Helper()
	return &fakeBangumi{searchFn: func(_ context.Context, kw string) (*bangumi.SearchResponse, error) {
		answer, ok := answers[kw]
		if !ok {
			t.Errorf("unexpected search for %q", kw)
			return &bangumi.SearchResponse{}, nil
		}
		return answer()
	}}
}

func hits(results ...bangumi.SearchResult) func() (*bangumi.SearchResponse, error) {
	return func() (*bangumi.SearchResponse, error) { return &bangumi.SearchResponse{List: results}, nil }
}

func searchErr(err error) func() (*bangumi.SearchResponse, error) {
	return func() (*bangumi.SearchResponse, error) { return nil, err }
}

func runRebind(t *testing.T, ctx context.Context, bgm *fakeBangumi, db *fakeRebindDB, binder *fakeRebindBinder) error {
	t.Helper()
	w := newBgmRebindWorker(bgm, db, binder)
	return w.Work(ctx, &river.Job[BgmRebindArgs]{})
}

// ---------------------------------------------------------------------------
// decideRebind
// ---------------------------------------------------------------------------

func TestDecideRebind(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		row     dbgen.ListBgmRebindCandidatesRow
		list    []bangumi.SearchResult
		verdict rebindVerdict
		bgmID   int
	}{
		{
			// The row this sweep was written for: parked fuzzy_low when it was
			// first searched, an exact title, year and episode match today.
			name:    "an exact match binds",
			row:     edgerunners2,
			list:    []bangumi.SearchResult{edgerunners2Subject, unrelatedSubject},
			verdict: rebindBind,
			bgmID:   513878,
		},
		{
			name:    "the best candidate wins regardless of list position",
			row:     edgerunners2,
			list:    []bangumi.SearchResult{unrelatedSubject, edgerunners2Subject},
			verdict: rebindBind,
			bgmID:   513878,
		},
		{
			name:    "no candidates is no hit",
			row:     edgerunners2,
			list:    nil,
			verdict: rebindNoHit,
		},
		{
			name:    "a candidate below the confidence floor is refused",
			row:     edgerunners2,
			list:    []bangumi.SearchResult{unrelatedSubject},
			verdict: rebindLowConfidence,
		},
		{
			// The scorer calls this high confidence: it strips 第3期 and 第2期
			// before comparing, so the titles are identical, and a one-year gap
			// only discounts the year.  Binding it would put season 2's
			// Chinese title and episode names on season 3's public page.
			name:    "a season the subject does not share is refused even at high confidence",
			row:     frieren3,
			list:    []bangumi.SearchResult{frieren2Subject},
			verdict: rebindSeasonMismatch,
		},
		{
			// 2クール (no 第) on the AniList side, 第2クール on Bangumi's: the
			// romaji's "Part 2" is what states the part, and the entry's
			// titles are folded together, so the two sides agree.
			name:    "a part stated in different forms on each side binds",
			row:     chitosePart2,
			list:    []bangumi.SearchResult{chitosePart2Subject},
			verdict: rebindBind,
			bgmID:   584847,
		},
		{
			name:    "a roman numeral season against a fullwidth one binds",
			row:     katainaka2,
			list:    []bangumi.SearchResult{katainaka2Subject},
			verdict: rebindBind,
			bgmID:   565701,
		},
		{
			name:    "season and part both agreeing binds",
			row:     yozakura2Part2,
			list:    []bangumi.SearchResult{yozakura2Part2Subject},
			verdict: rebindBind,
			bgmID:   664389,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			d := decideRebind(tc.row, tc.list)
			assert.Equal(t, tc.verdict, d.verdict)
			if tc.verdict == rebindBind {
				require.NotNil(t, d.best)
				assert.Equal(t, tc.bgmID, d.best.ID)
			}
		})
	}
}

func TestSubjectChineseTitle(t *testing.T) {
	t.Parallel()

	got := subjectChineseTitle(&edgerunners2Subject)
	require.NotNil(t, got)
	assert.Equal(t, "赛博朋克：边缘行者 2", *got)

	assert.Nil(t, subjectChineseTitle(&bangumi.SearchResult{Name: "x", NameCN: ""}),
		"an empty name_cn is no Chinese title")
	assert.Nil(t, subjectChineseTitle(&bangumi.SearchResult{Name: "GROTESQQQUE", NameCN: "GROTESQQQUE"}),
		"a name_cn that only repeats the native name is not a translation")
	assert.Nil(t, subjectChineseTitle(nil))
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

func TestBgmRebindWorker_KillSwitch(t *testing.T) {
	for _, value := range []string{"", "yes-please", "false"} {
		t.Run("value "+value, func(t *testing.T) {
			t.Setenv(rebindSearchEnabledEnv, value)
			db := &fakeRebindDB{rows: []dbgen.ListBgmRebindCandidatesRow{edgerunners2}}
			bgm := &fakeBangumi{}
			binder := &fakeRebindBinder{bound: true}

			require.NoError(t, runRebind(t, context.Background(), bgm, db, binder))

			assert.Zero(t, db.listCalls, "a disabled sweep must not even read its work list")
			assert.Zero(t, bgm.calls, "a disabled sweep must not spend the shared Bangumi bucket")
			assert.Empty(t, binder.calls)
		})
	}
}

func TestBgmRebindWorker_ListFailureEndsThePassQuietly(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "true")
	db := &fakeRebindDB{listErr: errors.New("connection reset")}
	bgm := &fakeBangumi{}

	// nil, not the error: river would retry it with attempt⁴ backoff, and the
	// next scheduled fire is the better retry.
	require.NoError(t, runRebind(t, context.Background(), bgm, db, &fakeRebindBinder{}))
	assert.Zero(t, bgm.calls)
}

func TestBgmRebindWorker_AsksForTheWeeklyWindowAndBatch(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "1")
	db := &fakeRebindDB{}
	require.NoError(t, runRebind(t, context.Background(), &fakeBangumi{}, db, &fakeRebindBinder{}))

	require.Equal(t, 1, db.listCalls)
	assert.True(t, db.lastStale.Valid)
	assert.Equal(t, int64(rebindSearchStaleAfter.Microseconds()), db.lastStale.Microseconds,
		"the stamp window is the weekly cycle")
	assert.Equal(t, rebindSearchBatch, db.lastLimit)
}

// One pass over a row of every kind.  The assertion that matters is the
// stamp set: a stamped row waits a week, an unstamped one is retried on the
// next fire.  Stamping a transient failure would hide the row for a week for
// no reason; failing to stamp a settled refusal would re-search it every six
// hours forever.
func TestBgmRebindWorker_OnePassOverEveryOutcome(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "true")

	noKeyword := rebindRow(1, "", "", "Only English", 2026, 0)
	notFound := rebindRow(2, "見つからない", "", "", 2026, 0)
	emptyList := rebindRow(3, "空っぽ", "", "", 2026, 0)
	lowConfidence := rebindRow(4, "低い", "Hikui", "", 2026, 12)
	transient := rebindRow(5, "一時的", "", "", 2026, 0)
	taken := rebindRow(6, "片田舎のおっさん、剣聖になるII", "Katainaka no Ossan, Kensei ni Naru II", "", 2026, 12)

	db := &fakeRebindDB{
		rows: []dbgen.ListBgmRebindCandidatesRow{
			edgerunners2, noKeyword, notFound, emptyList, lowConfidence, frieren3, transient, taken,
		},
		taken: map[int32]int64{int32(katainaka2Subject.ID): 1},
	}
	bgm := searchByKeyword(t, map[string]func() (*bangumi.SearchResponse, error){
		"サイバーパンク: エッジランナーズ2": hits(edgerunners2Subject),
		"見つからない":       searchErr(bangumi.ErrNotFound),
		"空っぽ":          hits(),
		"低い":           hits(unrelatedSubject),
		"葬送のフリーレン 第3期": hits(frieren2Subject),
		"一時的":          searchErr(errors.New("dial tcp: i/o timeout")),
		"片田舎のおっさん、剣聖になるII": hits(katainaka2Subject),
	})
	binder := &fakeRebindBinder{bound: true}

	require.NoError(t, runRebind(t, context.Background(), bgm, db, binder))

	require.Len(t, binder.calls, 1, "only the free, confident, season-agreeing match binds")
	call := binder.calls[0]
	assert.Equal(t, int32(195539), call.anilistID)
	assert.Equal(t, int32(513878), call.bgmID)
	require.NotNil(t, call.titleChinese)
	assert.Equal(t, "赛博朋克：边缘行者 2", *call.titleChinese)

	assert.ElementsMatch(t,
		[]int32{noKeyword.AnilistID, notFound.AnilistID, emptyList.AnilistID,
			lowConfidence.AnilistID, frieren3.AnilistID, taken.AnilistID},
		db.stamped,
		"every settled refusal waits out the cycle; the transient failure and the bind do not go through this stamp")

	assert.Equal(t, 7, bgm.calls, "the row with no Japanese or romaji title is never searched")
	assert.ElementsMatch(t, []int32{513878, int32(katainaka2Subject.ID)}, db.countedBgmIDs,
		"the collision check runs only for a candidate that is about to be bound")
}

func TestBgmRebindWorker_RefusedBindIsStamped(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "true")
	db := &fakeRebindDB{rows: []dbgen.ListBgmRebindCandidatesRow{edgerunners2}}
	bgm := searchByKeyword(t, map[string]func() (*bangumi.SearchResponse, error){
		"サイバーパンク: エッジランナーズ2": hits(edgerunners2Subject),
	})
	// The statement wrote nothing: the subject was taken, or the row was
	// bound or hand-corrected, between the read and the write.
	binder := &fakeRebindBinder{bound: false}

	require.NoError(t, runRebind(t, context.Background(), bgm, db, binder))

	require.Len(t, binder.calls, 1)
	assert.Equal(t, []int32{195539}, db.stamped,
		"a refused bind is a settled answer for this cycle; unstamped it would lead every pass")
}

func TestBgmRebindWorker_FailedBindIsNotStamped(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "true")
	db := &fakeRebindDB{rows: []dbgen.ListBgmRebindCandidatesRow{edgerunners2, chitosePart2}}
	bgm := searchByKeyword(t, map[string]func() (*bangumi.SearchResponse, error){
		"サイバーパンク: エッジランナーズ2": hits(edgerunners2Subject),
		"千歳くんはラムネ瓶のなか 2クール":  hits(chitosePart2Subject),
	})
	binder := &fakeRebindBinder{err: errors.New("river InsertManyTx failed")}

	require.NoError(t, runRebind(t, context.Background(), bgm, db, binder))

	assert.Len(t, binder.calls, 2, "one row's failure does not end the pass")
	assert.Empty(t, db.stamped,
		"the transaction rolled back, so nothing was decided: the rows must come back on the next fire, not in a week")
}

func TestBgmRebindWorker_CollisionCheckFailureIsNotABind(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "true")
	db := &fakeRebindDB{
		rows:     []dbgen.ListBgmRebindCandidatesRow{edgerunners2},
		countErr: errors.New("connection reset"),
	}
	bgm := searchByKeyword(t, map[string]func() (*bangumi.SearchResponse, error){
		"サイバーパンク: エッジランナーズ2": hits(edgerunners2Subject),
	})
	binder := &fakeRebindBinder{bound: true}

	require.NoError(t, runRebind(t, context.Background(), bgm, db, binder))

	assert.Empty(t, binder.calls, "a failed read must not become a licence to bind")
	assert.Empty(t, db.stamped, "nor a verdict that holds the row back for a week")
}

func TestBgmRebindWorker_StampFailureDoesNotEndThePass(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "true")
	first := rebindRow(11, "一つ目", "", "", 2026, 0)
	second := rebindRow(12, "二つ目", "", "", 2026, 0)
	db := &fakeRebindDB{
		rows:        []dbgen.ListBgmRebindCandidatesRow{first, second},
		stampErrFor: map[int32]error{11: errors.New("deadlock detected")},
	}
	bgm := searchByKeyword(t, map[string]func() (*bangumi.SearchResponse, error){
		"一つ目": hits(),
		"二つ目": hits(),
	})

	require.NoError(t, runRebind(t, context.Background(), bgm, db, &fakeRebindBinder{}))

	assert.Equal(t, 2, bgm.calls)
	assert.Equal(t, []int32{12}, db.stamped)
}

func TestBgmRebindWorker_StopsWhenOutOfTime(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "true")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	rows := []dbgen.ListBgmRebindCandidatesRow{
		rebindRow(21, "一", "", "", 2026, 0),
		rebindRow(22, "二", "", "", 2026, 0),
		rebindRow(23, "三", "", "", 2026, 0),
	}
	db := &fakeRebindDB{rows: rows}
	bgm := &fakeBangumi{searchFn: func(context.Context, string) (*bangumi.SearchResponse, error) {
		cancel() // the pass's budget runs out during the first search
		return nil, context.Canceled
	}}

	require.NoError(t, runRebind(t, ctx, bgm, db, &fakeRebindBinder{}))

	assert.Equal(t, 1, bgm.calls,
		"every remaining search would fail the same way; the rows stay unstamped for the next fire")
	assert.Empty(t, db.stamped)
}

func TestSearchFailureIsSettled(t *testing.T) {
	t.Parallel()

	var notJSON struct{}
	syntaxErr := json.Unmarshal([]byte("<html>"), &notJSON)
	require.Error(t, syntaxErr)
	var wrongShape struct{ List []bangumi.SearchResult }
	typeErr := json.Unmarshal([]byte(`{"List": {"id": 1}}`), &wrongShape)
	require.Error(t, typeErr)

	cases := []struct {
		name    string
		err     error
		settled bool
	}{
		{"400 is a rejection of the keyword", &bangumi.ErrUpstream{Status: 400}, true},
		{"403 is a rejection too", fmt.Errorf("wrapped: %w", &bangumi.ErrUpstream{Status: 403}), true},
		{"429 is the moment", &bangumi.ErrUpstream{Status: 429}, false},
		{"500 is the moment", &bangumi.ErrUpstream{Status: 500}, false},
		{"502 is the moment", &bangumi.ErrUpstream{Status: 502}, false},
		{"a body that is not JSON", fmt.Errorf("bangumi: decode response: %w", syntaxErr), true},
		{"JSON of the wrong shape", fmt.Errorf("bangumi: decode response: %w", typeErr), true},
		{"a body cut off mid-read", fmt.Errorf("bangumi: decode response: %w", io.ErrUnexpectedEOF), false},
		{"a transport failure", errors.New("bangumi: http do: dial tcp: i/o timeout"), false},
		{"an exhausted budget", fmt.Errorf("bangumi: rate limit wait: %w", context.DeadlineExceeded), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.settled, searchFailureIsSettled(tc.err))
		})
	}
}

// A rejected search is stamped and waits the week; a failure of the moment is
// not.  Without the distinction a keyword Bangumi always rejects would lead
// every batch -- never-stamped rows sort first -- and be re-sent every pass.
func TestBgmRebindWorker_RejectedSearchIsStamped(t *testing.T) {
	t.Setenv(rebindSearchEnabledEnv, "true")
	rejected := rebindRow(31, "拒否", "", "", 2026, 0)
	unavailable := rebindRow(32, "停止中", "", "", 2026, 0)
	db := &fakeRebindDB{rows: []dbgen.ListBgmRebindCandidatesRow{rejected, unavailable}}
	bgm := searchByKeyword(t, map[string]func() (*bangumi.SearchResponse, error){
		"拒否":  searchErr(&bangumi.ErrUpstream{Status: 400, Message: "Bangumi API error"}),
		"停止中": searchErr(&bangumi.ErrUpstream{Status: 503, Message: "Bangumi API error"}),
	})

	require.NoError(t, runRebind(t, context.Background(), bgm, db, &fakeRebindBinder{}))

	assert.Equal(t, []int32{rejected.AnilistID}, db.stamped)
}
