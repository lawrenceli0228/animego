//go:build integration

// bgm_rebind_worker_test.go — the weekly re-search sweep
// (internal/queue/bgm_rebind_search.go) and its three statements
// (internal/db/queries/bgm_rebind.sql) against a real Postgres.
//
// The unit tests pin the worker's decisions against doubles.  What only a
// database can show is whether the SQL says what those decisions assume:
//
//	candidate set   Each excluded population is a promise somebody else
//	                relies on -- V1 owns version 0, an admin's correction
//	                outranks the scorer, the weekly stamp is the cycle.  A
//	                clause that silently stops excluding one of them is
//	                invisible to a stub that returns whatever rows it is given.
//
//	bind statement  The collision guard and the hand-correction guard live in
//	                the UPDATE's WHERE, as a second line behind the worker's
//	                own checks.  Only a real statement can prove the second
//	                line holds when the first one is bypassed.
//
//	rollback        A row bound with no V2 job behind it leaves the candidate
//	                set and is never enriched.  As in id_map_bind_worker_test,
//	                the stub enqueuer reads the bind back through the
//	                transaction it is handed, so "the row is still unbound
//	                afterwards" means rolled back, not never written.
//
// The sweep is catalogue-wide, so the file owns the whole slate
// (testutil.TruncateAll) for the reason id_map_bind_worker_test.go gives.
package integration

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

const (
	// rebindWorkerEnv restates the unexported kill-switch name; a rename
	// there makes the enabled subtests read a variable nothing consults, and
	// their bind assertions fail.
	rebindWorkerEnv = "BGM_REBIND_SWEEP_ENABLED"

	// rebindIDFloor separates this file's fixtures from anything else.
	rebindIDFloor = 9910000
)

// rebindFixture is one anime_cache row.  Zero values are the common case: an
// airing, non-adult, unflagged row parked by V1, never stamped.
type rebindFixture struct {
	id         int
	native     string
	romaji     string
	status     string // "" -> RELEASING
	version    int    // 0 -> 2 (parked)
	bgmID      *int
	adult      bool
	adminFlag  *string
	source     *string
	popularity int
	stampedAgo time.Duration // 0 -> never stamped
	titleCN    *string
	seasonYear int
	episodes   int
	pendingV1  bool // bangumi_version 0: V1's queue, not the sweep's
	mappedTo   *int // a bgm_id_map entry naming this subject
}

func strp(s string) *string { return &s }
func intp(n int) *int       { return &n }

func rebindSeed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, rows ...rebindFixture) {
	t.Helper()
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM bgm_id_map WHERE anilist_id >= $1`, rebindIDFloor)
		_, _ = pool.Exec(bg, `DELETE FROM anime_cache WHERE anilist_id >= $1`, rebindIDFloor)
	})
	for _, r := range rows {
		require.GreaterOrEqual(t, r.id, rebindIDFloor)
		status := r.status
		if status == "" {
			status = "RELEASING"
		}
		version := r.version
		switch {
		case r.pendingV1:
			version = 0
		case version == 0:
			version = 2
		}
		romaji := r.romaji
		if romaji == "" {
			romaji = "Rebind Fixture"
		}
		var stamped *time.Time
		if r.stampedAgo > 0 {
			ts := time.Now().Add(-r.stampedAgo)
			stamped = &ts
		}
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, title_native, title_romaji, status, bangumi_version,
			                         bgm_id, is_adult, admin_flag, bgm_match_source, popularity,
			                         bgm_rebind_checked_at, title_chinese, season_year, episodes)
			VALUES ($1, NULLIF($2, ''), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULLIF($13, 0), NULLIF($14, 0))`,
			r.id, r.native, romaji, status, version, r.bgmID, r.adult, r.adminFlag, r.source, r.popularity,
			stamped, r.titleCN, r.seasonYear, r.episodes)
		require.NoError(t, err, "seed anime_cache %d", r.id)
		if r.mappedTo != nil {
			_, err = pool.Exec(ctx, `INSERT INTO bgm_id_map (anilist_id, bgm_id, source) VALUES ($1, $2, 'test')`,
				r.id, *r.mappedTo)
			require.NoError(t, err, "seed bgm_id_map %d", r.id)
		}
	}
}

