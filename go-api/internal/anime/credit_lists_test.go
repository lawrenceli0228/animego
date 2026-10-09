package anime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// fakeCreditListsDB is the four reads the credit-list endpoints make,
// with a call counter per query so a test can tell a cache hit from a
// load.
type fakeCreditListsDB struct {
	mu sync.Mutex

	missing bool    // GetAnimeCreditsHead and GetAnimeCreditCounts answer pgx.ErrNoRows
	country *string // the title's country_of_origin
	// unfetched is a title a listing wrote and no detail fetch has filled:
	// detail_fetched_at NULL, its credit tables empty because nobody asked.
	unfetched bool
	// gate, when set, holds ListAnimeCastCharacters until it is closed.
	gate   chan struct{}
	chars  []dbgen.ListAnimeCastCharactersRow
	voices []dbgen.ListAnimeCastVoicesRow
	staff  []dbgen.ListAnimeStaffCreditsRow
	counts dbgen.GetAnimeCreditCountsRow

	headErr, charsErr, voicesErr, staffErr, countsErr error

	calls map[string]int
}

func (f *fakeCreditListsDB) count(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[name]++
}

func (f *fakeCreditListsDB) called(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[name]
}

func (f *fakeCreditListsDB) GetAnimeCreditsHead(_ context.Context, _ int32) (dbgen.GetAnimeCreditsHeadRow, error) {
	f.count("head")
	if f.headErr != nil {
		return dbgen.GetAnimeCreditsHeadRow{}, f.headErr
	}
	if f.missing {
		return dbgen.GetAnimeCreditsHeadRow{}, pgx.ErrNoRows
	}
	return dbgen.GetAnimeCreditsHeadRow{CountryOfOrigin: f.country, DetailFetched: !f.unfetched}, nil
}

func (f *fakeCreditListsDB) GetAnimeCreditCounts(_ context.Context, _ int32) (dbgen.GetAnimeCreditCountsRow, error) {
	f.count("counts")
	if f.countsErr != nil {
		return dbgen.GetAnimeCreditCountsRow{}, f.countsErr
	}
	if f.missing {
		return dbgen.GetAnimeCreditCountsRow{}, pgx.ErrNoRows
	}
	row := f.counts
	row.DetailFetched = !f.unfetched
	return row, nil
}

func (f *fakeCreditListsDB) ListAnimeCastCharacters(_ context.Context, _ int32) ([]dbgen.ListAnimeCastCharactersRow, error) {
	f.count("chars")
	if f.gate != nil {
		<-f.gate
	}
	return f.chars, f.charsErr
}

func (f *fakeCreditListsDB) ListAnimeCastVoices(_ context.Context, _ int32) ([]dbgen.ListAnimeCastVoicesRow, error) {
	f.count("voices")
	return f.voices, f.voicesErr
}

func (f *fakeCreditListsDB) ListAnimeStaffCredits(_ context.Context, _ int32) ([]dbgen.ListAnimeStaffCreditsRow, error) {
	f.count("staff")
	return f.staff, f.staffErr
}

