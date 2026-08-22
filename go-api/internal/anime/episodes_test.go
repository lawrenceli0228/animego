package anime

// episodes_test.go — GET /api/anime/episodes.
//
// Same posture as handlers_test.go: a hand-rolled fake for the one Querier
// method the handler touches, testify require/assert, no Postgres.  The fake
// is local to this file rather than another field on handlers_test.go's
// fakeQuerier because Episodes takes the narrow EpisodeCountsDB interface,
// so there is nothing to gain from the full surface.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// fakeEpisodeCountsDB implements EpisodeCountsDB.  gotIDs records what the
// handler actually asked for so the parse/dedupe path can be asserted
// without reaching into unexported helpers.
type fakeEpisodeCountsDB struct {
	rows   []dbgen.GetEpisodeCountsByAnilistIDsRow
	err    error
	gotIDs []int32
	calls  int
}

func (f *fakeEpisodeCountsDB) GetEpisodeCountsByAnilistIDs(_ context.Context, ids []int32) ([]dbgen.GetEpisodeCountsByAnilistIDsRow, error) {
	f.calls++
	f.gotIDs = ids
	if f.err != nil {
		return nil, f.err
	}
	return f.rows, nil
}

func i32(v int32) *int32 { return &v }

// episodesGet issues GET /api/anime/episodes?<query> straight at the
// handler.  The route is a literal segment with no path params, so no chi
// router is needed except in the collision test below.
func episodesGet(db EpisodeCountsDB, query string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	Episodes(db).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/episodes?"+query, nil))
	return rec
}

// episodeCountsEnvelope is the parsed {"data":[...]} response.  Declared
// here rather than reusing episodeCountItem so the test asserts against the
// wire contract instead of against the struct that produces it — a renamed
// json tag would otherwise pass silently.
type episodeCountsEnvelope struct {
	Data []struct {
		AnilistID   int32  `json:"anilistId"`
		Episodes    *int32 `json:"episodes"`
		EpisodesBgm *int32 `json:"episodesBgm"`
	} `json:"data"`
}

