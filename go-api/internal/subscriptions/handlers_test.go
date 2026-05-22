package subscriptions

// handlers_test.go — table-driven coverage of the five /api/subscriptions
// endpoints.
//
// Test strategy:
//   - Validation, error-mapping, and most happy-path responses go
//     through a fakeSubsDB (function-pointer mock) so each test owns its
//     fixtures + is fast.
//   - SQL behaviour (UPSERT idempotence, score CASE/COALESCE, FK
//     cascade, ORDER BY updated_at DESC) goes through a shared
//     testcontainer Postgres set up in TestMain.  See pgURI + pgHandlers.
//
// All tests run with t.Parallel() where they don't share mutable
// global state.  The PG-backed tests TruncateAll on entry, so they're
// safe to run concurrently — each acquires its own pool from the same
// container.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/anime"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// pgURI is populated by TestMain.  All PG-backed tests open their own
// pool against it.
var pgURI string

func TestMain(m *testing.M) {
	ctx := context.Background()
	uri, cleanup, err := testutil.SetupPGForMain(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "subscriptions tests: setup postgres: %v\n", err)
		os.Exit(1)
	}
	defer cleanup()
	pgURI = uri
	os.Exit(m.Run())
}

// -----------------------------------------------------------------------------
// fakes
// -----------------------------------------------------------------------------

// fakeSubsDB is a function-pointer mock matching SubscriptionsDB.
// Per-test setup overrides only the fields it cares about; unset fields
// panic on call so missing wiring surfaces immediately.
type fakeSubsDB struct {
	mu sync.Mutex

	listFn   func(ctx context.Context, userID uuid.UUID, statusFilter *string) ([]dbgen.ListUserSubscriptionsRow, error)
	getFn    func(ctx context.Context, userID uuid.UUID, anilistID int32) (dbgen.Subscription, error)
	upsertFn func(ctx context.Context, userID uuid.UUID, anilistID int32, status string) (dbgen.Subscription, error)
	updateFn func(ctx context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error)
	deleteFn func(ctx context.Context, userID uuid.UUID, anilistID int32) (int64, error)

	listCalls   int32
	getCalls    int32
	upsertCalls int32
	updateCalls int32
	deleteCalls int32
}

func (f *fakeSubsDB) ListUserSubscriptions(ctx context.Context, userID uuid.UUID, statusFilter *string) ([]dbgen.ListUserSubscriptionsRow, error) {
	atomic.AddInt32(&f.listCalls, 1)
	if f.listFn == nil {
		panic("fakeSubsDB.ListUserSubscriptions not set")
	}
	return f.listFn(ctx, userID, statusFilter)
}

func (f *fakeSubsDB) GetSubscription(ctx context.Context, userID uuid.UUID, anilistID int32) (dbgen.Subscription, error) {
	atomic.AddInt32(&f.getCalls, 1)
	if f.getFn == nil {
		panic("fakeSubsDB.GetSubscription not set")
	}
	return f.getFn(ctx, userID, anilistID)
}

func (f *fakeSubsDB) UpsertSubscription(ctx context.Context, userID uuid.UUID, anilistID int32, status string) (dbgen.Subscription, error) {
	atomic.AddInt32(&f.upsertCalls, 1)
	if f.upsertFn == nil {
		panic("fakeSubsDB.UpsertSubscription not set")
	}
	return f.upsertFn(ctx, userID, anilistID, status)
}

func (f *fakeSubsDB) UpdateSubscription(ctx context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
	atomic.AddInt32(&f.updateCalls, 1)
	if f.updateFn == nil {
		panic("fakeSubsDB.UpdateSubscription not set")
	}
	return f.updateFn(ctx, arg)
}

func (f *fakeSubsDB) DeleteSubscription(ctx context.Context, userID uuid.UUID, anilistID int32) (int64, error) {
	atomic.AddInt32(&f.deleteCalls, 1)
	if f.deleteFn == nil {
		panic("fakeSubsDB.DeleteSubscription not set")
	}
	return f.deleteFn(ctx, userID, anilistID)
}

