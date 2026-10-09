package notifications

// pg_test.go — PG-backed proof that the notification inbox actually enforces
// user blocks.
//
// Enforcement for this package lives entirely in SQL: ListNotifications and
// CountUnreadNotifications each carry a NOT EXISTS against user_blocks that
// drops any row whose actor sits on either side of a block.  The fakeDB in
// handlers_test.go returns whatever rows a test hands it, so by construction
// it can never catch a regression in that predicate — only a live Postgres
// can.  Hence this file, and hence the TestMain below (the fake-based tests
// in this package do not need the container, they just share its lifetime).
//
// Per-test isolation comes from a fresh pool plus testutil.TruncateAll.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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
		fmt.Fprintf(os.Stderr, "notifications tests: setup postgres: %v\n", err)
		os.Exit(1)
	}
	defer cleanup()
	pgURI = uri
	os.Exit(m.Run())
}

// blockDirection names which side of the pair wrote the user_blocks row.  The
// stored record is directional (blocker_id, blocked_id) but the read policy in
// community.sql matches either orientation, so every enforcement test runs
// both ways: a notification must disappear whether the recipient blocked the
// actor or the actor blocked the recipient.
type blockDirection struct {
	name               string
	recipientIsBlocker bool
}

var blockDirections = []blockDirection{
	{name: "recipient blocked actor", recipientIsBlocker: true},
	{name: "actor blocked recipient", recipientIsBlocker: false},
}

// pair maps a direction case onto the (blocker, blocked) argument order.
func (d blockDirection) pair(recipient, actor uuid.UUID) (uuid.UUID, uuid.UUID) {
	if d.recipientIsBlocker {
		return recipient, actor
	}
	return actor, recipient
}

func seedNotificationUser(t *testing.T, pool *pgxpool.Pool, username string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO users (username, email, password)
		VALUES ($1, $1 || '@example.test', 'hash')
		RETURNING id`, username).Scan(&id))
	return id
}

// seedNotification writes one row directly rather than going through
// InsertNotificationDedupe so the test controls created_at (the list is
// ordered by it) and read state independently of any write-path policy.
// A nil readAt leaves the notification unread.
func seedNotification(
	t *testing.T,
	pool *pgxpool.Pool,
	recipient, actor uuid.UUID,
	dedupeKey string,
	createdAt time.Time,
	readAt *time.Time,
) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO notifications (user_id, actor_id, notification_type, dedupe_key, created_at, read_at)
		VALUES ($1, $2, 'follow', $3, $4, $5)
		RETURNING id`, recipient, actor, dedupeKey, createdAt, readAt).Scan(&id))
	return id
}

func insertBlock(t *testing.T, pool *pgxpool.Pool, blocker, blocked uuid.UUID) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, blocker, blocked)
	require.NoError(t, err)
}

func notificationIDs(rows []dbgen.ListNotificationsRow) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

func TestListNotificationsExcludesBlockedActorEitherDirection(t *testing.T) {
	ctx := context.Background()
	base := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	for _, dir := range blockDirections {
		t.Run(dir.name, func(t *testing.T) {
			pool := testutil.NewWebPool(t, ctx, pgURI)
			testutil.TruncateAll(t, ctx, pool)
			queries := dbgen.New(pool)

			viewer := seedNotificationUser(t, pool, "viewer")
			blockedActor := seedNotificationUser(t, pool, "blocked-actor")
			friend := seedNotificationUser(t, pool, "friend")

			hidden := seedNotification(t, pool, viewer, blockedActor, "blocked:follow", base, nil)
			visible := seedNotification(t, pool, viewer, friend, "friend:follow", base.Add(time.Minute), nil)
			blocker, blocked := dir.pair(viewer, blockedActor)
			insertBlock(t, pool, blocker, blocked)

			rows, err := queries.ListNotifications(ctx, viewer, 50)
			require.NoError(t, err)

			// Asserting the exact surviving row keeps this a filtering proof
			// rather than an empty-table proof: the unblocked actor's
			// notification has to still come back in the same result set.
			ids := notificationIDs(rows)
			assert.Equal(t, []uuid.UUID{visible}, ids)
			assert.NotContains(t, ids, hidden)
			require.Len(t, rows, 1)
			assert.Equal(t, "friend", rows[0].ActorUsername)
		})
	}
}

func TestCountUnreadNotificationsAgreesWithListNotifications(t *testing.T) {
	ctx := context.Background()
	base := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	readAt := base.Add(time.Hour)

	for _, dir := range blockDirections {
		t.Run(dir.name, func(t *testing.T) {
			pool := testutil.NewWebPool(t, ctx, pgURI)
			testutil.TruncateAll(t, ctx, pool)
			queries := dbgen.New(pool)

			viewer := seedNotificationUser(t, pool, "viewer")
			blockedActor := seedNotificationUser(t, pool, "blocked-actor")
			friend := seedNotificationUser(t, pool, "friend")

			seedNotification(t, pool, viewer, blockedActor, "blocked:one", base, nil)
			seedNotification(t, pool, viewer, blockedActor, "blocked:two", base.Add(time.Minute), nil)
			friendUnread := seedNotification(t, pool, viewer, friend, "friend:unread", base.Add(2*time.Minute), nil)
			friendRead := seedNotification(t, pool, viewer, friend, "friend:read", base.Add(3*time.Minute), &readAt)
			blocker, blocked := dir.pair(viewer, blockedActor)
			insertBlock(t, pool, blocker, blocked)

			rows, err := queries.ListNotifications(ctx, viewer, 50)
			require.NoError(t, err)
			assert.ElementsMatch(t, []uuid.UUID{friendUnread, friendRead}, notificationIDs(rows))

			var unreadInList int64
			for _, row := range rows {
				if !row.ReadAt.Valid {
					unreadInList++
				}
			}

			unread, err := queries.CountUnreadNotifications(ctx, viewer)
			require.NoError(t, err)

			// The badge is only trustworthy when it counts exactly the unread
			// rows the inbox is willing to show.  A 3 here would be the
			// "bell says 3, opening it shows one message" bug: two unread
			// notifications from the blocked actor leaking into the count.
			assert.Equal(t, int64(1), unread)
			assert.Equal(t, unreadInList, unread)
		})
	}
}

