package anime

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestUpsertAnimeCache_FactsSurviveListingUpsert is the pg-level half of
// the fix: the four facts written by a detail upsert must survive a later
// listing upsert that does not carry them, and the detail stamp must too.
// Both are ON CONFLICT semantics (COALESCE for the facts, CASE for the
// stamp), which is exactly the part no unit test over NormalizeMainRow
// can see.
func TestUpsertAnimeCache_FactsSurviveListingUpsert(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	media := anilist.Media{
		ID:        174184,
		Title:     &anilist.Title{Romaji: sptr("Dearest Blue")},
		StartDate: &anilist.FuzzyDate{Year: iptr(2024), Month: iptr(4), Day: iptr(26)},
		Duration:  iptr(23),
		Source:    sptr("VISUAL_NOVEL"),
	}

	// 1. Detail document: facts land, row is stamped.
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(media, anilist.DetailDocument)))
	row, err := q.GetAnimeMainByID(ctx, 174184)
	require.NoError(t, err)
	require.True(t, row.StartDate.Valid)
	assert.Equal(t, time.Date(2024, 4, 26, 0, 0, 0, 0, time.UTC), row.StartDate.Time)
	assert.False(t, row.EndDate.Valid, "AniList had no end date yet")
	require.NotNil(t, row.Duration)
	assert.Equal(t, int32(23), *row.Duration)
	require.NotNil(t, row.Source)
	assert.Equal(t, "VISUAL_NOVEL", *row.Source)
	require.True(t, row.DetailFetchedAt.Valid, "detail document must stamp the row")
	stampedAt := row.DetailFetchedAt.Time

	// 2. Listing document for the same id: no facts selected, no children
	//    selected.  Nothing it does not know may be erased.
	listing := anilist.Media{ID: 174184, Title: &anilist.Title{Romaji: sptr("Dearest Blue (listing)")}}
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(listing, anilist.SeasonalDocument)))
	row, err = q.GetAnimeMainByID(ctx, 174184)
	require.NoError(t, err)
	assert.Equal(t, "Dearest Blue (listing)", *row.TitleRomaji, "the listing's own columns do overwrite")
	require.True(t, row.StartDate.Valid, "start_date must survive a listing upsert")
	assert.Equal(t, time.Date(2024, 4, 26, 0, 0, 0, 0, time.UTC), row.StartDate.Time)
	require.NotNil(t, row.Duration)
	assert.Equal(t, int32(23), *row.Duration)
	require.NotNil(t, row.Source)
	assert.Equal(t, "VISUAL_NOVEL", *row.Source)
	require.True(t, row.DetailFetchedAt.Valid, "a listing upsert must not un-stamp the row")
	assert.True(t, row.DetailFetchedAt.Time.Equal(stampedAt), "stamp is the detail fetch's time, not the listing's")

	// 3. Detail document again, now with an end date: a newly known fact is
	//    written, the rest are overwritten with what AniList says now.
	media.EndDate = &anilist.FuzzyDate{Year: iptr(2024), Month: iptr(7), Day: iptr(12)}
	media.Duration = iptr(24)
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(media, anilist.DetailDocument)))
	row, err = q.GetAnimeMainByID(ctx, 174184)
	require.NoError(t, err)
	require.True(t, row.EndDate.Valid)
	assert.Equal(t, time.Date(2024, 7, 12, 0, 0, 0, 0, time.UTC), row.EndDate.Time)
	assert.Equal(t, int32(24), *row.Duration)
	assert.True(t, row.DetailFetchedAt.Time.After(stampedAt), "a second detail fetch re-stamps")
}

// TestMigration0034_StampsRowsWithChildRows exercises the one-time backfill
// in 0034: a row with child rows in a detail-only table is stamped with its
// cached_at; a row with none stays NULL; a row whose only child rows are
// genres (which the listing path also writes) stays NULL.
func TestMigration0034_StampsRowsWithChildRows(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)

	// Step back to the schema 0034 expects to find, plant rows, apply it.
	testutil.MigrateTo(t, uri, 33)
	cachedAt := time.Date(2026, 9, 14, 15, 24, 46, 0, time.UTC)
	for _, id := range []int32{1, 2, 3} {
		_, err := pool.Exec(ctx,
			`INSERT INTO anime_cache (anilist_id, title_romaji, cached_at) VALUES ($1, $2, $3)`,
			id, "row", cachedAt)
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx,
		`INSERT INTO anime_staff (anime_id, display_order, name_en, role) VALUES (1, 0, 'Someone', 'Director')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO anime_genres (anime_id, genre) VALUES (3, 'Action')`)
	require.NoError(t, err)

	testutil.MigrateTo(t, uri, 34)

	var got = map[int32]pgtype.Timestamptz{}
	rows, err := pool.Query(ctx, `SELECT anilist_id, detail_fetched_at FROM anime_cache ORDER BY anilist_id`)
	require.NoError(t, err)
	for rows.Next() {
		var id int32
		var ts pgtype.Timestamptz
		require.NoError(t, rows.Scan(&id, &ts))
		got[id] = ts
	}
	rows.Close()
	require.NoError(t, rows.Err())

	require.True(t, got[1].Valid, "row with a staff child is stamped")
	assert.True(t, got[1].Time.Equal(cachedAt), "stamp is the row's cached_at, not now()")
	assert.False(t, got[2].Valid, "row with no children stays NULL and pays one fetch")
	assert.False(t, got[3].Valid, "genres alone say nothing about the detail path")

	// Leave the schema where every other test expects it.
	testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
}
