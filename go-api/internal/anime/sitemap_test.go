package anime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// shardCall records the coordinates the handler forwarded to the querier,
// which is the only thing about this endpoint that can be wrong in a way
// the response body would still look fine.
type shardCall struct {
	count int32
	index int32
	made  bool
}

func sitemapQuerier(rows []dbgen.ListSitemapShardRow, call *shardCall) *fakeQuerier {
	return &fakeQuerier{
		listSitemapShardFn: func(_ context.Context, count, index int32) ([]dbgen.ListSitemapShardRow, error) {
			call.count, call.index, call.made = count, index, true
			return rows, nil
		},
	}
}

func TestSitemapShard_ForwardsShardCoordinates(t *testing.T) {
	t.Parallel()

	var call shardCall
	q := sitemapQuerier(nil, &call)

	rec := httptest.NewRecorder()
	SitemapShard(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/sitemap?shards=4&shard=3", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(4), call.count)
	assert.Equal(t, int32(3), call.index)
}

func TestSitemapShard_DefaultsToTheWholeCatalogue(t *testing.T) {
	t.Parallel()

	// No parameters means one shard containing everything — `id % 1 == 0`
	// is true for every row.  A caller that forgets the parameters gets
	// the complete catalogue rather than an arbitrary slice of it.
	var call shardCall
	q := sitemapQuerier(nil, &call)

	rec := httptest.NewRecorder()
	SitemapShard(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/sitemap", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(1), call.count)
	assert.Equal(t, int32(0), call.index)
}

func TestSitemapShard_EmitsIDAndLastModified(t *testing.T) {
	t.Parallel()

	when := time.Date(2026, 8, 27, 11, 29, 16, 0, time.UTC)
	var call shardCall
	q := sitemapQuerier([]dbgen.ListSitemapShardRow{
		{AnilistID: 1474, UpdatedAt: pgtype.Timestamptz{Time: when, Valid: true}},
	}, &call)

	rec := httptest.NewRecorder()
	SitemapShard(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/sitemap", nil))

	require.Equal(t, http.StatusOK, rec.Code)

	var parsed struct {
		Data []struct {
			AnilistID int32  `json:"anilistId"`
			UpdatedAt string `json:"updatedAt"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data, 1)
	assert.Equal(t, int32(1474), parsed.Data[0].AnilistID)

	// The timestamp has to survive as something Date() can parse — this is
	// the sitemap's <lastmod>, and pgtype.Timestamptz would serialise as a
	// struct if it did not carry its own MarshalJSON.
	got, err := time.Parse(time.RFC3339Nano, parsed.Data[0].UpdatedAt)
	require.NoError(t, err, "updatedAt must be an RFC3339 string, got %q", parsed.Data[0].UpdatedAt)
	assert.True(t, got.Equal(when))
}

// The four rejection cases below all share one stake: a request the
// handler "fixes" instead of refusing produces a sitemap file full of
// another shard's URLs, and duplicate <loc> entries across a sitemap set
// is a defect that surfaces as lost rankings rather than as an error.
// Every one of them must reach the database zero times.
func TestSitemapShard_RejectsBadCoordinates(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		query string
	}{
		{"shard equal to the shard count", "?shards=4&shard=4"},
		{"negative shard", "?shards=4&shard=-1"},
		{"non-numeric shard count", "?shards=four&shard=0"},
		// Zero is the one that would reach Postgres as `id % 0` and come
		// back as a division-by-zero from the driver, i.e. a 500 blamed on
		// the database for what is a bad query string.
		{"zero shards", "?shards=0&shard=0"},
		{"more shards than the cap", "?shards=65&shard=0"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var call shardCall
			q := sitemapQuerier(nil, &call)

			rec := httptest.NewRecorder()
			SitemapShard(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/sitemap"+tc.query, nil))

			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.False(t, call.made, "a rejected request must not reach the database")
		})
	}
}

func TestSitemapShard_RouteDoesNotCollideWithDetail(t *testing.T) {
	t.Parallel()

	// /sitemap is a literal segment sharing the /api/anime subtree with
	// the /{anilistId} wildcard.  chi resolves static before parametric,
	// so this passes by construction — the test is here because the
	// consequence of it ever changing is the detail handler being asked
	// for anime "sitemap" and the sitemap silently emptying out.
	var detailHits []string
	detail := func(w http.ResponseWriter, req *http.Request) {
		detailHits = append(detailHits, chi.URLParam(req, "anilistId"))
		w.WriteHeader(http.StatusOK)
	}

	var call shardCall
	q := sitemapQuerier([]dbgen.ListSitemapShardRow{{AnilistID: 1}}, &call)

	r := chi.NewRouter()
	r.Route("/api/anime", func(r chi.Router) {
		r.Get("/sitemap", SitemapShard(q))
		r.Get("/{anilistId}", detail)
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/sitemap", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.True(t, call.made, "SitemapShard is the handler that ran")
	assert.Empty(t, detailHits, "the detail handler must not see /api/anime/sitemap")

	// And the wildcard still answers for a real id.
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/anime/12345", nil))

	require.Equal(t, http.StatusOK, rec2.Code)
	assert.Equal(t, []string{"12345"}, detailHits)
}
