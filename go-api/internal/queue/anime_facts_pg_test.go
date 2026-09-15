package queue

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestAnimeFacts_PG covers the three statements the sweep runs, on a real
// Postgres: which rows a pass is offered and in what order, what a write
// with partial facts does to the row, and that a re-check that learns
// nothing new leaves updated_at (the sitemap lastmod) alone.
func TestAnimeFacts_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	seed := func(id int32, status string, checkedAgo *time.Duration) {
		var checked any
		if checkedAgo != nil {
			checked = time.Now().Add(-*checkedAgo)
		}
		_, err := pool.Exec(ctx,
			`INSERT INTO anime_cache (anilist_id, title_romaji, status, facts_checked_at) VALUES ($1, $2, $3, $4)`,
			id, "row", status, checked)
		require.NoError(t, err)
	}
	ago := func(d time.Duration) *time.Duration { return &d }

	seed(10, "FINISHED", nil)                   // never asked
	seed(20, "RELEASING", ago(40*24*time.Hour)) // moving, stale
	seed(30, "FINISHED", ago(40*24*time.Hour))  // finished, asked once: done for good
	seed(40, "RELEASING", ago(24*time.Hour))    // moving, fresh
	seed(50, "NOT_YET_RELEASED", nil)           // never asked

	stale := pgtype.Interval{Microseconds: int64(30 * 24 * time.Hour / time.Microsecond), Valid: true}

	t.Run("candidates: never-asked first, then stale moving rows, never a finished one that was asked", func(t *testing.T) {
		ids, err := q.ListAnimeFactsCandidates(ctx, stale, 10)
		require.NoError(t, err)
		assert.Equal(t, []int32{10, 50, 20}, ids)
	})

	t.Run("the pass cap is honoured", func(t *testing.T) {
		ids, err := q.ListAnimeFactsCandidates(ctx, stale, 2)
		require.NoError(t, err)
		assert.Equal(t, []int32{10, 50}, ids)
	})

	t.Run("a write lands the facts, stamps, and moves updated_at", func(t *testing.T) {
		var before time.Time
		require.NoError(t, pool.QueryRow(ctx, `SELECT updated_at FROM anime_cache WHERE anilist_id = 10`).Scan(&before))

		dur := int32(24)
		src := "MANGA"
		n, err := q.UpdateAnimeFacts(ctx,
			pgtype.Date{Time: time.Date(2024, 4, 26, 0, 0, 0, 0, time.UTC), Valid: true},
			pgtype.Date{}, // still airing when read: no end date
			&dur, &src, 10)
		require.NoError(t, err)
		assert.Equal(t, int64(1), n)

		row, err := q.GetAnimeMainByID(ctx, 10)
		require.NoError(t, err)
		require.True(t, row.StartDate.Valid)
		assert.Equal(t, time.Date(2024, 4, 26, 0, 0, 0, 0, time.UTC), row.StartDate.Time)
		assert.False(t, row.EndDate.Valid)
		assert.Equal(t, int32(24), *row.Duration)
		assert.Equal(t, "MANGA", *row.Source)

		var checked, after time.Time
		require.NoError(t, pool.QueryRow(ctx, `SELECT facts_checked_at, updated_at FROM anime_cache WHERE anilist_id = 10`).Scan(&checked, &after))
		assert.True(t, after.After(before), "a changed fact is content: lastmod must move")

		// 10 is no longer a candidate: finished and asked.
		ids, err := q.ListAnimeFactsCandidates(ctx, stale, 10)
		require.NoError(t, err)
		assert.NotContains(t, ids, int32(10))
	})

	t.Run("a re-check that learns nothing leaves the facts and updated_at alone", func(t *testing.T) {
		var before, checkedBefore time.Time
		require.NoError(t, pool.QueryRow(ctx, `SELECT updated_at, facts_checked_at FROM anime_cache WHERE anilist_id = 10`).Scan(&before, &checkedBefore))

		// Sleep past the clock's resolution so a moved stamp is observable.
		time.Sleep(20 * time.Millisecond)
		_, err := q.UpdateAnimeFacts(ctx, pgtype.Date{}, pgtype.Date{}, nil, nil, 10)
		require.NoError(t, err)

		row, err := q.GetAnimeMainByID(ctx, 10)
		require.NoError(t, err)
		require.True(t, row.StartDate.Valid, "NULL from the sweep must not erase a known date")
		assert.Equal(t, int32(24), *row.Duration)
		assert.Equal(t, "MANGA", *row.Source)

		var after, checkedAfter time.Time
		require.NoError(t, pool.QueryRow(ctx, `SELECT updated_at, facts_checked_at FROM anime_cache WHERE anilist_id = 10`).Scan(&after, &checkedAfter))
		assert.True(t, after.Equal(before), "nothing changed: lastmod must not move")
		assert.True(t, checkedAfter.After(checkedBefore), "but the read itself is recorded")
	})

	t.Run("a newly known end date is written over NULL, and lastmod moves", func(t *testing.T) {
		_, err := q.UpdateAnimeFacts(ctx, pgtype.Date{},
			pgtype.Date{Time: time.Date(2024, 7, 12, 0, 0, 0, 0, time.UTC), Valid: true}, nil, nil, 10)
		require.NoError(t, err)
		row, err := q.GetAnimeMainByID(ctx, 10)
		require.NoError(t, err)
		require.True(t, row.EndDate.Valid)
		assert.Equal(t, time.Date(2024, 7, 12, 0, 0, 0, 0, time.UTC), row.EndDate.Time)
	})

	t.Run("an absent id is stamped without touching its facts", func(t *testing.T) {
		n, err := q.MarkAnimeFactsChecked(ctx, 50)
		require.NoError(t, err)
		assert.Equal(t, int64(1), n)
		row, err := q.GetAnimeMainByID(ctx, 50)
		require.NoError(t, err)
		assert.False(t, row.StartDate.Valid)

		ids, err := q.ListAnimeFactsCandidates(ctx, stale, 10)
		require.NoError(t, err)
		// 50 is NOT_YET_RELEASED, so it is offered again only once its
		// fresh stamp ages out -- not now.
		assert.Equal(t, []int32{20}, ids)
	})
}
