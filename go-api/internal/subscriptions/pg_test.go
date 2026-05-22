package subscriptions

// pg_test.go — PG-backed end-to-end tests for the subscriptions
// handlers.  Uses the shared testcontainers Postgres set up by TestMain
// in handlers_test.go.
//
// These tests exercise the actual SQL behaviour:
//   - ORDER BY updated_at DESC in the list endpoint
//   - status filter pass-through to SQL (and the empty-match fallback)
//   - per-user isolation via the (user_id, anilist_id) PK
//   - UPSERT idempotence on ON CONFLICT
//   - the CASE expression in UpdateSubscription (last_watched_at only
//     bumps when current_episode is set)
//   - DELETE actually removes the row
//
// Per-test isolation comes from testutil.TruncateAll on pgHandlers.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// pgHandlers builds Handlers backed by a fresh testcontainer pool.  The
// pool is closed in t.Cleanup so concurrent tests don't accumulate
// leaked pools.
func pgHandlers(t *testing.T) (*Handlers, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)
	animeDB := &fakeEnsureCachedDB{
		getFn: func(ctx context.Context, anilistID int32) (dbgen.GetAnimeMainByIDRow, error) {
			return q.GetAnimeMainByID(ctx, anilistID)
		},
		upsertFn: func(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error {
			return q.UpsertAnimeCache(ctx, arg)
		},
	}
	ac := &fakeAnilist{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return &anilist.AnimeDetailResponse{}, nil
		},
	}
	h := NewHandlers(pool, q, animeDB, ac, nil)
	return h, pool
}

// seedUser inserts one users row via raw SQL.
func seedUser(t *testing.T, pool *pgxpool.Pool, username, email string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO users (username, email, password)
		VALUES ($1, $2, 'bcrypt-placeholder')
		RETURNING id`,
		username, email,
	).Scan(&id)
	require.NoError(t, err, "seedUser")
	return id
}

// seedAnime inserts one anime_cache row.
func seedAnime(t *testing.T, pool *pgxpool.Pool, anilistID int32, romaji, chinese string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese, cached_at)
		VALUES ($1, $2, $3, now())`,
		anilistID, romaji, chinese,
	)
	require.NoError(t, err, "seedAnime")
}

// seedSubscription inserts one subscriptions row.
func seedSubscription(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32, status string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO subscriptions (user_id, anilist_id, status)
		VALUES ($1, $2, $3)`,
		userID, anilistID, status,
	)
	require.NoError(t, err, "seedSubscription")
}

func TestPG_List_OrdersByUpdatedAtDesc(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "First", "第一")
	seedAnime(t, pool, 2, "Second", "第二")
	seedAnime(t, pool, 3, "Third", "第三")

	seedSubscription(t, pool, user, 1, "watching")
	seedSubscription(t, pool, user, 2, "watching")
	seedSubscription(t, pool, user, 3, "watching")
	_, err := pool.Exec(context.Background(),
		`UPDATE subscriptions SET updated_at = now() WHERE anilist_id = 2 AND user_id = $1`, user)
	require.NoError(t, err)

	ctx := withUserClaims(t, context.Background(), user, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var got struct {
		Data []listItem `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got.Data, 3)
	assert.Equal(t, int32(2), got.Data[0].AnilistID, "most-recently-updated sorts first")
}

func TestPG_List_FilterByStatus(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")
	seedSubscription(t, pool, user, 1, "watching")
	seedSubscription(t, pool, user, 2, "completed")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions?status=completed", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var got struct {
		Data []listItem `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got.Data, 1)
	assert.Equal(t, int32(2), got.Data[0].AnilistID)
}

func TestPG_List_UnknownStatusReturnsEmpty(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions?status=mystery", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"data":[]`)
}

func TestPG_List_OnlyOwnSubscriptions(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")
	seedSubscription(t, pool, alice, 1, "watching")
	seedSubscription(t, pool, bob, 2, "watching")

	ctx := withUserClaims(t, context.Background(), alice, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var got struct {
		Data []listItem `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got.Data, 1, "should only return alice's rows")
	assert.Equal(t, int32(1), got.Data[0].AnilistID)
}

func TestPG_Create_UpsertIsIdempotent(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")

	ctx := withUserClaims(t, context.Background(), user, "alice")

	doPost := func(status string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"anilistId":1,"status":%q}`, status)
		req := newReq(t, http.MethodPost, "/api/subscriptions", body, "", ctx)
		rec := httptest.NewRecorder()
		h.CreateSubscription(rec, req)
		return rec
	}

	rec := doPost("watching")
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec2 := doPost("completed")
	require.Equal(t, http.StatusCreated, rec2.Code, rec2.Body.String())

	var status string
	err := pool.QueryRow(context.Background(),
		`SELECT status FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&status)
	require.NoError(t, err)
	assert.Equal(t, "completed", status, "ON CONFLICT must update status")
}

func TestPG_Update_ChangesEpisodeAndBumpsLastWatched(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	var pre interface{}
	err := pool.QueryRow(context.Background(),
		`SELECT last_watched_at FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&pre)
	require.NoError(t, err)
	assert.Nil(t, pre, "fresh row should have NULL last_watched_at")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/1", `{"currentEpisode":5}`, "1", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var post interface{}
	err = pool.QueryRow(context.Background(),
		`SELECT last_watched_at FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&post)
	require.NoError(t, err)
	assert.NotNil(t, post, "current_episode update must populate last_watched_at")
}

func TestPG_Update_StatusOnlyDoesNotTouchLastWatched(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/1", `{"status":"completed"}`, "1", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var lwt interface{}
	err := pool.QueryRow(context.Background(),
		`SELECT last_watched_at FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&lwt)
	require.NoError(t, err)
	assert.Nil(t, lwt, "status-only update must NOT bump last_watched_at")
}

func TestPG_Delete_RemovesRow(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	req := newReq(t, http.MethodDelete, "/api/subscriptions/1", "", "1", ctx)
	rec := httptest.NewRecorder()
	h.DeleteSubscription(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var n int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&n))
	assert.Equal(t, 0, n, "row should be deleted")
}
