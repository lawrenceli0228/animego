package edits

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/notifications"
	"github.com/lawrenceli0228/animego/go-api/internal/people"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// The fixture: Frieren and its sequel; Stark leads both, voiced by 133507
// (and 115100 as a child); 95185 is credited elsewhere and can be given a
// voice row.  The ids are AniList's, the rows written the way the credit
// writers write them.
const flowFixture = `
INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese, start_date, season_year, popularity, is_adult, format) VALUES
  (154587, 'Sousou no Frieren', '葬送的芙莉莲', '2023-09-29', 2023, 480000, false, 'TV'),
  (182255, 'Sousou no Frieren 2', '葬送的芙莉莲 第二季', '2026-01-16', 2026, 150000, false, 'TV'),
  (166613, 'Jigokuraku', '地狱乐', '2023-04-01', 2023, 300000, false, 'TV');
INSERT INTO anime_characters (anime_id, display_order, name_en, name_ja, image_url, role, voice_actor_en, voice_actor_ja, character_id, voice_actor_id) VALUES
  (154587, 2, 'Stark', 'シュタルク', 'https://s4.anilist.co/file/anilistcdn/character/medium/b184313.jpg', 'MAIN', 'Chiaki Kobayashi', '小林千晃', 184313, 133507),
  (182255, 2, 'Stark', 'シュタルク', NULL, 'MAIN', 'Chiaki Kobayashi', '小林千晃', 184313, 133507),
  (166613, 0, 'Gabimaru', '画眉丸', NULL, 'MAIN', 'Chiaki Kobayashi', '小林千晃', 200000, 133507),
  (166613, 1, 'Sagiri', '佐切', NULL, 'MAIN', 'Other Voice', '他', 200001, 95185);
INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, language, role_notes, name_full, name_native) VALUES
  (154587, 184313, 133507, 0, 'Japanese', NULL, 'Chiaki Kobayashi', '小林千晃'),
  (154587, 184313, 115100, 1, 'Japanese', 'Childhood', 'Child Voice', '子役'),
  (182255, 184313, 133507, 0, 'Japanese', NULL, 'Chiaki Kobayashi', '小林千晃'),
  (166613, 200000, 133507, 0, 'Japanese', NULL, 'Chiaki Kobayashi', '小林千晃'),
  (166613, 200001, 95185, 0, 'Japanese', NULL, 'Other Voice', '他');
INSERT INTO characters (anilist_id, name_full, name_native, image_large, description, gender, fetched_at, checked_at) VALUES
  (184313, 'Stark', 'シュタルク', 'https://s4.anilist.co/file/anilistcdn/character/large/b184313.jpg', 'A warrior.', 'Male', now(), now());
INSERT INTO people (anilist_id, name_full, name_native, primary_occupations, home_town, fetched_at, checked_at) VALUES
  (133507, 'Chiaki Kobayashi', '小林千晃', '{"Voice Actor"}', 'Kanagawa, Japan', now(), now());
INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (184313, 89182, '修塔尔克', 'dump', now());
INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at) VALUES (133507, 7575, '小林千晃', 'dump', now());
`

type flow struct {
	t       *testing.T
	pool    *pgxpool.Pool
	router  http.Handler
	signer  *jwtx.Signer
	images  *ImageStore
	root    string
	fetcher *stubFetcher

	mu        sync.Mutex
	forgotten []int32
}

type account struct {
	id    uuid.UUID
	token string
}

func newFlow(t *testing.T) *flow {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	_, err := pool.Exec(ctx, flowFixture)
	require.NoError(t, err)

	signer, err := jwtx.NewSigner("edits-access-secret-0123456789", "edits-refresh-secret-0123456789", time.Hour, time.Hour)
	require.NoError(t, err)
	f := &flow{t: t, pool: pool, signer: signer, root: t.TempDir(), fetcher: &stubFetcher{}}
	f.images = NewImageStore(f.root, "https://example.org", f.fetcher)
	f.router = f.process()
	return f
}

