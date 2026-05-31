package danmaku

// handlers_test.go — PG-backed tests for the one /api/danmaku endpoint.
//
// One Postgres testcontainer spins up via TestMain and is shared
// across every Test* in the package.  Per-test isolation comes from
// testutil.TruncateAll between tests.
//
// Tests cover:
//   - GetDanmaku:  happy / empty / chronological-ordering / bad params /
//                  no-window (liveEndsAt null) / with-window (ISO ts) /
//                  DB error / custom envelope shape.
//   - parseEpisodePath drive-through via the handler.
//   - writeDanmakuJSON byte-output (siblings of data ordering).
//   - mapDanmakuRows direct reversal-correctness check.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
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
		fmt.Fprintf(os.Stderr, "danmaku tests: setup postgres: %v\n", err)
		os.Exit(1)
	}
	defer cleanup()
	pgURI = uri
	os.Exit(m.Run())
}

func makeHandlers(t *testing.T) (*Handlers, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	queries := dbgen.New(pool)
	h := NewHandlers(pool, queries)
	return h, pool
}

// --- seed helpers -----------------------------------------------------------

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

func seedUser(t *testing.T, pool *pgxpool.Pool, username, email string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO users (username, email, password)
		VALUES ($1, $2, 'bcrypt-placeholder')
		RETURNING id`,
		username, email,
	).Scan(&id)
	require.NoError(t, err, "seedUser")
	return id
}

// seedDanmaku inserts a danmaku row with an explicit created_at so
// chronological order tests are deterministic.
func seedDanmaku(t *testing.T, pool *pgxpool.Pool, anilistID, episode int32, userID, username, content string, createdAt time.Time, liveEndsAt time.Time) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO danmakus (anilist_id, episode, user_id, username, content, live_ends_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		anilistID, episode, userID, username, content, liveEndsAt, createdAt,
	)
	require.NoError(t, err, "seedDanmaku")
}

// seedWindow inserts an episode_windows row with the given liveEndsAt.
func seedWindow(t *testing.T, pool *pgxpool.Pool, anilistID, episode int32, liveEndsAt time.Time) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO episode_windows (anilist_id, episode, live_ends_at)
		VALUES ($1, $2, $3)`,
		anilistID, episode, liveEndsAt,
	)
	require.NoError(t, err, "seedWindow")
}

// reqWithEpisode builds a request with chi URL params injected.
func reqWithEpisode(method, path, anilistID, episode string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", anilistID)
	rc.URLParams.Add("episode", episode)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
}

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
// GetDanmaku
// -----------------------------------------------------------------------------

func TestGetDanmaku_HappyPath_NoWindow(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	uid := seedUser(t, pool, "alice", "alice@example.com")

	now := time.Now().UTC().Truncate(time.Microsecond)
	liveEnd := now.Add(24 * time.Hour)
	// Seed three danmakus at distinct times.  Insert order is NOT
	// chronological — we rely on created_at to disambiguate.
	seedDanmaku(t, pool, 1, 1, uid, "alice", "second", now.Add(time.Second), liveEnd)
	seedDanmaku(t, pool, 1, 1, uid, "alice", "third", now.Add(2*time.Second), liveEnd)
	seedDanmaku(t, pool, 1, 1, uid, "alice", "first", now, liveEnd)

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/1", "1", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var env struct {
		Data       []map[string]any `json:"data"`
		LiveEndsAt *string          `json:"liveEndsAt"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Len(t, env.Data, 3, "expected 3 danmakus; body=%s", rec.Body.String())

	// Chronological order (oldest → newest) — the handler reverses
	// from DB DESC.
	assert.Equal(t, "first", env.Data[0]["content"])
	assert.Equal(t, "second", env.Data[1]["content"])
	assert.Equal(t, "third", env.Data[2]["content"])

	// No episode_windows row seeded → liveEndsAt should be null.
	assert.Nil(t, env.LiveEndsAt, "no window → liveEndsAt:null")
}

func TestGetDanmaku_WithWindow_EmitsTimestamp(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 42)
	uid := seedUser(t, pool, "alice", "alice@example.com")

	now := time.Now().UTC().Truncate(time.Microsecond)
	liveEnd := now.Add(24 * time.Hour)
	seedDanmaku(t, pool, 42, 7, uid, "alice", "hello", now, liveEnd)
	seedWindow(t, pool, 42, 7, liveEnd)

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/42/7", "42", "7")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var env struct {
		Data       []map[string]any `json:"data"`
		LiveEndsAt *string          `json:"liveEndsAt"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.NotNil(t, env.LiveEndsAt, "window seeded → liveEndsAt non-null; body=%s", rec.Body.String())

	parsed, err := time.Parse(time.RFC3339Nano, *env.LiveEndsAt)
	require.NoError(t, err, "liveEndsAt must be RFC3339")
	assert.WithinDuration(t, liveEnd, parsed, time.Millisecond, "liveEndsAt round-trips")
}