// fixtureCreditsDB holds the fixtureCast title plus three staff credits
// for two people.
func fixtureCreditsDB() *fakeCreditListsDB {
	list := []dbgen.ListAnimeCastCharactersRow{
		castChar(1, "MAIN", "Frieren", "フリーレン"),
		castChar(2, "MAIN", "Fern", "フェルン"),
		castChar(3, "SUPPORTING", "Himmel", "ヒンメル"),
		castChar(4, "BACKGROUND", "Villager", "村人"),
	}
	list[0].NameCn = sptr("芙莉莲")
	list[0].ImageUrl = sptr("https://s4.anilist.co/file/anilistcdn/character/large/1.png")
	return &fakeCreditListsDB{
		country: sptr("JP"),
		counts:  dbgen.GetAnimeCreditCountsRow{Characters: 4, Staff: 2},
		chars:   list,
		voices: []dbgen.ListAnimeCastVoicesRow{
			castVoiceRow(1, 11, "Japanese", "", "Atsumi Tanezaki", "種崎敦美"),
			castVoiceRow(1, 12, "Chinese", "", "Zhong Pei", "中配一"),
			castVoiceRow(3, 31, "Japanese", "", "Nobuhiko Okamoto", "岡本信彦"),
			castVoiceRow(3, 32, "Japanese", "Childhood", "Child Himmel", "子供ヒンメル"),
		},
		staff: []dbgen.ListAnimeStaffCreditsRow{
			{StaffID: i32(101), Role: sptr("Director"), NameEn: sptr("Keiichirou Saitou"), NameJa: sptr("斎藤圭一郎")},
			{StaffID: i32(102), Role: sptr("Music"), NameEn: sptr("Evan Call"), NameJa: sptr("Evan Call"), NameCn: sptr("埃文·考尔")},
			{StaffID: i32(101), Role: sptr("Storyboard (eps 1, 2)"), NameEn: sptr("Keiichirou Saitou"), NameJa: sptr("斎藤圭一郎")},
		},
	}
}

func newCreditListsService(t *testing.T, db CreditListsDB) *CreditListsService {
	t.Helper()
	svc, err := NewCreditListsService(db)
	require.NoError(t, err)
	t.Cleanup(svc.Close)
	return svc
}

// creditListsRouter mounts the three endpoints the way main.go does, next
// to a detail handler that fails the test if it is ever reached.
func creditListsRouter(t *testing.T, svc *CreditListsService) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	r.Route("/api/anime", func(r chi.Router) {
		r.Get("/{anilistId}/characters", svc.Characters())
		r.Get("/{anilistId}/staff", svc.Staff())
		r.Get("/{anilistId}/credit-counts", svc.Counts())
		r.Get("/{anilistId}", func(w http.ResponseWriter, req *http.Request) {
			t.Errorf("the detail handler received %s", req.URL.Path)
			w.WriteHeader(http.StatusTeapot)
		})
	})
	return r
}

func getCredits(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func decodeCharacters(t *testing.T, rec *httptest.ResponseRecorder) charactersResponse {
	t.Helper()
	var body charactersResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body
}

func TestCharacters_EnvelopeShape(t *testing.T) {
	t.Parallel()

	h := creditListsRouter(t, newCreditListsService(t, fixtureCreditsDB()))
	rec := getCredits(t, h, "/api/anime/154587/characters?limit=1")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "application/json; charset=utf-8", rec.Header().Get("Content-Type"))

	// The whole body, byte for byte: the key order, the nulls, and the
	// voices in the response's language only.
	assert.JSONEq(t, `{
		"data": [{
			"characterId": 1,
			"role": "MAIN",
			"nameEn": "Frieren",
			"nameJa": "フリーレン",
			"nameCn": "芙莉莲",
			"imageUrl": "https://s4.anilist.co/file/anilistcdn/character/large/1.png",
			"voices": [{
				"staffId": 11,
				"nameFull": "Atsumi Tanezaki",
				"nameNative": "種崎敦美",
				"nameCn": null,
				"imageUrl": null,
				"roleNotes": null,
				"dubGroup": null
			}]
		}],
		"total": 4,
		"offset": 0,
		"limit": 1,
		"hasMore": true,
		"language": "ja",
		"counts": {
			"roles": {"all": 4, "main": 2, "supporting": 1, "background": 1},
			"languages": [{"language": "ja", "count": 2}, {"language": "zh", "count": 1}]
		}
	}`, rec.Body.String())
	assert.True(t, strings.HasPrefix(rec.Body.String(), `{"data":[{"characterId":1,`),
		"data first, the character's id first: the order the structs declare")
	assert.True(t, strings.HasSuffix(rec.Body.String(), `"count":1}]}}`), "no trailing newline")
}

