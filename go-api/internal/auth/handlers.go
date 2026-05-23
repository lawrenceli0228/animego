package auth

// handlers.go — the five /api/auth/* HTTP handlers.
//
// Each handler bounds its DB round-trip with a 5s query timeout, decodes
// the request body into the validation-tagged struct, runs the
// validator, and writes the canonical httpx envelope on the response.
//
// Error codes match the Express enum; the `message` strings are English
// — the frontend's i18n layer maps them to localized text.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/email"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// queryTimeout bounds every handler's database round-trip.  Five
// seconds covers DB contention spikes while still failing fast enough
// that a hung Postgres won't hold a goroutine pool indefinitely.
const queryTimeout = 5 * time.Second

// resetPasswordTokenTTL is how long a forgot-password token stays valid.
// One hour matches Express server/controllers/auth.controller.js.
const resetPasswordTokenTTL = time.Hour

// resetPasswordTokenBytes is the entropy of the reset token before hex
// encoding.  32 random bytes → 64-char hex output.  Matches Express's
// `crypto.randomBytes(32).toString('hex')`.
const resetPasswordTokenBytes = 32

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

// User-facing messages — emitted in English; the frontend i18n layer
// maps each string to a localized translation keyed on the English text.
const (
	msgDuplicate          = "Username or email already exists"
	msgInvalidCredentials = "Invalid email or password"
	msgNoToken            = "Please log in again"
	msgInvalidToken       = "Invalid token"
	msgUserNotFound       = "User not found"
	msgLoggedOut          = "Logged out"
	msgInvalidBody        = "Invalid request body"

	// Password-reset flow messages — `msgForgotPasswordGeneric` is
	// intentionally identical for the real-user and not-found paths to
	// prevent email enumeration via response-shape diff.  See
	// ForgotPassword for the timing-channel trade-off discussion.
	msgForgotPasswordGeneric = "If the email is registered, you will receive a reset link"
	msgResetTokenInvalid     = "The link is invalid or has expired, please request a new one"
	msgResetPasswordSuccess  = "Password has been reset, please log in again"

	// Validator field-message map.
	msgUsernameLen       = "Username must be 3-50 characters"
	msgEmailFormat       = "Invalid email format"
	msgPasswordMin       = "Password must be at least 6 characters"
	msgPasswordRequired  = "Password is required"
	msgUsernameRequired  = "Username must be 3-50 characters"
	msgEmailRequired     = "Invalid email format"
	msgValidationGeneric = "Invalid request"
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

	// Password-reset write/read trio.  SetResetPasswordToken is called
	// by ForgotPassword to stage a token + 1h expiry.  GetUserByResetToken
	// is the atomic "token-valid AND not-expired" lookup used by
	// ResetPassword.  ResetUserPassword writes the new bcrypt hash and
	// in one shot clears reset_token + reset_expires + refresh_token
	// (the last bit kicks every existing session so a stolen refresh
	// cookie is immediately invalidated).
	SetResetPasswordToken(ctx context.Context, id uuid.UUID, resetPasswordToken *string, resetPasswordExpires pgtype.Timestamptz) error
	GetUserByResetToken(ctx context.Context, resetPasswordToken *string) (dbgen.User, error)
	ResetUserPassword(ctx context.Context, id uuid.UUID, password string) error
}

// Handlers carries deps shared by all auth handlers.  Construct once at
// startup via NewHandlers and register each method on the chi router.
//
// email + clientOrigin are required by ForgotPassword to assemble the
// reset URL emailed to the user.  An unconfigured Gmail (NoopSender)
// is acceptable — the request still returns 200 (matches Express's
// silent-skip behavior when GMAIL_USER/GMAIL_APP_PASSWORD is unset).
type Handlers struct {
	db           AuthDB
	signer       *jwtx.Signer
	email        email.Sender
	isProd       bool
	refreshTTL   time.Duration
	clientOrigin string
	validator    *validator.Validate
}

