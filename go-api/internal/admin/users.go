// Package admin owns the /api/admin/* HTTP handlers — administrative
// endpoints gated behind jwtx.RequireAuth + jwtx.RequireAdmin (role check).
//
// This file (users.go) implements the user-management trio:
//
//	POST   /api/admin/users           — CreateUser
//	PATCH  /api/admin/users/:userId   — UpdateUser
//	DELETE /api/admin/users/:userId   — DeleteUser
//
// The /api/admin/warm-all endpoint lives in warm_all.go because it has
// a fundamentally different shape (immediate response + background
// goroutine, no DB writes), and keeping the two surfaces separate makes
// the per-handler intent obvious at a glance.
//
// Responses use the canonical English envelope (frontend i18n maps to
// localized text), error codes match the Express enum
// (BAD_REQUEST / CONFLICT / NOT_FOUND), and the success envelope uses
// the `_id` field name (Mongo legacy) preserved via json tags so the
// front-end consumer doesn't need to learn a new key.

package admin

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// userQueryTimeout bounds every user-CRUD handler's database round-trip.
// Five seconds covers the multi-step pre-check + write pattern used by
// the user CRUD endpoints (lookup → insert / update / delete) while
// still failing fast enough that a hung Postgres doesn't hold goroutines.
//
// Named with the user prefix because handlers.go in this package
// declares its own `queryTimeout` for the read endpoints.  The constants
// happen to share the same value but live in independent scopes —
// changing one for write workflows should not silently affect reads.
const userQueryTimeout = 5 * time.Second

// pgUniqueViolation is the Postgres SQLSTATE for a unique-constraint
// failure.  CreateUser races a pre-check lookup against the
// users_username_key / users_email_key indexes; on a tie the INSERT
// returns 23505 and we map to 409 CONFLICT with the same message logic
// the pre-check would have used.
const pgUniqueViolation = "23505"

// User-facing messages — emitted in English; the frontend i18n layer
// maps each string to a localized translation keyed on the English text.
const (
	msgMissingFields      = "Username, email and password are required"
	msgAtLeastOne         = "At least one of username or email is required"
	msgUsernameConflict   = "Username already exists"
	msgEmailConflict      = "Email already exists"
	msgUserNotFound       = "User not found"
	msgCannotDeleteSelf   = "Cannot delete yourself"
	msgInvalidUserID      = "Invalid user ID"
	msgInvalidRequestBody = "Invalid request body"
	msgPasswordTooShort   = "Password must be at least 6 characters"
)

// UserDB is the sqlc subset the user-CRUD handlers consume.  Defined at
// the use-site per "accept interfaces, return structs" so tests can
// substitute a fake without dragging the full dbgen.Querier surface
// into the test setup.
//
// GetUserByID is included even though sqlc only generates one method by
// that name on the Querier — DeleteUser needs an existence check before
// calling AdminDeleteUser so it can return 404 (the DELETE statement
// alone returns no error on a no-op match).
type UserDB interface {
	AdminCreateUser(ctx context.Context, username, email, password string) (dbgen.AdminCreateUserRow, error)
	AdminUpdateUser(ctx context.Context, username, email *string, userID uuid.UUID) (dbgen.AdminUpdateUserRow, error)
	AdminDeleteUser(ctx context.Context, id uuid.UUID) error
	AdminSetUserPassword(ctx context.Context, id uuid.UUID, password string) error
	AdminFindUserByUsernameOrEmail(ctx context.Context, username, email *string) (dbgen.AdminFindUserByUsernameOrEmailRow, error)
	AdminFindUserByUsernameOrEmailExcluding(ctx context.Context, username, email *string, excludeID uuid.UUID) (dbgen.AdminFindUserByUsernameOrEmailExcludingRow, error)
	GetUserByID(ctx context.Context, id uuid.UUID) (dbgen.User, error)
}

