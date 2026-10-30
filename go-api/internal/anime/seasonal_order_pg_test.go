package anime

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestSeasonalPagesAreDisjoint_PG — /api/anime/seasonal pages with
// LIMIT/OFFSET, so its ORDER BY has to be a total order. Sorting on
// average_score alone left equal scores in whatever order Postgres's sort
// happened to produce for that LIMIT, which differs between pages: the same
// show could close page 1 and open page 2 while another vanished from both.
// Ties are broken by anilist_id.
//
// The tied rows are inserted in descending id order so that "whatever order
// the sort leaves them in" and "by id" disagree.
func TestSeasonalPagesAreDisjoint_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	rows := []struct {
		id    int32
		score int32
	}{{9, 90}, {5, 80}, {4, 80}, {3, 80}, {2, 80}, {1, 80}}
	for _, r := range rows {
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, title_romaji, status, season, season_year, average_score, format, cover_image_url)
			VALUES ($1, 'row', 'RELEASING', 'FALL', 2026, $2, 'TV', 'https://cdn/x.jpg')`, r.id, r.score)
		require.NoError(t, err)
	}

	yr := int32(2026)
	var got []int32
	for page := int32(0); page < 3; page++ {
		res, err := q.GetSeasonalAnime(ctx, sptr("FALL"), &yr, 2, page*2)
		require.NoError(t, err)
		for _, r := range res {
			got = append(got, r.AnilistID)
		}
	}

	assert.Equal(t, []int32{9, 1, 2, 3, 4, 5}, got)
}
