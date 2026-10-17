package anime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// seasonalWireItem is what a client reads off /api/anime/seasonal for the
// fields these tests are about.  Pointers throughout, so "null" and
// "absent" can be told from a zero value.
type seasonalWireItem struct {
	AnilistID         int32    `json:"anilistId"`
	Genres            []string `json:"genres"`
	Studio            *string  `json:"studio"`
	NextAiringAt      *string  `json:"nextAiringAt"`
	NextAiringEpisode *int32   `json:"nextAiringEpisode"`
	Popularity        *int32   `json:"popularity"`
	Favourites        *int32   `json:"favourites"`
	Source            *string  `json:"source"`
	StartDate         *string  `json:"startDate"`
	Duration          *int32   `json:"duration"`
	IsSequel          *bool    `json:"isSequel"`
}

// seasonalNewKeys are the keys this endpoint gained for the seasonal
// page.  Every item carries every one of them, null or not.
var seasonalNewKeys = []string{
	"studio", "nextAiringAt", "nextAiringEpisode", "popularity", "favourites",
	"source", "startDate", "duration", "isSequel",
}

type seasonalWire struct {
	Data       []seasonalWireItem `json:"data"`
	Pagination struct {
		Total int `json:"total"`
	} `json:"pagination"`
}

// getSeasonalPG runs one request through the handler and returns the raw
// body and its decoded form, after checking every item has every new key.
func getSeasonalPG(t *testing.T, h http.Handler, query string) (string, seasonalWire) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?"+query, nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body := rec.Body.String()

	var raw struct {
		Data []map[string]json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &raw))
	for _, item := range raw.Data {
		for _, k := range seasonalNewKeys {
			assert.Contains(t, item, k, "every item carries %q, null or not", k)
		}
	}

	var parsed seasonalWire
	require.NoError(t, json.Unmarshal([]byte(body), &parsed))
	return body, parsed
}

func seasonalIDs(items []seasonalWireItem) []int32 {
	out := make([]int32, 0, len(items))
	for _, it := range items {
		out = append(out, it.AnilistID)
	}
	return out
}

func seasonalByID(t *testing.T, items []seasonalWireItem, id int32) seasonalWireItem {
	t.Helper()
	for _, it := range items {
		if it.AnilistID == id {
			return it
		}
	}
	require.Failf(t, "missing", "anilistId %d not in the response", id)
	return seasonalWireItem{}
}

// seasonalPGMedia is a title as AniList's documents state it, minimal
// enough that each test adds only what it is about.
func seasonalPGMedia(id int, season string, year int, score *int) anilist.Media {
	return anilist.Media{
		ID:           id,
		Title:        &anilist.Title{Romaji: sptr(fmt.Sprintf("Title %d", id))},
		Season:       sptr(season),
		SeasonYear:   iptr(year),
		AverageScore: score,
		Format:       sptr("TV"),
	}
}

func seasonalStudios(edges ...anilist.StudioEdge) *anilist.StudioConnection {
	return &anilist.StudioConnection{Edges: edges}
}

func seasonalStudio(name string, isMain bool) anilist.StudioEdge {
	return anilist.StudioEdge{IsMain: isMain, Node: anilist.Studio{Name: name}}
}

func seasonalRelations(edges ...anilist.RelationEdge) *anilist.RelationConnection {
	return &anilist.RelationConnection{Edges: edges}
}

// seasonalRelation is one relation edge; an empty format is AniList
// stating none.
func seasonalRelation(id int, relationType, format string) anilist.RelationEdge {
	e := anilist.RelationEdge{RelationType: sptr(relationType), Node: anilist.RelationNode{ID: id}}
	if format != "" {
		e.Node.Format = sptr(format)
	}
	return e
}

