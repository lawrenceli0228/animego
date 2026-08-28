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
	"github.com/lawrenceli0228/animego/go-api/internal/pii"
)

// queryTimeout bounds every handler's database round-trip.  Five
// seconds covers DB contention spikes while still failing fast enough
// that a hung Postgres won't hold a goroutine pool indefinitely.
const queryTimeout = 5 * time.Second

// refreshGraceWindow is how long the immediately-previous refresh token
// is accepted after rotation.  Near-simultaneous refresh requests
// (Next.js RSC prefetch + navigation) can race: the first rotates the
// token, the second arrives with the old value.  Within this window the
// handler issues a new ACCESS token and re-sets the refresh cookie to
// the CURRENT token — no re-rotation — so the client catches up.
const refreshGraceWindow = 30 * time.Second

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

	// The username is a public display name and the /u/{username} routing
	// key; the email is only ever a way to recover the account.  Letting
	// one be the other published contact details into anonymous endpoints
	// and, through the watchers list, into the CDN-cached /anime/{id}
	// page.  See internal/pii.
	msgUsernameLooksLikeContact = "Username cannot be an email address or a phone number — it is shown publicly"
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

	// ClearRefreshTokenIfMatches is logout's write.  It is a separate query
	// from UpdateUserRefreshToken(nil) rather than a parameter on it, because
	// the two have different authority: login OWNS the row and writes
	// unconditionally, while logout is authenticated only by a signature that
	// outlives the token it signs, so it may only clear the session it can
	// still prove it holds.  Returns rows affected; 0 is a normal outcome.
	ClearRefreshTokenIfMatches(ctx context.Context, id uuid.UUID, presentedToken *string) (int64, error)

	// RotateRefreshToken moves current→previous and writes the new token,
	// but only when the current token is still expectedToken — a
	// compare-and-swap.  Returns the row's username and role so the caller
	// can sign an access token without a separate read.
	//
	// pgx.ErrNoRows means the swap matched nothing: the cookie lost a
	// rotation race, the user logged out, or a password change nulled the
	// column.  That is NOT an error — the caller re-reads the row once and
	// falls through to the grace window.  Anything else is a real failure.
	//
	// Argument order follows sqlc's generated positional signature
	// (newToken, id, expectedToken).  The two *string parameters are the
	// swap hazard: reversing them compiles and passes every stub test,
	// but the CAS would then match nothing and every refresh would fall to
	// grace.  Only asserting that the row actually changed catches it —
	// test/integration/user_session_columns_test.go does, deliberately
	// including a reversed call so the hazard is stated rather than implied.
	RotateRefreshToken(ctx context.Context, newToken *string, id uuid.UUID, expectedToken *string) (dbgen.RotateRefreshTokenRow, error)

	// Password-reset write/read trio.  SetResetPasswordToken is called
	// by ForgotPassword to stage a token + 1h expiry.  GetUserByResetToken
	// is the atomic "token-valid AND not-expired" lookup used by
	// ResetPassword.  ResetUserPassword writes the new bcrypt hash and in
	// one shot clears reset_token + reset_expires + all three refresh-session
	// columns, so a stolen refresh cookie stops working — including the grace
	// slot, which an earlier version left loaded and therefore honored for 30 s
	// past the reset.  It does NOT reach access tokens: a JWT already issued
	// stays valid until accessTTL expires (15m default).
	SetResetPasswordToken(ctx context.Context, id uuid.UUID, resetPasswordToken *string, resetPasswordExpires pgtype.Timestamptz) error
	GetUserByResetToken(ctx context.Context, resetPasswordToken *string) (dbgen.User, error)
	ResetUserPassword(ctx context.Context, id uuid.UUID, password string) error

	// Self-serve account mutations (PATCH /api/auth/me + change-password).
	// UpdateUsername surfaces 23505 on the username unique index → 409
	// DUPLICATE. SetUserAvatar / SetUserBackdrop take nil to clear.
	UpdateUsername(ctx context.Context, id uuid.UUID, username string) (dbgen.User, error)
	SetUserAvatar(ctx context.Context, id uuid.UUID, avatarUrl *string) error
	SetUserBackdrop(ctx context.Context, id uuid.UUID, backdropAnilistID *int32) error
	SetUserPublic(ctx context.Context, id uuid.UUID, isPublic bool) error
	UpdateUserPassword(ctx context.Context, id uuid.UUID, password string) error

	// GetAnimeImages resolves the chosen backdrop anime → banner + cover so
	// /me + PATCH /me can theme the navbar avatar mini-card.
	GetAnimeImages(ctx context.Context, anilistID int32) (dbgen.GetAnimeImagesRow, error)
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
	accessTTL    time.Duration
	refreshTTL   time.Duration
	clientOrigin string
	validator    *validator.Validate
	// avatarDir is the volume path where uploaded pass photos are written
	// (set via SetAvatarDir at startup). Empty in tests that don't exercise
	// avatar upload.
	avatarDir string
	// loginObserver counts successful logins for the activity dashboard.
	// nil when nothing is watching — every call site guards.
	loginObserver LoginObserver
}

