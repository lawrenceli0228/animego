package anime

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// fullDetailMedia is a detail document with every child list the detail
// page shows: characters and staff (with a second page on AniList),
// genres, one relation and a trailer.
func fullDetailMedia(id int) anilist.Media {
	m := creditsMedia(id, idRange(1, 25), idRange(101, 125), 1000, true)
	m.Genres = []string{"Adventure", "Drama"}
	m.Relations = &anilist.RelationConnection{Edges: []anilist.RelationEdge{{
		RelationType: sptr("SEQUEL"),
		Node: anilist.RelationNode{
			ID:         id + 1,
			Title:      &anilist.Title{Romaji: sptr("Sequel")},
			CoverImage: &anilist.CoverImage{Large: sptr("https://img/sequel.jpg")},
			Format:     sptr("TV"),
		},
	}}}
	m.Trailer = &anilist.Trailer{ID: sptr("abcdefghijk"), Site: sptr("youtube")}
	return m
}

// TestEnsureCached_StoresWhatTheDetailPageReads_PG — a title subscribed
// to before anyone opened it.  EnsureCached fetches it with
// AnimeDetailQuery and stamps the row as detail-fetched; until this
// change it stored the main row alone, so the detail page served no
// characters, staff, genres or relations and, the row being fresh and
// stamped, kept doing so for a day.  The fill now stores the whole
// document, and the detail page reads it without going back to AniList.
func TestEnsureCached_StoresWhatTheDetailPageReads_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	const id = 154587
	require.NoError(t, EnsureCached(ctx, q, &ensureCachedFakeAniList{media: fullDetailMedia(id)}, id))

	al := &fakeAniListDetailer{}
	svc := newDetailServiceWithAniList(t, q, al)
	detail, err := svc.fetchDetail(ctx, id)
	require.NoError(t, err)
	assert.Zero(t, al.detailCalls.Load()+al.noWaitCalls.Load(), "the fill left the detail page nothing to fetch")

	assert.Len(t, detail.Characters, 25)
	assert.Len(t, detail.Staff, 25)
	assert.ElementsMatch(t, []string{"Adventure", "Drama"}, detail.Genres)
	require.Len(t, detail.Relations, 1)
	assert.Equal(t, int32(id+1), detail.Relations[0].AnilistID)

	var swept int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM anime_cache WHERE anilist_id = $1 AND cast_has_more AND staff_has_more`, id).Scan(&swept))
	assert.Equal(t, 1, swept, "the credits sweep sees the title's second pages")
}

// TestEnsureCached_ChildFailureDoesNotBlockTheSubscription — the
// subscription needs the main row, the foreign key's target; the child
// tables are for the detail page.  A failure writing them is logged and
// the subscription goes ahead, leaving the same partial state a failed
// detail refresh does.  A failure writing the main row is still an error.
func TestEnsureCached_ChildFailureDoesNotBlockTheSubscription(t *testing.T) {
	t.Parallel()

	miss := func(context.Context, int32) (dbgen.GetAnimeMainByIDRow, error) {
		return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
	}
	ac := &ensureCachedFakeAniList{media: fullDetailMedia(7)}

	db := &detailFakeDB{
		getAnimeMainByIDFn: miss,
		insertAnimeGenreFn: func(context.Context, int32, string) error { return errors.New("genre insert failed") },
	}
	require.NoError(t, EnsureCached(context.Background(), db, ac, 7))
	assert.Equal(t, int32(1), db.upsertMainCalls.Load())
	assert.Equal(t, int32(1), db.insertGenreCalls.Load(), "the fill tried to store the children")

	db = &detailFakeDB{
		getAnimeMainByIDFn: miss,
		upsertAnimeCacheFn: func(context.Context, dbgen.UpsertAnimeCacheParams) error { return errors.New("main upsert failed") },
	}
	require.Error(t, EnsureCached(context.Background(), db, ac, 7))
	assert.Zero(t, db.deleteGenresCalls.Load(), "no children without the row they belong to")
}