// TestSeasonal_PG_NewFieldsFromTheTables — the warm path over real tables,
// with the child rows written by the code that writes them in production
// (the detail fetch).
//
// What it pins: the main studio is the alphabetically first of the main
// studios and a non-main studio never counts, however it sorts; a title
// with two main studios is still one item, whatever shape the studio
// lookup takes; isSequel counts a PREQUEL that is an anime and not one
// that is a manga, a novel or of no stated format; a title the detail fetch
// reached with none of the new facts answers null for each and false for
// isSequel (known: no anime prequel), while a title only a listing wrote
// answers null for isSequel too (see the cold-start test); and the
// listing itself -- which titles, in which order, how many -- is what it
// was: adult titles out by column and by genre, other seasons out, score
// descending with unscored titles last.
func TestSeasonal_PG_NewFieldsFromTheTables(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	detail, err := NewDetailService(q, nil)
	require.NoError(t, err)
	t.Cleanup(detail.Close)
	seed := func(m anilist.Media) {
		t.Helper()
		require.NoError(t, detail.upsertFromMedia(ctx, int32(m.ID), m))
	}

	sequel := seasonalPGMedia(1001, "FALL", 2031, iptr(90))
	sequel.Genres = []string{"Drama", "Action"}
	sequel.Popularity = iptr(5000)
	sequel.Favourites = iptr(300)
	sequel.Source = sptr("MANGA")
	sequel.StartDate = &anilist.FuzzyDate{Year: iptr(2031), Month: iptr(10), Day: iptr(3)}
	sequel.Duration = iptr(24)
	sequel.NextAiringEpisode = &anilist.NextAiringEpisode{AiringAt: 1950618600, Episode: 4} // 2031-10-24 14:30 UTC
	sequel.Studios = seasonalStudios(
		seasonalStudio("Zeta Studio", true),
		seasonalStudio("Alpha Studio", true),
		seasonalStudio("Aardvark Licensing", false), // sorts first, is not a main studio
	)
	sequel.Relations = seasonalRelations(
		seasonalRelation(900, "PREQUEL", "TV"),
		seasonalRelation(901, "SEQUEL", "TV"),
	)
	seed(sequel)

	ovaPrequel := seasonalPGMedia(1002, "FALL", 2031, iptr(85))
	ovaPrequel.Studios = seasonalStudios(seasonalStudio("Studio Bind", true))
	ovaPrequel.Relations = seasonalRelations(seasonalRelation(910, "PREQUEL", "OVA"))
	seed(ovaPrequel)

	printPrequels := seasonalPGMedia(1003, "FALL", 2031, iptr(80))
	printPrequels.Studios = seasonalStudios(seasonalStudio("Some Committee", false))
	printPrequels.Relations = seasonalRelations(
		seasonalRelation(920, "PREQUEL", "MANGA"),
		seasonalRelation(921, "PREQUEL", "NOVEL"),
		seasonalRelation(922, "PREQUEL", ""),
		seasonalRelation(923, "ADAPTATION", "MANGA"),
		seasonalRelation(924, "SEQUEL", "TV"),
	)
	seed(printPrequels)

	seed(seasonalPGMedia(1004, "FALL", 2031, nil)) // nothing known

	hentai := seasonalPGMedia(1005, "FALL", 2031, iptr(99))
	hentai.Genres = []string{"Hentai"}
	seed(hentai)
	adult := seasonalPGMedia(1006, "FALL", 2031, iptr(98))
	adult.IsAdult = func() *bool { b := true; return &b }()
	seed(adult)
	seed(seasonalPGMedia(1007, "SUMMER", 2031, iptr(97)))

	// Let the planner see the tables as they are.  On a table it has no
	// statistics for, it reads anime_studios through the primary key,
	// (anime_id, studio), which hands rows back in name order whether or
	// not the query asks for that order.  With statistics it reads the heap
	// instead, as it does on a catalogue-sized table (a bitmap heap scan
	// there), and rows come back in insertion order -- AniList's edge
	// order, Zeta before Alpha here.  Only then does a missing ORDER BY
	// show.
	_, err = pool.Exec(ctx, "ANALYZE anime_studios")
	require.NoError(t, err)

	h := NewSeasonalService(q, nil).Handler()
	body, got := getSeasonalPG(t, h, "season=FALL&year=2031&perPage=200")

	t.Run("listing unchanged: membership, order, total", func(t *testing.T) {
		assert.Equal(t, []int32{1001, 1002, 1003, 1004}, seasonalIDs(got.Data),
			"adult (column and genre) and other-season titles out; score desc, unscored last; one item per title")
		assert.Equal(t, 4, got.Pagination.Total)
		assert.Equal(t, []string{"Action", "Drama"}, seasonalByID(t, got.Data, 1001).Genres)
	})

	t.Run("main studio: first main by name, non-main ignored", func(t *testing.T) {
		assert.Equal(t, sptr("Alpha Studio"), seasonalByID(t, got.Data, 1001).Studio)
		assert.Equal(t, sptr("Studio Bind"), seasonalByID(t, got.Data, 1002).Studio)
		assert.Nil(t, seasonalByID(t, got.Data, 1003).Studio, "a non-main studio is not the studio")
		assert.Nil(t, seasonalByID(t, got.Data, 1004).Studio)

		// The detail page's Studio row lists the same studio first.
		studios, err := q.GetAnimeStudiosByID(ctx, 1001)
		require.NoError(t, err)
		assert.Equal(t, []string{"Alpha Studio", "Zeta Studio"}, studios)
	})

	t.Run("isSequel: an anime prequel only", func(t *testing.T) {
		assert.Equal(t, true, *seasonalByID(t, got.Data, 1001).IsSequel, "PREQUEL TV")
		assert.Equal(t, true, *seasonalByID(t, got.Data, 1002).IsSequel, "PREQUEL OVA")
		assert.Equal(t, false, *seasonalByID(t, got.Data, 1003).IsSequel, "PREQUEL MANGA / NOVEL / no format")
		assert.Equal(t, false, *seasonalByID(t, got.Data, 1004).IsSequel, "no relations")
	})

	t.Run("the facts, as the contract encodes them", func(t *testing.T) {
		// The exact bytes: UTC whatever zone pgx scanned the instant into
		// (this process's local one), a calendar date, numbers as numbers.
		assert.Contains(t, body, `"studio":"Alpha Studio","nextAiringAt":"2031-10-24T14:30:00Z","nextAiringEpisode":4,`+
			`"popularity":5000,"favourites":300,"source":"MANGA","startDate":"2031-10-03","duration":24,"isSequel":true}`)
		assert.Contains(t, body, `"anilistId":1004,`)
		assert.Contains(t, body, `"studio":null,"nextAiringAt":null,"nextAiringEpisode":null,"popularity":null,`+
			`"favourites":null,"source":null,"startDate":null,"duration":null,"isSequel":false}`)
	})

	t.Run("every anime format counts as a prequel, no print format does", func(t *testing.T) {
		formats := map[string]bool{
			"TV": true, "TV_SHORT": true, "MOVIE": true, "SPECIAL": true, "OVA": true, "ONA": true, "MUSIC": true,
			"MANGA": false, "NOVEL": false, "ONE_SHOT": false,
		}
		want := map[int32]bool{}
		id := 1100
		for format, isAnime := range formats {
			id++
			m := seasonalPGMedia(id, "SPRING", 2031, iptr(50))
			m.Relations = seasonalRelations(seasonalRelation(id+1000, "PREQUEL", format))
			seed(m)
			want[int32(id)] = isAnime
		}
		_, spring := getSeasonalPG(t, h, "season=SPRING&year=2031&perPage=200")
		require.Len(t, spring.Data, len(formats))
		for _, it := range spring.Data {
			require.NotNil(t, it.IsSequel)
			assert.Equal(t, want[it.AnilistID], *it.IsSequel, "anilistId %d", it.AnilistID)
		}
	})
}

