// genre_overview.go — GET /api/anime/genre-overview?genre=Action
//
// Everything a genre page shows above its full grid, in one response: how
// many titles the genre has and how many are airing, five rails (airing,
// most popular, recent, classics, the top ten by score) and three rows of
// tiles (decades, the genres that most often appear alongside it, and the
// main studios that made the most of it).
//
// Every rail and tile opens a /browse listing, and the frontend builds
// that link from the table below.  The rails are read through /browse's
// own statement with exactly those filters, and the tiles count the same
// WHERE (genre_overview.sql), so a grid begins with the six titles the
// rail showed and is as long as the tile said:
//
//	lists.airing   ?genre=G&status=RELEASING
//	lists.popular  ?genre=G
//	lists.recent   ?genre=G&yearFrom=<recentFrom>
//	lists.classic  ?genre=G&yearTo=2009
//	lists.top      ?genre=G&sort=score
//	decade D       ?genre=G&yearFrom=D&yearTo=D+9    (old: ?genre=G&yearTo=1969)
//	related R      ?genre=G&with=R
//
// A studio tile links to that studio's own hub, every genre included; its
// count is the studio's titles in this genre.
//
// Cached in process per genre for ten minutes.  The genre is validated
// against the eighteen browsable genres before the cache is consulted, so
// nothing a request can send grows the key set past eighteen.
package anime

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	// genreOverviewTTL bounds how stale a genre page's numbers may be.
	// They move by a few titles a day, but the airing rail follows the
	// schedule, and ten minutes keeps it from lagging a premiere by more
	// than a page view or two.
	genreOverviewTTL = 10 * time.Minute

	// genreRailSize is a rail's length: one row of the desktop grid.
	genreRailSize = 6
	// genreTopSize is the length of the top-by-score list.
	genreTopSize = 10
	// genreTileCovers is how many cover candidates a tile carries.  It
	// shows three; the spares let the page skip covers an earlier tile
	// already showed.
	genreTileCovers = 6
	// genreMaxTiles is the length of the related-genre and studio rows.
	genreMaxTiles = 7

	// genreRecentYears is how far back "recent" reaches: the current year
	// and the six before it.
	genreRecentYears = 6
	// genreClassicLastYear is the last release year of a classic.
	genreClassicLastYear = 2009

	// statusReleasing is AniList's status for a title still airing.
	statusReleasing = "RELEASING"
)

// genreClockZone is where the site's readers are: China, at +08:00 all
// year.  recentFrom turns over at their midnight on the first of January,
// not at UTC's eight hours later.
var genreClockZone = time.FixedZone("UTC+8", 8*60*60)

// genreYearRange is one decade tile: the closed range of release years it
// counts, which is also the yearFrom / yearTo its grid asks /browse for.
type genreYearRange struct {
	key      string
	from, to int32
}

// genreDecades are the decade tiles, newest first.  "old" is everything
// before 1970, which its grid asks for as yearTo=1969 alone; its lower
// bound is the int32 floor so the SQL range has none either.
var genreDecades = []genreYearRange{
	{key: "2020", from: 2020, to: 2029},
	{key: "2010", from: 2010, to: 2019},
	{key: "2000", from: 2000, to: 2009},
	{key: "1990", from: 1990, to: 1999},
	{key: "1980", from: 1980, to: 1989},
	{key: "1970", from: 1970, to: 1979},
	{key: "old", from: math.MinInt32, to: 1969},
}

// GenreOverviewDB is the sqlc subset GenreOverview uses: /browse's pair,
// for the rails, and the three tile queries.
type GenreOverviewDB interface {
	BrowseDB
	ListGenreDecadeTiles(ctx context.Context, perTile int32, rangeKeys []string, rangeFroms []int32, rangeTos []int32, genre string) ([]dbgen.ListGenreDecadeTilesRow, error)
	ListGenreRelatedTiles(ctx context.Context, maxTiles int32, genre string, candidates []string, perTile int32) ([]dbgen.ListGenreRelatedTilesRow, error)
	ListGenreStudioTiles(ctx context.Context, maxTiles int32, genre string, perTile int32) ([]dbgen.ListGenreStudioTilesRow, error)
}

// GenreOverviewPayload is GET /api/anime/genre-overview's data.
type GenreOverviewPayload struct {
	Genre string `json:"genre"`
	// Total is how many titles carry the genre, adult titles excluded as
	// /browse excludes them; it is lists.popular's count.
	Total int64 `json:"total"`
	// Airing is how many of them are RELEASING; lists.airing's count.
	Airing int64 `json:"airing"`
	// RecentFrom is the first release year lists.recent counts.
	RecentFrom int32              `json:"recentFrom"`
	Lists      GenreOverviewLists `json:"lists"`
	// Decades are newest first; a decade with no titles is left out.
	Decades []GenreDecadeTile `json:"decades"`
	// Related are the genres most often carried alongside this one, most
	// frequent first: never the genre itself, never Hentai.
	Related []GenreRelatedTile `json:"related"`
	// Studios are the main studios that made the most of the genre.
	Studios []GenreStudioTile `json:"studios"`
}