// process is the API as one server process would run it: its own handlers
// (and so its own record of who has a submission in flight) over the shared
// database and image directory.
func (f *flow) process() http.Handler {
	h := NewHandlers(f.pool, f.images, func(ids ...int32) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.forgotten = append(f.forgotten, ids...)
	})
	q := dbgen.New(f.pool)
	r := chi.NewRouter()
	h.Mount(r, jwtx.RequireAuth(f.signer))
	r.Route("/api/admin", func(r chi.Router) {
		r.Use(jwtx.RequireAuth(f.signer))
		r.Use(jwtx.RequireAdmin())
		h.MountAdmin(r)
	})
	r.With(jwtx.RequireAuth(f.signer)).Get("/api/notifications", notifications.NewHandlers(q).List)
	cache := people.NewSitemapCache(people.SitemapTTL)
	r.Route("/api/characters", func(r chi.Router) { people.MountCharacters(r, q, cache) })
	r.Route("/api/people", func(r chi.Router) { people.MountPeople(r, q, cache) })
	return r
}

func (f *flow) user(name string, admin bool) account {
	f.t.Helper()
	var role *string
	if admin {
		r := "admin"
		role = &r
	}
	var id uuid.UUID
	require.NoError(f.t, f.pool.QueryRow(context.Background(),
		`INSERT INTO users (username, email, password, role) VALUES ($1, $1 || '@example.test', 'x', $2) RETURNING id`,
		name, role).Scan(&id))
	token, err := f.signer.SignAccess(id, name, role)
	require.NoError(f.t, err)
	return account{id: id, token: token}
}

func (f *flow) do(method, path string, who *account, body any) (int, map[string]any) {
	f.t.Helper()
	return f.doOn(f.router, method, path, who, body)
}

func (f *flow) doOn(router http.Handler, method, path string, who *account, body any) (int, map[string]any) {
	f.t.Helper()
	if body == nil {
		return f.send(router, method, path, who, "", nil)
	}
	raw, ok := body.(string)
	if !ok {
		b, err := json.Marshal(body)
		require.NoError(f.t, err)
		raw = string(b)
	}
	return f.send(router, method, path, who, "application/json", []byte(raw))
}

