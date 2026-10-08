package people

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// The fixture: titles, credits, profiles and Bangumi matches, written the way
// the credit writers, the profiles sweep and cmd/bgmnames write them.
//
//	1001  TV  2023-09-29  popularity 480000          the big one
//	1002  TV  2026-01-16  popularity 150000          its sequel
//	1003  TV  2023-04-01  popularity 300000
//	1004  TV  2024        popularity 900000  ADULT   must never show
//	1005  TV  (no date)   popularity 5000            announced
//	1006..1010  ONA 2020..2024                         for the staff threshold
const pagesFixture = `
INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese, start_date, season_year, popularity, is_adult, format, cover_image_url, poster_accent) VALUES
  (1001, 'Big Show', '大番', '2023-09-29', 2023, 480000, false, 'TV', 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/1001.jpg', '#7caf62'),
  (1002, 'Big Show 2', '大番 第二季', '2026-01-16', 2026, 150000, false, 'TV', NULL, NULL),
  (1003, 'Other Show', '别的番', '2023-04-01', 2023, 300000, false, 'TV', NULL, NULL),
  (1004, 'Adult Show', '成人番', NULL, 2024, 900000, true, 'TV', NULL, NULL),
  (1005, 'Announced', NULL, NULL, NULL, 5000, false, 'TV', NULL, NULL),
  (1006, 'Short 1', NULL, '2020-01-01', 2020, 10, false, 'ONA', NULL, NULL),
  (1007, 'Short 2', NULL, '2021-01-01', 2021, 10, false, 'ONA', NULL, NULL),
  (1008, 'Short 3', NULL, '2022-01-01', 2022, 10, false, 'ONA', NULL, NULL),
  (1009, 'Short 4', NULL, '2023-01-01', 2023, 10, false, 'ONA', NULL, NULL),
  (1010, 'Short 5', NULL, '2024-01-01', 2024, 10, false, 'ONA', NULL, NULL);

-- Characters.  101 leads 1001, 1002 and the adult 1004; 102 leads 1003;
-- 103 supports 1005; 104 is on 1003 with its voice only on
-- anime_characters (a title written before 0042); 105 is only on the adult
-- title.
INSERT INTO anime_characters (anime_id, display_order, name_en, name_ja, image_url, role, voice_actor_en, voice_actor_ja, voice_actor_image_url, character_id, voice_actor_id) VALUES
  (1001, 0, 'Lead', 'リード', 'https://s4.anilist.co/file/anilistcdn/character/medium/b101.png', 'MAIN', 'Voice One', 'ボイス一', 'https://s4.anilist.co/file/anilistcdn/staff/medium/n201.png', 101, 201),
  (1002, 0, 'Lead', 'リード', 'https://s4.anilist.co/file/anilistcdn/character/medium/b101.png', 'MAIN', 'Voice One', 'ボイス一', NULL, 101, 201),
  (1004, 0, 'Lead', 'リード', NULL, 'MAIN', 'Voice One', 'ボイス一', NULL, 101, 201),
  (1003, 0, 'Second', 'セカンド', NULL, 'MAIN', 'Voice One', 'ボイス一', NULL, 102, 201),
  (1003, 1, 'Old Row', 'オールド', NULL, 'SUPPORTING', 'Old Voice', '旧声', 'https://s4.anilist.co/file/anilistcdn/staff/medium/n204.png', 104, 204),
  (1005, 0, 'Newcomer', 'ニュー', NULL, 'SUPPORTING', 'Voice One', 'ボイス一', NULL, 103, 201),
  (1004, 1, 'Adult Only', 'アダルト', NULL, 'MAIN', 'Adult Voice', '成人声', NULL, 105, 203);

INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, language, role_notes, name_full, name_native, image_url) VALUES
  (1001, 101, 201, 0, 'Japanese', NULL, 'Voice One', 'ボイス一', 'https://s4.anilist.co/file/anilistcdn/staff/medium/n201.png'),
  (1001, 101, 206, 1, 'Japanese', 'Childhood', 'Child Voice', '子声', NULL),
  (1001, 101, 207, 2, 'Korean', NULL, 'Korean Voice', '한국', NULL),
  (1002, 101, 201, 0, 'Japanese', NULL, 'Voice One', 'ボイス一', NULL),
  (1004, 101, 201, 0, 'Japanese', NULL, 'Voice One', 'ボイス一', NULL),
  (1003, 102, 201, 0, 'Japanese', NULL, 'Voice One', 'ボイス一', NULL),
  (1005, 103, 201, 0, 'Japanese', NULL, 'Voice One', 'ボイス一', NULL),
  (1004, 105, 203, 0, 'Japanese', NULL, 'Adult Voice', '成人声', NULL);

-- Staff.  201 also performs a theme song; 205 directs; 208 is credited on
-- five shorts (the staff threshold) and on the adult title.
INSERT INTO anime_staff (anime_id, display_order, name_en, name_ja, image_url, role, staff_id) VALUES
  (1003, 9, 'Voice One', 'ボイス一', NULL, 'Theme Song Performance (OP)', 201),
  (1001, 0, 'Director Person', '監督', 'https://s4.anilist.co/file/anilistcdn/staff/medium/n205.jpg', 'Director', 205),
  (1001, 3, 'Director Person', '監督', NULL, 'Storyboard (eps 1, 5)', 205),
  (1002, 0, 'Director Person', '監督', NULL, 'Director', 205),
  (1004, 0, 'Director Person', '監督', NULL, 'Director', 205),
  (1006, 0, 'Busy Animator', '原画', NULL, 'Key Animation', 208),
  (1007, 0, 'Busy Animator', '原画', NULL, 'Key Animation', 208),
  (1008, 0, 'Busy Animator', '原画', NULL, 'Key Animation', 208),
  (1009, 0, 'Busy Animator', '原画', NULL, 'Key Animation', 208),
  (1010, 0, 'Busy Animator', '原画', NULL, 'Key Animation', 208);

-- Profiles.  201 has one; 202 and 205 were only stamped (the sweep asked
-- and has no answer yet), which is no profile.
INSERT INTO people (anilist_id, name_full, name_native, name_alternative, language, image_large, primary_occupations, gender, birth_year, birth_month, birth_day, home_town, fetched_at, checked_at) VALUES
  (201, 'Profile One', 'プロフィール一', '{"Alias One","Profile One"}', 'Japanese', 'https://s4.anilist.co/file/anilistcdn/staff/large/n201-profile.png', '{"Voice Actor"}', 'Female', 1990, 9, 27, 'Oita, Japan', now(), now());
INSERT INTO people (anilist_id, checked_at) VALUES (205, now());

INSERT INTO characters (anilist_id, name_full, name_native, name_alternative, name_alternative_spoiler, image_large, description, gender, age, fetched_at, checked_at) VALUES
  (101, 'Lead Profile', 'リード', '{"The Lead"}', '{"Secret Identity"}', 'https://s4.anilist.co/file/anilistcdn/character/large/b101-profile.png', 'A lead. ~!Dies later.!~', 'Female', '1000+', now(), now());
INSERT INTO characters (anilist_id, checked_at) VALUES (102, now());

INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (201, 7575, '声优一', 'dump', now());
INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES
  (101, 86246, '主角', 'dump', now()),
  (103, 86247, '新人', 'dump', now());
`

