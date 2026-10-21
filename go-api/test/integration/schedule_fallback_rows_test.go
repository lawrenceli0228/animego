//go:build integration

// schedule_fallback_rows_test.go — ListScheduleFallbackRows against a real
// Postgres.
//
// /schedule falls back to this query when AniList cannot be asked, and what
// it leaves out is as much the contract as what it returns: an adult title
// or a Hentai-tagged one must never reach the public schedule page, a title
// with nothing scheduled has no place on it, and a statement older than the
// staleness floor is too old to step forward.  Each of those is a WHERE
// clause, so each is shown here rather than in a unit test with a fake.
//
// Hermeticity: one transaction rolled back in t.Cleanup.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

func TestListScheduleFallbackRows(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	var held int
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT count(*) FROM anime_cache WHERE anilist_id BETWEEN 9970000 AND 9979999`).Scan(&held))
	require.Zero(t, held, "fixture id range must be unheld before seeding")

	today := time.Date(2026, 10, 21, 16, 0, 0, 0, time.UTC) // 00:00 on the 22nd, UTC+8
	day := 24 * time.Hour
	weekEnd := today.Add(7 * day)
	staleFloor := today.Add(-28 * day)

	seed := func(id int32, nextAt *time.Time, nextEp *int32, isAdult bool, color *string) {
		t.Helper()
		_, err := tx.Exec(ctx, `
			INSERT INTO anime_cache (
				anilist_id, title_romaji, cover_image_url, cover_image_color, format,
				average_score, episodes, is_adult, next_airing_at, next_airing_episode, cached_at
			) VALUES ($1, 'Fixture', 'https://s4.anilist.co/x.jpg', $2, 'TV', 71.5, 12, $3, $4, $5, now())`,
			id, color, isAdult, nextAt, nextEp)
		require.NoError(t, err, "seed anime_cache %d", id)
	}
	at := func(d time.Duration) *time.Time { v := today.Add(d); return &v }
	ep := func(n int32) *int32 { return &n }
	blue := "#3b82f6"

	seed(9970001, at(2*day), ep(5), false, &blue) // in the week
	seed(9970002, at(-3*day), ep(7), false, nil)  // stale, steppable
	seed(9970003, at(-27*day), ep(2), false, nil) // just inside the floor
	seed(9970004, at(-29*day), ep(2), false, nil) // past the floor
	seed(9970005, at(7*day), ep(9), false, nil)   // at the week's end: out
	seed(9970006, nil, nil, false, nil)           // nothing scheduled
	seed(9970007, at(day), ep(3), true, nil)      // adult
	seed(9970008, at(day), ep(3), false, nil)     // Hentai-tagged, below
	_, err = tx.Exec(ctx, `
		INSERT INTO anime_genres (anime_id, genre) VALUES
			(9970001, 'Drama'), (9970001, 'Action'), (9970008, 'Hentai')`)
	require.NoError(t, err, "seed anime_genres")

	rows, err := dbgen.New(tx).ListScheduleFallbackRows(ctx,
		pgtype.Timestamptz{Time: staleFloor, Valid: true},
		pgtype.Timestamptz{Time: weekEnd, Valid: true},
	)
	require.NoError(t, err)

	var ids []int32
	byID := map[int32]dbgen.ListScheduleFallbackRowsRow{}
	for _, r := range rows {
		if r.AnilistID < 9970000 || r.AnilistID > 9979999 {
			continue
		}
		ids = append(ids, r.AnilistID)
		byID[r.AnilistID] = r
	}
	assert.Equal(t, []int32{9970003, 9970002, 9970001}, ids, "ordered by next airing; floor, week end, unscheduled, adult and Hentai left out")

	inWeek := byID[9970001]
	require.True(t, inWeek.NextAiringAt.Valid)
	assert.True(t, today.Add(2*day).Equal(inWeek.NextAiringAt.Time))
	assert.Equal(t, int32(5), inWeek.NextAiringEpisode)
	assert.Equal(t, []string{"Action", "Drama"}, inWeek.Genres, "genres sorted")
	require.NotNil(t, inWeek.Episodes)
	assert.Equal(t, int32(12), *inWeek.Episodes)
	require.NotNil(t, inWeek.AverageScore)
	assert.InDelta(t, 71.5, *inWeek.AverageScore, 0.001)
	require.NotNil(t, inWeek.CoverImageColor)
	assert.Equal(t, blue, *inWeek.CoverImageColor)
	assert.Empty(t, byID[9970002].Genres, "a title without genres scans as empty, not an error")
}
