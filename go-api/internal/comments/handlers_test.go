package comments

// handlers_test.go — PG-backed tests for the three comment endpoints.
//
// One Postgres testcontainer spins up via TestMain and is shared
// across every Test* in the package.  Per-test isolation comes from
// testutil.TruncateAll between tests.
//
// Tests cover:
//   - ListComments:  happy / empty / bad params / DB error.
//   - AddComment:    happy (top-level + reply) / bad params / missing auth /
//                    empty content / whitespace-only / overflow / bad parent /
//                    cross-episode parent abuse / DB error / malformed JSON.
//   - DeleteComment: happy / bad uuid / missing auth / 404 / 403 / DB error.
//   - parseEpisodePath helper / message constants exercised via the handler
//     tests so coverage stays ≥85%.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// pgURI is populated by TestMain.  All tests open their own pool
// against this URI via testutil.NewWebPool so a leaked pool in one
// test can't poison another.
var pgURI string

func TestMain(m *testing.M) {
	ctx := context.Background()
	uri, cleanup, err := testutil.SetupPGForMain(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "comments tests: setup postgres: %v\n", err)
		os.Exit(1)
	}
	defer cleanup()
	pgURI = uri
	os.Exit(m.Run())
}

// makeHandlers spins a fresh pool + Handlers for one test.  Pool is
// closed via t.Cleanup so test parallelism doesn't accumulate leaked
// pools.
func makeHandlers(t *testing.T) (*Handlers, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	queries := dbgen.New(pool)
	h := NewHandlers(pool, queries)
	return h, pool
}

// --- Seed helpers -----------------------------------------------------------

func seedUser(t *testing.T, pool *pgxpool.Pool, username, email string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO users (username, email, password)
		VALUES ($1, $2, 'bcrypt-placeholder')
		RETURNING id`,
		username, email,
	).Scan(&id)
	require.NoError(t, err, "seedUser")
	return id
}

// seedAnime inserts a minimal anime_cache row so the episode_comments
// FK to anime_cache(anilist_id) passes.  No metadata needed — just the
// PK column.
func seedAnime(t *testing.T, pool *pgxpool.Pool, anilistID int32) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, cached_at)
		VALUES ($1, now())`,
		anilistID,
	)
	require.NoError(t, err, "seedAnime")
}

// seedComment inserts a top-level comment and returns the row id.  Used
// by parent-validation tests to set up an existing comment a reply can
// target.
func seedComment(t *testing.T, pool *pgxpool.Pool, anilistID, episode int32, userID uuid.UUID, username, content string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO episode_comments (anilist_id, episode, user_id, username, content)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		anilistID, episode, userID, username, content,
	).Scan(&id)
	require.NoError(t, err, "seedComment")
	return id
}

// withAuth wraps r with a valid JWT-populated context for userID +
// username.  Tests that need auth call this on their pre-built request.
func withAuth(t *testing.T, r *http.Request, userID uuid.UUID, username string) *http.Request {
	t.Helper()
	signer, err := jwtx.NewSigner("test-access", "test-refresh", 15*time.Minute, time.Hour)
	require.NoError(t, err)
	tok, err := signer.SignAccess(userID, username, nil)
	require.NoError(t, err)

	mw := jwtx.RequireAuth(signer)
	var captured *http.Request
	handler := mw(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
		captured = req
	}))
	holder := r.Clone(r.Context())
	holder.Header.Set("Authorization", "Bearer "+tok)
	handler.ServeHTTP(httptest.NewRecorder(), holder)
	require.NotNil(t, captured, "RequireAuth did not populate request")
	return captured
}

// reqWithEpisode builds a request with chi's :anilistId + :episode
// URL params already injected so handlers don't need to be wired
// through a router.
func reqWithEpisode(method, path, body string, anilistID, episode string) *http.Request {
	var b *bytes.Buffer
	if body != "" {
		b = bytes.NewBufferString(body)
	} else {
		b = &bytes.Buffer{}
	}
	req := httptest.NewRequest(method, path, b)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", anilistID)
	rc.URLParams.Add("episode", episode)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
}

// reqWithID builds a DELETE request with chi's :id URL param injected.
func reqWithID(method, path, id string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
}

// assertErrorEnvelope verifies the 4xx/5xx response shape + the exact
// English message.
func assertErrorEnvelope(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode, wantMsg string) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Errorf("status = %d, want %d; body=%s", rec.Code, wantStatus, rec.Body.String())
	}
	want := `{"error":{"code":"` + wantCode + `","message":"` + wantMsg + `"}}`
	if got := rec.Body.String(); got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