// fakeEnsureCachedDB satisfies anime.EnsureCachedDB with function
// pointers.  Used to drive the CreateSubscription anime-cache probe +
// upsert path in fake-DB tests.
type fakeEnsureCachedDB struct {
	getFn    func(ctx context.Context, anilistID int32) (dbgen.GetAnimeMainByIDRow, error)
	upsertFn func(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error
}

func (f *fakeEnsureCachedDB) GetAnimeMainByID(ctx context.Context, anilistID int32) (dbgen.GetAnimeMainByIDRow, error) {
	if f.getFn == nil {
		panic("fakeEnsureCachedDB.GetAnimeMainByID not set")
	}
	return f.getFn(ctx, anilistID)
}

func (f *fakeEnsureCachedDB) UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error {
	if f.upsertFn == nil {
		return nil // default no-op
	}
	return f.upsertFn(ctx, arg)
}

// fakeAnilist satisfies anime.AniListDetailFetcher.
type fakeAnilist struct {
	detailFn func(ctx context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error)
}

func (f *fakeAnilist) Detail(ctx context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
	if f.detailFn == nil {
		panic("fakeAnilist.Detail not set")
	}
	return f.detailFn(ctx, v)
}

// makeHandlersWithFakes builds Handlers with the supplied fakes + a
// fresh validator.  Pool is left nil — none of the handlers exercise it
// directly (Queries / AnimeDB / AnilistClient cover every code path).
func makeHandlersWithFakes(subsDB SubscriptionsDB, animeDB anime.EnsureCachedDB, ac anime.AniListDetailFetcher) *Handlers {
	if animeDB == nil {
		animeDB = &fakeEnsureCachedDB{
			getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
				return dbgen.GetAnimeMainByIDRow{AnilistID: 1}, nil // cache hit
			},
		}
	}
	if ac == nil {
		ac = &fakeAnilist{
			detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
				return &anilist.AnimeDetailResponse{}, nil
			},
		}
	}
	return NewHandlers(nil, subsDB, animeDB, ac, validator.New(validator.WithRequiredStructEnabled()))
}

// -----------------------------------------------------------------------------
// auth + request helpers
// -----------------------------------------------------------------------------

// withUserClaims signs an access token and runs it through
// jwtx.RequireAuth so the resulting context carries a real
// *AccessClaims under the unexported claimsKey.
func withUserClaims(t *testing.T, ctx context.Context, userID uuid.UUID, username string) context.Context {
	t.Helper()
	signer, err := jwtx.NewSigner("test-access-secret", "test-refresh-secret", 15*time.Minute, time.Hour)
	require.NoError(t, err, "NewSigner")
	tok, err := signer.SignAccess(userID, username, nil)
	require.NoError(t, err, "SignAccess")

	var captured context.Context
	mw := jwtx.RequireAuth(signer)
	handler := mw(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured = r.Context()
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req = req.WithContext(ctx)
	handler.ServeHTTP(httptest.NewRecorder(), req)
	require.NotNil(t, captured, "RequireAuth did not populate ctx")
	return captured
}

// newReq builds an httptest request with both the chi URL param for
// :anilistId AND the supplied auth context attached.  Passing
// anilistID="" skips the chi param injection (for endpoints without
// path params like list/create).
func newReq(t *testing.T, method, target, body, anilistID string, parentCtx context.Context) *http.Request {
	t.Helper()
	var b *bytes.Buffer
	if body != "" {
		b = bytes.NewBufferString(body)
	} else {
		b = &bytes.Buffer{}
	}
	req := httptest.NewRequest(method, target, b)
	ctx := parentCtx
	if ctx == nil {
		ctx = req.Context()
	}
	if anilistID != "" {
		rc := chi.NewRouteContext()
		rc.URLParams.Add("anilistId", anilistID)
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rc)
	}
	return req.WithContext(ctx)
}

// decodeData JSON-decodes {"data":...} into target.
func decodeData(t *testing.T, body []byte, target any) {
	t.Helper()
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(body, &env), "unmarshal envelope")
	require.NoError(t, json.Unmarshal(env.Data, target), "unmarshal data")
}

// assertError checks a 4xx/5xx response envelope byte-for-byte.
func assertError(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode, wantMsg string) {
	t.Helper()
	assert.Equal(t, wantStatus, rec.Code, "status; body=%s", rec.Body.String())
	want := `{"error":{"code":"` + wantCode + `","message":"` + wantMsg + `"}}`
	assert.Equal(t, want, rec.Body.String(), "body mismatch")
}

// -----------------------------------------------------------------------------
// ListSubscriptions
// -----------------------------------------------------------------------------