func TestCharacters_Defaults(t *testing.T) {
	t.Parallel()

	h := creditListsRouter(t, newCreditListsService(t, fixtureCreditsDB()))
	body := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters"))
	assert.Equal(t, castDefaultLimit, body.Limit)
	assert.Equal(t, 0, body.Offset)
	assert.Equal(t, "ja", body.Language, "a Japanese title answers in Japanese")
	assert.Len(t, body.Data, 4)
	assert.False(t, body.HasMore)
}

func TestCharacters_FiltersReachTheList(t *testing.T) {
	t.Parallel()

	h := creditListsRouter(t, newCreditListsService(t, fixtureCreditsDB()))

	main := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?role=MAIN"))
	assert.Equal(t, 2, main.Total)
	assert.Equal(t, "main", strings.ToLower(*main.Data[1].Role))

	lower := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?role=supporting"))
	assert.Equal(t, 1, lower.Total, "the role is read in any case")

	all := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?role=all"))
	assert.Equal(t, 4, all.Total)

	zh := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?lang=ZH"))
	assert.Equal(t, "zh", zh.Language)
	require.Len(t, zh.Data[0].Voices, 1)
	assert.Equal(t, int32(12), *zh.Data[0].Voices[0].StaffID)

	found := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?q=%E5%B2%A1%E6%9C%AC")) // 岡本
	assert.Equal(t, 1, found.Total)
	assert.Equal(t, "Himmel", *found.Data[0].NameEn)
	assert.Equal(t, castRoleCounts{All: 1, Supporting: 1}, found.Counts.Roles)
	require.Len(t, found.Data[0].Voices, 2, "his childhood voice comes with him")

	paged := decodeCharacters(t, getCredits(t, h, "/api/anime/154587/characters?offset=2&limit=1"))
	assert.Equal(t, 2, paged.Offset)
	assert.Equal(t, "Himmel", *paged.Data[0].NameEn)
	assert.True(t, paged.HasMore)
}

func TestCharacters_LimitAndOffsetAreClamped(t *testing.T) {
	t.Parallel()

	h := creditListsRouter(t, newCreditListsService(t, fixtureCreditsDB()))
	cases := []struct {
		query       string
		wantLimit   int
		wantOffset  int
		wantEntries int
	}{
		{"limit=500", castMaxLimit, 0, 4},
		{"limit=0", castDefaultLimit, 0, 4},
		{"limit=abc", castDefaultLimit, 0, 4},
		{"offset=-3", castDefaultLimit, 0, 4},
		{"offset=abc", castDefaultLimit, 0, 4},
		{"offset=99999999999999999999", castDefaultLimit, 0, 4},
		{"offset=10", castDefaultLimit, 10, 0},
	}
	for _, tc := range cases {
		t.Run(tc.query, func(t *testing.T) {
			rec := getCredits(t, h, "/api/anime/154587/characters?"+tc.query)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			body := decodeCharacters(t, rec)
			assert.Equal(t, tc.wantLimit, body.Limit)
			assert.Equal(t, tc.wantOffset, body.Offset)
			assert.Len(t, body.Data, tc.wantEntries)
			assert.NotNil(t, body.Data)
		})
	}
}

func TestCharacters_BadParametersAre400(t *testing.T) {
	t.Parallel()

	db := fixtureCreditsDB()
	h := creditListsRouter(t, newCreditListsService(t, db))
	cases := map[string]string{
		"role":       "/api/anime/154587/characters?role=LEAD",
		"lang":       "/api/anime/154587/characters?lang=en",
		"long query": "/api/anime/154587/characters?q=" + strings.Repeat("长", castMaxQueryRunes+1),
	}
	for name, target := range cases {
		t.Run(name, func(t *testing.T) {
			rec := getCredits(t, h, target)
			require.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Contains(t, rec.Body.String(), `"code":"VALIDATION_ERROR"`)
			assert.Empty(t, rec.Header().Get("Cache-Control"), "a rejection is not cached")
		})
	}
	assert.Zero(t, db.called("head"), "a malformed request never reaches the database")

	ok := getCredits(t, h, "/api/anime/154587/characters?q="+strings.Repeat("长", castMaxQueryRunes))
	assert.Equal(t, http.StatusOK, ok.Code, "the limit itself is allowed")
}

