// bangumi_episodes_test.go — unit tests for the inferred-episode-count sweep.
//
// No real DB and no real Bangumi HTTP server; fakes at each seam, the same
// stance description_backfill_test.go takes.
//
// The tests that carry the most weight are not the happy path:
//
//   - The identity gate is exercised against a REAL production mis-binding —
//     anilist 212309 (Transformers: Wild King W) carrying bgm_id 1269 (Aria
//     the Natural).  Fetching that subject's episode list returns Aria's
//     episodes with Aria's Chinese titles, and this worker would otherwise
//     write them to anime_episode_titles, from where they render on a public,
//     indexed page.  The regression test asserts the verdict AND that not one
//     write of either kind happened.
//   - One test does the comparison the gate must never do — Bangumi's name_cn
//     against our title_chinese — and asserts it scores ~1.0 on that same row,
//     because title_chinese has already been polluted to Aria's Chinese name.
//     That is the whole argument for keeping the column out of the gate, and
//     it belongs in a test rather than only in a comment.
//   - fakeEpisodesBgmDB deliberately exposes a WIDER write surface than the
//     worker's own dependency — the V2 enrichment writes, the AniList upsert —
//     so a future widening of that dependency is caught here instead of in
//     production.  This worker exists precisely so that filling one integer
//     does not re-open every column V2 owns.
//
// In-package so the batch constant, the cooldown constants and the ptr[T]
// helper (bangumi_v1_test.go) are reachable without widening the export
// surface.
package queue

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/titlematch"
)

// ---------------------------------------------------------------------------
// Fixtures — the production mis-binding
// ---------------------------------------------------------------------------

// The row and the subject below are a real, reproducible mis-binding observed
// in production, kept verbatim rather than synthesised.  A made-up pair of
// obviously-unrelated titles would prove only that the arithmetic works; this
// pair proves the gate rejects the shape of thing that actually goes wrong —
// including the part where title_chinese has ALREADY been overwritten with the
// wrong show's name, which is what makes the naive comparison pass.
const (
	misboundAnilistID = 212309
	misboundBgmID     = 1269

	misboundTitleNative = "トランスフォーマー：ワイルドキングW"
	misboundTitleRomaji = "Transformers: Wild King W"

	// What bgm.tv actually returns for subject 1269 — a different work
	// entirely, and the source of the 26 Chinese episode titles this worker
	// must not write against 212309.
	misboundSubjectName   = "ARIA The NATURAL"
	misboundSubjectNameCN = "水星领航员 第二季"

	// anime_cache.title_chinese as it stands on the mis-bound row: already
	// polluted by earlier enrichment to the wrong show's Chinese title.
	misboundPollutedTitleChinese = "水星领航员 第二季"
)

// misboundGate is the gate input row for the production mis-binding: no match
// source recorded (the class this gate exists for) and no id-map agreement.
func misboundGate() dbgen.GetEpisodesBgmGateInputsRow {
	return dbgen.GetEpisodesBgmGateInputsRow{
		BgmID:          ptr(int32(misboundBgmID)),
		BgmMatchSource: nil,
		TitleNative:    ptr(misboundTitleNative),
		TitleRomaji:    ptr(misboundTitleRomaji),
		IDMapAgrees:    false,
	}
}

// ariaEpisodes is a stand-in for what /subject/1269/ep returns: main episodes
// with Chinese names.  Only the shape matters — the point of the regression
// test is that NONE of these reach the database.
func ariaEpisodes(n int) []bangumi.Episode {
	eps := make([]bangumi.Episode, 0, n)
	for i := 1; i <= n; i++ {
		eps = append(eps, bangumi.Episode{
			Sort:   float64(i),
			Type:   0,
			Name:   "ARIA episode",
			NameCN: "水星领航员 一集",
		})
	}
	return eps
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeEpisodesBangumi is a programmable EpisodesBgmSubjectClient.
type fakeEpisodesBangumi struct {
	mu sync.Mutex

	subjectFn  func(ctx context.Context, bgmID int) (*bangumi.Subject, error)
	episodesFn func(ctx context.Context, bgmID int) (*bangumi.EpisodesResponse, error)

	subjectCalls  int
	episodesCalls int
}

func (f *fakeEpisodesBangumi) Subject(ctx context.Context, bgmID int) (*bangumi.Subject, error) {
	f.mu.Lock()
	f.subjectCalls++
	fn := f.subjectFn
	f.mu.Unlock()
	if fn == nil {
		return &bangumi.Subject{ID: bgmID}, nil
	}
	return fn(ctx, bgmID)
}

func (f *fakeEpisodesBangumi) Episodes(ctx context.Context, bgmID int) (*bangumi.EpisodesResponse, error) {
	f.mu.Lock()
	f.episodesCalls++
	fn := f.episodesFn
	f.mu.Unlock()
	if fn == nil {
		return &bangumi.EpisodesResponse{}, nil
	}
	return fn(ctx, bgmID)
}

// episodeTitleWrite records one UpsertEpisodeTitle call.
type episodeTitleWrite struct {
	animeID int32
	episode int32
	nameCN  *string
	name    *string
}

// countWrite records one UpdateEpisodesBgm call.
type countWrite struct {
	count     *int32
	anilistID int32
	bgmID     *int32
}

// stampWrite records one MarkEpisodesBgmAttempted call.
type stampWrite struct {
	outcome   string
	reason    *string
	anilistID int32
	bgmID     *int32
}

// fakeEpisodesBgmDB is the per-row worker's write surface, PLUS several
// methods the worker has no business calling.
//
// The extra methods are the test's real subject.  This worker was split out of
// BangumiV2Worker specifically so that filling one integer would not re-open
// bangumi_score, title_chinese, description_cn or the AniList main row, and
// nothing in the type system stops a future edit from reaching for them.
// Exposing them here — and asserting they stay at zero — is what turns that
// design decision into something a test can hold.
type fakeEpisodesBgmDB struct {
	mu sync.Mutex

	gateFn   func(ctx context.Context, anilistID int32) (dbgen.GetEpisodesBgmGateInputsRow, error)
	updateFn func(ctx context.Context, count *int32, anilistID int32, bgmID *int32) (int64, error)
	stampFn  func(ctx context.Context, outcome string, reason *string, anilistID int32, bgmID *int32) (int64, error)
	titleFn  func(ctx context.Context, animeID int32, episode int32, nameCN, name *string) error

	gateCalls   []int32
	countWrites []countWrite
	stamps      []stampWrite
	titles      []episodeTitleWrite

	// Writes this worker must never make.
	forbiddenWrites int
}

func (f *fakeEpisodesBgmDB) GetEpisodesBgmGateInputs(ctx context.Context, anilistID int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
	f.mu.Lock()
	f.gateCalls = append(f.gateCalls, anilistID)
	fn := f.gateFn
	f.mu.Unlock()
	if fn == nil {
		return dbgen.GetEpisodesBgmGateInputsRow{}, nil
	}
	return fn(ctx, anilistID)
}

func (f *fakeEpisodesBgmDB) UpdateEpisodesBgm(ctx context.Context, count *int32, anilistID int32, bgmID *int32) (int64, error) {
	f.mu.Lock()
	f.countWrites = append(f.countWrites, countWrite{count: count, anilistID: anilistID, bgmID: bgmID})
	fn := f.updateFn
	f.mu.Unlock()
	if fn == nil {
		return 1, nil
	}
	return fn(ctx, count, anilistID, bgmID)
}

func (f *fakeEpisodesBgmDB) MarkEpisodesBgmAttempted(ctx context.Context, outcome string, reason *string, anilistID int32, bgmID *int32) (int64, error) {
	f.mu.Lock()
	f.stamps = append(f.stamps, stampWrite{outcome: outcome, reason: reason, anilistID: anilistID, bgmID: bgmID})
	fn := f.stampFn
	f.mu.Unlock()
	if fn == nil {
		return 1, nil
	}
	return fn(ctx, outcome, reason, anilistID, bgmID)
}

func (f *fakeEpisodesBgmDB) UpsertEpisodeTitle(ctx context.Context, animeID int32, episode int32, nameCN, name *string) error {
	f.mu.Lock()
	f.titles = append(f.titles, episodeTitleWrite{animeID: animeID, episode: episode, nameCN: nameCN, name: name})
	fn := f.titleFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, animeID, episode, nameCN, name)
}

