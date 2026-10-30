package comments

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
