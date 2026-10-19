package anime

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// oracleCovers are a listing's first n titles with a cover.
func oracleCovers(list []genreSeed, n int) []int32 {
	out := []int32{}
	for _, s := range list {
		if s.cover && len(out) < n {
			out = append(out, s.id)
		}
	}
	return out
}

// genreOverviewWire is the overview as a client reads it.
type genreOverviewWire struct {
	Genre      string `json:"genre"`
	Total      int64  `json:"total"`
	Airing     int64  `json:"airing"`
	RecentFrom int    `json:"recentFrom"`
	Lists      map[string]struct {
		Count int64             `json:"count"`
		Items []json.RawMessage `json:"items"`
	} `json:"lists"`
	Decades []genreTileWire `json:"decades"`
	Related []genreTileWire `json:"related"`
	Studios []genreTileWire `json:"studios"`
}

// genreTileWire reads any of the three tile kinds; Name is whichever of
// key / genre / studio the kind names it by.
type genreTileWire struct {
	Key    string `json:"key"`
	Genre  string `json:"genre"`
	Studio string `json:"studio"`
	Count  int64  `json:"count"`
	Covers []struct {
		AnilistID     int32   `json:"anilistId"`
		CoverImageUrl *string `json:"coverImageUrl"`
		PosterAccent  *string `json:"posterAccent"`
	} `json:"covers"`
}

func (w genreTileWire) name() string { return w.Key + w.Genre + w.Studio }

func (w genreTileWire) coverIDs() []int32 {
	out := []int32{}
	for _, c := range w.Covers {
		out = append(out, c.AnilistID)
	}
	return out
}

type oracleTile struct {
	name   string
	count  int64
	covers []int32
}

func wireTiles(ws []genreTileWire) []oracleTile {
	out := []oracleTile{}
	for _, w := range ws {
		out = append(out, oracleTile{name: w.name(), count: w.Count, covers: w.coverIDs()})
	}
	return out
}

// rankTiles is the related and studio rows' rule: most titles first, ties
// by name, the first genreMaxTiles.
func rankTiles(tiles []oracleTile) []oracleTile {
	sort.SliceStable(tiles, func(i, j int) bool {
		if tiles[i].count != tiles[j].count {
			return tiles[i].count > tiles[j].count
		}
		return tiles[i].name < tiles[j].name
	})
	if len(tiles) > genreMaxTiles {
		tiles = tiles[:genreMaxTiles]
	}
	return tiles
}

