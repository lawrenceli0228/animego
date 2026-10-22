package auth

// devices.go — the settings page's device list: the signed-in user's
// sessions, and ending one of them or every other one.
//
// Which session is "this device" comes from the refresh cookie, not the
// access token: the refresh cookie (path "/") travels with every request,
// including the SSR fetch next-app makes with the reader's cookies, and it
// is what the device list's current-or-grace check (GetHeldUserSession)
// compares against.  The access token's own sid is checked for liveness by
// jwtx (WithSessionCheck) before these handlers run.
//
// All three endpoints require that session to be live, not just signed.
// The signature on a revoked refresh token outlives the revoke: a device the
// owner has just signed out could otherwise come back with it and sign the
// owner's devices out in turn, and an access token on its own could list and
// end every session.

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

const (
	eventRevoke       = "revoke"
	eventRevokeOthers = "revoke_others"
)

const (
	msgBadSessionID  = "Invalid session id"
	msgRevokeCurrent = "Use logout to end this session"
)

// SessionView is one device in the list.
type SessionView struct {
	ID         uuid.UUID `json:"id"`
	Current    bool      `json:"current"`
	Kind       string    `json:"kind"`
	OS         string    `json:"os"`
	Browser    string    `json:"browser"`
	City       *string   `json:"city"`
	Country    *string   `json:"country"`
	LastUsedAt string    `json:"lastUsedAt"`
	CreatedAt  string    `json:"createdAt"`
}

// SessionsData is GET /api/auth/sessions' payload.
type SessionsData struct {
	Items []SessionView `json:"items"`
}

// RevokedData is the DELETE endpoints' payload.
type RevokedData struct {
	Revoked int64 `json:"revoked"`
}

// ListSessions implements GET /api/auth/sessions: the user's live sessions,
// this device first, then most recently used.  Behind jwtx.RequireAuth.
func (h *Handlers) ListSessions(w http.ResponseWriter, r *http.Request) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, codeServerError, "missing auth claims"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	current, _, ok := h.requireCurrentSession(ctx, w, r, claims.UserID)
	if !ok {
		return
	}
	rows, err := h.db.ListUserSessions(ctx, claims.UserID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "session list failed"))
		return
	}

	items := make([]SessionView, 0, len(rows))
	for _, row := range rows {
		ua := ""
		if row.UserAgent != nil {
			ua = *row.UserAgent
		}
		dev := ParseUserAgent(ua)
		view := SessionView{
			ID:         row.ID,
			Current:    row.ID == current,
			Kind:       dev.Kind,
			OS:         dev.OS,
			Browser:    dev.Browser,
			City:       row.City,
			Country:    row.Country,
			LastUsedAt: row.LastUsedAt.Time.UTC().Format(timeLayout),
			CreatedAt:  row.CreatedAt.Time.UTC().Format(timeLayout),
		}
		if view.Current {
			items = append([]SessionView{view}, items...)
			continue
		}
		items = append(items, view)
	}
	httpx.Data(w, http.StatusOK, SessionsData{Items: items})
}

// RevokeSession implements DELETE /api/auth/sessions/{id}: ends one of the
// user's other sessions.  Scoped to the user, so an id that is not theirs
// ends nothing (revoked 0) and says nothing about whose it is.  This
// device's own session is refused — logout is how it ends.
func (h *Handlers) RevokeSession(w http.ResponseWriter, r *http.Request) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, codeServerError, "missing auth claims"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	current, _, ok := h.requireCurrentSession(ctx, w, r, claims.UserID)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgBadSessionID))
		return
	}
	if id == current {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgRevokeCurrent))
		return
	}

	n, err := h.db.DeleteUserSession(ctx, id, claims.UserID)
	if err != nil {
		h.logSession(ctx, eventRevoke, outcomeError, claims.UserID, id, "err", err)
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "revoke failed"))
		return
	}
	h.logSession(ctx, eventRevoke, outcomeEnded, claims.UserID, id, "deleted", n)
	httpx.Data(w, http.StatusOK, RevokedData{Revoked: n})
}

// RevokeOtherSessions implements DELETE /api/auth/sessions: ends every
// session of the user except this device's.  Refused (401) when this
// device's session cannot be identified as live, since "every other" would
// then be every live one.
func (h *Handlers) RevokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, codeServerError, "missing auth claims"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	current, presented, ok := h.requireCurrentSession(ctx, w, r, claims.UserID)
	if !ok {
		return
	}
	n, err := h.db.RevokeOtherSessions(ctx, claims.UserID, current, presented)
	if errors.Is(err, ErrSessionGone) {
		// Revoked or rotated past between the check above and the
		// transaction: the same answer as if it had happened before.
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeNoToken, msgNoToken))
		return
	}
	if err != nil {
		h.logSession(ctx, eventRevokeOthers, outcomeError, claims.UserID, current, "err", err)
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "revoke failed"))
		return
	}
	h.logSession(ctx, eventRevokeOthers, outcomeEnded, claims.UserID, current, "deleted", n)
	httpx.Data(w, http.StatusOK, RevokedData{Revoked: n})
}

// timeLayout is RFC 3339 at second precision, the form the frontend parses.
const timeLayout = "2006-01-02T15:04:05Z07:00"

// requireCurrentSession resolves this device's live session and writes the
// failure itself: 401 when there is none, 500 when the lookup fails.
// Returns the session id and the presented token's hash.
func (h *Handlers) requireCurrentSession(ctx context.Context, w http.ResponseWriter, r *http.Request, userID uuid.UUID) (uuid.UUID, string, bool) {
	sid, presented, err := h.currentSession(ctx, r, userID)
	switch {
	case err != nil:
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "session lookup failed"))
		return uuid.Nil, "", false
	case sid == uuid.Nil:
		httpx.Fail(w, httpx.NewError(http.StatusUnauthorized, codeNoToken, msgNoToken))
		return uuid.Nil, "", false
	}
	return sid, presented, true
}

// currentSession is the session this browser holds: the sid in its refresh
// cookie, when the cookie verifies, belongs to the signed-in user, and is
// still that session's current or grace-slot token (GetHeldUserSession).
// uuid.Nil otherwise — no cookie, a forged one, someone else's, a pre-0052
// token that names no session, or a session that has since been ended.
func (h *Handlers) currentSession(ctx context.Context, r *http.Request, userID uuid.UUID) (uuid.UUID, string, error) {
	c, err := r.Cookie(RefreshCookieName)
	if err != nil || c.Value == "" {
		return uuid.Nil, "", nil
	}
	claims, err := h.signer.VerifyRefresh(c.Value)
	if err != nil || claims.UserID != userID || claims.SessionID == uuid.Nil {
		return uuid.Nil, "", nil
	}
	presented := hashToken(c.Value)
	if _, err := h.db.GetHeldUserSession(ctx, claims.SessionID, userID, presented); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, "", nil
		}
		return uuid.Nil, "", err
	}
	return claims.SessionID, presented, nil
}
