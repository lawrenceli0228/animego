// Package safety owns community block and report HTTP endpoints.
package safety

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

const (
	queryTimeout      = 5 * time.Second
	defaultPageSize   = 20
	maxPageSize       = 50
	maxDetailsRunes   = 500
	maxResolutionNote = 1000

	// maxPageOffset caps the SQL OFFSET these list endpoints will ask
	// Postgres for.  Nothing real lives past a million blocks or reports,
	// so anything beyond this is a crawler or a probe — and the cap is
	// what keeps pageOffset's int32 conversion safe.
	maxPageOffset = 1_000_000
)

var validReasons = map[string]struct{}{
	"spam": {}, "harassment": {}, "hate_speech": {}, "sexual_content": {},
	"violence": {}, "spoiler": {}, "misinformation": {}, "other": {},
}

var validReportStatuses = map[string]struct{}{
	"pending": {}, "reviewing": {}, "resolved": {}, "dismissed": {},
}

type DB interface {
	GetUserIDByUsername(ctx context.Context, username string) (dbgen.GetUserIDByUsernameRow, error)
	GetCommentByID(ctx context.Context, id uuid.UUID) (dbgen.GetCommentByIDRow, error)
	BlockUser(ctx context.Context, blockerID, blockedID uuid.UUID) (dbgen.BlockUserRow, error)
	UnblockUser(ctx context.Context, blockerID, blockedID uuid.UUID) (int64, error)
	ListUserBlocks(ctx context.Context, blockerID uuid.UUID, limit, offset int32) ([]dbgen.ListUserBlocksRow, error)
	CreatePendingReport(ctx context.Context, arg dbgen.CreatePendingReportParams) (dbgen.CreatePendingReportRow, error)
	ListReports(ctx context.Context, reportStatus *string, pageOffset, pageLimit int32) ([]dbgen.ListReportsRow, error)
	UpdateReport(ctx context.Context, reportStatus string, resolutionNote *string, reviewedBy, reportID uuid.UUID) (dbgen.Report, error)
}

type Handlers struct{ db DB }

func NewHandlers(db DB) *Handlers {
	if db == nil {
		panic("safety.NewHandlers: nil DB")
	}
	return &Handlers{db: db}
}

func requestClaims(w http.ResponseWriter, r *http.Request) (*jwtx.AccessClaims, bool) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, httpx.CodeUnauthorized, "Authentication required"))
		return nil, false
	}
	return claims, true
}

func (h *Handlers) Block(w http.ResponseWriter, r *http.Request) {
	claims, ok := requestClaims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	target, err := h.db.GetUserIDByUsername(ctx, chi.URLParam(r, "username"))
	if err != nil {
		handleTargetLookupError(w, err, "user")
		return
	}
	if target.ID == claims.UserID {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidAction, "Cannot block yourself"))
		return
	}
	row, err := h.db.BlockUser(ctx, claims.UserID, target.ID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "block user failed"))
		return
	}
	httpx.Data(w, http.StatusOK, struct {
		Blocked              bool  `json:"blocked"`
		RemovedFollows       int64 `json:"removedFollows"`
		RemovedNotifications int64 `json:"removedNotifications"`
		RemovedReactions     int64 `json:"removedReactions"`
	}{
		Blocked: true, RemovedFollows: row.RemovedFollows,
		RemovedNotifications: row.RemovedNotifications, RemovedReactions: row.RemovedReactions,
	})
}

func (h *Handlers) Unblock(w http.ResponseWriter, r *http.Request) {
	claims, ok := requestClaims(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	target, err := h.db.GetUserIDByUsername(ctx, chi.URLParam(r, "username"))
	if err != nil {
		handleTargetLookupError(w, err, "user")
		return
	}
	if target.ID == claims.UserID {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidAction, "Cannot unblock yourself"))
		return
	}
	if _, err := h.db.UnblockUser(ctx, claims.UserID, target.ID); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "unblock user failed"))
		return
	}
	httpx.Data(w, http.StatusOK, struct {
		Blocked bool `json:"blocked"`
	}{Blocked: false})
}

type blockItem struct {
	ID               uuid.UUID          `json:"id"`
	Username         string             `json:"username"`
	AvatarURL        *string            `json:"avatarUrl"`
	BackdropCoverURL *string            `json:"backdropCoverUrl"`
	CreatedAt        pgtype.Timestamptz `json:"createdAt"`
}

