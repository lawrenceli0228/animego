//go:build integration

package anime

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
	"github.com/stretchr/testify/require"
	"testing"
)

// 只使用新建并自动销毁的测试数据库，验证迁移约束及省略/明确清空的区别。
func TestTrailerPostgresRoundTrip(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool, err := pgxpool.New(ctx, uri)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	q := dbgen.New(pool)
	row := NormalizeMainRow(anilist.Media{ID: 987654, Trailer: &anilist.Trailer{ID: sptr("abcdefghijk"), Site: sptr("youtube")}})
	require.NoError(t, q.UpsertAnimeCache(ctx, row))
	got, err := q.GetAnimeMainByID(ctx, row.AnilistID)
	require.NoError(t, err)
	require.Equal(t, "abcdefghijk", *got.TrailerID)
	require.True(t, got.TrailerFetched)
	// 搜索等精简列表未选 trailer，不能擦掉已经保存的值。
	omitted := NormalizeMainRow(anilist.Media{ID: 987654})
	require.NoError(t, q.UpsertAnimeCache(ctx, omitted))
	got, err = q.GetAnimeMainByID(ctx, row.AnilistID)
	require.NoError(t, err)
	require.Equal(t, "abcdefghijk", *got.TrailerID)
	_, err = pool.Exec(ctx, "UPDATE anime_cache SET trailer_site = NULL WHERE anilist_id = $1", row.AnilistID)
	require.Error(t, err)
	// 完整详情明确返回 null 时允许清空，并记录已经查询过。
	omitted.TrailerFetched = true
	require.NoError(t, q.UpsertAnimeCache(ctx, omitted))
	got, err = q.GetAnimeMainByID(ctx, row.AnilistID)
	require.NoError(t, err)
	require.Nil(t, got.TrailerID)
	require.Nil(t, got.TrailerSite)
	require.True(t, got.TrailerFetched)
}
