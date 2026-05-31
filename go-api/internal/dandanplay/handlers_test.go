package dandanplay

// handlers_test.go — PG-backed coverage for /api/dandanplay/*.
//
// Single Postgres testcontainer spins up in TestMain and is shared
// across every Test* in the package.  Per-test isolation comes from
// testutil.TruncateAll.  The dandanplay HTTP client is the real *Client
// (pointed at an httptest.NewServer) so the wire encoding stays
// exercised end-to-end through the same code path production uses.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

var pgURI string

func TestMain(m *testing.M) {
	ctx := context.Background()
	uri, cleanup, err := testutil.SetupPGForMain(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "dandanplay tests: setup postgres: %v\n", err)
		os.Exit(1)
	}
	defer cleanup()
	pgURI = uri
	os.Exit(m.Run())
}

// makeHandlersWithBackend builds a Handlers wired to the real
// PG-backed Querier and a real *Client pointing at the supplied
// upstream backend (an httptest.NewServer).
func makeHandlersWithBackend(t *testing.T, backend *httptest.Server) (*Handlers, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	queries := dbgen.New(pool)

	client, err := NewClient(WithEndpoint(backend.URL))
	require.NoError(t, err)
	t.Cleanup(client.Close)

	h := NewHandlers(queries, client, nil) // nil bangumi — none of these tests exercise it
	return h, pool
}

// seedAnime inserts an anime_cache row with the supplied titles +
// bgm_id so the AnimeCache search has something to find.
func seedAnimeCache(t *testing.T, pool *pgxpool.Pool, anilistID int32, titleNative, titleRomaji string, bgmID *int32) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_native, title_romaji, bgm_id, cached_at)
		VALUES ($1, $2, $3, $4, now())`,
		anilistID, titleNative, titleRomaji, bgmID,
	)
	require.NoError(t, err, "seedAnimeCache")
}

func seedGenre(t *testing.T, pool *pgxpool.Pool, animeID int32, genre string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO anime_genres (anime_id, genre) VALUES ($1, $2)`, animeID, genre)
	require.NoError(t, err)
}