// -----------------------------------------------------------------------------
// ListComments
// -----------------------------------------------------------------------------

func TestListComments_HappyPath(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")

	// Seed two top-level comments and one reply.
	parent := seedComment(t, pool, 1, 1, alice, "alice", "first comment")
	_ = parent
	seedComment(t, pool, 1, 1, bob, "bob", "second comment")
	// Reply to parent
	ctx := context.Background()
	var replyID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO episode_comments (anilist_id, episode, user_id, username, content, parent_id, reply_to_username)
		VALUES (1, 1, $1, 'bob', 'reply to alice', $2, 'alice')
		RETURNING id`, bob, parent).Scan(&replyID))

	req := reqWithEpisode(http.MethodGet, "/api/comments/1/1", "", "1", "1")
	rec := httptest.NewRecorder()
	h.ListComments(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var env struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Len(t, env.Data, 3, "expected 3 comments; body=%s", rec.Body.String())

	// Sorted ASC by created_at — order matches insert order.
	assert.Equal(t, "first comment", env.Data[0]["content"])
	assert.Equal(t, "second comment", env.Data[1]["content"])
	assert.Equal(t, "reply to alice", env.Data[2]["content"])

	// Reply has parentId + replyToUsername set.
	assert.NotNil(t, env.Data[2]["parentId"])
	assert.Equal(t, "alice", env.Data[2]["replyToUsername"])

	// Top-level has parentId = null.
	assert.Nil(t, env.Data[0]["parentId"])
	assert.Nil(t, env.Data[0]["replyToUsername"])
}

func TestListComments_EmptyArray(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)

	req := reqWithEpisode(http.MethodGet, "/api/comments/1/1", "", "1", "1")
	rec := httptest.NewRecorder()
	h.ListComments(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":[]}`, rec.Body.String(), "empty should emit []")
}

