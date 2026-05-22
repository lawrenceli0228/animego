package admin

// handlers_test.go — DB-backed tests for the three read handlers.
//
// One Postgres testcontainer spins up via TestMain and is shared
// across every Test* in the package.  Per-test isolation comes from
// testutil.TruncateAll between tests.
//
// We test:
//   - GetStats happy path + sub-failure of QueueStatus + nil QueueStatus.
//   - ListEnrichment for each filter + q + sort + order branch.
//   - ListUsers for filter on/off + the sub/follower count merge.
//
// The seed helpers below produce the minimum rows each test needs;
// they're intentionally simple (no test-data factory framework) so
// the test code reads like the SQL it exercises.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
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
		fmt.Fprintf(os.Stderr, "admin tests: setup postgres: %v\n", err)
		os.Exit(1)
	}
	defer cleanup()
	pgURI = uri
	os.Exit(m.Run())
}

// makeHandlers spins a fresh pool + Handlers for one test.  Pool is
// closed via t.Cleanup so test parallelism doesn't accumulate leaked
// pools.  The Handlers' QueueStatus is left nil — individual tests
// that exercise the stats path set it explicitly.
func makeHandlers(t *testing.T) (*Handlers, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	queries := dbgen.New(pool)
	h := NewHandlers(pool, queries, nil, nil)
	return h, pool
}

// withQueueStatus returns h with QueueStatus replaced.  Helper so
// tests don't reach into the struct directly.
func withQueueStatus(h *Handlers, fn QueueStatusFn) *Handlers {
	h.QueueStatus = fn
	return h
}

// --- Seed helpers -----------------------------------------------------------

// seedUser inserts one users row; returns the generated uuid.
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

