package people

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// fakeDB answers every read from fields; a nil func answers empty.
type fakeDB struct {
	personIdent     dbgen.GetPersonIdentityRow
	personVoices    []dbgen.ListPersonVoiceRolesRow
	personStaff     []dbgen.ListPersonStaffCreditsRow
	characterIdent  dbgen.GetCharacterIdentityRow
	appearances     []dbgen.ListCharacterAppearancesRow
	characterVoices []dbgen.ListCharacterVoicesRow
	overlays        []dbgen.ListEntityOverlaysRow
	personRefs      []dbgen.ListPersonRefsRow
	err             error

	peopleSitemapCalls     int
	lastThresholds         [2]int32
	lastShard              [2]int32
	charactersSitemapCalls int
}

func (f *fakeDB) GetPersonIdentity(context.Context, int32) (dbgen.GetPersonIdentityRow, error) {
	return f.personIdent, f.err
}
func (f *fakeDB) ListPersonVoiceRoles(context.Context, int32) ([]dbgen.ListPersonVoiceRolesRow, error) {
	return f.personVoices, f.err
}
func (f *fakeDB) ListPersonStaffCredits(context.Context, int32) ([]dbgen.ListPersonStaffCreditsRow, error) {
	return f.personStaff, f.err
}
func (f *fakeDB) GetCharacterIdentity(context.Context, int32) (dbgen.GetCharacterIdentityRow, error) {
	return f.characterIdent, f.err
}
func (f *fakeDB) ListCharacterAppearances(context.Context, int32) ([]dbgen.ListCharacterAppearancesRow, error) {
	return f.appearances, f.err
}
func (f *fakeDB) ListCharacterVoices(context.Context, int32) ([]dbgen.ListCharacterVoicesRow, error) {
	return f.characterVoices, f.err
}
func (f *fakeDB) ListEntityOverlays(context.Context, []int32, []int32) ([]dbgen.ListEntityOverlaysRow, error) {
	return f.overlays, f.err
}
func (f *fakeDB) ListPersonRefs(context.Context, []int32) ([]dbgen.ListPersonRefsRow, error) {
	return f.personRefs, f.err
}
func (f *fakeDB) ListPeopleSitemapShard(_ context.Context, minVoice, minStaff, shards, shard int32) ([]dbgen.ListPeopleSitemapShardRow, error) {
	f.peopleSitemapCalls++
	f.lastThresholds = [2]int32{minVoice, minStaff}
	f.lastShard = [2]int32{shards, shard}
	return []dbgen.ListPeopleSitemapShardRow{{
		AnilistID: 133507,
		UpdatedAt: pgtype.Timestamptz{Time: time.Date(2026, 10, 8, 19, 24, 30, 0, time.UTC), Valid: true},
	}}, f.err
}
func (f *fakeDB) ListCharactersSitemapShard(_ context.Context, shards, shard int32) ([]dbgen.ListCharactersSitemapShardRow, error) {
	f.charactersSitemapCalls++
	f.lastShard = [2]int32{shards, shard}
	return nil, f.err
}

func router(db DB) http.Handler {
	r := chi.NewRouter()
	r.Route("/api/people", func(r chi.Router) { MountPeople(r, db, NewSitemapCache(SitemapTTL)) })
	r.Route("/api/characters", func(r chi.Router) { MountCharacters(r, db, NewSitemapCache(SitemapTTL)) })
	return r
}

func get(t *testing.T, h http.Handler, path string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return rec, body
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestPersonHandler_InvalidIDIs400(t *testing.T) {
	t.Parallel()
	h := router(&fakeDB{})
	for _, id := range []string{"abc", "0", "-3", "2147483648", "1.5"} {
		rec, body := get(t, h, "/api/people/"+id)
		assert.Equal(t, http.StatusBadRequest, rec.Code, id)
		assert.Equal(t, "VALIDATION_ERROR", body["error"].(map[string]any)["code"], id)
	}
}

func TestPersonHandler_UncreditedIs404(t *testing.T) {
	t.Parallel()
	// A profile and a Bangumi match, and no credit: no page.
	h := router(&fakeDB{personIdent: dbgen.GetPersonIdentityRow{HasProfile: true, NameCn: sp("某人")}})
	rec, body := get(t, h, "/api/people/42")
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Equal(t, "NOT_FOUND", body["error"].(map[string]any)["code"])
}

func TestPersonHandler_DatabaseErrorIs500(t *testing.T) {
	t.Parallel()
	rec, body := get(t, router(&fakeDB{err: errors.New("boom")}), "/api/people/42")
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "SERVER_ERROR", body["error"].(map[string]any)["code"])
}