func seedStudio(t *testing.T, pool *pgxpool.Pool, animeID int32, studio string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO anime_studios (anime_id, studio) VALUES ($1, $2)`, animeID, studio)
	require.NoError(t, err)
}

// ─── /api/dandanplay/search ───────────────────────────────────────────────

func TestSearch_EmptyKeyword_EmptyResults(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Shouldn't be called for empty keyword.
		t.Error("upstream called for empty keyword")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h, _ := makeHandlersWithBackend(t, backend)
	req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/search", nil)
	rec := httptest.NewRecorder()
	h.Search(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	// Express returned `{"results":[]}` exactly — verify byte shape.
	assert.JSONEq(t, `{"results":[]}`, rec.Body.String())
}

func TestSearch_HappyPath_BothSources(t *testing.T) {
	// Backend stubs both /api/v2/search/anime and (irrelevant) match.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Contains(t, r.URL.Path, "/api/v2/search/anime")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"animes":[
			{"animeId":42,"animeTitle":"Foo Anime","type":"TV","imageUrl":"http://x/y.jpg","episodeCount":12}
		]}`))
	}))
	t.Cleanup(backend.Close)

	h, pool := makeHandlersWithBackend(t, backend)
	bgm := int32(123)
	seedAnimeCache(t, pool, 900, "Foo", "Foo Romanji", &bgm)
	seedGenre(t, pool, 900, "Drama")
	seedStudio(t, pool, 900, "StudioA")

	req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/search?keyword=Foo", nil)
	rec := httptest.NewRecorder()
	h.Search(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var out struct {
		Results []map[string]json.RawMessage `json:"results"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Len(t, out.Results, 2, "expected 2 results (1 cache + 1 dandanplay); body=%s", rec.Body.String())

	// Order: animeCache first, dandanplay second.
	var src1, src2 string
	require.NoError(t, json.Unmarshal(out.Results[0]["source"], &src1))
	require.NoError(t, json.Unmarshal(out.Results[1]["source"], &src2))
	assert.Equal(t, "animeCache", src1)
	assert.Equal(t, "dandanplay", src2)
}

func TestSearch_CacheOnly_NoDandanHit(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"animes":[]}`))
	}))
	t.Cleanup(backend.Close)

	h, pool := makeHandlersWithBackend(t, backend)
	seedAnimeCache(t, pool, 1, "Test Anime", "Test Anime", nil)

	req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/search?keyword=Test", nil)
	rec := httptest.NewRecorder()
	h.Search(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var out struct {
		Results []map[string]any `json:"results"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Len(t, out.Results, 1)
	assert.Equal(t, "animeCache", out.Results[0]["source"])
}

func TestSearch_CacheRowShape(t *testing.T) {
	// Verify the cache item emits all 20 declared fields.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"animes":[]}`))
	}))
	t.Cleanup(backend.Close)

	h, pool := makeHandlersWithBackend(t, backend)
	bgm := int32(99)
	seedAnimeCache(t, pool, 100, "ShapeTest", "ShapeTest", &bgm)

	req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/search?keyword=ShapeTest", nil)
	rec := httptest.NewRecorder()
	h.Search(rec, req)

	var out struct {
		Results []map[string]json.RawMessage `json:"results"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Len(t, out.Results, 1)
	wantKeys := []string{
		"source", "anilistId", "title", "titleChinese", "titleNative", "titleRomaji",
		"coverImageUrl", "episodes", "bgmId", "season", "seasonYear", "format",
		"averageScore", "bangumiScore", "bangumiVotes", "genres", "studios",
		"animeSource", "duration", "status",
	}
	for _, k := range wantKeys {
		_, ok := out.Results[0][k]
		assert.True(t, ok, "cache item missing field %q; got %v", k, out.Results[0])
	}
}

func TestSearch_DandanRowShape(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"animes":[
			{"animeId":1,"animeTitle":"X","type":"TV","imageUrl":"http://i","episodeCount":12}
		]}`))
	}))
	t.Cleanup(backend.Close)

	h, _ := makeHandlersWithBackend(t, backend)
	req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/search?keyword=X", nil)
	rec := httptest.NewRecorder()
	h.Search(rec, req)

	var out struct {
		Results []map[string]json.RawMessage `json:"results"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Len(t, out.Results, 1)
	for _, k := range []string{"source", "dandanAnimeId", "title", "episodes", "imageUrl", "type"} {
		_, ok := out.Results[0][k]
		assert.True(t, ok, "dandan item missing %q", k)
	}
}

func TestSearch_BackendError_500(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(backend.Close)

	h, _ := makeHandlersWithBackend(t, backend)
	req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/search?keyword=Foo", nil)
	rec := httptest.NewRecorder()
	h.Search(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), `"error":"search failed"`)
}

// ─── /api/dandanplay/comments/:episodeId ───────────────────────────────────

func reqWithParam(method, path, key, val string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	rc := chi.NewRouteContext()
	rc.URLParams.Add(key, val)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
}

func TestGetComments_Happy(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Contains(t, r.URL.Path, "/api/v2/comment/")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"count":2,"comments":[{"cid":1,"p":"0,1,16777215","m":"hi"}]}`))
	}))
	t.Cleanup(backend.Close)

	h, _ := makeHandlersWithBackend(t, backend)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/comments/42", "episodeId", "42")
	rec := httptest.NewRecorder()
	h.GetComments(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	// Verify it's a direct pass-through (no `{data:…}` wrap).
	var out struct {
		Count    int             `json:"count"`
		Comments json.RawMessage `json:"comments"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, 2, out.Count)
}

func TestGetComments_Invalid_BareError(t *testing.T) {
	// Use an in-process backend that always errors so the path test
	// is deterministic (won't be reached due to early-return).
	backend := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(backend.Close)
	h, _ := makeHandlersWithBackend(t, backend)

	cases := []string{"abc", "", "0", "-1"}
	for _, raw := range cases {
		t.Run("episodeId="+raw, func(t *testing.T) {
			req := reqWithParam(http.MethodGet, "/api/dandanplay/comments/"+raw, "episodeId", raw)
			rec := httptest.NewRecorder()
			h.GetComments(rec, req)
			require.Equal(t, http.StatusBadRequest, rec.Code, "body=%s", rec.Body.String())
			// Bare envelope — `{"error":"Invalid episodeId"}`, NOT
			// the standard `{error:{code,message}}` shape.
			assert.JSONEq(t, `{"error":"Invalid episodeId"}`, rec.Body.String())
		})
	}
}

// ─── /api/dandanplay/episodes/:animeId ────────────────────────────────────

func TestGetEpisodes_ByAnimeID(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Expect /api/v2/bangumi/123 (no bgmtv prefix).
		require.Contains(t, r.URL.Path, "/api/v2/bangumi/123")
		require.NotContains(t, r.URL.Path, "bgmtv")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"bangumi":{"animeId":123,"animeTitle":"Foo","imageUrl":"http://x","episodes":[{"episodeId":1,"episodeTitle":"Ep1","episodeNumber":"1"}]}}`))
	}))
	t.Cleanup(backend.Close)

	h, _ := makeHandlersWithBackend(t, backend)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/episodes/123", "animeId", "123")
	rec := httptest.NewRecorder()
	h.GetEpisodes(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	// Pass-through — top-level keys include `dandanAnimeId` /
	// `title` / `imageUrl` / `episodes` (NOT wrapped in {data}).
	var out map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	_, hasEpisodes := out["episodes"]
	assert.True(t, hasEpisodes, "top-level should be the EpisodeData passthrough; got %v", out)
}

