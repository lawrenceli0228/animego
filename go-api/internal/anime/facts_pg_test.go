package anime

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestUpsertAnimeCache_FactsSurviveListingUpsert is the pg-level half of
// the fix: the four facts written by a detail upsert must survive a later
// listing upsert that does not carry them, and the detail stamp must too.
// Both are ON CONFLICT semantics (COALESCE for the facts, CASE for the
// stamp), which is exactly the part no unit test over NormalizeMainRow
// can see.
func TestUpsertAnimeCache_FactsSurviveListingUpsert(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	media := anilist.Media{
		ID:        174184,
		Title:     &anilist.Title{Romaji: sptr("Dearest Blue")},
		StartDate: &anilist.FuzzyDate{Year: iptr(2024), Month: iptr(4), Day: iptr(26)},
		Duration:  iptr(23),
		Source:    sptr("VISUAL_NOVEL"),
	}

	// 1. Detail document: facts land, row is stamped.
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(media, anilist.DetailDocument)))
	row, err := q.GetAnimeMainByID(ctx, 174184)
	require.NoError(t, err)
	require.True(t, row.StartDate.Valid)
	assert.Equal(t, time.Date(2024, 4, 26, 0, 0, 0, 0, time.UTC), row.StartDate.Time)
	assert.False(t, row.EndDate.Valid, "AniList had no end date yet")
	require.NotNil(t, row.Duration)
	assert.Equal(t, int32(23), *row.Duration)
	require.NotNil(t, row.Source)
	assert.Equal(t, "VISUAL_NOVEL", *row.Source)
	require.True(t, row.DetailFetchedAt.Valid, "detail document must stamp the row")
	stampedAt := row.DetailFetchedAt.Time

	// 2. Listing document for the same id: no facts selected, no children
	//    selected.  Nothing it does not know may be erased.
	listing := anilist.Media{ID: 174184, Title: &anilist.Title{Romaji: sptr("Dearest Blue (listing)")}}
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(listing, anilist.SeasonalDocument)))
	row, err = q.GetAnimeMainByID(ctx, 174184)
	require.NoError(t, err)
	assert.Equal(t, "Dearest Blue (listing)", *row.TitleRomaji, "the listing's own columns do overwrite")
	require.True(t, row.StartDate.Valid, "start_date must survive a listing upsert")
	assert.Equal(t, time.Date(2024, 4, 26, 0, 0, 0, 0, time.UTC), row.StartDate.Time)
	require.NotNil(t, row.Duration)
	assert.Equal(t, int32(23), *row.Duration)
	require.NotNil(t, row.Source)
	assert.Equal(t, "VISUAL_NOVEL", *row.Source)
	require.True(t, row.DetailFetchedAt.Valid, "a listing upsert must not un-stamp the row")
	assert.True(t, row.DetailFetchedAt.Time.Equal(stampedAt), "stamp is the detail fetch's time, not the listing's")

	// 3. Detail document again, now with an end date: a newly known fact is
	//    written, the rest are overwritten with what AniList says now.
	media.EndDate = &anilist.FuzzyDate{Year: iptr(2024), Month: iptr(7), Day: iptr(12)}
	media.Duration = iptr(24)
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(media, anilist.DetailDocument)))
	row, err = q.GetAnimeMainByID(ctx, 174184)
	require.NoError(t, err)
	require.True(t, row.EndDate.Valid)
	assert.Equal(t, time.Date(2024, 7, 12, 0, 0, 0, 0, time.UTC), row.EndDate.Time)
	assert.Equal(t, int32(24), *row.Duration)
	assert.True(t, row.DetailFetchedAt.Time.After(stampedAt), "a second detail fetch re-stamps")
}

