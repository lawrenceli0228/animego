// Package testutil hosts test-only helpers shared across the integration
// suite and any handler test that needs a live Postgres.
//
// Build tag policy:  the file does NOT carry //go:build integration
// because handler-level unit tests want NewWebPool helpers without
// pulling the testcontainers + migrate deps into every test build.
// Callers that DO start containers should put their test files behind
// //go:build integration.
//
// Container reuse pattern:  for an entire test package, declare a
// package-level pgURI string in TestMain and call testutil.SetupPG once.
// Per-test functions then open their own pools via testutil.NewWebPool
// against pgURI, so a leak in one test cannot poison another.
package testutil

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	gomigrate "github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/lawrenceli0228/animego/go-api/internal/db"
)

// allTables enumerates every table the production schema owns so
// TruncateAll can wipe between tests in a single CASCADE statement.
// Includes the six river_* tables (0007/0008) plus the 14 application
// tables (0001).  Updating the schema?  Add new tables here too.
var allTables = []string{
	// Application tables (migrations 0001).
	"users",
	"anime_cache",
	"anime_genres",
	"anime_studios",
	"anime_relations",
	"anime_characters",
	"anime_staff",
	"anime_recommendations",
	"anime_episode_titles",
	"subscriptions",
	"follows",
	"episode_comments",
	"danmakus",
	"episode_windows",
	// Enrichment match-accuracy tables (migration 0011).
	"bgm_id_map",
	"ddp_bgm_title",
	// river queue tables (migrations 0007/0008).
	"river_client",
	"river_client_queue",
	"river_job",
	"river_leader",
	"river_queue",
	// Note: river_migration is NOT truncated — wiping it would force
	// every test to re-run river's internal migrations.
}

// SetupPG starts a single Postgres testcontainer using the custom
// animego-postgres:dev image (postgres:16-alpine + pg_cron, built by
// `docker compose -f docker-compose.dev.yml build postgres`), applies
// the full golang-migrate chain, and returns a connection URI.
//
// The container is terminated automatically via t.Cleanup.  Callers
// using the TestMain pattern should call SetupPGForMain instead — it
// returns an explicit cleanup function because TestMain has no *testing.T.
func SetupPG(t *testing.T) string {
	t.Helper()
	uri, cleanup, err := startPG(context.Background())
	require.NoError(t, err, "SetupPG")
	t.Cleanup(cleanup)
	return uri
}

// SetupPGForMain is the TestMain-friendly variant of SetupPG.  Returns
// an explicit cleanup function so the TestMain func can `defer` it
// before calling m.Run().  Designed for the "spin one container, share
// across every Test* in the package" pattern.
func SetupPGForMain(ctx context.Context) (uri string, cleanup func(), err error) {
	return startPG(ctx)
}

// startPG implements the container + migrate dance shared by the two
// public entry points above.  Always returns a non-nil cleanup (even
// on error) so callers can `defer cleanup()` unconditionally.
func startPG(ctx context.Context) (string, func(), error) {
	cleanup := func() {}

	pgContainer, err := postgres.Run(ctx,
		"animego-postgres:dev",
		postgres.WithDatabase("animego"),
		postgres.WithUsername("animego"),
		postgres.WithPassword("test"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		return "", cleanup, fmt.Errorf("start postgres testcontainer: %w", err)
	}
	cleanup = func() { _ = pgContainer.Terminate(context.Background()) }

	uri, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		return "", cleanup, fmt.Errorf("container ConnectionString: %w", err)
	}

	if err := applySchema(uri); err != nil {
		return "", cleanup, fmt.Errorf("apply schema: %w", err)
	}
	return uri, cleanup, nil
}

// NewWebPool opens a pgxpool against pgURI using the web-tier config
// from internal/db (MaxConns=20, etc.).  Pool is closed automatically
// via t.Cleanup.  The ctx bounds the initial connect + ping.
func NewWebPool(t *testing.T, ctx context.Context, pgURI string) *pgxpool.Pool {
	t.Helper()
	pool, err := db.NewPool(ctx, pgURI)
	require.NoError(t, err, "db.NewPool against pgURI")
	t.Cleanup(pool.Close)
	return pool
}

// TruncateAll wipes every test-managed table in a single CASCADE
// statement so each test starts from an empty schema.  river_migration
// is preserved so the river internal-migration ledger does not need to
// re-apply per test.
func TruncateAll(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	quoted := make([]string, len(allTables))
	for i, tbl := range allTables {
		quoted[i] = `"` + tbl + `"`
	}
	stmt := "TRUNCATE TABLE " + strings.Join(quoted, ", ") + " RESTART IDENTITY CASCADE"
	_, err := pool.Exec(ctx, stmt)
	require.NoError(t, err, "truncate: %s", stmt)
}

// applySchema runs golang-migrate's Go API to push migrations from the
// repo's go-api/migrations directory to pgURI.  Walks up from this file's
// path to find migrations/ so the helper works regardless of test CWD.
func applySchema(pgURI string) error {
	migrationsDir, err := migrationsDirAbs()
	if err != nil {
		return err
	}
	sourceURL := "file://" + migrationsDir

	m, err := gomigrate.New(sourceURL, pgURI)
	if err != nil {
		return fmt.Errorf("migrate.New: %w", err)
	}
	if err := m.Up(); err != nil && err != gomigrate.ErrNoChange {
		return fmt.Errorf("migrate.Up: %w", err)
	}
	if srcErr, dbErr := m.Close(); srcErr != nil || dbErr != nil {
		return fmt.Errorf("migrate close: src=%v db=%v", srcErr, dbErr)
	}
	return nil
}

// migrationsDirAbs resolves go-api/migrations relative to this file's
// runtime location so the helper works no matter where `go test` is
// invoked from.
func migrationsDirAbs() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("runtime.Caller failed")
	}
	// thisFile == .../go-api/internal/testutil/pg.go
	// migrations  ==  .../go-api/migrations/
	dir := filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("abs: %w", err)
	}
	return abs, nil
}