func TestGetDanmaku_EmptyArray(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/1", "1", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	// Express returns `[]` (not null) for empty — verify the exact byte
	// shape with liveEndsAt as a sibling, not nested.
	assert.Equal(t, `{"data":[],"liveEndsAt":null}`, rec.Body.String(),
		"empty + no-window envelope must be exactly this; body=%s", rec.Body.String())
}

func TestGetDanmaku_InvalidAnilistID(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithEpisode(http.MethodGet, "/api/danmaku/abc/1", "abc", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestGetDanmaku_InvalidEpisode(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/abc", "1", "abc")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestGetDanmaku_ZeroAnilistID(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithEpisode(http.MethodGet, "/api/danmaku/0/1", "0", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestGetDanmaku_NegativeEpisode(t *testing.T) {
	h, _ := makeHandlers(t)
	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/-3", "1", "-3")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)
	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid params")
}

func TestGetDanmaku_DBError_500(t *testing.T) {
	h, pool := makeHandlers(t)
	pool.Close()

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/1", "1", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"SERVER_ERROR"`)
}

// TestGetDanmaku_FieldShape verifies each danmakuItem has the exact
// fields and that liveEndsAt is a sibling of data (not nested).
func TestGetDanmaku_FieldShape(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	uid := seedUser(t, pool, "alice", "alice@example.com")

	now := time.Now().UTC().Truncate(time.Microsecond)
	liveEnd := now.Add(24 * time.Hour)
	seedDanmaku(t, pool, 1, 1, uid, "alice", "hi", now, liveEnd)

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/1", "1", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	// Top-level keys: data + liveEndsAt only.
	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
	_, hasData := raw["data"]
	_, hasLiveEnds := raw["liveEndsAt"]
	assert.True(t, hasData, "must have data key")
	assert.True(t, hasLiveEnds, "must have liveEndsAt key (sibling, not nested)")
	assert.Len(t, raw, 2, "envelope has exactly 2 top-level keys; got %v", raw)

	// Per-item keys: id, username, content, createdAt only.
	var items []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw["data"], &items))
	require.Len(t, items, 1)
	for _, key := range []string{"id", "username", "content", "createdAt"} {
		_, ok := items[0][key]
		assert.True(t, ok, "item missing %s", key)
	}
	// No leakage of internal fields (anilistId, episode, userId, etc.).
	for _, key := range []string{"anilistId", "episode", "userId", "liveEndsAt"} {
		_, ok := items[0][key]
		assert.False(t, ok, "item should not expose %s", key)
	}
}

// TestGetDanmaku_LimitAndReverse seeds 502 rows and verifies (a) the
// handler returns 500, (b) those are the 500 most-recent, (c) order is
// chronological ASC.
func TestGetDanmaku_LimitAndReverse(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, 1)
	uid := seedUser(t, pool, "alice", "alice@example.com")

	base := time.Now().UTC().Truncate(time.Microsecond)
	liveEnd := base.Add(24 * time.Hour)
	// Insert 502 rows; created_at goes from oldest=0..newest=501.
	for i := 0; i < 502; i++ {
		seedDanmaku(t, pool, 1, 1, uid, "alice",
			fmt.Sprintf("msg-%d", i),
			base.Add(time.Duration(i)*time.Millisecond),
			liveEnd)
	}

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/1", "1", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var env struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Len(t, env.Data, 500, "should cap at 500 rows")

	// Oldest of the returned 500 should be msg-2 (we dropped msg-0 and
	// msg-1 — the two oldest — because DB ORDER BY DESC + LIMIT 500
	// kept the 500 most-recent).
	assert.Equal(t, "msg-2", env.Data[0]["content"], "first should be msg-2 (oldest kept)")
	assert.Equal(t, "msg-501", env.Data[499]["content"], "last should be msg-501 (newest)")
}

