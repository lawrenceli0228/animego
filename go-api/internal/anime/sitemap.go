package anime

import (
	"context"
	"net/http"
	"strconv"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// maxSitemapShards bounds the `shards` parameter.  Anything above this is
// not a sitemap layout, it is a typo — and since each shard is a separate
// full scan of anime_cache, an unbounded value turns one query string into
// as many scans as the caller cares to name.
const maxSitemapShards = 64

// SitemapShard implements GET /api/anime/sitemap — every anime id in one
// modulo shard of the catalogue, with the time its row last changed.
//
// It exists because next-app's sitemap was built out of
// /api/anime/yearly-top, which answers a different question: the
// top-rated titles of one year, capped at 20 by that handler.  The
// sitemap asked for limit=100, parseLimit silently clamped it to 20, and
// the site advertised 20 of its 17,603 anime to Google.  The other 99.9%
// were reachable only by a crawler guessing ids.  Nothing was broken in
// a way any test or log could show — the wrong endpoint answered
// correctly.
//
// The caller owns the shard count.  next-app holds the constant and
// passes it, so changing the sitemap layout is a one-line frontend edit
// and this handler keeps no opinion about sizing.  See the
// ListSitemapShard comment for why the slice is `id % n` rather than
// LIMIT/OFFSET.
//
// Uncached on purpose.  next-app reads this behind its own revalidate
// window, so real traffic is a few requests an hour regardless of how
// many crawlers pull the XML.  A cache here would buy nothing and cost an
// invalidation question.
//
// Query parameters:
//
//	shards  how many shards the catalogue is divided into, 1..64 (default 1)
//	shard   which shard to return, 0..shards-1 (default 0)
//
// Response envelope:
//
//	{"data":[{"anilistId":1,"updatedAt":"2026-08-27T11:29:16.681137Z"}, ...]}
func SitemapShard(q dbgen.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		qs := req.URL.Query()

		// Rejecting bad input rather than clamping it, which is the
		// opposite of what parseLimit does elsewhere in this package.
		// The difference is what a silent correction costs: a clamped
		// `limit` returns fewer rows, while a clamped `shard` returns
		// somebody else's rows — two sitemap files would list the same
		// URLs, and duplicate <loc> entries across a sitemap set is a
		// defect Google attributes to the site instead of reporting
		// back.  A 400 is visible; a wrong sitemap is not.
		shards, err := parseShard(qs.Get("shards"), 1)
		if err != nil || shards < 1 || shards > maxSitemapShards {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError,
				"shards must be an integer in 1.."+strconv.Itoa(maxSitemapShards)))
			return
		}

		shard, err := parseShard(qs.Get("shard"), 0)
		if err != nil || shard < 0 || shard >= shards {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError,
				"shard must be an integer in 0.."+strconv.Itoa(shards-1)))
			return
		}

		rows, err := q.ListSitemapShard(ctx, int32(shards), int32(shard))
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		httpx.Data(w, http.StatusOK, rows)
	}
}

// parseShard reads an optional non-negative integer query parameter.
// Absent means def; anything present but unparseable is an error rather
// than a fallback, for the reason given at the call site.
func parseShard(s string, def int) (int, error) {
	if s == "" {
		return def, nil
	}
	return strconv.Atoi(s)
}