func (h *Handlers) ListBlocks(w http.ResponseWriter, r *http.Request) {
	claims, ok := requestClaims(w, r)
	if !ok {
		return
	}
	page := positiveInt(r.URL.Query().Get("page"), 1)
	limit := positiveInt(r.URL.Query().Get("limit"), defaultPageSize)
	if limit > maxPageSize {
		limit = maxPageSize
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	rows, err := h.db.ListUserBlocks(ctx, claims.UserID, int32(limit+1), pageOffset(page, limit))
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "list blocks failed"))
		return
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	items := make([]blockItem, len(rows))
	for i, row := range rows {
		items[i] = blockItem{
			ID: row.BlockedID, Username: row.Username, AvatarURL: row.AvatarUrl,
			BackdropCoverURL: row.BackdropCoverUrl, CreatedAt: row.CreatedAt,
		}
	}
	var nextPage *int
	if hasMore {
		next := page + 1
		nextPage = &next
	}
	httpx.Data(w, http.StatusOK, struct {
		Items    []blockItem `json:"items"`
		HasMore  bool        `json:"hasMore"`
		NextPage *int        `json:"nextPage"`
	}{Items: items, HasMore: hasMore, NextPage: nextPage})
}

type createReportRequest struct {
	TargetType string  `json:"targetType"`
	TargetID   string  `json:"targetId"`
	Reason     string  `json:"reason"`
	Details    *string `json:"details"`
}

func (h *Handlers) CreateReport(w http.ResponseWriter, r *http.Request) {
	claims, ok := requestClaims(w, r)
	if !ok {
		return
	}
	var req createReportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "Invalid request body"))
		return
	}
	req.TargetType = strings.TrimSpace(req.TargetType)
	req.TargetID = strings.TrimSpace(req.TargetID)
	req.Reason = strings.TrimSpace(req.Reason)
	if req.TargetType != "comment" && req.TargetType != "user" {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Invalid report target"))
		return
	}
	if _, ok := validReasons[req.Reason]; !ok {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Invalid report reason"))
		return
	}
	details, ok := trimOptional(req.Details, maxDetailsRunes)
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Report details too long"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	params := dbgen.CreatePendingReportParams{
		ReporterID: claims.UserID,
		TargetType: req.TargetType,
		Reason:     req.Reason,
		Details:    details,
	}
	if req.TargetType == "comment" {
		id, err := uuid.Parse(req.TargetID)
		if err != nil {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Invalid comment ID"))
			return
		}
		comment, err := h.db.GetCommentByID(ctx, id)
		if err != nil {
			handleTargetLookupError(w, err, "comment")
			return
		}
		if comment.UserID == claims.UserID {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidAction, "Cannot report your own content"))
			return
		}
		params.TargetCommentID = &id
	} else {
		target, err := h.db.GetUserIDByUsername(ctx, req.TargetID)
		if err != nil {
			handleTargetLookupError(w, err, "user")
			return
		}
		if target.ID == claims.UserID {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeInvalidAction, "Cannot report yourself"))
			return
		}
		params.TargetUserID = &target.ID
	}

	row, err := h.db.CreatePendingReport(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		// Empty means one of two things, and only a second attempt tells
		// them apart.
		//
		// Either the target really is gone — the report_target CTE matched
		// nothing, and the 404 below is the answer — or this request
		// overlapped another report of the same target by the same user.
		// In that case ON CONFLICT DO NOTHING made the statement wait on
		// the other transaction, but its snapshot was taken before the
		// wait: once the other side commits, the insert arm yields nothing
		// and the read-back arm cannot see the row that was just committed
		// either.  Zero rows, and the user is told their target does not
		// exist while their own report of it sits in the queue.
		//
		// Retrying runs on a fresh snapshot, so it reads that pending
		// report back.  A genuinely missing target stays missing and still
		// answers 404.  (InsertSubscriptionIfAbsent had the same race and
		// could close it in SQL by making the conflict arm DO UPDATE.
		// This one cannot: `reports` carries two partial unique indexes —
		// one per target kind — and DO UPDATE can only infer one of them.)
		row, err = h.db.CreatePendingReport(ctx, params)
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "Report target not found"))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "create report failed"))
		return
	}
	httpx.Data(w, http.StatusCreated, struct {
		ID     uuid.UUID `json:"id"`
		Status string    `json:"status"`
	}{ID: row.ID, Status: row.Status})
}

type reportItem struct {
	ID                     uuid.UUID          `json:"id"`
	ReporterUsername       string             `json:"reporterUsername"`
	TargetType             string             `json:"targetType"`
	TargetCommentID        *uuid.UUID         `json:"targetCommentId"`
	TargetUserID           *uuid.UUID         `json:"targetUserId"`
	TargetSnapshot         json.RawMessage    `json:"targetSnapshot"`
	TargetUsername         *string            `json:"targetUsername"`
	TargetCommentContent   *string            `json:"targetCommentContent"`
	TargetCommentIsSpoiler *bool              `json:"targetCommentIsSpoiler"`
	TargetCommentAnilistID *int32             `json:"targetCommentAnilistId"`
	TargetCommentEpisode   *int32             `json:"targetCommentEpisode"`
	Reason                 string             `json:"reason"`
	Details                *string            `json:"details"`
	Status                 string             `json:"status"`
	ResolutionNote         *string            `json:"resolutionNote"`
	ReviewerUsername       *string            `json:"reviewerUsername"`
	ReviewedAt             pgtype.Timestamptz `json:"reviewedAt"`
	CreatedAt              pgtype.Timestamptz `json:"createdAt"`
}

