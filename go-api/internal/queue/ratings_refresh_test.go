// Package queue — ratings_refresh_test.go
//
// The two sweeps are almost entirely bookkeeping: which rows get asked
// about, which get stamped, and which are deliberately left alone so the
// next pass sees them again.  Every test here is about one of those
// three, because a mistake in any of them is invisible in production —
// the sweep logs a cheerful summary either way and the only symptom is
// rows that quietly stop refreshing.
package queue

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// AniList doubles
// ---------------------------------------------------------------------------

type fakeAnilistRatingsDB struct {
	candidates []int32
	listErr    error

	gotYear  int32
	gotStale pgtype.Interval
	gotLimit int32

	updated map[int32]*int32 // anilistID → score votes written
	scores  map[int32]*float64
	stamped []int32
	updErr  error
}

func newFakeAnilistRatingsDB(ids ...int32) *fakeAnilistRatingsDB {
	return &fakeAnilistRatingsDB{
		candidates: ids,
		updated:    map[int32]*int32{},
		scores:     map[int32]*float64{},
	}
}

func (f *fakeAnilistRatingsDB) ListAnilistRatingCandidates(_ context.Context, year int32, stale pgtype.Interval, limit int32) ([]int32, error) {
	f.gotYear, f.gotStale, f.gotLimit = year, stale, limit
	return f.candidates, f.listErr
}

func (f *fakeAnilistRatingsDB) UpdateAnilistRating(_ context.Context, score *float64, votes *int32, id int32) (int64, error) {
	if f.updErr != nil {
		return 0, f.updErr
	}
	f.updated[id] = votes
	f.scores[id] = score
	return 1, nil
}

func (f *fakeAnilistRatingsDB) MarkAnilistRatingChecked(_ context.Context, id int32) (int64, error) {
	f.stamped = append(f.stamped, id)
	return 1, nil
}

type fakeRatingsFetcher struct {
	batches [][]int
	respond func(ids []int) (*anilist.MediaRatingsResponse, error)
}

func (f *fakeRatingsFetcher) Ratings(_ context.Context, v anilist.RatingsVars) (*anilist.MediaRatingsResponse, error) {
	f.batches = append(f.batches, append([]int(nil), v.IDs...))
	return f.respond(v.IDs)
}

// mediaWithVotes builds a Media as MediaRatingsQuery would return it:
// a non-nil Stats whose distribution sums to votes.
func mediaWithVotes(id, score, votes int) anilist.Media {
	return anilist.Media{
		ID:           id,
		AverageScore: &score,
		Stats:        &anilist.MediaStats{ScoreDistribution: []anilist.ScoreDistributionBucket{{Score: 80, Amount: votes}}},
	}
}

func runAnilistPass(t *testing.T, w *AnilistRatingsWorker) {
	t.Helper()
	require.NoError(t, w.Work(context.Background(), nil))
}

// ---------------------------------------------------------------------------
// AniList sweep
// ---------------------------------------------------------------------------

// TestAnilistRatings_AsksInPageSizedBatches pins the batching, which is
// the entire reason this sweep is affordable: 50 rows per request is
// what makes a whole-catalogue pass ~370 requests instead of ~18,000.
//
// It also pins the ceiling.  AniList truncates a page past 50 rather
// than erroring, and a truncated batch is indistinguishable from ids it
// declines to serve — the missing rows would be stamped "checked, no
// rating" without ever having been asked about.
func TestAnilistRatings_AsksInPageSizedBatches(t *testing.T) {
	ids := make([]int32, 120)
	for i := range ids {
		ids[i] = int32(1000 + i)
	}
	db := newFakeAnilistRatingsDB(ids...)
	fetch := &fakeRatingsFetcher{respond: func(batch []int) (*anilist.MediaRatingsResponse, error) {
		resp := &anilist.MediaRatingsResponse{}
		for _, id := range batch {
			resp.Page.Media = append(resp.Page.Media, mediaWithVotes(id, 80, 100))
		}
		return resp, nil
	}}

	runAnilistPass(t, NewAnilistRatingsWorker(fetch, db))

	require.Len(t, fetch.batches, 3, "120 ids at a 50-id page cap is 3 requests")
	assert.Len(t, fetch.batches[0], 50)
	assert.Len(t, fetch.batches[1], 50)
	assert.Len(t, fetch.batches[2], 20)
	for _, b := range fetch.batches {
		assert.LessOrEqual(t, len(b), anilist.MaxRatingIDs)
	}
	assert.Len(t, db.updated, 120, "every candidate was written")
	assert.Empty(t, db.stamped, "nothing was absent upstream")
}

