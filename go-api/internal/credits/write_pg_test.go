package credits

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// seedTitle inserts the anime_cache row the credit tables hang off.
func seedTitle(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int32) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO anime_cache (anilist_id, title_romaji) VALUES ($1, 'title')`, id)
	require.NoError(t, err)
}

// castOf builds a cast from character ids, each voiced by one Japanese
// actor whose id is 1000+character id (or voiceBase+character id).
func castOf(ids []int, voiceBase int) Cast {
	edges := make([]anilist.CharacterEdge, 0, len(ids))
	for _, id := range ids {
		edges = append(edges, character(id, fmt.Sprintf("C%d", id),
			voice(voiceBase+id, fmt.Sprintf("V%d", voiceBase+id), "Japanese", "")))
	}
	return CastFromEdges(edges, sptr("JP"))
}

func seq(from, to int) []int {
	out := make([]int, 0, to-from+1)
	for i := from; i <= to; i++ {
		out = append(out, i)
	}
	return out
}

// storedCharacters returns (character_id, display_order) for a title in
// display order; a NULL id reads as 0.
func storedCharacters(t *testing.T, ctx context.Context, pool *pgxpool.Pool, animeID int32) (ids []int, orders []int) {
	t.Helper()
	rows, err := pool.Query(ctx,
		`SELECT COALESCE(character_id, 0), display_order FROM anime_characters WHERE anime_id = $1 ORDER BY display_order, id`, animeID)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var id, order int
		require.NoError(t, rows.Scan(&id, &order))
		ids = append(ids, id)
		orders = append(orders, order)
	}
	require.NoError(t, rows.Err())
	return ids, orders
}

// storedVoices returns character_id -> staff ids in voice order.
func storedVoices(t *testing.T, ctx context.Context, pool *pgxpool.Pool, animeID int32) map[int][]int {
	t.Helper()
	rows, err := pool.Query(ctx,
		`SELECT character_id, staff_id FROM anime_character_voices WHERE anime_id = $1 ORDER BY character_id, display_order`, animeID)
	require.NoError(t, err)
	defer rows.Close()
	out := map[int][]int{}
	for rows.Next() {
		var c, s int
		require.NoError(t, rows.Scan(&c, &s))
		out[c] = append(out[c], s)
	}
	require.NoError(t, rows.Err())
	return out
}

// TestWriteCast_PG covers the two modes on a real Postgres: the upsert
// keys, what each mode prunes, the renumbering, and the voice rows.
func TestWriteCast_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	// The core property of this change.  The sweep stored a title's whole
	// cast; a day later the detail refresh reads page 1 again, and AniList's
	// order has moved: 2 and 1 swapped, 25 slipped to page 2 and a new
	// character 99 took its place.  The refresh must update page 1, keep
	// every row beyond it, and leave the first 25 by display_order equal to
	// AniList's page 1 -- the old delete + insert would have left 25 rows.
	t.Run("a first-page refresh keeps every row the sweep wrote", func(t *testing.T) {
		const anime = 1
		seedTitle(t, ctx, pool, anime)
		require.NoError(t, WriteCast(ctx, q, anime, castOf(seq(1, 30), 1000), WholeList))

		page1 := append([]int{2, 1}, seq(3, 24)...)
		page1 = append(page1, 99)
		require.NoError(t, WriteCast(ctx, q, anime, castOf(page1, 5000), FirstPage))

		ids, orders := storedCharacters(t, ctx, pool, anime)
		want := append(append([]int{}, page1...), seq(25, 30)...)
		assert.Equal(t, want, ids, "page 1 in AniList's new order, then the sweep's rows in their old order")
		assert.Equal(t, seq(0, 30), orders, "display_order is 0..n-1 with no ties")

		read, err := q.GetAnimeCharactersByID(ctx, anime)
		require.NoError(t, err)
		require.Len(t, read, 25, "/api/anime/:id still returns AniList's first page and nothing more")
		for i, r := range read {
			assert.Equal(t, int32(page1[i]), *r.CharacterID)
		}

		voices := storedVoices(t, ctx, pool, anime)
		assert.Equal(t, []int{5001}, voices[1], "page-1 voices are replaced by the refresh's")
		assert.Equal(t, []int{5099}, voices[99])
		assert.Equal(t, []int{1025}, voices[25], "a character beyond page 1 keeps the sweep's voices")
		assert.Equal(t, []int{1030}, voices[30])
	})

	t.Run("a whole-list write removes every row it did not write, and their voices", func(t *testing.T) {
		const anime = 2
		seedTitle(t, ctx, pool, anime)
		require.NoError(t, WriteCast(ctx, q, anime, castOf(seq(1, 30), 1000), WholeList))
		// A row from before 0037, with no id.
		_, err := pool.Exec(ctx, `INSERT INTO anime_characters (anime_id, display_order, name_en) VALUES ($1, 3, 'legacy')`, anime)
		require.NoError(t, err)

		require.NoError(t, WriteCast(ctx, q, anime, castOf([]int{7, 3, 40}, 2000), WholeList))

		ids, orders := storedCharacters(t, ctx, pool, anime)
		assert.Equal(t, []int{7, 3, 40}, ids)
		assert.Equal(t, []int{0, 1, 2}, orders)
		assert.Equal(t, map[int][]int{3: {2003}, 7: {2007}, 40: {2040}}, storedVoices(t, ctx, pool, anime),
			"no voice outlives its character")
	})

	t.Run("a first-page write removes id-less rows but no addressed ones", func(t *testing.T) {
		const anime = 3
		seedTitle(t, ctx, pool, anime)
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_characters (anime_id, display_order, name_en) VALUES ($1, 0, 'legacy a'), ($1, 1, 'legacy b');
			`, anime)
		require.NoError(t, err)
		require.NoError(t, WriteCast(ctx, q, anime, castOf(seq(26, 27), 1000), WholeList))
		// The whole-list write above already removed the legacy rows; put
		// one back to see a first-page write remove it too.
		_, err = pool.Exec(ctx, `INSERT INTO anime_characters (anime_id, display_order, name_en) VALUES ($1, 0, 'legacy c')`, anime)
		require.NoError(t, err)

		require.NoError(t, WriteCast(ctx, q, anime, castOf([]int{1, 2}, 1000), FirstPage))
		ids, orders := storedCharacters(t, ctx, pool, anime)
		assert.Equal(t, []int{1, 2, 26, 27}, ids)
		assert.Equal(t, []int{0, 1, 2, 3}, orders)
	})

	t.Run("an id-less node does not pile up across refreshes", func(t *testing.T) {
		const anime = 4
		seedTitle(t, ctx, pool, anime)
		edges := []anilist.CharacterEdge{character(1, "A"), character(0, "nameless")}
		require.NoError(t, WriteCast(ctx, q, anime, CastFromEdges(edges, nil), FirstPage))
		require.NoError(t, WriteCast(ctx, q, anime, CastFromEdges(edges, nil), FirstPage))
		ids, _ := storedCharacters(t, ctx, pool, anime)
		assert.Equal(t, []int{1, 0}, ids)
	})

	t.Run("name_cn survives a refresh; voice_actor_cn only while the voice is the same person", func(t *testing.T) {
		const anime = 5
		seedTitle(t, ctx, pool, anime)
		require.NoError(t, WriteCast(ctx, q, anime, castOf([]int{1, 2}, 1000), WholeList))
		_, err := pool.Exec(ctx,
			`UPDATE anime_characters SET name_cn = '名', voice_actor_cn = '声' WHERE anime_id = $1`, anime)
		require.NoError(t, err)

		// Character 1 keeps voice 1001; character 2's voice changes.
		next := castOf([]int{1, 2}, 1000)
		other := int32(7777)
		next.Characters[1].VoiceActorID = &other
		require.NoError(t, WriteCast(ctx, q, anime, next, FirstPage))

		var nameCn1, vaCn1, nameCn2 *string
		var vaCn2 *string
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT name_cn, voice_actor_cn FROM anime_characters WHERE anime_id = $1 AND character_id = 1`, anime).Scan(&nameCn1, &vaCn1))
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT name_cn, voice_actor_cn FROM anime_characters WHERE anime_id = $1 AND character_id = 2`, anime).Scan(&nameCn2, &vaCn2))
		require.NotNil(t, nameCn1)
		assert.Equal(t, "名", *nameCn1)
		require.NotNil(t, vaCn1)
		assert.Equal(t, "声", *vaCn1, "same voice actor: the Chinese name still names them")
		require.NotNil(t, nameCn2)
		assert.Nil(t, vaCn2, "a different voice actor must not inherit the previous one's Chinese name")
	})

	t.Run("a last first page is written as the whole list", func(t *testing.T) {
		const anime = 6
		seedTitle(t, ctx, pool, anime)
		require.NoError(t, WriteCast(ctx, q, anime, castOf(seq(1, 30), 1000), WholeList))
		// AniList now lists three characters and says there is no page 2.
		require.NoError(t, WriteCast(ctx, q, anime, castOf([]int{5, 6, 7}, 1000), ModeFor(false, true)))
		ids, _ := storedCharacters(t, ctx, pool, anime)
		assert.Equal(t, []int{5, 6, 7}, ids)
	})
}