// --- the surface this worker must never touch ---

func (f *fakeEpisodesBgmDB) UpdateBangumiV2(_ context.Context, _ int32, _ *float64, _ *int32, _ *string) error {
	f.mu.Lock()
	f.forbiddenWrites++
	f.mu.Unlock()
	return nil
}

func (f *fakeEpisodesBgmDB) UpdateBangumiV3(_ context.Context, _ int32, _ *string) error {
	f.mu.Lock()
	f.forbiddenWrites++
	f.mu.Unlock()
	return nil
}

func (f *fakeEpisodesBgmDB) UpdateDescriptionCn(_ context.Context, _ *string, _ int32, _ *int32) error {
	f.mu.Lock()
	f.forbiddenWrites++
	f.mu.Unlock()
	return nil
}

func (f *fakeEpisodesBgmDB) UpsertAnimeCache(_ context.Context, _ dbgen.UpsertAnimeCacheParams) error {
	f.mu.Lock()
	f.forbiddenWrites++
	f.mu.Unlock()
	return nil
}

func (f *fakeEpisodesBgmDB) snapshot() (counts []countWrite, stamps []stampWrite, titles []episodeTitleWrite, forbidden int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	counts = append(counts, f.countWrites...)
	stamps = append(stamps, f.stamps...)
	titles = append(titles, f.titles...)
	return counts, stamps, titles, f.forbiddenWrites
}

// fakeEpisodesBgmReader is a programmable candidate query.  Every call's params
// are recorded because the cooldowns are a termination property, not a detail:
// a sweep whose candidate query lost them stalls, and the stall is invisible
// from the outside (a full batch submitted every hour, none of it new).
type fakeEpisodesBgmReader struct {
	mu     sync.Mutex
	listFn func(ctx context.Context, arg dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error)
	args   []dbgen.ListEpisodesBgmCandidatesParams
}

func (f *fakeEpisodesBgmReader) ListEpisodesBgmCandidates(ctx context.Context, arg dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
	f.mu.Lock()
	f.args = append(f.args, arg)
	fn := f.listFn
	f.mu.Unlock()
	if fn == nil {
		return []dbgen.ListEpisodesBgmCandidatesRow{}, nil
	}
	return fn(ctx, arg)
}

func (f *fakeEpisodesBgmReader) snapshotArgs() []dbgen.ListEpisodesBgmCandidatesParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]dbgen.ListEpisodesBgmCandidatesParams, len(f.args))
	copy(dup, f.args)
	return dup
}

// fakeEpisodesBgmEnq records the batches the scan handed over.
type fakeEpisodesBgmEnq struct {
	mu        sync.Mutex
	enqueueFn func(ctx context.Context, jobs []EpisodesBgmArgs) error
	batches   [][]EpisodesBgmArgs
}

func (f *fakeEpisodesBgmEnq) EnqueueEpisodesBgmMany(ctx context.Context, jobs []EpisodesBgmArgs) error {
	dup := make([]EpisodesBgmArgs, len(jobs))
	copy(dup, jobs)
	f.mu.Lock()
	f.batches = append(f.batches, dup)
	fn := f.enqueueFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, jobs)
}

func (f *fakeEpisodesBgmEnq) snapshotBatches() [][]EpisodesBgmArgs {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([][]EpisodesBgmArgs, len(f.batches))
	copy(dup, f.batches)
	return dup
}

