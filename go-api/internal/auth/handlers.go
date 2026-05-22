package auth

// handlers.go — the five /api/auth/* HTTP handlers.
//
// Each handler bounds its DB round-trip with a 5s query timeout, decodes
// the request body into the validation-tagged struct, runs the
// validator, and writes a byte-compatible httpx envelope on the response.
//
// Port targets server/controllers/auth.controller.js — error codes and
// Chinese messages must match the Express output byte-for-byte so the
// shadow-traffic diff at cutover passes.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// queryTimeout bounds every handler's database round-trip.  Five
// seconds covers DB contention spikes while still failing fast enough
// that a hung Postgres won't hold a goroutine pool indefinitely.
const queryTimeout = 5 * time.Second

// pgUniqueViolation is the Postgres SQLSTATE for a unique constraint
// failure.  CreateUser races a pre-check against the users_email_key /
// users_username_key indexes; on a tie, the INSERT returns 23505 and
// we map to 400 DUPLICATE just like the pre-check path would have.
const pgUniqueViolation = "23505"

// Local error code constants — httpx.CodeNoToken / CodeInvalidToken
// exist but we re-declare the auth-specific Duplicate + InvalidCreds
// codes here so the handler call sites read self-documenting.  They
// equal the httpx.Code* values for shadow-diff parity.
const (
	codeDuplicate          = httpx.CodeDuplicate
	codeInvalidCredentials = httpx.CodeInvalidCredentials
	codeNoToken            = httpx.CodeNoToken
	codeInvalidToken       = httpx.CodeInvalidToken
	codeValidation         = httpx.CodeValidationError
	codeNotFound           = httpx.CodeNotFound
	codeServerError        = httpx.CodeServerError
)

// Chinese user-facing messages — copied verbatim from
// server/controllers/auth.controller.js + server/routes/auth.routes.js.
// Any drift here breaks the shadow-traffic byte-diff at cutover.
const (
	msgDuplicate          = "用户名或邮箱已存在"
	msgInvalidCredentials = "邮箱或密码错误"
	msgNoToken            = "需要重新登录"
	msgInvalidToken       = "无效的 token"
	msgUserNotFound       = "用户不存在"
	msgLoggedOut          = "已登出"
	msgInvalidBody        = "请求体格式错误"

	// Validator field-message map.
	msgUsernameLen       = "用户名需 3-50 个字符"
	msgEmailFormat       = "邮箱格式不正确"
	msgPasswordMin       = "密码至少 6 位"
	msgPasswordRequired  = "密码不能为空"
	msgUsernameRequired  = "用户名需 3-50 个字符"
	msgEmailRequired     = "邮箱格式不正确"
	msgValidationGeneric = "参数错误"
)

// AuthDB is the sqlc subset that auth handlers consume.  Defined here
// (where it's used) per Go's "accept interfaces, return structs" idiom
// — handler tests substitute a fakeAuthDB without depending on the full
// dbgen.Querier surface.
type AuthDB interface {
	CreateUser(ctx context.Context, username, email, password string) (dbgen.User, error)
	GetUserByEmail(ctx context.Context, email string) (dbgen.User, error)
	GetUserByUsername(ctx context.Context, username string) (dbgen.User, error)
	GetUserByID(ctx context.Context, id uuid.UUID) (dbgen.User, error)
	UpdateUserRefreshToken(ctx context.Context, id uuid.UUID, refreshToken *string) error
}

// Handlers carries deps shared by all auth handlers.  Construct once at
// startup via NewHandlers and register each method on the chi router.
type Handlers struct {
	db         AuthDB
	signer     *jwtx.Signer
	isProd     bool
	refreshTTL time.Duration
	validator  *validator.Validate
}

// NewHandlers constructs a Handlers bundle.  refreshTTL must match the
// Signer's refresh-token TTL so the cookie maxAge and the JWT exp align
// — drift here causes the cookie to outlive the token (frustrating user
// experience) or vice versa (refresh fails before the cookie expires).
func NewHandlers(db AuthDB, signer *jwtx.Signer, refreshTTL time.Duration, isProd bool) *Handlers {
	return &Handlers{
		db:         db,
		signer:     signer,
		isProd:     isProd,
		refreshTTL: refreshTTL,
		validator:  validator.New(validator.WithRequiredStructEnabled()),
	}
}