// TestListEndpointHidesBlockedActorFromItemsAndBadge closes the loop at the
// handler: List fans out to both queries concurrently, so this is where a
// filter present in one query but missing from the other would actually reach
// a user.
func TestListEndpointHidesBlockedActorFromItemsAndBadge(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)

	viewer := seedNotificationUser(t, pool, "viewer")
	blockedActor := seedNotificationUser(t, pool, "blocked-actor")
	friend := seedNotificationUser(t, pool, "friend")

	base := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	seedNotification(t, pool, viewer, blockedActor, "blocked:one", base, nil)
	seedNotification(t, pool, viewer, blockedActor, "blocked:two", base.Add(time.Minute), nil)
	seedNotification(t, pool, viewer, friend, "friend:unread", base.Add(2*time.Minute), nil)
	insertBlock(t, pool, viewer, blockedActor)

	rec := httptest.NewRecorder()
	NewHandlers(dbgen.New(pool)).List(rec, authenticatedRequest(t, http.MethodGet, "/api/notifications", viewer))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var body struct {
		Data struct {
			UnreadCount int64 `json:"unreadCount"`
			Items       []struct {
				Actor struct {
					Username string `json:"username"`
				} `json:"actor"`
			} `json:"items"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Data.Items, 1)
	assert.Equal(t, "friend", body.Data.Items[0].Actor.Username)
	assert.Equal(t, int64(1), body.Data.UnreadCount)
}

// TestListNotificationsReadsCommunityReplyContext proves the SQL half of the
// community tab's reply notifications (migration 0046): the anime comes
// through the reply when there is no comment, the thread title through the
// reply's thread, and an episode-comment notification beside it is
// unchanged.
func TestListNotificationsReadsCommunityReplyContext(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	queries := dbgen.New(pool)

	owner := seedNotificationUser(t, pool, "owner")
	replier := seedNotificationUser(t, pool, "replier")
	_, err := pool.Exec(ctx, `INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese) VALUES (154587, 'Sousou no Frieren', '葬送的芙莉莲')`)
	require.NoError(t, err)

	var threadID, replyID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO anime_threads (anilist_id, user_id, title, body) VALUES (154587, $1, '第五集的回忆杀', '说说看')
		RETURNING id`, owner).Scan(&threadID))
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO community_replies (anilist_id, thread_id, user_id, body, is_spoiler) VALUES (154587, $1, $2, '结局是……', true)
		RETURNING id`, threadID, replier).Scan(&replyID))
	_, err = pool.Exec(ctx, `
		INSERT INTO notifications (user_id, actor_id, notification_type, reply_id, dedupe_key)
		VALUES ($1, $2, 'thread_reply', $3, $4)`, owner, replier, replyID, "thread_reply:"+replyID.String())
	require.NoError(t, err)

	rows, err := queries.ListNotifications(ctx, owner, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	row := rows[0]
	assert.Equal(t, "thread_reply", row.NotificationType)
	assert.Nil(t, row.AnilistID, "no comment behind it")
	require.NotNil(t, row.ReplyAnilistID)
	assert.Equal(t, int32(154587), *row.ReplyAnilistID)
	require.NotNil(t, row.TitleChinese, "the anime is joined through the reply")
	assert.Equal(t, "葬送的芙莉莲", *row.TitleChinese)
	require.NotNil(t, row.ReplyThreadID)
	assert.Equal(t, threadID, *row.ReplyThreadID)
	require.NotNil(t, row.ThreadTitle)
	assert.Equal(t, "第五集的回忆杀", *row.ThreadTitle)
	require.NotNil(t, row.ReplyIsSpoiler)
	assert.True(t, *row.ReplyIsSpoiler)

	item := toItem(row)
	assert.True(t, item.IsSpoiler)
	assert.Nil(t, item.Excerpt, "the handler never quotes a spoiler")

	unread, err := queries.CountUnreadNotifications(ctx, owner)
	require.NoError(t, err)
	assert.Equal(t, int64(1), unread)

	// Deleting a thread or a reply deletes its notifications in the same
	// statement, but a reply posted while its thread was being deleted is
	// one that statement's snapshot never saw, and its notification stays
	// behind.  Such a leftover is neither listed (no removed title or text
	// in the inbox) nor counted.
	_, err = pool.Exec(ctx, `UPDATE anime_threads SET deleted_at = now() WHERE id = $1`, threadID)
	require.NoError(t, err)
	rows, err = queries.ListNotifications(ctx, owner, 10)
	require.NoError(t, err)
	assert.Empty(t, rows, "nothing from a removed thread")
	unread, err = queries.CountUnreadNotifications(ctx, owner)
	require.NoError(t, err)
	assert.Zero(t, unread)

	_, err = pool.Exec(ctx, `UPDATE anime_threads SET deleted_at = NULL WHERE id = $1`, threadID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE community_replies SET deleted_at = now() WHERE id = $1`, replyID)
	require.NoError(t, err)
	rows, err = queries.ListNotifications(ctx, owner, 10)
	require.NoError(t, err)
	assert.Empty(t, rows, "nor a removed reply")
	unread, err = queries.CountUnreadNotifications(ctx, owner)
	require.NoError(t, err)
	assert.Zero(t, unread)
}
