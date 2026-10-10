package credits

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestMigrations0042And0043_PG exercises 0042 and 0043 against rows
// planted under 0041: the dedupe that lets the unique indexes exist, each
// file on its own (a deploy applies them in turn, and either can be the
// last one applied when something stops it), the write path of the
// binary that predates them (which runs against this schema for the
// length of a deploy), and the down migrations.
func TestMigrations0042And0043_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	testutil.MigrateTo(t, uri, 41)
	pool := testutil.NewWebPool(t, ctx, uri)

	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n), sql)
		return n
	}

	exec(`INSERT INTO anime_cache (anilist_id, title_romaji) VALUES (1, 'one'), (2, 'two')`)
	// Characters: 10 twice (the later copy at display_order 1 is AniList's
	// first), 11 once, and two pre-0037 rows with no id.
	exec(`INSERT INTO anime_characters (anime_id, display_order, name_en, character_id) VALUES
		(1, 3, 'dup late', 10), (1, 1, 'dup early', 10), (1, 0, 'eleven', 11),
		(1, 2, 'legacy a', NULL), (1, 2, 'legacy b', NULL), (2, 0, 'other title', 10)`)
	// Staff: (5, no role) twice, (5, Director), (6, Music) twice.
	exec(`INSERT INTO anime_staff (anime_id, display_order, name_en, role, staff_id) VALUES
		(1, 2, 'five late', NULL, 5), (1, 0, 'five early', NULL, 5), (1, 1, 'five director', 'Director', 5),
		(1, 3, 'six', 'Music', 6), (1, 4, 'six again', 'Music', 6), (1, 5, 'legacy', 'Music', NULL)`)

	testutil.MigrateTo(t, uri, 42)

	t.Run("duplicates are removed, keeping the copy listed first", func(t *testing.T) {
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1 AND character_id = 10`))
		assert.Equal(t, 1, count(`SELECT display_order FROM anime_characters WHERE anime_id = 1 AND character_id = 10`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 2 AND character_id = 10`),
			"the same character on another title is not a duplicate")
		assert.Equal(t, 2, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1 AND character_id IS NULL`),
			"rows without an id are outside the key and are left alone")

		assert.Equal(t, 0, count(`SELECT display_order FROM anime_staff WHERE anime_id = 1 AND staff_id = 5 AND role IS NULL`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1 AND staff_id = 5 AND role IS NULL`),
			"an empty role is one key (NULLS NOT DISTINCT), so its copies are duplicates")
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1 AND staff_id = 5 AND role = 'Director'`))
		assert.Equal(t, 3, count(`SELECT display_order FROM anime_staff WHERE anime_id = 1 AND staff_id = 6`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1 AND staff_id IS NULL`))
	})

	stampColumns := `SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'anime_cache' AND column_name IN ('cast_has_more', 'cast_checked_at', 'staff_has_more', 'staff_checked_at')`

	t.Run("0042 adds the voices table; the sweep's columns wait for 0043", func(t *testing.T) {
		exec(`INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, language)
			VALUES (2, 10, 900, 0, 'Japanese')`)
		_, err := pool.Exec(ctx, `INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order) VALUES (2, 0, 900, 0)`)
		assert.Error(t, err, "ids are positive")
		exec(`DELETE FROM anime_cache WHERE anilist_id = 2`)
		assert.Equal(t, 0, count(`SELECT count(*) FROM anime_character_voices`), "voices go with their title")
		assert.Equal(t, 0, count(stampColumns))
	})

	// The binary that predates 0042 must also survive a deploy that stops
	// between the two files.
	t.Run("the pre-0042 delete-and-insert write works after 0042 alone", func(t *testing.T) {
		oldWrite(t, ctx, pool, 1)
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1`))
	})

	testutil.MigrateTo(t, uri, 43)

	t.Run("0043 adds the sweep's columns, empty", func(t *testing.T) {
		assert.Equal(t, 4, count(stampColumns))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_cache
			WHERE cast_has_more IS NULL AND cast_checked_at IS NULL AND staff_has_more IS NULL AND staff_checked_at IS NULL`))
	})

	// The binary that predates 0042 keeps serving while the new one
	// builds.  Its whole credit write is: delete every row of the title,
	// insert page 1.  Those exact statement shapes must still succeed.
	t.Run("the pre-0042 delete-and-insert write still works after 0043", func(t *testing.T) {
		oldWrite(t, ctx, pool, 1)
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1`))
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1`))
		oldWrite(t, ctx, pool, 1) // and again, as the next refresh would
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1`))

		// The one shape it can no longer write: the same key twice inside
		// a single page.  AniList's connections carry one edge per pair,
		// so this is the documented edge, pinned rather than hoped about.
		_, err := pool.Exec(ctx, `INSERT INTO anime_characters (anime_id, display_order, character_id) VALUES (1, 9, 101)`)
		assert.Error(t, err)
	})

	t.Run("down trims rows beyond the first page and drops what 0042 and 0043 added", func(t *testing.T) {
		exec(`INSERT INTO anime_characters (anime_id, display_order, character_id)
			SELECT 1, 100 + g, 1000 + g FROM generate_series(0, 39) g`)
		exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, role)
			SELECT 1, 100 + g, 1000 + g, 'Key Animation' FROM generate_series(0, 39) g`)

		testutil.MigrateTo(t, uri, 42)
		assert.Equal(t, 0, count(stampColumns), "0043's down drops the sweep's columns")
		assert.Equal(t, 43, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1`), "and touches nothing else")

		testutil.MigrateTo(t, uri, 41)

		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 1`),
			"the build that predates 0042 reads every row; only the first page may remain")
		assert.Equal(t, 3, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 1`))
		assert.Equal(t, 0, count(`SELECT count(*) FROM information_schema.tables WHERE table_name = 'anime_character_voices'`))
		assert.Equal(t, 0, count(`SELECT count(*) FROM pg_indexes
			WHERE indexname IN ('anime_characters_anime_character_uidx', 'anime_staff_anime_staff_role_uidx')`))

		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
	})
}

// oldWrite replays the credit statements the pre-0042 detail refresh ran
// (DeleteAnimeCharacters + InsertAnimeCharacter, DeleteAnimeStaff +
// InsertAnimeStaffMember), as the old binary sends them.
func oldWrite(t *testing.T, ctx context.Context, pool *pgxpool.Pool, animeID int32) {
	t.Helper()
	stmts := []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM anime_characters WHERE anime_id = $1`, []any{animeID}},
		{`DELETE FROM anime_staff WHERE anime_id = $1`, []any{animeID}},
	}
	for i := int32(0); i < 3; i++ {
		stmts = append(stmts,
			struct {
				sql  string
				args []any
			}{`INSERT INTO anime_characters (
				anime_id, display_order, name_en, name_ja, name_cn, image_url, role,
				voice_actor_en, voice_actor_ja, voice_actor_image_url, character_id, voice_actor_id
			) VALUES ($1, $2, 'n', NULL, NULL, NULL, 'MAIN', 'va', NULL, NULL, $3, $4)`,
				[]any{animeID, i, 100 + i, 500 + i}},
			struct {
				sql  string
				args []any
			}{`INSERT INTO anime_staff (anime_id, display_order, name_en, name_ja, image_url, role, staff_id)
			VALUES ($1, $2, 's', NULL, NULL, NULL, $3)`,
				[]any{animeID, i, 200 + i}},
		)
	}
	for _, s := range stmts {
		_, err := pool.Exec(ctx, s.sql, s.args...)
		require.NoError(t, err, s.sql)
	}
}