func TestCreditLists_BadIDsAre400(t *testing.T) {
	t.Parallel()

	db := fixtureCreditsDB()
	h := creditListsRouter(t, newCreditListsService(t, db))
	for _, path := range []string{"characters", "staff", "credit-counts"} {
		for _, id := range []string{"abc", "0", "-7", "2147483648", "1e3"} {
			rec := getCredits(t, h, "/api/anime/"+id+"/"+path)
			assert.Equal(t, http.StatusBadRequest, rec.Code, "%s %s", path, id)
			assert.Contains(t, rec.Body.String(), "无效的番剧 ID")
		}
	}
	assert.Zero(t, db.called("head"))
}

func TestCreditLists_UnknownTitleIs404AndNothingElseIsRead(t *testing.T) {
	t.Parallel()

	db := &fakeCreditListsDB{missing: true}
	h := creditListsRouter(t, newCreditListsService(t, db))
	for _, path := range []string{"characters", "staff", "credit-counts"} {
		rec := getCredits(t, h, "/api/anime/990100999/"+path)
		require.Equal(t, http.StatusNotFound, rec.Code, path)
		assert.JSONEq(t, `{"error":{"code":"NOT_FOUND","message":"番剧不存在"}}`, rec.Body.String())
		assert.Empty(t, rec.Header().Get("Cache-Control"), "a 404 is not cached by the browser")
	}
	assert.Zero(t, db.called("chars"))
	assert.Zero(t, db.called("voices"))
	assert.Zero(t, db.called("staff"))
	assert.Equal(t, 1, db.called("counts"), "the counts are their own one query")
}

func TestCreditLists_DatabaseErrorsAre500(t *testing.T) {
	t.Parallel()

	boom := errors.New("connection reset")
	cases := map[string]struct {
		mutate func(*fakeCreditListsDB)
		path   string
	}{
		"head":   {func(f *fakeCreditListsDB) { f.headErr = boom }, "characters"},
		"chars":  {func(f *fakeCreditListsDB) { f.charsErr = boom }, "characters"},
		"voices": {func(f *fakeCreditListsDB) { f.voicesErr = boom }, "characters"},
		"staff":  {func(f *fakeCreditListsDB) { f.staffErr = boom }, "staff"},
		"counts": {func(f *fakeCreditListsDB) { f.countsErr = boom }, "credit-counts"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			db := fixtureCreditsDB()
			tc.mutate(db)
			h := creditListsRouter(t, newCreditListsService(t, db))
			rec := getCredits(t, h, "/api/anime/154587/"+tc.path)
			require.Equal(t, http.StatusInternalServerError, rec.Code)
			assert.Contains(t, rec.Body.String(), `"code":"SERVER_ERROR"`)
			assert.NotContains(t, rec.Body.String(), "connection reset", "the cause stays in the log")
		})
	}
}

func TestCreditLists_SuccessCarriesThePublicCachePolicy(t *testing.T) {
	t.Parallel()

	h := creditListsRouter(t, newCreditListsService(t, fixtureCreditsDB()))
	for _, path := range []string{"characters", "staff", "credit-counts"} {
		rec := getCredits(t, h, "/api/anime/154587/"+path)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, episodeCountsCacheControl, rec.Header().Get("Cache-Control"), path)
	}
}