// TestMigration0034_StampsRowsWithChildRows exercises the one-time backfill
// in 0034: a row with child rows in a detail-only table is stamped with its
// cached_at; a row with none stays NULL; a row whose only child rows are
// genres (which the listing path also writes) stays NULL.
func TestMigration0034_StampsRowsWithChildRows(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)

	// Step back to the schema 0034 expects to find, plant rows, apply it.
	testutil.MigrateTo(t, uri, 33)
	cachedAt := time.Date(2026, 9, 14, 15, 24, 46, 0, time.UTC)
	for _, id := range []int32{1, 2, 3} {
		_, err := pool.Exec(ctx,
			`INSERT INTO anime_cache (anilist_id, title_romaji, cached_at) VALUES ($1, $2, $3)`,
			id, "row", cachedAt)
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx,
		`INSERT INTO anime_staff (anime_id, display_order, name_en, role) VALUES (1, 0, 'Someone', 'Director')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO anime_genres (anime_id, genre) VALUES (3, 'Action')`)
	require.NoError(t, err)

	testutil.MigrateTo(t, uri, 34)

	var got = map[int32]pgtype.Timestamptz{}
	rows, err := pool.Query(ctx, `SELECT anilist_id, detail_fetched_at FROM anime_cache ORDER BY anilist_id`)
	require.NoError(t, err)
	for rows.Next() {
		var id int32
		var ts pgtype.Timestamptz
		require.NoError(t, rows.Scan(&id, &ts))
		got[id] = ts
	}
	rows.Close()
	require.NoError(t, rows.Err())

	require.True(t, got[1].Valid, "row with a staff child is stamped")
	assert.True(t, got[1].Time.Equal(cachedAt), "stamp is the row's cached_at, not now()")
	assert.False(t, got[2].Valid, "row with no children stays NULL and pays one fetch")
	assert.False(t, got[3].Valid, "genres alone say nothing about the detail path")

	// Leave the schema where every other test expects it.
	testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
}

// TestUpsertAnimeCache_ScalarBlock — the 0036 columns land, a Media that
// did not decode isAdult leaves the stored flag alone, mal_id survives a
// null, and the synonym set is a whole replace on the detail path.
func TestUpsertAnimeCache_ScalarBlock(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	adult := true
	m := anilist.Media{
		ID:                7,
		Title:             &anilist.Title{Romaji: sptr("Row")},
		Popularity:        iptr(1000),
		Favourites:        iptr(10),
		IDMal:             iptr(555),
		IsAdult:           &adult,
		CountryOfOrigin:   sptr("JP"),
		NextAiringEpisode: &anilist.NextAiringEpisode{AiringAt: 1_800_000_000, Episode: 4},
	}
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(m, anilist.DetailDocument)))
	row, err := q.GetAnimeMainByID(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, int32(1000), *row.Popularity)
	assert.Equal(t, int32(10), *row.Favourites)
	assert.Equal(t, int32(555), *row.MalID)
	assert.True(t, row.IsAdult)
	assert.Equal(t, "JP", *row.CountryOfOrigin)
	require.True(t, row.NextAiringAt.Valid)
	assert.Equal(t, time.Unix(1_800_000_000, 0).UTC(), row.NextAiringAt.Time.UTC())
	assert.Equal(t, int32(4), *row.NextAiringEpisode)

	// A Media with nothing decoded: isAdult nil keeps true, mal_id keeps
	// 555, the plainly-written scalars go to what the document said (null).
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(anilist.Media{ID: 7, Title: &anilist.Title{Romaji: sptr("Row")}}, anilist.SearchDocument)))
	row, err = q.GetAnimeMainByID(ctx, 7)
	require.NoError(t, err)
	assert.True(t, row.IsAdult, "nil isAdult must not overwrite a stored true")
	assert.Equal(t, int32(555), *row.MalID, "mal_id COALESCEs")
	assert.Nil(t, row.Popularity, "popularity is written as stated, and this document stated nothing")
	assert.False(t, row.NextAiringAt.Valid, "an aired episode is cleared by the next read that says none is scheduled")

	// An explicit false does overwrite.
	notAdult := false
	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(anilist.Media{ID: 7, Title: &anilist.Title{Romaji: sptr("Row")}, IsAdult: &notAdult}, anilist.SearchDocument)))
	row, err = q.GetAnimeMainByID(ctx, 7)
	require.NoError(t, err)
	assert.False(t, row.IsAdult)
}