// SetAvatarDir configures where UpdateMe writes uploaded avatar files.
// Called once at startup after NewHandlers.
func (h *Handlers) SetAvatarDir(dir string) { h.avatarDir = dir }

// LoginObserver is told when a password authentication succeeds.
//
// Narrow on purpose — one method, no error return, no context — because the
// only implementation (internal/activity.Recorder) writes to an in-memory
// buffer and genuinely cannot fail or block.  A wider interface would invite a
// future implementation that can do both, on the path where a user is waiting
// to be let in.
type LoginObserver interface {
	Login(userID uuid.UUID, at time.Time)
}

// SetLoginObserver attaches the observer notified by Login.
//
// A post-construction setter rather than a constructor parameter, following
// SetAvatarDir: NewHandlers already takes seven arguments and is called from
// several tests that have no interest in this.  nil (the default) means
// nobody is watching.
//
// Why logins are observed here rather than by the recorder's own middleware:
// that middleware only sees requests that already carry a valid token, and by
// definition nobody holds one when they are logging in.  Without this hook the
// single event that most clearly means "a human deliberately came back" would
// be the one event the activity record could not see.
func (h *Handlers) SetLoginObserver(obs LoginObserver) { h.loginObserver = obs }

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
func NewHandlers(db AuthDB, signer *jwtx.Signer, emailSender email.Sender, clientOrigin string, accessTTL, refreshTTL time.Duration, isProd bool) *Handlers {
	if emailSender == nil {
		emailSender = email.NoopSender{}
	}
	return &Handlers{
		db:           db,
		signer:       signer,
		email:        emailSender,
		isProd:       isProd,
		accessTTL:    accessTTL,
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

	// The username is public (display name + /u/{username} route) while the
	// email exists only to recover the account.  Nothing used to stop the
	// two from being the same string, and users did exactly that, which put
	// live addresses and phone numbers into anonymous endpoints.  Rejecting
	// at registration stops new ones; internal/pii masks the existing rows
	// on the way out.
	if pii.LooksLikeContact(req.Username) {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgUsernameLooksLikeContact))
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
	SetSessionCookie(w, accessToken, h.accessTTL, h.isProd)
	SetAuthHintCookie(w, h.refreshTTL, h.isProd)
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
	SetSessionCookie(w, accessToken, h.accessTTL, h.isProd)
	SetAuthHintCookie(w, h.refreshTTL, h.isProd)

	// Counted only after every failure path above has been passed, so the
	// number means "somebody got in" rather than "somebody tried".  Placed
	// after the cookies rather than before, so a panic in cookie-setting could
	// never leave a login recorded that the user did not receive.
	if h.loginObserver != nil {
		h.loginObserver.Login(user.ID, time.Now())
	}

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

	// NORMAL path: try to rotate straight away.  The CAS predicate inside
	// RotateRefreshToken is what checks "the cookie is still the current
	// token", so there is nothing to pre-read — RETURNING hands back the
	// username and role SignAccess needs.  Happy path is one statement.
	newRefresh, err := h.signer.SignRefresh(claims.UserID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "sign token failed"))
		return
	}

	rotated, err := h.db.RotateRefreshToken(ctx, &newRefresh, claims.UserID, &cookieToken)
	switch {
	case err == nil:
		accessToken, sErr := h.signer.SignAccess(claims.UserID, rotated.Username, rotated.Role)
		if sErr != nil {
			httpx.Fail(w, httpx.WrapError(sErr, http.StatusInternalServerError, codeServerError, "sign token failed"))
			return
		}
		SetRefreshCookie(w, newRefresh, h.refreshTTL, h.isProd)
		SetSessionCookie(w, accessToken, h.accessTTL, h.isProd)
		SetAuthHintCookie(w, h.refreshTTL, h.isProd)
		httpx.Data(w, http.StatusOK, RefreshData{AccessToken: accessToken})
		return

	case !errors.Is(err, pgx.ErrNoRows):
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "persist refresh token failed"))
		return
	}

	// CAS matched nothing.  Three things look identical from here — the
	// cookie lost a rotation race, the user logged out, or a password
	// change nulled the column — and all three are answered by the same
	// question: does the grace slot still recognise this cookie?
	//
	// The row MUST be re-read.  Whatever state we might have loaded before
	// the CAS is by definition stale (something changed the row between the
	// read and the write, which is why the CAS missed), and judging the
	// grace window on stale token columns is the same class of bug the CAS
	// exists to remove.  Re-read exactly once: /refresh shares one rate
	// bucket for all SSR traffic, so a retry loop here is self-inflicted
	// load, and a second miss means the row is moving faster than a 401
	// costs to recover from.
	user, err := h.db.GetUserByID(ctx, claims.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "user lookup failed"))
		return
	}

	// GRACE path: cookie matches the previous token and is still within
	// the 30 s grace window.  Issue a new access token; re-set the
	// refresh cookie to the CURRENT token so the client catches up.
	// Do NOT call RotateRefreshToken — re-rotating here would overwrite
	// the previous slot with the token the client just sent, which is
	// already stale on the other concurrent request.
	// user.RefreshToken != nil guards the dereference ~15 lines below, where
	// the current token is written back into the cookie.  "previous matches,
	// current is NULL" used to be a state the DB really produced:
	// ResetUserPassword and AdminSetUserPassword nulled refresh_token while
	// leaving previous_refresh_token and refresh_rotated_at loaded, and
	// reaching the grace body in that state panicked into a 500 via the
	// Recoverer for up to 30 s after any password change.
	//
	// Those statements now clear all three columns, so no write path produces
	// the combination any more and this conjunct should be unreachable.  It
	// stays deliberately.  "Unreachable" here is a property of four SQL
	// statements agreeing with each other, not of anything the type system
	// enforces, and the cost of being wrong is a panic on an unauthenticated
	// route.  Deleting it would also silently re-arm the old bug the first
	// time someone adds a fifth statement that forgets a column.
	if user.RefreshToken != nil &&
		user.PreviousRefreshToken != nil &&
		*user.PreviousRefreshToken == cookieToken &&
		user.RefreshRotatedAt.Valid &&
		time.Since(user.RefreshRotatedAt.Time) < refreshGraceWindow {

		accessToken, _, err := h.issueTokens(user)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "sign token failed"))
			return
		}

		// Re-set refresh cookie to the CURRENT token (the one that won
		// the rotation race) so the client aligns after this response.
		SetRefreshCookie(w, *user.RefreshToken, h.refreshTTL, h.isProd)
		SetSessionCookie(w, accessToken, h.accessTTL, h.isProd)
		SetAuthHintCookie(w, h.refreshTTL, h.isProd)
		httpx.Data(w, http.StatusOK, RefreshData{AccessToken: accessToken})
		return
	}

	httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeInvalidToken, msgInvalidToken))
}

