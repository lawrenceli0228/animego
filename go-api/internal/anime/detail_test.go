package anime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// -----------------------------------------------------------------------------
// Test doubles.
// -----------------------------------------------------------------------------

// detailFakeDB implements DetailDB for the detail tests.  Each method is
// a function-pointer field; unset fields return a clear "not set" error
// so accidental cross-call shows up immediately.  Mutex + counters track
// invocation count for cache-hit assertions.
type detailFakeDB struct {
	mu sync.Mutex

	getAnimeMainByIDFn            func(ctx context.Context, id int32) (dbgen.GetAnimeMainByIDRow, error)
	getAnimeGenresByIDFn          func(ctx context.Context, id int32) ([]string, error)
	getAnimeStudiosByIDFn         func(ctx context.Context, id int32) ([]string, error)
	getAnimeRelationsByIDFn       func(ctx context.Context, id int32) ([]dbgen.GetAnimeRelationsByIDRow, error)
	getAnimeCharactersByIDFn      func(ctx context.Context, id int32) ([]dbgen.GetAnimeCharactersByIDRow, error)
	getAnimeStaffByIDFn           func(ctx context.Context, id int32) ([]dbgen.GetAnimeStaffByIDRow, error)
	getAnimeRecommendationsByIDFn func(ctx context.Context, id int32) ([]dbgen.GetAnimeRecommendationsByIDRow, error)
	getRelationEnrichmentByIDsFn  func(ctx context.Context, ids []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error)

	mainCalls       atomic.Int32
	enrichmentCalls atomic.Int32
	enrichmentIDs   [][]int32
}

func (f *detailFakeDB) GetAnimeMainByID(ctx context.Context, id int32) (dbgen.GetAnimeMainByIDRow, error) {
	f.mainCalls.Add(1)
	if f.getAnimeMainByIDFn == nil {
		return dbgen.GetAnimeMainByIDRow{}, errors.New("detailFakeDB: GetAnimeMainByID not set")
	}
	return f.getAnimeMainByIDFn(ctx, id)
}

func (f *detailFakeDB) GetAnimeGenresByID(ctx context.Context, id int32) ([]string, error) {
	if f.getAnimeGenresByIDFn == nil {
		return []string{}, nil
	}
	return f.getAnimeGenresByIDFn(ctx, id)
}

func (f *detailFakeDB) GetAnimeStudiosByID(ctx context.Context, id int32) ([]string, error) {
	if f.getAnimeStudiosByIDFn == nil {
		return []string{}, nil
	}
	return f.getAnimeStudiosByIDFn(ctx, id)
}

func (f *detailFakeDB) GetAnimeRelationsByID(ctx context.Context, id int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
	if f.getAnimeRelationsByIDFn == nil {
		return []dbgen.GetAnimeRelationsByIDRow{}, nil
	}
	return f.getAnimeRelationsByIDFn(ctx, id)
}

func (f *detailFakeDB) GetAnimeCharactersByID(ctx context.Context, id int32) ([]dbgen.GetAnimeCharactersByIDRow, error) {
	if f.getAnimeCharactersByIDFn == nil {
		return []dbgen.GetAnimeCharactersByIDRow{}, nil
	}
	return f.getAnimeCharactersByIDFn(ctx, id)
}

func (f *detailFakeDB) GetAnimeStaffByID(ctx context.Context, id int32) ([]dbgen.GetAnimeStaffByIDRow, error) {
	if f.getAnimeStaffByIDFn == nil {
		return []dbgen.GetAnimeStaffByIDRow{}, nil
	}
	return f.getAnimeStaffByIDFn(ctx, id)
}

func (f *detailFakeDB) GetAnimeRecommendationsByID(ctx context.Context, id int32) ([]dbgen.GetAnimeRecommendationsByIDRow, error) {
	if f.getAnimeRecommendationsByIDFn == nil {
		return []dbgen.GetAnimeRecommendationsByIDRow{}, nil
	}
	return f.getAnimeRecommendationsByIDFn(ctx, id)
}

func (f *detailFakeDB) GetRelationEnrichmentByIDs(ctx context.Context, ids []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error) {
	f.enrichmentCalls.Add(1)
	f.mu.Lock()
	dup := make([]int32, len(ids))
	copy(dup, ids)
	f.enrichmentIDs = append(f.enrichmentIDs, dup)
	f.mu.Unlock()
	if f.getRelationEnrichmentByIDsFn == nil {
		return []dbgen.GetRelationEnrichmentByIDsRow{}, nil
	}
	return f.getRelationEnrichmentByIDsFn(ctx, ids)
}