// TestPersonHandler_ResponseShape pins the JSON a page decodes, key for key.
func TestPersonHandler_ResponseShape(t *testing.T) {
	t.Parallel()
	db := &fakeDB{
		personIdent:  dbgen.GetPersonIdentityRow{HasProfile: true, NameFull: sp("Chiaki Kobayashi"), NameCn: sp("小林千晃"), BgmID: ip(32265)},
		personVoices: []dbgen.ListPersonVoiceRolesRow{voiceRow(frieren, 184313, 2, "MAIN", "Stark")},
		personStaff:  []dbgen.ListPersonStaffCreditsRow{staffRow(hell, "Theme Song Performance")},
	}
	rec, body := get(t, router(db), "/api/people/133507")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	data := body["data"].(map[string]any)
	assert.Equal(t, []string{
		"anilistId", "bangumiId", "image", "indexable", "name", "profile",
		"representativeRoles", "staffRoles", "staffWorkCount", "voiceRoles", "voiceWorkCount",
	}, keys(data))
	assert.Equal(t, []string{"cn", "full", "native"}, keys(data["name"].(map[string]any)))
	assert.Equal(t, []string{
		"age", "birth", "bloodType", "death", "gender", "homeTown", "language", "occupations", "siteUrl", "yearsActive",
	}, keys(data["profile"].(map[string]any)))

	year := data["voiceRoles"].([]any)[0].(map[string]any)
	assert.Equal(t, []string{"roles", "year"}, keys(year))
	role := year["roles"].([]any)[0].(map[string]any)
	assert.Equal(t, []string{"anime", "character", "language", "role", "roleNotes"}, keys(role))
	assert.Equal(t, []string{"anilistId", "image", "name"}, keys(role["character"].(map[string]any)))
	assert.Equal(t, []string{
		"anilistId", "coverImageUrl", "format", "popularity", "posterAccent",
		"titleChinese", "titleEnglish", "titleHant", "titleHantSeo", "titleNative", "titleRomaji", "year",
	}, keys(role["anime"].(map[string]any)))

	staffYear := data["staffRoles"].([]any)[0].(map[string]any)
	assert.Equal(t, []string{"works", "year"}, keys(staffYear))
	assert.Equal(t, []string{"anime", "roles"}, keys(staffYear["works"].([]any)[0].(map[string]any)))
}

func TestCharacterHandler_StatusesAndShape(t *testing.T) {
	t.Parallel()

	rec, _ := get(t, router(&fakeDB{}), "/api/characters/0")
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec, _ = get(t, router(&fakeDB{characterIdent: dbgen.GetCharacterIdentityRow{HasProfile: true}}), "/api/characters/184313")
	assert.Equal(t, http.StatusNotFound, rec.Code, "a profile alone is not a page")

	db := &fakeDB{
		characterIdent: dbgen.GetCharacterIdentityRow{HasProfile: true, Description: sp("Stark ~!x!~"), NameAlternative: []string{"Alias"},
			BgmSummary: sp("アイゼンの弟子。")},
		appearances:    []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "MAIN")},
		characterVoices: []dbgen.ListCharacterVoicesRow{
			characterVoiceRow(frieren, 133507, 0, "Japanese", nil, "Chiaki Kobayashi"),
		},
	}
	rec, body := get(t, router(db), "/api/characters/184313")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	data := body["data"].(map[string]any)
	assert.Equal(t, []string{
		"alternativeNames", "anilistId", "appearances", "bangumiDescription", "bangumiId", "image", "indexable", "name",
		"profile", "voices",
	}, keys(data))
	assert.Equal(t, "アイゼンの弟子。", data["bangumiDescription"])
	assert.Equal(t, []string{"age", "birth", "bloodType", "description", "gender", "siteUrl"}, keys(data["profile"].(map[string]any)))
	assert.Equal(t, []string{"anime", "role"}, keys(data["appearances"].([]any)[0].(map[string]any)))
	voice := data["voices"].([]any)[0].(map[string]any)
	// key names the row for an edit; line is the line an accepted edit wrote.
	assert.Equal(t, []string{"key", "language", "line", "person", "roleNotes"}, keys(voice))
	assert.Equal(t, "133507|Japanese|", voice["key"])
	assert.Nil(t, voice["line"])
	assert.Equal(t, []string{"anilistId", "image", "name"}, keys(voice["person"].(map[string]any)))
}

