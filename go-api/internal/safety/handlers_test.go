package safety

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

type fakeDB struct {
	user              dbgen.GetUserIDByUsernameRow
	userErr           error
	comment           dbgen.GetCommentByIDRow
	commentErr        error
	block             dbgen.BlockUserRow
	blockArgs         [2]uuid.UUID
	unblockArgs       [2]uuid.UUID
	blocks            []dbgen.ListUserBlocksRow
	report            dbgen.CreatePendingReportRow
	reportParams      dbgen.CreatePendingReportParams
	reportErr         error
	reports           []dbgen.ListReportsRow
	listReportStatus  *string
	updatedReport     dbgen.Report
	updateReportError error
}

func (f *fakeDB) GetUserIDByUsername(context.Context, string) (dbgen.GetUserIDByUsernameRow, error) {
	return f.user, f.userErr
}
func (f *fakeDB) GetCommentByID(context.Context, uuid.UUID) (dbgen.GetCommentByIDRow, error) {
	return f.comment, f.commentErr
}
func (f *fakeDB) BlockUser(_ context.Context, blockerID, blockedID uuid.UUID) (dbgen.BlockUserRow, error) {
	f.blockArgs = [2]uuid.UUID{blockerID, blockedID}
	return f.block, nil
}
func (f *fakeDB) UnblockUser(_ context.Context, blockerID, blockedID uuid.UUID) (int64, error) {
	f.unblockArgs = [2]uuid.UUID{blockerID, blockedID}
	return 1, nil
}
func (f *fakeDB) ListUserBlocks(context.Context, uuid.UUID, int32, int32) ([]dbgen.ListUserBlocksRow, error) {
	return f.blocks, nil
}
func (f *fakeDB) CreatePendingReport(_ context.Context, arg dbgen.CreatePendingReportParams) (dbgen.CreatePendingReportRow, error) {
	f.reportParams = arg
	return f.report, f.reportErr
}
func (f *fakeDB) ListReports(_ context.Context, status *string, _, _ int32) ([]dbgen.ListReportsRow, error) {
	f.listReportStatus = status
	return f.reports, nil
}
func (f *fakeDB) UpdateReport(context.Context, string, *string, uuid.UUID, uuid.UUID) (dbgen.Report, error) {
	return f.updatedReport, f.updateReportError
}

func withClaims(t *testing.T, req *http.Request, userID uuid.UUID, role *string) *http.Request {
	t.Helper()
	signer, err := jwtx.NewSigner("safety-access", "safety-refresh", time.Hour, time.Hour)
	require.NoError(t, err)
	token, err := signer.SignAccess(userID, "viewer", role)
	require.NoError(t, err)
	var captured *http.Request
	middleware := jwtx.RequireAuth(signer)
	handler := middleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { captured = r }))
	req.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(httptest.NewRecorder(), req)
	require.NotNil(t, captured)
	return captured
}