// TestAnilistRatings_StampsIdsAniListDidNotReturn is the one that keeps
// the sweep from wedging.
//
// Candidates are ordered `checked_at NULLS FIRST`, so a row that is
// never stamped sorts to the head of every subsequent pass.  A handful
// of media AniList has deleted or merged would therefore occupy the same
// slots hourly, forever, while the rows behind them are never read — and
// the pass summary would report a healthy batch count the whole time.
func TestAnilistRatings_StampsIdsAniListDidNotReturn(t *testing.T) {
	db := newFakeAnilistRatingsDB(1, 2, 3)
	fetch := &fakeRatingsFetcher{respond: func(_ []int) (*anilist.MediaRatingsResponse, error) {
		return &anilist.MediaRatingsResponse{Page: anilist.MediaPage{
			Media: []anilist.Media{mediaWithVotes(2, 75, 40)},
		}}, nil
	}}

	runAnilistPass(t, NewAnilistRatingsWorker(fetch, db))

	assert.ElementsMatch(t, []int32{1, 3}, db.stamped,
		"ids AniList omitted must be stamped or they lead every later pass")
	assert.Len(t, db.updated, 1)
	require.NotNil(t, db.updated[2])
	assert.EqualValues(t, 40, *db.updated[2])
}

// TestAnilistRatings_LeavesAFailedBatchUnstamped is the mirror image.
//
// Stamping on failure is the tempting bug: it makes the pass summary
// look clean and moves the rows along.  It would also mean an AniList
// outage — one is in progress as this is written, the API answers 403 to
// everything — silently marks the whole catalogue as read, with no
// rating collected and a 90-day wait before anything tries again.
func TestAnilistRatings_LeavesAFailedBatchUnstamped(t *testing.T) {
	db := newFakeAnilistRatingsDB(1, 2, 3)
	fetch := &fakeRatingsFetcher{respond: func(_ []int) (*anilist.MediaRatingsResponse, error) {
		return nil, &anilist.ErrUpstream{Status: 403, Message: "temporarily disabled"}
	}}

	// The pass itself must not return the error: river would retry with a
	// backoff measured in days, which is worse than the next hourly fire.
	runAnilistPass(t, NewAnilistRatingsWorker(fetch, db))

	assert.Empty(t, db.stamped, "a batch that never reached AniList must stay a candidate")
	assert.Empty(t, db.updated)
}

// TestAnilistRatings_SkipsMediaWithNoStats guards the boundary between
// this sweep and the query it depends on.
//
// Nil Stats means the document did not select the histogram — reachable
// only by editing MediaRatingsQuery.  Writing NULL votes there would be
// refused by the column's CHECK from inside an error the sweep swallows,
// so the row must be left alone and visible instead.
func TestAnilistRatings_SkipsMediaWithNoStats(t *testing.T) {
	db := newFakeAnilistRatingsDB(1)
	score := 80
	fetch := &fakeRatingsFetcher{respond: func(_ []int) (*anilist.MediaRatingsResponse, error) {
		return &anilist.MediaRatingsResponse{Page: anilist.MediaPage{
			Media: []anilist.Media{{ID: 1, AverageScore: &score}}, // no Stats
		}}, nil
	}}

	runAnilistPass(t, NewAnilistRatingsWorker(fetch, db))

	assert.Empty(t, db.updated, "a Media with no stats has no count to write")
	assert.Empty(t, db.stamped, "and must stay a candidate rather than be marked read")
}

// TestAnilistRatings_PreservesAStoredScoreOnNull pins the asymmetry
// UpdateAnilistRating documents: this sweep passes a nil score through
// so the SQL COALESCE keeps what is stored.  The request-driven paths
// overwrite unconditionally and should; this one walks all 18,458 rows.
func TestAnilistRatings_PreservesAStoredScoreOnNull(t *testing.T) {
	db := newFakeAnilistRatingsDB(1)
	fetch := &fakeRatingsFetcher{respond: func(_ []int) (*anilist.MediaRatingsResponse, error) {
		return &anilist.MediaRatingsResponse{Page: anilist.MediaPage{
			Media: []anilist.Media{{ID: 1, Stats: &anilist.MediaStats{}}}, // rated by nobody, no score
		}}, nil
	}}

	runAnilistPass(t, NewAnilistRatingsWorker(fetch, db))

	assert.Nil(t, db.scores[1], "a nil score reaches the UPDATE, where COALESCE keeps the stored value")
	require.NotNil(t, db.updated[1])
	assert.EqualValues(t, 0, *db.updated[1], "but the count is written: we asked, and it is zero")
}

