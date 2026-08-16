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
//   - the CASE expression in UpdateSubscriptionWithActivity
//     (last_watched_at only bumps when current_episode is set)
//   - the monotonic guard: GREATEST refusing a backwards push, and the
//     matching last_watched_at / activity_events suppression
//   - the currentEpisode upper bound against anime_cache.episodes,
//     including the NULL "still airing" pass-through
//   - InsertSubscriptionIfAbsent's ON CONFLICT DO NOTHING + UNION ALL
//     read-back leaving a hand-set status alone
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
	"time"

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

// seedWatchedSubscription inserts a subscription already sitting at
// `episode` with a last_watched_at an hour in the past, so a test can tell
// "the timestamp was left alone" from "the timestamp was rewritten to a
// value that happens to look similar".
func seedWatchedSubscription(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32, status string, episode int32) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO subscriptions (user_id, anilist_id, status, current_episode, last_watched_at)
		VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
		userID, anilistID, status, episode,
	)
	require.NoError(t, err, "seedWatchedSubscription")
}

// setAnimeEpisodes stamps the authoritative total-episode count on a cached
// title.  seedAnime leaves it NULL, which is the "still airing" case.
func setAnimeEpisodes(t *testing.T, pool *pgxpool.Pool, anilistID, episodes int32) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`UPDATE anime_cache SET episodes = $2 WHERE anilist_id = $1`, anilistID, episodes)
	require.NoError(t, err, "setAnimeEpisodes")
}

// readProgress returns (current_episode, last_watched_at) for one row.
func readProgress(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32) (int32, *time.Time) {
	t.Helper()
	var ep int32
	var lwt *time.Time
	err := pool.QueryRow(context.Background(),
		`SELECT current_episode, last_watched_at FROM subscriptions WHERE user_id = $1 AND anilist_id = $2`,
		userID, anilistID,
	).Scan(&ep, &lwt)
	require.NoError(t, err, "readProgress")
	return ep, lwt
}

// countWatchEvents counts watch_progress rows in the activity feed for one
// user — the feed must not gain an entry for a write that changed nothing.
func countWatchEvents(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM activity_events WHERE user_id = $1 AND event_type = 'watch_progress'`,
		userID,
	).Scan(&n), "countWatchEvents")
	return n
}

// ageUpdatedAt pushes one row's updated_at into the past so list ordering
// tests are deterministic rather than racing two same-millisecond inserts.
func ageUpdatedAt(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`UPDATE subscriptions SET updated_at = now() - interval '1 hour'
		 WHERE user_id = $1 AND anilist_id = $2`,
		userID, anilistID,
	)
	require.NoError(t, err, "ageUpdatedAt")
}

// listAnilistOrder returns the anilist ids in the exact order
// GET /api/subscriptions emits them — i.e. what ContinueWatching renders.
func listAnilistOrder(t *testing.T, h *Handlers, userID uuid.UUID) []int32 {
	t.Helper()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var got struct {
		Data []listItem `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	order := make([]int32, 0, len(got.Data))
	for _, item := range got.Data {
		order = append(order, item.AnilistID)
	}
	return order
}