// -----------------------------------------------------------------------------
// Helper unit tests
// -----------------------------------------------------------------------------

func TestMapDanmakuRows_Empty(t *testing.T) {
	t.Parallel()
	got := mapDanmakuRows(nil)
	if got == nil || len(got) != 0 {
		t.Errorf("mapDanmakuRows(nil) = %v, want []", got)
	}
	got2 := mapDanmakuRows([]dbgen.ListDanmakuRecentRow{})
	if got2 == nil || len(got2) != 0 {
		t.Errorf("mapDanmakuRows([]) = %v, want []", got2)
	}
}

func TestMapDanmakuRows_ReversesOrder(t *testing.T) {
	t.Parallel()
	rows := []dbgen.ListDanmakuRecentRow{
		{ID: 3, Username: "u", Content: "newest", CreatedAt: pgtype.Timestamptz{Time: time.Unix(3, 0), Valid: true}},
		{ID: 2, Username: "u", Content: "middle", CreatedAt: pgtype.Timestamptz{Time: time.Unix(2, 0), Valid: true}},
		{ID: 1, Username: "u", Content: "oldest", CreatedAt: pgtype.Timestamptz{Time: time.Unix(1, 0), Valid: true}},
	}
	got := mapDanmakuRows(rows)
	require.Len(t, got, 3)
	assert.Equal(t, "oldest", got[0].Content, "first should be oldest")
	assert.Equal(t, "middle", got[1].Content)
	assert.Equal(t, "newest", got[2].Content, "last should be newest")
}

func TestLiveEndsAtPtr_NoWin(t *testing.T) {
	t.Parallel()
	got := liveEndsAtPtr(false, dbgen.EpisodeWindow{})
	if got != nil {
		t.Errorf("hasWin=false → expected nil, got %v", got)
	}
}

func TestLiveEndsAtPtr_HasWinValid(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	w := dbgen.EpisodeWindow{LiveEndsAt: pgtype.Timestamptz{Time: now, Valid: true}}
	got := liveEndsAtPtr(true, w)
	require.NotNil(t, got)
	if !got.Equal(now) {
		t.Errorf("liveEndsAtPtr returned %v, want %v", *got, now)
	}
}

func TestLiveEndsAtPtr_HasWinInvalid(t *testing.T) {
	t.Parallel()
	w := dbgen.EpisodeWindow{LiveEndsAt: pgtype.Timestamptz{Valid: false}}
	got := liveEndsAtPtr(true, w)
	if got != nil {
		t.Errorf("hasWin but Valid=false → expected nil, got %v", got)
	}
}

func TestWriteDanmakuJSON_EmptyShape(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	writeDanmakuJSON(rec, http.StatusOK, danmakuResponse{
		Data:       []danmakuItem{},
		LiveEndsAt: nil,
	})
	want := `{"data":[],"liveEndsAt":null}`
	got := rec.Body.String()
	if got != want {
		t.Errorf("byte mismatch\n got: %s\nwant: %s", got, want)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want json", ct)
	}
}

func TestWriteDanmakuJSON_WithLiveEnds(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	ts := time.Date(2026, 5, 23, 12, 0, 0, 0, time.UTC)
	writeDanmakuJSON(rec, http.StatusOK, danmakuResponse{
		Data:       []danmakuItem{{ID: 1, Username: "u", Content: "hi", CreatedAt: ts}},
		LiveEndsAt: &ts,
	})
	// Order: data first, liveEndsAt second.  Item fields: id, username,
	// content, createdAt.
	body := rec.Body.String()
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"data":[`)) {
		t.Errorf("body missing data array; got %s", body)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"liveEndsAt":"2026-05-23T12:00:00Z"`)) {
		t.Errorf("body missing liveEndsAt sibling; got %s", body)
	}
	// Verify ordering: data must come before liveEndsAt.
	dataIdx := bytes.Index(rec.Body.Bytes(), []byte(`"data"`))
	liveIdx := bytes.Index(rec.Body.Bytes(), []byte(`"liveEndsAt"`))
	if dataIdx == -1 || liveIdx == -1 || dataIdx > liveIdx {
		t.Errorf("data must come before liveEndsAt; dataIdx=%d liveIdx=%d body=%s", dataIdx, liveIdx, body)
	}
}

