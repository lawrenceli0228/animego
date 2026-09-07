//go:build integration

// rating_columns_test.go — migration 0033's rating columns and the four
// statements that drive them, against a real Postgres.
//
// Everything load-bearing about this feature is a property of SQL, not of
// the Go around it, and none of it is visible from a unit test:
//
//	the candidate WHERE clause          decides which rows are refreshed
//	                                    quarterly and which are collected
//	                                    once.  A mistake here produces a
//	                                    sweep that runs perfectly and reads
//	                                    the wrong rows, hourly, forever.
//	COALESCE on average_score           a sweep that walks all 18,458 rows
//	                                    must not be able to erase the score
//	                                    catalogue on a null response.
//	the conditional updated_at          it is the lastmod ListSitemapShard
//	                                    reports to Google; a quarterly pass
//	                                    that touched every row would
//	                                    republish the whole sitemap for
//	                                    nothing.
//	CHECK anime_anilist_rating_pair     the column, not the caller, refuses
//	                                    a count with no observation behind
//	                                    it -- the sweep swallows a per-row
//	                                    update error, so a value the caller
//	                                    let through and the constraint
//	                                    refused would show up only as a row
//	                                    that quietly stopped refreshing.
//
// Hermeticity: everything runs in one transaction that TRUNCATEs
// anime_cache and is rolled back in t.Cleanup, so the candidate queries
// (which read the whole table) see only this test's fixtures.  now()
// inside that transaction is the transaction's start time, which is what
// the seeded ages are measured against.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ratingStaleWindow mirrors queue.ratingsStaleAfter.  It is duplicated
// rather than imported because the constant is unexported and the point
// of this file is to drive the SQL, not the worker; if the two drift the
// cadence subtest fails, which is the correct place to notice.
const ratingStaleWindow = 90 * 24 * time.Hour

// ratingSeededAt is a timestamp no writer would produce, so a column
// still wearing it was not written to.
var ratingSeededAt = time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC)

func ratingInterval(d time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: int64(d / time.Microsecond), Valid: true}
}

