package anime

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestDetail_ChineseNamesFromTheBangumiMaps_PG — /api/anime/:id fills a
// character's nameCn and its voice's voiceActorCn from bgm_character_map
// and bgm_person_map (internal/bgmnames).  A match beats a stored name; a
// stored name still shows where there is no match; the response keeps its
// shape, key for key.
func TestDetail_ChineseNamesFromTheBangumiMaps_PG(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	svc, err := NewDetailService(q, nil)
	require.NoError(t, err)
	t.Cleanup(svc.Close)

	const id = 154587
	// Characters 1, 2, 3 voiced by 1001, 1002, 1003 (creditsMedia's shape).
	require.NoError(t, svc.upsertFromMedia(ctx, id, creditsMedia(id, []int{1, 2, 3}, []int{101}, 1000, false)))
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err, sql)
	}
	exec(`INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES
		(1, 86246, '芙莉莲', 'dump', now()),
		(3, 86248, NULL, 'dump', now())`)
	exec(`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES
		(1001, 7575, '种崎敦美', 'dump', now()),
		(1003, 7577, NULL, 'dump', now())`)
	// Names stored on the rows themselves (none is written today; an old
	// import could have left some).
	exec(`UPDATE anime_characters SET name_cn = '旧名', voice_actor_cn = '旧声' WHERE anime_id = 154587 AND character_id IN (1, 2)`)

	detail, err := svc.fetchDetail(ctx, id)
	require.NoError(t, err)
	require.Len(t, detail.Characters, 3)
	byID := map[int32]DetailCharacter{}
	for _, c := range detail.Characters {
		byID[*c.CharacterID] = c
	}

	assert.Equal(t, "芙莉莲", *byID[1].NameCn, "the match wins over a stored name")
	assert.Equal(t, "种崎敦美", *byID[1].VoiceActorCn)
	assert.Equal(t, "旧名", *byID[2].NameCn, "no match: the stored name still shows")
	assert.Equal(t, "旧声", *byID[2].VoiceActorCn)
	assert.Nil(t, byID[3].NameCn, "a match without a Chinese name gives none")
	assert.Nil(t, byID[3].VoiceActorCn)

	raw, err := json.Marshal(byID[1])
	require.NoError(t, err)
	var keys map[string]any
	require.NoError(t, json.Unmarshal(raw, &keys))
	assert.ElementsMatch(t, []string{
		"nameEn", "nameJa", "nameCn", "imageUrl", "role",
		"voiceActorEn", "voiceActorJa", "voiceActorCn", "voiceActorImageUrl",
		"characterId", "voiceActorId",
	}, mapKeys(keys), "the response shape is unchanged")
}

func mapKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
