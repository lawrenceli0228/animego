// browse.go — the two endpoints behind the hub pages.
//
//	GET /api/anime/browse?genre=Action|studio=MAPPA|year=2024&page=&perPage=
//	                     [&with=Fantasy][&status=RELEASING][&yearFrom=&yearTo=][&sort=score]
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
// listing (see GetSeasonalAnime).  Browse answers with the seasonal item
// shape so the frontend renders the card it already has, and its optional
// filters (browse_params.go) are what a genre page's rails and tiles open:
// the genre overview (genre_overview.go) reads its rails through the same
// statement.
package anime

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"strconv"
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
	BrowseAnime(ctx context.Context, arg dbgen.BrowseAnimeParams) ([]dbgen.BrowseAnimeRow, error)
	CountBrowseAnime(ctx context.Context, arg dbgen.CountBrowseAnimeParams) (int64, error)
}

// browseResponse is the envelope: the seasonal one, with the same
// pagination block, so the frontend's paged fetch helper reads both.
type browseResponse struct {
	Data       []seasonalItem     `json:"data"`
	Pagination seasonalPagination `json:"pagination"`
}

// Browse implements GET /api/anime/browse.
func Browse(db BrowseDB) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		qs := req.URL.Query()
		q, apiErr := parseBrowseQuery(qs)
		if apiErr != nil {
			httpx.Fail(w, apiErr)
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

		items, total, err := browsePage(ctx, db, q, int32(offset), int32(perPage))
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		writeBrowseEnvelope(w, browseResponse{
			Data: items,
			Pagination: seasonalPagination{
				Page:       page,
				PerPage:    perPage,
				Total:      int(total),
				TotalPages: int(math.Ceil(float64(total) / float64(perPage))),
			},
		})
	}
}

// browsePage is one page of q and q's total.  The /browse handler and the
// genre overview's rails both read through it, which is what makes a
// rail the first page of the listing behind its "see all" link.
func browsePage(ctx context.Context, db BrowseDB, q browseQuery, offset, limit int32) ([]seasonalItem, int64, error) {
	rows, err := db.BrowseAnime(ctx, q.listParams(offset, limit))
	if err != nil {
		return nil, 0, err
	}
	total, err := db.CountBrowseAnime(ctx, q.countParams())
	if err != nil {
		return nil, 0, err
	}
	return seasonalItemsFromBrowseRows(rows), total, nil
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