// TestCharacterHandler_BangumiDescription: Bangumi's summary rides beside
// AniList's description, with or without an AniList profile, and an accepted
// edit to the description -- a new text or a cleared one -- supersedes both,
// so every language shows the edited one.
func TestCharacterHandler_BangumiDescription(t *testing.T) {
	t.Parallel()
	page := func(ident dbgen.GetCharacterIdentityRow, overlay string) map[string]any {
		t.Helper()
		db := &fakeDB{
			characterIdent: ident,
			appearances:    []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "MAIN")},
		}
		if overlay != "" {
			db.overlays = []dbgen.ListEntityOverlaysRow{{Kind: "character", EntityID: 184313, Data: []byte(overlay)}}
		}
		rec, body := get(t, router(db), "/api/characters/184313")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		return body["data"].(map[string]any)
	}
	withProfile := dbgen.GetCharacterIdentityRow{HasProfile: true, Description: sp("AniList's text"), BgmSummary: sp("Bangumi 的简介")}

	data := page(withProfile, "")
	assert.Equal(t, "Bangumi 的简介", data["bangumiDescription"])
	assert.Equal(t, "AniList's text", data["profile"].(map[string]any)["description"])

	data = page(dbgen.GetCharacterIdentityRow{BgmSummary: sp("Bangumi 的简介")}, "")
	assert.Equal(t, "Bangumi 的简介", data["bangumiDescription"], "no AniList profile yet: Bangumi's still shows")
	assert.Nil(t, data["profile"])

	data = page(withProfile, `{"description":"读者改过的简介"}`)
	assert.Nil(t, data["bangumiDescription"])
	assert.Equal(t, "读者改过的简介", data["profile"].(map[string]any)["description"])

	data = page(withProfile, `{"description":null}`)
	assert.Nil(t, data["bangumiDescription"], "a cleared description is cleared everywhere")
	assert.Nil(t, data["profile"].(map[string]any)["description"])

	data = page(dbgen.GetCharacterIdentityRow{HasProfile: true, BgmSummary: sp("  ")}, "")
	assert.Nil(t, data["bangumiDescription"], "blank is none")
}

// TestCharacterHandler_AppliesItsOverlay: the handler reads the character's
// accepted edits and answers with them on top.
func TestCharacterHandler_AppliesItsOverlay(t *testing.T) {
	t.Parallel()
	db := &fakeDB{
		characterIdent: dbgen.GetCharacterIdentityRow{NameCn: sp("修塔尔克")},
		appearances:    []dbgen.ListCharacterAppearancesRow{appearanceRow(frieren, "MAIN")},
		overlays: []dbgen.ListEntityOverlaysRow{
			{Kind: "character", EntityID: 184313, Data: []byte(`{"nameCn":"史塔克","roles":{"154587":"SUPPORTING"}}`)},
		},
	}
	rec, body := get(t, router(db), "/api/characters/184313")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	data := body["data"].(map[string]any)
	assert.Equal(t, "史塔克", data["name"].(map[string]any)["cn"])
	assert.Equal(t, "SUPPORTING", data["appearances"].([]any)[0].(map[string]any)["role"])
	assert.Equal(t, false, data["indexable"], "no longer a lead anywhere")
}

// TestRoutes_SitemapIsNotAnID: the literal segment shares the subtree with
// the {id} pattern, and must reach its own handler.
func TestRoutes_SitemapIsNotAnID(t *testing.T) {
	t.Parallel()
	db := &fakeDB{}
	h := router(db)

	rec, body := get(t, h, "/api/people/sitemap?shards=4&shard=3")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, 1, db.peopleSitemapCalls)
	assert.Equal(t, [2]int32{4, 3}, db.lastShard)
	assert.Equal(t, [2]int32{MinIndexedVoiceWorks, MinIndexedStaffWorks}, db.lastThresholds,
		"the listing applies the page's own threshold")
	rows := body["data"].([]any)
	require.Len(t, rows, 1)
	assert.Equal(t, map[string]any{"anilistId": float64(133507), "updatedAt": "2026-10-08T19:24:30Z"}, rows[0])

	rec, _ = get(t, h, "/api/characters/sitemap")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, db.charactersSitemapCalls)
	assert.Equal(t, [2]int32{1, 0}, db.lastShard, "no parameters: one shard holding everything")
}

func TestSitemap_RejectsRatherThanClamps(t *testing.T) {
	t.Parallel()
	h := router(&fakeDB{})
	for _, q := range []string{"shards=0", "shards=65", "shards=4&shard=4", "shards=4&shard=-1", "shards=x"} {
		rec, _ := get(t, h, "/api/people/sitemap?"+q)
		assert.Equal(t, http.StatusBadRequest, rec.Code, q)
	}
}

func TestSitemap_CachedForTheTTL(t *testing.T) {
	t.Parallel()
	db := &fakeDB{}
	cache := NewSitemapCache(time.Hour)
	now := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
	cache.now = func() time.Time { return now }
	h := PeopleSitemap(db, cache)

	serve := func(q string) int {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/people/sitemap?"+q, nil))
		return rec.Code
	}
	require.Equal(t, http.StatusOK, serve("shards=2&shard=0"))
	require.Equal(t, http.StatusOK, serve("shards=2&shard=0"))
	assert.Equal(t, 1, db.peopleSitemapCalls, "the second read is the cached one")

	require.Equal(t, http.StatusOK, serve("shards=2&shard=1"))
	assert.Equal(t, 2, db.peopleSitemapCalls, "another shard is another entry")

	now = now.Add(time.Hour)
	require.Equal(t, http.StatusOK, serve("shards=2&shard=0"))
	assert.Equal(t, 3, db.peopleSitemapCalls, "an expired entry is read again")
}

func TestSitemap_ErrorsAreNotCached(t *testing.T) {
	t.Parallel()
	db := &fakeDB{err: errors.New("boom")}
	h := PeopleSitemap(db, NewSitemapCache(time.Hour))
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/people/sitemap", nil))
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	}
	assert.Equal(t, 2, db.peopleSitemapCalls)
}