func seedPages(t *testing.T) (*pgxpool.Pool, http.Handler) {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	_, err := pool.Exec(ctx, pagesFixture)
	require.NoError(t, err)

	q := dbgen.New(pool)
	r := chi.NewRouter()
	r.Route("/api/people", func(r chi.Router) { MountPeople(r, q, NewSitemapCache(SitemapTTL)) })
	r.Route("/api/characters", func(r chi.Router) { MountCharacters(r, q, NewSitemapCache(SitemapTTL)) })
	return pool, r
}

func fetchJSON[T any](t *testing.T, h http.Handler, path string) (int, T) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var env struct {
		Data T `json:"data"`
	}
	if rec.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), rec.Body.String())
	}
	return rec.Code, env.Data
}

// voiceTimeline flattens a person's voice years to "year:anime/character".
func voiceTimeline(years []VoiceYear) []string {
	var out []string
	for _, y := range years {
		label := "nil"
		if y.Year != nil {
			label = itoa(*y.Year)
		}
		for _, r := range y.Roles {
			out = append(out, label+":"+itoa(r.Anime.AnilistID)+"/"+itoa(r.Character.AnilistID))
		}
	}
	return out
}

func TestPages_PG(t *testing.T) {
	_, h := seedPages(t)

	t.Run("a voice actor with a profile and a Chinese name", func(t *testing.T) {
		code, p := fetchJSON[Person](t, h, "/api/people/201")
		require.Equal(t, http.StatusOK, code)

		assert.Equal(t, "Profile One", *p.Name.Full, "the profile beats the credit")
		assert.Equal(t, "プロフィール一", *p.Name.Native)
		assert.Equal(t, "声优一", *p.Name.Cn)
		assert.Equal(t, int32(7575), *p.BangumiID)
		raw, err := json.Marshal(p)
		require.NoError(t, err)
		assert.NotContains(t, string(raw), "Alias One", "a person's alternative names are not answered")
		assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n201-profile.png", *p.Image)
		require.NotNil(t, p.Profile)
		assert.Equal(t, []string{"Voice Actor"}, p.Profile.Occupations)
		assert.Equal(t, int32(27), *p.Profile.Birth.Day)
		assert.Equal(t, "Oita, Japan", *p.Profile.HomeTown)

		// The adult title (1004) is nowhere; the voice on 1001 is listed once
		// although both tables hold it.
		assert.Equal(t, []string{
			"nil:1005/103",
			"2026:1002/101",
			"2023:1001/101",
			"2023:1003/102",
		}, voiceTimeline(p.VoiceRoles))
		assert.Equal(t, 4, p.VoiceWorkCount)
		assert.True(t, p.Indexable)

		// Leads first, most popular title first, a character once (101 leads
		// three titles and is one card); a supporting role fills the third.
		require.Len(t, p.RepresentativeRoles, 3)
		assert.Equal(t, int32(101), p.RepresentativeRoles[0].Character.AnilistID)
		assert.Equal(t, int32(1001), p.RepresentativeRoles[0].Anime.AnilistID)
		assert.Equal(t, int32(102), p.RepresentativeRoles[1].Character.AnilistID)
		assert.Equal(t, int32(103), p.RepresentativeRoles[2].Character.AnilistID)

		require.Len(t, p.StaffRoles, 1)
		assert.Equal(t, []string{"Theme Song Performance (OP)"}, p.StaffRoles[0].Works[0].Roles)
		assert.Equal(t, 1, p.StaffWorkCount)

		// The work carries what the card shows.
		big := p.VoiceRoles[2].Roles[0].Anime
		assert.Equal(t, "大番", *big.TitleChinese)
		assert.Equal(t, int32(2023), *big.Year)
		assert.Equal(t, "TV", *big.Format)
		assert.Equal(t, "#7caf62", *big.PosterAccent)
		lead := p.VoiceRoles[2].Roles[0].Character
		assert.Equal(t, "主角", *lead.Name.Cn)
		assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/character/large/b101-profile.png", *lead.Image,
			"the character's profile image")
	})

	t.Run("a stamped-only profile row is no profile", func(t *testing.T) {
		code, p := fetchJSON[Person](t, h, "/api/people/205")
		require.Equal(t, http.StatusOK, code)
		assert.Nil(t, p.Profile, "fetched_at is NULL: the sweep asked and AniList has not answered")
		assert.Equal(t, "Director Person", *p.Name.Full, "the credit names the person")
		assert.Equal(t, "監督", *p.Name.Native)
		assert.Nil(t, p.Name.Cn)
		assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n205.jpg", *p.Image)

		// One card per title, roles in credit order, the adult title gone.
		require.Len(t, p.StaffRoles, 2)
		assert.Equal(t, int32(2026), *p.StaffRoles[0].Year)
		assert.Equal(t, []string{"Director"}, p.StaffRoles[0].Works[0].Roles)
		assert.Equal(t, int32(2023), *p.StaffRoles[1].Year)
		assert.Equal(t, []string{"Director", "Storyboard (eps 1, 5)"}, p.StaffRoles[1].Works[0].Roles)
		assert.Equal(t, 2, p.StaffWorkCount)
		assert.Empty(t, p.VoiceRoles)
		assert.False(t, p.Indexable)
	})

	t.Run("a voice written before 0042 is read from anime_characters, as Japanese", func(t *testing.T) {
		code, p := fetchJSON[Person](t, h, "/api/people/204")
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, []string{"2023:1003/104"}, voiceTimeline(p.VoiceRoles))
		assert.Equal(t, "Japanese", *p.VoiceRoles[0].Roles[0].Language)
		assert.Equal(t, "Old Voice", *p.Name.Full)
		assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n204.png", *p.Image)

		code, c := fetchJSON[Character](t, h, "/api/characters/104")
		require.Equal(t, http.StatusOK, code)
		require.Len(t, c.Voices, 1)
		assert.Equal(t, int32(204), c.Voices[0].Person.AnilistID)
		assert.Equal(t, "Japanese", *c.Voices[0].Language)
	})

	t.Run("unknown and adult-only ids are 404", func(t *testing.T) {
		for _, path := range []string{
			"/api/people/999999",
			"/api/people/203", // credited only on the adult title
			"/api/characters/999999",
			"/api/characters/105", // listed only on the adult title
		} {
			code, _ := fetchJSON[map[string]any](t, h, path)
			assert.Equal(t, http.StatusNotFound, code, path)
		}
	})

	t.Run("a character: profile, voices across languages, titles in order", func(t *testing.T) {
		code, c := fetchJSON[Character](t, h, "/api/characters/101")
		require.Equal(t, http.StatusOK, code)

		assert.Equal(t, "Lead Profile", *c.Name.Full)
		assert.Equal(t, "主角", *c.Name.Cn)
		assert.Equal(t, []string{"The Lead"}, c.AlternativeNames, "spoiler aliases are not read at all")
		require.NotNil(t, c.Profile)
		assert.Equal(t, "A lead. ~!Dies later.!~", *c.Profile.Description)
		assert.Equal(t, "1000+", *c.Profile.Age)

		var voices []string
		for _, v := range c.Voices {
			note := ""
			if v.RoleNotes != nil {
				note = "/" + *v.RoleNotes
			}
			voices = append(voices, *v.Language+":"+itoa(v.Person.AnilistID)+note)
		}
		assert.Equal(t, []string{"Japanese:201", "Japanese:206/Childhood", "Korean:207"}, voices)
		assert.Equal(t, "声优一", *c.Voices[0].Person.Name.Cn)
		assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/staff/large/n201-profile.png", *c.Voices[0].Person.Image)

		require.Len(t, c.Appearances, 2, "the adult title is not listed")
		assert.Equal(t, int32(1001), c.Appearances[0].Anime.AnilistID)
		assert.Equal(t, int32(1002), c.Appearances[1].Anime.AnilistID)
		assert.True(t, c.Indexable)
	})

	t.Run("a character with a stamped-only profile row", func(t *testing.T) {
		code, c := fetchJSON[Character](t, h, "/api/characters/102")
		require.Equal(t, http.StatusOK, code)
		assert.Nil(t, c.Profile)
		assert.Equal(t, "Second", *c.Name.Full)
		assert.Equal(t, "セカンド", *c.Name.Native)
		assert.False(t, c.Indexable, "a lead, but no Chinese name")
	})

	t.Run("the sitemaps list exactly the pages that ask to be indexed", func(t *testing.T) {
		listed := func(path string) map[int32]bool {
			out := map[int32]bool{}
			for shard := 0; shard < 2; shard++ {
				code, rows := fetchJSON[[]SitemapEntry](t, h, path+"?shards=2&shard="+itoa(int32(shard)))
				require.Equal(t, http.StatusOK, code)
				for _, r := range rows {
					assert.False(t, r.UpdatedAt.IsZero(), "every row has a lastmod")
					out[r.AnilistID] = true
				}
			}
			return out
		}

		people := listed("/api/people/sitemap")
		assert.Equal(t, map[int32]bool{201: true, 208: true}, people,
			"201 voices four titles, 208 is staff on five; the adult title counts for no one")
		for _, id := range []int32{201, 202, 204, 205, 206, 207, 208} {
			code, p := fetchJSON[Person](t, h, "/api/people/"+itoa(id))
			if code != http.StatusOK {
				assert.False(t, people[id], "%d has no page and is not listed", id)
				continue
			}
			assert.Equal(t, people[id], p.Indexable, "person %d: sitemap and page agree", id)
		}

		characters := listed("/api/characters/sitemap")
		assert.Equal(t, map[int32]bool{101: true}, characters,
			"102 leads without a Chinese name; 103 has one but only supports")
		for _, id := range []int32{101, 102, 103, 104} {
			code, c := fetchJSON[Character](t, h, "/api/characters/"+itoa(id))
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, characters[id], c.Indexable, "character %d: sitemap and page agree", id)
		}
	})
}