// TestAnilistRatings_AsksForTheCurrentYearAndTheQuarterlyWindow pins the
// two numbers that define the cadence.  Both are invisible in the pass
// summary: a wrong year or a wrong window produces a sweep that runs
// perfectly and refreshes the wrong rows.
func TestAnilistRatings_AsksForTheCurrentYearAndTheQuarterlyWindow(t *testing.T) {
	db := newFakeAnilistRatingsDB()
	w := NewAnilistRatingsWorker(&fakeRatingsFetcher{}, db)
	w.now = func() time.Time { return time.Date(2027, time.January, 2, 3, 0, 0, 0, time.UTC) }

	runAnilistPass(t, w)

	assert.EqualValues(t, 2027, db.gotYear, "the year is read at pass time so a long-lived process rolls over")
	assert.EqualValues(t, anilistRatingsBatch, db.gotLimit)
	assert.EqualValues(t, int64(90*24*time.Hour/time.Microsecond), db.gotStale.Microseconds,
		"90 days is the quarterly cadence; the interval is the only thing enforcing it")
}

// TestAnilistRatings_ReturnsWhenItCannotSeeItsWorkList — the one error a
// pass does surface.  A pass that cannot read its candidates has not
// started, and river retrying it is right.
func TestAnilistRatings_ReturnsWhenItCannotSeeItsWorkList(t *testing.T) {
	db := newFakeAnilistRatingsDB()
	db.listErr = errors.New("connection refused")
	err := NewAnilistRatingsWorker(&fakeRatingsFetcher{}, db).Work(context.Background(), nil)
	assert.Error(t, err)
}

// ---------------------------------------------------------------------------
// Bangumi doubles
// ---------------------------------------------------------------------------

type fakeBangumiRatingsDB struct {
	candidates []dbgen.ListBangumiRatingCandidatesRow

	gotYear  int32
	gotLimit int32

	updates map[int32][2]any // anilistID → {score, votes} as written
	rows    int64
	stamped []int32
}

func newFakeBangumiRatingsDB(rows ...dbgen.ListBangumiRatingCandidatesRow) *fakeBangumiRatingsDB {
	return &fakeBangumiRatingsDB{candidates: rows, updates: map[int32][2]any{}, rows: 1}
}

func (f *fakeBangumiRatingsDB) ListBangumiRatingCandidates(_ context.Context, year int32, _ pgtype.Interval, limit int32) ([]dbgen.ListBangumiRatingCandidatesRow, error) {
	f.gotYear, f.gotLimit = year, limit
	return f.candidates, nil
}

func (f *fakeBangumiRatingsDB) UpdateBangumiRating(_ context.Context, score *float64, votes *int32, id int32, _ int32) (int64, error) {
	f.updates[id] = [2]any{score, votes}
	return f.rows, nil
}

func (f *fakeBangumiRatingsDB) MarkBangumiRatingChecked(_ context.Context, id int32, _ int32) (int64, error) {
	f.stamped = append(f.stamped, id)
	return 1, nil
}

type fakeSubjectFetcher struct {
	respond func(bgmID int) (*bangumi.Subject, error)
	asked   []int
}

func (f *fakeSubjectFetcher) Subject(_ context.Context, bgmID int) (*bangumi.Subject, error) {
	f.asked = append(f.asked, bgmID)
	return f.respond(bgmID)
}

func bgmCandidate(anilistID, bgmID int32) dbgen.ListBangumiRatingCandidatesRow {
	return dbgen.ListBangumiRatingCandidatesRow{AnilistID: anilistID, BgmID: &bgmID}
}

// subjectRated builds a Subject with a rating block, as /v0/subjects
// returns for anything anyone has scored.
func subjectRated(score float64, total int) *bangumi.Subject {
	s := &bangumi.Subject{}
	s.Rating = &struct {
		Score float64 `json:"score"`
		Count int     `json:"total"`
	}{Score: score, Count: total}
	return s
}

// ---------------------------------------------------------------------------
// Bangumi sweep
// ---------------------------------------------------------------------------

// TestBangumiRatings_WritesTheSubjectsRating is the happy path, and the
// number in it is the one this whole feature exists to keep current.
func TestBangumiRatings_WritesTheSubjectsRating(t *testing.T) {
	db := newFakeBangumiRatingsDB(bgmCandidate(201903, 555))
	fetch := &fakeSubjectFetcher{respond: func(int) (*bangumi.Subject, error) {
		return subjectRated(8.1, 18023), nil
	}}

	require.NoError(t, NewBangumiRatingsWorker(fetch, db).Work(context.Background(), nil))

	assert.Equal(t, []int{555}, fetch.asked)
	written, ok := db.updates[201903]
	require.True(t, ok)
	require.NotNil(t, written[0])
	assert.InDelta(t, 8.1, *written[0].(*float64), 0.001)
	require.NotNil(t, written[1])
	assert.EqualValues(t, 18023, *written[1].(*int32))
	assert.Empty(t, db.stamped)
}

