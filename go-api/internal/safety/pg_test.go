package safety

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

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

// TestPG_CreateReport_SurvivesAConcurrentReportOfTheSameTarget covers the
// second half of the ON CONFLICT DO NOTHING race that
// InsertSubscriptionIfAbsent hit in production on 2026-09-05.
//
// CreatePendingReport is built the same way — insert, and on conflict read the
// existing pending report back through a UNION ALL arm — and a single
// statement cannot do that safely.  A conflicting insert waits on the other
// transaction's speculative token, but the snapshot was taken before the wait,
// so once that transaction commits neither arm can see its row.  Zero rows
// reach the handler as pgx.ErrNoRows, which is also how a genuinely missing
// target arrives, so the reporter is told their target does not exist while
// their own report of it sits in the moderation queue.
//
// Unlike the subscriptions case this cannot be fixed by making the conflict
// arm DO UPDATE — `reports` has one partial unique index per target kind and
// DO UPDATE can only infer one — so the handler retries once, and this test is
// what says the retry is doing its job.
func TestPG_CreateReport_SurvivesAConcurrentReportOfTheSameTarget(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	queries := dbgen.New(pool)
	h := NewHandlers(queries)

	reporter := seedSafetyUser(t, "reporter", pool)
	author := seedSafetyUser(t, "author", pool)
	_, err := pool.Exec(ctx, `INSERT INTO anime_cache (anilist_id, cached_at) VALUES (2, now())`)
	require.NoError(t, err)
	var commentID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO episode_comments (anilist_id,episode,user_id,username,content,is_spoiler)
		VALUES (2,3,$1,'author','evidence',true) RETURNING id`, author).Scan(&commentID))

	// The reporter's other in-flight report, frozen just before commit.
	holder, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = holder.Rollback(ctx) }()
	var heldID uuid.UUID
	require.NoError(t, holder.QueryRow(ctx, `
		INSERT INTO reports (reporter_id, target_type, target_comment_id, reason)
		VALUES ($1, 'comment', $2, 'spam') RETURNING id`, reporter, commentID).Scan(&heldID))

	body := fmt.Sprintf(`{"targetType":"comment","targetId":%q,"reason":"spoiler"}`, commentID)
	req := withClaims(t,
		httptest.NewRequest(http.MethodPost, "/api/reports", strings.NewReader(body)),
		reporter, nil)

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		h.CreateReport(rec, req)
		done <- rec
	}()

	requireBlockedOnPendingReportInsert(t, pool)
	require.NoError(t, holder.Commit(ctx))

	select {
	case rec := <-done:
		require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())
		var got struct {
			Data struct {
				ID     uuid.UUID `json:"id"`
				Status string    `json:"status"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		assert.Equal(t, heldID, got.Data.ID,
			"the report the other request committed is the one that must come back")
	case <-time.After(20 * time.Second):
		t.Fatal("handler never returned")
	}

	var n int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM reports WHERE reporter_id=$1 AND target_comment_id=$2`,
		reporter, commentID).Scan(&n))
	assert.Equal(t, 1, n, "the loser of the race must not have opened a second report")
}

// requireBlockedOnPendingReportInsert blocks until a backend other than this
// one is parked on a lock inside CreatePendingReport.  sqlc keeps the
// `-- name:` header in the text it sends, so the query is identifiable by name.
func requireBlockedOnPendingReportInsert(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		require.NoError(t, pool.QueryRow(context.Background(), `
			SELECT count(*)
			FROM pg_stat_activity
			WHERE pid <> pg_backend_pid()
			  AND wait_event_type = 'Lock'
			  AND query LIKE '%CreatePendingReport%'`).Scan(&n))
		if n > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the second report never reached the conflict — the race this test needs did not happen")
}