// newDetailService builds a DetailService for tests.  t.Cleanup closes
// the cache so ristretto's background goroutines don't leak between
// parallel tests.
func newDetailService(t *testing.T, db DetailDB) *DetailService {
	t.Helper()
	s, err := NewDetailService(db)
	require.NoError(t, err)
	t.Cleanup(s.Close)
	return s
}

// serveDetail wires the chi URLParam plumbing the same way main.go
// will — chi.NewRouter().Get("/api/anime/{anilistId}", svc.Handler()).
// httptest.NewRequest by itself doesn't populate URLParam, so a real
// chi router is required for tests that read the :anilistId path piece.
func serveDetail(t *testing.T, svc *DetailService, path string) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	r.Get("/api/anime/{anilistId}", svc.Handler())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	r.ServeHTTP(rec, req)
	return rec
}

// detail tests reuse ptrString / ptrFloat64 from normalize.go (already
// defined in this package, see normalize.go:110+).

// -----------------------------------------------------------------------------
// Validation tests.
// -----------------------------------------------------------------------------

// TestDetail_InvalidID_400 verifies non-numeric :anilistId returns 400
// VALIDATION_ERROR with the byte-exact Chinese message "无效的番剧 ID".
func TestDetail_InvalidID_400(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/abc")

	require.Equal(t, http.StatusBadRequest, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"VALIDATION_ERROR"`)
	require.Contains(t, body, "无效的番剧 ID", "Chinese message must appear byte-exact")
	assert.Equal(t, int32(0), db.mainCalls.Load(), "no DB call on validation failure")
}

// TestDetail_ZeroID_400 verifies :anilistId=0 returns 400.  Zero is
// semantically equivalent to "missing" in Express's parseInt fallthrough,
// and Postgres anilist_id is a positive int — so we reject it as
// validation rather than letting it through to a 404.
func TestDetail_ZeroID_400(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/0")

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "无效的番剧 ID")
	assert.Equal(t, int32(0), db.mainCalls.Load(), "no DB call on zero id")
}

// TestDetail_NegativeID_400 verifies negative :anilistId also rejects
// with 400 (Postgres anilist_id is a positive int).
func TestDetail_NegativeID_400(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/-5")

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "无效的番剧 ID")
}

// TestDetail_NotInCache_404 verifies pgx.ErrNoRows on the main row
// maps to 404 NOT_FOUND with the Chinese message "番剧不存在".
func TestDetail_NotInCache_404(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/12345")

	require.Equal(t, http.StatusNotFound, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"NOT_FOUND"`)
	require.Contains(t, body, "番剧不存在", "Chinese 404 message must appear byte-exact")
}

// -----------------------------------------------------------------------------
// Happy-path tests.
// -----------------------------------------------------------------------------

