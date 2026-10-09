package subscriptions

// status_events_pg_test.go — the 'status' activity event (migration 0046).
//
// Every subscription write that changes what list a title is on appends one
// event in the same statement: that is what the anime's community tab lists
// as 看完了 / 在看 / 想看 / 弃番.  The tests pin both halves: a real change
// appends exactly one event with the new status, and a write that changes
// nothing — a replayed create, a repeated PATCH, a progress-only PATCH —
// appends none.

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// statusEvents lists one user's status events for one anime, oldest first.
func statusEvents(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT status FROM activity_events
		WHERE user_id = $1 AND anilist_id = $2 AND event_type = 'status'
		ORDER BY created_at, id`, userID, anilistID)
	require.NoError(t, err)
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		require.NoError(t, rows.Scan(&s))
		out = append(out, s)
	}
	require.NoError(t, rows.Err())
	return out
}

func postSubscription(t *testing.T, h *Handlers, ctx context.Context, body string) {
	t.Helper()
	req := newReq(t, http.MethodPost, "/api/subscriptions", body, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())
}

func patchStatusSubscription(t *testing.T, h *Handlers, ctx context.Context, anilistID int32, body string) {
	t.Helper()
	req := newReq(t, http.MethodPatch, fmt.Sprintf("/api/subscriptions/%d", anilistID), body, fmt.Sprint(anilistID), ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestPG_StatusEvents_UpsertAppendsOnCreateAndOnChangeOnly(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()
	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	postSubscription(t, h, ctx, `{"anilistId":1,"status":"plan_to_watch"}`)
	assert.Equal(t, []string{"plan_to_watch"}, statusEvents(t, pool, user, 1))

	postSubscription(t, h, ctx, `{"anilistId":1,"status":"plan_to_watch"}`)
	assert.Equal(t, []string{"plan_to_watch"}, statusEvents(t, pool, user, 1), "the same status again is not news")

	postSubscription(t, h, ctx, `{"anilistId":1,"status":"watching"}`)
	assert.Equal(t, []string{"plan_to_watch", "watching"}, statusEvents(t, pool, user, 1))
}

func TestPG_StatusEvents_IfAbsentAppendsOnlyWhenItCreates(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()
	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")
	seedSubscription(t, pool, user, 2, "dropped")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	postSubscription(t, h, ctx, `{"anilistId":1,"status":"watching","ifAbsent":true}`)
	postSubscription(t, h, ctx, `{"anilistId":1,"status":"watching","ifAbsent":true}`)
	assert.Equal(t, []string{"watching"}, statusEvents(t, pool, user, 1), "a replayed click-to-track appends nothing")

	postSubscription(t, h, ctx, `{"anilistId":2,"status":"watching","ifAbsent":true}`)
	assert.Empty(t, statusEvents(t, pool, user, 2), "an existing row is left alone, and so is the feed")
}

func TestPG_StatusEvents_PatchAppendsOnARealStatusChange(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()
	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	patchStatusSubscription(t, h, ctx, 1, `{"status":"completed"}`)
	assert.Equal(t, []string{"completed"}, statusEvents(t, pool, user, 1), "看完了")

	patchStatusSubscription(t, h, ctx, 1, `{"status":"completed"}`)
	assert.Equal(t, []string{"completed"}, statusEvents(t, pool, user, 1), "a repeated PATCH appends nothing")

	patchStatusSubscription(t, h, ctx, 1, `{"currentEpisode":3}`)
	patchStatusSubscription(t, h, ctx, 1, `{"score":8}`)
	assert.Equal(t, []string{"completed"}, statusEvents(t, pool, user, 1), "progress and score are not status")
	assert.Equal(t, 1, countWatchEvents(t, pool, user), "progress still writes its own event")

	patchStatusSubscription(t, h, ctx, 1, `{"status":"dropped","currentEpisode":4}`)
	assert.Equal(t, []string{"completed", "dropped"}, statusEvents(t, pool, user, 1))
}
