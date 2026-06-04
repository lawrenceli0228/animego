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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// -----------------------------------------------------------------------------
// Test doubles.
// -----------------------------------------------------------------------------

// detailFakeDB implements DetailDB for the detail tests.  Each method is
// a function-pointer field; unset fields return a clear "not set" error
// (for the main row read) or a sensible zero (for everything else) so
// accidental cross-call shows up immediately without forcing each test
// to wire up all twenty methods.
//
// Mutex + counters track invocation count for cache-hit and upsert-call
// assertions (re-fetch path tests).
type detailFakeDB struct {
	mu sync.Mutex

	// Readers
	getAnimeMainByIDFn            func(ctx context.Context, id int32) (dbgen.GetAnimeMainByIDRow, error)
	getAnimeGenresByIDFn          func(ctx context.Context, id int32) ([]string, error)
	getAnimeStudiosByIDFn         func(ctx context.Context, id int32) ([]string, error)
	getAnimeRelationsByIDFn       func(ctx context.Context, id int32) ([]dbgen.GetAnimeRelationsByIDRow, error)
	getAnimeCharactersByIDFn      func(ctx context.Context, id int32) ([]dbgen.GetAnimeCharactersByIDRow, error)
	getAnimeStaffByIDFn           func(ctx context.Context, id int32) ([]dbgen.GetAnimeStaffByIDRow, error)
	getAnimeRecommendationsByIDFn func(ctx context.Context, id int32) ([]dbgen.GetAnimeRecommendationsByIDRow, error)
	getAnimeEpisodeTitlesByIDFn   func(ctx context.Context, id int32) ([]dbgen.GetAnimeEpisodeTitlesByIDRow, error)
	getRelationEnrichmentByIDsFn  func(ctx context.Context, ids []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error)

	// Writers (P2.1.6 re-fetch path).  Defaults return nil error.
	upsertAnimeCacheFn            func(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error
	deleteAnimeGenresFn           func(ctx context.Context, id int32) error
	insertAnimeGenreFn            func(ctx context.Context, id int32, g string) error
	deleteAnimeStudiosFn          func(ctx context.Context, id int32) error
	insertAnimeStudioFn           func(ctx context.Context, id int32, s string) error
	deleteAnimeRelationsFn        func(ctx context.Context, id int32) error
	insertAnimeRelationFn         func(ctx context.Context, arg dbgen.InsertAnimeRelationParams) error
	deleteAnimeCharactersFn       func(ctx context.Context, id int32) error
	insertAnimeCharacterFn        func(ctx context.Context, arg dbgen.InsertAnimeCharacterParams) error
	deleteAnimeStaffFn            func(ctx context.Context, id int32) error
	insertAnimeStaffMemberFn      func(ctx context.Context, arg dbgen.InsertAnimeStaffMemberParams) error
	deleteAnimeRecommendationsFn  func(ctx context.Context, id int32) error
	insertAnimeRecommendationFn   func(ctx context.Context, arg dbgen.InsertAnimeRecommendationParams) error

	mainCalls       atomic.Int32
	enrichmentCalls atomic.Int32
	enrichmentIDs   [][]int32

	// Writer call counts — used by upsert-path tests to assert the
	// expected number of Delete+Insert pairs ran.
	upsertMainCalls           atomic.Int32
	deleteGenresCalls         atomic.Int32
	insertGenreCalls          atomic.Int32
	deleteStudiosCalls        atomic.Int32
	insertStudioCalls         atomic.Int32
	deleteRelationsCalls      atomic.Int32
	insertRelationCalls       atomic.Int32
	deleteCharactersCalls     atomic.Int32
	insertCharacterCalls      atomic.Int32
	deleteStaffCalls          atomic.Int32
	insertStaffCalls          atomic.Int32
	deleteRecommendationsCalls atomic.Int32
	insertRecommendationCalls  atomic.Int32

	// Captured args for byte-shape assertions on the re-fetch path.
	upsertParams          []dbgen.UpsertAnimeCacheParams
	insertedGenres        []string
	insertedStudios       []string
	insertedRelations     []dbgen.InsertAnimeRelationParams
	insertedCharacters    []dbgen.InsertAnimeCharacterParams
	insertedStaff         []dbgen.InsertAnimeStaffMemberParams
	insertedRecommendations []dbgen.InsertAnimeRecommendationParams
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

func (f *detailFakeDB) GetAnimeEpisodeTitlesByID(ctx context.Context, id int32) ([]dbgen.GetAnimeEpisodeTitlesByIDRow, error) {
	if f.getAnimeEpisodeTitlesByIDFn == nil {
		return []dbgen.GetAnimeEpisodeTitlesByIDRow{}, nil
	}
	return f.getAnimeEpisodeTitlesByIDFn(ctx, id)
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

// -----------------------------------------------------------------------------
// Writer methods (P2.1.6 re-fetch path).  Each captures the argument under
// mu so tests can inspect the byte shape, and increments the call counter
// for "how many times did this run" assertions.
// -----------------------------------------------------------------------------

func (f *detailFakeDB) UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error {
	f.upsertMainCalls.Add(1)
	f.mu.Lock()
	f.upsertParams = append(f.upsertParams, arg)
	f.mu.Unlock()
	if f.upsertAnimeCacheFn != nil {
		return f.upsertAnimeCacheFn(ctx, arg)
	}
	return nil
}

func (f *detailFakeDB) DeleteAnimeGenres(ctx context.Context, id int32) error {
	f.deleteGenresCalls.Add(1)
	if f.deleteAnimeGenresFn != nil {
		return f.deleteAnimeGenresFn(ctx, id)
	}
	return nil
}

func (f *detailFakeDB) InsertAnimeGenre(ctx context.Context, id int32, g string) error {
	f.insertGenreCalls.Add(1)
	f.mu.Lock()
	f.insertedGenres = append(f.insertedGenres, g)
	f.mu.Unlock()
	if f.insertAnimeGenreFn != nil {
		return f.insertAnimeGenreFn(ctx, id, g)
	}
	return nil
}

func (f *detailFakeDB) DeleteAnimeStudios(ctx context.Context, id int32) error {
	f.deleteStudiosCalls.Add(1)
	if f.deleteAnimeStudiosFn != nil {
		return f.deleteAnimeStudiosFn(ctx, id)
	}
	return nil
}

func (f *detailFakeDB) InsertAnimeStudio(ctx context.Context, id int32, s string) error {
	f.insertStudioCalls.Add(1)
	f.mu.Lock()
	f.insertedStudios = append(f.insertedStudios, s)
	f.mu.Unlock()
	if f.insertAnimeStudioFn != nil {
		return f.insertAnimeStudioFn(ctx, id, s)
	}
	return nil
}

func (f *detailFakeDB) DeleteAnimeRelations(ctx context.Context, id int32) error {
	f.deleteRelationsCalls.Add(1)
	if f.deleteAnimeRelationsFn != nil {
		return f.deleteAnimeRelationsFn(ctx, id)
	}
	return nil
}

func (f *detailFakeDB) InsertAnimeRelation(ctx context.Context, arg dbgen.InsertAnimeRelationParams) error {
	f.insertRelationCalls.Add(1)
	f.mu.Lock()
	f.insertedRelations = append(f.insertedRelations, arg)
	f.mu.Unlock()
	if f.insertAnimeRelationFn != nil {
		return f.insertAnimeRelationFn(ctx, arg)
	}
	return nil
}

func (f *detailFakeDB) DeleteAnimeCharacters(ctx context.Context, id int32) error {
	f.deleteCharactersCalls.Add(1)
	if f.deleteAnimeCharactersFn != nil {
		return f.deleteAnimeCharactersFn(ctx, id)
	}
	return nil
}

func (f *detailFakeDB) InsertAnimeCharacter(ctx context.Context, arg dbgen.InsertAnimeCharacterParams) error {
	f.insertCharacterCalls.Add(1)
	f.mu.Lock()
	f.insertedCharacters = append(f.insertedCharacters, arg)
	f.mu.Unlock()
	if f.insertAnimeCharacterFn != nil {
		return f.insertAnimeCharacterFn(ctx, arg)
	}
	return nil
}

func (f *detailFakeDB) DeleteAnimeStaff(ctx context.Context, id int32) error {
	f.deleteStaffCalls.Add(1)
	if f.deleteAnimeStaffFn != nil {
		return f.deleteAnimeStaffFn(ctx, id)
	}
	return nil
}

func (f *detailFakeDB) InsertAnimeStaffMember(ctx context.Context, arg dbgen.InsertAnimeStaffMemberParams) error {
	f.insertStaffCalls.Add(1)
	f.mu.Lock()
	f.insertedStaff = append(f.insertedStaff, arg)
	f.mu.Unlock()
	if f.insertAnimeStaffMemberFn != nil {
		return f.insertAnimeStaffMemberFn(ctx, arg)
	}
	return nil
}

func (f *detailFakeDB) DeleteAnimeRecommendations(ctx context.Context, id int32) error {
	f.deleteRecommendationsCalls.Add(1)
	if f.deleteAnimeRecommendationsFn != nil {
		return f.deleteAnimeRecommendationsFn(ctx, id)
	}
	return nil
}

func (f *detailFakeDB) InsertAnimeRecommendation(ctx context.Context, arg dbgen.InsertAnimeRecommendationParams) error {
	f.insertRecommendationCalls.Add(1)
	f.mu.Lock()
	f.insertedRecommendations = append(f.insertedRecommendations, arg)
	f.mu.Unlock()
	if f.insertAnimeRecommendationFn != nil {
		return f.insertAnimeRecommendationFn(ctx, arg)
	}
	return nil
}

// -----------------------------------------------------------------------------
// fakeAniListDetailer — AniListDetailer test double.
// -----------------------------------------------------------------------------

// fakeAniListDetailer captures Detail() invocations and returns a canned
// response or error.  Used by every stale / re-fetch test.
type fakeAniListDetailer struct {
	mu       sync.Mutex
	detailFn func(ctx context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error)
	calls    atomic.Int32
	gotVars  []anilist.DetailVars
}

func (f *fakeAniListDetailer) Detail(ctx context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
	f.calls.Add(1)
	f.mu.Lock()
	f.gotVars = append(f.gotVars, v)
	f.mu.Unlock()
	if f.detailFn == nil {
		return &anilist.AnimeDetailResponse{}, nil
	}
	return f.detailFn(ctx, v)
}

// newDetailService builds a DetailService for tests with anilist=nil
// (cache-only path).  t.Cleanup closes the cache so ristretto's
// background goroutines don't leak between parallel tests.
func newDetailService(t *testing.T, db DetailDB) *DetailService {
	t.Helper()
	s, err := NewDetailService(db, nil)
	require.NoError(t, err)
	t.Cleanup(s.Close)
	return s
}

// newDetailServiceWithAniList builds a DetailService for tests that
// exercise the re-fetch path.  Pass a *fakeAniListDetailer with the
// desired detailFn canned response.
func newDetailServiceWithAniList(t *testing.T, db DetailDB, al AniListDetailer) *DetailService {
	t.Helper()
	s, err := NewDetailService(db, al)
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

// =============================================================================
// P2.1.6 stale detection + AniList re-fetch tests.
//
// Two cohorts:
//   1. isStale unit tests — pure function over the four input slices, no
//      service spin-up.  Easier to read than HTTP round-trips for the
//      boolean logic and they catch regressions in the threshold rules.
//   2. End-to-end re-fetch tests through Handler() — assert the right
//      DB writer methods get called the right number of times based on
//      the canned AniList payload, and that the final HTTP envelope
//      reflects post-refetch values.
// =============================================================================

// -----------------------------------------------------------------------------
// isStale: pure function tests.
// -----------------------------------------------------------------------------

// freshTimestamp builds a non-stale cached_at — 5 minutes ago, well
// inside the staleCacheTTL window.
func freshTimestamp() pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: time.Now().Add(-5 * time.Minute), Valid: true}
}

// staleTimestamp builds a stale cached_at — 25 hours ago, beyond the 24h
// staleCacheTTL threshold.
func staleTimestamp() pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: time.Now().Add(-25 * time.Hour), Valid: true}
}