// TestDetail_HappyPath_AllChildrenPopulated verifies the assembly logic:
// main row + 2 genres + 1 studio + 3 relations + 2 characters + 1 staff
// + 1 recommendation all appear in the response.
func TestDetail_HappyPath_AllChildrenPopulated(t *testing.T) {
	t.Parallel()

	romaji := "Test Title"
	cover := "https://example.com/cover.jpg"

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:      99,
				TitleRomaji:    &romaji,
				CoverImageUrl:  &cover,
				BangumiVersion: 2,
			}, nil
		},
		getAnimeGenresByIDFn: func(_ context.Context, _ int32) ([]string, error) {
			return []string{"Action", "Drama"}, nil
		},
		getAnimeStudiosByIDFn: func(_ context.Context, _ int32) ([]string, error) {
			return []string{"MAPPA"}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{
				{AnilistID: 101, RelationType: ptrString("PREQUEL"), Title: ptrString("Prequel")},
				{AnilistID: 102, RelationType: ptrString("SEQUEL"), Title: ptrString("Sequel")},
				{AnilistID: 103, RelationType: ptrString("SIDE_STORY"), Title: ptrString("Side")},
			}, nil
		},
		getAnimeCharactersByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeCharactersByIDRow, error) {
			return []dbgen.GetAnimeCharactersByIDRow{
				{NameEn: ptrString("Alice"), Role: ptrString("MAIN")},
				{NameEn: ptrString("Bob"), Role: ptrString("SUPPORTING")},
			}, nil
		},
		getAnimeStaffByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeStaffByIDRow, error) {
			return []dbgen.GetAnimeStaffByIDRow{
				{NameEn: ptrString("Director X"), Role: ptrString("Director")},
			}, nil
		},
		getAnimeRecommendationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRecommendationsByIDRow, error) {
			return []dbgen.GetAnimeRecommendationsByIDRow{
				{AnilistID: 201, Title: ptrString("Rec One"), AverageScore: ptrFloat64(82)},
			}, nil
		},
		getRelationEnrichmentByIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error) {
			return []dbgen.GetRelationEnrichmentByIDsRow{}, nil
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/99")

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"anilistId":99`)
	require.Contains(t, body, `"titleRomaji":"Test Title"`)
	require.Contains(t, body, `"genres":["Action","Drama"]`)
	require.Contains(t, body, `"studios":["MAPPA"]`)
	require.Contains(t, body, `"anilistId":101`)
	require.Contains(t, body, `"anilistId":102`)
	require.Contains(t, body, `"anilistId":103`)
	require.Contains(t, body, `"nameEn":"Alice"`)
	require.Contains(t, body, `"nameEn":"Bob"`)
	require.Contains(t, body, `"nameEn":"Director X"`)
	require.Contains(t, body, `"title":"Rec One"`)
	require.Contains(t, body, `"bangumiVersion":2`)
}

// TestDetail_EmptyChildren_NotNullArrays verifies the critical Express
// parity rule: empty slices serialise as `[]`, not `null`.  Frontend
// safety depends on this — Array.prototype.map on null would throw.
func TestDetail_EmptyChildren_NotNullArrays(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 7}, nil
		},
		// All child fns nil → defaults return empty slices.
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/7")

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, `"genres":[]`, "empty genres must be [] not null")
	assert.Contains(t, body, `"studios":[]`, "empty studios must be [] not null")
	assert.Contains(t, body, `"relations":[]`, "empty relations must be [] not null")
	assert.Contains(t, body, `"characters":[]`, "empty characters must be [] not null")
	assert.Contains(t, body, `"staff":[]`, "empty staff must be [] not null")
	assert.Contains(t, body, `"recommendations":[]`, "empty recommendations must be [] not null")

	// Negative assertions: none of these should appear as null.
	assert.NotContains(t, body, `"genres":null`)
	assert.NotContains(t, body, `"relations":null`)
}

// -----------------------------------------------------------------------------
// Relations enrichment tests.
// -----------------------------------------------------------------------------

// TestDetail_RelationsEnrichment_TitleChineseFilled verifies the
// enrichment map's titleChinese is grafted into the relation entry.
func TestDetail_RelationsEnrichment_TitleChineseFilled(t *testing.T) {
	t.Parallel()

	titleCn := "中文标题"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 10}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{
				{AnilistID: 500, RelationType: ptrString("SEQUEL"), Title: ptrString("Sequel")},
			}, nil
		},
		getRelationEnrichmentByIDsFn: func(_ context.Context, ids []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error) {
			require.Equal(t, []int32{500}, ids)
			return []dbgen.GetRelationEnrichmentByIDsRow{
				{AnilistID: 500, TitleChinese: &titleCn},
			}, nil
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/10")

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()

	// Parse + assert structurally so we don't pin on key ordering inside
	// the relation object.
	var parsed struct {
		Data struct {
			Relations []DetailRelation `json:"relations"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &parsed))
	require.Len(t, parsed.Data.Relations, 1)
	require.NotNil(t, parsed.Data.Relations[0].TitleChinese)
	assert.Equal(t, "中文标题", *parsed.Data.Relations[0].TitleChinese)
}