// runEpisodesBgm dispatches one per-row job through Work().
func runEpisodesBgm(t *testing.T, b EpisodesBgmSubjectClient, db EpisodesBgmWriter, anilistID, bgmID int) error {
	t.Helper()
	w := NewEpisodesBgmWorker(b, db)
	return w.Work(t.Context(), &river.Job[EpisodesBgmArgs]{
		Args: EpisodesBgmArgs{AnilistID: anilistID, BgmID: bgmID},
	})
}

// runEpisodesBgmScan dispatches the periodic scan through Work().
func runEpisodesBgmScan(t *testing.T, db EpisodesBgmReader, enq EpisodesBgmEnqueuer) error {
	t.Helper()
	w := NewEpisodesBgmScanWorker(db, enq)
	return w.Work(t.Context(), &river.Job[EpisodesBgmScanArgs]{Args: EpisodesBgmScanArgs{}})
}

// ---------------------------------------------------------------------------
// The identity gate
// ---------------------------------------------------------------------------

// The regression this whole gate exists for.  anilist 212309 is Transformers:
// Wild King W; bgm 1269 is Aria the Natural.  With no match source recorded and
// no id-map agreement, the only thing standing between Aria's 26 Chinese
// episode titles and a public page is the title comparison.
func TestEvaluateBinding_RejectsProductionMisbinding(t *testing.T) {
	t.Parallel()

	v := evaluateBinding(misboundGate(), misboundSubjectName)

	assert.Equal(t, episodesBgmRejected, v.outcome,
		"anilist %d bound to bgm %d must be rejected: the subject names a different work",
		misboundAnilistID, misboundBgmID)
	assert.NotEmpty(t, v.reason, "a rejection has to say why; the reason column is the only forensic trail")
}

// The comparison the gate must NEVER make, asserted rather than described.
//
// A gate that compared Bangumi's name_cn against our title_chinese would look
// entirely reasonable — both are Chinese, so it is the obvious pairing — and it
// would pass this mis-binding with a perfect score, because earlier enrichment
// has already overwritten title_chinese with the wrong show's Chinese name.  It
// would validate the error with the error.  That is why
// GetEpisodesBgmGateInputs does not return the column at all.
func TestEvaluateBinding_PollutedChineseTitleWouldValidateTheError(t *testing.T) {
	t.Parallel()

	poisoned := titlematch.BestSimilarity(misboundSubjectNameCN, misboundPollutedTitleChinese)
	require.GreaterOrEqual(t, poisoned, titlematch.SimilarityFloor,
		"fixture no longer demonstrates the trap: name_cn vs the polluted title_chinese must score ABOVE the floor")

	honest := titlematch.BestSimilarity(misboundSubjectName, misboundTitleNative, misboundTitleRomaji)
	assert.Less(t, honest, titlematch.SimilarityFloor,
		"the AniList-side comparison the gate actually makes must score BELOW the floor")
	assert.Greater(t, poisoned, honest,
		"the polluted comparison must be the more attractive one — that is what makes it a trap")
}

// An admin override outranks similarity, and must not be second-guessed by a
// title comparison: legitimate bindings include localised titles and renames
// between broadcast and release that no similarity score forgives.
func TestEvaluateBinding_ManualSourceAcceptedWithoutComparison(t *testing.T) {
	t.Parallel()

	gate := misboundGate()
	gate.BgmMatchSource = ptr("manual")

	v := evaluateBinding(gate, misboundSubjectName)

	assert.Equal(t, episodesBgmOK, v.outcome,
		"bgm_match_source='manual' is a human decision and outranks the matcher")
}

// The vendored id map agreeing on this exact pair is independent confirmation,
// and accepted for the same reason as a manual binding.
func TestEvaluateBinding_IdMapAgreementAcceptedWithoutComparison(t *testing.T) {
	t.Parallel()

	gate := misboundGate()
	gate.IDMapAgrees = true

	v := evaluateBinding(gate, misboundSubjectName)

	assert.Equal(t, episodesBgmOK, v.outcome,
		"an independent authority agreeing on the pair outranks the matcher")
}

// Similarity and season are two independent signals, and this is the case that
// proves the second one is load-bearing: NormalizeTitle strips season markers,
// so consecutive seasons of one franchise score far above the floor against
// each other and no threshold can separate them.
func TestEvaluateBinding_SeasonMismatchRejectedDespiteHighSimilarity(t *testing.T) {
	t.Parallel()

	const (
		ourTitle     = "無職転生Ⅱ ～異世界行ったら本気だす～"
		subjectTitle = "無職転生Ⅲ ～異世界行ったら本気だす～"
	)

	// Guard the premise: if these ever stop scoring above the floor, this test
	// would pass for the wrong reason and stop covering the season gate.
	require.GreaterOrEqual(t, titlematch.BestSimilarity(subjectTitle, ourTitle), titlematch.SimilarityFloor,
		"fixture no longer demonstrates the two-signal split: similarity alone must NOT separate these")

	gate := dbgen.GetEpisodesBgmGateInputsRow{
		BgmID:       ptr(int32(1)),
		TitleNative: ptr(ourTitle),
		TitleRomaji: ptr("Mushoku Tensei II"),
	}

	v := evaluateBinding(gate, subjectTitle)

	assert.Equal(t, episodesBgmRejected, v.outcome,
		"a season-3 subject must not satisfy a season-2 row however similar the titles read")
}

// A matching native title with agreeing (unstated) season markers is the
// ordinary accept.
func TestEvaluateBinding_AcceptsMatchingNativeTitle(t *testing.T) {
	t.Parallel()

	gate := dbgen.GetEpisodesBgmGateInputsRow{
		BgmID:       ptr(int32(1)),
		TitleNative: ptr("進撃の巨人"),
		TitleRomaji: ptr("Shingeki no Kyojin"),
	}

	v := evaluateBinding(gate, "進撃の巨人")

	assert.Equal(t, episodesBgmOK, v.outcome)
	assert.Empty(t, v.reason, "an accept has nothing to explain")
}