func TestGetEpisodes_BgmIDOverridesAnimeID(t *testing.T) {
	// bgmId query param should take precedence over the :animeId path.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Should hit the bgmtv path, not the bare /api/v2/bangumi/…
		require.Contains(t, r.URL.Path, "/api/v2/bangumi/bgmtv/456")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"bangumi":{"animeId":456,"animeTitle":"x","imageUrl":"","episodes":[]}}`))
	}))
	t.Cleanup(backend.Close)

	h, _ := makeHandlersWithBackend(t, backend)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/episodes/999?bgmId=456", "animeId", "999")
	// Manually inject the query — httptest.NewRequest with ?param works.
	req.URL.RawQuery = "bgmId=456"
	rec := httptest.NewRecorder()
	h.GetEpisodes(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestGetEpisodes_NotFound_BareError(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(backend.Close)

	h, _ := makeHandlersWithBackend(t, backend)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/episodes/123", "animeId", "123")
	rec := httptest.NewRecorder()
	h.GetEpisodes(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code, "body=%s", rec.Body.String())
	assert.JSONEq(t, `{"error":"Anime not found on dandanplay"}`, rec.Body.String())
}

func TestGetEpisodes_InvalidParams_404(t *testing.T) {
	backend := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(backend.Close)
	h, _ := makeHandlersWithBackend(t, backend)

	// Empty path param and no bgmId.
	req := reqWithParam(http.MethodGet, "/api/dandanplay/episodes/", "animeId", "")
	rec := httptest.NewRecorder()
	h.GetEpisodes(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.JSONEq(t, `{"error":"Anime not found on dandanplay"}`, rec.Body.String())
}

func TestGetEpisodes_InvalidAnimeID(t *testing.T) {
	backend := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(backend.Close)
	h, _ := makeHandlersWithBackend(t, backend)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/episodes/abc", "animeId", "abc")
	rec := httptest.NewRecorder()
	h.GetEpisodes(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestGetEpisodes_InvalidBgmID(t *testing.T) {
	backend := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(backend.Close)
	h, _ := makeHandlersWithBackend(t, backend)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/episodes/123", "animeId", "123")
	req.URL.RawQuery = "bgmId=abc"
	rec := httptest.NewRecorder()
	h.GetEpisodes(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

// ─── /api/dandanplay/match — Phase 2 with real Postgres ───────────────────

func TestMatch_Phase2_RealPG(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Expect a /api/v2/bangumi/bgmtv/<id> call from Phase 2's
		// FetchEpisodesByBgmID.
		if strings.Contains(r.URL.Path, "/api/v2/bangumi/bgmtv/") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"bangumi":{"animeId":700,"animeTitle":"Kaguya","imageUrl":"http://","episodes":[{"episodeId":1,"episodeTitle":"Ep1","episodeNumber":"1"},{"episodeId":2,"episodeTitle":"Ep2","episodeNumber":"2"}]}}`))
			return
		}
		// No other paths expected (no Phase 1 because no fileName).
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h, pool := makeHandlersWithBackend(t, backend)
	bgmID := int32(555)
	seedAnimeCache(t, pool, 900, "Kaguya-sama wa Kokurasetai", "Kaguya-sama", &bgmID)
	seedGenre(t, pool, 900, "Romance")
	seedStudio(t, pool, 900, "A-1 Pictures")

	body, _ := json.Marshal(MatchRequest{
		Keyword:  "Kaguya",
		Episodes: []int{1, 2},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/dandanplay/match", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	h.Match(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var out map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.True(t, matched, "body=%s", rec.Body.String())

	var src string
	require.NoError(t, json.Unmarshal(out["source"], &src))
	assert.Equal(t, "animeCache", src)

	// siteAnime should be enriched with genres + studios from PG.
	var site map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(out["siteAnime"], &site))
	var genres []string
	require.NoError(t, json.Unmarshal(site["genres"], &genres))
	assert.Contains(t, genres, "Romance")
	var studios []string
	require.NoError(t, json.Unmarshal(site["studios"], &studios))
	assert.Contains(t, studios, "A-1 Pictures")
}