// seedUserAt inserts a users row with an explicit created_at so tests
// can verify the created_at DESC ordering.
func seedUserAt(t *testing.T, pool *pgxpool.Pool, username, email string, createdAt time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO users (username, email, password, created_at, updated_at)
		VALUES ($1, $2, 'bcrypt-placeholder', $3, $3)
		RETURNING id`,
		username, email, createdAt,
	).Scan(&id)
	require.NoError(t, err, "seedUserAt")
	return id
}

// seedAnime inserts one anime_cache row.  All fields default-NULL
// unless passed explicitly via the params struct.
type animeSeed struct {
	AnilistID      int32
	TitleRomaji    string
	TitleChinese   string
	TitleNative    string
	BgmID          *int32
	BangumiVersion int32
	BangumiScore   *float64
	AdminFlag      *string
	CachedAt       *time.Time
}

func seedAnime(t *testing.T, pool *pgxpool.Pool, a animeSeed) {
	t.Helper()
	ctx := context.Background()

	// Build params with NULLs where empty.
	var romaji, chinese, native *string
	if a.TitleRomaji != "" {
		romaji = &a.TitleRomaji
	}
	if a.TitleChinese != "" {
		chinese = &a.TitleChinese
	}
	if a.TitleNative != "" {
		native = &a.TitleNative
	}

	cached := time.Now().UTC()
	if a.CachedAt != nil {
		cached = *a.CachedAt
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (
			anilist_id, title_romaji, title_chinese, title_native,
			bgm_id, bangumi_version, bangumi_score, admin_flag, cached_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		a.AnilistID, romaji, chinese, native,
		a.BgmID, a.BangumiVersion, a.BangumiScore, a.AdminFlag, cached,
	)
	require.NoError(t, err, "seedAnime")
}

// seedSubscription inserts a watching-status sub.
func seedSubscription(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO subscriptions (user_id, anilist_id, status)
		VALUES ($1, $2, 'watching')`,
		userID, anilistID,
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

// --- GetStats ---------------------------------------------------------------

func TestGetStats_AllZero_WhenSchemaEmpty(t *testing.T) {
	h, _ := makeHandlers(t)

	rec := httptest.NewRecorder()
	h.GetStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil))

	require.Equal(t, http.StatusOK, rec.Code)

	var got struct {
		Data statsData `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, int64(0), got.Data.Users)
	assert.Equal(t, int64(0), got.Data.Anime)
	assert.Equal(t, statsEnrichment{}, got.Data.Enrichment)
	assert.Equal(t, QueueSnapshot{}, got.Data.Queue)
}

func TestGetStats_AggregatesRows(t *testing.T) {
	h, pool := makeHandlers(t)

	// 3 users, 5 anime (3 different bangumi versions), 2 subs, 1 follow,
	// 1 no-cn, 1 flagged.
	u1 := seedUser(t, pool, "alice", "alice@example.com")
	u2 := seedUser(t, pool, "bob", "bob@example.com")
	seedUser(t, pool, "carol", "carol@example.com")

	flag := "needs-review"
	bgm := int32(99)
	seedAnime(t, pool, animeSeed{AnilistID: 1, TitleRomaji: "A", BangumiVersion: 0})
	seedAnime(t, pool, animeSeed{AnilistID: 2, TitleRomaji: "B", BangumiVersion: 1})
	seedAnime(t, pool, animeSeed{AnilistID: 3, TitleRomaji: "C", BangumiVersion: 2})
	seedAnime(t, pool, animeSeed{AnilistID: 4, TitleRomaji: "D", BangumiVersion: 2, BgmID: &bgm}) // no-cn (bgm set, no chinese)
	seedAnime(t, pool, animeSeed{AnilistID: 5, TitleRomaji: "E", BangumiVersion: 0, AdminFlag: &flag})

	seedSubscription(t, pool, u1, 1)
	seedSubscription(t, pool, u2, 1)
	seedFollow(t, pool, u1, u2)

	rec := httptest.NewRecorder()
	h.GetStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()

	// Byte-exact field order check:  users, anime, enrichment, queue,
	// flagged, subscriptions, follows.  Express controllers/admin.controller.js:36-44.
	usersIdx := strings.Index(body, `"users":`)
	animeIdx := strings.Index(body, `"anime":`)
	enrIdx := strings.Index(body, `"enrichment":`)
	queueIdx := strings.Index(body, `"queue":`)
	flaggedIdx := strings.Index(body, `"flagged":`)
	subsIdx := strings.Index(body, `"subscriptions":`)
	followsIdx := strings.Index(body, `"follows":`)
	require.True(t, usersIdx < animeIdx && animeIdx < enrIdx && enrIdx < queueIdx && queueIdx < flaggedIdx && flaggedIdx < subsIdx && subsIdx < followsIdx,
		"top-level field order mismatch: %s", body)

	// Counter values.
	var got struct {
		Data statsData `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, int64(3), got.Data.Users)
	assert.Equal(t, int64(5), got.Data.Anime)
	assert.Equal(t, int64(2), got.Data.Enrichment.V0)
	assert.Equal(t, int64(1), got.Data.Enrichment.V1)
	assert.Equal(t, int64(2), got.Data.Enrichment.V2)
	assert.Equal(t, int64(0), got.Data.Enrichment.V3)
	assert.Equal(t, int64(1), got.Data.Enrichment.NoCn)
	assert.Equal(t, int64(1), got.Data.Flagged)
	assert.Equal(t, int64(2), got.Data.Subscriptions)
	assert.Equal(t, int64(1), got.Data.Follows)
}

func TestGetStats_QueueStatusInjected(t *testing.T) {
	h, _ := makeHandlers(t)

	called := 0
	progress := V3BatchProgress{Total: 100, Processed: 42, Healed: 30, Paused: false}
	withQueueStatus(h, func(_ context.Context) (QueueSnapshot, error) {
		called++
		return QueueSnapshot{
			Phase1:     5,
			Phase4:     2,
			V3:         77,
			V3Progress: &progress,
		}, nil
	})

	rec := httptest.NewRecorder()
	h.GetStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, called, "QueueStatus should be invoked exactly once")

	var got struct {
		Data statsData `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, int64(5), got.Data.Queue.Phase1)
	assert.Equal(t, int64(2), got.Data.Queue.Phase4)
	assert.Equal(t, int64(77), got.Data.Queue.V3)
	require.NotNil(t, got.Data.Queue.V3Progress)
	assert.Equal(t, int64(100), got.Data.Queue.V3Progress.Total)
	assert.Equal(t, int64(42), got.Data.Queue.V3Progress.Processed)
}

func TestGetStats_QueueStatusError_EmitsZeroAnd200(t *testing.T) {
	h, _ := makeHandlers(t)

	withQueueStatus(h, func(_ context.Context) (QueueSnapshot, error) {
		return QueueSnapshot{Phase1: 999}, errors.New("simulated river hiccup")
	})

	rec := httptest.NewRecorder()
	h.GetStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil))

	require.Equal(t, http.StatusOK, rec.Code, "queue error must not block the response")

	body := rec.Body.String()
	// Queue object present and shaped — but the counter we returned
	// in the error payload is discarded, so phase1 must be 0.
	assert.Contains(t, body, `"queue":{"phase1":0,"phase4":0,"v3":0,"v3Progress":null}`)
}

func TestGetStats_QueueStatusNil_EmitsZero(t *testing.T) {
	// makeHandlers leaves QueueStatus nil by default.
	h, _ := makeHandlers(t)

	rec := httptest.NewRecorder()
	h.GetStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"queue":{"phase1":0,"phase4":0,"v3":0,"v3Progress":null}`)
}

