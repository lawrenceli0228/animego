//go:build integration

// Package integration provides end-to-end tests for AnimeGo's
// Mongo -> Postgres migration tool using real Postgres 16 + Mongo 7
// containers (testcontainers-go).
//
// Build tag: `integration`.  Casual `go test ./...` does NOT trigger
// these tests (and therefore does NOT spin up Docker containers).
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
//
// TestMain spins both containers once, applies the SQL migrations
// via the golang-migrate Go library, and runs every Test* function
// against the same containers.  Each test TRUNCATEs all 14 PG tables
// + drops the Mongo DB so it sees a clean slate.
package integration

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	gomigrate "github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/mongodb"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"

	// Named import (rather than the usual blank import in
	// cmd/migrate-mongo) so tests can call MongoIDToUUID for FK
	// expectation assertions.  The init() registrations still fire.
	migtransforms "github.com/lawrenceli0228/animego/go-api/internal/migrate/transforms"
)

// mongoDBName is the database name used inside the Mongo container.
// All collections live here; ConnectMongo extracts it from the URI path.
const mongoDBName = "animego"

// Globals reused across tests; populated by TestMain.
var (
	pgURIGlobal    string
	mongoURIGlobal string
)

// pgTables enumerates every table the migration touches.  Used for
// TRUNCATE between tests and for empty-state assertions.
var pgTables = []string{
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
}

// TestMain owns the container lifecycle.  Containers are reused across
// every Test* in this package so the ~30s startup cost is paid once.
func TestMain(m *testing.M) {
	ctx := context.Background()

	pgC, pgURI, err := startPostgres(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start postgres: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		if err := pgC.Terminate(context.Background()); err != nil {
			fmt.Fprintf(os.Stderr, "terminate postgres: %v\n", err)
		}
	}()

	mongoC, mongoURI, err := startMongo(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start mongo: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		if err := mongoC.Terminate(context.Background()); err != nil {
			fmt.Fprintf(os.Stderr, "terminate mongo: %v\n", err)
		}
	}()

	if err := applySchema(ctx, pgURI); err != nil {
		fmt.Fprintf(os.Stderr, "apply schema: %v\n", err)
		os.Exit(1)
	}

	pgURIGlobal = pgURI
	mongoURIGlobal = mongoURI

	os.Exit(m.Run())
}

// ---------------------------------------------------------------------------
// Container helpers
// ---------------------------------------------------------------------------

func startPostgres(ctx context.Context) (testcontainers.Container, string, error) {
	pgContainer, err := postgres.Run(ctx,
		"postgres:16-alpine",
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
		return nil, "", fmt.Errorf("postgres.Run: %w", err)
	}
	uri, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		return nil, "", fmt.Errorf("postgres ConnectionString: %w", err)
	}
	return pgContainer, uri, nil
}

func startMongo(ctx context.Context) (testcontainers.Container, string, error) {
	mongoContainer, err := mongodb.Run(ctx,
		"mongo:7",
		testcontainers.WithWaitStrategy(
			wait.ForLog("Waiting for connections").
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		return nil, "", fmt.Errorf("mongodb.Run: %w", err)
	}
	base, err := mongoContainer.ConnectionString(ctx)
	if err != nil {
		return nil, "", fmt.Errorf("mongo ConnectionString: %w", err)
	}
	// testcontainers' mongodb module returns "mongodb://host:port/".
	// ConnectMongo parses the database name from the path component,
	// so append it explicitly.
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return mongoContainer, base + mongoDBName, nil
}

// applySchema runs `migrate up` programmatically via golang-migrate's Go API.
// Source is the local go-api/migrations directory.
func applySchema(ctx context.Context, pgURI string) error {
	_ = ctx // migrate.Up doesn't accept a ctx in v4
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

// migrationsDirAbs resolves go-api/migrations relative to this test file
// so the test still locates the SQL even if the CWD differs at runtime.
func migrationsDirAbs() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("runtime.Caller failed")
	}
	// thisFile == .../go-api/test/integration/migrate_test.go
	// migrations live at  .../go-api/migrations/
	dir := filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("abs: %w", err)
	}
	return abs, nil
}

// ---------------------------------------------------------------------------
// Per-test plumbing
// ---------------------------------------------------------------------------