// ─── buildKeywordPattern / searchAnimeCache unit ──────────────────────────

func TestBuildKeywordPattern(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"", "", false},
		{"   ", "", false},
		{"!!!", "", false},
		{"Kaguya", "%Kaguya%", true},
		{"Kaguya-sama wa", "%Kaguya%sama%wa%", true},
		{"進撃の巨人", "%進撃の巨人%", true},
		{"foo - bar 3", "%foo%bar%3%", true},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := buildKeywordPattern(tc.in)
			assert.Equal(t, tc.ok, ok)
			assert.Equal(t, tc.want, got)
		})
	}
}

// ─── envelope shape sanity ─────────────────────────────────────────────────

func TestWriteJSON_NoHTMLEscape(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, map[string]string{"x": "<a>"})
	// HTML escaping off — `<` should NOT be <.
	body := rec.Body.String()
	assert.Contains(t, body, "<a>", "HTML chars must be unescaped; got %s", body)
}

func TestWriteBareErrorJSON_Shape(t *testing.T) {
	rec := httptest.NewRecorder()
	writeBareErrorJSON(rec, http.StatusBadRequest, "oops")
	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.JSONEq(t, `{"error":"oops"}`, rec.Body.String())
}

// ─── NewHandlers fail-fast guards ─────────────────────────────────────────

func TestNewHandlers_NilDB_Panics(t *testing.T) {
	assert.Panics(t, func() {
		NewHandlers(nil, &fakeClient{}, nil)
	})
}

func TestNewHandlers_NilClient_Panics(t *testing.T) {
	assert.Panics(t, func() {
		NewHandlers(&fakeDB{}, nil, nil)
	})
}
