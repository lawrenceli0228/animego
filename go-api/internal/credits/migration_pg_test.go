package credits

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestMigration0042_PG exercises 0042 against rows planted under 0041:
// the dedupe that lets the unique indexes exist, the write path of the
// binary that predates 0042 (which runs against this schema for the
// length of a deploy), and the down migration.
func TestMigration0042_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	testutil.MigrateTo(t, uri, 41)
	pool := testutil.NewWebPool(t, ctx, uri)

	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n), sql)
		return n
	}

	exec(`INSERT INTO anime_cache (anilist_id, title_romaji) VALUES (1, 'one'), (2, 'two')`)
	// Characters: 10 twice (the later copy at display_order 1 is AniList's
	// first), 11 once, and two pre-0037 rows with no id.
	exec(`INSERT INTO anime_characters (anime_id, display_order, name_en, character_id) VALUES
		(1, 3, 'dup late', 10), (1, 1, 'dup early', 10), (1, 0, 'eleven', 11),
		(1, 2, 'legacy a', NULL), (1, 2, 'legacy b', NULL), (2, 0, 'other title', 10)`)
	// Staff: (5, no role) twice, (5, Director), (6, Music) twice.
	exec(`INSERT INTO anime_staff (anime_id, display_order, name_en, role, staff_id) VALUES
		(1, 2, 'five late', NULL, 5), (1, 0, 'five early', NULL, 5), (1, 1, 'five director', 'Director', 5),
		(1, 3, 'six', 'Music', 6), (1, 4, 'six again', 'Music', 6), (1, 5, 'legacy', 'Music', NULL)`)

	testutil.MigrateTo(t, uri, 42)

	t.Run("duplicates are removed, keeping the copy listed first", func(t *testing.T) {
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1 AND character_id = 10`))
		assert.Equal(t, 1, count(`SELECT display_order FROM anime_characters WHERE anime_id = 1 AND character_id = 10`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 2 AND character_id = 10`),
			"the same character on another title is not a duplicate")
		assert.Equal(t, 2, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1 AND character_id IS NULL`),
			"rows without an id are outside the key and are left alone")

		assert.Equal(t, 0, count(`SELECT display_order FROM anime_staff WHERE anime_id = 1 AND staff_id = 5 AND role IS NULL`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1 AND staff_id = 5 AND role IS NULL`),
			"an empty role is one key (NULLS NOT DISTINCT), so its copies are duplicates")
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1 AND staff_id = 5 AND role = 'Director'`))
		assert.Equal(t, 3, count(`SELECT display_order FROM anime_staff WHERE anime_id = 1 AND staff_id = 6`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1 AND staff_id IS NULL`))
	})

	t.Run("the new columns and table are there and empty", func(t *testing.T) {
		assert.Equal(t, 2, count(`SELECT count(*) FROM anime_cache
			WHERE cast_has_more IS NULL AND cast_checked_at IS NULL AND staff_has_more IS NULL AND staff_checked_at IS NULL`))
		exec(`INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, language)
			VALUES (2, 10, 900, 0, 'Japanese')`)
		_, err := pool.Exec(ctx, `INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order) VALUES (2, 0, 900, 0)`)
		assert.Error(t, err, "ids are positive")
		exec(`DELETE FROM anime_cache WHERE anilist_id = 2`)
		assert.Equal(t, 0, count(`SELECT count(*) FROM anime_character_voices`), "voices go with their title")
	})

	// The binary that predates 0042 keeps serving while the new one
	// builds.  Its whole credit write is: delete every row of the title,
	// insert page 1.  Those exact statement shapes must still succeed.
	t.Run("the pre-0042 delete-and-insert write still works", func(t *testing.T) {
		oldWrite(t, ctx, pool, 1)
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1`))
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1`))
		oldWrite(t, ctx, pool, 1) // and again, as the next refresh would
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1`))

		// The one shape it can no longer write: the same key twice inside
		// a single page.  AniList's connections carry one edge per pair,
		// so this is the documented edge, pinned rather than hoped about.
		_, err := pool.Exec(ctx, `INSERT INTO anime_characters (anime_id, display_order, character_id) VALUES (1, 9, 101)`)
		assert.Error(t, err)
	})

	t.Run("down trims rows beyond the first page and drops what 0042 added", func(t *testing.T) {
		exec(`INSERT INTO anime_characters (anime_id, display_order, character_id)
			SELECT 1, 100 + g, 1000 + g FROM generate_series(0, 39) g`)
		exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, role)
			SELECT 1, 100 + g, 1000 + g, 'Key Animation' FROM generate_series(0, 39) g`)

		testutil.MigrateTo(t, uri, 41)

		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1`),
			"the build that predates 0042 reads every row; only the first page may remain")
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1`))
		assert.Equal(t, 0, count(`SELECT count(*) FROM information_schema.tables WHERE table_name = 'anime_character_voices'`))
		assert.Equal(t, 0, count(`SELECT count(*) FROM information_schema.columns
			WHERE table_name = 'anime_cache' AND column_name IN ('cast_has_more', 'cast_checked_at', 'staff_has_more', 'staff_checked_at')`))
		assert.Equal(t, 0, count(`SELECT count(*) FROM pg_indexes
			WHERE indexname IN ('anime_characters_anime_character_uidx', 'anime_staff_anime_staff_role_uidx')`))

		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
	})
}

// oldWrite replays the credit statements the pre-0042 detail refresh ran
// (DeleteAnimeCharacters + InsertAnimeCharacter, DeleteAnimeStaff +
// InsertAnimeStaffMember), as the old binary sends them.
func oldWrite(t *testing.T, ctx context.Context, pool *pgxpool.Pool, animeID int32) {
	t.Helper()
	stmts := []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM anime_characters WHERE anime_id = $1`, []any{animeID}},
		{`DELETE FROM anime_staff WHERE anime_id = $1`, []any{animeID}},
	}
	for i := int32(0); i < 3; i++ {
		stmts = append(stmts,
			struct {
				sql  string
				args []any
			}{`INSERT INTO anime_characters (
				anime_id, display_order, name_en, name_ja, name_cn, image_url, role,
				voice_actor_en, voice_actor_ja, voice_actor_image_url, character_id, voice_actor_id
			) VALUES ($1, $2, 'n', NULL, NULL, NULL, 'MAIN', 'va', NULL, NULL, $3, $4)`,
				[]any{animeID, i, 100 + i, 500 + i}},
			struct {
				sql  string
				args []any
			}{`INSERT INTO anime_staff (anime_id, display_order, name_en, name_ja, image_url, role, staff_id)
			VALUES ($1, $2, 's', NULL, NULL, NULL, $3)`,
				[]any{animeID, i, 200 + i}},
		)
	}
	for _, s := range stmts {
		_, err := pool.Exec(ctx, s.sql, s.args...)
		require.NoError(t, err, s.sql)
	}
}