// UserHandlers carries the deps shared by every user-CRUD handler.
// Construct once via NewUserHandlers in main.go and register each
// method on the chi router behind the RequireAuth + RequireAdmin
// middleware chain.
//
// Enqueuer is the queue surface WarmAll uses; it lives on this struct
// (rather than a separate WarmAllHandlers type) because the production
// wiring binds them together — they share the same auth chain, the
// same logger, and the same lifecycle, so splitting them adds friction
// without payoff.
type UserHandlers struct {
	db  UserDB
	enq queue.Enqueuer
}

// NewUserHandlers constructs a UserHandlers bundle.  Pass the live
// dbgen.Queries (which satisfies UserDB) and the application's
// Enqueuer.  Both are required at boot — a nil dependency would crash
// on the first request, so we fail fast with a panic here to flag
// the misconfiguration during startup smoke tests rather than at
// request time.
func NewUserHandlers(db UserDB, enq queue.Enqueuer) *UserHandlers {
	if db == nil {
		panic("admin.NewUserHandlers: nil UserDB")
	}
	if enq == nil {
		panic("admin.NewUserHandlers: nil Enqueuer")
	}
	return &UserHandlers{db: db, enq: enq}
}

// createUserReq is the JSON body shape for POST /api/admin/users.  All
// three fields are required.  We deliberately do NOT use struct tags
// for validator min/max/email because the Express controller does the
// equivalent check via the `if (!username || !email || !password)`
// early-return — matching that one-shot 400 message keeps the byte-
// diff at cutover clean.
type createUserReq struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

// createUserResp is the success body for POST /api/admin/users.  Note
// the `_id` JSON tag — Express's response shape predates the Postgres
// migration and the front-end still consumes `_id`.  Preserving the
// key here means the SSR layer doesn't need a per-field rename.
type createUserResp struct {
	ID       uuid.UUID `json:"_id"`
	Username string    `json:"username"`
	Email    string    `json:"email"`
}

// CreateUser implements POST /api/admin/users.
//
// Flow:
//  1. Decode + check all three required fields present (Express's
//     non-validator early-return is byte-compatible here).
//  2. Pre-check dup via AdminFindUserByUsernameOrEmail.  Hit → 409
//     with the field-specific message ("Username already exists" vs
//     "Email already exists").
//  3. bcrypt-hash via jwtx.HashPassword (cost=10).
//  4. AdminCreateUser → 201 with {_id, username, email}.
//  5. Unique-violation race (23505) maps to the same 409 as pre-check.
func (h *UserHandlers) CreateUser(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), userQueryTimeout)
	defer cancel()

	var req createUserReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// Body parse failure is a different shape from "field missing"
		// — Express never reaches the missing-fields branch on a JSON
		// decode error, so we return BAD_REQUEST with a generic body
		// message that doesn't conflict with the missing-field 中文.
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidRequestBody))
		return
	}

	if req.Username == "" || req.Email == "" || req.Password == "" {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgMissingFields))
		return
	}

	// G6 — normalise email to lowercase before any DB touch.  Mirrors
	// auth.Register; users_email_lowercase_chk (migration 0009) is
	// defense-in-depth — handler is canonical normaliser.
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	username := req.Username
	email := req.Email
	dup, err := h.db.AdminFindUserByUsernameOrEmail(ctx, &username, &email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "duplicate check failed"))
		return
	}
	if err == nil {
		// Found a dup — Express logic:  if existing.username === username
		// the conflict is on username, otherwise it's on email.
		httpx.Fail(w, httpx.NewError(http.StatusConflict, httpx.CodeConflict, dupMessage(dup.Username, req.Username)))
		return
	}

	hash, err := jwtx.HashPassword(req.Password)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "password hash failed"))
		return
	}

	row, err := h.db.AdminCreateUser(ctx, req.Username, req.Email, hash)
	if err != nil {
		if isUniqueViolation(err) {
			// Race: pre-check passed but the INSERT hit the unique
			// index.  We don't know which field collided — Postgres
			// PgError.ConstraintName would tell us if we wired it, but
			// re-running the lookup is simpler and matches what the
			// pre-check did.  Best-effort:  do another lookup to pick
			// the correct field message; on lookup failure default to
			// username conflict (the more common collision in admin
			// workflows where the admin re-uses an existing handle).
			msg := raceConflictMessage(ctx, h.db, req.Username, req.Email)
			httpx.Fail(w, httpx.NewError(http.StatusConflict, httpx.CodeConflict, msg))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "create user failed"))
		return
	}

	// Express logs the admin action with the admin's username.  Pull
	// it from claims if present — admin routes always run behind
	// RequireAuth so this is the production path; defensive against
	// claim absence so unit tests without claims don't crash.
	if claims, ok := jwtx.ClaimsFrom(r.Context()); ok {
		slog.InfoContext(r.Context(), "admin created user",
			"admin", claims.Username, "username", row.Username)
	}

	httpx.Data(w, http.StatusCreated, createUserResp{
		ID:       row.ID,
		Username: row.Username,
		Email:    row.Email,
	})
}