func TestGetStats_DBError_500(t *testing.T) {
	// Substitute a querier whose GetAdminStats always fails.
	h, pool := makeHandlers(t)
	_ = pool

	h.Queries = &failingQuerier{}

	rec := httptest.NewRecorder()
	h.GetStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

// failingQuerier returns an error from every method.  Used by the
// stats DB-error path.
type failingQuerier struct{}

func (failingQuerier) GetAdminStats(_ context.Context) (dbgen.GetAdminStatsRow, error) {
	return dbgen.GetAdminStatsRow{}, errors.New("simulated stats query failure")
}

func (failingQuerier) GetAdminUserSubFollowCounts(_ context.Context, _ []uuid.UUID) ([]dbgen.GetAdminUserSubFollowCountsRow, error) {
	return nil, errors.New("simulated sub/follow query failure")
}

// --- ListEnrichment ---------------------------------------------------------

func TestListEnrichment_EmptyResult(t *testing.T) {
	h, _ := makeHandlers(t)

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	assert.Equal(t, []enrichmentItem{}, got.Data)
	assert.Equal(t, int64(0), got.Total)
	assert.Equal(t, 1, got.Page)
	assert.False(t, got.HasMore)
}

func TestListEnrichment_EnvelopeFieldOrder(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, animeSeed{AnilistID: 1, TitleRomaji: "Test"})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	dataIdx := strings.Index(body, `"data":`)
	hasMoreIdx := strings.Index(body, `"hasMore":`)
	totalIdx := strings.Index(body, `"total":`)
	pageIdx := strings.Index(body, `"page":`)
	require.True(t, dataIdx < hasMoreIdx && hasMoreIdx < totalIdx && totalIdx < pageIdx,
		"field order data,hasMore,total,page violated: %s", body)
	assert.NotContains(t, body, `"nextPage"`, "Express does not emit nextPage on this endpoint")
}

func TestListEnrichment_FilterNeedsReview(t *testing.T) {
	h, pool := makeHandlers(t)

	flagged := "needs-review"
	corrected := "manually-corrected"
	seedAnime(t, pool, animeSeed{AnilistID: 1, TitleRomaji: "Flagged", AdminFlag: &flagged})
	seedAnime(t, pool, animeSeed{AnilistID: 2, TitleRomaji: "Corrected", AdminFlag: &corrected})
	seedAnime(t, pool, animeSeed{AnilistID: 3, TitleRomaji: "Plain"})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?filter=needs-review", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1)
	assert.Equal(t, int32(1), got.Data[0].AnilistID)
	assert.Equal(t, int64(1), got.Total)
}

func TestListEnrichment_FilterManuallyCorrected(t *testing.T) {
	h, pool := makeHandlers(t)

	corrected := "manually-corrected"
	seedAnime(t, pool, animeSeed{AnilistID: 10, AdminFlag: &corrected})
	seedAnime(t, pool, animeSeed{AnilistID: 11})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?filter=manually-corrected", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1)
	assert.Equal(t, int32(10), got.Data[0].AnilistID)
}

func TestListEnrichment_FilterUnenriched(t *testing.T) {
	h, pool := makeHandlers(t)

	seedAnime(t, pool, animeSeed{AnilistID: 1, BangumiVersion: 0})
	seedAnime(t, pool, animeSeed{AnilistID: 2, BangumiVersion: 1})
	seedAnime(t, pool, animeSeed{AnilistID: 3, BangumiVersion: 0})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?filter=unenriched", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 2)
}