// The grey zone.  With no native title the only comparison available is romaji
// against a subject named in another script, where a perfectly good binding
// scores near zero — so a low score there is absence of evidence, not evidence
// of a wrong binding, and must not be recorded as a rejection.
func TestEvaluateBinding_UndecidedWhenNoNativeTitleToCompare(t *testing.T) {
	t.Parallel()

	gate := dbgen.GetEpisodesBgmGateInputsRow{
		BgmID:       ptr(int32(1)),
		TitleNative: nil,
		TitleRomaji: ptr("Shingeki no Kyojin"),
	}

	v := evaluateBinding(gate, "進撃の巨人")

	assert.Equal(t, episodesBgmUndecided, v.outcome,
		"romaji-versus-kanji scoring low proves nothing; recording it as 'rejected' would freeze a good row for 90 days")
	assert.NotEmpty(t, v.reason)
}

// Positive evidence still accepts even without a native title: a romaji match
// that also agrees on season is a match.
func TestEvaluateBinding_RomajiMatchAcceptedWithoutNativeTitle(t *testing.T) {
	t.Parallel()

	gate := dbgen.GetEpisodesBgmGateInputsRow{
		BgmID:       ptr(int32(1)),
		TitleNative: nil,
		TitleRomaji: ptr("Sousou no Frieren"),
	}

	v := evaluateBinding(gate, "Sousou no Frieren")

	assert.Equal(t, episodesBgmOK, v.outcome)
}

func TestEvaluateBinding_UndecidedWhenNothingToCompare(t *testing.T) {
	t.Parallel()

	t.Run("subject has no name", func(t *testing.T) {
		t.Parallel()
		v := evaluateBinding(misboundGate(), "   ")
		assert.Equal(t, episodesBgmUndecided, v.outcome)
		assert.NotEmpty(t, v.reason)
	})

	t.Run("row has no titles", func(t *testing.T) {
		t.Parallel()
		gate := dbgen.GetEpisodesBgmGateInputsRow{
			BgmID:       ptr(int32(1)),
			TitleNative: ptr("  "),
			TitleRomaji: nil,
		}
		v := evaluateBinding(gate, "進撃の巨人")
		assert.Equal(t, episodesBgmUndecided, v.outcome)
		assert.NotEmpty(t, v.reason)
	})
}

// A map entry naming a DIFFERENT bgm_id is evidence against the binding and
// must not read as confirmation of it.  IDMapAgrees is computed on the pair, so
// such a row arrives here with the flag false and falls through to the
// comparison — which is what this pins.
func TestEvaluateBinding_ContradictingIdMapDoesNotConfirm(t *testing.T) {
	t.Parallel()

	gate := misboundGate()
	gate.IDMapAgrees = false // the map lists 212309 -> some OTHER bgm_id

	v := evaluateBinding(gate, misboundSubjectName)

	assert.Equal(t, episodesBgmRejected, v.outcome,
		"a map that disagrees is evidence against the binding, never for it")
}

// ---------------------------------------------------------------------------
// The per-row worker
// ---------------------------------------------------------------------------

// THE regression test.  Not just "the verdict is rejected" — the assertion that
// matters operationally is that the run produced no count and not one episode
// title row, because a single UpsertEpisodeTitle here puts Aria's Chinese
// episode name on Transformers' indexed page and ON CONFLICT DO UPDATE means
// nothing later shortens the list back.
func TestEpisodesBgmWorker_MisbindingWritesNothing(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmDB{
		gateFn: func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
			return misboundGate(), nil
		},
	}
	bgm := &fakeEpisodesBangumi{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return &bangumi.Subject{
				ID:     misboundBgmID,
				Name:   misboundSubjectName,
				NameCN: misboundSubjectNameCN,
			}, nil
		},
		episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
			return &bangumi.EpisodesResponse{Eps: ariaEpisodes(26)}, nil
		},
	}

	err := runEpisodesBgm(t, bgm, db, misboundAnilistID, misboundBgmID)
	require.NoError(t, err, "a refused binding is a decided outcome, not a job failure")

	counts, stamps, titles, forbidden := db.snapshot()

	assert.Empty(t, counts, "episodes_bgm must not be written for a refused binding")
	assert.Empty(t, titles, "not one episode title row may be written for a refused binding")
	assert.Zero(t, forbidden, "the worker must not touch any other enrichment column")

	require.Len(t, stamps, 1, "the row must be stamped so the sweep can move past it")
	assert.Equal(t, string(episodesBgmRejected), stamps[0].outcome)
	assert.Equal(t, int32(misboundAnilistID), stamps[0].anilistID)
	require.NotNil(t, stamps[0].bgmID)
	assert.Equal(t, int32(misboundBgmID), *stamps[0].bgmID,
		"the stamp must be pinned to the binding it judged, not to whatever the row holds now")
	require.NotNil(t, stamps[0].reason)
	assert.NotEmpty(t, *stamps[0].reason)
}

func TestEpisodesBgmWorker_AcceptedBindingWritesCountAndTitles(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmDB{
		gateFn: func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
			return dbgen.GetEpisodesBgmGateInputsRow{
				BgmID:          ptr(int32(400602)),
				BgmMatchSource: ptr("id_map"),
				TitleNative:    ptr("葬送のフリーレン"),
				TitleRomaji:    ptr("Sousou no Frieren"),
				IDMapAgrees:    true,
			}, nil
		},
	}
	bgm := &fakeEpisodesBangumi{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return &bangumi.Subject{ID: 400602, Name: "葬送のフリーレン"}, nil
		},
		episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
			return &bangumi.EpisodesResponse{Eps: []bangumi.Episode{
				{Sort: 1, Type: 0, Name: "ep1", NameCN: "第一集"},
				{Sort: 2, Type: 0, Name: "ep2"},
				{Sort: 3, Type: 0},
				{Sort: 1, Type: 1, Name: "SP"}, // must be dropped
			}}, nil
		},
	}

	require.NoError(t, runEpisodesBgm(t, bgm, db, 154587, 400602))

	counts, stamps, titles, forbidden := db.snapshot()

	require.Len(t, counts, 1)
	require.NotNil(t, counts[0].count)
	assert.Equal(t, int32(3), *counts[0].count)
	require.NotNil(t, counts[0].bgmID)
	assert.Equal(t, int32(400602), *counts[0].bgmID,
		"the write must be pinned to the binding the job fetched")

	assert.Len(t, titles, 3, "the SP must not become an episode title row")
	assert.Empty(t, stamps, "a successful write stamps the attempt in the same statement, not separately")
	assert.Zero(t, forbidden)
}

