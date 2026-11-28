package anime

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// IsPrintOnlyRelation against real Postgres: which mixes of relation rows
// make an id a print work, which do not, and the index 0056 adds for it.
// Then the same rows driven through the detail handler with the real
// querier, so the cold-path wiring is exercised end to end.
func TestIsPrintOnlyRelation_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	for _, id := range []int32{1, 2} {
		_, err := pool.Exec(ctx,
			`INSERT INTO anime_cache (anilist_id, title_romaji, cached_at) VALUES ($1, 'parent', now())`, id)
		require.NoError(t, err)
	}
	relate := func(parent, target int32, format *string) {
		t.Helper()
		_, err := pool.Exec(ctx,
			`INSERT INTO anime_relations (anime_id, anilist_id, relation_type, format) VALUES ($1, $2, 'ADAPTATION', $3)`,
			parent, target, format)
		require.NoError(t, err)
	}
	manga, novel, oneShot, tv := "MANGA", "NOVEL", "ONE_SHOT", "TV"

	relate(1, 1001, &manga)
	relate(2, 1001, &manga) // two parents, both agree
	relate(1, 1002, &novel)
	relate(1, 1003, &oneShot)
	relate(1, 1004, &tv)
	relate(1, 1005, &manga)
	relate(2, 1005, &tv) // the rows disagree: not provably print
	relate(1, 1006, &novel)
	relate(2, 1006, nil) // one row does not know: not provably print
	relate(1, 1007, nil)

	cases := map[int32]bool{
		1001: true,
		1002: true,
		1003: true,
		1004: false,
		1005: false,
		1006: false,
		1007: false,
		9999: false, // no row at all
	}
	for id, want := range cases {
		got, err := q.IsPrintOnlyRelation(ctx, id)
		require.NoError(t, err, "id %d", id)
		assert.Equal(t, want, got, "id %d", id)
	}

	var indexDef string
	err := pool.QueryRow(ctx,
		`SELECT indexdef FROM pg_indexes WHERE tablename = 'anime_relations' AND indexname = 'anime_relations_anilist_id_idx'`,
	).Scan(&indexDef)
	require.NoError(t, err, "0056 creates the index")
	assert.Contains(t, indexDef, "(anilist_id)")

	// The handler with the real querier: a print id is a 404 that never
	// reaches AniList; an id the rows know as an anime still asks it.
	al := &fakeAniListDetailer{detailFn: nullMedia}
	svc := newDetailServiceWithAniList(t, q, al)

	rec := serveDetail(t, svc, "/api/anime/1002")
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	assert.Equal(t, int32(0), al.detailCalls.Load(), "a print work must not reach AniList")

	require.Equal(t, http.StatusNotFound, serveDetail(t, svc, "/api/anime/1004").Code)
	assert.Equal(t, int32(1), al.detailCalls.Load(), "an anime the catalogue lacks is still fetched")
}

// 0056 rolls back cleanly and re-applies: the down file drops only the
// index.
func TestMigration0056_DownAndUp(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)

	indexCount := func() int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT count(*) FROM pg_indexes WHERE indexname = 'anime_relations_anilist_id_idx'`).Scan(&n))
		return n
	}

	require.Equal(t, 1, indexCount())
	testutil.MigrateTo(t, uri, 55)
	assert.Equal(t, 0, indexCount())
	testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
	assert.Equal(t, 1, indexCount())
}
