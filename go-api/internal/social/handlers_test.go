package social

// handlers_test.go — PG-backed tests for the five social endpoints.
//
// One Postgres testcontainer spins up via TestMain and is shared
// across every Test* in the package.  Per-test isolation comes from
// testutil.TruncateAll between tests.
//
// Tests cover:
//   - GetProfile:  happy / 404 / anon (isFollowing null) / auth'd
//     (isFollowing true|false) / DB error.
//   - Follow / Unfollow:  happy / self-follow guard / 404 / missing
//     claims / idempotency.
//   - ListFollowers / ListFollowing:  happy / pagination / 404 /
//     empty.
//   - parsePage / fallbackTitle / mapWatching / mapFeedRows helpers
//     exercised directly so coverage stays ≥85% even on the rarer
//     code paths.
//
// feed_test.go hosts the GET /api/feed specific tests because the
// fixture setup (multi-followee, multi-subscription) is larger than
// the rest.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
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
		fmt.Fprintf(os.Stderr, "social tests: setup postgres: %v\n", err)
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

// seedAnime inserts a minimal anime_cache row.  TitleRomaji is required
// for the feed/profile projections; everything else defaults NULL.
func seedAnime(t *testing.T, pool *pgxpool.Pool, anilistID int32, titleRomaji, titleChinese, coverImageUrl string) {
	t.Helper()
	ctx := context.Background()
	var romaji, chinese, cover *string
	if titleRomaji != "" {
		romaji = &titleRomaji
	}
	if titleChinese != "" {
		chinese = &titleChinese
	}
	if coverImageUrl != "" {
		cover = &coverImageUrl
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese, cover_image_url, cached_at)
		VALUES ($1, $2, $3, $4, now())`,
		anilistID, romaji, chinese, cover,
	)
	require.NoError(t, err, "seedAnime")
}

// seedSubscription inserts one subscription row.  episode + lastWatchedAt
// are needed for feed tests; profile tests can leave them at default.
func seedSubscription(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID, currentEp int32, status string, lastWatchedAt *time.Time) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO subscriptions (user_id, anilist_id, status, current_episode, last_watched_at)
		VALUES ($1, $2, $3, $4, $5)`,
		userID, anilistID, status, currentEp, lastWatchedAt,
	)
	require.NoError(t, err, "seedSubscription")
}