// The payload is never the authority.  A rebind landing between scan and work
// must void the run entirely — no fetch, no write, and crucially no stamp,
// because the verdict would be about a binding this row no longer holds.
func TestEpisodesBgmWorker_BindingChangedUnderneathDiscardsRun(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmDB{
		gateFn: func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
			return dbgen.GetEpisodesBgmGateInputsRow{BgmID: ptr(int32(999999))}, nil
		},
	}
	bgm := &fakeEpisodesBangumi{}

	require.NoError(t, runEpisodesBgm(t, bgm, db, misboundAnilistID, misboundBgmID))

	counts, stamps, titles, _ := db.snapshot()
	assert.Empty(t, counts)
	assert.Empty(t, titles)
	assert.Empty(t, stamps, "stamping here would file a conclusion about the OLD binding against the new one")
	assert.Zero(t, bgm.subjectCalls, "a voided run must not spend upstream budget")
	assert.Zero(t, bgm.episodesCalls)
}

// A row whose bgm_id has been cleared entirely (an admin reset) is the same
// case: nothing to fetch, nothing to conclude.
func TestEpisodesBgmWorker_NullBgmIdDiscardsRun(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmDB{
		gateFn: func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
			return dbgen.GetEpisodesBgmGateInputsRow{BgmID: nil}, nil
		},
	}
	bgm := &fakeEpisodesBangumi{}

	require.NoError(t, runEpisodesBgm(t, bgm, db, misboundAnilistID, misboundBgmID))

	counts, stamps, titles, _ := db.snapshot()
	assert.Empty(t, counts)
	assert.Empty(t, titles)
	assert.Empty(t, stamps)
	assert.Zero(t, bgm.subjectCalls)
}

func TestEpisodesBgmWorker_EmptyEpisodeListIsADecidedOutcome(t *testing.T) {
	t.Parallel()

	acceptGate := func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
		return dbgen.GetEpisodesBgmGateInputsRow{
			BgmID:       ptr(int32(7)),
			IDMapAgrees: true,
		}, nil
	}

	t.Run("upstream returns no episodes", func(t *testing.T) {
		t.Parallel()
		db := &fakeEpisodesBgmDB{gateFn: acceptGate}
		bgm := &fakeEpisodesBangumi{
			subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
				return &bangumi.Subject{ID: 7, Name: "x"}, nil
			},
		}

		require.NoError(t, runEpisodesBgm(t, bgm, db, 1, 7))

		counts, stamps, titles, _ := db.snapshot()
		assert.Empty(t, counts)
		assert.Empty(t, titles)
		require.Len(t, stamps, 1)
		assert.Equal(t, string(episodesBgmEmpty), stamps[0].outcome,
			"'empty' is a correct answer that yields nothing, and must stay distinguishable from a refusal")
	})

	t.Run("episode endpoint 404s but the subject exists", func(t *testing.T) {
		t.Parallel()
		db := &fakeEpisodesBgmDB{gateFn: acceptGate}
		bgm := &fakeEpisodesBangumi{
			subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
				return &bangumi.Subject{ID: 7, Name: "x"}, nil
			},
			episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
				return nil, bangumi.ErrNotFound
			},
		}

		require.NoError(t, runEpisodesBgm(t, bgm, db, 1, 7))

		_, stamps, _, _ := db.snapshot()
		require.Len(t, stamps, 1)
		assert.Equal(t, string(episodesBgmEmpty), stamps[0].outcome)
	})

	t.Run("only specials, no main episodes", func(t *testing.T) {
		t.Parallel()
		db := &fakeEpisodesBgmDB{gateFn: acceptGate}
		bgm := &fakeEpisodesBangumi{
			subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
				return &bangumi.Subject{ID: 7, Name: "x"}, nil
			},
			episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
				return &bangumi.EpisodesResponse{Eps: []bangumi.Episode{
					{Sort: 1, Type: 1, Name: "SP"},
					{Sort: 2, Type: 6, Name: "PV"},
				}}, nil
			},
		}

		require.NoError(t, runEpisodesBgm(t, bgm, db, 1, 7))

		counts, stamps, titles, _ := db.snapshot()
		assert.Empty(t, counts)
		assert.Empty(t, titles)
		require.Len(t, stamps, 1)
		assert.Equal(t, string(episodesBgmEmpty), stamps[0].outcome)
	})
}

// A subject the binding points at that Bangumi does not have is a decided,
// negative finding about the binding — not a transient failure.
func TestEpisodesBgmWorker_SubjectNotFoundIsRejected(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmDB{
		gateFn: func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
			return dbgen.GetEpisodesBgmGateInputsRow{BgmID: ptr(int32(7)), IDMapAgrees: true}, nil
		},
	}
	bgm := &fakeEpisodesBangumi{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, bangumi.ErrNotFound
		},
	}

	require.NoError(t, runEpisodesBgm(t, bgm, db, 1, 7))

	counts, stamps, titles, _ := db.snapshot()
	assert.Empty(t, counts)
	assert.Empty(t, titles)
	require.Len(t, stamps, 1)
	assert.Equal(t, string(episodesBgmRejected), stamps[0].outcome)
}

