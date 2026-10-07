//go:build integration

// bangumi_v3_title_test.go — UpdateBangumiV3 against a real Postgres.
//
// V3 is chained by V2 whenever the Bangumi subject has no name_cn, and V2
// runs again on every re-enrich of a row.  The statement used to write
// title_chinese unconditionally, on the assumption that the column was NULL
// whenever V3 ran.  It is not: a title written by an admin, by the dandanplay
// heal, or by an earlier pass survives V2 (which COALESCEs) and was then
// wiped by V3 the moment the subject still had no Chinese name — the case
// for every donghua whose Bangumi name is already Chinese.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

const (
	v3KeepsTitle   = int32(9930101) // titled, subject has no name_cn
	v3FillsTitle   = int32(9930102) // untitled, subject has a name_cn
	v3ReplaceTitle = int32(9930103) // titled, subject has a different name_cn
	v3StaysEmpty   = int32(9930104) // untitled, subject has no name_cn
)

func TestUpdateBangumiV3_NeverErasesATitle(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	for id, title := range map[int32]*string{
		v3KeepsTitle:   ptr("有兽焉 第四季"),
		v3FillsTitle:   nil,
		v3ReplaceTitle: ptr("旧标题"),
		v3StaysEmpty:   nil,
	} {
		_, err := tx.Exec(ctx, `INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese, bgm_id, bangumi_version)
			VALUES ($1, 'fixture', $2, 1, 2)`, id, title)
		require.NoError(t, err)
	}
	q := dbgen.New(tx)

	require.NoError(t, q.UpdateBangumiV3(ctx, v3KeepsTitle, nil))
	require.NoError(t, q.UpdateBangumiV3(ctx, v3FillsTitle, ptr("新标题")))
	require.NoError(t, q.UpdateBangumiV3(ctx, v3ReplaceTitle, ptr("新标题")))
	require.NoError(t, q.UpdateBangumiV3(ctx, v3StaysEmpty, nil))

	for id, want := range map[int32]*string{
		v3KeepsTitle:   ptr("有兽焉 第四季"),
		v3FillsTitle:   ptr("新标题"),
		v3ReplaceTitle: ptr("新标题"),
		v3StaysEmpty:   nil,
	} {
		var got *string
		var version int32
		require.NoError(t, tx.QueryRow(ctx, `SELECT title_chinese, bangumi_version FROM anime_cache WHERE anilist_id = $1`, id).Scan(&got, &version))
		require.Equal(t, want, got, "title_chinese of %d", id)
		require.Equal(t, int32(3), version, "V3 is terminal whatever it found (%d)", id)
	}
}