// TestDetail_RelationsEnrichment_CoverImageFallback verifies the fallback
// rule: when the relation row's coverImageUrl is nil, the enrichment
// map's value flows into the response.
func TestDetail_RelationsEnrichment_CoverImageFallback(t *testing.T) {
	t.Parallel()

	enrichedCover := "https://anime-cache.example.com/500.jpg"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 10}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{
				// Relation row has CoverImageUrl: nil.
				{AnilistID: 500, RelationType: ptrString("SEQUEL"), CoverImageUrl: nil},
			}, nil
		},
		getRelationEnrichmentByIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error) {
			return []dbgen.GetRelationEnrichmentByIDsRow{
				{AnilistID: 500, CoverImageUrl: &enrichedCover},
			}, nil
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/10")
	require.Equal(t, http.StatusOK, rec.Code)

	var parsed struct {
		Data struct {
			Relations []DetailRelation `json:"relations"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal([]byte(rec.Body.Bytes()), &parsed))
	require.Len(t, parsed.Data.Relations, 1)
	require.NotNil(t, parsed.Data.Relations[0].CoverImageUrl)
	assert.Equal(t, enrichedCover, *parsed.Data.Relations[0].CoverImageUrl, "fallback to enrichment cover")
}

// TestDetail_RelationsEnrichment_RelationCoverPreserved verifies the
// opposite case: when the relation row carries a non-nil coverImageUrl,
// it survives unchanged even if the enrichment map has a different one.
func TestDetail_RelationsEnrichment_RelationCoverPreserved(t *testing.T) {
	t.Parallel()

	relationCover := "https://relation.example.com/X.jpg"
	enrichedCover := "https://anime-cache.example.com/X.jpg"

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 10}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{
				{AnilistID: 500, CoverImageUrl: &relationCover},
			}, nil
		},
		getRelationEnrichmentByIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error) {
			return []dbgen.GetRelationEnrichmentByIDsRow{
				{AnilistID: 500, CoverImageUrl: &enrichedCover},
			}, nil
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/10")
	require.Equal(t, http.StatusOK, rec.Code)

	var parsed struct {
		Data struct {
			Relations []DetailRelation `json:"relations"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data.Relations, 1)
	require.NotNil(t, parsed.Data.Relations[0].CoverImageUrl)
	assert.Equal(t, relationCover, *parsed.Data.Relations[0].CoverImageUrl, "relation row's cover must win")
}

// TestDetail_NoRelations_NoEnrichmentCall verifies the IN(...) lookup is
// skipped entirely when relations is empty.  Otherwise we'd issue a
// no-op query against Postgres for every cache-miss without relations.
func TestDetail_NoRelations_NoEnrichmentCall(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 10}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{}, nil
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/10")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(0), db.enrichmentCalls.Load(), "no enrichment call when relations empty")
}

// -----------------------------------------------------------------------------
// Cache behaviour tests.
// -----------------------------------------------------------------------------

// TestDetail_CacheHit_NoDBCall verifies a second request with the same
// :anilistId is served from the ristretto cache without touching the DB.
func TestDetail_CacheHit_NoDBCall(t *testing.T) {
	t.Parallel()

	romaji := "Cache Test"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 42, TitleRomaji: &romaji}, nil
		},
	}
	svc := newDetailService(t, db)

	// First request: cache miss → hits DB.
	rec1 := serveDetail(t, svc, "/api/anime/42")
	require.Equal(t, http.StatusOK, rec1.Code)
	require.Equal(t, int32(1), db.mainCalls.Load())

	// Ristretto writes are asynchronous — must Wait() before the
	// second Get can observe the cached value.
	svc.cache.Wait()

	// Second request: cache hit → DB call count must NOT increment.
	rec2 := serveDetail(t, svc, "/api/anime/42")
	require.Equal(t, http.StatusOK, rec2.Code)
	assert.Equal(t, int32(1), db.mainCalls.Load(), "cache hit must skip DB")

	// Bodies must be byte-identical between cache miss and hit.
	assert.Equal(t, rec1.Body.String(), rec2.Body.String())
}

// TestDetail_DifferentIDs_DifferentCacheEntries verifies the cache key
// includes the anilistId — separate IDs do NOT collide.
func TestDetail_DifferentIDs_DifferentCacheEntries(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, id int32) (dbgen.GetAnimeMainByIDRow, error) {
			romaji := "anime-" + intToString(int(id))
			return dbgen.GetAnimeMainByIDRow{AnilistID: id, TitleRomaji: &romaji}, nil
		},
	}
	svc := newDetailService(t, db)

	rec1 := serveDetail(t, svc, "/api/anime/1")
	require.Equal(t, http.StatusOK, rec1.Code)
	rec2 := serveDetail(t, svc, "/api/anime/2")
	require.Equal(t, http.StatusOK, rec2.Code)

	assert.Equal(t, int32(2), db.mainCalls.Load(), "distinct IDs must each hit DB")
	assert.Contains(t, rec1.Body.String(), `"titleRomaji":"anime-1"`)
	assert.Contains(t, rec2.Body.String(), `"titleRomaji":"anime-2"`)
}

