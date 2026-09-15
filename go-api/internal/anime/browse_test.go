package anime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

type fakeBrowseDB struct {
	gotGenre, gotStudio *string
	gotYear             *int32
	gotOffset, gotLimit int32
	rows                []dbgen.BrowseAnimeRow
	total               int64
}

func (f *fakeBrowseDB) BrowseAnime(_ context.Context, genre, studio *string, year *int32, offset, limit int32) ([]dbgen.BrowseAnimeRow, error) {
	f.gotGenre, f.gotStudio, f.gotYear, f.gotOffset, f.gotLimit = genre, studio, year, offset, limit
	return f.rows, nil
}

func (f *fakeBrowseDB) CountBrowseAnime(context.Context, *string, *string, *int32) (int64, error) {
	return f.total, nil
}

func TestParseBrowseFilter(t *testing.T) {
	for _, tc := range []struct {
		name string
		qs   map[string][]string
		ok   bool
	}{
		{"genre alone", map[string][]string{"genre": {"Action"}}, true},
		{"studio alone", map[string][]string{"studio": {"MAPPA"}}, true},
		{"year alone", map[string][]string{"year": {"2024"}}, true},
		{"nothing is the whole catalogue, refused", map[string][]string{}, false},
		{"two keys is a search, refused", map[string][]string{"genre": {"Action"}, "year": {"2024"}}, false},
		{"blank key does not count", map[string][]string{"genre": {"  "}, "year": {"2024"}}, true},
		{"non-numeric year", map[string][]string{"year": {"twenty"}}, false},
		{"year out of range", map[string][]string{"year": {"1850"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, ok := parseBrowseFilter(tc.qs)
			assert.Equal(t, tc.ok, ok)
		})
	}
}

func TestBrowse_PaginationAndEnvelope(t *testing.T) {
	db := &fakeBrowseDB{rows: []dbgen.BrowseAnimeRow{{AnilistID: 1}, {AnilistID: 2}}, total: 130}
	rec := httptest.NewRecorder()
	Browse(db).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/browse?genre=Action&page=3&perPage=999", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, db.gotGenre)
	assert.Equal(t, "Action", *db.gotGenre)
	assert.Nil(t, db.gotStudio)
	assert.Nil(t, db.gotYear)
	assert.Equal(t, int32(browseMaxPerPage), db.gotLimit, "perPage is capped")
	assert.Equal(t, int32(2*browseMaxPerPage), db.gotOffset, "offset is (page-1)*perPage after the cap")

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
	rec := httptest.NewRecorder()
	Browse(&fakeBrowseDB{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/browse?genre=Action&studio=MAPPA", nil))
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	Browse(&fakeBrowseDB{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/browse", nil))
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestBrowse_PageIsBounded(t *testing.T) {
	db := &fakeBrowseDB{}
	Browse(db).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/anime/browse?year=2024&page=99999", nil))
	assert.Equal(t, int32((browseMaxPage-1)*browseDefaultPerPage), db.gotOffset, "an unbounded page would be an unbounded OFFSET")
}
