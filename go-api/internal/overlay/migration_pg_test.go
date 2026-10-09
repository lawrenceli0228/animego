package overlay

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestMigration0047_PG applies 0047 over a schema at 0045 while another
// transaction holds ACCESS EXCLUSIVE on every table AniList or the sweeps
// write (a file that touched one would wait, and time out here), checks
// the new tables' constraints and the widened notification types, then
// runs it down and up again.
func TestMigration0047_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	testutil.MigrateTo(t, uri, 45)
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
	tables := `SELECT count(*) FROM information_schema.tables
		WHERE table_name IN ('edit_submissions', 'edit_items', 'entity_overlays')`

	exec(`INSERT INTO users (id, username, email, password) VALUES
		('00000000-0000-0000-0000-000000000001', 'submitter', 's@example.test', 'x'),
		('00000000-0000-0000-0000-000000000002', 'reviewer', 'r@example.test', 'x')`)
	exec(`INSERT INTO notifications (user_id, actor_id, notification_type, dedupe_key) VALUES
		('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'follow', 'follow:old')`)
	require.Zero(t, count(tables))

	t.Run("0047 applies while the upstream-owned tables are locked", func(t *testing.T) {
		const bound = 10 * time.Second
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `LOCK TABLE anime_cache, anime_characters, anime_character_voices, anime_staff,
			people, characters, bgm_person_map, bgm_character_map IN ACCESS EXCLUSIVE MODE`)
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
		testutil.MigrateTo(t, uri, 47)
		close(applied)
		<-released
		assert.Less(t, time.Since(start), bound, "0047 waited for a lock on a table it should not touch")
	})

	t.Run("the three tables and their constraints", func(t *testing.T) {
		assert.Equal(t, 3, count(tables))
		assert.Equal(t, 1, count(`SELECT count(*) FROM notifications WHERE dedupe_key = 'follow:old'`),
			"existing notifications pass the widened constraint")

		exec(`INSERT INTO edit_submissions (id, user_id, kind, entity_id, snapshot, source_url, item_count) VALUES
			('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'character', 184313, '{}', 'https://example.org', 2)`)
		exec(`INSERT INTO edit_items (submission_id, position, field, old_value, new_value) VALUES
			('10000000-0000-0000-0000-000000000001', 0, 'nameCn', '"旧"', '"新"')`)
		exec(`INSERT INTO edit_items (submission_id, position, field, item_key, old_value, new_value) VALUES
			('10000000-0000-0000-0000-000000000001', 1, 'role', '154587', '"MAIN"', '"SUPPORTING"')`)
		exec(`INSERT INTO entity_overlays (kind, entity_id, data) VALUES ('character', 184313, '{"nameCn":"新"}')`)
		exec(`INSERT INTO notifications (user_id, actor_id, notification_type, edit_submission_id, dedupe_key) VALUES
			('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'edit_review',
			 '10000000-0000-0000-0000-000000000001', 'edit_review:10000000-0000-0000-0000-000000000001')`)

		for _, bad := range []string{
			// kind, entity, empty source, blank items
			`INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, item_count) VALUES ('00000000-0000-0000-0000-000000000002', 'anime', 1, '{}', 'x', 1)`,
			`INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, item_count) VALUES ('00000000-0000-0000-0000-000000000002', 'person', 0, '{}', 'x', 1)`,
			`INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, item_count) VALUES ('00000000-0000-0000-0000-000000000002', 'person', 1, '{}', '', 1)`,
			`INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, item_count) VALUES ('00000000-0000-0000-0000-000000000002', 'person', 1, '{}', 'x', 0)`,
			`INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, item_count) VALUES ('00000000-0000-0000-0000-000000000002', 'person', 1, '[]', 'x', 1)`,
			// a second open submission by the same person for the same page
			`INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, item_count) VALUES ('00000000-0000-0000-0000-000000000001', 'character', 184313, '{}', 'x', 1)`,
			// reviewed without the counts adding up, or pending with a reviewer
			`UPDATE edit_submissions SET status = 'reviewed', reviewed_at = now(), accepted_count = 1 WHERE id = '10000000-0000-0000-0000-000000000001'`,
			`UPDATE edit_submissions SET reviewed_at = now() WHERE id = '10000000-0000-0000-0000-000000000001'`,
			// an unknown field, a field twice, a rejection without its note, a note without a rejection
			`INSERT INTO edit_items (submission_id, position, field, old_value, new_value) VALUES ('10000000-0000-0000-0000-000000000001', 5, 'score', 'null', '1')`,
			`INSERT INTO edit_items (submission_id, position, field, old_value, new_value) VALUES ('10000000-0000-0000-0000-000000000001', 6, 'nameCn', 'null', '"x"')`,
			`UPDATE edit_items SET status = 'rejected' WHERE position = 0`,
			`UPDATE edit_items SET reject_note = 'why' WHERE position = 0`,
			`UPDATE edit_items SET status = 'rejected', reject_note = '   ' WHERE position = 0`,
			// overlays: kind, id, shape
			`INSERT INTO entity_overlays (kind, entity_id, data) VALUES ('anime', 1, '{}')`,
			`INSERT INTO entity_overlays (kind, entity_id, data) VALUES ('person', -1, '{}')`,
			`INSERT INTO entity_overlays (kind, entity_id, data) VALUES ('person', 1, '"x"')`,
			// an edit_review notification names its submission
			`INSERT INTO notifications (user_id, actor_id, notification_type, dedupe_key) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'edit_review', 'edit_review:x')`,
			`INSERT INTO notifications (user_id, actor_id, notification_type, dedupe_key) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'poke', 'poke:x')`,
		} {
			_, err := pool.Exec(ctx, bad)
			assert.Error(t, err, bad)
		}

		exec(`UPDATE edit_items SET status = 'rejected', reject_note = '是第二季的造型' WHERE position = 0`)
		exec(`UPDATE edit_items SET status = 'accepted' WHERE position = 1`)
		exec(`UPDATE edit_submissions SET status = 'reviewed', reviewed_at = now(), reviewed_by = '00000000-0000-0000-0000-000000000002',
			accepted_count = 1, rejected_count = 1 WHERE id = '10000000-0000-0000-0000-000000000001'`)
		exec(`INSERT INTO edit_submissions (user_id, kind, entity_id, snapshot, source_url, item_count) VALUES
			('00000000-0000-0000-0000-000000000001', 'character', 184313, '{}', 'https://example.org', 1)`)

		// The submitter's account goes, and their submissions and the
		// notification about them with it; the accepted overlay stays.
		exec(`DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000001'`)
		assert.Zero(t, count(`SELECT count(*) FROM edit_submissions`))
		assert.Zero(t, count(`SELECT count(*) FROM edit_items`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM entity_overlays`))
	})

	t.Run("down drops the tables and the type; up again", func(t *testing.T) {
		exec(`INSERT INTO users (id, username, email, password) VALUES
			('00000000-0000-0000-0000-000000000003', 'submitter2', 's2@example.test', 'x')`)
		exec(`INSERT INTO edit_submissions (id, user_id, kind, entity_id, snapshot, source_url, item_count) VALUES
			('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'person', 133507, '{}', 'https://example.org', 1)`)
		exec(`INSERT INTO notifications (user_id, actor_id, notification_type, edit_submission_id, dedupe_key) VALUES
			('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'edit_review',
			 '10000000-0000-0000-0000-000000000002', 'edit_review:10000000-0000-0000-0000-000000000002')`)

		testutil.MigrateTo(t, uri, 45)
		assert.Zero(t, count(tables))
		assert.Zero(t, count(`SELECT count(*) FROM information_schema.columns
			WHERE table_name = 'notifications' AND column_name = 'edit_submission_id'`))
		_, err := pool.Exec(ctx, `INSERT INTO notifications (user_id, actor_id, notification_type, dedupe_key) VALUES
			('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'edit_review', 'edit_review:y')`)
		assert.Error(t, err, "the type is gone with the tables")

		testutil.MigrateTo(t, uri, 47)
		assert.Equal(t, 3, count(tables))
		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
	})
}
