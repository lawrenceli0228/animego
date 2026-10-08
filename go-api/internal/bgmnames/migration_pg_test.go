package bgmnames

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestMigration0045_PG applies 0045 over a schema at 0044 while another
// transaction holds ACCESS EXCLUSIVE on every table the import reads or
// the detail page joins (a file that touched any of them would wait, and
// time out here), checks the two tables' constraints, then runs it down
// and up again.
func TestMigration0045_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	testutil.MigrateTo(t, uri, 44)
	pool := testutil.NewWebPool(t, ctx, uri)

	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err, sql)
	}
	count := func(sql string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql).Scan(&n), sql)
		return n
	}
	tables := `SELECT count(*) FROM information_schema.tables WHERE table_name IN ('bgm_person_map', 'bgm_character_map')`
	exec(`INSERT INTO anime_cache (anilist_id, title_romaji, bgm_id) VALUES (1, 'one', 400602)`)
	exec(`INSERT INTO anime_characters (anime_id, display_order, character_id, voice_actor_id) VALUES (1, 0, 10, 20)`)
	require.Zero(t, count(tables))

	t.Run("0045 applies while the tables it sits beside are locked", func(t *testing.T) {
		const bound = 10 * time.Second
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `LOCK TABLE anime_cache, anime_characters, anime_character_voices, anime_staff,
			people, characters IN ACCESS EXCLUSIVE MODE`)
		require.NoError(t, err)

		applied, released := make(chan struct{}), make(chan struct{})
		go func() {
			defer close(released)
			select {
			case <-applied:
			case <-time.After(bound):
			}
			_ = tx.Rollback(ctx)
		}()
		start := time.Now()
		testutil.MigrateTo(t, uri, 45)
		close(applied)
		<-released
		assert.Less(t, time.Since(start), bound, "0045 waited for a lock on a table it should not touch")
	})

	t.Run("two empty tables, with their constraints", func(t *testing.T) {
		assert.Equal(t, 2, count(tables))
		assert.Zero(t, count(`SELECT count(*) FROM bgm_person_map`), "no backfill: the import fills them")

		exec(`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (1, 7575, '种崎敦美', 'dump', now())`)
		exec(`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (2, 7576, NULL, 'dump', now())`)
		exec(`INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (1, 86246, '芙莉莲', 'dump', now())`)
		for _, bad := range []string{
			`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (3, 7575, 'x', 'dump', now())`,
			`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (0, 9, 'x', 'dump', now())`,
			`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (4, 0, 'x', 'dump', now())`,
			`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (5, 9, '  ', 'dump', now())`,
			`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (6, 10, 'x', NULL, now())`,
			`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source) VALUES (7, 11, 'x', 'dump')`,
			`INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (2, 86246, 'x', 'dump', now())`,
			`INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (-1, 9, 'x', 'dump', now())`,
		} {
			_, err := pool.Exec(ctx, bad)
			assert.Error(t, err, bad)
		}
	})

	t.Run("down drops both tables and nothing else; up again", func(t *testing.T) {
		testutil.MigrateTo(t, uri, 44)
		assert.Zero(t, count(tables))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_characters WHERE character_id = 10`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_cache WHERE bgm_id = 400602`))

		testutil.MigrateTo(t, uri, 45)
		assert.Equal(t, 2, count(tables))
		assert.Zero(t, count(`SELECT count(*) FROM bgm_person_map`))
		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
	})
}