// A transport failure says nothing about the row.  Stamping it would file a
// wedged upstream as a decided outcome and put the row behind a cooldown; river
// retrying is the correct handling, so the job must error and NOT stamp.
func TestEpisodesBgmWorker_TransportErrorRetriesWithoutStamping(t *testing.T) {
	t.Parallel()

	boom := errors.New("connection reset")
	db := &fakeEpisodesBgmDB{
		gateFn: func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
			return dbgen.GetEpisodesBgmGateInputsRow{BgmID: ptr(int32(7)), IDMapAgrees: true}, nil
		},
	}
	bgm := &fakeEpisodesBangumi{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) { return nil, boom },
	}

	err := runEpisodesBgm(t, bgm, db, 1, 7)

	require.Error(t, err, "a transient upstream failure must be returned so river retries it")
	assert.ErrorIs(t, err, boom)

	counts, stamps, titles, _ := db.snapshot()
	assert.Empty(t, stamps, "stamping a timeout would put the row behind a cooldown for an upstream problem")
	assert.Empty(t, counts)
	assert.Empty(t, titles)
}

// The bgm_id pin in the UPDATE is the last defence against a rebind that landed
// after the gate read.  Zero rows affected means it fired, and the episode
// titles that would have followed belong to a binding the row no longer holds.
func TestEpisodesBgmWorker_ZeroRowCountWriteSkipsTitles(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmDB{
		gateFn: func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
			return dbgen.GetEpisodesBgmGateInputsRow{BgmID: ptr(int32(7)), IDMapAgrees: true}, nil
		},
		updateFn: func(_ context.Context, _ *int32, _ int32, _ *int32) (int64, error) {
			return 0, nil
		},
	}
	bgm := &fakeEpisodesBangumi{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return &bangumi.Subject{ID: 7, Name: "x"}, nil
		},
		episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
			return &bangumi.EpisodesResponse{Eps: []bangumi.Episode{{Sort: 1, Type: 0, NameCN: "第一集"}}}, nil
		},
	}

	require.NoError(t, runEpisodesBgm(t, bgm, db, 1, 7))

	_, _, titles, _ := db.snapshot()
	assert.Empty(t, titles, "no titles may follow a count write that matched no row")
}

// Both fetches happen, and exactly once each.  The subject is not optional
// decoration: without its name the gate has nothing to compare, so a change
// that "optimised" it away would silently disable the whole guard.
func TestEpisodesBgmWorker_FetchesSubjectAndEpisodesOnceEach(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmDB{
		gateFn: func(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
			return dbgen.GetEpisodesBgmGateInputsRow{BgmID: ptr(int32(7)), IDMapAgrees: true}, nil
		},
	}
	bgm := &fakeEpisodesBangumi{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return &bangumi.Subject{ID: 7, Name: "x"}, nil
		},
		episodesFn: func(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
			return &bangumi.EpisodesResponse{Eps: []bangumi.Episode{{Sort: 1, Type: 0}}}, nil
		},
	}

	require.NoError(t, runEpisodesBgm(t, bgm, db, 1, 7))

	assert.Equal(t, 1, bgm.subjectCalls, "the gate needs the subject's name; dropping this fetch disables the guard")
	assert.Equal(t, 1, bgm.episodesCalls)
}

// ---------------------------------------------------------------------------
// Count derivation
// ---------------------------------------------------------------------------

func TestEpisodesBgmCount_UsesHighestNumberNotEntryCount(t *testing.T) {
	t.Parallel()

	t.Run("gaps in the list", func(t *testing.T) {
		t.Parallel()
		// Bangumi lists skip numbers.  Four entries, largest 7 — a grid sized
		// by len() would stop at 4 and cut off the tail.
		titles := normalizeEpisodeTitles([]bangumi.Episode{
			{Sort: 1, Type: 0}, {Sort: 2, Type: 0}, {Sort: 3, Type: 0}, {Sort: 7, Type: 0},
		})
		require.Len(t, titles, 4)
		assert.Equal(t, int32(7), episodesBgmCount(titles),
			"len() would truncate the grid at 4 and hide episodes 5-7")
	})

	t.Run("rounding collision", func(t *testing.T) {
		t.Parallel()
		// Sort is a float and normalizeEpisodeTitles rounds it, so 32.5 and 33
		// both land on the same episode number.  Five entries, four distinct
		// episodes; the (anime_id, episode) primary key dedupes the rows and
		// len() would over-count.
		titles := normalizeEpisodeTitles([]bangumi.Episode{
			{Sort: 29, Type: 0}, {Sort: 30, Type: 0}, {Sort: 31, Type: 0},
			{Sort: 32.5, Type: 0}, {Sort: 33, Type: 0},
		})
		require.Len(t, titles, 5)
		assert.Equal(t, titles[3].episode, titles[4].episode, "fixture must actually collide")
		assert.Equal(t, int32(5), episodesBgmCount(titles), "len() would claim 5 distinct episodes when there are 4")
	})

	t.Run("sequel offset normalised to 1", func(t *testing.T) {
		t.Parallel()
		// A sequel whose episodes start at 29 maps to 1..N, matching AniList's
		// per-season numbering.
		titles := normalizeEpisodeTitles([]bangumi.Episode{
			{Sort: 29, Type: 0}, {Sort: 30, Type: 0}, {Sort: 31, Type: 0},
		})
		require.Len(t, titles, 3)
		assert.Equal(t, int32(1), titles[0].episode)
		assert.Equal(t, int32(3), episodesBgmCount(titles))
	})

	t.Run("empty list", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, int32(0), episodesBgmCount(nil))
	})
}

// ---------------------------------------------------------------------------
// Scan worker
// ---------------------------------------------------------------------------

func TestEpisodesBgmScan_MapsRowsToJobs(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmReader{
		listFn: func(_ context.Context, _ dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
			return []dbgen.ListEpisodesBgmCandidatesRow{
				{AnilistID: 1, BgmID: ptr(int32(11))},
				{AnilistID: 2, BgmID: ptr(int32(22))},
			}, nil
		},
	}
	enq := &fakeEpisodesBgmEnq{}

	require.NoError(t, runEpisodesBgmScan(t, db, enq))

	batches := enq.snapshotBatches()
	require.Len(t, batches, 1)
	assert.Equal(t, []EpisodesBgmArgs{
		{AnilistID: 1, BgmID: 11},
		{AnilistID: 2, BgmID: 22},
	}, batches[0])
}

