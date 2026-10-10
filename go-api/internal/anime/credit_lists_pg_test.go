package anime

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestCreditLists_ReadEverythingTheTablesHold_PG — the three endpoints
// over real tables, written by the same code that writes them in
// production (the detail refresh's credit write), plus the two kinds of
// row that code no longer writes: a character with no AniList id and its
// voice on the row.
//
// What it pins: the lists go past the 25 /api/anime/:id stops at, in
// display_order; voices come from anime_character_voices, Japanese only --
// a Chinese voice in AniList's answer is never stored -- and the row's own
// voice stands in only where the table has none; Bangumi's Chinese names
// arrive through the 0045 maps; and /api/anime/:id's own answer is
// untouched.
func TestCreditLists_ReadEverythingTheTablesHold_PG(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	detail, err := NewDetailService(q, nil)
	require.NoError(t, err)
	t.Cleanup(detail.Close)

	const id = 154587
	m := creditsMedia(id, idRange(1, 30), []int{101, 102, 103}, 1000, false)
	first := &m.Characters.Edges[0]
	first.Role = sptr("MAIN")
	first.Node.Name.Native = sptr("フリーレン")
	first.VoiceActorRoles = append(first.VoiceActorRoles,
		anilist.VoiceActorRole{RoleNotes: sptr("Childhood"), VoiceActor: &anilist.VoiceActor{
			ID: 2001, Name: &anilist.PersonName{Full: sptr("Child Voice"), Native: sptr("子役")}, LanguageV2: sptr("Japanese"),
		}},
		anilist.VoiceActorRole{VoiceActor: &anilist.VoiceActor{
			ID: 2002, Name: &anilist.PersonName{Full: sptr("Zh Voice"), Native: sptr("中配")}, LanguageV2: sptr("Chinese"),
		}},
	)
	m.Characters.Edges[29].Role = sptr("BACKGROUND")
	m.Staff.Edges[0].Role = sptr("Director")
	m.Staff.Edges[1].Role = sptr("Music")
	// The director again, in a second role: one person, two credits.
	m.Staff.Edges[2] = anilist.StaffEdge{Role: sptr("Storyboard (eps 1, 2)"), Node: m.Staff.Edges[0].Node}
	require.NoError(t, detail.upsertFromMedia(ctx, id, m))

	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err, sql)
	}
	// A row from before 0037: no ids, and its only voice on the row.
	exec(`INSERT INTO anime_characters (anime_id, display_order, name_en, name_ja, role, voice_actor_en, voice_actor_ja, voice_actor_cn)
		VALUES (154587, 30, 'Legacy', '古い', 'SUPPORTING', 'Old Voice', '古い声', '旧声')`)
	exec(`INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (1, 86246, '芙莉莲', 'dump', now())`)
	exec(`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES
		(1001, 7575, '种崎敦美', 'dump', now()),
		(101, 9001, '斋藤圭一郎', 'dump', now())`)

	svc, err := NewCreditListsService(q)
	require.NoError(t, err)
	t.Cleanup(svc.Close)
	h := creditListsRouter(t, svc)

	t.Run("characters: everything, in order, Japanese voices", func(t *testing.T) {
		body := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?limit=100"))
		require.Len(t, body.Data, 31)
		assert.Equal(t, 31, body.Total)
		for i := 0; i < 30; i++ {
			require.NotNil(t, body.Data[i].CharacterID)
			assert.Equal(t, int32(i+1), *body.Data[i].CharacterID, "display_order %d", i)
		}
		assert.Nil(t, body.Data[30].CharacterID)

		frieren := body.Data[0]
		assert.Equal(t, "芙莉莲", *frieren.NameCn)
		require.Len(t, frieren.Voices, 2, "the main Japanese voice, then the childhood one")
		assert.Equal(t, int32(1001), *frieren.Voices[0].StaffID)
		assert.Equal(t, "种崎敦美", *frieren.Voices[0].NameCn)
		assert.Nil(t, frieren.Voices[0].RoleNotes)
		assert.Equal(t, int32(2001), *frieren.Voices[1].StaffID)
		assert.Equal(t, "Childhood", *frieren.Voices[1].RoleNotes)

		legacy := body.Data[30]
		require.Len(t, legacy.Voices, 1, "the row's voice stands in")
		assert.Nil(t, legacy.Voices[0].StaffID)
		assert.Equal(t, "Old Voice", *legacy.Voices[0].NameFull)
		assert.Equal(t, "旧声", *legacy.Voices[0].NameCn)

		assert.Equal(t, castRoleCounts{All: 31, Main: 1, Supporting: 29, Background: 1}, body.Counts.Roles)
		assert.Equal(t, []castLangCount{{Language: "ja", Count: 31}}, body.Counts.Languages)
		assert.Equal(t, "ja", body.Language)
	})

	t.Run("characters: the Chinese voice AniList sent is not stored; lang=zh answers as ja; a search", func(t *testing.T) {
		var stored int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT count(*) FROM anime_character_voices WHERE anime_id = 154587 AND lower(language) <> 'japanese'`).Scan(&stored))
		assert.Zero(t, stored, "the write keeps Japanese voices only")

		ja := getCredits(t, h, "/api/anime/154587/characters?lang=ja&limit=2")
		zh := getCredits(t, h, "/api/anime/154587/characters?lang=zh&limit=2")
		require.Equal(t, http.StatusOK, zh.Code, zh.Body.String())
		assert.Equal(t, ja.Body.String(), zh.Body.String(), "an old 中配 link is answered with the Japanese cast")
		body := decodeCharacters(t, zh)
		assert.Equal(t, "ja", body.Language)
		require.Len(t, body.Data[0].Voices, 2)
		assert.Equal(t, int32(1001), *body.Data[0].Voices[0].StaffID)
		assert.Equal(t, 31, body.Total)

		found := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?q=%E7%A7%8D%E5%B4%8E")) // 种崎
		require.Equal(t, 1, found.Total)
		assert.Equal(t, int32(1), *found.Data[0].CharacterID, "Bangumi's name for the voice is searchable")
	})

	t.Run("staff: every credit, and people", func(t *testing.T) {
		rec := getCredits(t, h, "/api/anime/154587/staff")
		require.Equal(t, http.StatusOK, rec.Code)
		var body staffResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body.Data, 3)
		assert.Equal(t, 3, body.Total)
		assert.Equal(t, 2, body.People)
		assert.Equal(t, "Director", *body.Data[0].Role)
		assert.Equal(t, "斋藤圭一郎", *body.Data[0].NameCn)
		assert.Equal(t, "Music", *body.Data[1].Role)
		assert.Equal(t, "Storyboard (eps 1, 2)", *body.Data[2].Role)
	})

	t.Run("credit counts agree with the lists", func(t *testing.T) {
		// Counted in SQL, listed in Go: the two must name the same numbers,
		// legacy row and twice-credited director included.
		rec := getCredits(t, h, "/api/anime/154587/credit-counts")
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, `{"data":{"characters":31,"staff":2}}`, rec.Body.String())

		// A pre-0037 staff row has no id: it is one person per name, as the
		// staff list counts it.
		exec(`INSERT INTO anime_staff (anime_id, display_order, name_en, name_ja, role) VALUES
			(154587, 10, 'No Id', '無番号', 'Key Animation'),
			(154587, 11, 'No Id', '無番号', 'In-Between Animation')`)
		svc2, err := NewCreditListsService(q)
		require.NoError(t, err)
		t.Cleanup(svc2.Close)
		h2 := creditListsRouter(t, svc2)
		assert.Equal(t, `{"data":{"characters":31,"staff":3}}`, getCredits(t, h2, "/api/anime/154587/credit-counts").Body.String())
		var staff staffResponse
		require.NoError(t, json.Unmarshal(getCredits(t, h2, "/api/anime/154587/staff").Body.Bytes(), &staff))
		assert.Equal(t, 3, staff.People)
		assert.Equal(t, 5, staff.Total)
	})

	t.Run("a title only a listing wrote is answered, never kept", func(t *testing.T) {
		// seasonal / search / warm_season write the main row and nothing
		// else; detail_fetched_at stays NULL until /api/anime/:id fills the
		// credit tables.  Its empty lists are "not yet".
		exec(`INSERT INTO anime_cache (anilist_id, title_romaji) VALUES (154588, 'Listing Only')`)
		for _, path := range []string{"characters", "staff", "credit-counts"} {
			rec := getCredits(t, h, "/api/anime/154588/"+path)
			require.Equal(t, http.StatusOK, rec.Code, path)
			assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"), path)
		}
		assert.Equal(t, `{"data":{"characters":0,"staff":0}}`, getCredits(t, h, "/api/anime/154588/credit-counts").Body.String())

		// The fetched title still carries the public policy.
		assert.Equal(t, creditListsCacheControl, getCredits(t, h, "/api/anime/154587/characters").Header().Get("Cache-Control"))
	})

	t.Run("an id the catalogue does not hold is a 404", func(t *testing.T) {
		for _, path := range []string{"characters", "staff", "credit-counts"} {
			assert.Equal(t, http.StatusNotFound, getCredits(t, h, "/api/anime/999999/"+path).Code, path)
		}
	})

	t.Run("/api/anime/:id still answers 25", func(t *testing.T) {
		got, err := detail.fetchDetail(ctx, id)
		require.NoError(t, err)
		assert.Len(t, got.Characters, 25)
		assert.Equal(t, "芙莉莲", *got.Characters[0].NameCn)
	})
}

// TestCreditLists_AcceptedEditsApply_PG — a reader's accepted edit
// (entity_overlays, 0047) shows on the 角色 and 制作 tabs as it does on
// /api/anime/:id: the names and the image of a character, of the people
// voicing it and of a staff member, ahead of Bangumi's names and the rows'.
// Roles and voice changes stay the character page's, as on /api/anime/:id.
// The lists are cached, so a review that accepts an edit has the titles
// forgotten (Forget), as it has the detail forgotten.
func TestCreditLists_AcceptedEditsApply_PG(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	detail, err := NewDetailService(q, nil)
	require.NoError(t, err)
	t.Cleanup(detail.Close)

	const id = 154587
	m := creditsMedia(id, idRange(1, 3), []int{101, 102}, 1000, false)
	m.Characters.Edges[0].Role = sptr("MAIN")
	require.NoError(t, detail.upsertFromMedia(ctx, id, m))
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err, sql)
	}
	exec(`INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (1, 86246, '芙莉莲', 'dump', now())`)
	exec(`INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES
		(1001, 7575, '种崎敦美', 'dump', now()),
		(101, 9001, '斋藤圭一郎', 'dump', now())`)

	svc, err := NewCreditListsService(q)
	require.NoError(t, err)
	t.Cleanup(svc.Close)
	h := creditListsRouter(t, svc)
	characters := func() charactersResponse {
		t.Helper()
		return decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?limit=100"))
	}
	staff := func() staffResponse {
		t.Helper()
		rec := getCredits(t, h, "/api/anime/154587/staff")
		require.Equal(t, http.StatusOK, rec.Code)
		var body staffResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return body
	}

	// Read before any edit: from here both lists are in memory.
	require.Equal(t, "芙莉莲", *characters().Data[0].NameCn)
	require.Equal(t, "斋藤圭一郎", *staff().Data[0].NameCn)

	exec(`INSERT INTO entity_overlays (kind, entity_id, data) VALUES
		('character', 1, '{"nameCn":"芙莉莲（修）","nameNative":"フリーレン","nameFull":"Frieren","image":"https://example.org/frieren.jpg","role":{"154587":"SUPPORTING"}}'),
		('person', 1001, '{"nameCn":"种崎敦美（修）","image":"https://example.org/tanezaki.jpg"}'),
		('person', 101, '{"nameCn":"斋藤圭一郎（修）","nameNative":"斎藤圭一郎","image":"https://example.org/saito.jpg"}')`)

	t.Run("served from memory until the title is forgotten", func(t *testing.T) {
		assert.Equal(t, "芙莉莲", *characters().Data[0].NameCn)
		assert.Equal(t, "斋藤圭一郎", *staff().Data[0].NameCn)
		svc.Forget(id)
	})

	t.Run("characters: the character's edit and its voice's", func(t *testing.T) {
		body := characters()
		c := body.Data[0]
		assert.Equal(t, "芙莉莲（修）", *c.NameCn)
		assert.Equal(t, "フリーレン", *c.NameJa)
		assert.Equal(t, "Frieren", *c.NameEn)
		assert.Equal(t, "https://example.org/frieren.jpg", *c.ImageUrl)
		assert.Equal(t, "MAIN", *c.Role, "a role edit is the character page's, as on /api/anime/:id")
		require.NotEmpty(t, c.Voices)
		assert.Equal(t, int32(1001), *c.Voices[0].StaffID)
		assert.Equal(t, "种崎敦美（修）", *c.Voices[0].NameCn)
		assert.Equal(t, "https://example.org/tanezaki.jpg", *c.Voices[0].ImageUrl)
		assert.Equal(t, "C2", *body.Data[1].NameEn, "a character with no edit keeps its own")

		found := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?q=%E4%BF%AE")) // 修
		require.Equal(t, 1, found.Total, "the edited names are the ones searched")
		assert.Equal(t, int32(1), *found.Data[0].CharacterID)
	})

	t.Run("staff: the person's edit", func(t *testing.T) {
		s := staff().Data[0]
		assert.Equal(t, int32(101), *s.StaffID)
		assert.Equal(t, "斋藤圭一郎（修）", *s.NameCn)
		assert.Equal(t, "斎藤圭一郎", *s.NameJa)
		assert.Equal(t, "https://example.org/saito.jpg", *s.ImageUrl)
	})
}
