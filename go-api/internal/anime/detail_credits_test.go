package anime

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/credits"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// creditsMedia is a detail Media whose character and staff pages hold
// the given ids (each character voiced by Japanese actor voiceBase+id),
// with pageInfo saying whether there is a second page.
func creditsMedia(id int, characterIDs, staffIDs []int, voiceBase int, hasNext bool) anilist.Media {
	chars := make([]anilist.CharacterEdge, 0, len(characterIDs))
	for _, c := range characterIDs {
		chars = append(chars, anilist.CharacterEdge{
			Role: sptr("SUPPORTING"),
			Node: anilist.CharacterNode{ID: c, Name: &anilist.PersonName{Full: sptr(fmt.Sprintf("C%d", c))}},
			VoiceActorRoles: []anilist.VoiceActorRole{{VoiceActor: &anilist.VoiceActor{
				ID: voiceBase + c, Name: &anilist.PersonName{Full: sptr(fmt.Sprintf("V%d", voiceBase+c))}, LanguageV2: sptr("Japanese"),
			}}},
		})
	}
	staff := make([]anilist.StaffEdge, 0, len(staffIDs))
	for _, s := range staffIDs {
		staff = append(staff, anilist.StaffEdge{Role: sptr("Key Animation"), Node: anilist.StaffNode{ID: s, Name: &anilist.PersonName{Full: sptr("S")}}})
	}
	return anilist.Media{
		ID:              id,
		Title:           &anilist.Title{Romaji: sptr("Credits Title")},
		CountryOfOrigin: sptr("JP"),
		Characters:      &anilist.CharacterConnection{PageInfo: &anilist.PageInfo{HasNextPage: hasNext}, Edges: chars},
		Staff:           &anilist.StaffConnection{PageInfo: &anilist.PageInfo{HasNextPage: hasNext}, Edges: staff},
	}
}

func idRange(from, to int) []int {
	out := make([]int, 0, to-from+1)
	for i := from; i <= to; i++ {
		out = append(out, i)
	}
	return out
}

// TestDetail_RefetchWritesCreditsByPageInfo — the refresh's credit write
// is chosen by what AniList said about page 2: a page with more after it
// is written as the first page (keep the rest, renumber after it), a
// page that is also the last is the whole list (prune the rest, no
// renumber), and the flag is recorded either way.
func TestDetail_RefetchWritesCreditsByPageInfo(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name    string
		hasNext bool
		want    []string
	}{
		{"more pages: first-page write", true, []string{
			"prune characters keep=25 whole=false", "renumber characters from 25", "prune voices of 25",
			"prune staff keep=25 whole=false", "renumber staff from 25",
		}},
		{"last page: whole-list write", false, []string{
			"prune characters keep=25 whole=true", "prune voices of 25",
			"prune staff keep=25 whole=true",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var reads atomic.Int32
			db := &detailFakeDB{
				getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
					if reads.Add(1) == 1 {
						return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
					}
					return dbgen.GetAnimeMainByIDRow{AnilistID: 7, CachedAt: freshTimestamp()}, nil
				},
			}
			media := creditsMedia(7, idRange(1, 25), idRange(101, 125), 1000, tc.hasNext)
			al := &fakeAniListDetailer{detailFn: func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
				return &anilist.AnimeDetailResponse{Media: media}, nil
			}}
			svc := newDetailServiceWithAniList(t, db, al)

			rec := serveDetail(t, svc, "/api/anime/7")
			require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

			db.mu.Lock()
			defer db.mu.Unlock()
			assert.Equal(t, tc.want, db.creditCalls)
			assert.Len(t, db.insertedVoices, 25)
			require.Len(t, db.hasMoreSets, 1)
			require.NotNil(t, db.hasMoreSets[0][0])
			require.NotNil(t, db.hasMoreSets[0][1])
			assert.Equal(t, tc.hasNext, *db.hasMoreSets[0][0])
			assert.Equal(t, tc.hasNext, *db.hasMoreSets[0][1])
		})
	}
}

// TestDetail_EmptyCreditPageIsNotWritten — an empty characters or staff
// page says nothing about what is stored, whatever its pageInfo says.
// Written as the whole list it would prune every row of the title, the
// credits sweep's included, and record has_more false, which takes the
// title out of the sweep.  So the refresh writes neither the empty list
// nor its flag, and the list that did arrive is written as usual.
func TestDetail_EmptyCreditPageIsNotWritten(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name      string
		chars     []int
		staff     []int
		want      []string
		castFlag  bool
		staffFlag bool
	}{
		{name: "both empty"},
		{name: "characters empty", staff: idRange(101, 110),
			want: []string{"prune staff keep=10 whole=true"}, staffFlag: true},
		{name: "staff empty", chars: idRange(1, 10),
			want: []string{"prune characters keep=10 whole=true", "prune voices of 10"}, castFlag: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var reads atomic.Int32
			db := &detailFakeDB{
				getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
					if reads.Add(1) == 1 {
						return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
					}
					return dbgen.GetAnimeMainByIDRow{AnilistID: 7, CachedAt: freshTimestamp()}, nil
				},
			}
			// hasNext=false: the page AniList calls the last, which is
			// what would have made an empty one a whole-list delete.
			media := creditsMedia(7, tc.chars, tc.staff, 1000, false)
			al := &fakeAniListDetailer{detailFn: func(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
				return &anilist.AnimeDetailResponse{Media: media}, nil
			}}
			svc := newDetailServiceWithAniList(t, db, al)

			rec := serveDetail(t, svc, "/api/anime/7")
			require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

			db.mu.Lock()
			defer db.mu.Unlock()
			assert.Equal(t, tc.want, db.creditCalls, "no prune for an empty list")
			if !tc.castFlag && !tc.staffFlag {
				assert.Empty(t, db.hasMoreSets, "no flag to record")
				return
			}
			require.Len(t, db.hasMoreSets, 1)
			assert.Equal(t, tc.castFlag, db.hasMoreSets[0][0] != nil, "cast flag")
			assert.Equal(t, tc.staffFlag, db.hasMoreSets[0][1] != nil, "staff flag")
		})
	}
}