// newPGPool opens a pgxpool against the package-global PG URI.  Each test
// gets its own pool so a leak in one test doesn't poison another.
func newPGPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	pool, err := migrate.ConnectPG(ctx, pgURIGlobal)
	require.NoError(t, err, "ConnectPG")
	t.Cleanup(pool.Close)
	return pool
}

// newMongoClient opens a Mongo client against the package-global URI.
func newMongoClient(t *testing.T, ctx context.Context) *mongo.Client {
	t.Helper()
	cli, err := mongo.Connect(options.Client().ApplyURI(mongoURIGlobal))
	require.NoError(t, err, "mongo.Connect")
	t.Cleanup(func() {
		_ = cli.Disconnect(context.Background())
	})
	return cli
}

// truncateAllPG wipes every migration-target table in one CASCADE statement
// so each test starts from an empty PG state.
func truncateAllPG(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	quoted := make([]string, len(pgTables))
	for i, tbl := range pgTables {
		quoted[i] = `"` + tbl + `"`
	}
	stmt := "TRUNCATE TABLE " + strings.Join(quoted, ", ") + " RESTART IDENTITY CASCADE"
	_, err := pool.Exec(ctx, stmt)
	require.NoError(t, err, "truncate: %s", stmt)
}

// dropMongoDB removes every collection so each test gets a fresh Mongo state.
func dropMongoDB(t *testing.T, ctx context.Context, cli *mongo.Client) {
	t.Helper()
	require.NoError(t, cli.Database(mongoDBName).Drop(ctx), "drop mongo db")
}

// resetState clears both stores; call at the top of every Test*.
func resetState(t *testing.T, ctx context.Context, pool *pgxpool.Pool, cli *mongo.Client) {
	t.Helper()
	truncateAllPG(t, ctx, pool)
	dropMongoDB(t, ctx, cli)
}

// runMigration constructs the same Config + Orchestrator that
// cmd/migrate-mongo/main.go uses and invokes Run.  Returns the run's
// per-collection reports for assertion + the failure-log path used.
func runMigration(t *testing.T, ctx context.Context, dryRun bool) (string, error) {
	t.Helper()

	mc, err := migrate.ConnectMongo(ctx, mongoURIGlobal)
	require.NoError(t, err, "ConnectMongo")
	defer func() { _ = mc.Disconnect(context.Background()) }()

	pg, err := migrate.ConnectPG(ctx, pgURIGlobal)
	require.NoError(t, err, "ConnectPG")
	defer pg.Close()

	failLogPath := filepath.Join(t.TempDir(), "failures.jsonl")

	cfg := migrate.Config{
		MongoDatabase: mongoDBName,
		DryRun:        dryRun,
		Commit:        !dryRun,
		Collections:   []string{"all"},
		BatchSize:     100,
		LogFailedPath: failLogPath,
		Concurrency:   1,
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	orch, err := migrate.NewOrchestrator(cfg, logger, mc, pg)
	require.NoError(t, err, "NewOrchestrator")
	defer func() { _ = orch.Close() }()

	return failLogPath, orch.Run(ctx)
}

// scalarInt fetches a single integer (typically COUNT(*)) for the query.
func scalarInt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, q string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(ctx, q, args...).Scan(&n), "scalar: %s", q)
	return n
}