func TestListSubscriptions_MissingAuth_401(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/subscriptions", nil)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestListSubscriptions_HappyPath_FlatProjection(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	romaji := "Test Title"
	chinese := "测试标题"
	episodes := int32(12)

	db := &fakeSubsDB{
		listFn: func(_ context.Context, gotUserID uuid.UUID, statusFilter *string) ([]dbgen.ListUserSubscriptionsRow, error) {
			assert.Equal(t, userID, gotUserID)
			assert.Nil(t, statusFilter)
			return []dbgen.ListUserSubscriptionsRow{
				{
					UserID:         userID,
					AnilistID:      12345,
					Status:         "watching",
					CurrentEpisode: 3,
					TitleRomaji:    &romaji,
					TitleChinese:   &chinese,
					Episodes:       &episodes,
				},
			}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var got struct {
		Data []listItem `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got.Data, 1)
	assert.Equal(t, int32(12345), got.Data[0].AnilistID)
	assert.Equal(t, "watching", got.Data[0].Status)
	assert.Equal(t, int32(3), got.Data[0].CurrentEpisode)
	assert.Equal(t, "Test Title", *got.Data[0].TitleRomaji)
	assert.Equal(t, "测试标题", *got.Data[0].TitleChinese)
	assert.Nil(t, got.Data[0].SubscriptionID, "subscriptionId must be JSON null")
}

func TestListSubscriptions_SubscriptionIDIsExplicitNull(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		listFn: func(_ context.Context, _ uuid.UUID, _ *string) ([]dbgen.ListUserSubscriptionsRow, error) {
			return []dbgen.ListUserSubscriptionsRow{{
				UserID: userID, AnilistID: 1, Status: "watching",
			}}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"subscriptionId":null`,
		"subscriptionId must serialise as JSON null for Mongo-legacy FE compat")
}

func TestListSubscriptions_FilterAppliedFromQuery(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		listFn: func(_ context.Context, _ uuid.UUID, statusFilter *string) ([]dbgen.ListUserSubscriptionsRow, error) {
			require.NotNil(t, statusFilter)
			assert.Equal(t, "completed", *statusFilter)
			return []dbgen.ListUserSubscriptionsRow{}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions?status=completed", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestListSubscriptions_EmptyArrayNotNull(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		listFn: func(_ context.Context, _ uuid.UUID, _ *string) ([]dbgen.ListUserSubscriptionsRow, error) {
			return nil, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"data":[]`)
}

func TestListSubscriptions_DBError_500(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		listFn: func(_ context.Context, _ uuid.UUID, _ *string) ([]dbgen.ListUserSubscriptionsRow, error) {
			return nil, errors.New("db gone")
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), `"SERVER_ERROR"`)
}

// -----------------------------------------------------------------------------
// GetSubscriptionByAnilistID
// -----------------------------------------------------------------------------

func TestGetByAnilistID_HappyPath(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		getFn: func(_ context.Context, _ uuid.UUID, anilistID int32) (dbgen.Subscription, error) {
			assert.Equal(t, int32(42), anilistID)
			return dbgen.Subscription{
				UserID: userID, AnilistID: 42, Status: "watching", CurrentEpisode: 1,
			}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions/42", "", "42", ctx)
	rec := httptest.NewRecorder()
	h.GetSubscriptionByAnilistID(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	var sub dbgen.Subscription
	decodeData(t, rec.Body.Bytes(), &sub)
	assert.Equal(t, int32(42), sub.AnilistID)
}

func TestGetByAnilistID_NotFound_404(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		getFn: func(_ context.Context, _ uuid.UUID, _ int32) (dbgen.Subscription, error) {
			return dbgen.Subscription{}, pgx.ErrNoRows
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions/99", "", "99", ctx)
	rec := httptest.NewRecorder()
	h.GetSubscriptionByAnilistID(rec, req)

	assertError(t, rec, http.StatusNotFound, "NOT_FOUND", "Subscription not found")
}

func TestGetByAnilistID_InvalidPath_400(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, raw string }{
		{"non-numeric", "abc"},
		{"zero", "0"},
		{"negative", "-5"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
			userID := uuid.New()
			ctx := withUserClaims(t, context.Background(), userID, "alice")
			req := newReq(t, http.MethodGet, "/api/subscriptions/"+tc.raw, "", tc.raw, ctx)
			rec := httptest.NewRecorder()
			h.GetSubscriptionByAnilistID(rec, req)
			assertError(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid anime ID")
		})
	}
}

func TestGetByAnilistID_MissingAuth_401(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	req := newReq(t, http.MethodGet, "/api/subscriptions/1", "", "1", nil)
	rec := httptest.NewRecorder()
	h.GetSubscriptionByAnilistID(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestGetByAnilistID_DBError_500(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		getFn: func(_ context.Context, _ uuid.UUID, _ int32) (dbgen.Subscription, error) {
			return dbgen.Subscription{}, errors.New("db gone")
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodGet, "/api/subscriptions/1", "", "1", ctx)
	rec := httptest.NewRecorder()
	h.GetSubscriptionByAnilistID(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

// -----------------------------------------------------------------------------
// CreateSubscription
// -----------------------------------------------------------------------------

func TestCreate_HappyPath_201(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	want := dbgen.Subscription{UserID: userID, AnilistID: 100, Status: "watching"}

	db := &fakeSubsDB{
		upsertFn: func(_ context.Context, _ uuid.UUID, anilistID int32, status string) (dbgen.Subscription, error) {
			assert.Equal(t, int32(100), anilistID)
			assert.Equal(t, "watching", status)
			return want, nil
		},
	}
	animeDB := &fakeEnsureCachedDB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 100}, nil
		},
	}
	h := makeHandlersWithFakes(db, animeDB, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPost, "/api/subscriptions", `{"anilistId":100,"status":"watching"}`, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code, "body=%s", rec.Body.String())
	var got dbgen.Subscription
	decodeData(t, rec.Body.Bytes(), &got)
	assert.Equal(t, int32(100), got.AnilistID)
}

func TestCreate_ValidationFailures(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, body, wantMsg string
	}{
		{"missing anilistId", `{"status":"watching"}`, "Invalid anime ID"},
		{"zero anilistId", `{"anilistId":0,"status":"watching"}`, "Invalid anime ID"},
		{"negative anilistId", `{"anilistId":-1,"status":"watching"}`, "Invalid anime ID"},
		{"missing status", `{"anilistId":1}`, "Invalid status"},
		{"empty status", `{"anilistId":1,"status":""}`, "Invalid status"},
		{"invalid status", `{"anilistId":1,"status":"banana"}`, "Invalid status"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
			userID := uuid.New()
			ctx := withUserClaims(t, context.Background(), userID, "alice")
			req := newReq(t, http.MethodPost, "/api/subscriptions", tc.body, "", ctx)
			rec := httptest.NewRecorder()
			h.CreateSubscription(rec, req)
			assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", tc.wantMsg)
		})
	}
}

func TestCreate_AnilistNotFound_404(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	animeDB := &fakeEnsureCachedDB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows // probe miss
		},
	}
	ac := &fakeAnilist{
		detailFn: func(_ context.Context, _ anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
			return &anilist.AnimeDetailResponse{}, nil // empty Media → ErrAnilistNotFound
		},
	}
	h := makeHandlersWithFakes(&fakeSubsDB{}, animeDB, ac)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPost, "/api/subscriptions", `{"anilistId":999,"status":"watching"}`, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)

	assertError(t, rec, http.StatusNotFound, "NOT_FOUND", "Anime not found")
}

func TestCreate_EnsureCachedInfraError_500(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	animeDB := &fakeEnsureCachedDB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{}, errors.New("postgres down")
		},
	}
	h := makeHandlersWithFakes(&fakeSubsDB{}, animeDB, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPost, "/api/subscriptions", `{"anilistId":1,"status":"watching"}`, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestCreate_FKViolationRace_404(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		upsertFn: func(_ context.Context, _ uuid.UUID, _ int32, _ string) (dbgen.Subscription, error) {
			return dbgen.Subscription{}, &pgconn.PgError{Code: "23503"}
		},
	}
	animeDB := &fakeEnsureCachedDB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 1}, nil
		},
	}
	h := makeHandlersWithFakes(db, animeDB, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPost, "/api/subscriptions", `{"anilistId":1,"status":"watching"}`, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)

	assertError(t, rec, http.StatusNotFound, "NOT_FOUND", "Anime not found")
}

func TestCreate_UpsertOtherDBError_500(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		upsertFn: func(_ context.Context, _ uuid.UUID, _ int32, _ string) (dbgen.Subscription, error) {
			return dbgen.Subscription{}, errors.New("disk full")
		},
	}
	animeDB := &fakeEnsureCachedDB{
		getFn: func(_ context.Context, _ int32) (dbgen.GetAnimeMainByIDRow, error) {
			return dbgen.GetAnimeMainByIDRow{AnilistID: 1}, nil
		},
	}
	h := makeHandlersWithFakes(db, animeDB, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPost, "/api/subscriptions", `{"anilistId":1,"status":"watching"}`, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestCreate_InvalidJSON_400(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	userID := uuid.New()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPost, "/api/subscriptions", `{garbage`, "", ctx)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestCreate_MissingAuth_401(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	req := newReq(t, http.MethodPost, "/api/subscriptions", `{"anilistId":1,"status":"watching"}`, "", nil)
	rec := httptest.NewRecorder()
	h.CreateSubscription(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

// -----------------------------------------------------------------------------
// UpdateSubscription
// -----------------------------------------------------------------------------

func TestUpdate_HappyPath_AllFields_200(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	score := int32(8)
	want := dbgen.Subscription{
		UserID: userID, AnilistID: 42, Status: "completed",
		CurrentEpisode: 12, Score: &score,
	}

	db := &fakeSubsDB{
		updateFn: func(_ context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			require.NotNil(t, arg.Status)
			assert.Equal(t, "completed", *arg.Status)
			require.NotNil(t, arg.CurrentEpisode)
			assert.Equal(t, int32(12), *arg.CurrentEpisode)
			assert.True(t, arg.ScoreSet, "ScoreSet must be true when score key present")
			require.NotNil(t, arg.Score)
			assert.Equal(t, int32(8), *arg.Score)
			return want, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42",
		`{"status":"completed","currentEpisode":12,"score":8}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestUpdate_EmptyBodyReturnsRowUnchanged(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	want := dbgen.Subscription{UserID: userID, AnilistID: 42, Status: "watching"}

	db := &fakeSubsDB{
		updateFn: func(_ context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			assert.Nil(t, arg.Status)
			assert.Nil(t, arg.CurrentEpisode)
			assert.False(t, arg.ScoreSet)
			assert.Nil(t, arg.Score)
			return want, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestUpdate_ScoreNullClears(t *testing.T) {
	t.Parallel()
	// `{"score":null}` → ScoreSet=true, Score=nil — clears the column.
	userID := uuid.New()
	db := &fakeSubsDB{
		updateFn: func(_ context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			assert.True(t, arg.ScoreSet, "ScoreSet must be true for explicit null")
			assert.Nil(t, arg.Score, "Score must be nil for explicit null")
			return dbgen.Subscription{UserID: userID, AnilistID: 42}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"score":null}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestUpdate_ScoreAbsentLeavesUnchanged(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		updateFn: func(_ context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			assert.False(t, arg.ScoreSet)
			return dbgen.Subscription{UserID: userID, AnilistID: 42}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"status":"watching"}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestUpdate_ScoreClampedToTen(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		updateFn: func(_ context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			require.NotNil(t, arg.Score)
			assert.Equal(t, int32(10), *arg.Score, "out-of-range score must clamp to 10")
			return dbgen.Subscription{UserID: userID, AnilistID: 42, Score: arg.Score}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"score":15}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestUpdate_ScoreClampedToOne(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		updateFn: func(_ context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			require.NotNil(t, arg.Score)
			assert.Equal(t, int32(1), *arg.Score, "below-range score must clamp to 1")
			return dbgen.Subscription{UserID: userID, AnilistID: 42, Score: arg.Score}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"score":0}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestUpdate_InvalidStatus_400(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	userID := uuid.New()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"status":"nope"}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid status")
}

func TestUpdate_NegativeEpisode_400(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	userID := uuid.New()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"currentEpisode":-1}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	assertError(t, rec, http.StatusBadRequest, "VALIDATION_ERROR", "Episode must be a non-negative integer")
}

func TestUpdate_InvalidJSON_400(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	userID := uuid.New()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{garbage`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestUpdate_TypeMismatchInField_400(t *testing.T) {
	t.Parallel()
	// status as a number rather than a string trips parseUpdateBody's
	// inner json.Unmarshal — must surface as 400 not 500.
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	userID := uuid.New()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"status":123}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestUpdate_EmptyBodyContentLengthZero_200(t *testing.T) {
	t.Parallel()
	// Express treats an entirely missing body as an empty patch.  Our
	// parseUpdateBody short-circuits the io.EOF case from json.Decode
	// to mirror that.
	userID := uuid.New()
	db := &fakeSubsDB{
		updateFn: func(_ context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			assert.False(t, arg.ScoreSet, "ScoreSet must be false for empty body")
			return dbgen.Subscription{UserID: userID, AnilistID: 42}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	// Empty body (no content) — pass "" so newReq sends an empty buffer.
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", "", "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestUpdate_ExplicitNullBody_200(t *testing.T) {
	t.Parallel()
	// `null` body decodes to a nil map — handled as empty patch.
	userID := uuid.New()
	db := &fakeSubsDB{
		updateFn: func(_ context.Context, arg dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			assert.False(t, arg.ScoreSet, "ScoreSet must be false for null body")
			return dbgen.Subscription{UserID: userID, AnilistID: 42}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `null`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

func TestUpdate_NotFound_404(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		updateFn: func(_ context.Context, _ dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			return dbgen.Subscription{}, pgx.ErrNoRows
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"status":"watching"}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)

	assertError(t, rec, http.StatusNotFound, "NOT_FOUND", "Subscription not found")
}

func TestUpdate_DBError_500(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		updateFn: func(_ context.Context, _ dbgen.UpdateSubscriptionParams) (dbgen.Subscription, error) {
			return dbgen.Subscription{}, errors.New("kaboom")
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/42", `{"status":"watching"}`, "42", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestUpdate_InvalidAnilistID_400(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	userID := uuid.New()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodPatch, "/api/subscriptions/bad", `{}`, "bad", ctx)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	assertError(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid anime ID")
}

func TestUpdate_MissingAuth_401(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	req := newReq(t, http.MethodPatch, "/api/subscriptions/1", `{}`, "1", nil)
	rec := httptest.NewRecorder()
	h.UpdateSubscription(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

// -----------------------------------------------------------------------------
// DeleteSubscription
// -----------------------------------------------------------------------------

func TestDelete_HappyPath_200(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		deleteFn: func(_ context.Context, _ uuid.UUID, anilistID int32) (int64, error) {
			assert.Equal(t, int32(42), anilistID)
			return 1, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodDelete, "/api/subscriptions/42", "", "42", ctx)
	rec := httptest.NewRecorder()
	h.DeleteSubscription(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.Equal(t, `{"data":{"message":"Deleted"}}`, rec.Body.String())
}

func TestDelete_NotFound_404(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		deleteFn: func(_ context.Context, _ uuid.UUID, _ int32) (int64, error) {
			return 0, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodDelete, "/api/subscriptions/99", "", "99", ctx)
	rec := httptest.NewRecorder()
	h.DeleteSubscription(rec, req)

	assertError(t, rec, http.StatusNotFound, "NOT_FOUND", "Subscription not found")
}

func TestDelete_InvalidAnilistID_400(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	userID := uuid.New()
	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodDelete, "/api/subscriptions/abc", "", "abc", ctx)
	rec := httptest.NewRecorder()
	h.DeleteSubscription(rec, req)
	assertError(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid anime ID")
}

func TestDelete_DBError_500(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	db := &fakeSubsDB{
		deleteFn: func(_ context.Context, _ uuid.UUID, _ int32) (int64, error) {
			return 0, errors.New("boom")
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	ctx := withUserClaims(t, context.Background(), userID, "alice")
	req := newReq(t, http.MethodDelete, "/api/subscriptions/1", "", "1", ctx)
	rec := httptest.NewRecorder()
	h.DeleteSubscription(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestDelete_MissingAuth_401(t *testing.T) {
	t.Parallel()
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	req := newReq(t, http.MethodDelete, "/api/subscriptions/1", "", "1", nil)
	rec := httptest.NewRecorder()
	h.DeleteSubscription(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

// -----------------------------------------------------------------------------
// NewHandlers — constructor wiring
// -----------------------------------------------------------------------------

func TestNewHandlers_NilDeps_Panic(t *testing.T) {
	t.Parallel()

	t.Run("nil queries", func(t *testing.T) {
		t.Parallel()
		assert.Panics(t, func() {
			NewHandlers(nil, nil, &fakeEnsureCachedDB{}, &fakeAnilist{}, nil)
		})
	})

	t.Run("nil animeDB", func(t *testing.T) {
		t.Parallel()
		assert.Panics(t, func() {
			NewHandlers(nil, &fakeSubsDB{}, nil, &fakeAnilist{}, nil)
		})
	})

	t.Run("nil anilist client", func(t *testing.T) {
		t.Parallel()
		assert.Panics(t, func() {
			NewHandlers(nil, &fakeSubsDB{}, &fakeEnsureCachedDB{}, nil, nil)
		})
	})
}

func TestNewHandlers_NilValidatorSubstitutesDefault(t *testing.T) {
	t.Parallel()
	h := NewHandlers(nil, &fakeSubsDB{}, &fakeEnsureCachedDB{}, &fakeAnilist{}, nil)
	require.NotNil(t, h.Validate, "Validate must be defaulted when nil passed")
}

