// top.go — the Top 100 pages.
//
//	GET /api/anime/top?year=2024&format=MOVIE&season=FALL&genre=Drama
//	GET /api/anime/top/years
//
// /top is one ranking of at most a hundred titles, best first: the
// all-time one, or one release year's, cut to any of a format, a season of
// that year and a genre (top_params.go).  Each item is the /browse item --
// the seasonal shape, so the page renders the cards it already has -- with
// its place in the ranking as "rank", counted from 1 with no gaps: two
// titles on the same score still take two places, the more popular one
// first.  Which titles take part, and in what order, is top.sql's.
//
// /top/years is every release year that has a ranking, newest first, and
// how many titles it ranks: the year pages that exist, for the page's year
// strip and the sitemap.
//
// Both are cached in process for ten minutes, and concurrent misses of one
// ranking share a single read.
package anime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	// topTTL bounds how stale a ranking may be.  Scores and popularity
	// move when the facts sweep reaches a title, a few hundred titles a
	// day; ten minutes is invisible on a page and spares the database a
	// re-read per view.
	topTTL = 10 * time.Minute

	// topCacheEntries is how many rankings the cache holds.  A ranking is
	// up to a hundred items of a few kilobytes each (three synopses ride
	// on every item), so a few hundred kilobytes; sixty-four of them bound
	// the cache at a few tens of megabytes.  That is every unfiltered
	// ranking the site links to (all time and each year's, about sixty);
	// the filtered ones compete for the rest, and ristretto's admission
	// policy keeps what is read often.  Next's data cache in front of this
	// one already holds each page's response for its revalidate window;
	// this cache is what keeps a burst of cold rankings from each costing
	// a statement.
	topCacheEntries = 64

	// topYearsKey is the years cache's only key.
	topYearsKey = "years"
)

// TopDB is the sqlc subset Top uses.
type TopDB interface {
	TopAnime(ctx context.Context, arg dbgen.TopAnimeParams) ([]dbgen.TopAnimeRow, error)
}

// TopYearsDB is the sqlc subset TopYears uses.
type TopYearsDB interface {
	ListTopYears(ctx context.Context, minPopularity int32) ([]dbgen.ListTopYearsRow, error)
}

// topItem is one entry of /top's data: the /browse item with its place in
// the ranking after it.  seasonalItem has no MarshalJSON of its own, so
// embedding it encodes its fields in place, followed by rank.
type topItem struct {
	seasonalItem
	Rank int `json:"rank"`
}

// TopList is one ranking, best first.  Cached and handed to every reader
// of it as is: read-only.
type TopList []topItem

// TopYear is one release year with a ranking, and how many titles it
// ranks (the page shows at most topSize of them).
type TopYear struct {
	Year  int32 `json:"year"`
	Count int64 `json:"count"`
}

// NewTopCache builds the per-ranking cache Top reads through.
func NewTopCache() (*cache.Cache[TopList], error) {
	return cache.New[TopList](topCacheConfig())
}

// topCacheConfig sizes the cache by entry rather than by byte (see
// cache.Config.IgnoreInternalCost), with ten counters per entry as
// ristretto recommends: the default sizing is for millions of keys and
// allocates its counters -- tens of megabytes -- up front.
func topCacheConfig() cache.Config {
	return cache.Config{
		NumCounters:        10 * topCacheEntries,
		MaxCost:            topCacheEntries,
		IgnoreInternalCost: true,
		DefaultTTL:         topTTL,
	}
}

// NewTopYearsCache builds the one-entry cache TopYears reads through.
func NewTopYearsCache() (*cache.Cache[[]TopYear], error) {
	return cache.New[[]TopYear](topYearsCacheConfig())
}

// topYearsCacheConfig holds the one key, with room to spare so the
// admission policy never turns it away.
func topYearsCacheConfig() cache.Config {
	return cache.Config{
		NumCounters:        10,
		MaxCost:            2,
		IgnoreInternalCost: true,
		DefaultTTL:         topTTL,
	}
}

