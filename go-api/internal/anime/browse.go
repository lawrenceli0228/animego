// browse.go — the two endpoints behind the hub pages.
//
//	GET /api/anime/browse?genre=Action|studio=MAPPA|year=2024&page=&perPage=
//	GET /api/anime/hubs
//
// A hub page is a listing keyed by one thing a title is about -- its
// genre, the studio that animated it, the year it came out -- and its
// whole job is to link.  Until these existed the catalogue's eighteen
// thousand detail pages did not link to one another at all: the genre
// chips were <span>s and the studio row was text, so a crawler landing
// on one title had nowhere to go next.  Browse is the page; Hubs is the
// list of pages, for the sitemap and for an index.
//
// Both exclude adult titles by column and by genre, like every other
// listing (see GetSeasonalAnime).  Browse answers with the seasonal row
// shape so the frontend renders the card it already has.
package anime

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	browseDefaultPerPage = 24
	browseMaxPerPage     = 50
	// browseMaxPage bounds OFFSET.  A genre page past the first few
	// hundred is nobody's destination, and an unbounded page number is an
	// unbounded OFFSET on a seq scan.
	browseMaxPage = 200

	// hubStudioMinTitles is the floor for a studio to have a hub page.  A
	// page listing one title is a thin page and there are thousands of
	// one-title production companies.
	hubStudioMinTitles = 5

	// hubsTTL bounds how stale the hub index may be.  The counts move by
	// a few titles a day; an hour is invisible.
	hubsTTL = time.Hour
)

// BrowseDB is the sqlc subset Browse uses.
type BrowseDB interface {
	BrowseAnime(ctx context.Context, genre *string, studio *string, releaseYear *int32, rowOffset int32, rowLimit int32) ([]dbgen.BrowseAnimeRow, error)
	CountBrowseAnime(ctx context.Context, genre *string, studio *string, releaseYear *int32) (int64, error)
}

// browseFilter is the one key a browse request names.
type browseFilter struct {
	genre  *string
	studio *string
	year   *int32
}

// parseBrowseFilter reads exactly one of genre / studio / year from the
// query string.  Zero or more than one is a 400: a page keyed by nothing
// would be the whole catalogue, and one keyed by two things is a search,
// which is a different endpoint with a different cache story.
func parseBrowseFilter(qs map[string][]string) (browseFilter, bool) {
	get := func(k string) string {
		if v, ok := qs[k]; ok && len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	var f browseFilter
	n := 0
	if g := get("genre"); g != "" {
		f.genre = &g
		n++
	}
	if s := get("studio"); s != "" {
		f.studio = &s
		n++
	}
	if y := get("year"); y != "" {
		yr, err := strconv.Atoi(y)
		if err != nil || yr < 1900 || yr > 2100 {
			return browseFilter{}, false
		}
		y32 := int32(yr)
		f.year = &y32
		n++
	}
	return f, n == 1
}

// browseResponse is the envelope: the seasonal one, with the same
// pagination block, so the frontend's paged fetch helper reads both.
type browseResponse struct {
	Data       []dbgen.BrowseAnimeRow `json:"data"`
	Pagination seasonalPagination     `json:"pagination"`
}

// Browse implements GET /api/anime/browse.
func Browse(db BrowseDB) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		qs := req.URL.Query()
		f, ok := parseBrowseFilter(qs)
		if !ok {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError,
				"exactly one of genre, studio or year is required"))
			return
		}

		page := parseIntDefault(qs.Get("page"), 1)
		if page < 1 {
			page = 1
		}
		if page > browseMaxPage {
			page = browseMaxPage
		}
		perPage := parseIntDefault(qs.Get("perPage"), browseDefaultPerPage)
		if perPage < 1 {
			perPage = browseDefaultPerPage
		}
		if perPage > browseMaxPerPage {
			perPage = browseMaxPerPage
		}
		offset := (page - 1) * perPage

		rows, err := db.BrowseAnime(ctx, f.genre, f.studio, f.year, int32(offset), int32(perPage))
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
		total, err := db.CountBrowseAnime(ctx, f.genre, f.studio, f.year)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
		if rows == nil {
			rows = []dbgen.BrowseAnimeRow{}
		}

		writeBrowseEnvelope(w, browseResponse{
			Data: rows,
			Pagination: seasonalPagination{
				Page:       page,
				PerPage:    perPage,
				Total:      int(total),
				TotalPages: int(math.Ceil(float64(total) / float64(perPage))),
			},
		})
	}
}