// seedFollow inserts one follow edge.  follower → followee.
func seedFollow(t *testing.T, pool *pgxpool.Pool, follower, followee uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO follows (follower_id, followee_id)
		VALUES ($1, $2)`,
		follower, followee,
	)
	require.NoError(t, err, "seedFollow")
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

// withOptionalAuth runs the request through OptionalAuth middleware so
// claims are attached if a token is present.  Used by profile tests to
// exercise the auth'd-vs-anon code paths.
func withOptionalAuth(t *testing.T, r *http.Request, userID uuid.UUID, username string) *http.Request {
	t.Helper()
	signer, err := jwtx.NewSigner("test-access", "test-refresh", 15*time.Minute, time.Hour)
	require.NoError(t, err)
	tok, err := signer.SignAccess(userID, username, nil)
	require.NoError(t, err)

	mw := jwtx.OptionalAuth(signer)
	var captured *http.Request
	handler := mw(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
		captured = req
	}))
	holder := r.Clone(r.Context())
	holder.Header.Set("Authorization", "Bearer "+tok)
	handler.ServeHTTP(httptest.NewRecorder(), holder)
	require.NotNil(t, captured, "OptionalAuth did not populate request")
	return captured
}

// reqWithUsername builds a request with chi's :username URL param
// already injected so handlers don't need to be wired through a router.
func reqWithUsername(method, path, body, username string) *http.Request {
	var b *bytes.Buffer
	if body != "" {
		b = bytes.NewBufferString(body)
	} else {
		b = &bytes.Buffer{}
	}
	req := httptest.NewRequest(method, path, b)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", username)
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
// GetProfile
// -----------------------------------------------------------------------------

func TestGetProfile_HappyPath_Anon_IsFollowingNull(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	// Two followers + one following for alice.
	seedFollow(t, pool, bob, alice)
	carol := seedUser(t, pool, "carol", "carol@example.com")
	seedFollow(t, pool, carol, alice)
	seedFollow(t, pool, alice, bob)

	seedAnime(t, pool, 1, "Anime One", "动画一", "https://img/1.jpg")
	seedSubscription(t, pool, alice, 1, 3, "watching", nil)

	req := reqWithUsername(http.MethodGet, "/api/users/alice", "", "alice")
	rec := httptest.NewRecorder()
	h.GetProfile(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	// isFollowing must be JSON null for anon caller (no auth).
	body := rec.Body.String()
	require.Contains(t, body, `"isFollowing":null`, "anon caller should produce isFollowing:null; got %s", body)
	require.Contains(t, body, `"followerCount":2`)
	require.Contains(t, body, `"followingCount":1`)
	require.Contains(t, body, `"username":"alice"`)
	require.Contains(t, body, `"subscriptionStatus":"watching"`)
	require.Contains(t, body, `"currentEpisode":3`)
	require.Contains(t, body, `"titleRomaji":"Anime One"`)
}

func TestGetProfile_HappyPath_AuthFollowingTrue(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedFollow(t, pool, bob, alice) // bob follows alice

	req := reqWithUsername(http.MethodGet, "/api/users/alice", "", "alice")
	req = withOptionalAuth(t, req, bob, "bob")
	// Re-inject chi route param since withOptionalAuth re-wraps the ctx.
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.GetProfile(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	body := rec.Body.String()
	require.Contains(t, body, `"isFollowing":true`, "auth'd follower → isFollowing:true; got %s", body)
}

func TestGetProfile_HappyPath_AuthFollowingFalse(t *testing.T) {
	h, pool := makeHandlers(t)
	seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	// bob is auth'd but does NOT follow alice.

	req := reqWithUsername(http.MethodGet, "/api/users/alice", "", "alice")
	req = withOptionalAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.GetProfile(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	require.Contains(t, rec.Body.String(), `"isFollowing":false`, "auth'd non-follower → isFollowing:false; got %s", rec.Body.String())
}

func TestGetProfile_UserNotFound_404(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithUsername(http.MethodGet, "/api/users/nope", "", "nope")
	rec := httptest.NewRecorder()
	h.GetProfile(rec, req)
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
}

func TestGetProfile_EmptyWatchingEmitsArray(t *testing.T) {
	h, pool := makeHandlers(t)
	seedUser(t, pool, "alice", "alice@example.com")
	// No subscriptions seeded.

	req := reqWithUsername(http.MethodGet, "/api/users/alice", "", "alice")
	rec := httptest.NewRecorder()
	h.GetProfile(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"watching":[]`, "empty watching should marshal to []; got %s", rec.Body.String())
}

func TestGetProfile_DBPoolClosed_500(t *testing.T) {
	h, pool := makeHandlers(t)
	seedUser(t, pool, "alice", "alice@example.com")
	// Close the pool to force a query error mid-handler.
	pool.Close()

	req := reqWithUsername(http.MethodGet, "/api/users/alice", "", "alice")
	rec := httptest.NewRecorder()
	h.GetProfile(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code, "closed-pool query should 500; body=%s", rec.Body.String())
}

// -----------------------------------------------------------------------------
// Follow / Unfollow
// -----------------------------------------------------------------------------

func TestFollow_HappyPath_201(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")

	req := reqWithUsername(http.MethodPost, "/api/users/alice/follow", "", "alice")
	req = withAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.Follow(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())
	assert.Equal(t, `{"data":{"following":true}}`, rec.Body.String())

	// Verify the row landed.
	var count int
	err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM follows WHERE follower_id=$1 AND followee_id=$2`,
		bob, alice,
	).Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, 1, count, "follows row should exist")
}

func TestFollow_Idempotent(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")

	for i := 0; i < 3; i++ {
		req := reqWithUsername(http.MethodPost, "/api/users/alice/follow", "", "alice")
		req = withAuth(t, req, bob, "bob")
		rc := chi.NewRouteContext()
		rc.URLParams.Add("username", "alice")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

		rec := httptest.NewRecorder()
		h.Follow(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code, "iter %d body=%s", i, rec.Body.String())
	}

	var count int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM follows WHERE follower_id=$1 AND followee_id=$2`,
		bob, alice,
	).Scan(&count))
	assert.Equal(t, 1, count, "ON CONFLICT DO NOTHING should keep row count at 1")
}

func TestFollow_SelfFollow_400(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")

	req := reqWithUsername(http.MethodPost, "/api/users/alice/follow", "", "alice")
	req = withAuth(t, req, alice, "alice")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.Follow(rec, req)

	assertErrorEnvelope(t, rec, http.StatusBadRequest, "INVALID_ACTION", "Cannot follow yourself")
}