// TestIsStale_FreshNotStale: all five checks pass → false.
func TestIsStale_FreshNotStale(t *testing.T) {
	t.Parallel()

	main := dbgen.GetAnimeMainByIDRow{CachedAt: freshTimestamp()}
	studios := []string{"MAPPA"}
	characters := []dbgen.GetAnimeCharactersByIDRow{
		{NameEn: ptrString("Alice"), Role: ptrString("MAIN")},
	}
	relations := []dbgen.GetAnimeRelationsByIDRow{
		{AnilistID: 100, CoverImageUrl: ptrString("https://cdn/100.jpg")},
	}
	assert.False(t, isStale(main, studios, characters, relations))
}

// TestIsStale_CachedAtPastTTL: cached_at > staleCacheTTL ago → true.
func TestIsStale_CachedAtPastTTL(t *testing.T) {
	t.Parallel()

	main := dbgen.GetAnimeMainByIDRow{CachedAt: staleTimestamp()}
	studios := []string{"MAPPA"}
	characters := []dbgen.GetAnimeCharactersByIDRow{{Role: ptrString("MAIN")}}
	relations := []dbgen.GetAnimeRelationsByIDRow{}
	assert.True(t, isStale(main, studios, characters, relations), "old cached_at must trip stale")
}

// TestIsStale_EmptyStudios: characters present but studios empty → true.
func TestIsStale_EmptyStudios(t *testing.T) {
	t.Parallel()

	main := dbgen.GetAnimeMainByIDRow{CachedAt: freshTimestamp()}
	characters := []dbgen.GetAnimeCharactersByIDRow{{Role: ptrString("MAIN")}}
	assert.True(t, isStale(main, []string{}, characters, nil), "empty studios must trip stale")
}