// Logout implements POST /api/auth/logout.
//
// ── DELIBERATELY NOT BEHIND jwtx.RequireAuth ──
// Logging out must always succeed.  The access cookie lives for accessTTL
// (JWT_EXPIRES_IN, 15m by default), so gating this route on a valid access
// token meant a tab left open past that window got a 401 from the
// middleware and THIS FUNCTION NEVER RAN: no Clear-Cookie headers, no DB
// write — while the browser kept a 7-day refresh cookie that proxy.ts
// spends on the very next navigation (needsRefresh(session) is true
// precisely because the access token expired).  The user saw a logged-out
// UI and was silently signed back in.  That failure was deterministic, not
// a race: idle past 15 minutes and it happened every time.
//
// The two side effects have different authentication requirements, so they
// are deliberately separated:
//
//   - Clearing COOKIES needs no authentication.  It only touches the
//     caller's own browser, so the worst a forged request achieves is
//     logging out whoever sent it.  Runs unconditionally, first, before
//     anything can fail.
//
//   - Clearing the DB ROW does need authentication — it ends a session
//     server-side.  It runs only when the refresh cookie carries a
//     signature we minted.  Identity comes from the REFRESH token, not the
//     access token, because the refresh token is the credential that
//     outlives the access window; that is the whole point of the change.
//
// Always answers 200.  Whether a cookie was present, parseable, or matched
// a live user is not something an unauthenticated caller gets to learn.
//
// CSRF note: the cookies are SameSite=None in prod (cookies.go — required
// for the SSR fetch), so a cross-site POST here does carry them and can
// force a logout.  That was already true while this route sat behind
// RequireAuth; what changes is the window, from "access token still valid"
// (15m) to "refresh token still valid" (7d).  Forced logout is a nuisance,
// not a compromise, and it matches the posture cookies.go already documents
// for /auth/refresh ("CSRF on /auth/refresh only forces a harmless token
// rotation").  Stated here so the widening is a choice, not an accident.
func (h *Handlers) Logout(w http.ResponseWriter, r *http.Request) {
	// Cookies first and unconditionally — nothing below may prevent the
	// browser from dropping its credentials.
	ClearRefreshCookie(w, h.isProd)
	ClearSessionCookie(w, h.isProd)
	ClearAuthHintCookie(w, h.isProd)

	if userID, token, ok := h.logoutSubject(r); ok {
		ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
		defer cancel()

		// Scoped to the session the caller actually holds — see the
		// ClearRefreshTokenIfMatches doc comment.  A verified SIGNATURE is not
		// evidence the token is still live, and an unconditional clear would
		// let a long-dead refresh token be replayed as a forced-logout weapon
		// against its former owner for the rest of its 7-day TTL.
		n, err := h.db.ClearRefreshTokenIfMatches(ctx, userID, &token)
		switch {
		case err != nil:
			// Log + continue — logout already succeeded from the user's
			// perspective.  The cookie is the dominant credential.
			slog.WarnContext(ctx, "auth: logout failed to clear refresh token", "userId", userID, "err", err)
		case n == 0:
			// Not an error and not worth a warning: the row moved on without
			// us.  A double-clicked button, a logout racing a login on
			// another device, a password reset that landed first, or a
			// deleted account.  Info-level because a burst of these from one
			// user is the signature of a replayed stale token.
			slog.InfoContext(ctx, "auth: logout matched no live session", "userId", userID)
		}
	}

	httpx.Data(w, http.StatusOK, MessageData{Message: msgLoggedOut})
}