// send is a request with the body and Content-Type given as they are.
func (f *flow) send(router http.Handler, method, path string, who *account, contentType string, body []byte) (int, map[string]any) {
	f.t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if who != nil {
		req.Header.Set("Authorization", "Bearer "+who.token)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func errMessage(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	m, _ := e["message"].(string)
	return m
}

func (f *flow) count(sql string, args ...any) int {
	f.t.Helper()
	var n int
	require.NoError(f.t, f.pool.QueryRow(context.Background(), sql, args...).Scan(&n), sql)
	return n
}

func submission(changes map[string]any) map[string]any {
	return map[string]any{
		"kind": "character", "entityId": 184313,
		"sourceUrl": "https://frieren-anime.jp/character/", "note": "官网角色页",
		"changes": changes,
	}
}

func TestSubmit_Refusals_PG(t *testing.T) {
	f := newFlow(t)
	reader := f.user("reader-one", false)

	code, _ := f.do(http.MethodPost, "/api/edits", nil, submission(map[string]any{"nameCn": "史塔克"}))
	assert.Equal(t, http.StatusUnauthorized, code, "only signed-in readers submit")

	for name, tc := range map[string]struct {
		body any
		code int
		msg  string
	}{
		"not JSON":        {"{", http.StatusBadRequest, msgBadBody},
		"an unknown key":  {`{"kind":"character","entityId":184313,"sourceUrl":"https://x.org","changes":{},"extra":1}`, http.StatusBadRequest, msgBadBody},
		"an unknown kind": {map[string]any{"kind": "anime", "entityId": 1, "sourceUrl": "https://x.org", "changes": map[string]any{}}, http.StatusBadRequest, msgBadKind},
		"a bad id":        {map[string]any{"kind": "person", "entityId": -1, "sourceUrl": "https://x.org", "changes": map[string]any{}}, http.StatusBadRequest, msgBadID},
		"no source": {map[string]any{"kind": "character", "entityId": 184313, "sourceUrl": "  ",
			"changes": map[string]any{"nameCn": "史塔克"}}, http.StatusBadRequest, msgSourceRequired},
		"a script source": {map[string]any{"kind": "character", "entityId": 184313, "sourceUrl": "javascript:alert(1)",
			"changes": map[string]any{"nameCn": "史塔克"}}, http.StatusBadRequest, msgSourceInvalid},
		"a long note": {map[string]any{"kind": "character", "entityId": 184313, "sourceUrl": "https://x.org",
			"note": strings.Repeat("长", maxNoteLen+1), "changes": map[string]any{"nameCn": "史塔克"}}, http.StatusBadRequest, msgNoteInvalid},
		"a page that does not exist": {map[string]any{"kind": "character", "entityId": 999999, "sourceUrl": "https://x.org",
			"changes": map[string]any{"nameCn": "史塔克"}}, http.StatusNotFound, msgNotFound},
		"nothing changed":     {submission(map[string]any{"nameCn": "修塔尔克", "gender": "Male"}), http.StatusBadRequest, msgNothingChanged},
		"no changes at all":   {submission(map[string]any{}), http.StatusBadRequest, msgNothingChanged},
		"a person's field":    {submission(map[string]any{"homeTown": "東京"}), http.StatusBadRequest, "invalid change: homeTown: not on this page"},
		"an image link":       {submission(map[string]any{"image": map[string]any{"url": "http://example.org/a.png"}}), http.StatusBadRequest, msgImageLink},
		"both image kinds":    {submission(map[string]any{"image": map[string]any{"url": "https://e.org/a.png", "dataUrl": "data:image/png;base64,AA"}}), http.StatusBadRequest, "invalid change: image: a link or an upload, one of them"},
		"a GIF upload":        {submission(map[string]any{"image": map[string]any{"dataUrl": "data:image/gif;base64,R0lGODlhAQABAAAAACw="}}), http.StatusBadRequest, msgImageType},
		"an unreadable image": {submission(map[string]any{"image": map[string]any{"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("nope"))}}), http.StatusBadRequest, msgImageUnreadable},
	} {
		code, body := f.do(http.MethodPost, "/api/edits", &reader, tc.body)
		assert.Equal(t, tc.code, code, name)
		assert.Equal(t, tc.msg, errMessage(body), name)
	}
	assert.Zero(t, f.count(`SELECT count(*) FROM edit_submissions`), "nothing refused was stored")
	entries, _ := os.ReadDir(filepath.Join(f.root, "pending"))
	assert.Empty(t, entries, "and no photo was kept")
}

func TestSubmit_LimitsAndOnePendingPerPage_PG(t *testing.T) {
	f := newFlow(t)
	reader := f.user("reader-two", false)
	other := f.user("reader-three", false)

	code, _ := f.do(http.MethodPost, "/api/edits", &reader, submission(map[string]any{"nameCn": "史塔克"}))
	require.Equal(t, http.StatusCreated, code)
	code, body := f.do(http.MethodPost, "/api/edits", &reader, submission(map[string]any{"age": "18"}))
	assert.Equal(t, http.StatusConflict, code, "one open submission per person per page")
	assert.Equal(t, msgPendingExists, errMessage(body))
	code, _ = f.do(http.MethodPost, "/api/edits", &other, submission(map[string]any{"age": "18"}))
	assert.Equal(t, http.StatusCreated, code, "someone else may submit on the same page")

	// Four more after the first, each freed by marking the last reviewed,
	// reach the burst limit; the sixth in ten minutes is refused.
	free := func() {
		_, err := f.pool.Exec(context.Background(), `UPDATE edit_items SET status = 'accepted'
			WHERE submission_id IN (SELECT id FROM edit_submissions WHERE user_id = $1 AND status = 'pending')`, reader.id)
		require.NoError(t, err)
		_, err = f.pool.Exec(context.Background(), `UPDATE edit_submissions
			SET status = 'reviewed', reviewed_at = now(), accepted_count = item_count
			WHERE user_id = $1 AND status = 'pending'`, reader.id)
		require.NoError(t, err)
	}
	for i := 0; i < burstMax-1; i++ {
		free()
		code, body := f.do(http.MethodPost, "/api/edits", &reader, submission(map[string]any{"age": fmt.Sprint(20 + i)}))
		require.Equal(t, http.StatusCreated, code, "%d: %v", i, body)
	}
	free()
	code, body = f.do(http.MethodPost, "/api/edits", &reader, submission(map[string]any{"age": "99"}))
	assert.Equal(t, http.StatusTooManyRequests, code)
	assert.Equal(t, msgTooMany, errMessage(body))
}

// Each request on a process of its own, as behind a load balancer: the
// in-process record of who is in flight cannot see the others, so this is
// the database's guard alone -- the submitter's lock and the unique index.
func TestSubmit_ConcurrentSubmissionsCannotBothPass_PG(t *testing.T) {
	f := newFlow(t)
	reader := f.user("reader-race", false)
	var wg sync.WaitGroup
	codes := make([]int, 4)
	for i := range codes {
		router := f.process()
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _ = f.doOn(router, http.MethodPost, "/api/edits", &reader, submission(map[string]any{"age": fmt.Sprint(30 + i)}))
		}()
	}
	wg.Wait()
	created := 0
	for _, c := range codes {
		if c == http.StatusCreated {
			created++
		} else {
			assert.Equal(t, http.StatusConflict, c, "one open submission per person per page")
		}
	}
	assert.Equal(t, 1, created, "the submitter's lock and the unique index admit one")
	assert.Equal(t, 1, f.count(`SELECT count(*) FROM edit_submissions`))
}

func TestSubmit_OneInFlightPerPerson_PG(t *testing.T) {
	f := newFlow(t)
	reader := f.user("reader-inflight", false)
	f.fetcher.body = pngBytes(t, 20, 30)
	f.fetcher.entered = make(chan struct{}, 1)
	f.fetcher.release = make(chan struct{})

	first := make(chan int, 1)
	go func() {
		code, _ := f.do(http.MethodPost, "/api/edits", &reader, submission(map[string]any{
			"image": map[string]any{"url": "https://images.example.org/slow.png"},
		}))
		first <- code
	}()
	<-f.fetcher.entered // the first is fetching its photo

	code, body := f.do(http.MethodPost, "/api/edits", &reader, submission(map[string]any{"age": "18"}))
	assert.Equal(t, http.StatusTooManyRequests, code, "a second while the first is in flight")
	assert.Equal(t, msgTooMany, errMessage(body))
	other := f.user("reader-other", false)
	code, _ = f.do(http.MethodPost, "/api/edits", &other, submission(map[string]any{"age": "18"}))
	assert.Equal(t, http.StatusCreated, code, "someone else is not held up")

	close(f.fetcher.release)
	assert.Equal(t, http.StatusCreated, <-first)
	f.fetcher.entered = nil
}

// Only a JSON body is read, on both write endpoints.  A form, or a fetch
// another site makes in no-cors mode, can carry a signed-in reader's or an
// admin's cookie (SameSite=None in production) but not this Content-Type:
// asking for it takes a CORS preflight, which only the site's own origin
// passes.  Each refusal comes before anything is read or written.
func TestEdits_OnlyJSONBodies_PG(t *testing.T) {
	f := newFlow(t)
	reader := f.user("reader-plain", false)
	admin := f.user("admin-plain", true)
	f.fetcher.body = pngBytes(t, 20, 30)
	notJSON := []string{
		"text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded",
		"multipart/form-data; boundary=x", "",
	}

	body, err := json.Marshal(submission(map[string]any{
		"nameCn": "史塔克",
		"image":  map[string]any{"url": "https://images.example.org/stark.png"},
	}))
	require.NoError(t, err)
	for _, ct := range notJSON {
		code, got := f.send(f.router, http.MethodPost, "/api/edits", &reader, ct, body)
		assert.Equal(t, http.StatusUnsupportedMediaType, code, ct)
		assert.Equal(t, msgNotJSON, errMessage(got), ct)
	}
	assert.Zero(t, f.count(`SELECT count(*) FROM edit_submissions`), "no submission")
	assert.Empty(t, f.fetcher.got, "no photo fetched")
	stored, _ := os.ReadDir(filepath.Join(f.root, "pending"))
	assert.Empty(t, stored, "none stored")

	// As JSON -- a charset is fine -- the same body is a submission.
	code, got := f.send(f.router, http.MethodPost, "/api/edits", &reader, "application/json; charset=utf-8", body)
	require.Equal(t, http.StatusCreated, code, "%v", got)
	id := got["data"].(map[string]any)["id"].(string)

	_, sub := f.do(http.MethodGet, "/api/admin/edits/"+id, &admin, nil)
	var decisions []map[string]any
	for _, it := range sub["data"].(map[string]any)["items"].([]any) {
		decisions = append(decisions, map[string]any{"itemId": it.(map[string]any)["id"], "accept": true})
	}
	review, err := json.Marshal(map[string]any{"decisions": decisions})
	require.NoError(t, err)
	for _, ct := range notJSON {
		code, got := f.send(f.router, http.MethodPost, "/api/admin/edits/"+id+"/review", &admin, ct, review)
		assert.Equal(t, http.StatusUnsupportedMediaType, code, ct)
		assert.Equal(t, msgNotJSON, errMessage(got), ct)
	}
	assert.Equal(t, 1, f.count(`SELECT count(*) FROM edit_submissions WHERE status = 'pending'`), "not reviewed")
	assert.Zero(t, f.count(`SELECT count(*) FROM edit_items WHERE status <> 'pending'`))
	assert.Zero(t, f.count(`SELECT count(*) FROM entity_overlays`))
	assert.Zero(t, f.count(`SELECT count(*) FROM notifications`))
	stored, _ = os.ReadDir(filepath.Join(f.root, "pending"))
	assert.Len(t, stored, 1, "the photo still waits")

	code, got = f.send(f.router, http.MethodPost, "/api/admin/edits/"+id+"/review", &admin, "application/json; charset=utf-8", review)
	require.Equal(t, http.StatusOK, code, "%v", got)
	assert.Equal(t, "reviewed", got["data"].(map[string]any)["status"])
}

func TestEditFlow_PG(t *testing.T) {
	f := newFlow(t)
	ctx := context.Background()
	submitter := f.user("submitter", false)
	admin := f.user("the-admin", true)

	f.fetcher.body = pngBytes(t, 460, 690)
	code, body := f.do(http.MethodPost, "/api/edits", &submitter, submission(map[string]any{
		"nameCn": "史塔克",
		"image":  map[string]any{"url": "https://images.example.org/stark.png"},
		"roles":  []map[string]any{{"animeId": 182255, "role": "SUPPORTING"}},
		"voices": []map[string]any{{"key": "115100|Japanese|Childhood", "remove": true}, {"personId": 95185, "line": "中配"}},
	}))
	require.Equal(t, http.StatusCreated, code, "%v", body)
	data := body["data"].(map[string]any)
	assert.Equal(t, "pending", data["status"])
	assert.Equal(t, float64(5), data["itemCount"])
	id := data["id"].(string)
	assert.Equal(t, "https://images.example.org/stark.png", f.fetcher.got)

	t.Run("nothing is public before the review", func(t *testing.T) {
		code, page := f.do(http.MethodGet, "/api/characters/184313", nil, nil)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "修塔尔克", page["data"].(map[string]any)["name"].(map[string]any)["cn"])
		assert.Zero(t, f.count(`SELECT count(*) FROM entity_overlays`))
	})

	t.Run("the queue is the admin's", func(t *testing.T) {
		code, _ := f.do(http.MethodGet, "/api/admin/edits", &submitter, nil)
		assert.Equal(t, http.StatusForbidden, code)
		code, _ = f.do(http.MethodPost, "/api/admin/edits/"+id+"/review", &submitter, map[string]any{"decisions": []any{}})
		assert.Equal(t, http.StatusForbidden, code)

		code, list := f.do(http.MethodGet, "/api/admin/edits", &admin, nil)
		require.Equal(t, http.StatusOK, code)
		ld := list["data"].(map[string]any)
		assert.Equal(t, float64(1), ld["pendingCount"])
		items := ld["items"].([]any)
		require.Len(t, items, 1)
		row := items[0].(map[string]any)
		assert.Equal(t, id, row["id"])
		assert.Equal(t, true, row["hasImage"])
		assert.Equal(t, "submitter", row["submitter"].(map[string]any)["username"])
		assert.Equal(t, float64(1), row["submitter"].(map[string]any)["nth"])
		snap := row["snapshot"].(map[string]any)
		assert.Equal(t, "修塔尔克", snap["name"].(map[string]any)["cn"])
		assert.Equal(t, "葬送的芙莉莲", snap["work"].(map[string]any)["titleChinese"])

		code, list = f.do(http.MethodGet, "/api/admin/edits?status=reviewed", &admin, nil)
		require.Equal(t, http.StatusOK, code)
		assert.Empty(t, list["data"].(map[string]any)["items"])
		code, _ = f.do(http.MethodGet, "/api/admin/edits?status=nonsense", &admin, nil)
		assert.Equal(t, http.StatusBadRequest, code)
	})

	var items []map[string]any
	t.Run("one submission, item by item", func(t *testing.T) {
		code, got := f.do(http.MethodGet, "/api/admin/edits/"+id, &admin, nil)
		require.Equal(t, http.StatusOK, code)
		sub := got["data"].(map[string]any)
		assert.Equal(t, "https://frieren-anime.jp/character/", sub["sourceUrl"])
		assert.Equal(t, "官网角色页", sub["note"])
		for _, it := range sub["items"].([]any) {
			items = append(items, it.(map[string]any))
		}
		var order []string
		for _, it := range items {
			order = append(order, it["field"].(string))
		}
		assert.Equal(t, []string{"image", "nameCn", "voice", "voice", "role"}, order)

		img := items[0]
		assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/character/large/b184313.jpg", img["old"], "the old image beside the new")
		newImg := img["new"].(map[string]any)
		assert.Equal(t, float64(460), newImg["width"])
		assert.Equal(t, "https://images.example.org/stark.png", newImg["source"])
		preview := img["previewUrl"].(string)
		assert.True(t, strings.HasPrefix(preview, "/api/admin/edits/images/"))

		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, preview, nil)
		req.Header.Set("Authorization", "Bearer "+admin.token)
		f.router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code, "the admin sees the waiting photo")
		rec = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodGet, preview, nil)
		req.Header.Set("Authorization", "Bearer "+submitter.token)
		f.router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusForbidden, rec.Code, "nobody else does")
		rec = httptest.NewRecorder()
		f.router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/edit-images/"+newImg["file"].(string), nil))
		assert.Equal(t, http.StatusNotFound, rec.Code, "and it is not public")

		assert.Equal(t, "修塔尔克", items[1]["old"])
		assert.Equal(t, "史塔克", items[1]["new"])
		assert.Nil(t, items[2]["new"], "the childhood row removed")
		assert.Nil(t, items[3]["old"], "a row added")
		assert.Equal(t, "182255", items[4]["key"])
	})

	decide := func(acceptAllBut ...int) []map[string]any {
		var out []map[string]any
		for i, it := range items {
			d := map[string]any{"itemId": it["id"], "accept": true}
			for _, j := range acceptAllBut {
				if i == j {
					d["accept"] = false
					d["note"] = "这张图是第二季的造型，会剧透，先不换"
				}
			}
			out = append(out, d)
		}
		return out
	}

	t.Run("refused reviews change nothing", func(t *testing.T) {
		missingNote := decide()
		missingNote[0] = map[string]any{"itemId": items[0]["id"], "accept": false}
		code, body := f.do(http.MethodPost, "/api/admin/edits/"+id+"/review", &admin, map[string]any{"decisions": missingNote})
		assert.Equal(t, http.StatusBadRequest, code)
		assert.Equal(t, msgRejectNote, errMessage(body))

		blankNote := decide()
		blankNote[0] = map[string]any{"itemId": items[0]["id"], "accept": false, "note": "   "}
		code, _ = f.do(http.MethodPost, "/api/admin/edits/"+id+"/review", &admin, map[string]any{"decisions": blankNote})
		assert.Equal(t, http.StatusBadRequest, code)

		code, body = f.do(http.MethodPost, "/api/admin/edits/"+id+"/review", &admin, map[string]any{"decisions": decide()[:3]})
		assert.Equal(t, http.StatusBadRequest, code, "every item needs a decision")
		assert.Equal(t, msgReviewBody, errMessage(body))

		code, _ = f.do(http.MethodPost, "/api/admin/edits/"+uuid.NewString()+"/review", &admin, map[string]any{"decisions": decide()})
		assert.Equal(t, http.StatusNotFound, code)

		assert.Zero(t, f.count(`SELECT count(*) FROM entity_overlays`))
		assert.Equal(t, 1, f.count(`SELECT count(*) FROM edit_submissions WHERE status = 'pending'`))
	})

	t.Run("a partial accept: the name and the rest, not the photo", func(t *testing.T) {
		code, body := f.do(http.MethodPost, "/api/admin/edits/"+id+"/review", &admin, map[string]any{"decisions": decide(0)})
		require.Equal(t, http.StatusOK, code, "%v", body)
		sub := body["data"].(map[string]any)
		assert.Equal(t, "reviewed", sub["status"])
		assert.Equal(t, float64(4), sub["acceptedCount"])
		assert.Equal(t, float64(1), sub["rejectedCount"])
		assert.Equal(t, "the-admin", sub["reviewer"])
		first := sub["items"].([]any)[0].(map[string]any)
		assert.Equal(t, "rejected", first["status"])
		assert.Equal(t, "这张图是第二季的造型，会剧透，先不换", first["rejectNote"])
		assert.Nil(t, first["previewUrl"], "a rejected photo is deleted")
		entries, _ := os.ReadDir(filepath.Join(f.root, "pending"))
		assert.Empty(t, entries)

		code, again := f.do(http.MethodPost, "/api/admin/edits/"+id+"/review", &admin, map[string]any{"decisions": decide()})
		assert.Equal(t, http.StatusConflict, code, "reviewed once")
		assert.Equal(t, msgAlreadyReviewed, errMessage(again))

		f.mu.Lock()
		assert.ElementsMatch(t, []int32{154587, 182255}, f.forgotten, "every title crediting Stark leaves the detail cache")
		f.mu.Unlock()
	})

	t.Run("the page shows the accepted values and the old photo", func(t *testing.T) {
		code, page := f.do(http.MethodGet, "/api/characters/184313", nil, nil)
		require.Equal(t, http.StatusOK, code)
		c := page["data"].(map[string]any)
		assert.Equal(t, "史塔克", c["name"].(map[string]any)["cn"])
		assert.Equal(t, "https://s4.anilist.co/file/anilistcdn/character/large/b184313.jpg", c["image"])
		apps := c["appearances"].([]any)
		assert.Equal(t, "SUPPORTING", apps[1].(map[string]any)["role"])
		var voices []string
		for _, v := range c["voices"].([]any) {
			vm := v.(map[string]any)
			voices = append(voices, vm["key"].(string))
		}
		assert.Equal(t, []string{"133507|Japanese|", "add:95185"}, voices)

		// The credit tables were not written.
		assert.Equal(t, 1, f.count(`SELECT count(*) FROM anime_character_voices WHERE character_id = 184313 AND staff_id = 115100`))
		assert.Equal(t, 1, f.count(`SELECT count(*) FROM anime_characters WHERE character_id = 184313 AND anime_id = 182255 AND role = 'MAIN'`))
		assert.Equal(t, 1, f.count(`SELECT count(*) FROM bgm_character_map WHERE anilist_id = 184313 AND name_cn = '修塔尔克'`))
	})

	t.Run("the submitter is told", func(t *testing.T) {
		code, inbox := f.do(http.MethodGet, "/api/notifications", &submitter, nil)
		require.Equal(t, http.StatusOK, code)
		items := inbox["data"].(map[string]any)["items"].([]any)
		require.Len(t, items, 1)
		n := items[0].(map[string]any)
		assert.Equal(t, "edit_review", n["type"])
		edit := n["edit"].(map[string]any)
		assert.Equal(t, "character", edit["kind"])
		assert.Equal(t, float64(184313), edit["entityId"])
		assert.Equal(t, float64(4), edit["accepted"])
		assert.Equal(t, float64(1), edit["rejected"])
		assert.Equal(t, []any{"这张图是第二季的造型，会剧透，先不换"}, edit["rejectNotes"])
		assert.Equal(t, float64(1), inbox["data"].(map[string]any)["unreadCount"])
		assert.Equal(t, map[string]any{"username": "", "avatarUrl": nil}, n["actor"], "not who reviewed it")
	})

	t.Run("an accepted photo is published and shown", func(t *testing.T) {
		f.fetcher.body = pngBytes(t, 230, 345)
		code, body := f.do(http.MethodPost, "/api/edits", &submitter, submission(map[string]any{
			"image": map[string]any{"url": "https://images.example.org/stark2.png"},
		}))
		require.Equal(t, http.StatusCreated, code, "%v", body)
		sid := body["data"].(map[string]any)["id"].(string)
		_, got := f.do(http.MethodGet, "/api/admin/edits/"+sid, &admin, nil)
		item := got["data"].(map[string]any)["items"].([]any)[0].(map[string]any)
		file := item["new"].(map[string]any)["file"].(string)

		code, body = f.do(http.MethodPost, "/api/admin/edits/"+sid+"/review", &admin, map[string]any{
			"decisions": []map[string]any{{"itemId": item["id"], "accept": true}},
		})
		require.Equal(t, http.StatusOK, code, "%v", body)
		published := body["data"].(map[string]any)["items"].([]any)[0].(map[string]any)["previewUrl"]
		assert.Equal(t, "https://example.org/api/edit-images/"+file, published)

		rec := httptest.NewRecorder()
		f.router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/edit-images/"+file, nil))
		assert.Equal(t, http.StatusOK, rec.Code, "public now")
		_, page := f.do(http.MethodGet, "/api/characters/184313", nil, nil)
		assert.Equal(t, "https://example.org/api/edit-images/"+file, page["data"].(map[string]any)["image"])
		assert.Equal(t, "史塔克", page["data"].(map[string]any)["name"].(map[string]any)["cn"],
			"a second accepted edit keeps the first one's fields")
	})

	t.Run("an admin reviewing their own submission is not notified", func(t *testing.T) {
		code, body := f.do(http.MethodPost, "/api/edits", &admin, map[string]any{
			"kind": "person", "entityId": 133507, "sourceUrl": "https://x.org/profile",
			"changes": map[string]any{"homeTown": "神奈川县", "occupations": []string{"Voice Actor", "Singer"}},
		})
		require.Equal(t, http.StatusCreated, code, "%v", body)
		sid := body["data"].(map[string]any)["id"].(string)
		_, got := f.do(http.MethodGet, "/api/admin/edits/"+sid, &admin, nil)
		var decisions []map[string]any
		for _, it := range got["data"].(map[string]any)["items"].([]any) {
			decisions = append(decisions, map[string]any{"itemId": it.(map[string]any)["id"], "accept": true})
		}
		code, _ = f.do(http.MethodPost, "/api/admin/edits/"+sid+"/review", &admin, map[string]any{"decisions": decisions})
		require.Equal(t, http.StatusOK, code)
		assert.Zero(t, f.count(`SELECT count(*) FROM notifications WHERE user_id = $1`, admin.id))

		_, person := f.do(http.MethodGet, "/api/people/133507", nil, nil)
		profile := person["data"].(map[string]any)["profile"].(map[string]any)
		assert.Equal(t, "神奈川县", profile["homeTown"])
		assert.Equal(t, []any{"Voice Actor", "Singer"}, profile["occupations"])
	})

	var overlayRows int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM entity_overlays`).Scan(&overlayRows))
	assert.Equal(t, 2, overlayRows)
}
