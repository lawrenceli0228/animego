package safety

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

var pgURI string

func TestMain(m *testing.M) {
	ctx := context.Background()
	uri, cleanup, err := testutil.SetupPGForMain(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "safety tests: setup postgres: %v\n", err)
		os.Exit(1)
	}
	defer cleanup()
	pgURI = uri
	os.Exit(m.Run())
}

func seedSafetyUser(t *testing.T, q string, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO users (username, email, password)
		VALUES ($1, $1 || '@example.test', 'hash')
		RETURNING id`, q).Scan(&id))
	return id
}

func TestBlockUserRemovesRelationshipArtifacts(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	queries := dbgen.New(pool)

	alice := seedSafetyUser(t, "alice", pool)
	bob := seedSafetyUser(t, "bob", pool)
	_, err := pool.Exec(ctx, `INSERT INTO anime_cache (anilist_id, cached_at) VALUES (1, now())`)
	require.NoError(t, err)
	var aliceComment, bobComment uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO episode_comments (anilist_id, episode, user_id, username, content)
		VALUES (1, 1, $1, 'alice', 'a') RETURNING id`, alice).Scan(&aliceComment))
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO episode_comments (anilist_id, episode, user_id, username, content)
		VALUES (1, 1, $1, 'bob', 'b') RETURNING id`, bob).Scan(&bobComment))
	_, err = pool.Exec(ctx, `INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2),($2,$1)`, alice, bob)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO comment_reactions (comment_id,user_id) VALUES ($1,$2),($3,$4)`, bobComment, alice, aliceComment, bob)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO notifications (user_id,actor_id,notification_type,dedupe_key)
		VALUES ($1,$2,'follow','one'),($2,$1,'follow','two')`, alice, bob)
	require.NoError(t, err)

	row, err := queries.BlockUser(ctx, alice, bob)
	require.NoError(t, err)
	assert.True(t, row.Inserted)
	assert.Equal(t, int64(2), row.RemovedFollows)
	assert.Equal(t, int64(2), row.RemovedNotifications)
	assert.Equal(t, int64(2), row.RemovedReactions)
	blocked, err := queries.UserBlockExists(ctx, alice, bob)
	require.NoError(t, err)
	assert.True(t, blocked)

	for table := range map[string]struct{}{"follows": {}, "notifications": {}, "comment_reactions": {}} {
		var count int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		assert.Zero(t, count, table)
	}
}

func TestReportDedupesAndRetainsSnapshotAfterTargetDeletion(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	queries := dbgen.New(pool)
	reporter := seedSafetyUser(t, "reporter", pool)
	author := seedSafetyUser(t, "author", pool)
	_, err := pool.Exec(ctx, `INSERT INTO anime_cache (anilist_id, cached_at) VALUES (2, now())`)
	require.NoError(t, err)
	var commentID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO episode_comments (anilist_id,episode,user_id,username,content,is_spoiler)
		VALUES (2,3,$1,'author','evidence',true) RETURNING id`, author).Scan(&commentID))

	params := dbgen.CreatePendingReportParams{
		ReporterID: reporter, TargetType: "comment", TargetCommentID: &commentID,
		Reason: "spoiler",
	}
	first, err := queries.CreatePendingReport(ctx, params)
	require.NoError(t, err)
	second, err := queries.CreatePendingReport(ctx, params)
	require.NoError(t, err)
	assert.Equal(t, first.ID, second.ID)

	_, err = pool.Exec(ctx, `DELETE FROM episode_comments WHERE id=$1`, commentID)
	require.NoError(t, err)
	var targetID *uuid.UUID
	var snapshot []byte
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT target_comment_id,target_snapshot FROM reports WHERE id=$1`, first.ID,
	).Scan(&targetID, &snapshot))
	assert.Nil(t, targetID)
	assert.JSONEq(t, `{"username":"author","content":"evidence","isSpoiler":true,"anilistId":2,"episode":3}`, string(snapshot))
}