// GenreOverviewLists are the rails, each named for the /browse listing
// its "see all" link opens (see the table at the top of this file).
type GenreOverviewLists struct {
	Airing  GenreOverviewList `json:"airing"`
	Popular GenreOverviewList `json:"popular"`
	Recent  GenreOverviewList `json:"recent"`
	Classic GenreOverviewList `json:"classic"`
	Top     GenreOverviewList `json:"top"`
}

// GenreOverviewList is a rail: the first page of its listing and the
// listing's total.  Items are /browse's items, field for field.
type GenreOverviewList struct {
	Count int64          `json:"count"`
	Items []seasonalItem `json:"items"`
}

// GenreCover is a tile's cover candidate.  A title without a cover is
// never one, so CoverImageUrl is never null.
type GenreCover struct {
	AnilistID     int32   `json:"anilistId"`
	CoverImageUrl string  `json:"coverImageUrl"`
	PosterAccent  *string `json:"posterAccent"`
}

// GenreDecadeTile is one decade: Key is its first year ("2020") or "old".
type GenreDecadeTile struct {
	Key    string       `json:"key"`
	Count  int64        `json:"count"`
	Covers []GenreCover `json:"covers"`
}

// GenreRelatedTile is one genre seen alongside this one, and how many
// titles carry both.
type GenreRelatedTile struct {
	Genre  string       `json:"genre"`
	Count  int64        `json:"count"`
	Covers []GenreCover `json:"covers"`
}

// GenreStudioTile is one main studio and how many of the genre's titles
// it made.
type GenreStudioTile struct {
	Studio string       `json:"studio"`
	Count  int64        `json:"count"`
	Covers []GenreCover `json:"covers"`
}

// NewGenreOverviewCache builds the per-genre cache GenreOverview reads
// through.
func NewGenreOverviewCache() (*cache.Cache[*GenreOverviewPayload], error) {
	return cache.New[*GenreOverviewPayload](cache.Config{DefaultTTL: genreOverviewTTL})
}

// GenreOverview implements GET /api/anime/genre-overview.
func GenreOverview(db GenreOverviewDB, c *cache.Cache[*GenreOverviewPayload]) http.HandlerFunc {
	return genreOverviewHandler(db, c, time.Now)
}

func genreOverviewHandler(db GenreOverviewDB, c *cache.Cache[*GenreOverviewPayload], now func() time.Time) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		genre := strings.TrimSpace(req.URL.Query().Get("genre"))
		if !isBrowsableGenre(genre) {
			httpx.Fail(w, browseInvalid("genre must be one of the browsable genres"))
			return
		}
		if hit, ok := c.Get(genre); ok && hit != nil {
			httpx.Data(w, http.StatusOK, hit)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		payload, err := loadGenreOverview(ctx, db, genre, now())
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
		if ok := c.Set(genre, payload); !ok {
			slog.Warn("genre overview cache set rejected", "genre", genre)
		}
		httpx.Data(w, http.StatusOK, payload)
	}
}

// loadGenreOverview reads one genre's overview.  The queries run one after
// another on one connection: a miss happens once per genre per TTL, and
// fanning out would let a burst of cold genres take the pool from every
// other request.
func loadGenreOverview(ctx context.Context, db GenreOverviewDB, genre string, now time.Time) (*GenreOverviewPayload, error) {
	recentFrom := int32(now.In(genreClockZone).Year() - genreRecentYears)
	lists, err := loadGenreLists(ctx, db, genre, recentFrom)
	if err != nil {
		return nil, err
	}

	keys, froms, tos := genreDecadeArgs()
	decadeRows, err := db.ListGenreDecadeTiles(ctx, genreTileCovers, keys, froms, tos, genre)
	if err != nil {
		return nil, err
	}
	relatedRows, err := db.ListGenreRelatedTiles(ctx, genreMaxTiles, genre, browsableGenres, genreTileCovers)
	if err != nil {
		return nil, err
	}
	studioRows, err := db.ListGenreStudioTiles(ctx, genreMaxTiles, genre, genreTileCovers)
	if err != nil {
		return nil, err
	}

	return &GenreOverviewPayload{
		Genre:      genre,
		Total:      lists.Popular.Count,
		Airing:     lists.Airing.Count,
		RecentFrom: recentFrom,
		Lists:      lists,
		Decades:    decadeTiles(decadeRows),
		Related:    relatedTiles(relatedRows),
		Studios:    studioTiles(studioRows),
	}, nil
}