// TestIsStale_EmptyCharacters: studios present but characters empty → true.
func TestIsStale_EmptyCharacters(t *testing.T) {
	t.Parallel()

	main := dbgen.GetAnimeMainByIDRow{CachedAt: freshTimestamp()}
	assert.True(t, isStale(main, []string{"MAPPA"}, []dbgen.GetAnimeCharactersByIDRow{}, nil),
		"empty characters must trip stale")
}

// TestIsStale_FirstCharacterRoleNil: characters[0].Role missing → true.
// Express checks `cached.characters?.length > 0 && cached.characters[0].role === undefined`.
func TestIsStale_FirstCharacterRoleNil(t *testing.T) {
	t.Parallel()

	main := dbgen.GetAnimeMainByIDRow{CachedAt: freshTimestamp()}
	characters := []dbgen.GetAnimeCharactersByIDRow{{NameEn: ptrString("Bob"), Role: nil}}
	assert.True(t, isStale(main, []string{"MAPPA"}, characters, nil),
		"first character with nil role must trip stale")
}

// TestIsStale_FirstRelationCoverNil: relations[0].CoverImageUrl missing → true.
// Express's last branch:
//
//	cached.relations?.length > 0 && !cached.relations[0].coverImageUrl
func TestIsStale_FirstRelationCoverNil(t *testing.T) {
	t.Parallel()

	main := dbgen.GetAnimeMainByIDRow{CachedAt: freshTimestamp()}
	characters := []dbgen.GetAnimeCharactersByIDRow{{Role: ptrString("MAIN")}}
	relations := []dbgen.GetAnimeRelationsByIDRow{{AnilistID: 100, CoverImageUrl: nil}}
	assert.True(t, isStale(main, []string{"MAPPA"}, characters, relations),
		"first relation with nil cover_image_url must trip stale")
}