// TestWrite_EveryColumnRoundTrips_PG pins the json tags on Character,
// Voice and Staff to the column definition lists of the batch upserts.
// jsonb_to_recordset answers a key it does not know with NULL and no
// error, so a tag that drifts from its column would silently empty that
// column on every write -- this test is where that shows.
func TestWrite_EveryColumnRoundTrips_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)
	seedTitle(t, ctx, pool, 1)

	s := func(v string) *string { return &v }
	i32 := func(v int32) *int32 { return &v }
	cast := Cast{
		Characters: []Character{{
			DisplayOrder: 0, NameEn: s("Stark"), NameJa: s("シュタルク"), ImageUrl: s("https://img/c"),
			Role: s("MAIN"), VoiceActorEn: s("Chiaki Kobayashi"), VoiceActorJa: s("小林千晃"),
			VoiceActorImageUrl: s("https://img/va"), CharacterID: i32(10), VoiceActorID: i32(20),
		}},
		Voices: []Voice{{
			CharacterID: 10, StaffID: 21, DisplayOrder: 1, Language: s("Japanese"), RoleNotes: s("Childhood"),
			DubGroup: s("Dub Co"), NameFull: s("Arisa Kiyoto"), NameNative: s("清都ありさ"), ImageUrl: s("https://img/v2"),
		}},
	}
	require.NoError(t, WriteCast(ctx, q, 1, cast, WholeList))
	require.NoError(t, WriteStaff(ctx, q, 1, []Staff{{
		DisplayOrder: 0, NameEn: s("Keiichiro Saito"), NameJa: s("斎藤圭一郎"), ImageUrl: s("https://img/s"),
		Role: s("Director"), StaffID: i32(30),
	}}, WholeList))

	// Every column is read as text so a NULL shows up as a mismatch in the
	// diff rather than as a nil dereference.
	readRow := func(sql string) []string {
		t.Helper()
		rows, err := pool.Query(ctx, sql)
		require.NoError(t, err)
		defer rows.Close()
		require.True(t, rows.Next(), "no row for %s", sql)
		vals, err := rows.Values()
		require.NoError(t, err)
		out := make([]string, len(vals))
		for i, v := range vals {
			if v == nil {
				out[i] = "<NULL>"
				continue
			}
			out[i] = fmt.Sprint(v)
		}
		return out
	}

	assert.Equal(t,
		[]string{"0", "Stark", "シュタルク", "https://img/c", "MAIN", "Chiaki Kobayashi", "小林千晃", "https://img/va", "10", "20"},
		readRow(`SELECT display_order, name_en, name_ja, image_url, role, voice_actor_en, voice_actor_ja,
		               voice_actor_image_url, character_id, voice_actor_id
		        FROM anime_characters WHERE anime_id = 1`))
	assert.Equal(t,
		[]string{"10", "21", "1", "Japanese", "Childhood", "Dub Co", "Arisa Kiyoto", "清都ありさ", "https://img/v2"},
		readRow(`SELECT character_id, staff_id, display_order, language, role_notes, dub_group,
		               name_full, name_native, image_url
		        FROM anime_character_voices WHERE anime_id = 1`))
	assert.Equal(t,
		[]string{"0", "Keiichiro Saito", "斎藤圭一郎", "https://img/s", "Director", "30"},
		readRow(`SELECT display_order, name_en, name_ja, image_url, role, staff_id FROM anime_staff WHERE anime_id = 1`))
}