// updateUserReq is the JSON body shape for PATCH /api/admin/users/:userId.
// Both fields are optional — but at least one must be present.  Express
// returns 400 if both are missing OR both are empty strings; we mirror
// that with a single conditional below.
type updateUserReq struct {
	Username string `json:"username,omitempty"`
	Email    string `json:"email,omitempty"`
}

// updateUserResp is the success body for PATCH /api/admin/users/:userId.
// Matches Express's .select('username email role createdAt') projection:
//
//	{ _id, username, email, role|null, createdAt }
//
// CreatedAt serializes as an RFC3339 string (pgtype.Timestamptz default).
type updateUserResp struct {
	ID        uuid.UUID          `json:"_id"`
	Username  string             `json:"username"`
	Email     string             `json:"email"`
	Role      *string            `json:"role"`
	CreatedAt pgtype.Timestamptz `json:"createdAt"`
}

// UpdateUser implements PATCH /api/admin/users/:userId.
//
// Flow:
//  1. Parse :userId path param as UUID; invalid → 400 BAD_REQUEST.
//  2. Decode body; both username + email empty → 400 BAD_REQUEST.
//  3. Pre-check dup excluding the target user id via
//     AdminFindUserByUsernameOrEmailExcluding.  Hit → 409.
//  4. AdminUpdateUser using COALESCE — nil for any field the caller
//     didn't send means "no change".
//  5. ErrNoRows from the UPDATE → 404.  (Postgres `UPDATE ... RETURNING`
//     emits ErrNoRows when the WHERE clause matched zero rows, which is
//     exactly the case where userId doesn't exist.)
func (h *UserHandlers) UpdateUser(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), userQueryTimeout)
	defer cancel()

	userID, ok := parseUserID(w, r)
	if !ok {
		return
	}

	var req updateUserReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidRequestBody))
		return
	}

	if req.Username == "" && req.Email == "" {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgAtLeastOne))
		return
	}

	// Build *string pointers — nil means "skip this field" in the
	// AdminUpdateUser COALESCE() pattern.  Empty string is treated the
	// same as absent so a caller sending `{"username":""}` doesn't
	// accidentally clear the column.
	var usernamePtr, emailPtr *string
	if req.Username != "" {
		v := req.Username
		usernamePtr = &v
	}
	// G6 — normalise update email to lowercase (defense-in-depth
	// matches CHECK in migration 0009).
	if req.Email != "" {
		req.Email = strings.ToLower(strings.TrimSpace(req.Email))
		v := req.Email
		emailPtr = &v
	}

	dup, err := h.db.AdminFindUserByUsernameOrEmailExcluding(ctx, usernamePtr, emailPtr, userID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "duplicate check failed"))
		return
	}
	if err == nil {
		// Same field-resolution logic as CreateUser.  We compare the
		// dup row's username to the *requested* username — if they
		// match, the conflict was on username; otherwise it's on email.
		httpx.Fail(w, httpx.NewError(http.StatusConflict, httpx.CodeConflict, dupMessage(dup.Username, req.Username)))
		return
	}

	row, err := h.db.AdminUpdateUser(ctx, usernamePtr, emailPtr, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return
		}
		// Late-stage unique violation can still occur if a parallel
		// CreateUser slips in between our pre-check and the UPDATE.
		// Map to 409 with username-default messaging.
		if isUniqueViolation(err) {
			msg := raceConflictMessageForUpdate(ctx, h.db, req.Username, req.Email, userID)
			httpx.Fail(w, httpx.NewError(http.StatusConflict, httpx.CodeConflict, msg))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "update user failed"))
		return
	}

	if claims, ok := jwtx.ClaimsFrom(r.Context()); ok {
		slog.InfoContext(r.Context(), "admin updated user",
			"admin", claims.Username, "username", row.Username)
	}

	httpx.Data(w, http.StatusOK, updateUserResp{
		ID:        row.ID,
		Username:  row.Username,
		Email:     row.Email,
		Role:      row.Role,
		CreatedAt: row.CreatedAt,
	})
}