// rebindRowState is what the assertions read back.
type rebindRowState struct {
	bgmID     *int32
	titleCN   *string
	source    *string
	adminFlag *string
	version   int32
	stamped   bool
}

func rebindRead(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int) rebindRowState {
	t.Helper()
	var s rebindRowState
	err := pool.QueryRow(ctx, `
		SELECT bgm_id, title_chinese, bgm_match_source, admin_flag, bangumi_version,
		       bgm_rebind_checked_at IS NOT NULL
		FROM anime_cache WHERE anilist_id = $1`, id).
		Scan(&s.bgmID, &s.titleCN, &s.source, &s.adminFlag, &s.version, &s.stamped)
	require.NoError(t, err, "read back %d", id)
	return s
}

func weekInterval() pgtype.Interval {
	return pgtype.Interval{Microseconds: (7 * 24 * time.Hour).Microseconds(), Valid: true}
}

// rebindStubEnqueuer stands in for river, structurally satisfying the
// worker's unexported transactional-enqueue interface.
type rebindStubEnqueuer struct {
	err       error
	jobs      []queue.BangumiV2Args
	boundInTx int
	txErr     error
}

func (s *rebindStubEnqueuer) EnqueueV2ManyTx(ctx context.Context, tx pgx.Tx, jobs []queue.BangumiV2Args) error {
	s.jobs = append(s.jobs, jobs...)
	s.txErr = tx.QueryRow(ctx, `
		SELECT count(*) FROM anime_cache WHERE anilist_id >= $1 AND bgm_id IS NOT NULL`,
		rebindIDFloor).Scan(&s.boundInTx)
	return s.err
}

// rebindStubSearch answers searches from a keyword table.
type rebindStubSearch struct {
	answers  map[string][]bangumi.SearchResult
	keywords []string
}

func (s *rebindStubSearch) Search(_ context.Context, kw string) (*bangumi.SearchResponse, error) {
	s.keywords = append(s.keywords, kw)
	list, ok := s.answers[kw]
	if !ok {
		return nil, bangumi.ErrNotFound
	}
	return &bangumi.SearchResponse{List: list}, nil
}

func rebindRun(t *testing.T, ctx context.Context, pool *pgxpool.Pool, search *rebindStubSearch, enq *rebindStubEnqueuer) {
	t.Helper()
	w := queue.NewBgmRebindWorker(pool, dbgen.New(pool), search, enq)
	require.NoError(t, w.Work(ctx, &river.Job[queue.BgmRebindArgs]{}),
		"a pass always returns nil; the next fire is the retry")
}

func TestBgmRebindCandidates(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	rebindSeed(t, ctx, pool,
		// Candidates.
		rebindFixture{id: 9910001, source: strp("fuzzy_low"), adminFlag: strp("needs-review"), popularity: 100},
		rebindFixture{id: 9910002, status: "NOT_YET_RELEASED", popularity: 5000}, // parked by MarkBangumiV1NotFound
		rebindFixture{id: 9910003, version: 3, source: strp("fuzzy_low"), popularity: 50},
		rebindFixture{id: 9910004, stampedAgo: 8 * 24 * time.Hour, popularity: 99999}, // week is up

		// Not candidates, one reason each.
		rebindFixture{id: 9910101, status: "FINISHED"},
		rebindFixture{id: 9910102, pendingV1: true},      // V1's queue
		rebindFixture{id: 9910103, bgmID: intp(9919103)}, // bound
		rebindFixture{id: 9910104, adult: true},          // R18
		rebindFixture{id: 9910105, adminFlag: strp("manually-corrected")},
		rebindFixture{id: 9910106, stampedAgo: 24 * time.Hour}, // searched this week
		rebindFixture{id: 9910107, status: "CANCELLED"},
		rebindFixture{id: 9910108, status: "HIATUS"},
		// The map names a subject the id-map sweep declined to bind.
		rebindFixture{id: 9910109, mappedTo: intp(9919109), popularity: 999999},
	)

	rows, err := q.ListBgmRebindCandidates(ctx, weekInterval(), 100)
	require.NoError(t, err)

	got := make([]int32, len(rows))
	for i, r := range rows {
		got[i] = r.AnilistID
	}
	assert.Equal(t, []int32{9910002, 9910001, 9910003, 9910004}, got,
		"never-searched rows first, most popular first among them; a row whose week is up after them "+
			"however popular; and none of the excluded populations")

	limited, err := q.ListBgmRebindCandidates(ctx, weekInterval(), 2)
	require.NoError(t, err)
	assert.Len(t, limited, 2, "the batch cap applies")
}