func TestCharacters_ATitleIsReadOnceAndServedFromMemory(t *testing.T) {
	t.Parallel()

	db := fixtureCreditsDB()
	svc := newCreditListsService(t, db)
	h := creditListsRouter(t, svc)

	require.Equal(t, http.StatusOK, getCredits(t, h, "/api/anime/154587/characters").Code)
	svc.cast.Wait()
	// Different filters, same title: what a reader typing into the search
	// box sends.  None of them touches the tables again.
	for _, q := range []string{"?q=fern", "?role=main", "?lang=zh", "?offset=2&limit=1"} {
		require.Equal(t, http.StatusOK, getCredits(t, h, "/api/anime/154587/characters"+q).Code)
	}
	assert.Equal(t, 1, db.called("head"))
	assert.Equal(t, 1, db.called("chars"))
	assert.Equal(t, 1, db.called("voices"))
	assert.Zero(t, db.called("staff"), "the cast never loads the staff")
}

func TestCharacters_AFailedLoadIsNotRemembered(t *testing.T) {
	t.Parallel()

	db := fixtureCreditsDB()
	db.voicesErr = errors.New("timeout")
	svc := newCreditListsService(t, db)
	h := creditListsRouter(t, svc)

	require.Equal(t, http.StatusInternalServerError, getCredits(t, h, "/api/anime/154587/characters").Code)
	svc.cast.Wait()
	db.mu.Lock()
	db.voicesErr = nil
	db.mu.Unlock()
	require.Equal(t, http.StatusOK, getCredits(t, h, "/api/anime/154587/characters").Code)
	assert.Equal(t, 2, db.called("voices"))
}

func TestStaff_EnvelopeShape(t *testing.T) {
	t.Parallel()

	h := creditListsRouter(t, newCreditListsService(t, fixtureCreditsDB()))
	rec := getCredits(t, h, "/api/anime/154587/staff")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.JSONEq(t, `{
		"data": [
			{"staffId": 101, "role": "Director", "nameEn": "Keiichirou Saitou", "nameJa": "斎藤圭一郎", "nameCn": null, "imageUrl": null},
			{"staffId": 102, "role": "Music", "nameEn": "Evan Call", "nameJa": "Evan Call", "nameCn": "埃文·考尔", "imageUrl": null},
			{"staffId": 101, "role": "Storyboard (eps 1, 2)", "nameEn": "Keiichirou Saitou", "nameJa": "斎藤圭一郎", "nameCn": null, "imageUrl": null}
		],
		"total": 3,
		"people": 2
	}`, rec.Body.String())
	assert.True(t, strings.HasPrefix(rec.Body.String(), `{"data":[{"staffId":101,"role":"Director",`))
}

func TestStaff_ATitleWithNoStaffIsAnEmptyList(t *testing.T) {
	t.Parallel()

	db := fixtureCreditsDB()
	db.staff = nil
	h := creditListsRouter(t, newCreditListsService(t, db))
	rec := getCredits(t, h, "/api/anime/154587/staff")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"data":[],"total":0,"people":0}`, rec.Body.String())
}

func TestCreditCounts_TwoNumbersFromOneQuery(t *testing.T) {
	t.Parallel()

	// Every overview render asks for these, so they must not load the lists:
	// a crawl through the catalogue would otherwise read every title's whole
	// cast and staff and churn the list caches for numbers.
	db := fixtureCreditsDB()
	h := creditListsRouter(t, newCreditListsService(t, db))
	rec := getCredits(t, h, "/api/anime/154587/credit-counts")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, `{"data":{"characters":4,"staff":2}}`, rec.Body.String())
	assert.Equal(t, 1, db.called("counts"))
	assert.Zero(t, db.called("head"))
	assert.Zero(t, db.called("chars"))
	assert.Zero(t, db.called("voices"))
	assert.Zero(t, db.called("staff"))
}

func TestCreditCounts_ATitleWithNoCreditsCountsZero(t *testing.T) {
	t.Parallel()

	h := creditListsRouter(t, newCreditListsService(t, &fakeCreditListsDB{}))
	rec := getCredits(t, h, "/api/anime/1/credit-counts")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":{"characters":0,"staff":0}}`, rec.Body.String())
}