// TestSeasonal_PG_ColdStartReturnsTheNewFields — a season nothing has
// cached yet, fetched from AniList, upserted and read back: the first
// response already carries the facts SeasonalAnimeQuery selects, the
// second (warm) one answers the same from the rows the first wrote, and
// the two child-table fields stay "not known yet" until the detail fetch
// reaches the title -- after which the listing shows them.
func TestSeasonal_PG_ColdStartReturnsTheNewFields(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)

	airing := seasonalPGMedia(2001, "WINTER", 2032, iptr(70))
	airing.StartDate = &anilist.FuzzyDate{Year: iptr(2032), Month: iptr(1), Day: iptr(8)}
	airing.Duration = iptr(24)
	airing.Source = sptr("ORIGINAL")
	airing.Popularity = iptr(4321)
	airing.Favourites = iptr(210)
	airing.NextAiringEpisode = &anilist.NextAiringEpisode{AiringAt: 1957183200, Episode: 1} // 2032-01-08 14:00 UTC

	// AniList knows only the year, nothing else yet.
	yearOnly := seasonalPGMedia(2002, "WINTER", 2032, nil)
	yearOnly.StartDate = &anilist.FuzzyDate{Year: iptr(2032)}
	yearOnly.Popularity = iptr(12)
	yearOnly.Favourites = iptr(0)

	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return &anilist.SeasonalAnimeResponse{Page: anilist.MediaPage{
				PageInfo: anilist.PageInfo{Total: 2, CurrentPage: 1, LastPage: 1, PerPage: 50},
				Media:    []anilist.Media{airing, yearOnly},
			}}, nil
		},
	}
	h := NewSeasonalService(q, al).Handler()
	const query = "season=WINTER&year=2032&perPage=200"

	checkFacts := func(t *testing.T, got seasonalWire) {
		t.Helper()
		require.Equal(t, []int32{2001, 2002}, seasonalIDs(got.Data))

		a := seasonalByID(t, got.Data, 2001)
		assert.Equal(t, sptr("2032-01-08"), a.StartDate)
		assert.Equal(t, i32(24), a.Duration)
		assert.Equal(t, sptr("ORIGINAL"), a.Source)
		assert.Equal(t, i32(4321), a.Popularity)
		assert.Equal(t, i32(210), a.Favourites)
		assert.Equal(t, sptr("2032-01-08T14:00:00Z"), a.NextAiringAt)
		assert.Equal(t, i32(1), a.NextAiringEpisode)
		assert.Nil(t, a.Studio, "anime_studios is written by the detail fetch only")
		assert.Nil(t, a.IsSequel, "anime_relations is written by the detail fetch only: not known yet, so null")

		y := seasonalByID(t, got.Data, 2002)
		assert.Nil(t, y.StartDate, "a year-only date is not a date")
		assert.Nil(t, y.Duration)
		assert.Nil(t, y.Source)
		assert.Equal(t, i32(12), y.Popularity)
		assert.Equal(t, i32(0), y.Favourites, "zero is a value, not null")
		assert.Nil(t, y.NextAiringAt)
		assert.Nil(t, y.NextAiringEpisode)
	}

	coldBody, cold := getSeasonalPG(t, h, query)
	require.Equal(t, int32(1), al.callCount(), "an empty season goes to AniList")
	checkFacts(t, cold)

	warmBody, warm := getSeasonalPG(t, h, query)
	assert.Equal(t, int32(1), al.callCount(), "the second request is served from the rows the first wrote")
	checkFacts(t, warm)
	assert.Equal(t, coldBody, warmBody, "cold and warm paths answer byte for byte the same")

	// The detail fetch reaches 2001 (a visit to its page): its children
	// are written, and the listing shows what was "not known yet".
	detail, err := NewDetailService(q, nil)
	require.NoError(t, err)
	t.Cleanup(detail.Close)
	full := airing
	full.Studios = seasonalStudios(seasonalStudio("Studio Pine", true))
	full.Relations = seasonalRelations(seasonalRelation(1999, "PREQUEL", "TV"))
	require.NoError(t, detail.upsertFromMedia(ctx, 2001, full))

	afterBody, after := getSeasonalPG(t, h, query)
	a := seasonalByID(t, after.Data, 2001)
	assert.Equal(t, sptr("Studio Pine"), a.Studio)
	assert.Equal(t, true, *a.IsSequel)
	assert.Equal(t, int32(1), al.callCount())
	assert.True(t, strings.Contains(afterBody, `"startDate":"2032-01-08","duration":24,"isSequel":true}`), afterBody)
}