func decodeEpisodes(t *testing.T, rec *httptest.ResponseRecorder) episodeCountsEnvelope {
	t.Helper()
	var out episodeCountsEnvelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

// -----------------------------------------------------------------------------
// Happy path.
// -----------------------------------------------------------------------------

func TestEpisodes_ReturnsBothCountsForMultipleIDs(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{
		rows: []dbgen.GetEpisodeCountsByAnilistIDsRow{
			{AnilistID: 1, Episodes: i32(26), EpisodesBgm: i32(26)},
			{AnilistID: 2, Episodes: i32(12), EpisodesBgm: i32(13)},
			{AnilistID: 3, Episodes: i32(51), EpisodesBgm: nil},
		},
	}

	rec := episodesGet(db, "ids=1,2,3")
	require.Equal(t, http.StatusOK, rec.Code)

	assert.Equal(t, []int32{1, 2, 3}, db.gotIDs)

	got := decodeEpisodes(t, rec)
	require.Len(t, got.Data, 3)

	assert.Equal(t, int32(1), got.Data[0].AnilistID)
	require.NotNil(t, got.Data[0].Episodes)
	require.NotNil(t, got.Data[0].EpisodesBgm)
	assert.Equal(t, int32(26), *got.Data[0].Episodes)
	assert.Equal(t, int32(26), *got.Data[0].EpisodesBgm)

	// Row 2 disagrees between the two sources.  Both values survive the
	// round trip unchanged; reconciling them is not the server's job.
	require.NotNil(t, got.Data[1].Episodes)
	require.NotNil(t, got.Data[1].EpisodesBgm)
	assert.Equal(t, int32(12), *got.Data[1].Episodes)
	assert.Equal(t, int32(13), *got.Data[1].EpisodesBgm)

	// Row 3 has no inferred count.  It stays null rather than borrowing
	// the authoritative one.
	require.NotNil(t, got.Data[2].Episodes)
	assert.Equal(t, int32(51), *got.Data[2].Episodes)
	assert.Nil(t, got.Data[2].EpisodesBgm)
}

func TestEpisodes_SingleIDStillReturnsAList(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{
		rows: []dbgen.GetEpisodeCountsByAnilistIDsRow{{AnilistID: 9, Episodes: i32(1)}},
	}

	rec := episodesGet(db, "ids=9")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"data":[`, "data is always an array, never a bare object")
	require.Len(t, decodeEpisodes(t, rec).Data, 1)
}

// -----------------------------------------------------------------------------
// R3 — episodes and episodesBgm must never be merged server-side.
//
// The consumer downstream emits numberOfEpisodes into schema.org JSON-LD and
// only the authoritative AniList value may appear there.  If the server ever
// starts filling a missing `episodes` from `episodes_bgm`, or grows a third
// coalescing field, that boundary is gone and no call site downstream can
// tell an authoritative count from an inferred one.
// -----------------------------------------------------------------------------

func TestEpisodes_NullAuthoritativeCountIsNotBackfilledFromBgm(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{
		rows: []dbgen.GetEpisodeCountsByAnilistIDsRow{
			// Currently airing: AniList has no total, the external source
			// inferred one.  This is the exact row shape the regression is
			// about.
			{AnilistID: 100, Episodes: nil, EpisodesBgm: i32(24)},
		},
	}

	rec := episodesGet(db, "ids=100")
	require.Equal(t, http.StatusOK, rec.Code)

	got := decodeEpisodes(t, rec)
	require.Len(t, got.Data, 1)
	assert.Nil(t, got.Data[0].Episodes, "episodes must stay null; it is the authoritative field and AniList has no value")
	require.NotNil(t, got.Data[0].EpisodesBgm)
	assert.Equal(t, int32(24), *got.Data[0].EpisodesBgm)

	// Explicit on the raw JSON too — a *int32 decoding to nil would also be
	// the result of the key going missing entirely.
	assert.Contains(t, rec.Body.String(), `"episodes":null`)
	assert.Contains(t, rec.Body.String(), `"episodesBgm":24`)
}

func TestEpisodes_RowCarriesExactlyThreeFieldsAndNoCoalescedTotal(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{
		rows: []dbgen.GetEpisodeCountsByAnilistIDsRow{
			{AnilistID: 100, Episodes: nil, EpisodesBgm: i32(24)},
		},
	}

	rec := episodesGet(db, "ids=100")
	require.Equal(t, http.StatusOK, rec.Code)

	var envelope struct {
		Data []map[string]json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	require.Len(t, envelope.Data, 1)

	keys := make([]string, 0, len(envelope.Data[0]))
	for k := range envelope.Data[0] {
		keys = append(keys, k)
	}
	assert.ElementsMatch(t, []string{"anilistId", "episodes", "episodesBgm"}, keys,
		"the row shape is the R3 guard: two separate counts and nothing that merges them")
}

// -----------------------------------------------------------------------------
// Unknown ids.
// -----------------------------------------------------------------------------

func TestEpisodes_UnknownIDIsAbsentNotAnError(t *testing.T) {
	t.Parallel()

	// The caller asks about three; only one is cached.
	db := &fakeEpisodeCountsDB{
		rows: []dbgen.GetEpisodeCountsByAnilistIDsRow{
			{AnilistID: 2, Episodes: i32(12), EpisodesBgm: i32(12)},
		},
	}

	rec := episodesGet(db, "ids=1,2,3")
	require.Equal(t, http.StatusOK, rec.Code, "an uncached id is not a 404 — the request itself was fine")

	got := decodeEpisodes(t, rec)
	require.Len(t, got.Data, 1, "uncached ids are omitted, not padded with null rows")
	assert.Equal(t, int32(2), got.Data[0].AnilistID)
}

func TestEpisodes_NoMatchesReturnsEmptyArrayNotNull(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{rows: nil}

	rec := episodesGet(db, "ids=404404")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":[]}`, rec.Body.String(), "an empty result is [] so the client can iterate without a nil check")
}

// -----------------------------------------------------------------------------
// The ids cap.
// -----------------------------------------------------------------------------

func TestEpisodes_AtCapIsAccepted(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{}
	rec := episodesGet(db, "ids="+joinIDs(1, maxEpisodeIDs))

	require.Equal(t, http.StatusOK, rec.Code, "exactly maxEpisodeIDs must pass; the cap is inclusive")
	assert.Len(t, db.gotIDs, maxEpisodeIDs)
}

func TestEpisodes_OverCapIsRejected(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{}
	rec := episodesGet(db, "ids="+joinIDs(1, maxEpisodeIDs+1))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), `"VALIDATION_ERROR"`)
	assert.Contains(t, rec.Body.String(), "too many ids")
	assert.Equal(t, 0, db.calls, "the cap is checked before the list is parsed, let alone queried")
}

