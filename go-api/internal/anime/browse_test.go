package anime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// fakeBrowseDB records what each call was asked.  rowsFor, when set,
// answers per call; otherwise every call answers rows and total.
type fakeBrowseDB struct {
	listCalls  []dbgen.BrowseAnimeParams
	countCalls []dbgen.CountBrowseAnimeParams
	rows       []dbgen.BrowseAnimeRow
	total      int64
	rowsFor    func(dbgen.BrowseAnimeParams) []dbgen.BrowseAnimeRow
	totalFor   func(dbgen.CountBrowseAnimeParams) int64
	err        error
}

func (f *fakeBrowseDB) BrowseAnime(_ context.Context, arg dbgen.BrowseAnimeParams) ([]dbgen.BrowseAnimeRow, error) {
	f.listCalls = append(f.listCalls, arg)
	if f.err != nil {
		return nil, f.err
	}
	if f.rowsFor != nil {
		return f.rowsFor(arg), nil
	}
	return f.rows, nil
}

func (f *fakeBrowseDB) CountBrowseAnime(_ context.Context, arg dbgen.CountBrowseAnimeParams) (int64, error) {
	f.countCalls = append(f.countCalls, arg)
	if f.err != nil {
		return 0, f.err
	}
	if f.totalFor != nil {
		return f.totalFor(arg), nil
	}
	return f.total, nil
}

// lastList is the only list call, which a single request makes.
func (f *fakeBrowseDB) lastList(t *testing.T) dbgen.BrowseAnimeParams {
	t.Helper()
	require.Len(t, f.listCalls, 1)
	return f.listCalls[0]
}

func browseGet(db BrowseDB, query string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	Browse(db).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/browse?"+query, nil))
	return rec
}

// sameWhere is the WHERE half of a list call, which the count must match
// argument for argument: a total that counts a different set than the page
// lists is a pagination that lies.
func sameWhere(p dbgen.BrowseAnimeParams) dbgen.CountBrowseAnimeParams {
	return dbgen.CountBrowseAnimeParams{
		Genre: p.Genre, WithGenre: p.WithGenre, Studio: p.Studio, ReleaseYear: p.ReleaseYear,
		YearFrom: p.YearFrom, YearTo: p.YearTo, Status: p.Status,
		ByScore: p.ByScore, ScoreMinPopularity: p.ScoreMinPopularity,
	}
}

