package bgmidmap_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bgmidmap"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestSeed_RealPG proves the TRUNCATE+COPY seed loads the full embedded map
// into bgm_id_map on a real Postgres, is idempotent (full-replace, no dupes),
// and that the seeded rows are queryable via LookupBgmIdMap — the exact query
// the V1 worker uses to bind authoritatively. Covers the two pieces no unit
// test can: the pgx CopyFrom path and the migration-0011 table on real PG.
func TestSeed_RealPG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	entries, err := bgmidmap.Load()
	require.NoError(t, err)
	require.Greater(t, len(entries), 1000, "embedded map should be substantial")

	// First seed loads every embedded row.
	n, err := bgmidmap.Seed(ctx, pool)
	require.NoError(t, err)
	require.Equal(t, len(entries), n)

	count, err := q.CountBgmIdMap(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(len(entries)), count, "all embedded rows loaded")

	// Re-seed is idempotent: TRUNCATE+COPY full-replaces, count is unchanged.
	n2, err := bgmidmap.Seed(ctx, pool)
	require.NoError(t, err)
	require.Equal(t, len(entries), n2)
	count2, err := q.CountBgmIdMap(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(len(entries)), count2, "re-seed produced no duplicates")

	// The seeded data answers the V1 worker's authoritative lookup.
	first := entries[0]
	bgm, err := q.LookupBgmIdMap(ctx, first.AnilistID)
	require.NoError(t, err)
	require.Equal(t, first.BgmID, bgm)
}

// TestSeedAnidb_RealPG proves the AniList->AniDB pairs load into the 0041
// table, re-seed without duplicates, and are what the magnet handler's query
// reads — including for a show the Bangumi map leaves out, which is the
// reason the pairs have their own table.
func TestSeedAnidb_RealPG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	pairs, err := bgmidmap.LoadAnidb()
	require.NoError(t, err)
	_, err = bgmidmap.Seed(ctx, pool)
	require.NoError(t, err)

	for range 2 { // second pass: TRUNCATE+COPY full-replaces
		n, err := bgmidmap.SeedAnidb(ctx, pool)
		require.NoError(t, err)
		require.Equal(t, len(pairs), n)
		count, err := q.CountAnidbIdMap(ctx)
		require.NoError(t, err)
		require.Equal(t, int64(len(pairs)), count, "every pair loaded exactly once")
	}

	bgm, err := bgmidmap.Load()
	require.NoError(t, err)
	inBgm := make(map[int32]bool, len(bgm))
	for _, e := range bgm {
		inBgm[e.AnilistID] = true
	}
	var orphan bgmidmap.AnidbEntry
	for _, p := range pairs {
		if !inBgm[p.AnilistID] {
			orphan = p
			break
		}
	}
	require.NotZero(t, orphan.AnilistID, "need a pair the Bangumi map leaves out")

	_, err = pool.Exec(ctx, `INSERT INTO anime_cache (anilist_id, title_romaji) VALUES ($1, 'Orphan')`, orphan.AnilistID)
	require.NoError(t, err)
	row, err := q.GetTorrentQueryInputsByAnilistID(ctx, orphan.AnilistID)
	require.NoError(t, err)
	require.NotNil(t, row.AnidbID, "magnet inputs must carry the AniDB id even without a Bangumi entry")
	require.Equal(t, orphan.AnidbID, *row.AnidbID)
}