func TestFollow_UserNotFound_404(t *testing.T) {
	h, pool := makeHandlers(t)
	bob := seedUser(t, pool, "bob", "bob@example.com")

	req := reqWithUsername(http.MethodPost, "/api/users/nope/follow", "", "nope")
	req = withAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", "nope")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.Follow(rec, req)

	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
}

func TestFollow_MissingClaims_500(t *testing.T) {
	h, pool := makeHandlers(t)
	seedUser(t, pool, "alice", "alice@example.com")

	// No auth wrapper — ClaimsFrom returns false → 500 SERVER_ERROR.
	req := reqWithUsername(http.MethodPost, "/api/users/alice/follow", "", "alice")
	rec := httptest.NewRecorder()
	h.Follow(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"SERVER_ERROR"`)
}

func TestUnfollow_HappyPath_200(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedFollow(t, pool, bob, alice)

	req := reqWithUsername(http.MethodDelete, "/api/users/alice/follow", "", "alice")
	req = withAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.Unfollow(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":{"following":false}}`, rec.Body.String())

	var count int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM follows WHERE follower_id=$1 AND followee_id=$2`,
		bob, alice,
	).Scan(&count))
	assert.Equal(t, 0, count, "follows row should be gone")
}

func TestUnfollow_NotFollowing_Still200(t *testing.T) {
	h, pool := makeHandlers(t)
	seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	// No follow seeded.

	req := reqWithUsername(http.MethodDelete, "/api/users/alice/follow", "", "alice")
	req = withAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", "alice")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.Unfollow(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "delete on nothing should still 200; body=%s", rec.Body.String())
	assert.Equal(t, `{"data":{"following":false}}`, rec.Body.String())
}

func TestUnfollow_UserNotFound_404(t *testing.T) {
	h, pool := makeHandlers(t)
	bob := seedUser(t, pool, "bob", "bob@example.com")

	req := reqWithUsername(http.MethodDelete, "/api/users/nope/follow", "", "nope")
	req = withAuth(t, req, bob, "bob")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("username", "nope")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.Unfollow(rec, req)

	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
}

func TestUnfollow_MissingClaims_500(t *testing.T) {
	h, pool := makeHandlers(t)
	seedUser(t, pool, "alice", "alice@example.com")

	req := reqWithUsername(http.MethodDelete, "/api/users/alice/follow", "", "alice")
	rec := httptest.NewRecorder()
	h.Unfollow(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"SERVER_ERROR"`)
}

// -----------------------------------------------------------------------------
// ListFollowers / ListFollowing
// -----------------------------------------------------------------------------

