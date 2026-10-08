package profiles

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestMigration0044_PG applies 0044 over a schema at 0043 with credit rows
// in it, takes it down, and applies it again.
//
// The first subtest is the lock claim in 0044's header made checkable: the
// file is applied while another transaction holds ACCESS EXCLUSIVE on
// every table the sweep reads (anime_cache and the three credit tables).
// A file that touched any of them -- a foreign key, an index, an ALTER --
// would queue behind that transaction, as it would behind a long read in
// production, and this test would time out instead of passing.
func TestMigration0044_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	testutil.MigrateTo(t, uri, 43)
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
	tables := `SELECT count(*) FROM information_schema.tables WHERE table_name IN ('people', 'characters')`

	exec(`INSERT INTO anime_cache (anilist_id, title_romaji) VALUES (1, 'one')`)
	exec(`INSERT INTO anime_characters (anime_id, display_order, character_id, voice_actor_id) VALUES (1, 0, 10, 20)`)
	exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, role) VALUES (1, 0, 30, 'Director')`)
	exec(`INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order) VALUES (1, 10, 20, 0)`)
	require.Zero(t, count(tables))

	t.Run("0044 applies while the tables the sweep reads are locked", func(t *testing.T) {
		const bound = 10 * time.Second
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `LOCK TABLE anime_cache, anime_characters, anime_staff, anime_character_voices IN ACCESS EXCLUSIVE MODE`)
		require.NoError(t, err)

		applied := make(chan struct{})
		released := make(chan struct{})
		go func() {
			defer close(released)
			select {
			case <-applied:
			case <-time.After(bound):
			}
			_ = tx.Rollback(ctx)
		}()

		start := time.Now()
		testutil.MigrateTo(t, uri, 44)
		close(applied)
		<-released
		assert.Less(t, time.Since(start), bound, "0044 waited for a lock on a table it should not touch")
	})

	t.Run("two empty tables, with their constraints", func(t *testing.T) {
		assert.Equal(t, 2, count(tables))
		assert.Zero(t, count(`SELECT count(*) FROM people`), "no backfill: the sweep fills them")
		assert.Zero(t, count(`SELECT count(*) FROM characters`))

		exec(`INSERT INTO people (anilist_id, checked_at) VALUES (5, now())`)
		assert.Equal(t, 1, count(`SELECT count(*) FROM people
			WHERE name_alternative = '{}' AND primary_occupations = '{}' AND years_active = '{}'
			  AND fetched_at IS NULL AND absent_since IS NULL`), "a stamp-only row has empty lists, not NULLs")
		exec(`INSERT INTO characters (anilist_id, checked_at) VALUES (5, now())`)
		assert.Equal(t, 1, count(`SELECT count(*) FROM characters
			WHERE name_alternative = '{}' AND name_alternative_spoiler = '{}' AND fetched_at IS NULL`))

		for _, bad := range []string{
			`INSERT INTO people (anilist_id, checked_at) VALUES (0, now())`,
			`INSERT INTO people (anilist_id) VALUES (6)`,
			`INSERT INTO people (anilist_id, checked_at, birth_month) VALUES (7, now(), 13)`,
			`INSERT INTO people (anilist_id, checked_at, birth_day) VALUES (8, now(), 0)`,
			`INSERT INTO people (anilist_id, checked_at, death_month) VALUES (9, now(), 0)`,
			`INSERT INTO people (anilist_id, checked_at, death_day) VALUES (10, now(), 32)`,
			`INSERT INTO characters (anilist_id, checked_at) VALUES (-1, now())`,
			`INSERT INTO characters (anilist_id) VALUES (11)`,
			`INSERT INTO characters (anilist_id, checked_at, birth_month) VALUES (12, now(), 13)`,
			`INSERT INTO characters (anilist_id, checked_at, birth_day) VALUES (13, now(), 32)`,
		} {
			_, err := pool.Exec(ctx, bad)
			assert.Error(t, err, bad)
		}

		assert.Equal(t, 2, count(`SELECT count(*) FROM pg_indexes
			WHERE indexname IN ('people_checked_at_idx', 'characters_checked_at_idx')`))
	})

	t.Run("down drops both tables and nothing else; up again", func(t *testing.T) {
		testutil.MigrateTo(t, uri, 43)
		assert.Zero(t, count(tables))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_characters WHERE character_id = 10`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_staff WHERE staff_id = 30`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_character_voices WHERE staff_id = 20`))

		testutil.MigrateTo(t, uri, 44)
		assert.Equal(t, 2, count(tables))
		assert.Zero(t, count(`SELECT count(*) FROM people`), "the earlier rows went with the down")

		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
	})
}