func TestEpisodes_OverCapCountsEntriesNotDistinctIDs(t *testing.T) {
	t.Parallel()

	// All the same id, repeated past the cap.  De-duplication happens after
	// the cap on purpose, so a caller cannot buy a bigger request line by
	// repeating one value.
	db := &fakeEpisodeCountsDB{}
	repeated := strings.TrimSuffix(strings.Repeat("7,", maxEpisodeIDs+1), ",")

	rec := episodesGet(db, "ids="+repeated)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, 0, db.calls)
}

// -----------------------------------------------------------------------------
// Malformed input.
// -----------------------------------------------------------------------------

func TestEpisodes_MalformedIDsAreRejected(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		query string
	}{
		{"missing param", ""},
		{"empty value", "ids="},
		{"whitespace only", "ids=%20"},
		{"non-numeric", "ids=abc"},
		{"one bad entry among good ones", "ids=1,abc,3"},
		{"empty entry", "ids=1,,3"},
		{"trailing comma", "ids=1,2,"},
		{"leading comma", "ids=,1,2"},
		{"float", "ids=1.5"},
		{"hex", "ids=0x10"},
		{"zero", "ids=0"},
		{"negative", "ids=-3"},
		// 2^32 + 1.  strconv.Atoi would accept this on a 64-bit platform and
		// an int32() conversion would wrap it to 1, silently answering with
		// a different anime's episode count.  ParseInt(_, 10, 32) refuses.
		{"above int32", "ids=4294967297"},
		{"int64 max", "ids=9223372036854775807"},
		{"above int64", "ids=99999999999999999999"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			db := &fakeEpisodeCountsDB{}
			rec := episodesGet(db, tc.query)

			require.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Contains(t, rec.Body.String(), `"VALIDATION_ERROR"`)
			assert.Equal(t, 0, db.calls, "a rejected request must not reach the database")
		})
	}
}

func TestEpisodes_RejectionNamesThePositionAndEchoesNothing(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{}
	rec := episodesGet(db, "ids=1,2,%3Cscript%3E,4")

	require.Equal(t, http.StatusBadRequest, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, "ids[2]", "the message points at the offending entry by index")
	assert.NotContains(t, body, "script", "the offending text is never reflected back")
}

func TestEpisodes_SurroundingWhitespaceIsTolerated(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{}
	rec := episodesGet(db, "ids=1,%202%20,3")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, []int32{1, 2, 3}, db.gotIDs)
}

func TestEpisodes_DuplicateIDsAreCollapsedBeforeTheQuery(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{}
	rec := episodesGet(db, "ids=5,5,7,5")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, []int32{5, 7}, db.gotIDs, "ANY() returns one row per row, so duplicates would only shorten the response")
}

// -----------------------------------------------------------------------------
// Cache header.
// -----------------------------------------------------------------------------

func TestEpisodes_SetsPublicCacheHeaderOnSuccess(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{
		rows: []dbgen.GetEpisodeCountsByAnilistIDsRow{{AnilistID: 1, Episodes: i32(26)}},
	}

	rec := episodesGet(db, "ids=1")
	require.Equal(t, http.StatusOK, rec.Code)

	assert.Equal(t, "public, max-age=300, stale-while-revalidate=3600", rec.Header().Get("Cache-Control"))
	assert.Equal(t, episodeCountsCacheControl, rec.Header().Get("Cache-Control"),
		"the literal above is spelled out so a constant edit has to be deliberate")
}