func TestBgmRebindBindStatement(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	t.Run("binds a parked row and retires its review flag", func(t *testing.T) {
		rebindSeed(t, ctx, pool, rebindFixture{
			id: 9910201, version: 3, source: strp("fuzzy_low"), adminFlag: strp("needs-review"),
		})
		n, err := q.BindBgmIdFromRebindSearch(ctx, 9919201, strp("赛博朋克：边缘行者 2"), 9910201)
		require.NoError(t, err)
		require.EqualValues(t, 1, n)

		s := rebindRead(t, ctx, pool, 9910201)
		require.NotNil(t, s.bgmID)
		assert.EqualValues(t, 9919201, *s.bgmID)
		assert.Equal(t, strp("赛博朋克：边缘行者 2"), s.titleCN)
		assert.Equal(t, strp("fuzzy_high"), s.source)
		assert.Nil(t, s.adminFlag, "the bind answers the question the flag was raised for")
		assert.EqualValues(t, 3, s.version, "V2 moves the version when it completes, not the bind")
		assert.True(t, s.stamped, "the stamp is what tells this sweep's binds apart from V1's")
	})

	t.Run("keeps a Chinese title the row already holds", func(t *testing.T) {
		rebindSeed(t, ctx, pool, rebindFixture{id: 9910202, titleCN: strp("管理员写的")})
		_, err := q.BindBgmIdFromRebindSearch(ctx, 9919202, strp("搜索结果"), 9910202)
		require.NoError(t, err)
		assert.Equal(t, strp("管理员写的"), rebindRead(t, ctx, pool, 9910202).titleCN)
	})

	t.Run("refuses a subject another row holds", func(t *testing.T) {
		rebindSeed(t, ctx, pool,
			rebindFixture{id: 9910203},
			rebindFixture{id: 9910204, bgmID: intp(9919203), version: 2},
		)
		n, err := q.BindBgmIdFromRebindSearch(ctx, 9919203, nil, 9910203)
		require.NoError(t, err)
		assert.Zero(t, n, "one subject, one work: the second row would show the first one's titles")
		assert.Nil(t, rebindRead(t, ctx, pool, 9910203).bgmID)
	})

	t.Run("refuses a hand-corrected row", func(t *testing.T) {
		rebindSeed(t, ctx, pool, rebindFixture{id: 9910205, adminFlag: strp("manually-corrected")})
		n, err := q.BindBgmIdFromRebindSearch(ctx, 9919205, nil, 9910205)
		require.NoError(t, err)
		assert.Zero(t, n)
	})

	t.Run("refuses a row that is already bound", func(t *testing.T) {
		rebindSeed(t, ctx, pool, rebindFixture{id: 9910206, bgmID: intp(9919206)})
		n, err := q.BindBgmIdFromRebindSearch(ctx, 9919207, nil, 9910206)
		require.NoError(t, err)
		assert.Zero(t, n)
		assert.EqualValues(t, 9919206, *rebindRead(t, ctx, pool, 9910206).bgmID)
	})

	t.Run("keeps a review flag a human raised", func(t *testing.T) {
		// FlagAnimeEnrichment writes needs-review too.  Only V1's park pairs it
		// with fuzzy_low; on any other row the flag is a reviewer's, and the
		// bind must not drop the row from their queue.
		rebindSeed(t, ctx, pool, rebindFixture{id: 9910208, adminFlag: strp("needs-review")})
		n, err := q.BindBgmIdFromRebindSearch(ctx, 9919208, nil, 9910208)
		require.NoError(t, err)
		require.EqualValues(t, 1, n)
		assert.Equal(t, strp("needs-review"), rebindRead(t, ctx, pool, 9910208).adminFlag)
	})

	t.Run("refuses a row reset to version 0 since the read", func(t *testing.T) {
		// An admin reset between the candidate read and this write hands the
		// row to V1.  A bind here would be overwritten or parked by V1, and the
		// V2 job queued with it would then write this subject's title onto a
		// row that no longer holds it.
		rebindSeed(t, ctx, pool, rebindFixture{id: 9910209, pendingV1: true})
		n, err := q.BindBgmIdFromRebindSearch(ctx, 9919209, nil, 9910209)
		require.NoError(t, err)
		assert.Zero(t, n)

		stamped, err := q.MarkBgmRebindChecked(ctx, 9910209)
		require.NoError(t, err)
		assert.Zero(t, stamped, "nor stamped: V1 is about to search it, and a stamp would hold a re-park back a week")
	})

	t.Run("the stamp leaves a bound row alone", func(t *testing.T) {
		rebindSeed(t, ctx, pool, rebindFixture{id: 9910207, bgmID: intp(9919208)})
		n, err := q.MarkBgmRebindChecked(ctx, 9910207)
		require.NoError(t, err)
		assert.Zero(t, n)
	})
}

