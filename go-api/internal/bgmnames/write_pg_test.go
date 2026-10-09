package bgmnames

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// storedRow is a map row read back.
type storedRow struct {
	BgmID     int32
	NameCn    *string
	Source    string
	MatchedAt time.Time
}

func readMap(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table string) map[int32]storedRow {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT anilist_id, bgm_id, name_cn, source, matched_at FROM `+table)
	require.NoError(t, err)
	defer rows.Close()
	out := map[int32]storedRow{}
	for rows.Next() {
		var id int32
		var r storedRow
		require.NoError(t, rows.Scan(&id, &r.BgmID, &r.NameCn, &r.Source, &r.MatchedAt))
		out[id] = r
	}
	require.NoError(t, rows.Err())
	return out
}

// TestApply_PG writes two runs' results through Apply on a real Postgres.
func TestApply_PG(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	t0 := time.Date(2026, 10, 7, 5, 0, 0, 0, time.UTC)

	first := Result{
		People: []Pair{
			{AnilistID: 112215, BgmID: 7575, NameCn: "种崎敦美"},
			{AnilistID: 124390, BgmID: 31136, NameCn: "市之濑加那"},
			{AnilistID: 95100, BgmID: 3873, NameCn: "田中敦子"},
			{AnilistID: 900, BgmID: 9000},
		},
		Characters: []Pair{
			{AnilistID: 176754, BgmID: 86246, NameCn: "芙莉莲"},
			{AnilistID: 183965, BgmID: 86247, NameCn: "菲伦"},
		},
	}

	t.Run("a preview writes nothing and says what a write would do", func(t *testing.T) {
		changes, err := Preview(ctx, q, first)
		require.NoError(t, err)
		assert.Equal(t, Changes{People: Change{Inserted: 4}, Characters: Change{Inserted: 2}}, changes)
		assert.Empty(t, readMap(t, ctx, pool, "bgm_person_map"))
	})

	t.Run("a first run inserts every pair", func(t *testing.T) {
		changes, err := Apply(ctx, pool, first, "dump-a", t0)
		require.NoError(t, err)
		assert.Equal(t, Changes{People: Change{Inserted: 4}, Characters: Change{Inserted: 2}}, changes)

		people := readMap(t, ctx, pool, "bgm_person_map")
		require.Len(t, people, 4)
		assert.Equal(t, int32(7575), people[112215].BgmID)
		assert.Equal(t, "种崎敦美", *people[112215].NameCn)
		assert.Nil(t, people[900].NameCn, "a match without a Chinese name is kept, with NULL")
		assert.Equal(t, "dump-a", people[112215].Source)
		assert.True(t, people[112215].MatchedAt.Equal(t0))
		assert.Equal(t, "菲伦", *readMap(t, ctx, pool, "bgm_character_map")[183965].NameCn)
	})

	t.Run("the same run again changes nothing, matched_at included", func(t *testing.T) {
		changes, err := Apply(ctx, pool, first, "dump-b", t0.Add(7*24*time.Hour))
		require.NoError(t, err)
		assert.Equal(t, Changes{People: Change{Unchanged: 4}, Characters: Change{Unchanged: 2}}, changes)
		people := readMap(t, ctx, pool, "bgm_person_map")
		assert.True(t, people[112215].MatchedAt.Equal(t0), "matched_at is when this match was made")
		assert.Equal(t, "dump-a", people[112215].Source)
	})

	t1 := t0.Add(14 * 24 * time.Hour)
	second := Result{
		People: []Pair{
			{AnilistID: 112215, BgmID: 7575, NameCn: "种崎敦美"},
			{AnilistID: 124390, BgmID: 31136, NameCn: "市之濑加那（改）"},
			{AnilistID: 95100, BgmID: 9000, NameCn: "田中敦子"},
			{AnilistID: 900, BgmID: 3873},
		},
		Characters: []Pair{{AnilistID: 176754, BgmID: 86246, NameCn: "芙莉莲"}},
	}

	t.Run("changed, moved, swapped and gone", func(t *testing.T) {
		changes, err := Apply(ctx, pool, second, "dump-c", t1)
		require.NoError(t, err)
		assert.Equal(t, Changes{
			People:     Change{Unchanged: 1, Updated: 3},
			Characters: Change{Unchanged: 1, Deleted: 1},
		}, changes)

		people := readMap(t, ctx, pool, "bgm_person_map")
		assert.Equal(t, "市之濑加那（改）", *people[124390].NameCn)
		assert.True(t, people[124390].MatchedAt.Equal(t1))
		assert.Equal(t, "dump-c", people[124390].Source)
		assert.Equal(t, int32(9000), people[95100].BgmID, "95100 and 900 swapped Bangumi ids in one run")
		assert.Equal(t, int32(3873), people[900].BgmID)
		assert.True(t, people[112215].MatchedAt.Equal(t0))
		assert.NotContains(t, readMap(t, ctx, pool, "bgm_character_map"), int32(183965), "not found this run, so not kept")
	})

	t.Run("a character's summary is written with it, and a changed one replaces the row", func(t *testing.T) {
		summary := func() *string {
			t.Helper()
			var s *string
			require.NoError(t, pool.QueryRow(ctx, `SELECT summary FROM bgm_character_map WHERE anilist_id = 176754`).Scan(&s))
			return s
		}
		with := Result{People: second.People, Characters: []Pair{
			{AnilistID: 176754, BgmID: 86246, NameCn: "芙莉莲", Summary: "活了一千多年的精灵魔法使。"},
		}}
		changes, err := Apply(ctx, pool, with, "dump-d", t1)
		require.NoError(t, err)
		assert.Equal(t, Change{Updated: 1}, changes.Characters, "a summary where there was none is a change")
		require.NotNil(t, summary())
		assert.Equal(t, "活了一千多年的精灵魔法使。", *summary())

		changes, err = Apply(ctx, pool, with, "dump-e", t1)
		require.NoError(t, err)
		assert.Equal(t, Change{Unchanged: 1}, changes.Characters)

		changes, err = Apply(ctx, pool, second, "dump-f", t1)
		require.NoError(t, err)
		assert.Equal(t, Change{Updated: 1}, changes.Characters, "and so is none where there was one")
		assert.Nil(t, summary())
	})

	t.Run("a failed run leaves both tables as they were", func(t *testing.T) {
		before := [2]map[int32]storedRow{readMap(t, ctx, pool, "bgm_person_map"), readMap(t, ctx, pool, "bgm_character_map")}
		bad := Result{
			People:     []Pair{{AnilistID: 1, BgmID: 1, NameCn: "甲"}},
			Characters: []Pair{{AnilistID: 2, BgmID: 0, NameCn: "乙"}}, // refused by the CHECK, after the people were written
		}
		_, err := Apply(ctx, pool, bad, "dump-d", t1.Add(time.Hour))
		require.Error(t, err)
		assert.Equal(t, before, [2]map[int32]storedRow{readMap(t, ctx, pool, "bgm_person_map"), readMap(t, ctx, pool, "bgm_character_map")})
	})
}
