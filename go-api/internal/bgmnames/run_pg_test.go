package bgmnames

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestRun_PG runs the whole import against frierenDump on a real Postgres
// seeded the way the detail refresh leaves a title: a dry run, a write, a
// second write, and the title re-bound to an unrelated subject.
func TestRun_PG(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	dump := frierenDump(t)
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	count := func(sql string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql).Scan(&n), sql)
		return n
	}

	exec(`INSERT INTO anime_cache (anilist_id, title_romaji, bgm_id) VALUES
		(154587, 'Sousou no Frieren', 400602), (555, 'not bound', NULL)`)
	// Frieren and Fern with their primary voices (the voices table too, as
	// the detail refresh writes both), Flamme with only the primary voice
	// (a row from before 0042), and an unbound title's character.
	exec(`INSERT INTO anime_characters (anime_id, display_order, character_id, name_ja, voice_actor_id, voice_actor_ja) VALUES
		(154587, 0, 176754, 'フリーレン', 112215, '種﨑敦美'),
		(154587, 1, 183965, 'フェルン', 124390, '市ノ瀬加那'),
		(154587, 2, 219733, 'フランメ', 95100, '田中敦子'),
		(555, 0, 1, 'フリーレン', 112215, '種﨑敦美')`)
	exec(`INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, language, name_native) VALUES
		(154587, 176754, 112215, 0, 'Japanese', '種﨑敦美'),
		(154587, 183965, 124390, 0, 'Japanese', '市ノ瀬加那')`)
	exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, name_ja, role) VALUES
		(154587, 0, 134254, '斎藤圭一郎', 'Director'),
		(154587, 1, 134254, '斎藤圭一郎', 'Storyboard'),
		(154587, 2, 122202, '山田鐘人', 'Original Story')`)

	run := func(apply bool, now time.Time) *Report {
		t.Helper()
		rep, err := Run(ctx, pool, Options{DumpDir: dump, Source: "dump-test", Apply: apply, Now: func() time.Time { return now }})
		require.NoError(t, err)
		return rep
	}
	t0 := time.Date(2026, 10, 7, 5, 0, 0, 0, time.UTC)

	t.Run("a dry run reports and writes nothing", func(t *testing.T) {
		rep := run(false, t0)
		assert.False(t, rep.Applied)
		assert.Equal(t, Stats{
			Titles: 1, TitlesMatched: 1,
			PeopleConsidered: 5, PeopleMatched: 4, PeopleNamed: 4, ByVoice: 3, ByStaff: 1,
			CharactersConsidered: 3, CharactersMatched: 3, CharactersNamed: 3,
		}, rep.Stats)
		assert.Equal(t, Changes{People: Change{Inserted: 4}, Characters: Change{Inserted: 3}}, rep.Changes)
		assert.Zero(t, count(`SELECT count(*) FROM bgm_person_map`))
		assert.Zero(t, count(`SELECT count(*) FROM bgm_character_map`))

		var out bytes.Buffer
		rep.Write(&out, 10)
		for _, want := range []string{"dry run", "种崎敦美", "市之濑加那", "田中敦子", "芙莉莲", "菲伦", "伏拉梅", "斋藤圭一郎", "bgm_person_map"} {
			assert.Contains(t, out.String(), want)
		}
		assert.NotContains(t, out.String(), "（声优）")
		assert.Contains(t, out.String(), "3 with a Chinese name, 1 with a summary")
	})

	t.Run("a write stores the matches; the same write again changes nothing", func(t *testing.T) {
		rep := run(true, t0)
		assert.True(t, rep.Applied)
		assert.Equal(t, Changes{People: Change{Inserted: 4}, Characters: Change{Inserted: 3}}, rep.Changes)

		people := readMap(t, ctx, pool, "bgm_person_map")
		assert.Equal(t, "种崎敦美", *people[112215].NameCn)
		assert.Equal(t, int32(7575), people[112215].BgmID)
		assert.Equal(t, "市之濑加那", *people[124390].NameCn)
		assert.Equal(t, "田中敦子", *people[95100].NameCn)
		assert.Equal(t, int32(3873), people[95100].BgmID, "the voice actress, not her namesake")
		assert.Equal(t, "斋藤圭一郎", *people[134254].NameCn)
		assert.NotContains(t, people, int32(122202), "Bangumi does not credit him on this subject")
		chars := readMap(t, ctx, pool, "bgm_character_map")
		assert.Equal(t, "芙莉莲", *chars[176754].NameCn)
		assert.Equal(t, "菲伦", *chars[183965].NameCn)
		assert.Equal(t, 1, count(`SELECT count(*) FROM bgm_character_map
			WHERE anilist_id = 183965 AND summary = E'芙莉莲的弟子。\n~!后来成为一级魔法使。!~'`), "the summary, cleaned, with the match")
		assert.Equal(t, "伏拉梅", *chars[219733].NameCn, "found through the primary voice alone")
		assert.NotContains(t, chars, int32(1), "the unbound title is not read")

		again := run(true, t0.Add(7*24*time.Hour))
		assert.Equal(t, Changes{People: Change{Unchanged: 4}, Characters: Change{Unchanged: 3}}, again.Changes)
		assert.Zero(t, count(`SELECT count(*) FROM anime_characters WHERE name_cn IS NOT NULL OR voice_actor_cn IS NOT NULL`),
			"the import never writes anime_characters")
	})

	t.Run("a title bound to an unrelated subject: nothing is written, and its old matches go", func(t *testing.T) {
		exec(`UPDATE anime_cache SET bgm_id = 1 WHERE anilist_id = 154587`)
		rep := run(true, t0.Add(14*24*time.Hour))

		assert.Zero(t, rep.Stats.PeopleMatched)
		assert.Zero(t, rep.Stats.CharactersMatched)
		assert.Equal(t, Changes{People: Change{Deleted: 4}, Characters: Change{Deleted: 3}}, rep.Changes)
		assert.Zero(t, count(`SELECT count(*) FROM bgm_person_map`))
		assert.Zero(t, count(`SELECT count(*) FROM bgm_character_map`))
	})
}