// TestNewHandlers_NilPoolPanics + NilQueriesPanics — coverage for the
// boot-time fail-fast paths.
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
			t.Fatal("expected panic on nil DanmakuDB")
		}
	}()
	pool := testutil.NewWebPool(t, context.Background(), pgURI)
	_ = NewHandlers(pool, nil)
}

// -----------------------------------------------------------------------------
// fakeDB — exercise secondary DB-error paths
// -----------------------------------------------------------------------------

type fakeDB struct {
	listFn   func(ctx context.Context, anilistID, episode int32) ([]dbgen.ListDanmakuRecentRow, error)
	windowFn func(ctx context.Context, anilistID, episode int32) (dbgen.EpisodeWindow, error)
}

func (f *fakeDB) ListDanmakuRecent(ctx context.Context, anilistID, episode int32) ([]dbgen.ListDanmakuRecentRow, error) {
	if f.listFn == nil {
		panic("fakeDB.ListDanmakuRecent not set")
	}
	return f.listFn(ctx, anilistID, episode)
}

func (f *fakeDB) GetEpisodeWindow(ctx context.Context, anilistID, episode int32) (dbgen.EpisodeWindow, error) {
	if f.windowFn == nil {
		panic("fakeDB.GetEpisodeWindow not set")
	}
	return f.windowFn(ctx, anilistID, episode)
}

func stubHandlers(t *testing.T, db DanmakuDB) *Handlers {
	t.Helper()
	pool := testutil.NewWebPool(t, context.Background(), pgURI)
	return &Handlers{Pool: pool, Queries: db}
}

func TestGetDanmaku_ListError_500(t *testing.T) {
	db := &fakeDB{
		listFn: func(_ context.Context, _, _ int32) ([]dbgen.ListDanmakuRecentRow, error) {
			return nil, errors.New("connection refused")
		},
		windowFn: func(_ context.Context, _, _ int32) (dbgen.EpisodeWindow, error) {
			return dbgen.EpisodeWindow{}, pgx.ErrNoRows
		},
	}
	h := stubHandlers(t, db)

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/1", "1", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "body=%s", rec.Body.String())
}

func TestGetDanmaku_WindowError_500(t *testing.T) {
	db := &fakeDB{
		listFn: func(_ context.Context, _, _ int32) ([]dbgen.ListDanmakuRecentRow, error) {
			return []dbgen.ListDanmakuRecentRow{}, nil
		},
		windowFn: func(_ context.Context, _, _ int32) (dbgen.EpisodeWindow, error) {
			return dbgen.EpisodeWindow{}, errors.New("disk full")
		},
	}
	h := stubHandlers(t, db)

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/1", "1", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "body=%s", rec.Body.String())
}

// TestGetDanmaku_WindowErrNoRows_StillSuccess covers the explicit
// "no window for this episode" branch — handler must NOT 500 when the
// only error is ErrNoRows from GetEpisodeWindow.
func TestGetDanmaku_WindowErrNoRows_StillSuccess(t *testing.T) {
	db := &fakeDB{
		listFn: func(_ context.Context, _, _ int32) ([]dbgen.ListDanmakuRecentRow, error) {
			return []dbgen.ListDanmakuRecentRow{}, nil
		},
		windowFn: func(_ context.Context, _, _ int32) (dbgen.EpisodeWindow, error) {
			return dbgen.EpisodeWindow{}, pgx.ErrNoRows
		},
	}
	h := stubHandlers(t, db)

	req := reqWithEpisode(http.MethodGet, "/api/danmaku/1/1", "1", "1")
	rec := httptest.NewRecorder()
	h.GetDanmaku(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.Equal(t, `{"data":[],"liveEndsAt":null}`, rec.Body.String())
}