func TestParseBrowseQuery(t *testing.T) {
	t.Parallel()

	action, fantasy, mappa := "Action", "Fantasy", "MAPPA"
	releasing, hiatus := "RELEASING", "HIATUS"
	y := func(v int32) *int32 { return &v }
	const studioErr = "studio must be valid UTF-8 without NUL, at most 200 bytes"
	studioAtBound := strings.Repeat("a", browseMaxStudioBytes)
	studioCJK := "スタジオぴえろ"
	studioPunct := "Studio Cloud & <Sky>"

	for _, tc := range []struct {
		name string
		qs   string
		want browseQuery
		err  string // the 400's message; "" means the query parses
	}{
		// The key: exactly one of genre / studio / year.
		{name: "genre alone", qs: "genre=Action", want: browseQuery{genre: &action}},
		{name: "studio alone", qs: "studio=MAPPA", want: browseQuery{studio: &mappa}},
		{name: "year alone", qs: "year=2024", want: browseQuery{year: y(2024)}},
		{name: "year at the bounds", qs: "year=1900", want: browseQuery{year: y(1900)}},
		{name: "year at the upper bound", qs: "year=2100", want: browseQuery{year: y(2100)}},
		{name: "nothing is the whole catalogue, refused", qs: "", err: "exactly one of genre, studio or year is required"},
		{name: "two keys is a search, refused", qs: "genre=Action&year=2024", err: "exactly one of genre, studio or year is required"},
		{name: "three keys, refused", qs: "genre=Action&studio=MAPPA&year=2024", err: "exactly one of genre, studio or year is required"},
		{name: "blank key does not count", qs: "genre=%20%20&year=2024", want: browseQuery{year: y(2024)}},
		{name: "a key is trimmed", qs: "genre=%20Action%20", want: browseQuery{genre: &action}},
		{name: "non-numeric year", qs: "year=twenty", err: "year must be a year between 1900 and 2100"},
		{name: "year below range", qs: "year=1850", err: "year must be a year between 1900 and 2100"},
		{name: "year above range", qs: "year=2101", err: "year must be a year between 1900 and 2100"},

		// genre: a hub's, spelled as AniList spells it.
		{name: "a browsable genre of three words", qs: "genre=Slice%20of%20Life", want: browseQuery{genre: sptr("Slice of Life")}},
		{name: "genre not UTF-8", qs: "genre=%FF", err: "genre must be a browsable genre"},
		{name: "genre with a NUL", qs: "genre=Action%00", err: "genre must be a browsable genre"},
		{name: "genre unknown", qs: "genre=Nope", err: "genre must be a browsable genre"},
		{name: "genre Hentai is no hub", qs: "genre=Hentai", err: "genre must be a browsable genre"},
		{name: "genre is case-sensitive like the enum", qs: "genre=action", err: "genre must be a browsable genre"},

		// studio: free text, but text Postgres accepts, and of a studio's length.
		{name: "studio of any script", qs: "studio=" + url.QueryEscape(studioCJK), want: browseQuery{studio: &studioCJK}},
		{name: "studio with punctuation", qs: "studio=" + url.QueryEscape(studioPunct), want: browseQuery{studio: &studioPunct}},
		{name: "studio at the bound", qs: "studio=" + studioAtBound, want: browseQuery{studio: &studioAtBound}},
		{name: "studio past the bound", qs: "studio=" + studioAtBound + "a", err: studioErr},
		{name: "studio not UTF-8", qs: "studio=%C3%28", err: studioErr},
		{name: "studio with a NUL", qs: "studio=MAP%00PA", err: studioErr},

		// with: a second genre, on a genre listing only.
		{name: "with a second genre", qs: "genre=Action&with=Fantasy", want: browseQuery{genre: &action, withGenre: &fantasy}},
		{name: "with needs genre, not studio", qs: "studio=MAPPA&with=Fantasy", err: "with requires genre"},
		{name: "with needs genre, not year", qs: "year=2024&with=Fantasy", err: "with requires genre"},
		{name: "with the same genre", qs: "genre=Action&with=Action", err: "with must differ from genre"},
		{name: "with Hentai", qs: "genre=Action&with=Hentai", err: "with must be a browsable genre"},
		{name: "with an unknown genre", qs: "genre=Action&with=Isekai", err: "with must be a browsable genre"},
		{name: "with is case-sensitive like the enum", qs: "genre=Action&with=fantasy", err: "with must be a browsable genre"},
		{name: "blank with is absent", qs: "genre=Action&with=", want: browseQuery{genre: &action}},

		// status: AniList's enum, exactly.
		{name: "status RELEASING", qs: "genre=Action&status=RELEASING", want: browseQuery{genre: &action, status: &releasing}},
		{name: "status HIATUS", qs: "studio=MAPPA&status=HIATUS", want: browseQuery{studio: &mappa, status: &hiatus}},
		{name: "status lower-case", qs: "genre=Action&status=releasing", err: "invalid status"},
		{name: "status not an AniList value", qs: "genre=Action&status=AIRING", err: "invalid status"},

		// yearFrom / yearTo: inclusive, either or both, in order.
		{name: "both bounds", qs: "genre=Action&yearFrom=1990&yearTo=1999", want: browseQuery{genre: &action, yearFrom: y(1990), yearTo: y(1999)}},
		{name: "lower bound only", qs: "genre=Action&yearFrom=2020", want: browseQuery{genre: &action, yearFrom: y(2020)}},
		{name: "upper bound only", qs: "genre=Action&yearTo=1969", want: browseQuery{genre: &action, yearTo: y(1969)}},
		{name: "one-year range", qs: "genre=Action&yearFrom=2001&yearTo=2001", want: browseQuery{genre: &action, yearFrom: y(2001), yearTo: y(2001)}},
		{name: "bounds with a year key", qs: "year=2024&yearFrom=2020", want: browseQuery{year: y(2024), yearFrom: y(2020)}},
		{name: "bounds out of order", qs: "genre=Action&yearFrom=2000&yearTo=1999", err: "yearFrom must not be after yearTo"},
		{name: "yearFrom not a number", qs: "genre=Action&yearFrom=199x", err: "yearFrom must be a year between 1900 and 2100"},
		{name: "yearFrom below range", qs: "genre=Action&yearFrom=1899", err: "yearFrom must be a year between 1900 and 2100"},
		{name: "yearTo above range", qs: "genre=Action&yearTo=2101", err: "yearTo must be a year between 1900 and 2100"},

		// sort.
		{name: "sort popularity is the default order", qs: "genre=Action&sort=popularity", want: browseQuery{genre: &action}},
		{name: "sort score", qs: "genre=Action&sort=score", want: browseQuery{genre: &action, byScore: true}},
		{name: "blank sort is the default", qs: "genre=Action&sort=", want: browseQuery{genre: &action}},
		{name: "sort unknown", qs: "genre=Action&sort=rating", err: "sort must be popularity or score"},
		{name: "sort is case-sensitive", qs: "genre=Action&sort=Score", err: "sort must be popularity or score"},

		// Everything at once.
		{
			name: "every filter",
			qs:   "genre=Action&with=Fantasy&status=RELEASING&yearFrom=2010&yearTo=2019&sort=score",
			want: browseQuery{genre: &action, withGenre: &fantasy, status: &releasing, yearFrom: y(2010), yearTo: y(2019), byScore: true},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			qs, err := url.ParseQuery(tc.qs)
			require.NoError(t, err)
			got, apiErr := parseBrowseQuery(qs)
			if tc.err != "" {
				require.NotNil(t, apiErr)
				assert.Equal(t, http.StatusBadRequest, apiErr.Status)
				assert.Equal(t, httpx.CodeValidationError, apiErr.Code)
				assert.Equal(t, tc.err, apiErr.Message)
				return
			}
			require.Nil(t, apiErr)
			assert.Equal(t, tc.want, got)
		})
	}
}

