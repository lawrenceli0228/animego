package comments

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

func TestListTrendingDiscussions_RanksParticipationAndRedactsSpoiler(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 101)
	seedAnime(t, pool, 202)
	alice := seedUser(t, pool, "discover_alice", "discover-alice@example.com")
	bob := seedUser(t, pool, "discover_bob", "discover-bob@example.com")

	_, err := pool.Exec(context.Background(), `
		UPDATE anime_cache
		SET title_chinese = '热议番剧', title_romaji = 'Hot Anime',
		    cover_image_url = 'https://example.test/hot.jpg'
		WHERE anilist_id = 101;
		UPDATE anime_cache
		SET title_chinese = '普通番剧', title_romaji = 'Quiet Anime'
		WHERE anilist_id = 202`)
	require.NoError(t, err)

	first := seedComment(t, pool, 101, 3, alice, "discover_alice", "第一条讨论")
	var latestID string
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO episode_comments (
			anilist_id, episode, user_id, username, content, is_spoiler
		) VALUES (101, 3, $1, 'discover_bob', '这里是剧透正文', true)
		RETURNING id::text`, bob).Scan(&latestID))
	_, err = pool.Exec(context.Background(), `
		INSERT INTO comment_reactions (comment_id, user_id, reaction)
		VALUES ($1, $2, 'like')`, first, bob)
	require.NoError(t, err)
	seedComment(t, pool, 202, 1, alice, "discover_alice", "只有一位参与者")

	req := httptest.NewRequest(http.MethodGet, "/api/community/discussions/trending?limit=6", nil)
	rec := httptest.NewRecorder()
	h.ListTrendingDiscussions(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var env struct {
		Data []struct {
			AnilistID        int32 `json:"anilistId"`
			Episode          int32 `json:"episode"`
			CommentCount     int64 `json:"commentCount"`
			ParticipantCount int64 `json:"participantCount"`
			ReactionCount    int64 `json:"reactionCount"`
			Latest           struct {
				ID        string `json:"id"`
				Content   string `json:"content"`
				IsSpoiler bool   `json:"isSpoiler"`
			} `json:"latest"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Len(t, env.Data, 2)
	assert.Equal(t, int32(101), env.Data[0].AnilistID)
	assert.Equal(t, int32(3), env.Data[0].Episode)
	assert.Equal(t, int64(2), env.Data[0].CommentCount)
	assert.Equal(t, int64(2), env.Data[0].ParticipantCount)
	assert.Equal(t, int64(1), env.Data[0].ReactionCount)
	assert.Equal(t, latestID, env.Data[0].Latest.ID)
	assert.True(t, env.Data[0].Latest.IsSpoiler)
	assert.Empty(t, env.Data[0].Latest.Content, "spoiler preview must be redacted")
}