// countTable returns SELECT COUNT(*) for one table.
func countTable(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table string) int {
	t.Helper()
	return scalarInt(t, ctx, pool, `SELECT COUNT(*) FROM "`+table+`"`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestMigrateEmptyMongo(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	cli := newMongoClient(t, ctx)
	resetState(t, ctx, pool, cli)

	_, err := runMigration(t, ctx, false /*dryRun*/)
	require.NoError(t, err, "orchestrator run")

	for _, tbl := range pgTables {
		assert.Equal(t, 0, countTable(t, ctx, pool, tbl), "table %s should be empty", tbl)
	}
}

func TestMigrateOneUser(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	cli := newMongoClient(t, ctx)
	resetState(t, ctx, pool, cli)

	userOID := bson.NewObjectID()
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err := cli.Database(mongoDBName).Collection("users").InsertOne(ctx, bson.M{
		"_id":       userOID,
		"username":  "alice",
		"email":     "alice@example.com",
		"password":  "$2b$12$abcdefghijklmnopqrstuv",
		"createdAt": bson.NewDateTimeFromTime(now),
		"updatedAt": bson.NewDateTimeFromTime(now),
	})
	require.NoError(t, err, "mongo insert user")

	_, err = runMigration(t, ctx, false)
	require.NoError(t, err, "orchestrator run")

	assert.Equal(t, 1, countTable(t, ctx, pool, "users"))

	expectedID, err := migtransforms.MongoIDToUUID(userOID)
	require.NoError(t, err)

	var (
		gotID                          uuid.UUID
		gotUsername, gotEmail, gotPass string
		gotIsPublic                    bool
	)
	err = pool.QueryRow(ctx,
		`SELECT id, username, email, password, is_public FROM users WHERE username=$1`,
		"alice",
	).Scan(&gotID, &gotUsername, &gotEmail, &gotPass, &gotIsPublic)
	require.NoError(t, err)

	assert.Equal(t, expectedID, gotID, "uuid should match MongoIDToUUID(_id)")
	assert.Equal(t, "alice", gotUsername)
	assert.Equal(t, "alice@example.com", gotEmail)
	assert.Equal(t, "$2b$12$abcdefghijklmnopqrstuv", gotPass)
	assert.True(t, gotIsPublic, "is_public should default to true")
}

func TestMigrateAnimeCacheFanOut(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	cli := newMongoClient(t, ctx)
	resetState(t, ctx, pool, cli)

	const anilistID = 12345
	_, err := cli.Database(mongoDBName).Collection("animecaches").InsertOne(ctx, bson.M{
		"anilistId":    anilistID,
		"titleRomaji":  "Test Anime",
		"titleEnglish": "Test Anime EN",
		"genres":       bson.A{"Action", "Comedy"},
		"studios":      bson.A{"MAPPA", "Pierrot"},
		"relations": bson.A{
			bson.M{"anilistId": 1, "relationType": "PREQUEL", "title": "Test Anime Prequel"},
			bson.M{"anilistId": 2, "relationType": "SEQUEL", "title": "Test Anime Sequel"},
		},
		"characters": bson.A{
			bson.M{"nameEn": "Char A", "role": "MAIN"},
			bson.M{"nameEn": "Char B", "role": "SUPPORTING"},
			bson.M{"nameEn": "Char C", "role": "BACKGROUND"},
		},
		"staff": bson.A{
			bson.M{"nameEn": "Director X", "role": "Director"},
			bson.M{"nameEn": "Composer Y", "role": "Music"},
		},
		"recommendations": bson.A{
			bson.M{"anilistId": 100, "title": "Rec 1"},
			bson.M{"anilistId": 200, "title": "Rec 2"},
		},
		"episodeTitles": bson.A{
			bson.M{"episode": 1, "nameCn": "第一话"},
			bson.M{"episode": 2, "nameCn": "第二话"},
		},
		"startDate": bson.M{"year": 2024, "month": 1, "day": 15},
	})
	require.NoError(t, err, "mongo insert anime_cache")

	_, err = runMigration(t, ctx, false)
	require.NoError(t, err, "orchestrator run")

	// Spot-check the parent row.
	var (
		gotAnilist int
		gotStart   time.Time
		gotVecLen  int
	)
	err = pool.QueryRow(ctx, `
		SELECT anilist_id, start_date, length(search_vec::text)
		FROM anime_cache WHERE anilist_id=$1`, anilistID,
	).Scan(&gotAnilist, &gotStart, &gotVecLen)
	require.NoError(t, err)
	assert.Equal(t, anilistID, gotAnilist)
	assert.Equal(t, 2024, gotStart.Year())
	assert.Equal(t, time.January, gotStart.Month())
	assert.Equal(t, 15, gotStart.Day())
	assert.Greater(t, gotVecLen, 0, "search_vec should be populated by the GENERATED column")

	// Fan-out counts.
	assert.Equal(t, 1, countTable(t, ctx, pool, "anime_cache"))
	assert.Equal(t, 2, countTable(t, ctx, pool, "anime_genres"))
	assert.Equal(t, 2, countTable(t, ctx, pool, "anime_studios"))
	assert.Equal(t, 2, countTable(t, ctx, pool, "anime_relations"))
	assert.Equal(t, 3, countTable(t, ctx, pool, "anime_characters"))
	assert.Equal(t, 2, countTable(t, ctx, pool, "anime_staff"))
	assert.Equal(t, 2, countTable(t, ctx, pool, "anime_recommendations"))
	assert.Equal(t, 2, countTable(t, ctx, pool, "anime_episode_titles"))

	// display_order should be 0,1,2 for the three characters.
	rows, err := pool.Query(ctx,
		`SELECT display_order FROM anime_characters WHERE anime_id=$1 ORDER BY display_order`,
		anilistID)
	require.NoError(t, err)
	defer rows.Close()
	var orders []int
	for rows.Next() {
		var n int
		require.NoError(t, rows.Scan(&n))
		orders = append(orders, n)
	}
	require.NoError(t, rows.Err())
	assert.Equal(t, []int{0, 1, 2}, orders)
}

func TestMigrateFKRelationships(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	cli := newMongoClient(t, ctx)
	resetState(t, ctx, pool, cli)

	db := cli.Database(mongoDBName)

	userOID := bson.NewObjectID()
	const anilistID = 77777
	now := time.Now().UTC().Truncate(time.Millisecond)
	bnow := bson.NewDateTimeFromTime(now)

	// 1 user
	_, err := db.Collection("users").InsertOne(ctx, bson.M{
		"_id":       userOID,
		"username":  "bob",
		"email":     "bob@example.com",
		"password":  "$2b$12$xxxxxxxxxxxxxxxxxxxxxx",
		"createdAt": bnow,
		"updatedAt": bnow,
	})
	require.NoError(t, err)

	// 1 anime_cache
	_, err = db.Collection("animecaches").InsertOne(ctx, bson.M{
		"anilistId":   anilistID,
		"titleRomaji": "Sample",
	})
	require.NoError(t, err)

	// 1 subscription
	_, err = db.Collection("subscriptions").InsertOne(ctx, bson.M{
		"userId":         userOID,
		"anilistId":      anilistID,
		"status":         "watching",
		"currentEpisode": 3,
		"createdAt":      bnow,
		"updatedAt":      bnow,
	})
	require.NoError(t, err)

	// 1 follow (self-follow OK)
	_, err = db.Collection("follows").InsertOne(ctx, bson.M{
		"followerId": userOID,
		"followeeId": userOID,
		"createdAt":  bnow,
		"updatedAt":  bnow,
	})
	require.NoError(t, err)

	// 2 episode_comments, child references parent (deferred self-FK)
	parentOID := bson.NewObjectID()
	childOID := bson.NewObjectID()
	_, err = db.Collection("episodecomments").InsertMany(ctx, []any{
		bson.M{
			"_id":       parentOID,
			"userId":    userOID,
			"anilistId": anilistID,
			"episode":   1,
			"username":  "bob",
			"content":   "first comment",
			"createdAt": bnow,
			"updatedAt": bnow,
		},
		bson.M{
			"_id":       childOID,
			"userId":    userOID,
			"anilistId": anilistID,
			"episode":   1,
			"username":  "bob",
			"content":   "reply to first",
			"parentId":  parentOID,
			"createdAt": bnow,
			"updatedAt": bnow,
		},
	})
	require.NoError(t, err)

	// 1 danmaku
	_, err = db.Collection("danmakus").InsertOne(ctx, bson.M{
		"userId":     userOID,
		"anilistId":  anilistID,
		"episode":    1,
		"username":   "bob",
		"content":    "go!",
		"liveEndsAt": bson.NewDateTimeFromTime(now.Add(24 * time.Hour)),
		"createdAt":  bnow,
		"updatedAt":  bnow,
	})
	require.NoError(t, err)

	// 1 episode_window
	_, err = db.Collection("episodewindows").InsertOne(ctx, bson.M{
		"anilistId":  anilistID,
		"episode":    1,
		"liveEndsAt": bson.NewDateTimeFromTime(now.Add(48 * time.Hour)),
	})
	require.NoError(t, err)

	_, err = runMigration(t, ctx, false)
	require.NoError(t, err, "orchestrator run")

	expectedUserID, err := migtransforms.MongoIDToUUID(userOID)
	require.NoError(t, err)
	expectedParentID, err := migtransforms.MongoIDToUUID(parentOID)
	require.NoError(t, err)
	expectedChildID, err := migtransforms.MongoIDToUUID(childOID)
	require.NoError(t, err)

	// Subscription FKs resolve.
	assert.Equal(t, 1, countTable(t, ctx, pool, "subscriptions"))
	var subUser uuid.UUID
	var subAnilist int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT user_id, anilist_id FROM subscriptions LIMIT 1`,
	).Scan(&subUser, &subAnilist))
	assert.Equal(t, expectedUserID, subUser)
	assert.Equal(t, anilistID, subAnilist)

	// Follow FKs resolve (both endpoints).
	assert.Equal(t, 1, countTable(t, ctx, pool, "follows"))
	var fFollower, fFollowee uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT follower_id, followee_id FROM follows LIMIT 1`,
	).Scan(&fFollower, &fFollowee))
	assert.Equal(t, expectedUserID, fFollower)
	assert.Equal(t, expectedUserID, fFollowee)

	// Comments: 2 rows, child.parent_id == parent.id.
	assert.Equal(t, 2, countTable(t, ctx, pool, "episode_comments"))
	var childParent *uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT parent_id FROM episode_comments WHERE id=$1`, expectedChildID,
	).Scan(&childParent))
	require.NotNil(t, childParent, "child comment must reference a parent")
	assert.Equal(t, expectedParentID, *childParent)

	// Danmaku + episode_window present.
	assert.Equal(t, 1, countTable(t, ctx, pool, "danmakus"))
	assert.Equal(t, 1, countTable(t, ctx, pool, "episode_windows"))

	// Deleting the user CASCADEs.
	_, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, expectedUserID)
	require.NoError(t, err)
	assert.Equal(t, 0, countTable(t, ctx, pool, "users"))
	assert.Equal(t, 0, countTable(t, ctx, pool, "subscriptions"))
	assert.Equal(t, 0, countTable(t, ctx, pool, "follows"))
	assert.Equal(t, 0, countTable(t, ctx, pool, "episode_comments"))
	assert.Equal(t, 0, countTable(t, ctx, pool, "danmakus"))
}

func TestMigrateDryRun(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	cli := newMongoClient(t, ctx)
	resetState(t, ctx, pool, cli)

	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err := cli.Database(mongoDBName).Collection("users").InsertOne(ctx, bson.M{
		"_id":       bson.NewObjectID(),
		"username":  "dryrun_user",
		"email":     "dryrun@example.com",
		"password":  "$2b$12$xxxxxxxxxxxxxxxxxxxxxx",
		"createdAt": bson.NewDateTimeFromTime(now),
		"updatedAt": bson.NewDateTimeFromTime(now),
	})
	require.NoError(t, err)

	_, err = runMigration(t, ctx, true /*dryRun*/)
	require.NoError(t, err, "orchestrator run (dry-run)")

	// PG state unchanged.
	assert.Equal(t, 0, countTable(t, ctx, pool, "users"),
		"dry-run must NOT write to Postgres")
}

func TestMigrateFailureLogging(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	cli := newMongoClient(t, ctx)
	resetState(t, ctx, pool, cli)

	// Malformed user: no _id at all.  The users transform calls
	// MongoIDToUUID(doc["_id"]) -> err "nil ObjectId", which routes to
	// the failure log.  But Mongo *requires* every document to have an
	// _id; if we omit it, the driver auto-generates one.  To produce a
	// shape MongoIDToUUID rejects, use an unsupported type for _id
	// (an int — neither bson.ObjectID nor string).
	_, err := cli.Database(mongoDBName).Collection("users").InsertOne(ctx, bson.M{
		"_id":      42, // unsupported type triggers "unsupported _id type"
		"username": "broken",
		"email":    "broken@example.com",
		"password": "$2b$12$xxxxxxxxxxxxxxxxxxxxxx",
	})
	require.NoError(t, err)

	failLog, runErr := runMigration(t, ctx, false)
	require.NoError(t, runErr, "orchestrator should not panic on bad row")

	// Bad row must not have been inserted.
	assert.Equal(t, 0, countTable(t, ctx, pool, "users"),
		"malformed user row should not land in Postgres")

	// Failure log should contain one JSONL line referencing the users
	// collection.  Read the whole file (small).
	data, err := os.ReadFile(failLog)
	require.NoError(t, err, "read failure log")
	content := string(data)
	assert.NotEmpty(t, content, "failure log should have at least one entry")
	assert.Contains(t, content, `"collection":"users"`)
	assert.Contains(t, content, `"error"`)
}