// TestWriteStaff_PG — the staff key includes the role, an empty role is
// a key of its own (NULLS NOT DISTINCT), and the two modes prune and
// renumber as they do for characters.
func TestWriteStaff_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	staffEdge := func(id int, role *string) anilist.StaffEdge {
		return anilist.StaffEdge{Role: role, Node: anilist.StaffNode{ID: id, Name: &anilist.PersonName{Full: sptr(fmt.Sprintf("S%d", id))}}}
	}
	keys := func(animeID int32) []string {
		rows, err := pool.Query(ctx,
			`SELECT COALESCE(staff_id, 0), COALESCE(role, '<null>'), display_order FROM anime_staff WHERE anime_id = $1 ORDER BY display_order, id`, animeID)
		require.NoError(t, err)
		defer rows.Close()
		var out []string
		for rows.Next() {
			var id, order int
			var role string
			require.NoError(t, rows.Scan(&id, &role, &order))
			out = append(out, fmt.Sprintf("%d:%s@%d", id, role, order))
		}
		require.NoError(t, rows.Err())
		return out
	}

	const anime = 1
	seedTitle(t, ctx, pool, anime)

	whole := StaffFromEdges([]anilist.StaffEdge{
		staffEdge(1, sptr("Director")),
		staffEdge(1, sptr("Storyboard")),
		staffEdge(2, nil),
		staffEdge(3, sptr("Music")),
		staffEdge(4, sptr("Key Animation")),
	})
	require.NoError(t, WriteStaff(ctx, q, anime, whole, WholeList))
	require.NoError(t, WriteStaff(ctx, q, anime, whole, WholeList), "rewriting the same list, NULL role included, must not conflict or duplicate")
	assert.Equal(t, []string{"1:Director@0", "1:Storyboard@1", "2:<null>@2", "3:Music@3", "4:Key Animation@4"}, keys(anime))

	// First page now leads with 3 and drops (1, Storyboard) to later pages.
	first := StaffFromEdges([]anilist.StaffEdge{
		staffEdge(3, sptr("Music")),
		staffEdge(1, sptr("Director")),
		staffEdge(2, nil),
	})
	require.NoError(t, WriteStaff(ctx, q, anime, first, FirstPage))
	assert.Equal(t, []string{"3:Music@0", "1:Director@1", "2:<null>@2", "1:Storyboard@3", "4:Key Animation@4"}, keys(anime))

	read, err := q.GetAnimeStaffByID(ctx, anime)
	require.NoError(t, err)
	require.Len(t, read, 5)
	assert.Equal(t, "Music", *read[0].Role)

	require.NoError(t, WriteStaff(ctx, q, anime, first, WholeList))
	assert.Equal(t, []string{"3:Music@0", "1:Director@1", "2:<null>@2"}, keys(anime))
}