// TestBrowseQuery_ParamsShareTheWhere — the page and its total are asked
// with the same filter arguments, the score floor included, whatever the
// query.
func TestBrowseQuery_ParamsShareTheWhere(t *testing.T) {
	t.Parallel()

	for _, qs := range []string{
		"genre=Action",
		"studio=MAPPA&status=FINISHED",
		"year=2024&sort=score",
		"genre=Action&with=Fantasy&status=RELEASING&yearFrom=2010&yearTo=2019&sort=score",
	} {
		t.Run(qs, func(t *testing.T) {
			v, _ := url.ParseQuery(qs)
			q, apiErr := parseBrowseQuery(v)
			require.Nil(t, apiErr)
			list := q.listParams(48, 24)
			assert.Equal(t, sameWhere(list), q.countParams())
			assert.Equal(t, int32(48), list.RowOffset)
			assert.Equal(t, int32(24), list.RowLimit)
			assert.Equal(t, int32(browseScoreMinPopularity), list.ScoreMinPopularity,
				"the floor is passed whether or not the order uses it, so the statement is one")
		})
	}
}

func TestBrowse_PaginationAndEnvelope(t *testing.T) {
	t.Parallel()

	db := &fakeBrowseDB{rows: []dbgen.BrowseAnimeRow{{AnilistID: 1}, {AnilistID: 2}}, total: 130}
	rec := browseGet(db, "genre=Action&page=3&perPage=999")

	require.Equal(t, http.StatusOK, rec.Code)
	list := db.lastList(t)
	require.NotNil(t, list.Genre)
	assert.Equal(t, "Action", *list.Genre)
	assert.Nil(t, list.Studio)
	assert.Nil(t, list.ReleaseYear)
	assert.Equal(t, int32(browseMaxPerPage), list.RowLimit, "perPage is capped")
	assert.Equal(t, int32(2*browseMaxPerPage), list.RowOffset, "offset is (page-1)*perPage after the cap")

	var env struct {
		Data []struct {
			AnilistID int32 `json:"anilistId"`
		} `json:"data"`
		Pagination seasonalPagination `json:"pagination"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	assert.Len(t, env.Data, 2)
	assert.Equal(t, seasonalPagination{Page: 3, PerPage: browseMaxPerPage, Total: 130, TotalPages: 3}, env.Pagination)
}

func TestBrowse_RefusesAmbiguousFilter(t *testing.T) {
	t.Parallel()

	assert.Equal(t, http.StatusBadRequest, browseGet(&fakeBrowseDB{}, "genre=Action&studio=MAPPA").Code)
	assert.Equal(t, http.StatusBadRequest, browseGet(&fakeBrowseDB{}, "").Code)
}

func TestBrowse_PageIsBounded(t *testing.T) {
	t.Parallel()

	db := &fakeBrowseDB{}
	browseGet(db, "year=2024&page=99999")
	assert.Equal(t, int32((browseMaxPage-1)*browseDefaultPerPage), db.lastList(t).RowOffset,
		"an unbounded page would be an unbounded OFFSET")
}

// TestBrowse_FiltersReachBothQueries — every filter the request names
// arrives at the list query and, identically, at the count.
func TestBrowse_FiltersReachBothQueries(t *testing.T) {
	t.Parallel()

	db := &fakeBrowseDB{}
	rec := browseGet(db, "genre=Action&with=Sci-Fi&status=FINISHED&yearFrom=1990&yearTo=1999&sort=score&page=2&perPage=36")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	list := db.lastList(t)
	assert.Equal(t, sptr("Action"), list.Genre)
	assert.Equal(t, sptr("Sci-Fi"), list.WithGenre)
	assert.Equal(t, sptr("FINISHED"), list.Status)
	assert.Equal(t, i32(1990), list.YearFrom)
	assert.Equal(t, i32(1999), list.YearTo)
	assert.True(t, list.ByScore)
	assert.Equal(t, int32(browseScoreMinPopularity), list.ScoreMinPopularity)
	assert.Equal(t, int32(36), list.RowOffset)
	assert.Equal(t, int32(36), list.RowLimit)

	require.Len(t, db.countCalls, 1)
	assert.Equal(t, sameWhere(list), db.countCalls[0])
}

// TestBrowse_InvalidFilterIsAValidationError — a key or a filter that is
// present but wrong is refused before any query runs, in the error
// envelope: bytes Postgres would refuse never reach it to make a 500.
func TestBrowse_InvalidFilterIsAValidationError(t *testing.T) {
	t.Parallel()

	for qs, msg := range map[string]string{
		"genre=Action&status=airing":             "invalid status",
		"genre=Action&yearFrom=2020&yearTo=2010": "yearFrom must not be after yearTo",
		"genre=Action&sort=newest":               "sort must be popularity or score",
		"studio=MAPPA&with=Action":               "with requires genre",
		"genre=%FF":                              "genre must be a browsable genre",
		"genre=Action%00":                        "genre must be a browsable genre",
		"genre=Hentai":                           "genre must be a browsable genre",
		"studio=%C3%28":                          "studio must be valid UTF-8 without NUL, at most 200 bytes",
		"studio=%00":                             "studio must be valid UTF-8 without NUL, at most 200 bytes",
	} {
		t.Run(qs, func(t *testing.T) {
			db := &fakeBrowseDB{}
			rec := browseGet(db, qs)
			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Equal(t, `{"error":{"code":"VALIDATION_ERROR","message":"`+msg+`"}}`, rec.Body.String())
			assert.Empty(t, db.listCalls)
			assert.Empty(t, db.countCalls)
		})
	}
}

func TestBrowse_QueryErrorIs500(t *testing.T) {
	t.Parallel()

	rec := browseGet(&fakeBrowseDB{err: errors.New("connection reset")}, "genre=Action")
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, `{"error":{"code":"SERVER_ERROR","message":"query failed"}}`, rec.Body.String())
}

// TestBrowse_LegacyFieldsEncodeAsBefore — /browse answered with the sqlc
// row itself until its items became seasonal items, and the hub pages and
// the sitemap read it.  Every field that existed then comes out byte for
// byte as it did, in the same order, with the seasonal page's fields
// appended.  The legacy constants are the seasonal ones: the old browse
// row had exactly those columns, and these bytes were checked against the
// old handler before it changed.
func TestBrowse_LegacyFieldsEncodeAsBefore(t *testing.T) {
	t.Parallel()

	const page1Of1 = `,"pagination":{"page":1,"perPage":24,"total":2,"totalPages":1}}`

	t.Run("legacy columns only", func(t *testing.T) {
		db := &fakeBrowseDB{rows: []dbgen.BrowseAnimeRow{
			dbgen.BrowseAnimeRow(seasonalLegacyFullRow()),
			{AnilistID: 7},
		}, total: 2}
		rec := browseGet(db, "genre=Drama")
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, `{"data":[`+
			seasonalLegacyFullJSON+seasonalNullNewFieldsJSON+`,`+
			seasonalLegacyEmptyJSON+seasonalNullNewFieldsJSON+
			`]`+page1Of1, rec.Body.String())
	})

	t.Run("new columns set leave the legacy bytes alone", func(t *testing.T) {
		row := dbgen.BrowseAnimeRow(seasonalLegacyFullRow())
		row.MainStudio = []string{"Studio Cloud & <Sky>"}
		row.NextAiringAt = pgtype.Timestamptz{Time: time.Date(2026, 10, 22, 22, 0, 0, 0, time.FixedZone("UTC+8", 8*60*60)), Valid: true}
		row.NextAiringEpisode = i32(4)
		row.Popularity = i32(123456)
		row.Favourites = i32(7890)
		row.Source = sptr("LIGHT_NOVEL")
		row.StartDate = pgtype.Date{Time: time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), Valid: true}
		row.Duration = i32(24)
		row.IsSequel = true
		row.RelationsKnown = true

		rec := browseGet(&fakeBrowseDB{rows: []dbgen.BrowseAnimeRow{row, {AnilistID: 7, RelationsKnown: true}}, total: 2}, "genre=Drama")
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, `{"data":[`+
			seasonalLegacyFullJSON+
			`,"studio":"Studio Cloud & <Sky>","nextAiringAt":"2026-10-22T14:00:00Z","nextAiringEpisode":4,`+
			`"popularity":123456,"favourites":7890,"source":"LIGHT_NOVEL","startDate":"2026-10-02",`+
			`"duration":24,"isSequel":true},`+
			seasonalLegacyEmptyJSON+
			`,"studio":null,"nextAiringAt":null,"nextAiringEpisode":null,"popularity":null,"favourites":null,`+
			`"source":null,"startDate":null,"duration":null,"isSequel":false}`+
			`]`+page1Of1, rec.Body.String())
	})

	t.Run("an empty page is still []", func(t *testing.T) {
		rec := browseGet(&fakeBrowseDB{}, "year=1901")
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, `{"data":[],"pagination":{"page":1,"perPage":24,"total":0,"totalPages":0}}`, rec.Body.String())
	})
}

// TestSeasonalItemFromBrowseRow_IsTheSeasonalMapping — a browse row and a
// seasonal row with the same columns make the same item.
func TestSeasonalItemFromBrowseRow_IsTheSeasonalMapping(t *testing.T) {
	t.Parallel()

	row := seasonalLegacyFullRow()
	row.MainStudio = []string{"Alpha"}
	row.NextAiringAt = pgtype.Timestamptz{Time: time.Date(2026, 10, 22, 14, 0, 0, 0, time.UTC), Valid: true}
	row.NextAiringEpisode = i32(4)
	row.StartDate = pgtype.Date{Time: time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), Valid: true}
	row.IsSequel = true
	row.RelationsKnown = true

	assert.Equal(t, seasonalItemFromRow(row), seasonalItemFromBrowseRow(dbgen.BrowseAnimeRow(row)))
	assert.Nil(t, seasonalItemFromBrowseRow(dbgen.BrowseAnimeRow{IsSequel: true}).IsSequel,
		"relations not known yet: null, whatever the EXISTS said")

	got := seasonalItemsFromBrowseRows(nil)
	require.NotNil(t, got)
	assert.Empty(t, got)
}