// Register implements POST /api/auth/register.
//
// Flow:
//  1. Decode JSON body → RegisterReq.  Parse failure → 400 VALIDATION_ERROR.
//  2. Validate (length / email / min length).  First field error →
//     400 VALIDATION_ERROR with the Chinese message map'd in
//     validationMessage().
//  3. Pre-check email + username uniqueness in parallel via errgroup.
//     Any hit → 400 DUPLICATE_ERROR.
//  4. bcrypt-hash the plaintext password.
//  5. CreateUser.  Unique-violation race → 400 DUPLICATE_ERROR (same as
//     pre-check).
//  6. Sign access + refresh tokens, persist refresh on the user row,
//     set the refresh cookie, respond 201 with {accessToken, user}.
func (h *Handlers) Register(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	var req RegisterReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgInvalidBody))
		return
	}
	if err := h.validator.Struct(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, validationMessage(err)))
		return
	}

	if dup, err := h.checkDuplicate(ctx, req.Email, req.Username); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "duplicate check failed"))
		return
	} else if dup {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeDuplicate, msgDuplicate))
		return
	}

	hash, err := jwtx.HashPassword(req.Password)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "password hash failed"))
		return
	}

	user, err := h.db.CreateUser(ctx, req.Username, req.Email, hash)
	if err != nil {
		// Race condition: pre-check passed but CreateUser hit the
		// unique index.  Treat the same as pre-check duplicate.
		if isUniqueViolation(err) {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeDuplicate, msgDuplicate))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "create user failed"))
		return
	}

	accessToken, refreshToken, err := h.issueTokens(user)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "sign token failed"))
		return
	}

	if err := h.db.UpdateUserRefreshToken(ctx, user.ID, &refreshToken); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "persist refresh token failed"))
		return
	}

	SetRefreshCookie(w, refreshToken, h.refreshTTL, h.isProd)
	httpx.Data(w, http.StatusCreated, AuthData{AccessToken: accessToken, User: ToSafeUser(user)})
}

// Login implements POST /api/auth/login.
//
// On any auth failure (email not found OR password mismatch) the response
// is identical 401 INVALID_CREDENTIALS — no enumeration leak via timing
// or message differentiation.  We do incur a real bcrypt comparison
// only when the user exists; on email miss the function returns early.
// This is acceptable because the dominant signal already exists via the
// register endpoint's DUPLICATE response.
func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	var req LoginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgInvalidBody))
		return
	}
	if err := h.validator.Struct(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, validationMessage(err)))
		return
	}

	user, err := h.db.GetUserByEmail(ctx, req.Email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidCredentials, msgInvalidCredentials))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "user lookup failed"))
		return
	}

	if err := jwtx.ComparePassword(user.Password, req.Password); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidCredentials, msgInvalidCredentials))
		return
	}

	accessToken, refreshToken, err := h.issueTokens(user)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "sign token failed"))
		return
	}

	if err := h.db.UpdateUserRefreshToken(ctx, user.ID, &refreshToken); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "persist refresh token failed"))
		return
	}

	SetRefreshCookie(w, refreshToken, h.refreshTTL, h.isProd)
	httpx.Data(w, http.StatusOK, AuthData{AccessToken: accessToken, User: ToSafeUser(user)})
}

// Refresh implements POST /api/auth/refresh.
//
// Reads the refreshToken cookie, verifies the JWT signature, then
// double-checks the DB-stored refresh_token MATCHES the cookie.  The
// double-check is what closes the "stolen refresh token" window —
// signing a new pair invalidates the previous refresh by writing the
// new one to the user row.  A stolen-but-stale token therefore fails
// the DB-match step.
//
// All failure modes collapse into NO_TOKEN (no cookie) or INVALID_TOKEN
// (any other reason) — no leak of "did JWT verify fail vs DB mismatch".
func (h *Handlers) Refresh(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	c, err := r.Cookie(RefreshCookieName)
	if err != nil || c.Value == "" {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeNoToken, msgNoToken))
		return
	}
	cookieToken := c.Value

	claims, err := h.signer.VerifyRefresh(cookieToken)
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
		return
	}

	user, err := h.db.GetUserByID(ctx, claims.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "user lookup failed"))
		return
	}
	if user.RefreshToken == nil || *user.RefreshToken != cookieToken {
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
		return
	}

	accessToken, refreshToken, err := h.issueTokens(user)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "sign token failed"))
		return
	}

	if err := h.db.UpdateUserRefreshToken(ctx, user.ID, &refreshToken); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "persist refresh token failed"))
		return
	}

	SetRefreshCookie(w, refreshToken, h.refreshTTL, h.isProd)
	httpx.Data(w, http.StatusOK, RefreshData{AccessToken: accessToken})
}