func TestListEnrichment_FilterNoCN(t *testing.T) {
	h, pool := makeHandlers(t)

	bgm := int32(1234)
	seedAnime(t, pool, animeSeed{AnilistID: 1, BgmID: &bgm, TitleChinese: "已存在"})
	seedAnime(t, pool, animeSeed{AnilistID: 2, BgmID: &bgm}) // matches: bgm set, no Chinese
	seedAnime(t, pool, animeSeed{AnilistID: 3})              // no bgm

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?filter=no-cn", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1)
	assert.Equal(t, int32(2), got.Data[0].AnilistID)
}

func TestListEnrichment_FilterUnknown_NoFilter(t *testing.T) {
	h, pool := makeHandlers(t)
	seedAnime(t, pool, animeSeed{AnilistID: 1, TitleRomaji: "A"})
	seedAnime(t, pool, animeSeed{AnilistID: 2, TitleRomaji: "B"})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?filter=bogus", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	assert.Len(t, got.Data, 2)
}

func TestListEnrichment_QueryByAnilistID(t *testing.T) {
	h, pool := makeHandlers(t)

	seedAnime(t, pool, animeSeed{AnilistID: 12345, TitleRomaji: "Match"})
	seedAnime(t, pool, animeSeed{AnilistID: 67890, TitleRomaji: "Other"})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?q=12345", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1)
	assert.Equal(t, int32(12345), got.Data[0].AnilistID)
}

func TestListEnrichment_QueryByText_ILIKE(t *testing.T) {
	h, pool := makeHandlers(t)

	seedAnime(t, pool, animeSeed{AnilistID: 1, TitleRomaji: "Attack on Titan", TitleChinese: "进击的巨人"})
	seedAnime(t, pool, animeSeed{AnilistID: 2, TitleRomaji: "Naruto"})
	seedAnime(t, pool, animeSeed{AnilistID: 3, TitleNative: "進撃の巨人"})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?q=titan", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1)
	assert.Equal(t, int32(1), got.Data[0].AnilistID)
}

func TestListEnrichment_QueryByChineseTitle(t *testing.T) {
	h, pool := makeHandlers(t)

	seedAnime(t, pool, animeSeed{AnilistID: 1, TitleChinese: "进击的巨人"})
	seedAnime(t, pool, animeSeed{AnilistID: 2, TitleChinese: "鬼灭之刃"})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?q=进击", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1)
	assert.Equal(t, int32(1), got.Data[0].AnilistID)
}

func TestListEnrichment_QueryLeadingZeroFallsToILIKE(t *testing.T) {
	h, pool := makeHandlers(t)

	// "01" is NOT a strict integer ("01" != "1") so we should ILIKE.
	seedAnime(t, pool, animeSeed{AnilistID: 1, TitleRomaji: "01 prefix match"})
	seedAnime(t, pool, animeSeed{AnilistID: 2, TitleRomaji: "no match"})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?q=01", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1, "only the row with '01' in romaji should match")
	assert.Equal(t, int32(1), got.Data[0].AnilistID)
}

func TestListEnrichment_SortAnilistAsc(t *testing.T) {
	h, pool := makeHandlers(t)

	seedAnime(t, pool, animeSeed{AnilistID: 3})
	seedAnime(t, pool, animeSeed{AnilistID: 1})
	seedAnime(t, pool, animeSeed{AnilistID: 2})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?sort=anilist_id&order=asc", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 3)
	assert.Equal(t, int32(1), got.Data[0].AnilistID)
	assert.Equal(t, int32(2), got.Data[1].AnilistID)
	assert.Equal(t, int32(3), got.Data[2].AnilistID)
}

func TestListEnrichment_SortCachedAtDescDefault(t *testing.T) {
	h, pool := makeHandlers(t)

	t0 := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 := time.Date(2025, 5, 1, 0, 0, 0, 0, time.UTC)
	t2 := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)

	seedAnime(t, pool, animeSeed{AnilistID: 1, CachedAt: &t0})
	seedAnime(t, pool, animeSeed{AnilistID: 2, CachedAt: &t2})
	seedAnime(t, pool, animeSeed{AnilistID: 3, CachedAt: &t1})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 3)
	assert.Equal(t, int32(2), got.Data[0].AnilistID, "newest first")
	assert.Equal(t, int32(3), got.Data[1].AnilistID)
	assert.Equal(t, int32(1), got.Data[2].AnilistID, "oldest last")
}

