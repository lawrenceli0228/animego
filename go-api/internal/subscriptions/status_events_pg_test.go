package subscriptions

// status_events_pg_test.go — the 'status' activity event (migration 0046).
//
// Every subscription write that changes what list a title is on appends one
// event in the same statement: that is what the anime's community tab lists
// as 看完了 / 在看 / 想看 / 弃番.  The tests pin both halves: a real change
// appends exactly one event with the new status, and a write that changes
// nothing — a replayed create, a repeated PATCH, a progress-only PATCH —
// appends none.
//
// A new status also replaces the person's earlier status events for that
// title that nobody has liked or replied to, so switching back and forth
// cannot fill the tab's 最近动态; and taking the title off the list takes
// its status events with it.

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
	assert.Equal(t, []string{"watching"}, statusEvents(t, pool, user, 1), "the new status replaces the one nobody answered")
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
	assert.Equal(t, []string{"dropped"}, statusEvents(t, pool, user, 1))
}

// statusEventID is the id of the user's one status event for the anime.
func statusEventID(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(), `
		SELECT id FROM activity_events
		WHERE user_id = $1 AND anilist_id = $2 AND event_type = 'status'`, userID, anilistID).Scan(&id))
	return id
}

func TestPG_StatusEvents_SwitchingBackAndForthLeavesOneCard(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()
	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	postSubscription(t, h, ctx, `{"anilistId":1,"status":"watching"}`)
	for i := 0; i < 5; i++ {
		patchStatusSubscription(t, h, ctx, 1, `{"status":"completed"}`)
		patchStatusSubscription(t, h, ctx, 1, `{"status":"watching"}`)
		postSubscription(t, h, ctx, `{"anilistId":1,"status":"dropped"}`)
	}
	assert.Equal(t, []string{"dropped"}, statusEvents(t, pool, user, 1))
}

func TestPG_StatusEvents_ACardSomeoneAnsweredIsKept(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")
	seedAnime(t, pool, 3, "C", "丙")
	ctx := withUserClaims(t, context.Background(), alice, "alice")
	bg := context.Background()

	// Liked: kept.
	postSubscription(t, h, ctx, `{"anilistId":1,"status":"watching"}`)
	_, err := pool.Exec(bg, `INSERT INTO activity_likes (activity_event_id, user_id) VALUES ($1, $2)`,
		statusEventID(t, pool, alice, 1), bob)
	require.NoError(t, err)
	patchStatusSubscription(t, h, ctx, 1, `{"status":"completed"}`)
	assert.Equal(t, []string{"watching", "completed"}, statusEvents(t, pool, alice, 1), "a liked card stays")

	// A live reply: kept.
	postSubscription(t, h, ctx, `{"anilistId":2,"status":"watching"}`)
	_, err = pool.Exec(bg, `INSERT INTO community_replies (anilist_id, activity_event_id, user_id, body) VALUES (2, $1, $2, '加油')`,
		statusEventID(t, pool, alice, 2), bob)
	require.NoError(t, err)
	patchStatusSubscription(t, h, ctx, 2, `{"status":"completed"}`)
	assert.Equal(t, []string{"watching", "completed"}, statusEvents(t, pool, alice, 2), "a card with a reply stays")

	// Only a deleted reply: replaced, and the deleted reply goes with it.
	postSubscription(t, h, ctx, `{"anilistId":3,"status":"watching"}`)
	_, err = pool.Exec(bg, `INSERT INTO community_replies (anilist_id, activity_event_id, user_id, body, deleted_at) VALUES (3, $1, $2, '已删', now())`,
		statusEventID(t, pool, alice, 3), bob)
	require.NoError(t, err)
	patchStatusSubscription(t, h, ctx, 3, `{"status":"completed"}`)
	assert.Equal(t, []string{"completed"}, statusEvents(t, pool, alice, 3), "a deleted reply is not a conversation")
}

func TestPG_StatusEvents_UnsubscribingRemovesTheCards(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")
	aliceCtx := withUserClaims(t, context.Background(), alice, "alice")
	bobCtx := withUserClaims(t, context.Background(), bob, "bob")

	postSubscription(t, h, aliceCtx, `{"anilistId":1,"status":"completed"}`)
	postSubscription(t, h, aliceCtx, `{"anilistId":2,"status":"watching"}`)
	postSubscription(t, h, bobCtx, `{"anilistId":1,"status":"watching"}`)

	req := newReq(t, http.MethodDelete, "/api/subscriptions/1", "", "1", aliceCtx)
	rec := httptest.NewRecorder()
	h.DeleteSubscription(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	assert.Empty(t, statusEvents(t, pool, alice, 1), "off the list, off the tab")
	assert.Equal(t, []string{"watching"}, statusEvents(t, pool, alice, 2), "her other titles keep theirs")
	assert.Equal(t, []string{"watching"}, statusEvents(t, pool, bob, 1), "and other people keep theirs")
}