// deleteUserResp is the success body for DELETE /api/admin/users/:userId.
// Matches Express:  { deleted: true, username }.
type deleteUserResp struct {
	Deleted  bool   `json:"deleted"`
	Username string `json:"username"`
}

// DeleteUser implements DELETE /api/admin/users/:userId.
//
// Flow:
//  1. Parse :userId path param as UUID; invalid → 400 BAD_REQUEST.
//  2. Pull current admin's user id from claims; if :userId equals
//     claims.UserID → 400 BAD_REQUEST "Cannot delete yourself".  Matches
//     Express's req.params.userId === req.user.userId guard.
//  3. GetUserByID — if pgx.ErrNoRows → 404 NOT_FOUND.  Express does
//     this same lookup so it can echo the deleted username in the
//     response; we keep the read to preserve that affordance.
//  4. AdminDeleteUser — Postgres ON DELETE CASCADE removes
//     subscriptions / follows / comments / danmakus in one statement
//     (Express had to run four parallel deleteMany calls; PG schema
//     made that unnecessary, see migrations/0001_init.up.sql).
//  5. 200 with { deleted: true, username }.
func (h *UserHandlers) DeleteUser(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), userQueryTimeout)
	defer cancel()

	userID, ok := parseUserID(w, r)
	if !ok {
		return
	}

	claims, hasClaims := jwtx.ClaimsFrom(r.Context())
	if !hasClaims || claims == nil {
		// Routing bug — admin routes should be behind RequireAuth +
		// RequireAdmin, so claims must be present.  Surface as 500 so
		// the operator notices the misconfiguration; we deliberately
		// do NOT treat this as a 403 because that would mask a wiring
		// error as a permissions error.
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, httpx.CodeServerError, "missing auth claims"))
		return
	}

	if claims.UserID == userID {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgCannotDeleteSelf))
		return
	}

	user, err := h.db.GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "user lookup failed"))
		return
	}

	if err := h.db.AdminDeleteUser(ctx, userID); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "delete user failed"))
		return
	}

	slog.InfoContext(r.Context(), "admin deleted user",
		"admin", claims.Username, "username", user.Username)

	httpx.Data(w, http.StatusOK, deleteUserResp{
		Deleted:  true,
		Username: user.Username,
	})
}

// setPasswordReq is the JSON body for POST /api/admin/users/:userId/password.
type setPasswordReq struct {
	Password string `json:"password"`
}