func writeBrowseEnvelope(w http.ResponseWriter, v browseResponse) {
	// Same helper the seasonal envelope goes through: same byte shape,
	// same charset, same HTML-escape-off behaviour.
	writeMultiKeyEnvelope(w, http.StatusOK, v)
}

// ---------------------------------------------------------------------------
// Hubs
// ---------------------------------------------------------------------------

// HubsDB is the sqlc subset Hubs uses.
type HubsDB interface {
	ListGenreCounts(ctx context.Context) ([]dbgen.ListGenreCountsRow, error)
	ListStudioCounts(ctx context.Context, minTitles int32) ([]dbgen.ListStudioCountsRow, error)
	ListYearCounts(ctx context.Context) ([]dbgen.ListYearCountsRow, error)
	ListSeasonCounts(ctx context.Context) ([]dbgen.ListSeasonCountsRow, error)
}

// HubCount is one hub and how many titles it lists.
type HubCount struct {
	Key   string `json:"key"`
	Count int64  `json:"count"`
}

// SeasonHub is one (season, year) pair with a title in it.
type SeasonHub struct {
	Season string `json:"season"`
	Year   int32  `json:"year"`
	Count  int64  `json:"count"`
}

// HubsPayload is GET /api/anime/hubs: every hub page that exists, with
// its size.  The sitemap lists what is here; the seasonal route already
// renders every pair in Seasons and until now listed one of them.
type HubsPayload struct {
	Genres  []HubCount  `json:"genres"`
	Studios []HubCount  `json:"studios"`
	Years   []HubCount  `json:"years"`
	Seasons []SeasonHub `json:"seasons"`
}

// NewHubsCache builds the one-entry cache Hubs reads through.
func NewHubsCache() (*cache.Cache[*HubsPayload], error) {
	return cache.New[*HubsPayload](cache.Config{DefaultTTL: hubsTTL})
}

// Hubs implements GET /api/anime/hubs.
func Hubs(db HubsDB, c *cache.Cache[*HubsPayload]) http.HandlerFunc {
	const key = "hubs"
	return func(w http.ResponseWriter, req *http.Request) {
		if hit, ok := c.Get(key); ok && hit != nil {
			httpx.Data(w, http.StatusOK, hit)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		payload, err := loadHubs(ctx, db)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
		if ok := c.Set(key, payload); !ok {
			slog.Warn("hubs cache set rejected")
		}
		httpx.Data(w, http.StatusOK, payload)
	}
}

func loadHubs(ctx context.Context, db HubsDB) (*HubsPayload, error) {
	genres, err := db.ListGenreCounts(ctx)
	if err != nil {
		return nil, err
	}
	studios, err := db.ListStudioCounts(ctx, hubStudioMinTitles)
	if err != nil {
		return nil, err
	}
	years, err := db.ListYearCounts(ctx)
	if err != nil {
		return nil, err
	}
	seasons, err := db.ListSeasonCounts(ctx)
	if err != nil {
		return nil, err
	}
	p := &HubsPayload{
		Genres:  make([]HubCount, 0, len(genres)),
		Studios: make([]HubCount, 0, len(studios)),
		Years:   make([]HubCount, 0, len(years)),
		Seasons: make([]SeasonHub, 0, len(seasons)),
	}
	for _, g := range genres {
		p.Genres = append(p.Genres, HubCount{Key: g.Genre, Count: g.N})
	}
	for _, s := range studios {
		p.Studios = append(p.Studios, HubCount{Key: s.Studio, Count: s.N})
	}
	for _, y := range years {
		p.Years = append(p.Years, HubCount{Key: strconv.Itoa(int(y.ReleaseYear)), Count: y.N})
	}
	for _, s := range seasons {
		if s.Season == nil || s.SeasonYear == nil {
			continue
		}
		p.Seasons = append(p.Seasons, SeasonHub{Season: *s.Season, Year: *s.SeasonYear, Count: s.N})
	}
	return p, nil
}
