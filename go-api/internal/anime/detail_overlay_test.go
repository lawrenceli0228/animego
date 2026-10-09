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

// TestDetail_AcceptedEditsOnTheCastAndStaff_PG — /api/anime/:id reads the
// accepted reader edits (entity_overlays) for the names and images of its
// characters, their voices and its staff: overlay, then Bangumi, then the
// row.  Nothing else changes -- not the role, not who voices whom, not one
// key of the response -- and a refresh from AniList, which rewrites the
// credit rows, does not touch an edit.  Forget drops a cached response so
// the next read sees a new edit.
func TestDetail_AcceptedEditsOnTheCastAndStaff_PG(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	svc, err := NewDetailService(q, nil)
	require.NoError(t, err)
	t.Cleanup(svc.Close)

	const id = 154587
	// Characters 1, 2 voiced by 1001, 1002; staff 101.
	media := creditsMedia(id, []int{1, 2}, []int{101}, 1000, false)
	require.NoError(t, svc.upsertFromMedia(ctx, id, media))
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err, sql)
	}
	exec(`INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (1, 86246, '芙莉莲', 'dump', now())`)
	exec(`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (1001, 7575, '种崎敦美', 'dump', now())`)

	before, err := svc.fetchDetail(ctx, id)
	require.NoError(t, err)
	svc.cache.Wait()

	exec(`INSERT INTO entity_overlays (kind, entity_id, data) VALUES
		('character', 1, '{"nameCn":"芙莉莲（改）","nameFull":"Frieren","image":"https://example.org/api/edit-images/c1.jpg",
		                   "roles":{"154587":"MAIN"},"voices":[{"key":"1001|Japanese|","remove":true}]}'),
		('person', 1001, '{"nameCn":"种崎敦美（改）","nameNative":"種﨑敦美","image":"https://example.org/api/edit-images/p1001.jpg"}'),
		('person', 101, '{"nameFull":"Staff Edited","image":"https://example.org/api/edit-images/s101.jpg"}')`)

	cached, err := svc.fetchDetail(ctx, id)
	require.NoError(t, err)
	assert.Same(t, before, cached, "a cached response is served until it is forgotten")

	svc.Forget(id)
	detail, err := svc.fetchDetail(ctx, id)
	require.NoError(t, err)

	check := func(t *testing.T, detail *AnimeDetail) {
		t.Helper()
		byID := map[int32]DetailCharacter{}
		for _, c := range detail.Characters {
			byID[*c.CharacterID] = c
		}
		one := byID[1]
		assert.Equal(t, "芙莉莲（改）", *one.NameCn, "the edit beats Bangumi's name")
		assert.Equal(t, "Frieren", *one.NameEn)
		assert.Equal(t, "https://example.org/api/edit-images/c1.jpg", *one.ImageUrl)
		assert.Equal(t, "SUPPORTING", *one.Role, "roles are the character page's, not this response's")
		assert.Equal(t, int32(1001), *one.VoiceActorID, "so is a voice an edit removed")
		assert.Equal(t, "种崎敦美（改）", *one.VoiceActorCn)
		assert.Equal(t, "種﨑敦美", *one.VoiceActorJa)
		assert.Equal(t, "https://example.org/api/edit-images/p1001.jpg", *one.VoiceActorImageUrl)

		two := byID[2]
		assert.Equal(t, "C2", *two.NameEn, "no edit: the row as it was")
		assert.Nil(t, two.NameCn)

		require.Len(t, detail.Staff, 1)
		assert.Equal(t, "Staff Edited", *detail.Staff[0].NameEn)
		assert.Equal(t, "https://example.org/api/edit-images/s101.jpg", *detail.Staff[0].ImageUrl)

		raw, err := json.Marshal(one)
		require.NoError(t, err)
		var keys map[string]any
		require.NoError(t, json.Unmarshal(raw, &keys))
		assert.ElementsMatch(t, []string{
			"nameEn", "nameJa", "nameCn", "imageUrl", "role",
			"voiceActorEn", "voiceActorJa", "voiceActorCn", "voiceActorImageUrl",
			"characterId", "voiceActorId",
		}, mapKeys(keys), "a character's keys are unchanged")
		raw, err = json.Marshal(detail.Staff[0])
		require.NoError(t, err)
		keys = nil
		require.NoError(t, json.Unmarshal(raw, &keys))
		assert.ElementsMatch(t, []string{"nameEn", "nameJa", "imageUrl", "role", "staffId"}, mapKeys(keys),
			"a staff member's keys are unchanged")
	}
	check(t, detail)

	// AniList refreshes the title: the credit rows are rewritten from the
	// response, entity_overlays is not, and the edits still show.
	require.NoError(t, svc.upsertFromMedia(ctx, id, media))
	svc.Forget(id)
	refreshed, err := svc.fetchDetail(ctx, id)
	require.NoError(t, err)
	check(t, refreshed)
	var overlays int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM entity_overlays`).Scan(&overlays))
	assert.Equal(t, 3, overlays)
	var stored string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT name_en FROM anime_characters WHERE anime_id = 154587 AND character_id = 1`).Scan(&stored))
	assert.Equal(t, "C1", stored, "the edit was never written into the credit row")
}