func TestEpisodes_DoesNotCacheRejections(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{}
	rec := episodesGet(db, "ids=abc")

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Empty(t, rec.Header().Get("Cache-Control"),
		"a cached 400 would pin the client's own malformed request in front of it")
}

// -----------------------------------------------------------------------------
// Database failure.
// -----------------------------------------------------------------------------

func TestEpisodes_QueryFailureIs500(t *testing.T) {
	t.Parallel()

	db := &fakeEpisodeCountsDB{err: errors.New("connection reset")}
	rec := episodesGet(db, "ids=1,2")

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
	assert.NotContains(t, rec.Body.String(), "connection reset", "driver detail stays in the logs")
	assert.Empty(t, rec.Header().Get("Cache-Control"))
}

// -----------------------------------------------------------------------------
// Routing.
//
// /api/anime/episodes is a literal segment inside the same chi subtree as
// the /{anilistId} detail wildcard.  chi resolves static segments ahead of
// parametric ones, but that is worth pinning rather than assuming: if it
// ever stopped holding, the symptom would be the detail handler being
// handed anilistId="episodes" and answering 400 or 404 for a request that
// looks perfectly valid from the client side.
// -----------------------------------------------------------------------------

// animeSubtree mirrors main.go's r.Route("/api/anime", ...) closely enough
// to reproduce the shape that matters: several literal segments and a
// trailing {anilistId} wildcard, all in one subtree.
func animeSubtree(db EpisodeCountsDB, detail http.HandlerFunc) http.Handler {
	r := chi.NewRouter()
	r.Route("/api/anime", func(r chi.Router) {
		r.Get("/episodes", Episodes(db))
		r.Get("/{anilistId}/watchers", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		})
		r.Get("/{anilistId}", detail)
	})
	return r
}

func TestEpisodes_RouteDoesNotCollideWithDetail(t *testing.T) {
	t.Parallel()

	var detailHits []string
	detail := func(w http.ResponseWriter, req *http.Request) {
		detailHits = append(detailHits, chi.URLParam(req, "anilistId"))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"handler":"detail"}}`))
	}

	db := &fakeEpisodeCountsDB{
		rows: []dbgen.GetEpisodeCountsByAnilistIDsRow{{AnilistID: 1, Episodes: i32(26)}},
	}
	router := animeSubtree(db, detail)

	// The batch read reaches Episodes, not the detail handler.
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/episodes?ids=1", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, detailHits, "the detail handler must not see a request for /api/anime/episodes")
	assert.Equal(t, 1, db.calls, "Episodes is the handler that ran")
	assert.Equal(t, episodeCountsCacheControl, rec.Header().Get("Cache-Control"),
		"the response came from Episodes, and it came through the router intact")
	require.Len(t, decodeEpisodes(t, rec).Data, 1)

	// And the wildcard still works for a real id.
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/anime/12345", nil))

	require.Equal(t, http.StatusOK, rec2.Code)
	assert.Equal(t, []string{"12345"}, detailHits)
	assert.Equal(t, 1, db.calls, "the detail route must not have reached Episodes")
	assert.Contains(t, rec2.Body.String(), `"detail"`)
}

func TestEpisodes_MissingIDsParamIsStill400ThroughTheRouter(t *testing.T) {
	t.Parallel()

	// Without the ids param the path is still unambiguous — it must be
	// Episodes rejecting the request, not the detail handler picking it up
	// because it looked like a bare segment.
	detail := func(w http.ResponseWriter, _ *http.Request) {
		t.Error("detail handler received /api/anime/episodes")
		w.WriteHeader(http.StatusOK)
	}

	db := &fakeEpisodeCountsDB{}
	rec := httptest.NewRecorder()
	animeSubtree(db, detail).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/episodes", nil))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "ids is required")
}

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

// joinIDs builds "first,first+1,...,first+n-1".
func joinIDs(first, n int) string {
	parts := make([]string, 0, n)
	for i := 0; i < n; i++ {
		parts = append(parts, strconv.Itoa(first+i))
	}
	return strings.Join(parts, ",")
}