// intToString is a tiny helper used by the cache test so the dbgen-supplied
// id appears in the response without pulling in strconv at every call site.
func intToString(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// -----------------------------------------------------------------------------
// Error propagation.
// -----------------------------------------------------------------------------

// TestDetail_ChildQueryError_500 verifies any child-array query error
// fails the whole detail with 500 SERVER_ERROR.
func TestDetail_ChildQueryError_500(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 50}, nil
		},
		getAnimeGenresByIDFn: func(_ context.Context, _ int32) ([]string, error) {
			return nil, errors.New("simulated genre query failure")
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/50")

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"SERVER_ERROR"`)
	require.NotContains(t, body, "simulated genre query failure", "cause must not leak to client")
}

// TestDetail_MainQueryError_500 verifies a non-ErrNoRows error on the
// main row still maps to 500 (only pgx.ErrNoRows triggers 404).
func TestDetail_MainQueryError_500(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, errors.New("postgres connection refused")
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/77")

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"SERVER_ERROR"`)
	require.NotContains(t, body, "postgres connection refused")
}

// TestDetail_EnrichmentError_500 verifies the GetRelationEnrichmentByIDs
// failure also fails the whole request with 500 (not silently dropped).
func TestDetail_EnrichmentError_500(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 10}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{
				{AnilistID: 500},
			}, nil
		},
		getRelationEnrichmentByIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error) {
			return nil, errors.New("enrichment lookup failed")
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/10")

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

// -----------------------------------------------------------------------------
// Envelope shape + field-order tests.
// -----------------------------------------------------------------------------

// TestDetail_EnvelopeShape verifies the response is wrapped in the
// canonical {"data": {...}} envelope.
func TestDetail_EnvelopeShape(t *testing.T) {
	t.Parallel()

	romaji := "Envelope Test"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 1, TitleRomaji: &romaji}, nil
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/1")
	require.Equal(t, http.StatusOK, rec.Code)

	body := rec.Body.String()
	prefixSampleLen := len(body)
	if prefixSampleLen > 60 {
		prefixSampleLen = 60
	}
	assert.True(t, strings.HasPrefix(body, `{"data":{"anilistId":`),
		"body must start with {\"data\":{\"anilistId\": — got %q", body[:prefixSampleLen])

	// Top-level must have exactly one key: "data".
	var top map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(body), &top))
	require.Len(t, top, 1, "envelope must have exactly one top-level key")
	_, hasData := top["data"]
	assert.True(t, hasData, "envelope must wrap payload in `data`")
}

// TestDetail_FieldOrder verifies the first five JSON keys after the
// `data:{` opener appear in declaration order: anilistId, titleRomaji,
// titleEnglish, titleNative, titleChinese.  This is critical for
// byte-level parity with Express's mongoose document serialisation.
func TestDetail_FieldOrder(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 1}, nil
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/1")
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()

	keys := []string{
		`"anilistId"`,
		`"titleRomaji"`,
		`"titleEnglish"`,
		`"titleNative"`,
		`"titleChinese"`,
	}
	prev := -1
	for i, key := range keys {
		idx := strings.Index(body, key)
		require.NotEqual(t, -1, idx, "key %d (%s) must appear", i, key)
		assert.Greater(t, idx, prev, "key %s must appear after the previous key", key)
		prev = idx
	}

	// And the field-order must place coverImageUrl AFTER titleChinese,
	// matching the prompt spec.
	coverIdx := strings.Index(body, `"coverImageUrl"`)
	titleCnIdx := strings.Index(body, `"titleChinese"`)
	require.NotEqual(t, -1, coverIdx)
	require.NotEqual(t, -1, titleCnIdx)
	assert.Greater(t, coverIdx, titleCnIdx, "coverImageUrl must come after titleChinese")
}

// TestDetail_EnrichmentIDsCollected verifies the enrichment query receives
// the full set of relation anilistIds — duplicates are NOT filtered (the
// IN(...) clause de-dups at SQL level, and the response join key is
// AnilistID which is unique per row).
func TestDetail_EnrichmentIDsCollected(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 1}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{
				{AnilistID: 100},
				{AnilistID: 200},
				{AnilistID: 300},
			}, nil
		},
	}
	svc := newDetailService(t, db)

	rec := serveDetail(t, svc, "/api/anime/1")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, int32(1), db.enrichmentCalls.Load())

	db.mu.Lock()
	defer db.mu.Unlock()
	require.Len(t, db.enrichmentIDs, 1)
	assert.ElementsMatch(t, []int32{100, 200, 300}, db.enrichmentIDs[0])
}