// NewHandlers constructs a Handlers bundle.  refreshTTL must match the
// Signer's refresh-token TTL so the cookie maxAge and the JWT exp align
// — drift here causes the cookie to outlive the token (frustrating user
// experience) or vice versa (refresh fails before the cookie expires).
//
// emailSender may be nil — we substitute email.NoopSender so the
// forgot-password handler never crashes on missing config.
//
// clientOrigin is the front-end origin used to assemble the reset URL
// (e.g. "https://animego.app").  Trailing slash is stripped before use
// so we never emit a double-slash URL.
func NewHandlers(db AuthDB, signer *jwtx.Signer, emailSender email.Sender, clientOrigin string, refreshTTL time.Duration, isProd bool) *Handlers {
	if emailSender == nil {
		emailSender = email.NoopSender{}
	}
	return &Handlers{
		db:           db,
		signer:       signer,
		email:        emailSender,
		isProd:       isProd,
		refreshTTL:   refreshTTL,
		clientOrigin: clientOrigin,
		validator:    validator.New(validator.WithRequiredStructEnabled()),
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

	// G6 — normalise email to lowercase before any DB touch.  The
	// users_email_lowercase_chk constraint added in migration 0009 is
	// defense-in-depth; the application layer is the canonical source
	// of normalisation so the user-facing error stays "Username or
	// email already exists" instead of leaking a CHECK violation.
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

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

	// G6 — match lookup against the lowercase canonical form (rows
	// are stored lowercase by Register + admin CreateUser).
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

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

// ForgotPassword implements POST /api/auth/forgot-password.
//
// Privacy: ALWAYS returns 200 with the same generic message regardless
// of whether the email matches a registered user.  Prevents email
// enumeration via response shape.
//
// Timing-channel note: the lookup runs for every input but the
// token-generation + DB write + (best-effort) email send only happens
// when the user actually exists.  This is the same trade-off Express
// makes — the absolute timing diff is small enough that practical
// enumeration attacks would lean on response-shape signals instead,
// and we close those.  Adding constant-time padding here would slow
// every request to the worst-case path; not worth the latency.
//
// Token: 32 random bytes → 64-char lowercase hex string.  TTL 1 hour.
//
// Email-send failures are LOGGED but never bubble to the client.  An
// unconfigured Gmail (email.NoopSender) is treated as success.
//
// Validation:
//   - email: required + RFC 5322 → "Invalid email format" on miss
//
// Response (200, both real-user and not-found paths):
//
//	{"data":{"message":"If the email is registered, you will receive a reset link"}}
func (h *Handlers) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	var req ForgotPasswordReq
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
			// Unknown email — same 200, no enumeration leak.
			writeForgotPasswordSuccess(w)
			return
		}
		// Database trouble.  Log for operators but still return the
		// generic 200 — privacy trumps debuggability on the client side
		// (the operator has the slog line; the attacker has nothing).
		slog.WarnContext(ctx, "auth: forgot-password user lookup failed", "err", err)
		writeForgotPasswordSuccess(w)
		return
	}

	// Generate the reset token.  crypto/rand.Read is the only source
	// suitable for security tokens — math/rand would be predictable.
	var raw [resetPasswordTokenBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// crypto/rand failing is a serious system issue; we don't try
		// to hide this behind a 200.  Surface as 500.
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "rand failed"))
		return
	}
	token := hex.EncodeToString(raw[:])

	expires := pgtype.Timestamptz{Time: time.Now().Add(resetPasswordTokenTTL), Valid: true}
	if err := h.db.SetResetPasswordToken(ctx, user.ID, &token, expires); err != nil {
		// DB write failure — log + still return 200 (matches the
		// "always-200" contract).  The operator sees the failure in
		// slog; the user sees "if registered, check your email"
		// followed by … silence, which is acceptable for the rare DB
		// outage case.  An alternative would be to surface 500 here,
		// but that gives the attacker a probe to detect outage windows.
		slog.WarnContext(ctx, "auth: forgot-password SetResetPasswordToken failed",
			"userId", user.ID, "err", err)
		writeForgotPasswordSuccess(w)
		return
	}

	// Build the reset URL.  TrimRight on clientOrigin guarantees we
	// never emit a double-slash if the operator configured the origin
	// with a trailing slash.
	resetURL := fmt.Sprintf("%s/reset-password/%s", strings.TrimRight(h.clientOrigin, "/"), token)
	if err := h.email.SendPasswordReset(ctx, user.Email, resetURL); err != nil {
		// Best-effort send.  Log + ignore — the privacy contract
		// matters more than telling the user "we tried to email you
		// but our SMTP relay timed out".
		slog.WarnContext(ctx, "auth: forgot-password email send failed",
			"userId", user.ID, "err", err)
	}

	writeForgotPasswordSuccess(w)
}

// ResetPassword implements POST /api/auth/reset-password/:token.
//
// Token comes from URL path (chi.URLParam), NOT the body.  Validates
// body password (min 6) then looks up the user by token + not-expired
// in one SQL via GetUserByResetToken.
//
// On success: ResetUserPassword writes a new bcrypt hash and in one
// statement clears reset_token + reset_expires + refresh_token — the
// last clear forces every active session to re-authenticate.
//
// Response messages:
//
//	400 VALIDATION_ERROR "Password must be at least 6 characters"
//	400 INVALID_TOKEN    "The link is invalid or has expired, please request a new one"
//	200 success          {"data":{"message":"Password has been reset, please log in again"}}
//
// Note: expired-token and never-existed-token both surface as
// pgx.ErrNoRows (the SQL filters `reset_password_expires > now()` in
// the same SELECT).  We deliberately use the SAME 400 message for
// both — leaking "expired vs never existed" would help an attacker
// probe whether a given token ever lived.
func (h *Handlers) ResetPassword(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	token := chi.URLParam(r, "token")
	if token == "" {
		// The chi route pattern enforces non-empty token; this branch
		// only fires when a test calls the handler outside the chi
		// router.  We still respond predictably.
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeInvalidToken, msgResetTokenInvalid))
		return
	}

	var req ResetPasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgInvalidBody))
		return
	}
	if err := h.validator.Struct(&req); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, validationMessage(err)))
		return
	}

	user, err := h.db.GetUserByResetToken(ctx, &token)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeInvalidToken, msgResetTokenInvalid))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "reset token lookup failed"))
		return
	}

	hash, err := jwtx.HashPassword(req.Password)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "password hash failed"))
		return
	}

	if err := h.db.ResetUserPassword(ctx, user.ID, hash); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "reset password failed"))
		return
	}

	httpx.Data(w, http.StatusOK, MessageData{Message: msgResetPasswordSuccess})
}

// writeForgotPasswordSuccess centralizes the 200 envelope used by every
// ForgotPassword response path (user-found, user-not-found, db-error,
// email-send-error).  Keeping a single emitter ensures the byte-exact
// message can never drift between branches — drift would itself be a
// signal an attacker could use to enumerate emails.
func writeForgotPasswordSuccess(w http.ResponseWriter) {
	httpx.Data(w, http.StatusOK, MessageData{Message: msgForgotPasswordGeneric})
}

// validationMessage maps the FIRST validator FieldError on a struct to
// the user-facing English message the frontend i18n layer translates.
//
// Falls back to msgValidationGeneric for any tag/field combination we
// haven't explicitly mapped — better to ship a generic message than to
// leak the validator's stock library English message into the response.
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