// SetUserPassword implements POST /api/admin/users/:userId/password.
//
// Admin-initiated password change for any account. Flow:
//  1. Parse :userId (400 on bad UUID).
//  2. Decode {password}; require >= 6 chars (matches the register rule).
//  3. GetUserByID — 404 if the account doesn't exist (the UPDATE is a
//     silent no-op on a missing id, so check first to return a real 404).
//  4. bcrypt-hash via jwtx.HashPassword (cost=10).
//  5. AdminSetUserPassword — writes the hash + nulls refresh_token so the
//     target's existing sessions are invalidated (forces re-login).
//  6. 200 { success: true }.
func (h *UserHandlers) SetUserPassword(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), userQueryTimeout)
	defer cancel()

	userID, ok := parseUserID(w, r)
	if !ok {
		return
	}

	var req setPasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidRequestBody))
		return
	}
	if len(req.Password) < 6 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgPasswordTooShort))
		return
	}

	user, err := h.db.GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "user lookup failed"))
		return
	}

	hash, err := jwtx.HashPassword(req.Password)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "password hash failed"))
		return
	}

	if err := h.db.AdminSetUserPassword(ctx, userID, hash); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "set password failed"))
		return
	}

	if claims, ok := jwtx.ClaimsFrom(r.Context()); ok {
		slog.InfoContext(r.Context(), "admin set user password",
			"admin", claims.Username, "username", user.Username)
	}

	httpx.Data(w, http.StatusOK, map[string]bool{"success": true})
}

// parseUserID extracts :userId from the chi route and returns it as a
// uuid.UUID.  Writes a 400 envelope on parse failure and returns ok=false
// so the caller can early-return without writing additional output.
func parseUserID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	raw := chi.URLParam(r, "userId")
	id, err := uuid.Parse(raw)
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidUserID))
		return uuid.Nil, false
	}
	return id, true
}

// dupMessage selects the right conflict string by comparing the
// existing row's username to the requested username.  Mirrors the
// Express logic:
//
//	const field = existing.username === username ? 'Username' : 'Email';
//	`${field} already exists`
//
// The semantics: if the dup row's username equals the user's *requested*
// username, the conflict is on username; otherwise it's on email.  This
// correctly handles the three cases:
//   - both fields conflict on the same row: returns "Username already
//     exists" (Express preference — the username message takes precedence).
//   - only username conflicts: returns "Username already exists".
//   - only email conflicts: returns "Email already exists".
func dupMessage(existingUsername, requestedUsername string) string {
	if existingUsername == requestedUsername {
		return msgUsernameConflict
	}
	return msgEmailConflict
}

// raceConflictMessage runs a fresh lookup after a unique-violation race
// to pick the right conflict message.  Used by CreateUser when the
// INSERT fails on 23505 even though the pre-check returned ErrNoRows
// (parallel admin operation slipped in between).  Best-effort: on
// lookup failure default to username conflict (the more common case).
func raceConflictMessage(ctx context.Context, db UserDB, username, email string) string {
	usernamePtr := &username
	emailPtr := &email
	row, err := db.AdminFindUserByUsernameOrEmail(ctx, usernamePtr, emailPtr)
	if err != nil {
		// Lookup failed — return the conservative default.
		return msgUsernameConflict
	}
	return dupMessage(row.Username, username)
}

// raceConflictMessageForUpdate is the UpdateUser counterpart to
// raceConflictMessage.  Uses the excluding variant so we don't match
// the row we're trying to update.
func raceConflictMessageForUpdate(ctx context.Context, db UserDB, username, email string, excludeID uuid.UUID) string {
	var usernamePtr, emailPtr *string
	if username != "" {
		usernamePtr = &username
	}
	if email != "" {
		emailPtr = &email
	}
	row, err := db.AdminFindUserByUsernameOrEmailExcluding(ctx, usernamePtr, emailPtr, excludeID)
	if err != nil {
		return msgUsernameConflict
	}
	return dupMessage(row.Username, username)
}

// isUniqueViolation returns true if err is a *pgconn.PgError with the
// 23505 SQLSTATE.  Reuses the same pattern as internal/auth/handlers.go
// — drift-free across packages because both reference the SQLSTATE
// constant directly.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == pgUniqueViolation
	}
	return false
}