// TestIsStale_NoRelations_NotTriggerByCover: when relations is empty, the
// "first relation cover nil" check must NOT fire (Express: relations length > 0
// is the guard).
func TestIsStale_NoRelations_NotTriggerByCover(t *testing.T) {
	t.Parallel()

	main := dbgen.GetAnimeMainByIDRow{CachedAt: freshTimestamp()}
	characters := []dbgen.GetAnimeCharactersByIDRow{{Role: ptrString("MAIN")}}
	assert.False(t, isStale(main, []string{"MAPPA"}, characters, []dbgen.GetAnimeRelationsByIDRow{}),
		"empty relations slice must not by itself trip stale")
}

// -----------------------------------------------------------------------------
// fetchDetail re-fetch path: nil anilist client.
// -----------------------------------------------------------------------------

// TestDetail_NilAniList_StaleNeverFires verifies the cache-only path: even
// when the cached row is patently stale (no characters, no studios), the
// service returns the DB rows as-is and does NOT call any writer methods.
//
// This guards the "AniList not wired" deployment shape so a half-installed
// service still serves whatever's in the cache.
func TestDetail_NilAniList_StaleNeverFires(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			// Stale row: no characters → would trip isStale=true.
			return dbgen.GetAnimeMainByIDRow{AnilistID: 1, CachedAt: freshTimestamp()}, nil
		},
		// characters/studios fns are nil → return empty slices (stale).
	}
	svc := newDetailService(t, db) // nil anilist

	rec := serveDetail(t, svc, "/api/anime/1")
	require.Equal(t, http.StatusOK, rec.Code)

	// No writer methods were called — proves the re-fetch path stayed off.
	assert.Equal(t, int32(0), db.upsertMainCalls.Load())
	assert.Equal(t, int32(0), db.deleteCharactersCalls.Load())
	assert.Equal(t, int32(0), db.deleteStudiosCalls.Load())
}