// seedRatingRow inserts one anime_cache row with full control over the
// three columns the candidate queries read.  checkedAgo < 0 means "never
// checked" (NULL stamp).
func seedRatingRow(t *testing.T, ctx context.Context, tx pgx.Tx, id int32, seasonYear *int32, bgmID *int32, checkedAgo time.Duration, anilistChecked bool) {
	t.Helper()
	var stamp any
	if checkedAgo >= 0 {
		stamp = checkedAgo
	}
	col := "bangumi_rating_checked_at"
	if anilistChecked {
		col = "anilist_rating_checked_at"
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, season_year, bgm_id, `+col+`)
		VALUES ($1, $2, $3, CASE WHEN $4::interval IS NULL THEN NULL ELSE now() - $4::interval END)`,
		id, seasonYear, bgmID, stamp)
	require.NoError(t, err, "seed row %d", id)
}

func yearPtr(y int32) *int32 { return &y }

func TestRatingCandidateCadence(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	// The candidate queries read the whole table; emptying it inside the
	// rolled-back transaction is what makes the assertions about which
	// rows come back mean anything.
	_, err = tx.Exec(ctx, `TRUNCATE anime_cache CASCADE`)
	require.NoError(t, err, "truncate anime_cache")

	const currentYear int32 = 2026
	q := dbgen.New(tx)

	// One row per population the WHERE clause distinguishes.  The names
	// are the claim; the ids are arbitrary.
	const (
		thisYearNever   = int32(9970001) // due: current year, never read
		thisYearStale   = int32(9970002) // due: current year, read 100 days ago
		thisYearFresh   = int32(9970003) // not due: read 10 days ago
		nextYearStale   = int32(9970004) // due: the `>=` decision
		oldNever        = int32(9970005) // due: back catalogue, never read
		oldStale        = int32(9970006) // NOT due: collected once, that is the design
		noSeasonNever   = int32(9970007) // due: NULL season_year is back catalogue
		noSeasonChecked = int32(9970008) // NOT due, for the same reason as oldStale
	)

	for _, s := range []struct {
		id         int32
		year       *int32
		checkedAgo time.Duration
	}{
		{thisYearNever, yearPtr(currentYear), -1},
		{thisYearStale, yearPtr(currentYear), 100 * 24 * time.Hour},
		{thisYearFresh, yearPtr(currentYear), 10 * 24 * time.Hour},
		{nextYearStale, yearPtr(currentYear + 1), 100 * 24 * time.Hour},
		{oldNever, yearPtr(2015), -1},
		{oldStale, yearPtr(2015), 100 * 24 * time.Hour},
		{noSeasonNever, nil, -1},
		{noSeasonChecked, nil, 100 * 24 * time.Hour},
	} {
		seedRatingRow(t, ctx, tx, s.id, s.year, nil, s.checkedAgo, true)
	}

	got, err := q.ListAnilistRatingCandidates(ctx, currentYear, ratingInterval(ratingStaleWindow), 100)
	require.NoError(t, err)

	assert.ElementsMatch(t,
		[]int32{thisYearNever, thisYearStale, nextYearStale, oldNever, noSeasonNever},
		got,
		"the cycling population is current-year-and-later past the window; the back catalogue is only the rows never read")

	t.Run("the back catalogue is collected once and then left alone", func(t *testing.T) {
		// This is the half of the design that is easiest to get wrong in
		// the direction nobody notices: a WHERE clause that let oldStale
		// back in would turn a one-shot backfill into a permanent
		// quarterly re-read of 18,000 rows.
		assert.NotContains(t, got, oldStale)
		assert.NotContains(t, got, noSeasonChecked)
	})

	t.Run("rows with no season_year are reachable at all", func(t *testing.T) {
		// 4,500 of 18,458 prod rows have no season_year.  `NULL >= 2026`
		// is NULL, so without the COALESCE neither branch would claim
		// them and a quarter of the catalogue would never be read.
		assert.Contains(t, got, noSeasonNever)
	})

	t.Run("the cycling population is ordered ahead of the backlog", func(t *testing.T) {
		// A multi-day backfill drain must not be able to delay this
		// season's refresh behind it.
		cycling := map[int32]bool{thisYearNever: true, thisYearStale: true, nextYearStale: true}
		var seenBacklog bool
		for _, id := range got {
			if !cycling[id] {
				seenBacklog = true
				continue
			}
			assert.False(t, seenBacklog,
				"row %d is current-year-or-later and sorted after a backlog row", id)
		}
	})

	t.Run("row_limit bounds the pass", func(t *testing.T) {
		capped, err := q.ListAnilistRatingCandidates(ctx, currentYear, ratingInterval(ratingStaleWindow), 2)
		require.NoError(t, err)
		assert.Len(t, capped, 2)
	})
}

func TestBangumiRatingCandidatesRequireABinding(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	_, err = tx.Exec(ctx, `TRUNCATE anime_cache CASCADE`)
	require.NoError(t, err)

	const currentYear int32 = 2026
	bound, unbound := int32(9971001), int32(9971002)
	bgm := int32(4321)
	seedRatingRow(t, ctx, tx, bound, yearPtr(currentYear), &bgm, -1, false)
	seedRatingRow(t, ctx, tx, unbound, yearPtr(currentYear), nil, -1, false)

	rows, err := dbgen.New(tx).ListBangumiRatingCandidates(ctx, currentYear, ratingInterval(ratingStaleWindow), 100)
	require.NoError(t, err)

	// An unbound row has no subject to ask about.  Offering it would make
	// the pass stamp a row it could not read, which the binding sweep
	// could never undo.  5,225 of 18,458 prod rows are unbound.
	require.Len(t, rows, 1)
	assert.Equal(t, bound, rows[0].AnilistID)
	require.NotNil(t, rows[0].BgmID)
	assert.Equal(t, bgm, *rows[0].BgmID)
}

func TestUpdateAnilistRating(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	q := dbgen.New(tx)
	const id = int32(9972001)
	_, err = tx.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, average_score, updated_at)
		VALUES ($1, 84.00, $2)`, id, ratingSeededAt)
	require.NoError(t, err)

	type row struct {
		score     *float64
		votes     *int32
		checkedAt *time.Time
		updatedAt time.Time
	}
	read := func() row {
		t.Helper()
		var r row
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT average_score, anilist_score_votes, anilist_rating_checked_at, updated_at
			FROM anime_cache WHERE anilist_id = $1`, id).
			Scan(&r.score, &r.votes, &r.checkedAt, &r.updatedAt))
		return r
	}

	t.Run("a null score leaves the stored one alone", func(t *testing.T) {
		// The asymmetry with the four request-driven paths, which
		// overwrite unconditionally.  Those answer for one row a request
		// just named; this one walks the whole catalogue, so the same
		// null means "if it is wrong, it is wrong everywhere at once,
		// and there is no second source to restore a score from".
		n, err := q.UpdateAnilistRating(ctx, nil, ptrInt32(120), id)
		require.NoError(t, err)
		require.EqualValues(t, 1, n)

		got := read()
		require.NotNil(t, got.score)
		assert.InDelta(t, 84.0, *got.score, 0.001, "a null response must not erase a stored score")
		require.NotNil(t, got.votes)
		assert.EqualValues(t, 120, *got.votes)
		require.NotNil(t, got.checkedAt, "the read is stamped even when the score was not written")
		assert.True(t, got.updatedAt.After(ratingSeededAt), "the count changed, so lastmod moves")
	})

	// The two subtests below cannot compare updated_at before against
	// updated_at after: now() inside a transaction is the transaction's
	// start time, so every write in this test stamps the SAME instant and
	// "did not move" and "moved" are indistinguishable by comparison --
	// the no-bump case would pass against an unconditional
	// `updated_at = now()`, which is precisely the bug it exists to
	// catch.  Each therefore reseeds the column to a sentinel no writer
	// produces and asks whether the statement left it there.
	reseed := func() {
		t.Helper()
		_, err := tx.Exec(ctx, `UPDATE anime_cache SET updated_at = $2 WHERE anilist_id = $1`, id, ratingSeededAt)
		require.NoError(t, err)
	}

	t.Run("a second identical write does not move updated_at", func(t *testing.T) {
		// updated_at is the lastmod ListSitemapShard reports.  A
		// quarterly pass over 18,458 rows that bumped every one of them
		// would republish the entire sitemap having changed nothing --
		// which is the failure TODOS.md already records for the shared
		// upsert, and this statement must not add to it.
		reseed()
		before := read()
		_, err := q.UpdateAnilistRating(ctx, ptrFloat64(84), ptrInt32(120), id)
		require.NoError(t, err)
		after := read()

		assert.True(t, after.updatedAt.Equal(ratingSeededAt),
			"nothing changed, so lastmod must not claim otherwise")
		require.NotNil(t, after.checkedAt)
		assert.True(t, after.checkedAt.Equal(*before.checkedAt) || after.checkedAt.After(*before.checkedAt),
			"the read stamp always advances -- that is what moves the row out of the candidate set")
	})

	t.Run("a changed count moves updated_at", func(t *testing.T) {
		reseed()
		_, err := q.UpdateAnilistRating(ctx, ptrFloat64(84), ptrInt32(18023), id)
		require.NoError(t, err)
		after := read()

		require.NotNil(t, after.votes)
		assert.EqualValues(t, 18023, *after.votes)
		assert.False(t, after.updatedAt.Equal(ratingSeededAt),
			"a figure a public page renders changed, so lastmod moves")
	})

	t.Run("a changed score moves updated_at", func(t *testing.T) {
		// The other half of the CASE.  Without it, a score correction
		// that arrived through this sweep would never reach Google.
		reseed()
		_, err := q.UpdateAnilistRating(ctx, ptrFloat64(91), ptrInt32(18023), id)
		require.NoError(t, err)
		after := read()

		require.NotNil(t, after.score)
		assert.InDelta(t, 91.0, *after.score, 0.001)
		assert.False(t, after.updatedAt.Equal(ratingSeededAt))
	})
}

func TestMarkAnilistRatingCheckedLeavesFiguresAlone(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	const id = int32(9973001)
	_, err = tx.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, average_score, updated_at)
		VALUES ($1, 84.00, $2)`, id, ratingSeededAt)
	require.NoError(t, err)

	n, err := dbgen.New(tx).MarkAnilistRatingChecked(ctx, id)
	require.NoError(t, err)
	require.EqualValues(t, 1, n)

	var score *float64
	var checkedAt *time.Time
	var updatedAt time.Time
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT average_score, anilist_rating_checked_at, updated_at
		FROM anime_cache WHERE anilist_id = $1`, id).Scan(&score, &checkedAt, &updatedAt))

	require.NotNil(t, checkedAt, "an id AniList declined to return is still an id we asked about")
	require.NotNil(t, score)
	assert.InDelta(t, 84.0, *score, 0.001)
	assert.True(t, updatedAt.Equal(ratingSeededAt),
		"nothing about the row changed, so lastmod must not move")
}

func TestUpdateBangumiRatingRefusesAMovedBinding(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	q := dbgen.New(tx)
	const id = int32(9974001)
	_, err = tx.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, bgm_id, bangumi_score, bangumi_votes)
		VALUES ($1, 555, 7.50, 300)`, id)
	require.NoError(t, err)

	// The payload is never the authority.  A row re-bound between the
	// scan and this write would otherwise be given another subject's
	// score under its new binding -- the rule TouchEpisodeTitlesAt and
	// EpisodesBgmArgs already follow.
	n, err := q.UpdateBangumiRating(ctx, ptrFloat64(9.9), ptrInt32(99999), id, 999)
	require.NoError(t, err)
	assert.EqualValues(t, 0, n, "a stale binding matches no row, and the caller reads that as 'ask again next pass'")

	var votes *int32
	var checkedAt *time.Time
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT bangumi_votes, bangumi_rating_checked_at FROM anime_cache WHERE anilist_id = $1`, id).
		Scan(&votes, &checkedAt))
	require.NotNil(t, votes)
	assert.EqualValues(t, 300, *votes, "the stored figure survived a write aimed at the wrong subject")
	assert.Nil(t, checkedAt, "and the row was not stamped, so the next pass re-reads it")

	t.Run("the right binding writes, and zero is a real answer", func(t *testing.T) {
		n, err := q.UpdateBangumiRating(ctx, ptrFloat64(0), ptrInt32(0), id, 555)
		require.NoError(t, err)
		require.EqualValues(t, 1, n)

		var score *float64
		var votes *int32
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT bangumi_score, bangumi_votes FROM anime_cache WHERE anilist_id = $1`, id).
			Scan(&score, &votes))
		require.NotNil(t, votes)
		// Bangumi sends total=0 for a subject nobody has rated.  COALESCE
		// preserves only on SQL NULL, so a real zero must land.
		assert.EqualValues(t, 0, *votes)
		require.NotNil(t, score)
		assert.InDelta(t, 0.0, *score, 0.001)
	})

	t.Run("a subject with no rating block leaves both figures alone", func(t *testing.T) {
		_, err := q.UpdateBangumiRating(ctx, ptrFloat64(6.6), ptrInt32(42), id, 555)
		require.NoError(t, err)
		n, err := q.UpdateBangumiRating(ctx, nil, nil, id, 555)
		require.NoError(t, err)
		require.EqualValues(t, 1, n)

		var score *float64
		var votes *int32
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT bangumi_score, bangumi_votes FROM anime_cache WHERE anilist_id = $1`, id).
			Scan(&score, &votes))
		require.NotNil(t, votes)
		assert.EqualValues(t, 42, *votes, "nils are 'keep what is stored', not 'clear it'")
		require.NotNil(t, score)
		assert.InDelta(t, 6.6, *score, 0.001)
	})
}

func TestAnilistRatingPairConstraint(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	// The constraint is the only thing standing between a swallowed
	// per-row update error and a count nobody can account for.  The sweep
	// logs and continues on failure, so a value it let through and the
	// column refused surfaces as a row that quietly stops refreshing.
	for _, tc := range []struct {
		name   string
		insert string
		ok     bool
	}{
		{"a count with the observation behind it", `(9975001, 18023, now())`, true},
		{"no count, no observation", `(9975002, NULL, NULL)`, true},
		{"asked, and the answer was nobody", `(9975003, 0, now())`, true},
		{"a stamp with no count -- an id AniList declined to return", `(9975004, NULL, now())`, true},
		{"a count with no observation behind it", `(9975005, 18023, NULL)`, false},
		{"a negative number of people", `(9975006, -1, now())`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sp, err := tx.Begin(ctx) // nested savepoint: a refusal must not poison the outer tx
			require.NoError(t, err)
			defer func() { _ = sp.Rollback(context.Background()) }()

			_, err = sp.Exec(ctx, `
				INSERT INTO anime_cache (anilist_id, anilist_score_votes, anilist_rating_checked_at)
				VALUES `+tc.insert)
			if tc.ok {
				assert.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), "anime_anilist_rating_pair",
				"the column must be what refuses this, not the caller")
		})
	}
}

func ptrInt32(v int32) *int32       { return &v }
func ptrFloat64(v float64) *float64 { return &v }