// Logout implements POST /api/auth/logout.  Requires the route to be
// wrapped in jwtx.RequireAuth so the access claims are present in ctx.
//
// Side effects:
//   - DB: nulls users.refresh_token so any stolen refresh cookie is
//     invalidated (the DB-match check in /refresh will fail).
//   - Cookie: ClearRefreshCookie writes a Max-Age=-1 Set-Cookie so the
//     browser drops the cookie immediately.
func (h *Handlers) Logout(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok {
		// Routing bug — Logout should only be reachable via RequireAuth.
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, codeServerError, "missing auth claims"))
		return
	}

	// Best-effort: clear the DB refresh token.  If the user row is
	// gone (deleted between token issue and logout), the UPDATE is a
	// no-op — that's fine, we still clear the cookie.
	if err := h.db.UpdateUserRefreshToken(ctx, claims.UserID, nil); err != nil {
		// Log + continue — logout should still succeed from the
		// user's perspective even if the DB write fails.  The cookie
		// is the dominant credential.
		slog.Warn("auth: logout failed to clear refresh token", "userId", claims.UserID, "err", err)
	}

	ClearRefreshCookie(w, h.isProd)
	httpx.Data(w, http.StatusOK, MessageData{Message: msgLoggedOut})
}

// Me implements GET /api/auth/me.  Requires the route to be wrapped in
// jwtx.RequireAuth.  Returns the full SafeUser projection.
//
// If the user row has been deleted between token issue and this call,
// returns 404 NOT_FOUND — the client treats this as "session is dead,
// log in again".
func (h *Handlers) Me(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, codeServerError, "missing auth claims"))
		return
	}

	user, err := h.db.GetUserByID(ctx, claims.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, codeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "user lookup failed"))
		return
	}

	httpx.Data(w, http.StatusOK, MeData{User: ToSafeUser(user)})
}

// checkDuplicate runs the two uniqueness reads in parallel.  Returns
// (true, nil) if either email or username is already taken.  Pre-check
// is best-effort; the unique index on the table is the authoritative
// gate (handled by isUniqueViolation downstream).
//
// An error from either branch other than pgx.ErrNoRows is fatal — the
// caller surfaces it as a 500 rather than risk silently mis-classifying
// a real DB outage as "duplicate".
func (h *Handlers) checkDuplicate(ctx context.Context, email, username string) (bool, error) {
	g, gctx := errgroup.WithContext(ctx)

	var emailHit, usernameHit bool
	g.Go(func() error {
		_, err := h.db.GetUserByEmail(gctx, email)
		if err == nil {
			emailHit = true
			return nil
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	g.Go(func() error {
		_, err := h.db.GetUserByUsername(gctx, username)
		if err == nil {
			usernameHit = true
			return nil
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})

	if err := g.Wait(); err != nil {
		return false, err
	}
	return emailHit || usernameHit, nil
}

// issueTokens signs an access + refresh pair for the given user.
// Centralized so the three callers (Register, Login, Refresh) emit
// identical token shapes.
func (h *Handlers) issueTokens(user dbgen.User) (string, string, error) {
	accessToken, err := h.signer.SignAccess(user.ID, user.Username, user.Role)
	if err != nil {
		return "", "", err
	}
	refreshToken, err := h.signer.SignRefresh(user.ID)
	if err != nil {
		return "", "", err
	}
	return accessToken, refreshToken, nil
}

// isUniqueViolation returns true if err is a pgconn.PgError with the
// 23505 SQLSTATE.  Used by Register to map a race-condition INSERT
// failure to the same 400 DUPLICATE as the pre-check path.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == pgUniqueViolation
	}
	return false
}

// validationMessage maps the FIRST validator FieldError on a struct to
// the Chinese message Express's express-validator middleware would have
// emitted.  Matching this byte-for-byte is required because the front-
// end consumes the message string directly in toast UI.
//
// Falls back to msgValidationGeneric for any tag/field combination we
// haven't explicitly mapped — better to ship a generic message than to
// leak the validator's stock English message into the response.
func validationMessage(err error) string {
	var verrs validator.ValidationErrors
	if !errors.As(err, &verrs) || len(verrs) == 0 {
		return msgValidationGeneric
	}
	first := verrs[0]
	field := first.Field()
	tag := first.Tag()

	switch field {
	case "Username":
		switch tag {
		case "required":
			return msgUsernameRequired
		case "min", "max":
			return msgUsernameLen
		}
	case "Email":
		switch tag {
		case "required":
			return msgEmailRequired
		case "email":
			return msgEmailFormat
		}
	case "Password":
		switch tag {
		case "required":
			return msgPasswordRequired
		case "min":
			return msgPasswordMin
		}
	}
	return msgValidationGeneric
}