// The candidate query is where the sweep's ability to terminate lives, so the
// scan has to be passing it a full set of cooldowns and a bounded batch.  A
// zero interval would silently restore the stall migration 0023 exists to
// prevent — every decided row back at the front of the next batch.
func TestEpisodesBgmScan_PassesEveryCooldownAndABoundedBatch(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmReader{}
	require.NoError(t, runEpisodesBgmScan(t, db, &fakeEpisodesBgmEnq{}))

	args := db.snapshotArgs()
	require.Len(t, args, 1)
	a := args[0]

	assert.Equal(t, episodesBgmScanBatchSize, a.RowLimit, "an unbounded batch would spend the whole shared request budget in one pass")
	assert.Empty(t, a.AnilistIds, "the hourly sweep must not narrow to any id subset")
	assert.NotNil(t, a.AnilistIds, "a nil array makes cardinality() NULL and the id filter never true")

	assert.True(t, a.AiringRecheck.Valid && a.AiringRecheck.Microseconds > 0,
		"airing rows must have a re-check bound")
	assert.True(t, a.UndecidedRetry.Valid && a.UndecidedRetry.Days > 0,
		"undecided rows without a cooldown hold the front of every batch forever")
	assert.True(t, a.RejectedRetry.Valid && a.RejectedRetry.Days > 0,
		"rejected rows without a cooldown hold the front of every batch forever")
	assert.True(t, a.ErrorRetry.Valid && a.ErrorRetry.Days > 0,
		"the 'error' arm exists so a row stamped with a CHECK-legal value cannot freeze")
}

func TestEpisodesBgmScan_SkipsRowsWithoutBgmID(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodesBgmReader{
		listFn: func(_ context.Context, _ dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
			return []dbgen.ListEpisodesBgmCandidatesRow{
				{AnilistID: 1, BgmID: nil},
				{AnilistID: 2, BgmID: ptr(int32(22))},
			}, nil
		},
	}
	enq := &fakeEpisodesBgmEnq{}

	require.NoError(t, runEpisodesBgmScan(t, db, enq))

	batches := enq.snapshotBatches()
	require.Len(t, batches, 1)
	assert.Equal(t, []EpisodesBgmArgs{{AnilistID: 2, BgmID: 22}}, batches[0],
		"a NULL bgm_id must be skipped, not dereferenced — the query filters them, so one arriving means drift")
}

func TestEpisodesBgmScan_EmptyCandidateSetIsSuccess(t *testing.T) {
	t.Parallel()

	enq := &fakeEpisodesBgmEnq{}
	require.NoError(t, runEpisodesBgmScan(t, &fakeEpisodesBgmReader{}, enq))
	assert.Empty(t, enq.snapshotBatches(), "an empty sweep is the steady state, not an error")
}

func TestEpisodesBgmScan_ReadFailureIsRetried(t *testing.T) {
	t.Parallel()

	boom := errors.New("pool exhausted")
	db := &fakeEpisodesBgmReader{
		listFn: func(_ context.Context, _ dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
			return nil, boom
		},
	}

	err := runEpisodesBgmScan(t, db, &fakeEpisodesBgmEnq{})
	require.Error(t, err)
	assert.ErrorIs(t, err, boom)
}

func TestEpisodesBgmScan_EnqueueFailureIsRetried(t *testing.T) {
	t.Parallel()

	boom := errors.New("river down")
	db := &fakeEpisodesBgmReader{
		listFn: func(_ context.Context, _ dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
			return []dbgen.ListEpisodesBgmCandidatesRow{{AnilistID: 1, BgmID: ptr(int32(11))}}, nil
		},
	}
	enq := &fakeEpisodesBgmEnq{
		enqueueFn: func(_ context.Context, _ []EpisodesBgmArgs) error { return boom },
	}

	err := runEpisodesBgmScan(t, db, enq)
	require.Error(t, err)
	assert.ErrorIs(t, err, boom)
}

// ---------------------------------------------------------------------------
// Cooldown shape
// ---------------------------------------------------------------------------

// The cooldowns are the corrected predicate's whole substance, so their
// RELATIVE ordering is pinned rather than just their values.  A future edit
// that made a rejection re-check as often as an airing row would quietly turn
// a permanent finding into a daily upstream request.
func TestEpisodesBgmCooldownsAreOrdered(t *testing.T) {
	t.Parallel()

	assert.Less(t, episodesBgmAiringRecheck, 24*time.Hour,
		"a >=24h cooldown against an hourly sweep drifts later every day and eventually skips one")

	assert.Greater(t, episodesBgmRejectedRetryDays, episodesBgmUndecidedRetryDays,
		"a positive finding that the binding is wrong should sit out longer than an inconclusive one")
	assert.Greater(t, episodesBgmUndecidedRetryDays, episodesBgmErrorRetryDays,
		"an inconclusive verdict should sit out longer than a transport hiccup")
	assert.Positive(t, episodesBgmErrorRetryDays,
		"every value the 0023 CHECK admits needs a non-zero cooldown or a row carrying it freezes")
}

func TestEpisodesBgmScanIntervalIsHourly(t *testing.T) {
	t.Parallel()

	assert.Equal(t, time.Hour, episodesBgmScanInterval)
	assert.Positive(t, episodesBgmScanBatchSize)
	assert.Less(t, episodesBgmScanBatchSize, descriptionBackfillScanBatchSize,
		"each row here costs two upstream requests, so the batch must be smaller than the single-request sweep's")
}

// ---------------------------------------------------------------------------
// Periodic job
// ---------------------------------------------------------------------------