func TestListComments_InvalidAnilistID(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithEpisode(http.MethodGet, "/api/comments/abc/1", "", "abc", "1")
	rec := httptest.NewRecorder()
	h.ListComments(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestListComments_InvalidEpisode(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithEpisode(http.MethodGet, "/api/comments/1/xyz", "", "1", "xyz")
	rec := httptest.NewRecorder()
	h.ListComments(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestListComments_ZeroAnilistID(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithEpisode(http.MethodGet, "/api/comments/0/1", "", "0", "1")
	rec := httptest.NewRecorder()
	h.ListComments(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestListComments_NegativeEpisode(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithEpisode(http.MethodGet, "/api/comments/1/-1", "", "1", "-1")
	rec := httptest.NewRecorder()
	h.ListComments(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestListComments_DBError_500(t *testing.T) {
	h, pool := makeHandlers(t)
	pool.Close()
	req := reqWithEpisode(http.MethodGet, "/api/comments/1/1", "", "1", "1")
	rec := httptest.NewRecorder()
	h.ListComments(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"SERVER_ERROR"`)
}

// -----------------------------------------------------------------------------
// AddComment
// -----------------------------------------------------------------------------

func TestAddComment_TopLevel_201(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	body := `{"content":"hello world"}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	// Re-inject chi route params after auth wrapping.
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())
	bodyStr := rec.Body.String()
	require.Contains(t, bodyStr, `"content":"hello world"`)
	require.Contains(t, bodyStr, `"username":"alice"`)
	require.Contains(t, bodyStr, `"anilistId":1`)
	require.Contains(t, bodyStr, `"episode":1`)
	require.Contains(t, bodyStr, `"parentId":null`)
	require.Contains(t, bodyStr, `"replyToUsername":null`)
}

func TestAddComment_Reply_201(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	parent := seedComment(t, pool, 1, 1, alice, "alice", "first")

	body := fmt.Sprintf(`{"content":"reply!","parentId":%q,"replyToUsername":"alice"}`, parent.String())
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())
	bodyStr := rec.Body.String()
	require.Contains(t, bodyStr, `"content":"reply!"`)
	require.Contains(t, bodyStr, `"username":"bob"`)
	require.Contains(t, bodyStr, fmt.Sprintf(`"parentId":%q`, parent.String()))
	require.Contains(t, bodyStr, `"replyToUsername":"alice"`)
}

func TestAddComment_TrimsLeadingTrailingWhitespace(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	body := `{"content":"   spaced   "}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())
	require.Contains(t, rec.Body.String(), `"content":"spaced"`, "leading/trailing whitespace should be stripped")
}

func TestAddComment_MissingAuth_401(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)

	body := `{"content":"unauth"}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	rec := httptest.NewRecorder()
	h.AddComment(rec, req)

	assertErrorEnvelope(t, rec, http.StatusUnauthorized, "UNAUTHORIZED", "Please log in again")
}

func TestAddComment_BadParams_400(t *testing.T) {
	h, _ := makeHandlers(t)
	body := `{"content":"hi"}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/abc/1", body, "abc", "1")
	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestAddComment_EmptyContent_400(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	body := `{"content":""}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Content is required")
}

func TestAddComment_WhitespaceOnlyContent_400(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	body := `{"content":"   \t\n   "}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Content is required")
}

func TestAddComment_OverflowContent_400(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	overflow := strings.Repeat("a", maxContentRunes+1)
	body := `{"content":"` + overflow + `"}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Content too long")
}

func TestAddComment_ExactlyMaxContent_201(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	exact := strings.Repeat("a", maxContentRunes)
	body := `{"content":"` + exact + `"}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code, "exactly 500 runes should pass; body=%s", rec.Body.String())
}

func TestAddComment_ParentNotFound_400(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	// No parent comment seeded — random UUID won't match.

	fakeParent := uuid.New().String()
	body := fmt.Sprintf(`{"content":"reply","parentId":%q}`, fakeParent)
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Parent comment not found")
}

// TestAddComment_CrossEpisodeParentRejected verifies the same-episode
// invariant — a comment id valid on episode 1 cannot be used as a parent
// for a reply on episode 2.  This is the SQL-level abuse defense.
func TestAddComment_CrossEpisodeParentRejected(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")

	// Seed a parent on episode 1.
	parent := seedComment(t, pool, 1, 1, alice, "alice", "ep1 comment")

	// Try to reply on episode 2 referencing the episode-1 parent id.
	body := fmt.Sprintf(`{"content":"cross-ep reply","parentId":%q}`, parent.String())
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/2", body, "1", "2")
	req = withAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "2")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Parent comment not found")
}

func TestAddComment_MalformedJSON_400(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	body := `{garbage`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	// Express's first guard is `!content` → 400 VALIDATION_ERROR
	// "Content is required" — we mirror that exact response.
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Content is required")
}

func TestAddComment_DBError_500(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	pool.Close()

	body := `{"content":"hi"}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "body=%s", rec.Body.String())
	require.Contains(t, rec.Body.String(), `"code":"SERVER_ERROR"`)
}

// -----------------------------------------------------------------------------
// DeleteComment
// -----------------------------------------------------------------------------

func TestDeleteComment_OwnComment_200(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	id := seedComment(t, pool, 1, 1, alice, "alice", "my comment")

	req := reqWithID(http.MethodDelete, "/api/comments/"+id.String(), id.String())
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", id.String())
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.DeleteComment(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.Equal(t, `{"data":{"success":true}}`, rec.Body.String())

	// Verify row is gone.
	var count int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM episode_comments WHERE id=$1`, id,
	).Scan(&count))
	assert.Equal(t, 0, count, "comment should be deleted")
}

// TestDeleteComment_CascadesReplies verifies ON DELETE CASCADE removes
// any reply children automatically — Express's deleteOne() left them
// dangling; the Postgres FK fixes that for free.
func TestDeleteComment_CascadesReplies(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")

	parent := seedComment(t, pool, 1, 1, alice, "alice", "parent")
	// Add reply.
	ctx := context.Background()
	var replyID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO episode_comments (anilist_id, episode, user_id, username, content, parent_id, reply_to_username)
		VALUES (1, 1, $1, 'bob', 'child', $2, 'alice')
		RETURNING id`, bob, parent).Scan(&replyID))

	req := reqWithID(http.MethodDelete, "/api/comments/"+parent.String(), parent.String())
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", parent.String())
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.DeleteComment(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM episode_comments`).Scan(&count))
	assert.Equal(t, 0, count, "ON DELETE CASCADE should remove the reply too")
}

func TestDeleteComment_BadUUID_400(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithID(http.MethodDelete, "/api/comments/not-a-uuid", "not-a-uuid")
	rec := httptest.NewRecorder()
	h.DeleteComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestDeleteComment_MissingAuth_401(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	id := seedComment(t, pool, 1, 1, alice, "alice", "comment")

	req := reqWithID(http.MethodDelete, "/api/comments/"+id.String(), id.String())
	rec := httptest.NewRecorder()
	h.DeleteComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusUnauthorized, "UNAUTHORIZED", "Please log in again")
}

func TestDeleteComment_NotFound_404(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	nonexistent := uuid.New().String()
	req := reqWithID(http.MethodDelete, "/api/comments/"+nonexistent, nonexistent)
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", nonexistent)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.DeleteComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "Comment not found")
}

func TestDeleteComment_NotYourComment_403(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	id := seedComment(t, pool, 1, 1, alice, "alice", "alice's comment")

	// Bob tries to delete Alice's comment.
	req := reqWithID(http.MethodDelete, "/api/comments/"+id.String(), id.String())
	req = withAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", id.String())
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.DeleteComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusForbidden, "FORBIDDEN", "Not your comment")
}

func TestDeleteComment_DBLookupError_500(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	pool.Close()

	id := uuid.New().String()
	req := reqWithID(http.MethodDelete, "/api/comments/"+id, id)
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.DeleteComment(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "body=%s", rec.Body.String())
}

// -----------------------------------------------------------------------------
// Constructor + helpers
// -----------------------------------------------------------------------------

func TestNewHandlers_NilPoolPanics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on nil Pool")
		}
	}()
	_ = NewHandlers(nil, dbgen.New(nil))
}

func TestNewHandlers_NilQueriesPanics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on nil CommentsDB")
		}
	}()
	pool := testutil.NewWebPool(t, context.Background(), pgURI)
	_ = NewHandlers(pool, nil)
}

// -----------------------------------------------------------------------------
// fakeDB — exercise secondary DB-error paths the PG-backed tests can't
// easily reach.
// -----------------------------------------------------------------------------

type fakeDB struct {
	listFn      func(ctx context.Context, anilistID, episode int32) ([]dbgen.EpisodeComment, error)
	createFn    func(ctx context.Context, arg dbgen.CreateCommentParams) (dbgen.EpisodeComment, error)
	parentFn    func(ctx context.Context, id uuid.UUID, anilistID, episode int32) (uuid.UUID, error)
	getByIDFn   func(ctx context.Context, id uuid.UUID) (dbgen.GetCommentByIDRow, error)
	deleteFn    func(ctx context.Context, id uuid.UUID) error
}

func (f *fakeDB) ListEpisodeComments(ctx context.Context, anilistID, episode int32) ([]dbgen.EpisodeComment, error) {
	if f.listFn == nil {
		panic("fakeDB.ListEpisodeComments not set")
	}
	return f.listFn(ctx, anilistID, episode)
}

func (f *fakeDB) CreateComment(ctx context.Context, arg dbgen.CreateCommentParams) (dbgen.EpisodeComment, error) {
	if f.createFn == nil {
		panic("fakeDB.CreateComment not set")
	}
	return f.createFn(ctx, arg)
}

func (f *fakeDB) GetCommentParentForValidation(ctx context.Context, id uuid.UUID, anilistID, episode int32) (uuid.UUID, error) {
	if f.parentFn == nil {
		panic("fakeDB.GetCommentParentForValidation not set")
	}
	return f.parentFn(ctx, id, anilistID, episode)
}

func (f *fakeDB) GetCommentByID(ctx context.Context, id uuid.UUID) (dbgen.GetCommentByIDRow, error) {
	if f.getByIDFn == nil {
		panic("fakeDB.GetCommentByID not set")
	}
	return f.getByIDFn(ctx, id)
}

func (f *fakeDB) DeleteComment(ctx context.Context, id uuid.UUID) error {
	if f.deleteFn == nil {
		panic("fakeDB.DeleteComment not set")
	}
	return f.deleteFn(ctx, id)
}

func stubHandlers(t *testing.T, db CommentsDB) *Handlers {
	t.Helper()
	pool := testutil.NewWebPool(t, context.Background(), pgURI)
	return &Handlers{Pool: pool, Queries: db}
}

func TestAddComment_CreateDBError_500(t *testing.T) {
	db := &fakeDB{
		createFn: func(_ context.Context, _ dbgen.CreateCommentParams) (dbgen.EpisodeComment, error) {
			return dbgen.EpisodeComment{}, errors.New("disk full")
		},
	}
	h := stubHandlers(t, db)

	body := `{"content":"hi"}`
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, uuid.New(), "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "body=%s", rec.Body.String())
}

func TestAddComment_ParentLookupNonErrNoRows_500(t *testing.T) {
	db := &fakeDB{
		parentFn: func(_ context.Context, _ uuid.UUID, _, _ int32) (uuid.UUID, error) {
			return uuid.Nil, errors.New("connection refused")
		},
	}
	h := stubHandlers(t, db)

	parent := uuid.New().String()
	body := fmt.Sprintf(`{"content":"reply","parentId":%q}`, parent)
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, uuid.New(), "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "body=%s", rec.Body.String())
}

func TestDeleteComment_DeleteFails_500(t *testing.T) {
	uid := uuid.New()
	db := &fakeDB{
		getByIDFn: func(_ context.Context, _ uuid.UUID) (dbgen.GetCommentByIDRow, error) {
			return dbgen.GetCommentByIDRow{ID: uuid.New(), UserID: uid}, nil
		},
		deleteFn: func(_ context.Context, _ uuid.UUID) error {
			return errors.New("disk full")
		},
	}
	h := stubHandlers(t, db)

	id := uuid.New().String()
	req := reqWithID(http.MethodDelete, "/api/comments/"+id, id)
	req = withAuth(t, req, uid, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.DeleteComment(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "body=%s", rec.Body.String())
}

func TestListComments_ReturnsEmptyOnNilFromDB(t *testing.T) {
	// Defensive coverage for the "rows == nil" branch in ListComments.
	db := &fakeDB{
		listFn: func(_ context.Context, _, _ int32) ([]dbgen.EpisodeComment, error) {
			return nil, nil
		},
	}
	h := stubHandlers(t, db)
	req := reqWithEpisode(http.MethodGet, "/api/comments/1/1", "", "1", "1")
	rec := httptest.NewRecorder()
	h.ListComments(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.Equal(t, `{"data":[]}`, rec.Body.String(), "nil rows should marshal to empty array")
}

// TestParseEpisodePath_Cases drives every branch of the helper through
// the handler (since chi URL params are the only realistic injection
// point).  The handler's first action is parseEpisodePath, so any 400
// "Invalid params" we observe came from this helper.
func TestParseEpisodePath_Cases(t *testing.T) {
	h, _ := makeHandlers(t)
	cases := []struct {
		anilistID string
		episode   string
		wantOK    bool
	}{
		{"1", "1", true},
		{"0", "1", false},
		{"-1", "1", false},
		{"abc", "1", false},
		{"1", "0", false},
		{"1", "-1", false},
		{"1", "xyz", false},
		{"", "1", false},
		{"1", "", false},
	}
	for _, tc := range cases {
		req := reqWithEpisode(http.MethodGet, "/api/comments/x/y", "", tc.anilistID, tc.episode)
		rec := httptest.NewRecorder()
		h.ListComments(rec, req)
		if tc.wantOK {
			require.True(t, rec.Code == http.StatusOK || rec.Code == http.StatusInternalServerError,
				"a=%s e=%s want OK or 500 (anime_cache missing); got %d body=%s",
				tc.anilistID, tc.episode, rec.Code, rec.Body.String())
		} else {
			require.Equal(t, http.StatusBadRequest, rec.Code,
				"a=%s e=%s want 400; got %d body=%s",
				tc.anilistID, tc.episode, rec.Code, rec.Body.String())
		}
	}
}

// Sanity: pgx.ErrNoRows is mapped to msgParentNotFound by AddComment.
// This is a redundant test (the cross-episode + missing-parent tests
// above cover the path) but exercises the errors.Is branch directly.
func TestAddComment_ParentErrNoRows_Mapped(t *testing.T) {
	db := &fakeDB{
		parentFn: func(_ context.Context, _ uuid.UUID, _, _ int32) (uuid.UUID, error) {
			return uuid.Nil, pgx.ErrNoRows
		},
	}
	h := stubHandlers(t, db)

	parent := uuid.New().String()
	body := fmt.Sprintf(`{"content":"hi","parentId":%q}`, parent)
	req := reqWithEpisode(http.MethodPost, "/api/comments/1/1", body, "1", "1")
	req = withAuth(t, req, uuid.New(), "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "1")
	rc.URLParams.Add("episode", "1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.AddComment(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Parent comment not found")
}