// logoutSubject resolves whose session to end, and which token the caller
// presented, from the refresh cookie.
//
// Returns false when there is no cookie, or the signature does not verify.
// The caller treats that as "clear cookies only" — we will not touch a user
// row on the strength of an unverified claim about who the caller is.
//
// The raw token is returned alongside the id because the signature alone is
// not enough to authorise the write.  VerifyRefresh proves this server minted
// the token; it says nothing about whether the token is still the live one,
// and those come apart for a full 7 days after any rotation, logout or
// password change.  The DB write is predicated on the raw value for exactly
// that reason.
//
// Access claims are deliberately NOT consulted as a fallback: this route no
// longer runs behind RequireAuth, so ctx never carries them, and refresh
// TTL (7d) strictly outlives access TTL (15m) — a request holding a valid
// access token but no valid refresh token is not a case that exists.
func (h *Handlers) logoutSubject(r *http.Request) (uuid.UUID, string, bool) {
	c, err := r.Cookie(RefreshCookieName)
	if err != nil || c.Value == "" {
		return uuid.Nil, "", false
	}
	claims, err := h.signer.VerifyRefresh(c.Value)
	if err != nil {
		return uuid.Nil, "", false
	}
	return claims.UserID, c.Value, true
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

	httpx.Data(w, http.StatusOK, MeData{User: h.fillBackdropImages(ctx, ToSafeUser(user))})
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
// statement clears reset_token + reset_expires + all three refresh-session
// columns.  That kills the refresh credential everywhere, grace slot
// included.  It does not kill access tokens — a session holding an unexpired
// JWT keeps working for up to accessTTL (15m default) before it has to come
// back through /refresh and gets the 401.  The reset is effective within 15
// minutes, not instantly, and the honest framing matters here because this is
// the flow a user runs when they think someone else is in their account.
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