// Prevents: RunOnStart quietly reverting to river's default.
//
// River's OSS scheduler does not persist periodic schedules — it recomputes the
// next run as now+period on every Start — so with RunOnStart=false every deploy
// pushes the sweep a full hour out, and a day with several deploys can produce
// no sweep at all.
//
// Read via reflection because river keeps PeriodicJob's fields unexported and
// exposes no accessor.  That couples this test to river's internals on purpose:
// river is version-pinned, so an upgrade that reshapes PeriodicJob should stop
// and make somebody re-confirm this rather than silently carry an unverified
// assumption forward.
func TestPeriodicEpisodesBgmScanJobRunsOnStart(t *testing.T) {
	t.Parallel()

	job := PeriodicEpisodesBgmScanJob()
	require.NotNil(t, job)

	optsField := reflect.ValueOf(job).Elem().FieldByName("opts")
	require.True(t, optsField.IsValid(),
		"river.PeriodicJob no longer has an `opts` field — re-verify the sweep still runs at boot")
	require.False(t, optsField.IsNil(),
		"nil opts means RunOnStart=false, which lets a redeploying service never sweep")

	runOnStart := optsField.Elem().FieldByName("RunOnStart")
	require.True(t, runOnStart.IsValid(),
		"river.PeriodicJobOpts no longer has RunOnStart — re-verify what the sweep does at boot")
	assert.True(t, runOnStart.Bool(),
		"river recomputes the next run on every Start, so RunOnStart=false can mean the sweep never fires")
}

// Both halves have to be registered together.  A scan with no per-row worker
// enqueues jobs nothing can run; a per-row worker with no scan is never fed.
// Either way the symptom is a queue that quietly does nothing.
func TestAddEpisodesBgmWorkers_RegistersBothSlots(t *testing.T) {
	t.Parallel()

	w := river.NewWorkers()
	AddEpisodesBgmWorkers(w, &fakeEpisodesBangumi{}, noopEpisodesBgmDB{}, NoopEnqueuer{})

	err := river.AddWorkerSafely(w, NewEpisodesBgmScanWorker(noopEpisodesBgmDB{}, NoopEnqueuer{}))
	require.Error(t, err, "episodes_bgm_scan slot should already be occupied")
	assert.Contains(t, err.Error(), "episodes_bgm_scan")

	err = river.AddWorkerSafely(w, NewEpisodesBgmWorker(&fakeEpisodesBangumi{}, &fakeEpisodesBgmDB{}))
	require.Error(t, err, "episodes_bgm slot should already be occupied")
	assert.Contains(t, err.Error(), "episodes_bgm")
}

// noopEpisodesBgmDB satisfies EpisodesBgmDB for registration tests, which never
// invoke Work.
type noopEpisodesBgmDB struct{}

func (noopEpisodesBgmDB) ListEpisodesBgmCandidates(_ context.Context, _ dbgen.ListEpisodesBgmCandidatesParams) ([]dbgen.ListEpisodesBgmCandidatesRow, error) {
	return []dbgen.ListEpisodesBgmCandidatesRow{}, nil
}

func (noopEpisodesBgmDB) GetEpisodesBgmGateInputs(_ context.Context, _ int32) (dbgen.GetEpisodesBgmGateInputsRow, error) {
	return dbgen.GetEpisodesBgmGateInputsRow{}, nil
}

func (noopEpisodesBgmDB) UpdateEpisodesBgm(_ context.Context, _ *int32, _ int32, _ *int32) (int64, error) {
	return 0, nil
}

func (noopEpisodesBgmDB) MarkEpisodesBgmAttempted(_ context.Context, _ string, _ *string, _ int32, _ *int32) (int64, error) {
	return 0, nil
}

func (noopEpisodesBgmDB) UpsertEpisodeTitle(_ context.Context, _ int32, _ int32, _ *string, _ *string) error {
	return nil
}

// A double that is a valid Enqueuer but does NOT carry the episode-count
// method must degrade to a no-op seed rather than panicking a worker that is
// under test for something else.  That fallback is the price of keeping the
// method off the Enqueuer interface, and it is asserted rather than assumed.
func TestEpisodesBgmEnqueuerFrom_FallsBackToNoop(t *testing.T) {
	t.Parallel()

	assert.NotNil(t, episodesBgmEnqueuerFrom(enqueuerWithoutEpisodesBgm{}))
	require.NoError(t, episodesBgmEnqueuerFrom(enqueuerWithoutEpisodesBgm{}).
		EnqueueEpisodesBgmMany(context.Background(), []EpisodesBgmArgs{{AnilistID: 1, BgmID: 2}}))

	// And the production implementation must NOT take that fallback.
	lbe := &LateBoundEnqueuer{}
	assert.Same(t, lbe, episodesBgmEnqueuerFrom(lbe),
		"the production enqueuer must resolve to itself, not to the no-op fallback")
}

// enqueuerWithoutEpisodesBgm is an Enqueuer from before this capability
// existed — the shape every pre-existing test double has.
type enqueuerWithoutEpisodesBgm struct{}

func (enqueuerWithoutEpisodesBgm) EnqueueV1Many(context.Context, []int32) error { return nil }
func (enqueuerWithoutEpisodesBgm) EnqueueV2Many(context.Context, []BangumiV2Args) error {
	return nil
}
func (enqueuerWithoutEpisodesBgm) EnqueueV3Many(context.Context, []BangumiV3Args) error {
	return nil
}
func (enqueuerWithoutEpisodesBgm) EnqueueDescriptionBackfillMany(context.Context, []DescriptionBackfillArgs) error {
	return nil
}
func (enqueuerWithoutEpisodesBgm) EnqueueDescriptionLlmBackfillMany(context.Context, []DescriptionLlmBackfillArgs) error {
	return nil
}
func (enqueuerWithoutEpisodesBgm) EnqueueWarmSeasonNow(context.Context, WarmSeasonArgs) error {
	return nil
}
func (enqueuerWithoutEpisodesBgm) EnqueueHantBackfillNow(context.Context) (bool, error) {
	return false, nil
}
