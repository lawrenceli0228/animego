//go:build integration

// episode_title_provenance_repair_test.go — migration 0030 against a real
// Postgres, run over rows shaped like the ones it was written for.
//
// The migration has already been applied by the time this test starts, so
// asserting on production-shaped rows would prove nothing.  Instead the test
// seeds the two broken shapes AFTER migration, then executes 0030's own file
// off disk and checks what it did.  Reading the file rather than restating its
// SQL is the point: a copy in the test would keep passing after someone edited
// the migration.
//
// What the shapes mean, and why the repair direction is what it is:
//
//	name_source set, name NULL      a writer replaced the value and left the
//	                                label. The label is the lie -- retract it.
//	name set, name_source NULL      a writer set the value through the
//	                                pre-0029 statement, which never touched
//	                                source columns. The value is real; only
//	                                Bangumi-backed writers can produce this
//	                                shape, so 'bangumi' is a fact rather than
//	                                a guess.
//
// A label with no value behind it is not inert.  UpsertEpisodeTitleSourced
// scores precedence against the source column, so an empty column wearing a
// 'ddp' label reads as CLAIMED at that rank and refuses every automatic writer
// ranked at or below it.  That is what made 1,966 production episodes
// permanently unfillable, and it is the property the last subtest pins.
package integration

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const provRepairMigration = "../../migrations/0030_repair_episode_title_provenance.up.sql"

func TestEpisodeTitleProvenanceRepair(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)

	const animeID = 990301

	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_romaji, bgm_id)
		VALUES ($1, 'Provenance Repair Fixture', 990301)
		ON CONFLICT (anilist_id) DO NOTHING`, animeID)
	require.NoError(t, err, "seed anime_cache")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM anime_episode_titles WHERE anime_id = $1`, animeID)
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM anime_cache WHERE anilist_id = $1`, animeID)
	})

	// Episode 1 — the 1,966-row shape: a 'ddp' claim over two empty columns.
	// Episode 2 — the mirror on the Chinese column only, with a real Japanese
	//             name beside it, so the repair must touch one half and not
	//             the other.
	// Episode 3 — a value with no label at all.
	// Episode 4 — already correct; must come out untouched.
	_, err = pool.Exec(ctx, `
		INSERT INTO anime_episode_titles (anime_id, episode, name, name_cn, name_source, name_cn_source)
		VALUES ($1, 1, NULL,     NULL,   'ddp',     NULL),
		       ($1, 2, 'サムライ', NULL,   'bangumi', 'ddp'),
		       ($1, 3, 'Orphan',  NULL,   NULL,      NULL),
		       ($1, 4, 'Kept',    '保留', 'ddp',     'ddp')`, animeID)
	require.NoError(t, err, "seed broken rows")

	sqlBytes, err := os.ReadFile(provRepairMigration)
	require.NoError(t, err, "read migration 0030 off disk")
	_, err = pool.Exec(ctx, string(sqlBytes))
	require.NoError(t, err, "apply migration 0030")

	type row struct {
		name, nameCn, nameSrc, nameCnSrc *string
	}
	read := func(t *testing.T, ep int32) row {
		t.Helper()
		var r row
		err := pool.QueryRow(ctx, `
			SELECT name, name_cn, name_source, name_cn_source
			FROM anime_episode_titles WHERE anime_id = $1 AND episode = $2`,
			animeID, ep).Scan(&r.name, &r.nameCn, &r.nameSrc, &r.nameCnSrc)
		require.NoError(t, err)
		return r
	}

	t.Run("a label with no value is retracted", func(t *testing.T) {
		r := read(t, 1)
		assert.Nil(t, r.nameSrc, "'ddp' claimed a column holding nothing; the claim is what was false")
		assert.Nil(t, r.name, "the payload column must not be invented")
	})

	t.Run("the repair is per field, not per row", func(t *testing.T) {
		r := read(t, 2)
		require.NotNil(t, r.name)
		assert.Equal(t, "サムライ", *r.name, "the real value must survive")
		require.NotNil(t, r.nameSrc)
		assert.Equal(t, "bangumi", *r.nameSrc, "its correct label must survive too")
		assert.Nil(t, r.nameCnSrc, "only the half that claimed an empty column is retracted")
	})

	t.Run("a value with no label is attributed to bangumi", func(t *testing.T) {
		r := read(t, 3)
		require.NotNil(t, r.nameSrc)
		assert.Equal(t, "bangumi", *r.nameSrc,
			"only the pre-0029 queue writers can leave a value unlabelled, and both read /subject/{id}/ep")
		require.NotNil(t, r.name)
		assert.Equal(t, "Orphan", *r.name)
	})

	t.Run("a correct row is left alone", func(t *testing.T) {
		r := read(t, 4)
		require.NotNil(t, r.nameSrc)
		require.NotNil(t, r.nameCnSrc)
		assert.Equal(t, "ddp", *r.nameSrc)
		assert.Equal(t, "ddp", *r.nameCnSrc, "a 'ddp' label BACKED by a value is not the bug")
	})

	t.Run("re-running changes nothing", func(t *testing.T) {
		before := []row{read(t, 1), read(t, 2), read(t, 3), read(t, 4)}
		_, err := pool.Exec(ctx, string(sqlBytes))
		require.NoError(t, err, "0030 must be safe to apply twice")
		after := []row{read(t, 1), read(t, 2), read(t, 3), read(t, 4)}
		assert.Equal(t, before, after,
			"both statements' WHERE clauses describe exactly the rows their SET clauses change")
	})

	t.Run("no orphan shape survives", func(t *testing.T) {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT count(*) FROM anime_episode_titles
			WHERE anime_id = $1 AND (
			      (name    IS NULL     AND name_source    IS NOT NULL)
			   OR (name_cn IS NULL     AND name_cn_source IS NOT NULL)
			   OR (name    IS NOT NULL AND name_source    IS NULL)
			   OR (name_cn IS NOT NULL AND name_cn_source IS NULL))`,
			animeID).Scan(&n))
		assert.Zero(t, n, "value and source must agree in both directions after the repair")
	})
}