// TestGenreOverview_PG — the overview over a real Postgres, three ways:
// against the oracle; against /browse, whose listings each rail and tile
// opens (same first items byte for byte, same totals); and on the points
// each rule exists for.
func TestGenreOverview_PG(t *testing.T) {
	q, seeds := seedGenreCatalogue(t)
	c, err := NewGenreOverviewCache()
	require.NoError(t, err)
	t.Cleanup(c.Close)
	h := genreOverviewHandler(q, c, func() time.Time { return octoberNoon })
	browse := Browse(q)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/genre-overview?genre=Action", nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var env struct {
		Data genreOverviewWire `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	got := env.Data
	y := func(v int) *int { return &v }

	assert.Equal(t, "Action", got.Genre)
	assert.Equal(t, 2020, got.RecentFrom)

	rails := map[string]struct {
		query string
		want  oracleQuery
		size  int
	}{
		"airing":  {"genre=Action&status=RELEASING", oracleQuery{genre: "Action", status: "RELEASING"}, genreRailSize},
		"popular": {"genre=Action", oracleQuery{genre: "Action"}, genreRailSize},
		"recent":  {"genre=Action&yearFrom=2020", oracleQuery{genre: "Action", yearFrom: y(2020)}, genreRailSize},
		"classic": {"genre=Action&yearTo=2009", oracleQuery{genre: "Action", yearTo: y(2009)}, genreRailSize},
		"top":     {"genre=Action&sort=score", oracleQuery{genre: "Action", byScore: true}, genreTopSize},
	}
	require.Len(t, got.Lists, len(rails))
	for name, r := range rails {
		t.Run("lists."+name, func(t *testing.T) {
			list := got.Lists[name]
			want := oracleList(seeds, r.want)
			require.Greater(t, len(want), r.size, "the seed must overfill the rail to test its length")
			assert.Equal(t, int64(len(want)), list.Count)

			grid := browseAll(t, browse, r.query, 36)
			assert.Equal(t, int64(grid.total), list.Count, "the rail counts what its grid lists")
			require.Len(t, list.Items, r.size)
			for i, item := range list.Items {
				assert.Equal(t, want[i].id, grid.ids[i])
				assert.JSONEq(t, string(grid.items[i]), string(item), "%s item %d is the grid's", name, i)
				assert.Equal(t, string(grid.items[i]), string(item), "byte for byte")
			}
		})
	}
	assert.Equal(t, got.Lists["popular"].Count, got.Total)
	assert.Equal(t, got.Lists["airing"].Count, got.Airing)

	t.Run("decades", func(t *testing.T) {
		var want []oracleTile
		for _, d := range genreDecades {
			oq := oracleQuery{genre: "Action", yearTo: y(int(d.to))}
			query := fmt.Sprintf("genre=Action&yearTo=%d", d.to)
			if d.key != "old" {
				oq.yearFrom = y(int(d.from))
				query = fmt.Sprintf("genre=Action&yearFrom=%d&yearTo=%d", d.from, d.to)
			}
			list := oracleList(seeds, oq)
			if len(list) == 0 {
				continue
			}
			want = append(want, oracleTile{name: d.key, count: int64(len(list)), covers: oracleCovers(list, genreTileCovers)})

			grid := browseAll(t, browse, query, 50)
			assert.Equal(t, len(list), grid.total, "the %s tile counts its grid (%s)", d.key, query)
		}
		assert.Equal(t, want, wireTiles(got.Decades))

		// The edges, through the grids the tiles open (whose totals the
		// tiles were just held to).
		old := browseAll(t, browse, "genre=Action&yearTo=1969", 50).ids
		seventies := browseAll(t, browse, "genre=Action&yearFrom=1970&yearTo=1979", 50).ids
		twenties := browseAll(t, browse, "genre=Action&yearFrom=2020&yearTo=2029", 50).ids
		assert.Contains(t, old, int32(101), "1969 is before 1970")
		assert.NotContains(t, seventies, int32(101))
		assert.Contains(t, seventies, int32(102), "1970")
		assert.Contains(t, seventies, int32(103), "1979")
		assert.Contains(t, twenties, int32(104), "2029")
		assert.NotContains(t, twenties, int32(105), "2030 is in no decade")

		names := map[string]genreTileWire{}
		for _, d := range got.Decades {
			names[d.Key] = d
			assert.LessOrEqual(t, len(d.Covers), genreTileCovers)
			assert.NotContains(t, d.coverIDs(), int32(105), "2030 is in no decade")
		}
		assert.Contains(t, names, "old")
		assert.Len(t, names["2020"].Covers, genreTileCovers, "a full decade carries every spare")
		var sum int64
		for _, d := range got.Decades {
			sum += d.Count
		}
		assert.Equal(t, got.Total-5-1, sum, "every title is in one decade but the five with no year and the one from 2030")
	})

	t.Run("related", func(t *testing.T) {
		var all []oracleTile
		for _, g := range browsableGenres {
			if g == "Action" {
				continue
			}
			list := oracleList(seeds, oracleQuery{genre: "Action", with: g})
			if len(list) > 0 {
				all = append(all, oracleTile{name: g, count: int64(len(list)), covers: oracleCovers(list, genreTileCovers)})
			}
		}
		want := rankTiles(all)
		assert.Equal(t, want, wireTiles(got.Related))

		for _, r := range got.Related {
			assert.NotContains(t, []string{"Action", "Hentai", "Isekai"}, r.Genre)
			grid := browseAll(t, browse, "genre=Action&with="+url.QueryEscape(r.Genre), 50)
			assert.Equal(t, int64(grid.total), r.Count, "the %s tile counts its grid", r.Genre)
		}
		require.Len(t, got.Related, genreMaxTiles)
		assert.Equal(t, "Mecha", got.Related[genreMaxTiles-1].Genre, "Mecha and Mystery tie for the last tile; the name decides")
	})

	t.Run("studios", func(t *testing.T) {
		action := oracleList(seeds, oracleQuery{genre: "Action"})
		seen := map[string]bool{}
		var all []oracleTile
		for _, s := range action {
			for _, st := range s.main {
				if seen[st] {
					continue
				}
				seen[st] = true
				list := oracleList(seeds, oracleQuery{genre: "Action", studio: st})
				all = append(all, oracleTile{name: st, count: int64(len(list)), covers: oracleCovers(list, genreTileCovers)})
			}
		}
		assert.Equal(t, rankTiles(all), wireTiles(got.Studios))

		require.Len(t, got.Studios, genreMaxTiles)
		for _, st := range got.Studios {
			assert.NotEqual(t, committee, st.Studio, "a committee credit on every title is still not a studio")
		}
		assert.Equal(t, "Studio Iota", got.Studios[4].Studio, "three titles of its own and six as the second main studio")
		assert.Equal(t, "Studio Eta", got.Studios[genreMaxTiles-1].Studio, "Eta and Zeta tie for the last tile; the name decides")
	})

	t.Run("covers are titles with a cover, in their listing's order", func(t *testing.T) {
		for _, tiles := range [][]genreTileWire{got.Decades, got.Related, got.Studios} {
			for _, tile := range tiles {
				assert.NotContains(t, tile.coverIDs(), int32(904), "%s: the coverless leader is not a cover", tile.name())
				for _, c := range tile.Covers {
					require.NotNil(t, c.CoverImageUrl)
					assert.True(t, strings.HasPrefix(*c.CoverImageUrl, "https://img.example/cover/"))
					assert.NotNil(t, c.PosterAccent)
				}
			}
		}
	})

	t.Run("adult titles reach no part of it", func(t *testing.T) {
		body := rec.Body.String()
		for _, id := range []int{901, 902, 903} {
			assert.NotContains(t, body, fmt.Sprintf(`"anilistId":%d,`, id))
			assert.NotContains(t, body, fmt.Sprintf(`"anilistId":%d}`, id))
		}
	})
}