// TestDetail_RefreshKeepsTheSweepsCredits_PG is the property this change
// exists for, through the real refresh path and the real read: the sweep
// has stored a title's whole cast and staff, then the 24h refresh reads
// AniList's first page again.  Before 0042 the refresh deleted every row
// and inserted the page, so the sweep's work lasted a day.  Now the rows
// beyond the page survive, /api/anime/:id still answers with exactly the
// first 25, and a first page that AniList says is the last does replace
// everything.
func TestDetail_RefreshKeepsTheSweepsCredits_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)
	svc, err := NewDetailService(q, nil)
	require.NoError(t, err)
	t.Cleanup(svc.Close)

	const id = 154587
	media := creditsMedia(id, idRange(1, 25), idRange(101, 125), 1000, true)
	require.NoError(t, svc.upsertFromMedia(ctx, id, media))

	// The sweep's pass: 87 characters and 60 staff, in AniList's order.
	sweep := creditsMedia(id, idRange(1, 87), idRange(101, 160), 1000, false)
	require.NoError(t, credits.WriteCast(ctx, q, id, CastFromMedia(sweep), credits.WholeList))
	require.NoError(t, credits.WriteStaff(ctx, q, id, StaffFromMedia(sweep), credits.WholeList))

	// The next refresh: page 1 again, with one newcomer (99) in it.
	page1 := append(idRange(1, 24), 99)
	require.NoError(t, svc.upsertFromMedia(ctx, id, creditsMedia(id, page1, idRange(101, 125), 3000, true)))

	count := func(sql string) int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql, id).Scan(&n))
		return n
	}
	assert.Equal(t, 88, count(`SELECT count(*) FROM anime_characters WHERE anime_id = $1`),
		"87 from the sweep plus the newcomer: the refresh deleted none of them")
	assert.Equal(t, 60, count(`SELECT count(*) FROM anime_staff WHERE anime_id = $1`))
	assert.Equal(t, 88, count(`SELECT count(*) FROM anime_character_voices WHERE anime_id = $1`))
	assert.Equal(t, 3001, count(`SELECT staff_id FROM anime_character_voices WHERE anime_id = $1 AND character_id = 1`),
		"page-1 voices come from the refresh")
	assert.Equal(t, 1050, count(`SELECT staff_id FROM anime_character_voices WHERE anime_id = $1 AND character_id = 50`),
		"voices beyond page 1 stay the sweep's")
	assert.Equal(t, 1, count(`SELECT count(*) FROM anime_cache WHERE anilist_id = $1 AND cast_has_more AND staff_has_more`))

	detail, err := svc.fetchDetail(ctx, id)
	require.NoError(t, err)
	require.Len(t, detail.Characters, 25, "the API answers with AniList's first page and no more")
	require.Len(t, detail.Staff, 25)
	for i, c := range detail.Characters {
		assert.Equal(t, int32(page1[i]), *c.CharacterID, "position %d", i)
	}
	assert.Equal(t, "V3099", *detail.Characters[24].VoiceActorEn)

	// A refresh whose pages come back empty, the last saying there is no
	// more, keeps every row and both flags: an empty answer is not the
	// whole list.
	require.NoError(t, svc.upsertFromMedia(ctx, id, creditsMedia(id, nil, nil, 1000, false)))
	assert.Equal(t, 88, count(`SELECT count(*) FROM anime_characters WHERE anime_id = $1`), "an empty page deletes nothing")
	assert.Equal(t, 60, count(`SELECT count(*) FROM anime_staff WHERE anime_id = $1`))
	assert.Equal(t, 88, count(`SELECT count(*) FROM anime_character_voices WHERE anime_id = $1`))
	assert.Equal(t, 1, count(`SELECT count(*) FROM anime_cache WHERE anilist_id = $1 AND cast_has_more AND staff_has_more`),
		"the title stays a credits-sweep candidate")

	// AniList now lists three characters and says that is all.
	require.NoError(t, svc.upsertFromMedia(ctx, id, creditsMedia(id, []int{5, 6, 7}, []int{101}, 1000, false)))
	assert.Equal(t, 3, count(`SELECT count(*) FROM anime_characters WHERE anime_id = $1`))
	assert.Equal(t, 1, count(`SELECT count(*) FROM anime_staff WHERE anime_id = $1`))
	assert.Equal(t, 3, count(`SELECT count(*) FROM anime_character_voices WHERE anime_id = $1`))
	assert.Equal(t, 1, count(`SELECT count(*) FROM anime_cache WHERE anilist_id = $1 AND NOT cast_has_more AND NOT staff_has_more`))
}