func TestListFollowers_HappyPath(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	carol := seedUser(t, pool, "carol", "carol@example.com")
	seedFollow(t, pool, bob, alice)
	seedFollow(t, pool, carol, alice)

	req := reqWithUsername(http.MethodGet, "/api/users/alice/followers", "", "alice")
	rec := httptest.NewRecorder()
	h.ListFollowers(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	body := rec.Body.String()
	require.Contains(t, body, `"total":2`)
	require.Contains(t, body, `"page":1`)
	require.Contains(t, body, `"hasMore":false`)
	require.Contains(t, body, `"nextPage":null`)
	// Both usernames present.
	require.Contains(t, body, `"bob"`)
	require.Contains(t, body, `"carol"`)
}

func TestListFollowers_Paginated_HasMore(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	// Seed 21 followers — listPageSize is 20, so page=1 hasMore=true.
	for i := 0; i < 21; i++ {
		u := seedUser(t, pool, fmt.Sprintf("follower%02d", i), fmt.Sprintf("follower%02d@example.com", i))
		seedFollow(t, pool, u, alice)
	}

	req := reqWithUsername(http.MethodGet, "/api/users/alice/followers?page=1", "", "alice")
	rec := httptest.NewRecorder()
	h.ListFollowers(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	body := rec.Body.String()
	require.Contains(t, body, `"total":21`)
	require.Contains(t, body, `"page":1`)
	require.Contains(t, body, `"hasMore":true`)
	require.Contains(t, body, `"nextPage":2`)

	// Page 2 has 1 item, hasMore false, nextPage null.
	req2 := reqWithUsername(http.MethodGet, "/api/users/alice/followers?page=2", "", "alice")
	rec2 := httptest.NewRecorder()
	h.ListFollowers(rec2, req2)

	require.Equal(t, http.StatusOK, rec2.Code)
	body2 := rec2.Body.String()
	require.Contains(t, body2, `"total":21`)
	require.Contains(t, body2, `"page":2`)
	require.Contains(t, body2, `"hasMore":false`)
	require.Contains(t, body2, `"nextPage":null`)
}

func TestListFollowers_NoFollowers_EmptyArray(t *testing.T) {
	h, pool := makeHandlers(t)
	seedUser(t, pool, "alice", "alice@example.com")

	req := reqWithUsername(http.MethodGet, "/api/users/alice/followers", "", "alice")
	rec := httptest.NewRecorder()
	h.ListFollowers(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `"data":[]`)
	require.Contains(t, body, `"total":0`)
	require.Contains(t, body, `"hasMore":false`)
	require.Contains(t, body, `"nextPage":null`)
}

func TestListFollowers_UserNotFound_404(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithUsername(http.MethodGet, "/api/users/nope/followers", "", "nope")
	rec := httptest.NewRecorder()
	h.ListFollowers(rec, req)
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
}

func TestListFollowing_HappyPath(t *testing.T) {
	h, pool := makeHandlers(t)
	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	carol := seedUser(t, pool, "carol", "carol@example.com")
	seedFollow(t, pool, alice, bob)
	seedFollow(t, pool, alice, carol)

	req := reqWithUsername(http.MethodGet, "/api/users/alice/following", "", "alice")
	rec := httptest.NewRecorder()
	h.ListFollowing(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	body := rec.Body.String()
	require.Contains(t, body, `"total":2`)
	require.Contains(t, body, `"page":1`)
	require.Contains(t, body, `"hasMore":false`)
	require.Contains(t, body, `"bob"`)
	require.Contains(t, body, `"carol"`)
}

func TestListFollowing_UserNotFound_404(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithUsername(http.MethodGet, "/api/users/nope/following", "", "nope")
	rec := httptest.NewRecorder()
	h.ListFollowing(rec, req)
	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", "User not found")
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
			t.Fatal("expected panic on nil SocialDB")
		}
	}()
	// We can't easily build a non-nil *pgxpool.Pool without a real DB,
	// but the nil-queries check fires before any pool dereference.
	pool := testutil.NewWebPool(t, context.Background(), pgURI)
	_ = NewHandlers(pool, nil)
}

func TestParsePage_Cases(t *testing.T) {
	t.Parallel()
	cases := []struct {
		query string
		want  int
	}{
		{"", 1},
		{"?page=", 1},
		{"?page=1", 1},
		{"?page=2", 2},
		{"?page=0", 1},
		{"?page=-5", 1},
		{"?page=abc", 1},
		{"?page=99", 99},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/x"+tc.query, nil)
		if got := parsePage(req); got != tc.want {
			t.Errorf("parsePage(%q) = %d, want %d", tc.query, got, tc.want)
		}
	}
}

func TestMapWatching_EmptyReturnsEmptySlice(t *testing.T) {
	t.Parallel()
	if got := mapWatching(nil); got == nil || len(got) != 0 {
		t.Errorf("mapWatching(nil) = %v, want []", got)
	}
}

func TestMapWatching_FieldRenames(t *testing.T) {
	t.Parallel()
	romaji := "Test Title"
	chinese := "测试"
	subscriptionStatus := "watching"
	animeStatus := "FINISHED"
	rows := []dbgen.ListProfileWatchingRow{
		{
			AnilistID:      42,
			Status:         subscriptionStatus,
			AnimeStatus:    &animeStatus,
			CurrentEpisode: 3,
			TitleRomaji:    &romaji,
			TitleChinese:   &chinese,
		},
	}
	got := mapWatching(rows)
	require.Len(t, got, 1)
	assert.Equal(t, subscriptionStatus, got[0].SubscriptionStatus, "row.Status → SubscriptionStatus")
	assert.NotNil(t, got[0].Status)
	assert.Equal(t, animeStatus, *got[0].Status, "row.AnimeStatus → Status")
	assert.Equal(t, int32(42), got[0].AnilistID)
	assert.Equal(t, int32(3), got[0].CurrentEpisode)

	// Round-trip the JSON to assert byte-level field names.
	raw, err := json.Marshal(got[0])
	require.NoError(t, err)
	s := string(raw)
	assert.Contains(t, s, `"subscriptionStatus":"watching"`, "renamed field key present")
	assert.Contains(t, s, `"status":"FINISHED"`, "anime status key present")
}

