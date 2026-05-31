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
