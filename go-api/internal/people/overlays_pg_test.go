package people

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestOverlays_PG: accepted edits (entity_overlays) on the whole read path,
// over pagesFixture -- the character page, the person page, the people an
// edit names, and the two sitemap listings, which must keep agreeing with
// each page's own `indexable`.
func TestOverlays_PG(t *testing.T) {
	pool, h := seedPages(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
INSERT INTO entity_overlays (kind, entity_id, data) VALUES
  -- 101 leads 1001 and 1002: both roles edited away, and a new name, an
  -- image and voices: 206's childhood row given to 205 (credited only as
  -- staff), the Korean row removed, 208 added as the Chinese voice.
  ('character', 101, '{
     "nameCn": "主角（改）",
     "image": "https://example.org/api/edit-images/c101.jpg",
     "roles": {"1001": "BACKGROUND", "1002": "SUPPORTING"},
     "voices": [
       {"key": "206|Japanese|Childhood", "personId": 205, "line": "日配 · 少年"},
       {"key": "207|Korean|", "remove": true},
       {"key": "add:208", "personId": 208, "line": "中配"}
     ]}'),
  -- 102 leads 1003 with no Chinese name: an edit gives it one.
  ('character', 102, '{"nameCn": "第二"}'),
  -- 201 voices 101: a Chinese name and a portrait.
  ('person', 201, '{"nameCn": "声优一（改）", "image": "https://example.org/api/edit-images/p201.jpg",
                    "homeTown": "大分县", "occupations": ["Voice Actor", "Singer"]}')
`)
	require.NoError(t, err)

	t.Run("the character page", func(t *testing.T) {
		code, c := fetchJSON[Character](t, h, "/api/characters/101")
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "主角（改）", *c.Name.Cn, "the edit beats Bangumi's 主角")
		assert.Equal(t, "Lead Profile", *c.Name.Full)
		assert.Equal(t, "https://example.org/api/edit-images/c101.jpg", *c.Image)
		require.Len(t, c.Appearances, 2)
		assert.Equal(t, "BACKGROUND", *c.Appearances[0].Role)
		assert.Equal(t, "SUPPORTING", *c.Appearances[1].Role)
		assert.False(t, c.Indexable, "no longer a lead anywhere")

		var got []string
		for _, v := range c.Voices {
			line := ""
			if v.Line != nil {
				line = " " + *v.Line
			}
			got = append(got, v.Key+">"+itoa(v.Person.AnilistID)+line)
		}
		assert.Equal(t, []string{
			"201|Japanese|>201",
			"206|Japanese|Childhood>205 日配 · 少年",
			"add:208>208 中配",
		}, got)
		assert.Equal(t, "声优一（改）", *c.Voices[0].Person.Name.Cn, "the voice's own edit")
		assert.Equal(t, "https://example.org/api/edit-images/p201.jpg", *c.Voices[0].Person.Image)
		assert.Equal(t, "Director Person", *c.Voices[1].Person.Name.Full, "a person found through their staff credit")
		assert.Equal(t, "Busy Animator", *c.Voices[2].Person.Name.Full)

		code, c = fetchJSON[Character](t, h, "/api/characters/102")
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "第二", *c.Name.Cn)
		assert.True(t, c.Indexable, "a lead with a Chinese name now")
	})

	t.Run("the person page", func(t *testing.T) {
		code, p := fetchJSON[Person](t, h, "/api/people/201")
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "声优一（改）", *p.Name.Cn)
		assert.Equal(t, "https://example.org/api/edit-images/p201.jpg", *p.Image)
		assert.Equal(t, "大分县", *p.Profile.HomeTown)
		assert.Equal(t, []string{"Voice Actor", "Singer"}, p.Profile.Occupations)
		assert.Equal(t, 4, p.VoiceWorkCount, "edits change no count")
		for _, y := range p.VoiceRoles {
			for _, r := range y.Roles {
				if r.Character.AnilistID != 101 {
					continue
				}
				assert.Equal(t, "主角（改）", *r.Character.Name.Cn, "%d", r.Anime.AnilistID)
				assert.Equal(t, "https://example.org/api/edit-images/c101.jpg", *r.Character.Image)
			}
		}
	})

	t.Run("the sitemaps still list exactly the pages that ask to be indexed", func(t *testing.T) {
		listed := func(path string) map[int32]bool {
			out := map[int32]bool{}
			for shard := 0; shard < 2; shard++ {
				code, rows := fetchJSON[[]SitemapEntry](t, h, path+"?shards=2&shard="+itoa(int32(shard)))
				require.Equal(t, http.StatusOK, code)
				for _, r := range rows {
					out[r.AnilistID] = true
				}
			}
			return out
		}
		characters := listed("/api/characters/sitemap")
		assert.Equal(t, map[int32]bool{102: true}, characters, "101 lost its leads, 102 gained a Chinese name")
		for _, id := range []int32{101, 102, 103, 104} {
			code, c := fetchJSON[Character](t, h, "/api/characters/"+itoa(id))
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, characters[id], c.Indexable, "character %d", id)
		}
		people := listed("/api/people/sitemap")
		assert.Equal(t, map[int32]bool{201: true, 208: true}, people)
	})

	t.Run("an id with only an overlay is still a 404", func(t *testing.T) {
		_, err := pool.Exec(ctx, `INSERT INTO entity_overlays (kind, entity_id, data) VALUES
			('character', 999999, '{"nameCn":"无"}'), ('person', 999999, '{"nameCn":"无"}')`)
		require.NoError(t, err)
		code, _ := fetchJSON[map[string]any](t, h, "/api/characters/999999")
		assert.Equal(t, http.StatusNotFound, code)
		code, _ = fetchJSON[map[string]any](t, h, "/api/people/999999")
		assert.Equal(t, http.StatusNotFound, code)
	})
}