// TestMigration0050_PG applies 0050 over a schema at 0049 holding what the
// code before it wrote -- a Japanese title with Chinese and Korean dubs, a
// Chinese production headed by its Chinese cast, a Korean one with no
// Japanese voice at all, a title from before 0042 -- and the AniList
// profiles of the people they credit.  It checks each of the file's four
// steps, the people it must keep, the photos it takes out of image_refs,
// and that the file changes nothing when it runs again, by hand or through
// a down and an up.
func TestMigration0050_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	testutil.MigrateTo(t, uri, 49)
	pool := testutil.NewWebPool(t, ctx, uri)

	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n), sql)
		return n
	}
	ints := func(sql string, args ...any) []int {
		t.Helper()
		rows, err := pool.Query(ctx, sql, args...)
		require.NoError(t, err, sql)
		out, err := pgx.CollectRows(rows, pgx.RowTo[int])
		require.NoError(t, err, sql)
		return out
	}
	// A person's photo as a credit row stores it, and as their profile does.
	creditPhoto := func(staff int) string {
		return fmt.Sprintf("https://s4.anilist.co/file/anilistcdn/staff/medium/n%d-credit.png", staff)
	}
	profilePhoto := func(staff int, size string) string {
		return fmt.Sprintf("https://s4.anilist.co/file/anilistcdn/staff/%s/n%d-profile.png", size, staff)
	}
	voice := func(anime, character, staff, order int, language, notes string) {
		t.Helper()
		exec(`INSERT INTO anime_character_voices
				(anime_id, character_id, staff_id, display_order, language, role_notes, name_full, name_native, image_url)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9)`,
			anime, character, staff, order, language, notes,
			fmt.Sprintf("V%d", staff), fmt.Sprintf("声%d", staff), creditPhoto(staff))
	}
	// character writes a character row voiced by voiceActor (0 for none),
	// as the writers before 0050 did: the voice_actor_* columns copy that
	// person's credit.
	character := func(anime, character, order, voiceActor int, voiceActorCn string) {
		t.Helper()
		var id, en, ja, photo any
		if voiceActor != 0 {
			id, en, ja, photo = voiceActor, fmt.Sprintf("V%d", voiceActor), fmt.Sprintf("声%d", voiceActor), creditPhoto(voiceActor)
		}
		exec(`INSERT INTO anime_characters
				(anime_id, display_order, character_id, name_en, role,
				 voice_actor_id, voice_actor_en, voice_actor_ja, voice_actor_image_url, voice_actor_cn)
			VALUES ($1, $2, $3, $4, 'MAIN', $5, $6, $7, $8, NULLIF($9, ''))`,
			anime, order, character, fmt.Sprintf("C%d", character), id, en, ja, photo, voiceActorCn)
	}
	person := func(staff int) {
		t.Helper()
		exec(`INSERT INTO people (anilist_id, name_full, image_large, image_medium, fetched_at, checked_at)
			VALUES ($1, $2, $3, $4, now(), now())`,
			staff, fmt.Sprintf("V%d", staff), profilePhoto(staff, "large"), profilePhoto(staff, "medium"))
	}

	exec(`INSERT INTO anime_cache (anilist_id, title_romaji, country_of_origin) VALUES
		(1, 'Japanese title', 'JP'), (2, 'Chinese production', 'CN'), (3, 'Korean production', 'KR'),
		(4, 'Written before 0042', 'JP')`)

	// A Japanese title with every dub: Japanese first, as the old order put it.
	character(1, 10, 0, 100, "日配一")
	voice(1, 10, 100, 0, "Japanese", "")
	voice(1, 10, 101, 1, "Japanese", "Childhood")
	voice(1, 10, 102, 2, "Chinese", "")
	voice(1, 10, 103, 3, "Korean", "")
	character(1, 11, 1, 110, "")
	voice(1, 11, 110, 0, "Japanese", "")
	voice(1, 11, 111, 1, "Korean", "")
	voice(1, 11, 112, 2, "Japanese", "Young")
	// 204 voices this character in Japanese and one of title 2's in Korean.
	character(1, 12, 2, 204, "")
	voice(1, 12, 204, 0, "Japanese", "")

	// A Chinese production: the Chinese cast first and on the rows.  20's
	// Japanese main voice comes after a Japanese childhood voice; 21's only
	// Japanese voice has notes and a lower-case label.
	character(2, 20, 0, 200, "阿杰")
	voice(2, 20, 200, 0, "Chinese", "")
	voice(2, 20, 201, 1, "Chinese", "Childhood")
	voice(2, 20, 202, 2, "Japanese", "Childhood")
	voice(2, 20, 203, 3, "Japanese", "")
	voice(2, 20, 204, 4, "Korean", "")
	character(2, 21, 1, 210, "")
	voice(2, 21, 210, 0, "Chinese", "")
	voice(2, 21, 211, 1, "japanese", "Young")

	// A Korean production with no Japanese dub.  300 voiced only here; 310
	// is also its sound director; 320 has a reader's accepted edit; 400 is
	// the voice a title from before 0042 names; 33 was never voiced.
	character(3, 30, 0, 300, "韩配一")
	voice(3, 30, 300, 0, "Korean", "")
	character(3, 31, 1, 310, "")
	voice(3, 31, 310, 0, "Korean", "")
	character(3, 32, 2, 320, "")
	voice(3, 32, 320, 0, "Korean", "")
	character(3, 33, 3, 0, "")
	character(3, 34, 4, 400, "")
	voice(3, 34, 400, 0, "Korean", "")
	exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, role, name_en, image_url)
		VALUES (3, 0, 310, 'Sound Director', 'V310', $1)`, creditPhoto(310))
	exec(`INSERT INTO entity_overlays (kind, entity_id, data) VALUES ('person', 320, '{"nameCn":"三二零"}')`)

	// Before 0042 a title kept one Japanese voice per character, on the row,
	// and nothing in the voice table; a row from before 0037 has no ids.
	character(4, 40, 0, 400, "")
	exec(`INSERT INTO anime_characters (anime_id, display_order, name_en, voice_actor_en, voice_actor_ja)
		VALUES (4, 1, 'Legacy', 'Old Voice', '古い声')`)

	// 500 was credited nowhere before 0050: not this file's to remove.
	for _, staff := range []int{100, 102, 103, 200, 201, 203, 204, 210, 300, 310, 320, 400, 500} {
		person(staff)
	}

	// characterVoice is a character row's voice columns, NULL spelled out.
	characterVoice := func(anime, character int) []string {
		t.Helper()
		var id, en, ja, photo, cn string
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT COALESCE(voice_actor_id::text, '<NULL>'), COALESCE(voice_actor_en, '<NULL>'),
			       COALESCE(voice_actor_ja, '<NULL>'), COALESCE(voice_actor_image_url, '<NULL>'),
			       COALESCE(voice_actor_cn, '<NULL>')
			FROM anime_characters WHERE anime_id = $1 AND character_id = $2`, anime, character).
			Scan(&id, &en, &ja, &photo, &cn))
		return []string{id, en, ja, photo, cn}
	}
	none := []string{"<NULL>", "<NULL>", "<NULL>", "<NULL>", "<NULL>"}
	// voices is a character's voice rows as staff@display_order, in order.
	voices := func(anime, character int) string {
		t.Helper()
		var got *string
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT string_agg(staff_id || '@' || display_order, ' ' ORDER BY display_order, staff_id)
			FROM anime_character_voices WHERE anime_id = $1 AND character_id = $2`, anime, character).Scan(&got))
		if got == nil {
			return ""
		}
		return *got
	}
	// snapshot is everything the file writes, for the reruns below.
	snapshot := func() string {
		t.Helper()
		var s string
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT concat_ws(' | ',
			  (SELECT string_agg(concat_ws(',', anime_id, character_id, staff_id, display_order, language),
			                     ';' ORDER BY anime_id, character_id, staff_id)
			   FROM anime_character_voices),
			  (SELECT string_agg(concat_ws(',', anime_id, display_order, character_id, voice_actor_id,
			                               voice_actor_en, voice_actor_ja, voice_actor_image_url, voice_actor_cn),
			                     ';' ORDER BY anime_id, display_order)
			   FROM anime_characters),
			  (SELECT string_agg(anilist_id::text, ',' ORDER BY anilist_id) FROM people))`).Scan(&s))
		return s
	}

	t.Run("0050 applies while a reader holds the tables it writes", func(t *testing.T) {
		const bound = 10 * time.Second
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `SELECT (SELECT count(*) FROM anime_characters) + (SELECT count(*) FROM anime_character_voices)
			+ (SELECT count(*) FROM people)`)
		require.NoError(t, err)

		applied, released := make(chan struct{}), make(chan struct{})
		go func() {
			defer close(released)
			select {
			case <-applied:
			case <-time.After(bound):
			}
			_ = tx.Rollback(ctx)
		}()
		start := time.Now()
		testutil.MigrateTo(t, uri, 50)
		close(applied)
		<-released
		assert.Less(t, time.Since(start), bound, "SHARE ROW EXCLUSIVE does not wait for a reader")
	})

	t.Run("1. a character row takes its Japanese voice, or none", func(t *testing.T) {
		assert.Equal(t, []string{"100", "V100", "声100", creditPhoto(100), "日配一"}, characterVoice(1, 10),
			"a Japanese primary is left as it is, Chinese name and all")
		assert.Equal(t, []string{"203", "V203", "声203", creditPhoto(203), "<NULL>"}, characterVoice(2, 20),
			"the Japanese main voice, over the Japanese childhood voice listed before it; "+
				"the old voice's Chinese name does not pass to the new one")
		assert.Equal(t, "211", characterVoice(2, 21)[0], "the only Japanese voice, notes and all, the label read in any case")
		for _, c := range []int{30, 31, 32, 33, 34} {
			assert.Equal(t, none, characterVoice(3, c), "Korean production, character %d: no Japanese voice, no voice", c)
		}
		assert.Equal(t, "400", characterVoice(4, 40)[0], "a row from before 0042 has no voice row to say otherwise")
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_characters
			WHERE anime_id = 4 AND character_id IS NULL AND voice_actor_en = 'Old Voice'`), "a row with no ids is left alone")
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_characters
			WHERE anime_id = 2 AND character_id = 20 AND name_en = 'C20' AND role = 'MAIN' AND display_order = 0`),
			"nothing but the voice columns moves")
	})

	t.Run("2 and 3. only Japanese voices are left, numbered from the character row's", func(t *testing.T) {
		assert.Zero(t, count(`SELECT count(*) FROM anime_character_voices
			WHERE lower(btrim(language)) IS DISTINCT FROM 'japanese'`))
		assert.Equal(t, "100@0 101@1", voices(1, 10))
		assert.Equal(t, "110@0 112@1", voices(1, 11), "the voice after a deleted one moves up")
		assert.Equal(t, "204@0", voices(1, 12))
		assert.Equal(t, "203@0 202@1", voices(2, 20), "the promoted voice first, the rest in their old order")
		assert.Equal(t, "211@0", voices(2, 21))
		assert.Zero(t, count(`SELECT count(*) FROM anime_character_voices WHERE anime_id = 3`))
	})

	t.Run("4. the profiles of the people left uncredited go, and only those", func(t *testing.T) {
		// Gone: 102 and 103 (a dub of title 1), 200, 201 and 210 (title 2's
		// Chinese cast) and 300 (Korean only).  Kept: 100 and 203 (Japanese voices),
		// 204 (Japanese on title 1), 310 (a staff credit), 320 (an accepted
		// edit), 400 (a character row before 0042) and 500 (unreferenced
		// before, so never a candidate).
		assert.Equal(t, []int{100, 203, 204, 310, 320, 400, 500}, ints(`SELECT anilist_id FROM people ORDER BY anilist_id`))
	})

	t.Run("the removed people's photos leave image_refs", func(t *testing.T) {
		refs := func(url string) int {
			t.Helper()
			return count(`SELECT count(*) FROM image_refs WHERE url = $1`, url)
		}
		for _, gone := range []int{102, 103, 200, 201, 210, 300} {
			assert.Zero(t, refs(profilePhoto(gone, "large")), "%d", gone)
			assert.Zero(t, refs(profilePhoto(gone, "medium")), "%d", gone)
			assert.Zero(t, refs(creditPhoto(gone)), "%d", gone)
		}
		for _, kept := range []int{100, 203, 310, 320, 500} {
			assert.Equal(t, 1, refs(profilePhoto(kept, "large")), "%d", kept)
		}
		assert.Equal(t, 1, refs(creditPhoto(203)), "the promoted voice's photo, from its voice row and the character row")
	})

	t.Run("running the file again by hand changes nothing", func(t *testing.T) {
		before := snapshot()
		up, err := os.ReadFile(filepath.Join("..", "..", "migrations", "0050_japanese_voices_only.up.sql"))
		require.NoError(t, err)
		exec(string(up))
		assert.Equal(t, before, snapshot())
	})

	t.Run("down restores nothing; up again changes nothing", func(t *testing.T) {
		before := snapshot()
		testutil.MigrateTo(t, uri, 49)
		assert.Equal(t, before, snapshot())
		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
		assert.Equal(t, before, snapshot())
	})
}
