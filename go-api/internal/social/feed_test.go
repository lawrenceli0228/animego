package social

// feed_test.go — PG-backed tests for GET /api/feed.
//
// Test matrix:
//   - happy path (multiple followees with activity)
//   - empty-followees short-circuit ({data:[], hasMore:false, nextPage:null})
//   - lastWatchedAt IS NULL filtered out
//   - missing TitleRomaji → "Anime #N" fallback
//   - pagination (hasMore/nextPage when total > 20)
//   - missing claims → 500
//   - DB error → 500

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// feedDecode parses the feed response into a struct.  We use json.RawMessage
// for nextPage because *int doesn't distinguish null vs missing reliably.
type feedDecode struct {
	Data     []feedItem      `json:"data"`
	HasMore  bool            `json:"hasMore"`
	NextPage json.RawMessage `json:"nextPage"`
}

func TestGetFeed_HappyPath(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	carol := seedUser(t, pool, "carol", "carol@example.com")
	// alice follows bob + carol.
	seedFollow(t, pool, alice, bob)
	seedFollow(t, pool, alice, carol)

	// 3 anime cached, 3 subs spread across bob + carol.
	seedAnime(t, pool, 1, "Anime One", "动画一", "https://img/1.jpg")
	seedAnime(t, pool, 2, "Anime Two", "动画二", "https://img/2.jpg")
	seedAnime(t, pool, 3, "Anime Three", "", "")

	t1 := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	t3 := time.Date(2026, 1, 3, 12, 0, 0, 0, time.UTC)
	seedSubscription(t, pool, bob, 1, 3, "watching", &t1)
	seedSubscription(t, pool, carol, 2, 5, "watching", &t2)
	seedSubscription(t, pool, bob, 3, 1, "watching", &t3)

	req := httptest.NewRequest(http.MethodGet, "/api/feed", nil)
	req = withAuth(t, req, alice, "alice")

	rec := httptest.NewRecorder()
	h.GetFeed(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var got feedDecode
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Len(t, got.Data, 3)
	assert.False(t, got.HasMore)
	assert.Equal(t, "null", string(got.NextPage), "nextPage should marshal to JSON null")

	// Sort order: lastWatchedAt DESC → t3 (bob/3) → t2 (carol/2) → t1 (bob/1).
	assert.Equal(t, "bob", got.Data[0].Username)
	assert.Equal(t, int32(3), got.Data[0].AnilistID)
	assert.Equal(t, int32(1), got.Data[0].Episode)
	assert.Equal(t, "watching", got.Data[0].Status)
	assert.Equal(t, "Anime Three", got.Data[0].Title)

	assert.Equal(t, "carol", got.Data[1].Username)
	assert.Equal(t, int32(2), got.Data[1].AnilistID)
	assert.Equal(t, int32(5), got.Data[1].Episode)

	assert.Equal(t, "bob", got.Data[2].Username)
	assert.Equal(t, int32(1), got.Data[2].AnilistID)
	assert.Equal(t, int32(3), got.Data[2].Episode)
}

func TestGetFeed_NoFollowees_EmptyShortCircuit(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	// No follows seeded for alice.

	req := httptest.NewRequest(http.MethodGet, "/api/feed", nil)
	req = withAuth(t, req, alice, "alice")

	rec := httptest.NewRecorder()
	h.GetFeed(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	// Byte-exact: data:[], hasMore:false, nextPage:null in that order.
	want := `{"data":[],"hasMore":false,"nextPage":null}`
	assert.Equal(t, want, rec.Body.String(), "empty feed should produce exact envelope")
}

func TestGetFeed_LastWatchedAtNull_Excluded(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedFollow(t, pool, alice, bob)

	seedAnime(t, pool, 1, "A", "", "")
	seedAnime(t, pool, 2, "B", "", "")
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	seedSubscription(t, pool, bob, 1, 1, "watching", &t1) // has lastWatchedAt
	seedSubscription(t, pool, bob, 2, 0, "watching", nil) // NULL lastWatchedAt — must be excluded

	req := httptest.NewRequest(http.MethodGet, "/api/feed", nil)
	req = withAuth(t, req, alice, "alice")

	rec := httptest.NewRecorder()
	h.GetFeed(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var got feedDecode
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Len(t, got.Data, 1, "rows with null lastWatchedAt must be filtered out")
	assert.Equal(t, int32(1), got.Data[0].AnilistID)
}

func TestGetFeed_MissingAnimeCache_TitleFallback(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedFollow(t, pool, alice, bob)

	// Seed anime row but with NULL title_romaji.
	_, err := pool.Exec(context.Background(), `
		INSERT INTO anime_cache (anilist_id, cached_at)
		VALUES ($1, now())`, int32(777))
	require.NoError(t, err)

	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	seedSubscription(t, pool, bob, 777, 1, "watching", &t1)

	req := httptest.NewRequest(http.MethodGet, "/api/feed", nil)
	req = withAuth(t, req, alice, "alice")

	rec := httptest.NewRecorder()
	h.GetFeed(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var got feedDecode
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got.Data, 1)
	assert.Equal(t, "Anime #777", got.Data[0].Title, "fallback title should be `Anime #N` when title_romaji is NULL")
}

func TestGetFeed_Paginated_HasMore(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedFollow(t, pool, alice, bob)

	// Seed 21 anime + 21 subs so total > pageSize=20.
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 21; i++ {
		seedAnime(t, pool, int32(100+i), "Anime", "", "")
		ts := base.Add(time.Duration(i) * time.Hour)
		seedSubscription(t, pool, bob, int32(100+i), int32(i), "watching", &ts)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/feed?page=1", nil)
	req = withAuth(t, req, alice, "alice")
	rec := httptest.NewRecorder()
	h.GetFeed(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var got feedDecode
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Len(t, got.Data, 20, "page=1 should hold 20 items")
	assert.True(t, got.HasMore, "21 total → hasMore=true")
	assert.Equal(t, "2", string(got.NextPage), "nextPage=2 when hasMore=true")

	// Page 2 has 1 item.
	req2 := httptest.NewRequest(http.MethodGet, "/api/feed?page=2", nil)
	req2 = withAuth(t, req2, alice, "alice")
	rec2 := httptest.NewRecorder()
	h.GetFeed(rec2, req2)

	var got2 feedDecode
	require.NoError(t, json.Unmarshal(rec2.Body.Bytes(), &got2))
	assert.Len(t, got2.Data, 1, "page=2 should hold the remaining 1 item")
	assert.False(t, got2.HasMore)
	assert.Equal(t, "null", string(got2.NextPage))
}

func TestGetFeed_MissingClaims_500(t *testing.T) {
	h, _ := makeHandlers(t)
	req := httptest.NewRequest(http.MethodGet, "/api/feed", nil)
	rec := httptest.NewRecorder()
	h.GetFeed(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"SERVER_ERROR"`)
}

func TestGetFeed_DBPoolClosed_500(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	// Force a DB error by closing the pool — ListFeedFolloweeIDs will
	// fail on a closed pool.
	pool.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/feed", nil)
	req = withAuth(t, req, alice, "alice")
	rec := httptest.NewRecorder()
	h.GetFeed(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "closed pool should 500; body=%s", rec.Body.String())
}

// -----------------------------------------------------------------------------
// Helpers exercised directly
// -----------------------------------------------------------------------------

func TestFallbackTitle_Cases(t *testing.T) {
	t.Parallel()
	romaji := "Real Title"
	empty := ""
	cases := []struct {
		name      string
		romaji    *string
		anilistID int32
		want      string
	}{
		{"nil pointer", nil, 42, "Anime #42"},
		{"empty string", &empty, 99, "Anime #99"},
		{"real title", &romaji, 1, "Real Title"},
		{"zero id", nil, 0, "Anime #0"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := fallbackTitle(tc.romaji, tc.anilistID); got != tc.want {
				t.Errorf("fallbackTitle(%v, %d) = %q, want %q", tc.romaji, tc.anilistID, got, tc.want)
			}
		})
	}
}

func TestMapFeedRows_EmptyReturnsEmptySlice(t *testing.T) {
	t.Parallel()
	got := mapFeedRows(nil)
	if got == nil || len(got) != 0 {
		t.Errorf("mapFeedRows(nil) = %v, want []", got)
	}
}

func TestMapFeedRows_FieldMapping(t *testing.T) {
	t.Parallel()
	romaji := "Hello"
	cn := "你好"
	cover := "https://img/x.jpg"
	rows := []dbgen.ListFeedActivitiesRow{
		{
			AnilistID:      7,
			Status:         "watching",
			CurrentEpisode: 4,
			LastWatchedAt:  pgtype.Timestamptz{Time: time.Now(), Valid: true},
			Username:       "lawrence",
			TitleRomaji:    &romaji,
			TitleChinese:   &cn,
			CoverImageUrl:  &cover,
		},
	}
	got := mapFeedRows(rows)
	require.Len(t, got, 1)
	assert.Equal(t, "lawrence", got[0].Username)
	assert.Equal(t, int32(7), got[0].AnilistID)
	assert.Equal(t, "Hello", got[0].Title)
	require.NotNil(t, got[0].TitleChinese)
	assert.Equal(t, "你好", *got[0].TitleChinese)
	require.NotNil(t, got[0].CoverImageUrl)
	assert.Equal(t, cover, *got[0].CoverImageUrl)
	assert.Equal(t, int32(4), got[0].Episode, "row.CurrentEpisode → Episode")
	assert.Equal(t, "watching", got[0].Status)
}