func TestCommunityEngagement_AggregatesWithoutUserHistory(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 101)
	alice := seedUser(t, pool, "metrics_alice", "metrics-alice@example.com")

	for range 2 {
		req := httptest.NewRequest(http.MethodPost, "/api/community/engagement", strings.NewReader(`{
			"eventType":"hot_discussions_impression","source":"home"
		}`))
		rec := httptest.NewRecorder()
		h.TrackCommunityEngagement(rec, req)
		require.Equal(t, http.StatusAccepted, rec.Code, "body=%s", rec.Body.String())
	}

	openReq := httptest.NewRequest(http.MethodPost, "/api/community/engagement", strings.NewReader(`{
		"eventType":"discussion_open","source":"home","anilistId":101,"episode":3
	}`))
	openReq = withAuth(t, openReq, alice, "metrics_alice")
	openRec := httptest.NewRecorder()
	h.TrackCommunityEngagement(openRec, openReq)
	require.Equal(t, http.StatusAccepted, openRec.Code, "body=%s", openRec.Body.String())

	metricsReq := httptest.NewRequest(http.MethodGet, "/api/admin/community-metrics?days=7", nil)
	metricsRec := httptest.NewRecorder()
	h.CommunityMetrics(metricsRec, metricsReq)
	require.Equal(t, http.StatusOK, metricsRec.Code, "body=%s", metricsRec.Body.String())

	var metrics struct {
		Data struct {
			Days        int     `json:"days"`
			Impressions int64   `json:"impressions"`
			Opens       int64   `json:"opens"`
			OpenRate    float64 `json:"openRate"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(metricsRec.Body.Bytes(), &metrics))
	assert.Equal(t, 7, metrics.Data.Days)
	assert.Equal(t, int64(2), metrics.Data.Impressions)
	assert.Equal(t, int64(1), metrics.Data.Opens)
	assert.Equal(t, 0.5, metrics.Data.OpenRate)

	var rowCount int
	require.NoError(t, pool.QueryRow(context.Background(), `
		SELECT count(*) FROM community_engagement_daily`).Scan(&rowCount))
	assert.Equal(t, 2, rowCount, "anonymous and authenticated aggregates stay separate")

	var userColumns int
	require.NoError(t, pool.QueryRow(context.Background(), `
		SELECT count(*)
		FROM information_schema.columns
		WHERE table_name = 'community_engagement_daily'
		  AND column_name IN ('user_id', 'session_id', 'ip_address', 'user_agent')
	`).Scan(&userColumns))
	assert.Zero(t, userColumns, "aggregate telemetry must not grow a browsing identity")
}

func TestCommunityEngagement_RejectsInvalidTarget(t *testing.T) {
	h, _ := makeHandlers(t)
	req := httptest.NewRequest(http.MethodPost, "/api/community/engagement", strings.NewReader(`{
		"eventType":"discussion_open","source":"home","anilistId":101,"episode":0
	}`))
	rec := httptest.NewRecorder()
	h.TrackCommunityEngagement(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

// The welcome card and the rail are counted against different denominators on
// purpose: the card renders whether or not the rail has anything in it, so its
// exposure is recorded on strictly more renders.  The two rates here are
// deliberately different numbers, because a handler that crossed the pairs --
// dividing welcome opens by rail impressions -- would produce 0.5 for both and
// look perfectly plausible.
func TestCommunityEngagement_WelcomeCardKeepsItsOwnDenominator(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 404)

	post := func(body string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/community/engagement", strings.NewReader(body))
		rec := httptest.NewRecorder()
		h.TrackCommunityEngagement(rec, req)
		// A 500 here is the specific failure this migration exists to avoid:
		// widening community_engagement_event_type_chk without also widening
		// community_engagement_target_chk lets the request past the Go
		// allowlist and then fails the insert at the database edge.
		require.Equal(t, http.StatusAccepted, rec.Code, "body=%s", rec.Body.String())
	}

	for range 4 {
		post(`{"eventType":"welcome_card_impression","source":"home"}`)
	}
	post(`{"eventType":"welcome_card_open","source":"home"}`)

	for range 2 {
		post(`{"eventType":"hot_discussions_impression","source":"home"}`)
	}
	post(`{"eventType":"discussion_open","source":"home","anilistId":404,"episode":1}`)

	metricsReq := httptest.NewRequest(http.MethodGet, "/api/admin/community-metrics?days=7", nil)
	metricsRec := httptest.NewRecorder()
	h.CommunityMetrics(metricsRec, metricsReq)
	require.Equal(t, http.StatusOK, metricsRec.Code, "body=%s", metricsRec.Body.String())

	var metrics struct {
		Data struct {
			Impressions        int64   `json:"impressions"`
			Opens              int64   `json:"opens"`
			OpenRate           float64 `json:"openRate"`
			WelcomeImpressions int64   `json:"welcomeImpressions"`
			WelcomeOpens       int64   `json:"welcomeOpens"`
			WelcomeOpenRate    float64 `json:"welcomeOpenRate"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(metricsRec.Body.Bytes(), &metrics))

	assert.Equal(t, int64(2), metrics.Data.Impressions)
	assert.Equal(t, int64(1), metrics.Data.Opens)
	assert.Equal(t, 0.5, metrics.Data.OpenRate)

	assert.Equal(t, int64(4), metrics.Data.WelcomeImpressions)
	assert.Equal(t, int64(1), metrics.Data.WelcomeOpens)
	assert.Equal(t, 0.25, metrics.Data.WelcomeOpenRate,
		"welcome opens must divide by welcome impressions, not by the rail's")
}

func TestCommunityEngagement_RejectsWelcomeEventCarryingATarget(t *testing.T) {
	h, _ := makeHandlers(t)
	req := httptest.NewRequest(http.MethodPost, "/api/community/engagement", strings.NewReader(`{
		"eventType":"welcome_card_open","source":"home","anilistId":101,"episode":3
	}`))
	rec := httptest.NewRecorder()
	h.TrackCommunityEngagement(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code,
		"the welcome card names no anime, so a target must be refused at parse time")
}

// Proves 0028 widened community_engagement_target_chk rather than loosening it.
// Going around the Go allowlist with a direct insert is the only way to reach
// the constraint, and reaching it is the point: the handler and the schema are
// two independent statements of the same rule, and this asserts the schema half
// still says no.
func TestCommunityEngagementSchema_WelcomeEventsStillCannotCarryATarget(t *testing.T) {
	_, pool := makeHandlers(t)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO community_engagement_daily
			(event_type, source, anilist_id, episode, authenticated, event_count)
		VALUES ('welcome_card_open', 'home', 101, 3, false, 1)`)
	require.Error(t, err, "target_chk must still reject an untargeted event that names an anime")
	assert.Contains(t, err.Error(), "community_engagement_target_chk")

	_, err = pool.Exec(context.Background(), `
		INSERT INTO community_engagement_daily
			(event_type, source, anilist_id, episode, authenticated, event_count)
		VALUES ('welcome_card_typo', 'home', 0, 0, false, 1)`)
	require.Error(t, err, "the vocabulary stays closed — a typo is not a new event type")
	assert.Contains(t, err.Error(), "community_engagement_event_type_chk")
}

func TestSeasonalRows_IncludeDiscussionCount(t *testing.T) {
	_, pool := makeHandlers(t)
	seedAnime(t, pool, 303)
	alice := seedUser(t, pool, "season_alice", "season-alice@example.com")
	_, err := pool.Exec(context.Background(), `
		UPDATE anime_cache
		SET season = 'SUMMER', season_year = 2026, average_score = 80
		WHERE anilist_id = 303`)
	require.NoError(t, err)
	seedComment(t, pool, 303, 1, alice, "season_alice", "第一集讨论")
	seedComment(t, pool, 303, 2, alice, "season_alice", "第二集讨论")

	season := "SUMMER"
	year := int32(2026)
	rows, err := dbgen.New(pool).GetSeasonalAnime(
		context.Background(),
		&season,
		&year,
		20,
		0,
	)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, int64(2), rows[0].DiscussionCount)
}
