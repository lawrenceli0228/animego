// Package auth owns the /api/auth/* HTTP handlers — register, login,
// refresh, logout, and me — plus the in-memory rate limiter that fronts
// the un-authenticated subset (register / login / refresh).
//
// types.go defines the request/response shapes shared by all handlers.
//
// SafeUser is the canonical user projection sent in API responses.
// NEVER expose password / refreshToken / resetPasswordToken — even when
// the underlying dbgen.User has them populated, the projection strips
// them.  ToSafeUser(dbgen.User) → SafeUser is the single conversion
// point and is the only function in this package that may touch a
// dbgen.User in a response path.
package auth

import (
	"time"

	"github.com/google/uuid"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// RegisterReq is the POST /api/auth/register body shape.  Validation
// tags drive go-playground/validator/v10:
//
//   - username: 3..50 chars, required
//   - email: required RFC5322 email
//   - password: required, min 6 chars
//
// Express express-validator messages (Chinese) — match byte-for-byte in
// the handler validation error path via validationMessage().
type RegisterReq struct {
	Username string `json:"username" validate:"required,min=3,max=50"`
	Email    string `json:"email"    validate:"required,email"`
	Password string `json:"password" validate:"required,min=6"`
}

// LoginReq is POST /api/auth/login body.  Express only validates that
// email is RFC5322 and password is non-empty — bcrypt comparison is the
// actual auth gate.
type LoginReq struct {
	Email    string `json:"email"    validate:"required,email"`
	Password string `json:"password" validate:"required"`
}

// ForgotPasswordReq is the POST /api/auth/forgot-password body shape.
// Only the email is required — successful + not-found paths BOTH return
// the same generic 200 to prevent email enumeration via response shape.
type ForgotPasswordReq struct {
	Email string `json:"email" validate:"required,email"`
}

// ResetPasswordReq is the POST /api/auth/reset-password/:token body.
// The token comes from the URL path (chi.URLParam), NOT this struct.
//
// Min length 6 matches Express's only validator hook on the reset path
// (`if (!password || password.length < 6)`) — bcrypt cost is the actual
// entropy gate, not the validator.
//
// We deliberately use `min=6` without `required` so empty and short
// inputs map to the SAME "密码至少 6 位" message — Express collapses
// both failure modes into a single error.  `min=6` on a string already
// rejects the empty case (len("") = 0 < 6) so this works.
type ResetPasswordReq struct {
	Password string `json:"password" validate:"min=6"`
}

// SafeUser is the public user shape returned in /me, /login, /register
// responses.  Field order matches Express's mongoose toJSON default
// (which mirrors insertion order in the schema): id, username, email,
// role, isPublic, createdAt, updatedAt.
//
// id is JSON-marshaled by google/uuid → canonical RFC4122 hyphenated
// form.  Timestamps use time.Time's default RFC3339Nano.
//
// The struct DELIBERATELY omits password, refreshToken,
// resetPasswordToken, resetPasswordExpires.  See ToSafeUser comment for
// the trust boundary.
type SafeUser struct {
	ID        uuid.UUID `json:"id"`
	Username  string    `json:"username"`
	Email     string    `json:"email"`
	Role      *string   `json:"role"`
	IsPublic  bool      `json:"isPublic"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ToSafeUser strips the secret columns out of a dbgen.User row before
// the value crosses the API boundary.  This is the ONLY function in
// internal/auth that converts the DB row into a response payload;
// handlers must route every user serialization through it so a future
// schema addition (e.g. a new sensitive field) defaults to NOT
// leaking — anything new in dbgen.User that should be public must be
// explicitly added here.
func ToSafeUser(u dbgen.User) SafeUser {
	return SafeUser{
		ID:        u.ID,
		Username:  u.Username,
		Email:     u.Email,
		Role:      u.Role,
		IsPublic:  u.IsPublic,
		CreatedAt: u.CreatedAt.Time,
		UpdatedAt: u.UpdatedAt.Time,
	}
}

// AuthData is the {accessToken, user} payload returned by register/login.
//
// Field order matches Express's res.json({ data: { accessToken, user } })
// — V8 JSON.stringify preserves insertion order, so accessToken precedes
// user on the wire.
type AuthData struct {
	AccessToken string   `json:"accessToken"`
	User        SafeUser `json:"user"`
}

// RefreshData is the {accessToken} payload returned by /refresh.  The
// new refresh token rides as an httpOnly cookie, not in the JSON body.
type RefreshData struct {
	AccessToken string `json:"accessToken"`
}

// MessageData is the {message} payload returned by /logout.  Reused for
// any flat success-with-prompt response.
type MessageData struct {
	Message string `json:"message"`
}

// MeData is the {user} payload returned by /me.
type MeData struct {
	User SafeUser `json:"user"`
}