// TestListingsExcludeAdultRows — the four listings a visitor reaches
// without asking for adult content exclude is_adult rows: seasonal and
// its count (which also keep the genre exclusion), completed gems, and
// the yearly top.
func TestListingsExcludeAdultRows(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	for _, r := range []struct {
		id    int32
		adult bool
	}{{1, false}, {2, true}} {
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, title_romaji, status, season, season_year, average_score, format, cover_image_url, is_adult)
			VALUES ($1, 'row', 'FINISHED', 'WINTER', 2026, 80, 'TV', 'https://cdn/x.jpg', $2)`, r.id, r.adult)
		require.NoError(t, err)
	}

	yr := int32(2026)
	seasonal, err := q.GetSeasonalAnime(ctx, sptr("WINTER"), &yr, 10, 0)
	require.NoError(t, err)
	require.Len(t, seasonal, 1)
	assert.Equal(t, int32(1), seasonal[0].AnilistID)

	n, err := q.CountSeasonal(ctx, sptr("WINTER"), &yr)
	require.NoError(t, err)
	assert.Equal(t, int64(1), n)

	gems, err := q.GetCompletedGems(ctx, 10)
	require.NoError(t, err)
	require.Len(t, gems, 1)
	assert.Equal(t, int32(1), gems[0].AnilistID)

	top, err := q.GetYearlyTop(ctx, &yr, 10)
	require.NoError(t, err)
	require.Len(t, top, 1)
	assert.Equal(t, int32(1), top[0].AnilistID)
}

// TestCharacterAndStaffIDs_PG — the 0037 columns round-trip through the
// detail path's writer and reader, a NULL id is accepted (pre-0037 rows),
// and a non-positive id is refused at the column.
func TestCharacterAndStaffIDs_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)

	require.NoError(t, q.UpsertAnimeCache(ctx, NormalizeMainRow(anilist.Media{ID: 3, Title: &anilist.Title{Romaji: sptr("Row")}}, anilist.DetailDocument)))

	cid, vid, sid := int32(138100), int32(112215), int32(95000)
	require.NoError(t, q.InsertAnimeCharacter(ctx, dbgen.InsertAnimeCharacterParams{
		AnimeID: 3, DisplayOrder: 0, NameEn: sptr("Frieren"), CharacterID: &cid, VoiceActorID: &vid,
	}))
	require.NoError(t, q.InsertAnimeCharacter(ctx, dbgen.InsertAnimeCharacterParams{
		AnimeID: 3, DisplayOrder: 1, NameEn: sptr("legacy row"), // no ids
	}))
	require.NoError(t, q.InsertAnimeStaffMember(ctx, dbgen.InsertAnimeStaffMemberParams{
		AnimeID: 3, DisplayOrder: 0, NameEn: sptr("Director"), StaffID: &sid,
	}))

	chars, err := q.GetAnimeCharactersByID(ctx, 3)
	require.NoError(t, err)
	require.Len(t, chars, 2)
	assert.Equal(t, int32(138100), *chars[0].CharacterID)
	assert.Equal(t, int32(112215), *chars[0].VoiceActorID)
	assert.Nil(t, chars[1].CharacterID)
	assert.Nil(t, chars[1].VoiceActorID)

	staff, err := q.GetAnimeStaffByID(ctx, 3)
	require.NoError(t, err)
	require.Len(t, staff, 1)
	assert.Equal(t, int32(95000), *staff[0].StaffID)

	zero := int32(0)
	err = q.InsertAnimeCharacter(ctx, dbgen.InsertAnimeCharacterParams{AnimeID: 3, DisplayOrder: 2, CharacterID: &zero})
	require.Error(t, err, "a zero id must be refused at the column, not stored")
	err = q.InsertAnimeStaffMember(ctx, dbgen.InsertAnimeStaffMemberParams{AnimeID: 3, DisplayOrder: 1, StaffID: &zero})
	require.Error(t, err)
}