func TestBgmRebindWorker(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	edgerunners := bangumi.SearchResult{
		ID: 9919301, Name: "Cyberpunk: Edgerunners 2", NameCN: "赛博朋克：边缘行者 2", Date: "2026-10-20", Eps: 10,
	}
	edgerunnersRow := rebindFixture{
		id: 9910301, native: "サイバーパンク: エッジランナーズ2", romaji: "Cyberpunk: Edgerunners 2",
		source: strp("fuzzy_low"), adminFlag: strp("needs-review"), status: "NOT_YET_RELEASED",
		seasonYear: 2026, episodes: 10,
	}

	t.Run("kill switch off searches nothing", func(t *testing.T) {
		rebindSeed(t, ctx, pool, edgerunnersRow)
		t.Setenv(rebindWorkerEnv, "")
		search := &rebindStubSearch{}
		enq := &rebindStubEnqueuer{}

		rebindRun(t, ctx, pool, search, enq)

		assert.Empty(t, search.keywords)
		assert.Nil(t, rebindRead(t, ctx, pool, edgerunnersRow.id).bgmID)
		assert.False(t, rebindRead(t, ctx, pool, edgerunnersRow.id).stamped)
	})

	t.Run("a pass binds, dispatches V2, and stamps what it refused", func(t *testing.T) {
		noHit := rebindFixture{id: 9910302, native: "見つからない", status: "NOT_YET_RELEASED"}
		rebindSeed(t, ctx, pool, edgerunnersRow, noHit)
		t.Setenv(rebindWorkerEnv, "true")
		search := &rebindStubSearch{answers: map[string][]bangumi.SearchResult{
			"サイバーパンク: エッジランナーズ2": {edgerunners},
		}}
		enq := &rebindStubEnqueuer{}

		rebindRun(t, ctx, pool, search, enq)

		bound := rebindRead(t, ctx, pool, edgerunnersRow.id)
		require.NotNil(t, bound.bgmID)
		assert.EqualValues(t, edgerunners.ID, *bound.bgmID)
		assert.Equal(t, strp("赛博朋克：边缘行者 2"), bound.titleCN)
		assert.Nil(t, bound.adminFlag)
		assert.Equal(t, []queue.BangumiV2Args{{AnilistID: edgerunnersRow.id, BgmID: edgerunners.ID}}, enq.jobs,
			"exactly one V2 job, carrying this row's own pair")

		assert.True(t, rebindRead(t, ctx, pool, noHit.id).stamped, "a settled no-hit waits out the week")

		// The second pass finds nothing: one row is bound, the other stamped.
		search.keywords = nil
		rebindRun(t, ctx, pool, search, enq)
		assert.Empty(t, search.keywords, "a drained set must not spend the Bangumi bucket again this week")
		assert.Len(t, enq.jobs, 1)
	})

	t.Run("two rows reaching for one subject in a pass bind only the first", func(t *testing.T) {
		// One subject, one work.  The first row's bind commits before the
		// second row's collision check runs, so the second sees the subject
		// held and is stamped as taken.  The rows must be written one after
		// another for that: two binds in flight at once would each pass the
		// other's NOT EXISTS, and both would stand.
		subject := bangumi.SearchResult{ID: 9919311, Name: "同じ作品", NameCN: "同一部作品", Date: "2026-10-01"}
		first := rebindFixture{id: 9910311, native: "同じ作品", popularity: 200, seasonYear: 2026}
		second := rebindFixture{id: 9910312, native: "同じ作品", popularity: 100, seasonYear: 2026}
		rebindSeed(t, ctx, pool, first, second)
		t.Setenv(rebindWorkerEnv, "true")
		search := &rebindStubSearch{answers: map[string][]bangumi.SearchResult{"同じ作品": {subject}}}
		enq := &rebindStubEnqueuer{}

		rebindRun(t, ctx, pool, search, enq)

		require.Len(t, search.keywords, 2, "both rows were searched")
		won := rebindRead(t, ctx, pool, first.id)
		require.NotNil(t, won.bgmID, "the more popular row comes first and binds")
		assert.EqualValues(t, subject.ID, *won.bgmID)

		lost := rebindRead(t, ctx, pool, second.id)
		assert.Nil(t, lost.bgmID, "a second row on the same subject would show the first one's titles")
		assert.True(t, lost.stamped, "taken is a settled answer for the week")
		assert.Equal(t, []queue.BangumiV2Args{{AnilistID: first.id, BgmID: subject.ID}}, enq.jobs)
	})

	t.Run("an enqueue failure rolls the bind back and leaves the row for the next fire", func(t *testing.T) {
		rebindSeed(t, ctx, pool, edgerunnersRow)
		t.Setenv(rebindWorkerEnv, "true")
		search := &rebindStubSearch{answers: map[string][]bangumi.SearchResult{
			"サイバーパンク: エッジランナーズ2": {edgerunners},
		}}
		enq := &rebindStubEnqueuer{err: errors.New("river InsertManyTx failed")}

		rebindRun(t, ctx, pool, search, enq)

		require.NoError(t, enq.txErr, "the enqueuer must be handed the live transaction")
		require.Equal(t, 1, enq.boundInTx, "the bind was written inside that transaction")

		s := rebindRead(t, ctx, pool, edgerunnersRow.id)
		assert.Nil(t, s.bgmID, "a bound row with no V2 behind it would never be enriched")
		assert.False(t, s.stamped, "nothing was decided, so the row must not wait a week")
		assert.Equal(t, strp("needs-review"), s.adminFlag)
	})
}