// patchSubscription runs one PATCH against the handler and returns the recorder.
func patchSubscription(t *testing.T, h *Handlers, userID uuid.UUID, anilistID int32, body string) *httptest.ResponseRecorder {
	t.Helper()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	target := fmt.Sprintf("/api/subscriptions/%d", anilistID)
	req := newReq(t, http.MethodPatch, target, body, fmt.Sprint(anilistID), ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	return rec
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

// -----------------------------------------------------------------------------
// monotonic guard — real SQL, because GREATEST + the last_watched_at CASE
// are the whole feature and a fake cannot fail them (§4 decisions 4 + 8)
// -----------------------------------------------------------------------------

func TestPG_Update_MonotonicRejectsBackwardsPush(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedWatchedSubscription(t, pool, user, 1, "watching", 5)

	_, beforeLWT := readProgress(t, pool, user, 1)
	require.NotNil(t, beforeLWT)
	beforeEvents := countWatchEvents(t, pool, user)

	// A stale tab replaying an old high-water mark.
	rec := patchSubscription(t, h, user, 1, `{"currentEpisode":3,"monotonic":true}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	ep, afterLWT := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(5), ep, "GREATEST must refuse to move progress backwards")
	require.NotNil(t, afterLWT)
	assert.True(t, beforeLWT.Equal(*afterLWT),
		"a no-op push must not bump last_watched_at — it would reshuffle 'continue watching' for nothing")
	assert.Equal(t, beforeEvents, countWatchEvents(t, pool, user),
		"a no-op push must not manufacture an activity event")
}

func TestPG_Update_MonotonicAdvancesAndBumps(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedWatchedSubscription(t, pool, user, 1, "watching", 5)

	_, beforeLWT := readProgress(t, pool, user, 1)
	require.NotNil(t, beforeLWT)
	beforeEvents := countWatchEvents(t, pool, user)

	rec := patchSubscription(t, h, user, 1, `{"currentEpisode":7,"monotonic":true}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	ep, afterLWT := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(7), ep, "a genuine advance must land")
	require.NotNil(t, afterLWT)
	assert.True(t, afterLWT.After(*beforeLWT), "a real advance must bump last_watched_at")
	assert.Equal(t, beforeEvents+1, countWatchEvents(t, pool, user),
		"a real advance must feed the activity stream")
}

// The two tests below are the ones that actually pin the user-visible
// symptom.  MonotonicRejectsBackwardsPush proves current_episode holds;
// these prove the row does not jump to the top of the home page while
// holding it.  That ordering comes from ListUserSubscriptions'
// ORDER BY s.updated_at DESC, which is why updated_at needs its own
// suppression — last_watched_at is not what sorts this list.

func TestPG_Update_MonotonicNoOpDoesNotReorderList(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")
	seedWatchedSubscription(t, pool, user, 1, "watching", 12)
	seedWatchedSubscription(t, pool, user, 2, "watching", 3)
	ageUpdatedAt(t, pool, user, 1) // B is the more recent, so B sorts first

	require.Equal(t, []int32{2, 1}, listAnilistOrder(t, h, user), "precondition")

	var beforeUpdatedAt time.Time
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT updated_at FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user,
	).Scan(&beforeUpdatedAt))

	// A stale tab replaying an old high-water mark against A.
	rec := patchSubscription(t, h, user, 1, `{"currentEpisode":5,"monotonic":true}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var afterUpdatedAt time.Time
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT updated_at FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user,
	).Scan(&afterUpdatedAt))
	assert.True(t, beforeUpdatedAt.Equal(afterUpdatedAt),
		"a no-op push must leave updated_at alone")

	assert.Equal(t, []int32{2, 1}, listAnilistOrder(t, h, user),
		"a no-op push must not jump an untouched show to the front of the list")
}

func TestPG_Update_MonotonicAdvanceReordersList(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	// The mirror image: make sure the suppression above did not overshoot
	// and freeze the ordering for genuine progress too.
	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")
	seedWatchedSubscription(t, pool, user, 1, "watching", 12)
	seedWatchedSubscription(t, pool, user, 2, "watching", 3)
	ageUpdatedAt(t, pool, user, 1)

	require.Equal(t, []int32{2, 1}, listAnilistOrder(t, h, user), "precondition")

	rec := patchSubscription(t, h, user, 1, `{"currentEpisode":13,"monotonic":true}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	assert.Equal(t, []int32{1, 2}, listAnilistOrder(t, h, user),
		"real progress must still float the show to the front — that is the feature")
}

func TestPG_Update_MonotonicNoOpWithStatusStillBumps(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	// A monotonic PATCH carrying a status change is a real edit even when
	// the episode folds into a no-op.  The reconciler never sends this
	// shape, but the endpoint accepts it, so the guard must not swallow it.
	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")
	seedWatchedSubscription(t, pool, user, 1, "watching", 12)
	seedWatchedSubscription(t, pool, user, 2, "watching", 3)
	ageUpdatedAt(t, pool, user, 1)

	require.Equal(t, []int32{2, 1}, listAnilistOrder(t, h, user), "precondition")

	rec := patchSubscription(t, h, user, 1,
		`{"currentEpisode":5,"monotonic":true,"status":"completed"}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	ep, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(12), ep, "the episode still must not move backwards")

	var status string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT status FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&status))
	assert.Equal(t, "completed", status, "the status edit must land")

	assert.Equal(t, []int32{1, 2}, listAnilistOrder(t, h, user),
		"a real status edit must bump updated_at even though the episode did not move")
}

func TestPG_Update_NonMonotonicCanCorrectDownwards(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedWatchedSubscription(t, pool, user, 1, "watching", 5)

	_, beforeLWT := readProgress(t, pool, user, 1)
	require.NotNil(t, beforeLWT)

	// The detail page's − button: no monotonic key at all, exactly what
	// ships today.
	rec := patchSubscription(t, h, user, 1, `{"currentEpisode":3}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	ep, afterLWT := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(3), ep, "a human correcting the count downwards MUST still work")
	require.NotNil(t, afterLWT)
	assert.True(t, afterLWT.After(*beforeLWT),
		"non-monotonic keeps the old rule: any explicit currentEpisode bumps last_watched_at")
}

// -----------------------------------------------------------------------------
// episode upper bound — the ceiling lives in anime_cache, so this needs
// a real row (§4 decision 4)
// -----------------------------------------------------------------------------

func TestPG_Update_EpisodeAboveTotal_400(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	setAnimeEpisodes(t, pool, 1, 12)
	seedWatchedSubscription(t, pool, user, 1, "watching", 5)

	rec := patchSubscription(t, h, user, 1, `{"currentEpisode":13,"monotonic":true}`)
	require.Equal(t, http.StatusBadRequest, rec.Code, "body=%s", rec.Body.String())
	assert.Contains(t, rec.Body.String(), "Episode exceeds the total episode count")

	ep, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(5), ep, "a rejected episode must leave the row untouched — no clamp to 12")
	assert.Equal(t, 0, countWatchEvents(t, pool, user))
}