// TestBangumiRatings_StampsASubjectBangumiWillNotServe covers the R18
// gating migration 0031 records: the v0 endpoint 404s for an anonymous
// caller on a binding the legacy search endpoint handed us, and no
// number of retries turns into a token.  Unstamped, those rows would
// lead every pass forever.
func TestBangumiRatings_StampsASubjectBangumiWillNotServe(t *testing.T) {
	db := newFakeBangumiRatingsDB(bgmCandidate(7, 99))
	fetch := &fakeSubjectFetcher{respond: func(int) (*bangumi.Subject, error) {
		return nil, bangumi.ErrNotFound
	}}

	require.NoError(t, NewBangumiRatingsWorker(fetch, db).Work(context.Background(), nil))

	assert.Equal(t, []int32{7}, db.stamped)
	assert.Empty(t, db.updates, "nothing is written for a subject we could not read")
}

// TestBangumiRatings_DoesNotStampATransportFailure — a 5xx or a timeout
// is not an answer, and stamping one would cost the row 90 days (or,
// for the back catalogue, permanently).
func TestBangumiRatings_DoesNotStampATransportFailure(t *testing.T) {
	db := newFakeBangumiRatingsDB(bgmCandidate(7, 99))
	fetch := &fakeSubjectFetcher{respond: func(int) (*bangumi.Subject, error) {
		return nil, errors.New("upstream 503")
	}}

	require.NoError(t, NewBangumiRatingsWorker(fetch, db).Work(context.Background(), nil))

	assert.Empty(t, db.stamped)
	assert.Empty(t, db.updates)
}

// TestBangumiRatings_PassesNilsWhenTheSubjectCarriesNoRating.  The SQL
// COALESCEs them, so the stored pair survives while the read is still
// stamped: we asked, and there was nothing to write.
func TestBangumiRatings_PassesNilsWhenTheSubjectCarriesNoRating(t *testing.T) {
	db := newFakeBangumiRatingsDB(bgmCandidate(7, 99))
	fetch := &fakeSubjectFetcher{respond: func(int) (*bangumi.Subject, error) {
		return &bangumi.Subject{ID: 99}, nil // no Rating block
	}}

	require.NoError(t, NewBangumiRatingsWorker(fetch, db).Work(context.Background(), nil))

	written, ok := db.updates[7]
	require.True(t, ok, "the read still happens and still stamps")
	assert.Nil(t, written[0])
	assert.Nil(t, written[1])
}

// TestBangumiRatings_WritesAZeroTotal — Bangumi sends total=0 for a
// subject nobody has rated, and that zero is an answer, not an absence.
// COALESCE only preserves on SQL NULL, so this must arrive as *0 rather
// than nil or the count would never fall back to zero.
func TestBangumiRatings_WritesAZeroTotal(t *testing.T) {
	db := newFakeBangumiRatingsDB(bgmCandidate(7, 99))
	fetch := &fakeSubjectFetcher{respond: func(int) (*bangumi.Subject, error) {
		return subjectRated(0, 0), nil
	}}

	require.NoError(t, NewBangumiRatingsWorker(fetch, db).Work(context.Background(), nil))

	written := db.updates[7]
	require.NotNil(t, written[1])
	assert.EqualValues(t, 0, *written[1].(*int32))
}

// TestBangumiRatings_LeavesARowWhoseBindingMoved.  The UPDATE carries
// bgm_id in its WHERE, so a row re-bound between the scan and the write
// matches nothing.  That is not a failure to retry and not a write to
// count — it is a row whose next pass will ask about the subject it now
// holds, so it must not be stamped.
func TestBangumiRatings_LeavesARowWhoseBindingMoved(t *testing.T) {
	db := newFakeBangumiRatingsDB(bgmCandidate(7, 99))
	db.rows = 0
	fetch := &fakeSubjectFetcher{respond: func(int) (*bangumi.Subject, error) {
		return subjectRated(7.5, 300), nil
	}}

	require.NoError(t, NewBangumiRatingsWorker(fetch, db).Work(context.Background(), nil))

	assert.Empty(t, db.stamped, "a row that moved must be re-read under its new binding")
}

// TestBangumiRatings_BatchIsFarSmallerThanTheAniListOne pins the cost
// difference the two caps encode: one request per row through the same
// 800ms bucket the request path uses, against 50 rows per request.
func TestBangumiRatings_BatchIsFarSmallerThanTheAniListOne(t *testing.T) {
	db := newFakeBangumiRatingsDB()
	w := NewBangumiRatingsWorker(&fakeSubjectFetcher{}, db)
	w.now = func() time.Time { return time.Date(2026, time.September, 7, 0, 0, 0, 0, time.UTC) }

	require.NoError(t, w.Work(context.Background(), nil))

	assert.EqualValues(t, 2026, db.gotYear)
	assert.EqualValues(t, bangumiRatingsBatch, db.gotLimit)
	assert.Less(t, bangumiRatingsBatch, anilistRatingsBatch,
		"one request per row cannot be capped like fifty rows per request")
}