// TestBgmRebindStampLeavesWithTheBinding pins the invariant the bind
// statement's provenance claim rests on: no version-0 row carries a stamp.
// Every statement that sends a row back to V1 clears it with the binding, so
// a later V1 bind (also 'fuzzy_high') cannot be mistaken for the sweep's.
func TestBgmRebindStampLeavesWithTheBinding(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	resets := []struct {
		name  string
		row   rebindFixture
		reset func(id int) error
	}{
		{
			name: "admin reset",
			row:  rebindFixture{id: 9910401, bgmID: intp(9919401), source: strp("fuzzy_high"), stampedAgo: time.Hour},
			reset: func(id int) error {
				return q.ResetAnimeEnrichment(ctx, int32(id))
			},
		},
		{
			name: "backfill reset",
			row:  rebindFixture{id: 9910402, bgmID: intp(9919402), source: strp("fuzzy_high"), stampedAgo: time.Hour},
			reset: func(id int) error {
				return q.BackfillResetRows(ctx, []int32{int32(id)})
			},
		},
		{
			// Repudiation only reaches a binding nothing vouched for, so this
			// row has no recorded source.
			name: "legacy binding withdrawn",
			row:  rebindFixture{id: 9910403, bgmID: intp(9919403), stampedAgo: time.Hour},
			reset: func(id int) error {
				n, err := q.RepudiateLegacyBangumiBinding(ctx, int32(id), 9919403)
				if err == nil && n != 1 {
					return fmt.Errorf("repudiation reached %d rows, want 1", n)
				}
				return err
			},
		},
	}
	for _, tc := range resets {
		t.Run(tc.name, func(t *testing.T) {
			rebindSeed(t, ctx, pool, tc.row)
			require.True(t, rebindRead(t, ctx, pool, tc.row.id).stamped)

			require.NoError(t, tc.reset(tc.row.id))

			s := rebindRead(t, ctx, pool, tc.row.id)
			require.EqualValues(t, 0, s.version, "the reset hands the row back to V1")
			assert.False(t, s.stamped, "a version-0 row must not carry the sweep's stamp")
		})
	}
}