// loadGenreLists reads the five rails, each as the first page of the
// /browse listing named in the table at the top of this file.
func loadGenreLists(ctx context.Context, db BrowseDB, genre string, recentFrom int32) (GenreOverviewLists, error) {
	g := genre
	releasing := statusReleasing
	classicTo := int32(genreClassicLastYear)

	var (
		lists GenreOverviewLists
		err   error
	)
	if lists.Airing, err = genreList(ctx, db, browseQuery{genre: &g, status: &releasing}, genreRailSize); err != nil {
		return GenreOverviewLists{}, err
	}
	if lists.Popular, err = genreList(ctx, db, browseQuery{genre: &g}, genreRailSize); err != nil {
		return GenreOverviewLists{}, err
	}
	if lists.Recent, err = genreList(ctx, db, browseQuery{genre: &g, yearFrom: &recentFrom}, genreRailSize); err != nil {
		return GenreOverviewLists{}, err
	}
	if lists.Classic, err = genreList(ctx, db, browseQuery{genre: &g, yearTo: &classicTo}, genreRailSize); err != nil {
		return GenreOverviewLists{}, err
	}
	if lists.Top, err = genreList(ctx, db, browseQuery{genre: &g, byScore: true}, genreTopSize); err != nil {
		return GenreOverviewLists{}, err
	}
	return lists, nil
}

func genreList(ctx context.Context, db BrowseDB, q browseQuery, size int32) (GenreOverviewList, error) {
	items, total, err := browsePage(ctx, db, q, 0, size)
	if err != nil {
		return GenreOverviewList{}, err
	}
	return GenreOverviewList{Count: total, Items: items}, nil
}

// genreDecadeArgs is genreDecades as the three parallel arrays
// ListGenreDecadeTiles takes.
func genreDecadeArgs() (keys []string, froms, tos []int32) {
	for _, d := range genreDecades {
		keys = append(keys, d.key)
		froms = append(froms, d.from)
		tos = append(tos, d.to)
	}
	return keys, froms, tos
}

// genreTileRow is one cover candidate row of any of the three tile
// queries: the tile it belongs to, the tile's count, and the candidate.
type genreTileRow struct {
	key    string
	n      int64
	id     int32
	cover  *string
	accent *string
}

// genreTile is a tile folded from its rows.
type genreTile struct {
	key    string
	count  int64
	covers []GenreCover
}

// groupGenreTiles folds candidate rows into tiles, in the order the rows
// first name each tile, keeping each tile's candidates in row order.  A
// row without a cover keeps its tile -- and the tile's count -- but adds
// no candidate; Covers is never nil, so a tile with none encodes as [].
func groupGenreTiles(rows []genreTileRow) []genreTile {
	out := []genreTile{}
	at := map[string]int{}
	for _, r := range rows {
		i, seen := at[r.key]
		if !seen {
			i = len(out)
			at[r.key] = i
			out = append(out, genreTile{key: r.key, count: r.n, covers: []GenreCover{}})
		}
		if r.cover == nil {
			continue
		}
		out[i].covers = append(out[i].covers, GenreCover{AnilistID: r.id, CoverImageUrl: *r.cover, PosterAccent: r.accent})
	}
	return out
}

// decadeTiles orders the decades newest first, by genreDecades rather
// than by the rows, and leaves out a decade the rows do not name -- one
// with no titles.
func decadeTiles(rows []dbgen.ListGenreDecadeTilesRow) []GenreDecadeTile {
	in := make([]genreTileRow, 0, len(rows))
	for _, r := range rows {
		in = append(in, genreTileRow{key: r.RangeKey, n: r.N, id: r.AnilistID, cover: r.CoverImageUrl, accent: r.PosterAccent})
	}
	byKey := map[string]genreTile{}
	for _, t := range groupGenreTiles(in) {
		byKey[t.key] = t
	}
	out := make([]GenreDecadeTile, 0, len(genreDecades))
	for _, d := range genreDecades {
		if t, ok := byKey[d.key]; ok {
			out = append(out, GenreDecadeTile{Key: t.key, Count: t.count, Covers: t.covers})
		}
	}
	return out
}

// relatedTiles keeps the rows' order, which is the ranking.
func relatedTiles(rows []dbgen.ListGenreRelatedTilesRow) []GenreRelatedTile {
	in := make([]genreTileRow, 0, len(rows))
	for _, r := range rows {
		in = append(in, genreTileRow{key: r.Related, n: r.N, id: r.AnilistID, cover: r.CoverImageUrl, accent: r.PosterAccent})
	}
	tiles := groupGenreTiles(in)
	out := make([]GenreRelatedTile, 0, len(tiles))
	for _, t := range tiles {
		out = append(out, GenreRelatedTile{Genre: t.key, Count: t.count, Covers: t.covers})
	}
	return out
}

// studioTiles keeps the rows' order, which is the ranking.
func studioTiles(rows []dbgen.ListGenreStudioTilesRow) []GenreStudioTile {
	in := make([]genreTileRow, 0, len(rows))
	for _, r := range rows {
		in = append(in, genreTileRow{key: r.Studio, n: r.N, id: r.AnilistID, cover: r.CoverImageUrl, accent: r.PosterAccent})
	}
	tiles := groupGenreTiles(in)
	out := make([]GenreStudioTile, 0, len(tiles))
	for _, t := range tiles {
		out = append(out, GenreStudioTile{Studio: t.key, Count: t.count, Covers: t.covers})
	}
	return out
}
