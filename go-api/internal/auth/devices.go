package auth

// devices.go — the settings page's device list: the signed-in user's
// sessions, and ending one of them or every other one.
//
// Which session is "this device" comes from the refresh cookie, not the
// access token: the access token carries no session id, and the refresh
// cookie (path "/") travels with every request, including the SSR fetch
// next-app makes with the reader's cookies.

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

const (
	eventRevoke       = "revoke"
	eventRevokeOthers = "revoke_others"
)

const (
	msgBadSessionID   = "Invalid session id"
	msgRevokeCurrent  = "Use logout to end this session"
	msgUnknownCurrent = "Cannot tell which session this is"
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

	rows, err := h.db.ListUserSessions(ctx, claims.UserID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, codeServerError, "session list failed"))
		return
	}

	current := h.currentSessionID(r, claims.UserID)
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
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgBadSessionID))
		return
	}
	if id == h.currentSessionID(r, claims.UserID) {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgRevokeCurrent))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
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
// session of the user except this device's.  Refused when this device's
// session cannot be identified, since "every other" would then be every
// one, this device included.
func (h *Handlers) RevokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, codeServerError, "missing auth claims"))
		return
	}
	current := h.currentSessionID(r, claims.UserID)
	if current == uuid.Nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, codeValidation, msgUnknownCurrent))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	n, err := h.db.RevokeOtherSessions(ctx, claims.UserID, current)
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

// currentSessionID is the session this browser holds: the sid in its
// refresh cookie, when the cookie verifies and belongs to the signed-in
// user.  uuid.Nil otherwise — no cookie, a forged one, someone else's, or a
// pre-0052 token that names no session.
func (h *Handlers) currentSessionID(r *http.Request, userID uuid.UUID) uuid.UUID {
	c, err := r.Cookie(RefreshCookieName)
	if err != nil || c.Value == "" {
		return uuid.Nil
	}
	claims, err := h.signer.VerifyRefresh(c.Value)
	if err != nil || claims.UserID != userID {
		return uuid.Nil
	}
	return claims.SessionID
}