func (h *Handlers) ListReports(w http.ResponseWriter, r *http.Request) {
	if _, ok := requestClaims(w, r); !ok {
		return
	}
	var status *string
	if raw := strings.TrimSpace(r.URL.Query().Get("status")); raw != "" {
		if _, ok := validReportStatuses[raw]; !ok {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Invalid report status"))
			return
		}
		status = &raw
	}
	page := positiveInt(r.URL.Query().Get("page"), 1)
	limit := positiveInt(r.URL.Query().Get("limit"), defaultPageSize)
	if limit > maxPageSize {
		limit = maxPageSize
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	rows, err := h.db.ListReports(ctx, status, pageOffset(page, limit), int32(limit+1))
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "list reports failed"))
		return
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	items := make([]reportItem, len(rows))
	for i, row := range rows {
		items[i] = reportItem{
			ID: row.ID, ReporterUsername: row.ReporterUsername, TargetType: row.TargetType,
			TargetCommentID: row.TargetCommentID, TargetUserID: row.TargetUserID,
			TargetSnapshot: json.RawMessage(row.TargetSnapshot), TargetUsername: row.TargetUsername,
			TargetCommentContent: row.TargetCommentContent, TargetCommentIsSpoiler: row.TargetCommentIsSpoiler,
			TargetCommentAnilistID: row.TargetCommentAnilistID, TargetCommentEpisode: row.TargetCommentEpisode,
			Reason: row.Reason, Details: row.Details, Status: row.Status,
			ResolutionNote: row.ResolutionNote, ReviewerUsername: row.ReviewerUsername,
			ReviewedAt: row.ReviewedAt, CreatedAt: row.CreatedAt,
		}
	}
	var nextPage *int
	if hasMore {
		next := page + 1
		nextPage = &next
	}
	httpx.Data(w, http.StatusOK, struct {
		Items    []reportItem `json:"items"`
		HasMore  bool         `json:"hasMore"`
		NextPage *int         `json:"nextPage"`
	}{Items: items, HasMore: hasMore, NextPage: nextPage})
}

type updateReportRequest struct {
	Status         string  `json:"status"`
	ResolutionNote *string `json:"resolutionNote"`
}

func (h *Handlers) UpdateReport(w http.ResponseWriter, r *http.Request) {
	claims, ok := requestClaims(w, r)
	if !ok {
		return
	}
	reportID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "Invalid report ID"))
		return
	}
	var req updateReportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, "Invalid request body"))
		return
	}
	req.Status = strings.TrimSpace(req.Status)
	if _, ok := validReportStatuses[req.Status]; !ok || req.Status == "pending" {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Invalid report status"))
		return
	}
	note, ok := trimOptional(req.ResolutionNote, maxResolutionNote)
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Resolution note too long"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	row, err := h.db.UpdateReport(ctx, req.Status, note, claims.UserID, reportID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "Report not found"))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "update report failed"))
		return
	}
	httpx.Data(w, http.StatusOK, struct {
		ID             uuid.UUID `json:"id"`
		Status         string    `json:"status"`
		ResolutionNote *string   `json:"resolutionNote"`
	}{ID: row.ID, Status: row.Status, ResolutionNote: row.ResolutionNote})
}

func handleTargetLookupError(w http.ResponseWriter, err error, target string) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, strings.ToUpper(target[:1])+target[1:]+" not found"))
		return
	}
	httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, target+" lookup failed"))
}

func positiveInt(raw string, fallback int) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return fallback
	}
	return n
}

// pageOffset turns a 1-based page number into a SQL OFFSET, clamped to
// maxPageOffset.
//
// positiveInt only clamps the lower bound, so ?page= arrives unbounded and
// (page-1)*limit runs past int32.  Go truncates rather than saturating on
// the conversion, so the offset wraps: ?page=1000000000&limit=50 lands on
// -1539607602, Postgres rejects `OFFSET -N`, and the endpoint 500s.  Values
// that wrap back to a positive number are quieter but no better — they
// serve an arbitrary page.  Clamping degrades a nonsense page number into
// an ordinary empty result page instead.
//
// The bound is checked by division rather than by computing the product
// first — the product is exactly the thing that overflows.
func pageOffset(page, limit int) int32 {
	if page < 2 || limit < 1 {
		return 0
	}
	if page-1 > maxPageOffset/limit {
		return maxPageOffset
	}
	return int32((page - 1) * limit)
}

func trimOptional(value *string, maxRunes int) (*string, bool) {
	if value == nil {
		return nil, true
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil, true
	}
	if utf8.RuneCountInString(trimmed) > maxRunes {
		return nil, false
	}
	return &trimmed, true
}