func TestPG_Update_EpisodeEqualsTotal_200(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	setAnimeEpisodes(t, pool, 1, 12)
	seedWatchedSubscription(t, pool, user, 1, "watching", 11)

	rec := patchSubscription(t, h, user, 1, `{"currentEpisode":12,"monotonic":true}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	ep, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(12), ep, "finishing the final episode is the common case, not an error")
}

func TestPG_Update_EpisodesNullMeansNoBound(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲") // leaves anime_cache.episodes NULL
	seedWatchedSubscription(t, pool, user, 1, "watching", 5)

	rec := patchSubscription(t, h, user, 1, `{"currentEpisode":999,"monotonic":true}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	ep, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(999), ep, "an airing show has no known length — nothing to bound against")
}

// -----------------------------------------------------------------------------
// idempotent creation — ON CONFLICT DO NOTHING + the UNION ALL read-back
// (§4 decision 3)
// -----------------------------------------------------------------------------

func TestPG_Create_IfAbsentPreservesDroppedStatus(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedWatchedSubscription(t, pool, user, 1, "dropped", 4)

	ctx := withUserClaims(t, context.Background(), user, "alice")
	req := newReq(t, http.MethodPost, "/api/subscriptions",
		`{"anilistId":1,"status":"watching","ifAbsent":true}`, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())

	// The response is the read-back arm of the UNION ALL, not the insert.
	var got struct {
		Data dbgen.Subscription `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, "dropped", got.Data.Status, "existing row must come back verbatim")
	assert.Equal(t, int32(4), got.Data.CurrentEpisode, "progress must survive click-to-track")

	var status string
	var episode int32
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT status, current_episode FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user,
	).Scan(&status, &episode))
	assert.Equal(t, "dropped", status, "click-to-track must never resurrect a hand-dropped title")
	assert.Equal(t, int32(4), episode)
}

func TestPG_Create_IfAbsentCreatesWhenMissing(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	doPost := func() *httptest.ResponseRecorder {
		req := newReq(t, http.MethodPost, "/api/subscriptions",
			`{"anilistId":1,"status":"watching","ifAbsent":true}`, "", ctx)
		rec := httptest.NewRecorder()
		h.CreateSubscription(rec, req)
		return rec
	}

	rec := doPost()
	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())

	var status string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT status FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&status))
	assert.Equal(t, "watching", status, "absent row must actually be created")

	// Replaying it is the point — the reconciler has no queue and no
	// dedupe of its own, so the endpoint has to absorb repeats.
	rec2 := doPost()
	require.Equal(t, http.StatusCreated, rec2.Code, "body=%s", rec2.Body.String())

	var n int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&n))
	assert.Equal(t, 1, n, "replay must not duplicate")
}

func TestPG_Create_IfAbsentOmitted_StillUpserts(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "dropped")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	req := newReq(t, http.MethodPost, "/api/subscriptions",
		`{"anilistId":1,"status":"watching"}`, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())

	var status string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT status FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user).Scan(&status))
	assert.Equal(t, "watching", status,
		"the explicit Subscribe button still overwrites status — only ifAbsent changes that")
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