func withParam(req *http.Request, name, value string) *http.Request {
	route := chi.NewRouteContext()
	route.URLParams.Add(name, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
}

func TestBlockAndUnblock(t *testing.T) {
	viewer, target := uuid.New(), uuid.New()
	db := &fakeDB{
		user:  dbgen.GetUserIDByUsernameRow{ID: target, Username: "target"},
		block: dbgen.BlockUserRow{Inserted: true, RemovedFollows: 2, RemovedNotifications: 3, RemovedReactions: 4},
	}
	h := NewHandlers(db)

	req := withParam(httptest.NewRequest(http.MethodPut, "/api/users/target/block", nil), "username", "target")
	req = withClaims(t, req, viewer, nil)
	rec := httptest.NewRecorder()
	h.Block(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, [2]uuid.UUID{viewer, target}, db.blockArgs)
	assert.JSONEq(t, `{"data":{"blocked":true,"removedFollows":2,"removedNotifications":3,"removedReactions":4}}`, rec.Body.String())

	req = withParam(httptest.NewRequest(http.MethodDelete, "/api/users/target/block", nil), "username", "target")
	req = withClaims(t, req, viewer, nil)
	rec = httptest.NewRecorder()
	h.Unblock(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, [2]uuid.UUID{viewer, target}, db.unblockArgs)
}

func TestBlockRejectsSelf(t *testing.T) {
	viewer := uuid.New()
	db := &fakeDB{user: dbgen.GetUserIDByUsernameRow{ID: viewer, Username: "viewer"}}
	req := withParam(httptest.NewRequest(http.MethodPut, "/api/users/viewer/block", nil), "username", "viewer")
	req = withClaims(t, req, viewer, nil)
	rec := httptest.NewRecorder()
	NewHandlers(db).Block(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Cannot block yourself")
	assert.Equal(t, [2]uuid.UUID{}, db.blockArgs)
}

func TestListBlocksUsesLookaheadPagination(t *testing.T) {
	viewer := uuid.New()
	db := &fakeDB{blocks: []dbgen.ListUserBlocksRow{
		{BlockedID: uuid.New(), Username: "one"},
		{BlockedID: uuid.New(), Username: "two"},
	}}
	req := withClaims(t, httptest.NewRequest(http.MethodGet, "/api/blocks?limit=1", nil), viewer, nil)
	rec := httptest.NewRecorder()
	NewHandlers(db).ListBlocks(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var body struct {
		Data struct {
			Items    []blockItem `json:"items"`
			HasMore  bool        `json:"hasMore"`
			NextPage *int        `json:"nextPage"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Len(t, body.Data.Items, 1)
	assert.True(t, body.Data.HasMore)
	require.NotNil(t, body.Data.NextPage)
	assert.Equal(t, 2, *body.Data.NextPage)
}

func TestCreateCommentReport(t *testing.T) {
	viewer, author, commentID, reportID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	db := &fakeDB{
		comment: dbgen.GetCommentByIDRow{ID: commentID, UserID: author},
		report:  dbgen.CreatePendingReportRow{ID: reportID, Status: "pending"},
	}
	body := bytes.NewBufferString(`{"targetType":"comment","targetId":"` + commentID.String() + `","reason":"spoiler","details":"  unmarked  "}`)
	req := withClaims(t, httptest.NewRequest(http.MethodPost, "/api/reports", body), viewer, nil)
	rec := httptest.NewRecorder()
	NewHandlers(db).CreateReport(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NotNil(t, db.reportParams.TargetCommentID)
	assert.Equal(t, commentID, *db.reportParams.TargetCommentID)
	require.NotNil(t, db.reportParams.Details)
	assert.Equal(t, "unmarked", *db.reportParams.Details)
	assert.JSONEq(t, `{"data":{"id":"`+reportID.String()+`","status":"pending"}}`, rec.Body.String())
}

func TestCreateReportValidationAndOwnership(t *testing.T) {
	viewer, commentID := uuid.New(), uuid.New()
	db := &fakeDB{comment: dbgen.GetCommentByIDRow{ID: commentID, UserID: viewer}}
	h := NewHandlers(db)

	req := withClaims(t, httptest.NewRequest(http.MethodPost, "/api/reports", bytes.NewBufferString(
		`{"targetType":"comment","targetId":"`+commentID.String()+`","reason":"not-real"}`,
	)), viewer, nil)
	rec := httptest.NewRecorder()
	h.CreateReport(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	req = withClaims(t, httptest.NewRequest(http.MethodPost, "/api/reports", bytes.NewBufferString(
		`{"targetType":"comment","targetId":"`+commentID.String()+`","reason":"spam"}`,
	)), viewer, nil)
	rec = httptest.NewRecorder()
	h.CreateReport(rec, req)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "Cannot report your own content")
}

func TestReportTargetNotFound(t *testing.T) {
	viewer, commentID := uuid.New(), uuid.New()
	db := &fakeDB{commentErr: pgx.ErrNoRows}
	req := withClaims(t, httptest.NewRequest(http.MethodPost, "/api/reports", bytes.NewBufferString(
		`{"targetType":"comment","targetId":"`+commentID.String()+`","reason":"spam"}`,
	)), viewer, nil)
	rec := httptest.NewRecorder()
	NewHandlers(db).CreateReport(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestAdminListAndUpdateReports(t *testing.T) {
	adminID, reportID := uuid.New(), uuid.New()
	created := pgtype.Timestamptz{Time: time.Now(), Valid: true}
	db := &fakeDB{
		reports: []dbgen.ListReportsRow{{
			ID: reportID, ReporterUsername: "reporter", TargetType: "comment",
			TargetSnapshot: []byte(`{"content":"evidence"}`), Reason: "spam", Status: "pending", CreatedAt: created,
		}},
		updatedReport: dbgen.Report{ID: reportID, Status: "resolved"},
	}
	role := "admin"
	req := withClaims(t, httptest.NewRequest(http.MethodGet, "/api/admin/reports?status=pending", nil), adminID, &role)
	rec := httptest.NewRecorder()
	NewHandlers(db).ListReports(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotNil(t, db.listReportStatus)
	assert.Equal(t, "pending", *db.listReportStatus)
	assert.Contains(t, rec.Body.String(), `"targetSnapshot":{"content":"evidence"}`)

	req = withParam(httptest.NewRequest(http.MethodPatch, "/api/admin/reports/"+reportID.String(), bytes.NewBufferString(
		`{"status":"resolved"}`,
	)), "id", reportID.String())
	req = withClaims(t, req, adminID, &role)
	rec = httptest.NewRecorder()
	NewHandlers(db).UpdateReport(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestPageOffsetClampsInsteadOfOverflowing(t *testing.T) {
	for name, tc := range map[string]struct {
		page, limit int
		want        int32
	}{
		"first page":     {page: 1, limit: 20, want: 0},
		"second page":    {page: 2, limit: 20, want: 20},
		"tenth page":     {page: 10, limit: 50, want: 450},
		"page below one": {page: 0, limit: 20, want: 0},
		"zero limit":     {page: 9, limit: 0, want: 0},
		"beyond cap":     {page: 1_000_000, limit: 50, want: maxPageOffset},
		// (page-1)*limit truncates to a positive-but-wrong int32 here...
		"wraps int32 positive": {page: 200_000_000, limit: 50, want: maxPageOffset},
		// ...and to a negative one here, which is what Postgres rejects.
		"wraps int32 negative": {page: 1_000_000_000, limit: 50, want: maxPageOffset},
		"smallest wrap":        {page: 42_949_674, limit: 50, want: maxPageOffset},
		// The largest ?page= strconv.Atoi will hand back — the product
		// (page-1)*limit overflows the machine int, so pageOffset must
		// never compute it.
		"overflows the product": {page: math.MaxInt, limit: maxPageSize, want: maxPageOffset},
	} {
		t.Run(name, func(t *testing.T) {
			got := pageOffset(tc.page, tc.limit)
			assert.Equal(t, tc.want, got)
			assert.GreaterOrEqual(t, got, int32(0), "a negative OFFSET makes Postgres error out")
		})
	}
}

func TestHandlersRequireClaims(t *testing.T) {
	db := &fakeDB{}
	h := NewHandlers(db)
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){
		"blocks": h.ListBlocks, "create-report": h.CreateReport, "reports": h.ListReports,
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			call(rec, httptest.NewRequest(http.MethodGet, "/", nil))
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}
}