// Top implements GET /api/anime/top.
func Top(db TopDB, c *cache.Cache[TopList]) http.HandlerFunc {
	// loads collapses concurrent misses of one ranking into one read, as
	// the genre overview's does.
	var loads singleflight.Group
	return func(w http.ResponseWriter, req *http.Request) {
		q, apiErr := parseTopQuery(req.URL.Query())
		if apiErr != nil {
			httpx.Fail(w, apiErr)
			return
		}
		key := q.key()
		if hit, ok := c.Get(key); ok && hit != nil {
			httpx.Data(w, http.StatusOK, hit)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		list, err := sharedRead(ctx, &loads, "anime/top", key, func(lctx context.Context) (TopList, error) {
			list, err := loadTop(lctx, db, q)
			if err != nil {
				return nil, err
			}
			if ok := c.Set(key, list); !ok {
				slog.Warn("top cache set rejected", "key", key)
			}
			return list, nil
		})
		if errors.Is(err, context.Canceled) {
			// The reader went away; nobody is there to read an answer, and a
			// 500 for it would be a server error that never happened.  The
			// read goes on without it (see sharedRead).
			return
		}
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
		httpx.Data(w, http.StatusOK, list)
	}
}

// loadTop reads one ranking and numbers it.
func loadTop(ctx context.Context, db TopDB, q topQuery) (TopList, error) {
	rows, err := db.TopAnime(ctx, q.params())
	if err != nil {
		return nil, fmt.Errorf("top %s: %w", q.key(), err)
	}
	return topListFromRows(rows), nil
}

// topListFromRows numbers the rows in the order the statement ranked them:
// the place is the position, so a tie on the score still takes two
// places.  Never nil, so an empty ranking encodes as [].
func topListFromRows(rows []dbgen.TopAnimeRow) TopList {
	out := make(TopList, 0, len(rows))
	for i, r := range rows {
		out = append(out, topItemFromRow(r, i+1))
	}
	return out
}

// topItemFromRow projects one TopAnime row onto the /browse item.
// TopAnime selects BrowseAnime's projection column for column, so sqlc
// generates the same struct under a third name and the conversion copies
// it as it is.  The conversion is also the guard on that, as
// seasonalItemFromBrowseRow's is: a column added to one query and not the
// other stops this compiling.
func topItemFromRow(r dbgen.TopAnimeRow, rank int) topItem {
	return topItem{seasonalItem: seasonalItemFromRow(dbgen.GetSeasonalAnimeRow(r)), Rank: rank}
}

// TopYears implements GET /api/anime/top/years.
func TopYears(db TopYearsDB, c *cache.Cache[[]TopYear]) http.HandlerFunc {
	var loads singleflight.Group
	return func(w http.ResponseWriter, req *http.Request) {
		if hit, ok := c.Get(topYearsKey); ok && hit != nil {
			httpx.Data(w, http.StatusOK, hit)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		years, err := sharedRead(ctx, &loads, "anime/top/years", topYearsKey, func(lctx context.Context) ([]TopYear, error) {
			rows, err := db.ListTopYears(lctx, browseScoreMinPopularity)
			if err != nil {
				return nil, fmt.Errorf("top years: %w", err)
			}
			years := topYearsFromRows(rows)
			if ok := c.Set(topYearsKey, years); !ok {
				slog.Warn("top years cache set rejected")
			}
			return years, nil
		})
		if errors.Is(err, context.Canceled) {
			return
		}
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
		httpx.Data(w, http.StatusOK, years)
	}
}

// topYearsFromRows keeps the rows' order, newest first, and leaves out a
// year /top would refuse: a page for it could only answer a 400.  Never
// nil, so no years encodes as [].
func topYearsFromRows(rows []dbgen.ListTopYearsRow) []TopYear {
	out := make([]TopYear, 0, len(rows))
	for _, r := range rows {
		if r.ReleaseYear < browseMinYear || r.ReleaseYear > browseMaxYear {
			continue
		}
		out = append(out, TopYear{Year: r.ReleaseYear, Count: r.N})
	}
	return out
}

// sharedRead runs load once for every concurrent caller of the same key;
// load is also what caches the answer, so it is written once.  It is
// sharedGenreOverview's contract for any value: the load runs on a context
// detached from any one caller, with its own queryTimeout, so the request
// that happened to start it going away neither fails the others nor
// wastes the read; each caller still stops waiting at its own deadline.
// DoChan runs load on a goroutine of its own, where httpmw.Recoverer
// cannot reach a panic, hence the recover.
func sharedRead[V any](
	ctx context.Context,
	loads *singleflight.Group,
	route, key string,
	load func(context.Context) (V, error),
) (V, error) {
	ch := loads.DoChan(key, func() (val any, err error) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.ErrorContext(ctx, route+": load panic",
					"key", key, "panic", rec, "stack", string(debug.Stack()))
				val, err = nil, fmt.Errorf("%s %s: panic: %v", route, key, rec)
			}
		}()
		lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), queryTimeout)
		defer cancel()
		return load(lctx)
	})
	var zero V
	select {
	case res := <-ch:
		if res.Err != nil {
			return zero, res.Err
		}
		return res.Val.(V), nil
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}