func TestListEnrichment_SortCachedAtAliasCamelCase(t *testing.T) {
	h, pool := makeHandlers(t)

	t0 := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 := time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC)
	seedAnime(t, pool, animeSeed{AnilistID: 1, CachedAt: &t0})
	seedAnime(t, pool, animeSeed{AnilistID: 2, CachedAt: &t1})

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?sort=cachedAt&order=asc", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeEnrichmentList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 2)
	assert.Equal(t, int32(1), got.Data[0].AnilistID, "ascending by cached_at via camelCase alias")
	assert.Equal(t, int32(2), got.Data[1].AnilistID)
}

func TestListEnrichment_Pagination(t *testing.T) {
	h, pool := makeHandlers(t)

	// 35 rows → page 1: 30 items hasMore=true, page 2: 5 items hasMore=false.
	for i := 1; i <= 35; i++ {
		seedAnime(t, pool, animeSeed{AnilistID: int32(i), TitleRomaji: "Item " + strconv.Itoa(i)})
	}

	rec1 := httptest.NewRecorder()
	h.ListEnrichment(rec1, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?sort=anilist_id&order=asc", nil))
	got1 := decodeEnrichmentList(t, rec1.Body.Bytes())
	assert.Len(t, got1.Data, 30)
	assert.True(t, got1.HasMore)
	assert.Equal(t, int64(35), got1.Total)
	assert.Equal(t, 1, got1.Page)

	rec2 := httptest.NewRecorder()
	h.ListEnrichment(rec2, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment?page=2&sort=anilist_id&order=asc", nil))
	got2 := decodeEnrichmentList(t, rec2.Body.Bytes())
	assert.Len(t, got2.Data, 5)
	assert.False(t, got2.HasMore)
	assert.Equal(t, 2, got2.Page)
}

func TestListEnrichment_DBError_500(t *testing.T) {
	h, _ := makeHandlers(t)
	// Close the pool to force the next query to fail.
	h.Pool.Close()

	rec := httptest.NewRecorder()
	h.ListEnrichment(rec, httptest.NewRequest(http.MethodGet, "/api/admin/enrichment", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

// --- ListUsers --------------------------------------------------------------

func TestListUsers_EmptyResult(t *testing.T) {
	h, _ := makeHandlers(t)

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeUserList(t, rec.Body.Bytes())
	assert.Equal(t, []userItem{}, got.Data)
	assert.Equal(t, int64(0), got.Total)
	assert.False(t, got.HasMore)
}

func TestListUsers_EnvelopeFieldOrder(t *testing.T) {
	h, pool := makeHandlers(t)
	seedUser(t, pool, "alice", "alice@example.com")

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	dataIdx := strings.Index(body, `"data":`)
	hasMoreIdx := strings.Index(body, `"hasMore":`)
	totalIdx := strings.Index(body, `"total":`)
	pageIdx := strings.Index(body, `"page":`)
	require.True(t, dataIdx < hasMoreIdx && hasMoreIdx < totalIdx && totalIdx < pageIdx,
		"field order data,hasMore,total,page violated: %s", body)
	assert.NotContains(t, body, `"nextPage"`)

	// _id (Express-style) must appear; "id" only as inside _id.
	assert.Contains(t, body, `"_id":`)
}

func TestListUsers_MergesCounts(t *testing.T) {
	h, pool := makeHandlers(t)

	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	carol := seedUser(t, pool, "carol", "carol@example.com")

	// alice has 2 subs, 1 follower; bob has 1 sub, 0 followers; carol has 0/2.
	seedAnime(t, pool, animeSeed{AnilistID: 1})
	seedAnime(t, pool, animeSeed{AnilistID: 2})
	seedSubscription(t, pool, alice, 1)
	seedSubscription(t, pool, alice, 2)
	seedSubscription(t, pool, bob, 1)
	seedFollow(t, pool, bob, alice)    // alice has 1 follower
	seedFollow(t, pool, alice, carol)  // carol has 1 follower
	seedFollow(t, pool, bob, carol)    // carol has 2 followers total

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeUserList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 3)

	byID := make(map[uuid.UUID]userItem, len(got.Data))
	for _, u := range got.Data {
		byID[u.ID] = u
	}

	require.Contains(t, byID, alice)
	assert.Equal(t, int64(2), byID[alice].Subscriptions)
	assert.Equal(t, int64(1), byID[alice].Followers)

	require.Contains(t, byID, bob)
	assert.Equal(t, int64(1), byID[bob].Subscriptions)
	assert.Equal(t, int64(0), byID[bob].Followers)

	require.Contains(t, byID, carol)
	assert.Equal(t, int64(0), byID[carol].Subscriptions)
	assert.Equal(t, int64(2), byID[carol].Followers)
}

func TestListUsers_QueryFilter_ByUsername(t *testing.T) {
	h, pool := makeHandlers(t)

	seedUser(t, pool, "alice", "alice@example.com")
	seedUser(t, pool, "bobby", "bobby@example.com")
	seedUser(t, pool, "carol", "carol@example.com")

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users?q=bob", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeUserList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1)
	assert.Equal(t, "bobby", got.Data[0].Username)
}

func TestListUsers_QueryFilter_ByEmail(t *testing.T) {
	h, pool := makeHandlers(t)

	seedUser(t, pool, "alice", "alice@example.com")
	seedUser(t, pool, "bobby", "bobby@gmail.com")
	seedUser(t, pool, "carol", "carol@example.com")

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users?q=gmail", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeUserList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 1)
	assert.Equal(t, "bobby", got.Data[0].Username)
}

func TestListUsers_CreatedAtDescOrder(t *testing.T) {
	h, pool := makeHandlers(t)

	t0 := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 := time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC)
	t2 := time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC)
	seedUserAt(t, pool, "oldest", "old@example.com", t0)
	seedUserAt(t, pool, "newest", "new@example.com", t2)
	seedUserAt(t, pool, "middle", "mid@example.com", t1)

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeUserList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 3)
	assert.Equal(t, "newest", got.Data[0].Username)
	assert.Equal(t, "middle", got.Data[1].Username)
	assert.Equal(t, "oldest", got.Data[2].Username)
}

func TestListUsers_Pagination(t *testing.T) {
	h, pool := makeHandlers(t)

	for i := 0; i < 35; i++ {
		// Use staggered created_at so order is deterministic across the page boundary.
		ts := time.Date(2025, 1, 1+i, 0, 0, 0, 0, time.UTC)
		seedUserAt(t, pool, fmt.Sprintf("user%02d", i), fmt.Sprintf("u%02d@example.com", i), ts)
	}

	rec1 := httptest.NewRecorder()
	h.ListUsers(rec1, httptest.NewRequest(http.MethodGet, "/api/admin/users", nil))
	got1 := decodeUserList(t, rec1.Body.Bytes())
	assert.Len(t, got1.Data, 30)
	assert.True(t, got1.HasMore)
	assert.Equal(t, int64(35), got1.Total)

	rec2 := httptest.NewRecorder()
	h.ListUsers(rec2, httptest.NewRequest(http.MethodGet, "/api/admin/users?page=2", nil))
	got2 := decodeUserList(t, rec2.Body.Bytes())
	assert.Len(t, got2.Data, 5)
	assert.False(t, got2.HasMore)
}

func TestListUsers_DBError_500_PoolClosed(t *testing.T) {
	h, _ := makeHandlers(t)
	h.Pool.Close()

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users", nil))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

func TestListUsers_RolesPassThroughNullable(t *testing.T) {
	h, pool := makeHandlers(t)

	// admin
	var adminID uuid.UUID
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO users (username, email, password, role)
		VALUES ('root', 'root@example.com', 'x', 'admin')
		RETURNING id`,
	).Scan(&adminID))

	// regular user (role = NULL)
	seedUser(t, pool, "regular", "regular@example.com")

	rec := httptest.NewRecorder()
	h.ListUsers(rec, httptest.NewRequest(http.MethodGet, "/api/admin/users", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeUserList(t, rec.Body.Bytes())
	require.Len(t, got.Data, 2)

	// Body must contain "role":null for the regular user and "role":"admin" for root.
	body := rec.Body.String()
	assert.Contains(t, body, `"role":null`)
	assert.Contains(t, body, `"role":"admin"`)
}

// --- NewHandlers nil validator fallback ------------------------------------

func TestNewHandlers_NilValidator_DefaultInstance(t *testing.T) {
	h := NewHandlers(nil, nil, nil, nil)
	assert.NotNil(t, h.Validate)
}

// --- helpers ----------------------------------------------------------------

func decodeEnrichmentList(t *testing.T, body []byte) enrichmentListResponse {
	t.Helper()
	var got enrichmentListResponse
	require.NoError(t, json.Unmarshal(body, &got))
	return got
}

func decodeUserList(t *testing.T, body []byte) userListResponse {
	t.Helper()
	var got userListResponse
	require.NoError(t, json.Unmarshal(body, &got))
	return got
}
