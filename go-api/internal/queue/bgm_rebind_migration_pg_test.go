package queue

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestMigration0051_PG pins the two things the migration's header promises
// about deploying it.
//
// The first is the lock: adding the column needs ACCESS EXCLUSIVE on
// anime_cache, which queues behind anything reading the table -- a nightly
// pg_dump holds ACCESS SHARE on every table for the whole dump -- and every
// catalogue read would queue behind the waiting ALTER.  lock_timeout is what
// turns that into a failed deploy instead of a hung site, and this test is
// what notices if the line goes.  The second is the recovery the header
// describes: a timeout leaves the schema at 0050 with golang-migrate's version
// row at 51 and dirty, and `migrate force 50` puts the row back where the
// schema is, after which the file applies normally.
func TestMigration0051_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	testutil.MigrateTo(t, uri, 50)
	pool := testutil.NewWebPool(t, ctx, uri)

	// Each takes the calling (sub)test's t: a helper closed over the parent's
	// would call FailNow on the parent from inside a subtest.
	columns := func(t *testing.T) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT count(*) FROM information_schema.columns
			WHERE table_name = 'anime_cache' AND column_name = 'bgm_rebind_checked_at'`).Scan(&n))
		return n
	}
	migrationState := func(t *testing.T) (version int, dirty bool) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx, `SELECT version, dirty FROM schema_migrations`).Scan(&version, &dirty))
		return version, dirty
	}
	require.Zero(t, columns(t), "0050 has no stamp column")

	t.Run("fails fast while a reader holds anime_cache", func(t *testing.T) {
		// Well above the file's 3s timeout and well below any CI limit: a run
		// that lands near it is waiting on the lock, not timing out of it.
		const bound = 15 * time.Second

		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `LOCK TABLE anime_cache IN ACCESS SHARE MODE`)
		require.NoError(t, err)

		// Release the reader as soon as the migration returns, or at the
		// bound if it never does, so a regression fails this test instead of
		// hanging the package.
		returned, released := make(chan struct{}), make(chan struct{})
		go func() {
			defer close(released)
			select {
			case <-returned:
			case <-time.After(bound):
			}
			_ = tx.Rollback(context.Background())
		}()

		start := time.Now()
		migrateErr := testutil.TryMigrateTo(t, uri, 51)
		elapsed := time.Since(start)
		close(returned)
		<-released

		require.Error(t, migrateErr, "the ALTER must give up rather than wait out the reader")
		assert.Contains(t, migrateErr.Error(), "lock timeout")
		assert.Less(t, elapsed, bound, "the migration waited for the lock instead of timing out")

		// The state the header tells an operator to expect, and why the
		// recovery is a force rather than a re-run.
		version, dirty := migrationState(t)
		assert.Equal(t, 51, version)
		assert.True(t, dirty, "golang-migrate marks the version it failed on dirty, which blocks the next deploy")

		testutil.ForceMigrationVersion(t, uri, 50)
		version, dirty = migrationState(t)
		assert.Equal(t, 50, version)
		assert.False(t, dirty)
	})

	t.Run("applies once the table is free, and reverses", func(t *testing.T) {
		testutil.MigrateTo(t, uri, 51)
		assert.Equal(t, 1, columns(t))

		testutil.MigrateTo(t, uri, 50)
		assert.Zero(t, columns(t))

		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
		assert.Equal(t, 1, columns(t))
	})
}