// TestDetail_NotInCache_AniListNil_404 verifies the original behaviour: when
// there's no cache row AND no anilist client, return 404 with the Chinese
// message.  Same shape as the pre-P2.1.6 TestDetail_NotInCache_404 but with
// the new constructor signature.
func TestDetail_NotInCache_AniListNil_404(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
		},
	}
	svc := newDetailService(t, db) // nil anilist
	rec := serveDetail(t, svc, "/api/anime/12345")

	require.Equal(t, http.StatusNotFound, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"NOT_FOUND"`)
	require.Contains(t, body, "番剧不存在")
}

// -----------------------------------------------------------------------------
// fetchDetail re-fetch path: AniList client wired.
// -----------------------------------------------------------------------------

// makeDetailMedia builds a minimal but fully-populated anilist.Media for
// re-fetch tests.  Each field that drives a child-table write is present
// so the test can assert one row of each insert was attempted.
func makeDetailMedia(id int) anilist.Media {
	romaji := "Re-fetched Title"
	cover := "https://cdn/cover.jpg"
	color := "#3b82f6"
	studio := "WIT"
	relType := "SEQUEL"
	relTitle := "Sequel"
	relCover := "https://cdn/rel.jpg"
	chFull := "Hero"
	chRole := "MAIN"
	vaFull := "VA"
	staffFull := "Director"
	staffRole := "Director"
	recTitle := "Rec"
	recCover := "https://cdn/rec.jpg"
	avgScore := 88

	return anilist.Media{
		ID:           id,
		Title:        &anilist.Title{Romaji: &romaji},
		CoverImage:   &anilist.CoverImage{Large: &cover, Color: &color},
		Genres:       []string{"Action"},
		Studios:      &anilist.StudioConnection{Nodes: []anilist.Studio{{Name: studio}}},
		Relations: &anilist.RelationConnection{Edges: []anilist.RelationEdge{
			{
				RelationType: &relType,
				Node: anilist.RelationNode{
					ID:         500,
					Title:      &anilist.Title{Romaji: &relTitle},
					CoverImage: &anilist.CoverImage{Large: &relCover, Color: &color},
				},
			},
		}},
		Characters: &anilist.CharacterConnection{Edges: []anilist.CharacterEdge{
			{
				Role: &chRole,
				Node: anilist.CharacterNode{Name: &anilist.PersonName{Full: &chFull}},
				VoiceActors: []anilist.VoiceActor{
					{Name: &anilist.PersonName{Full: &vaFull}},
				},
			},
		}},
		Staff: &anilist.StaffConnection{Edges: []anilist.StaffEdge{
			{Role: &staffRole, Node: anilist.StaffNode{Name: &anilist.PersonName{Full: &staffFull}}},
		}},
		Recommendations: &anilist.RecommendationConnection{Nodes: []anilist.RecommendationNode{
			{MediaRecommendation: &anilist.MediaRecommendation{
				ID:           600,
				Title:        &anilist.Title{Romaji: &recTitle},
				CoverImage:   &anilist.CoverImage{Large: &recCover, Color: &color},
				AverageScore: &avgScore,
			}},
		}},
	}
}

// TestDetail_NotInCache_AniListReFetchSucceeds verifies: pgx.ErrNoRows on
// main → re-fetch via AniList → upsert main + 6 child tables → re-read +
// return 200 OK with the re-fetched data.
//
// readCount tracks the GetAnimeMainByID call count: the FIRST call is the
// pre-refetch read (returns ErrNoRows), the SECOND is the post-refetch
// re-read (must return a populated row).
func TestDetail_NotInCache_AniListReFetchSucceeds(t *testing.T) {
	t.Parallel()

	var readCount atomic.Int32
	romaji := "Re-fetched Title"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			if readCount.Add(1) == 1 {
				return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
			}
			// Post-refetch re-read.
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:   42,
				TitleRomaji: &romaji,
				CachedAt:    freshTimestamp(),
			}, nil
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			require.Equal(t, 42, v.ID)
			return &anilist.AnimeDetailResponse{Media: makeDetailMedia(42)}, nil
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/42")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	body := rec.Body.String()
	require.Contains(t, body, `"anilistId":42`)
	require.Contains(t, body, `"titleRomaji":"Re-fetched Title"`)

	// Re-fetch was attempted.
	assert.Equal(t, int32(1), al.calls.Load(), "AniList.Detail must be called exactly once")
	// Main row upsert + 6 Delete + N Inserts ran.  Counts: 1 genre / 1
	// studio / 1 relation / 1 character / 1 staff / 1 recommendation.
	assert.Equal(t, int32(1), db.upsertMainCalls.Load())
	assert.Equal(t, int32(1), db.deleteGenresCalls.Load())
	assert.Equal(t, int32(1), db.insertGenreCalls.Load())
	assert.Equal(t, int32(1), db.deleteStudiosCalls.Load())
	assert.Equal(t, int32(1), db.insertStudioCalls.Load())
	assert.Equal(t, int32(1), db.deleteRelationsCalls.Load())
	assert.Equal(t, int32(1), db.insertRelationCalls.Load())
	assert.Equal(t, int32(1), db.deleteCharactersCalls.Load())
	assert.Equal(t, int32(1), db.insertCharacterCalls.Load())
	assert.Equal(t, int32(1), db.deleteStaffCalls.Load())
	assert.Equal(t, int32(1), db.insertStaffCalls.Load())
	assert.Equal(t, int32(1), db.deleteRecommendationsCalls.Load())
	assert.Equal(t, int32(1), db.insertRecommendationCalls.Load())
}

// TestDetail_StaleDetected_AniListReFetchSucceeds verifies the cache-miss
// + stale path: main row exists but characters are empty → isStale=true →
// AniList re-fetch fires, writer methods run, response reflects the
// re-fetched data.
func TestDetail_StaleDetected_AniListReFetchSucceeds(t *testing.T) {
	t.Parallel()

	var readCount atomic.Int32
	romaji := "Stale Pre-Refetch"
	romajiAfter := "Refetched"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			c := readCount.Add(1)
			if c == 1 {
				return dbgen.GetAnimeMainByIDRow{
					AnilistID:   77,
					TitleRomaji: &romaji,
					CachedAt:    freshTimestamp(),
					// no characters → triggers stale check below
				}, nil
			}
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:   77,
				TitleRomaji: &romajiAfter,
				CachedAt:    freshTimestamp(),
			}, nil
		},
		// characters/studios fns nil → empty slices → isStale=true.
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			require.Equal(t, 77, v.ID)
			return &anilist.AnimeDetailResponse{Media: makeDetailMedia(77)}, nil
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/77")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	body := rec.Body.String()
	require.Contains(t, body, `"titleRomaji":"Refetched"`, "must reflect post-refetch title")
	assert.Equal(t, int32(1), al.calls.Load(), "AniList.Detail must fire once")
	assert.Equal(t, int32(1), db.upsertMainCalls.Load())
}

// TestDetail_StaleDetected_AniListFails_FallbackToStale verifies the
// resilience contract: when AniList re-fetch fails, the request still
// returns the in-flight stale row (200 OK) instead of a 5xx.
func TestDetail_StaleDetected_AniListFails_FallbackToStale(t *testing.T) {
	t.Parallel()

	staleTitle := "Stale But Visible"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:   88,
				TitleRomaji: &staleTitle,
				CachedAt:    freshTimestamp(),
			}, nil
			// no characters → isStale=true
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return nil, errors.New("upstream blew up")
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/88")

	require.Equal(t, http.StatusOK, rec.Code, "must fall back to stale, not 500")
	require.Contains(t, rec.Body.String(), `"titleRomaji":"Stale But Visible"`)
	assert.Equal(t, int32(1), al.calls.Load(), "AniList.Detail was attempted")
	assert.Equal(t, int32(0), db.upsertMainCalls.Load(), "upsert did not run after AniList failed")
}

// TestDetail_FreshNotStale_SkipsReFetch verifies the inverse: when the
// cached row passes all five isStale checks, NO AniList call is made even
// though the anilist client is wired.
func TestDetail_FreshNotStale_SkipsReFetch(t *testing.T) {
	t.Parallel()

	romaji := "Already Fresh"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:   99,
				TitleRomaji: &romaji,
				CachedAt:    freshTimestamp(),
			}, nil
		},
		getAnimeStudiosByIDFn: func(_ context.Context, _ int32) ([]string, error) {
			return []string{"MAPPA"}, nil
		},
		getAnimeCharactersByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeCharactersByIDRow, error) {
			return []dbgen.GetAnimeCharactersByIDRow{
				{NameEn: ptrString("Alice"), Role: ptrString("MAIN")},
			}, nil
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			t.Fatal("AniList.Detail must NOT be called for fresh row")
			return nil, nil
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/99")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(0), al.calls.Load(), "no AniList call for fresh row")
	assert.Equal(t, int32(0), db.upsertMainCalls.Load(), "no upsert for fresh row")
}

// TestDetail_StaleByCachedAt verifies the time-based stale path: even when
// every content check passes, an old cached_at trips the stale flag and
// triggers a re-fetch.
func TestDetail_StaleByCachedAt(t *testing.T) {
	t.Parallel()

	var readCount atomic.Int32
	romajiPre := "Pre-stale"
	romajiPost := "Post-stale"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			if readCount.Add(1) == 1 {
				return dbgen.GetAnimeMainByIDRow{
					AnilistID:   55,
					TitleRomaji: &romajiPre,
					CachedAt:    staleTimestamp(), // > 1h ago
				}, nil
			}
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:   55,
				TitleRomaji: &romajiPost,
				CachedAt:    freshTimestamp(),
			}, nil
		},
		// Content checks all pass — only cached_at is stale.
		getAnimeStudiosByIDFn: func(_ context.Context, _ int32) ([]string, error) {
			return []string{"WIT"}, nil
		},
		getAnimeCharactersByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeCharactersByIDRow, error) {
			return []dbgen.GetAnimeCharactersByIDRow{
				{NameEn: ptrString("X"), Role: ptrString("MAIN")},
			}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{
				{AnilistID: 100, CoverImageUrl: ptrString("https://cdn/100.jpg")},
			}, nil
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return &anilist.AnimeDetailResponse{Media: makeDetailMedia(v.ID)}, nil
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/55")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(1), al.calls.Load(), "stale cached_at must trigger re-fetch")
	require.Contains(t, rec.Body.String(), `"titleRomaji":"Post-stale"`)
}

// TestDetail_UpsertFromMedia_ChildrenShapesAreCorrect inspects the captured
// args from a re-fetch run to confirm:
//   - InsertAnimeRelation rows carry the parent anime_id and the relation's
//     own anilist_id.
//   - DisplayOrder is the 0-based slice index on characters/staff.
//   - Accent fields are non-nil (came through colorx).
func TestDetail_UpsertFromMedia_ChildrenShapesAreCorrect(t *testing.T) {
	t.Parallel()

	var readCount atomic.Int32
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			if readCount.Add(1) == 1 {
				return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
			}
			return dbgen.GetAnimeMainByIDRow{AnilistID: 42, CachedAt: freshTimestamp()}, nil
		},
	}
	media := makeDetailMedia(42)
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return &anilist.AnimeDetailResponse{Media: media}, nil
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/42")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	db.mu.Lock()
	defer db.mu.Unlock()
	require.Len(t, db.insertedRelations, 1)
	rel := db.insertedRelations[0]
	assert.Equal(t, int32(42), rel.AnimeID, "parent anime_id propagated")
	assert.Equal(t, int32(500), rel.AnilistID, "relation's own anilist_id from Media")
	require.NotNil(t, rel.PosterAccent)
	require.NotNil(t, rel.PosterAccentRgb)
	require.NotNil(t, rel.PosterAccentContrastOnBlack)
	require.NotNil(t, rel.CoverImageUrl)
	assert.Equal(t, "https://cdn/rel.jpg", *rel.CoverImageUrl, ".large preferred for relation cover")

	require.Len(t, db.insertedCharacters, 1)
	ch := db.insertedCharacters[0]
	assert.Equal(t, int32(42), ch.AnimeID)
	assert.Equal(t, int32(0), ch.DisplayOrder, "first character gets display_order=0")
	require.NotNil(t, ch.NameEn)
	assert.Equal(t, "Hero", *ch.NameEn)
	require.NotNil(t, ch.VoiceActorEn)
	assert.Equal(t, "VA", *ch.VoiceActorEn)
	assert.Nil(t, ch.NameCn, "AniList never sets name_cn")

	require.Len(t, db.insertedStaff, 1)
	st := db.insertedStaff[0]
	assert.Equal(t, int32(42), st.AnimeID)
	assert.Equal(t, int32(0), st.DisplayOrder)
	require.NotNil(t, st.NameEn)
	assert.Equal(t, "Director", *st.NameEn)

	require.Len(t, db.insertedRecommendations, 1)
	rec2 := db.insertedRecommendations[0]
	assert.Equal(t, int32(42), rec2.AnimeID)
	assert.Equal(t, int32(600), rec2.AnilistID)
	require.NotNil(t, rec2.AverageScore)
	assert.InDelta(t, 88.0, *rec2.AverageScore, 0.0001)

	assert.Equal(t, []string{"Action"}, db.insertedGenres)
	assert.Equal(t, []string{"WIT"}, db.insertedStudios)
}

// TestDetail_AniListReturnsNullMedia_404 verifies that an AniList response
// whose Media is the zero value (Media: null on the wire) maps to 404
// "番剧不存在" — Express's getAnimeDetail does the same when the upstream
// id is unknown.
func TestDetail_AniListReturnsNullMedia_404(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			// Media.ID = 0 — distinguishes "AniList said unknown" from a
			// transport error.
			return &anilist.AnimeDetailResponse{Media: anilist.Media{}}, nil
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/99999")
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Contains(t, rec.Body.String(), "番剧不存在")
	assert.Equal(t, int32(0), db.upsertMainCalls.Load(), "no upsert when AniList returned null")
}

// TestDetail_AniListUpstreamError_502 verifies that a 500-class upstream
// error on the initial-fetch path maps to a 502 BAD_GATEWAY (so frontend
// can distinguish "we tried but AniList broke" from "we couldn't find it").
func TestDetail_AniListUpstreamError_502(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return nil, &anilist.ErrUpstream{Status: 500, Message: "AniList down"}
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/12345")
	require.Equal(t, http.StatusBadGateway, rec.Code)
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

// TestDetail_AniListReturnsUpstream404_MapsTo404 verifies the special
// case: when AniList itself returns 404 (rare — usually means a
// hard-deleted id), surface it as the same Chinese 404 message the cache
// path uses, not a 502.
func TestDetail_AniListReturnsUpstream404_MapsTo404(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return nil, &anilist.ErrUpstream{Status: 404, Message: "Media not found"}
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/99999")
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Contains(t, rec.Body.String(), "番剧不存在")
}

// TestDetail_UpsertFromMedia_DeleteGenresFails_500 forces a writer-method
// failure inside the upsert path and verifies the request maps to 500
// SERVER_ERROR.  This guards the wrap-and-rethrow chain on each
// sub-step of upsertFromMedia.
func TestDetail_UpsertFromMedia_DeleteGenresFails_500(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
		},
		deleteAnimeGenresFn: func(_ context.Context, _ int32) error {
			return errors.New("genres delete blew up")
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return &anilist.AnimeDetailResponse{Media: makeDetailMedia(42)}, nil
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/42")
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
	require.NotContains(t, rec.Body.String(), "genres delete blew up", "internal cause must not leak")
}

// TestDetail_UpsertFromMedia_InsertRelationFails_500 hits a different
// sub-step of the upsert pipeline (the relations Insert) — this branch
// would otherwise be unreachable through happy-path tests.
func TestDetail_UpsertFromMedia_InsertRelationFails_500(t *testing.T) {
	t.Parallel()

	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
		},
		insertAnimeRelationFn: func(_ context.Context, _ dbgen.InsertAnimeRelationParams) error {
			return errors.New("relation insert blew up")
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return &anilist.AnimeDetailResponse{Media: makeDetailMedia(42)}, nil
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/42")
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

// TestConvertRelationsToDetailRelations exercises the fallback path used
// when relations enrichment fails post-refetch.  Pure function, no HTTP
// wiring needed.
func TestConvertRelationsToDetailRelations(t *testing.T) {
	t.Run("empty input returns empty slice", func(t *testing.T) {
		got := convertRelationsToDetailRelations(nil)
		assert.Empty(t, got)
		assert.NotNil(t, got)
	})
	t.Run("preserves row fields one-for-one", func(t *testing.T) {
		got := convertRelationsToDetailRelations([]dbgen.GetAnimeRelationsByIDRow{
			{
				AnilistID:     100,
				RelationType:  ptrString("SEQUEL"),
				Title:         ptrString("Sequel"),
				CoverImageUrl: ptrString("https://cdn/100.jpg"),
			},
		})
		require.Len(t, got, 1)
		assert.Equal(t, int32(100), got[0].AnilistID)
		require.NotNil(t, got[0].Title)
		assert.Equal(t, "Sequel", *got[0].Title)
		assert.Nil(t, got[0].TitleChinese, "fallback path leaves titleChinese nil")
	})
}

// TestDetail_StaleRefetchFails_ServesStale guards the graceful-degradation
// path added after the prod Internal Server Errors (3.1.5): when the cached
// row is stale AND the AniList re-fetch FAILS (upstream slow / 5xx), the
// handler must return 200 with the stale rows ALREADY read — NOT 500.
//
// The bug it pins: after a failed re-fetch the code fell through to
// enrichRelations(ctx) on a request context whose deadline was exhausted by
// the failed re-fetch, producing "context deadline exceeded" → 500. The fix
// returns the stale rows via the no-DB convertRelationsToDetailRelations and
// caches them. Asserts three things:
//   - 200 with stale data (not 500)
//   - the enrichment query does NOT run on the fallback path
//   - the stale result is cached (a herd doesn't each repeat the re-fetch)
func TestDetail_StaleRefetchFails_ServesStale(t *testing.T) {
	t.Parallel()

	romaji := "Stale But Served"
	relCover := "https://cdn/rel-500.jpg"
	db := &detailFakeDB{
		getAnimeMainByIDFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			// stale cached_at is the only stale trigger here → re-fetch attempted
			return dbgen.GetAnimeMainByIDRow{
				AnilistID:   42,
				TitleRomaji: &romaji,
				CachedAt:    staleTimestamp(),
			}, nil
		},
		getAnimeStudiosByIDFn: func(_ context.Context, _ int32) ([]string, error) {
			return []string{"MAPPA"}, nil
		},
		getAnimeCharactersByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeCharactersByIDRow, error) {
			return []dbgen.GetAnimeCharactersByIDRow{{NameEn: ptrString("Alice"), Role: ptrString("MAIN")}}, nil
		},
		getAnimeRelationsByIDFn: func(_ context.Context, _ int32) ([]dbgen.GetAnimeRelationsByIDRow, error) {
			return []dbgen.GetAnimeRelationsByIDRow{
				{AnilistID: 500, RelationType: ptrString("SEQUEL"), Title: ptrString("Sequel"), CoverImageUrl: &relCover},
			}, nil
		},
		// MUST NOT run on the stale-fallback path. If a regression re-introduced
		// the enrichRelations(ctx) call, this error would 500 the request — which
		// the http.StatusOK assertion below would then catch.
		getRelationEnrichmentByIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetRelationEnrichmentByIDsRow, error) {
			return nil, errors.New("enrichment must not run on the stale-fallback path")
		},
	}
	al := &fakeAniListDetailer{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			// the AniList upstream slowness/outage that caused the incident
			return nil, &anilist.ErrUpstream{Status: http.StatusBadGateway, Message: "AniList upstream error"}
		},
	}
	svc := newDetailServiceWithAniList(t, db, al)

	rec := serveDetail(t, svc, "/api/anime/42")

	require.Equal(t, http.StatusOK, rec.Code, "stale row + failed re-fetch must serve stale, not 500")
	body := rec.Body.String()
	require.Contains(t, body, `"anilistId":42`)
	require.Contains(t, body, `"titleRomaji":"Stale But Served"`)
	require.Contains(t, body, `"anilistId":500`, "relation still served (un-enriched via no-DB converter)")

	assert.Equal(t, int32(1), al.calls.Load(), "re-fetch must have been attempted once")
	assert.Equal(t, int32(0), db.enrichmentCalls.Load(),
		"enrichment must NOT query the deadline-exhausted context on the stale-fallback path")

	// Stale result is cached so a herd of stale requests during an AniList
	// outage doesn't each repeat the (blocking ~5s) re-fetch attempt.
	svc.cache.Wait()
	rec2 := serveDetail(t, svc, "/api/anime/42")
	require.Equal(t, http.StatusOK, rec2.Code)
	assert.Equal(t, int32(1), al.calls.Load(), "stale result cached → second request must not re-fetch")
	assert.Equal(t, int32(1), db.mainCalls.Load(), "second request served from cache, no DB read")
}