func TestCreditLists_RoutesDoNotCollideWithDetail(t *testing.T) {
	t.Parallel()

	// creditListsRouter's detail handler fails the test if it runs.  The
	// three sub-resources are two-segment routes beside the one-segment
	// wildcard, which chi resolves structurally.
	h := creditListsRouter(t, newCreditListsService(t, fixtureCreditsDB()))
	for _, path := range []string{"characters", "staff", "credit-counts"} {
		assert.Equal(t, http.StatusOK, getCredits(t, h, "/api/anime/154587/"+path).Code, path)
	}
}

func TestCreditLists_AListingOnlyTitleIsNeitherCachedNorCacheable(t *testing.T) {
	t.Parallel()

	// A title seasonal / search / warm_season wrote and nobody has opened:
	// its credit tables are empty because no detail fetch has filled them
	// yet, and the next /api/anime/:id will.  Remembering that emptiness for
	// ten minutes would show an empty tab long after the fetch landed.
	db := fixtureCreditsDB()
	db.unfetched = true
	svc := newCreditListsService(t, db)
	h := creditListsRouter(t, svc)

	for _, path := range []string{"characters", "staff", "credit-counts"} {
		rec := getCredits(t, h, "/api/anime/154587/"+path)
		require.Equal(t, http.StatusOK, rec.Code, path)
		assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"), path)
	}
	svc.cast.Wait()
	svc.staff.Wait()
	require.Equal(t, http.StatusOK, getCredits(t, h, "/api/anime/154587/characters").Code)
	require.Equal(t, http.StatusOK, getCredits(t, h, "/api/anime/154587/staff").Code)
	assert.Equal(t, 2, db.called("chars"), "read again: nothing was kept")
	assert.Equal(t, 2, db.called("staff"))
}

func TestCreditLists_AnEmptyListIsKeptOnlyBriefly(t *testing.T) {
	t.Parallel()

	// Fetched, and empty: AniList lists nobody, or the refresh that stamped
	// the row has not written its credits yet -- the main row goes first.
	// Either way the answer is worth a short look, not ten minutes.
	db := fixtureCreditsDB()
	db.chars, db.voices, db.staff = nil, nil, nil
	svc := newCreditListsService(t, db)
	svc.emptyTTL = 50 * time.Millisecond
	h := creditListsRouter(t, svc)

	rec := getCredits(t, h, "/api/anime/154587/characters")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, creditListsCacheControl, rec.Header().Get("Cache-Control"))
	svc.cast.Wait()
	require.Equal(t, http.StatusOK, getCredits(t, h, "/api/anime/154587/characters").Code)
	assert.Equal(t, 1, db.called("chars"), "kept for its short while")

	time.Sleep(120 * time.Millisecond)
	require.Equal(t, http.StatusOK, getCredits(t, h, "/api/anime/154587/characters").Code)
	assert.Equal(t, 2, db.called("chars"), "and read again after it")
}

func TestCharacters_ConcurrentColdRequestsShareOneRead(t *testing.T) {
	t.Parallel()

	db := fixtureCreditsDB()
	db.gate = make(chan struct{})
	h := creditListsRouter(t, newCreditListsService(t, db))

	const callers = 8
	codes := make(chan int, callers)
	for i := 0; i < callers; i++ {
		go func() {
			codes <- getCredits(t, h, "/api/anime/154587/characters").Code
		}()
	}
	// Let every caller reach the shared load before the first read returns.
	require.Eventually(t, func() bool { return db.called("chars") == 1 }, time.Second, 5*time.Millisecond)
	time.Sleep(100 * time.Millisecond)
	close(db.gate)

	for i := 0; i < callers; i++ {
		assert.Equal(t, http.StatusOK, <-codes)
	}
	assert.Equal(t, 1, db.called("head"))
	assert.Equal(t, 1, db.called("chars"))
	assert.Equal(t, 1, db.called("voices"))
}
