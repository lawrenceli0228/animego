package auth

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

const (
	uaMac    = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
	uaIPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)

func strp(s string) *string { return &s }

// devicesRouter mounts the three endpoints the way main.go does, minus
// RequireAuth: the tests put the claims in ctx themselves.
func devicesRouter(h *Handlers) http.Handler {
	r := chi.NewRouter()
	r.Get("/api/auth/sessions", h.ListSessions)
	r.Delete("/api/auth/sessions", h.RevokeOtherSessions)
	r.Delete("/api/auth/sessions/{id}", h.RevokeSession)
	return r
}

// authed is a request from user, carrying cookie as its refresh cookie
// ("" for none).
func authed(method, path string, user dbgen.User, cookie string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	req = req.WithContext(injectClaims(req.Context(), user.ID, user.Username, user.Role))
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookie})
	}
	return req
}

func setDevice(m *sessionModel, sid uuid.UUID, ua, country, city string, lastUsed time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[sid]
	if ua != "" {
		r.UserAgent = strp(ua)
	}
	if country != "" {
		r.Country = strp(country)
	}
	if city != "" {
		r.City = strp(city)
	}
	r.LastUsedAt = lastUsed
}

// -----------------------------------------------------------------------------
// Recording the device
// -----------------------------------------------------------------------------

func TestLogin_RecordsTheDevice(t *testing.T) {
	t.Parallel()
	db, _ := loginDB(t)
	h, signer, _ := newSessionHandlers(t, db)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"correct-horse"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	req.Header.Set("User-Agent", uaMac)
	req.Header.Set("CF-IPCountry", "CN")
	req.Header.Set("CF-IPCity", "Shanghai")
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	claims, err := signer.VerifyRefresh(refreshCookie(t, rec))
	if err != nil {
		t.Fatal(err)
	}
	row := db.model().session(claims.SessionID)
	if row.UserAgent == nil || *row.UserAgent != uaMac || row.Country == nil || *row.Country != "CN" || row.City == nil || *row.City != "Shanghai" {
		t.Errorf("device not recorded: ua=%v country=%v city=%v", row.UserAgent, row.Country, row.City)
	}
}

// A refresh moves the device columns to the latest request, and keeps what
// that request does not state.
func TestRefresh_UpdatesTheDevice(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, _, _ := newSessionHandlers(t, db)
	cookie, sid := seedSession(t, db, newTestSigner(t), fixtureUser(t))
	setDevice(db.model(), sid, uaMac, "CN", "Shanghai", time.Now())

	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookie})
	req.Header.Set("User-Agent", uaIPhone)
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	row := db.model().session(sid)
	if *row.UserAgent != uaIPhone {
		t.Errorf("user agent = %q, want the latest request's", *row.UserAgent)
	}
	if row.Country == nil || *row.Country != "CN" || row.City == nil || *row.City != "Shanghai" {
		t.Error("a request without location headers wiped the stored location")
	}
}

// -----------------------------------------------------------------------------
// GET /api/auth/sessions
// -----------------------------------------------------------------------------

func TestListSessions_ThisDeviceFirstThenMostRecent(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	_, older := seedSession(t, db, signer, user)
	thisCookie, this := seedSession(t, db, signer, user)
	_, recent := seedSession(t, db, signer, user)
	now := time.Now()
	setDevice(db.model(), older, "", "", "", now.Add(-48*time.Hour))
	setDevice(db.model(), this, uaMac, "CN", "Shanghai", now.Add(-time.Hour))
	setDevice(db.model(), recent, uaIPhone, "CN", "", now.Add(-time.Minute))

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodGet, "/api/auth/sessions", user, thisCookie))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var data SessionsData
	decodeData(t, rec.Body.Bytes(), &data)
	if len(data.Items) != 3 {
		t.Fatalf("items = %d, want 3", len(data.Items))
	}
	got := []uuid.UUID{data.Items[0].ID, data.Items[1].ID, data.Items[2].ID}
	if got[0] != this || got[1] != recent || got[2] != older {
		t.Errorf("order = %v, want this device, then most recent, then oldest", got)
	}
	first := data.Items[0]
	if !first.Current || first.Kind != KindLaptop || first.OS != "Mac" || first.Browser != "Chrome" ||
		first.City == nil || *first.City != "Shanghai" || first.Country == nil || *first.Country != "CN" {
		t.Errorf("this device = %+v", first)
	}
	if data.Items[1].Current || data.Items[1].Kind != KindPhone || data.Items[1].City != nil {
		t.Errorf("other device = %+v", data.Items[1])
	}
	if data.Items[2].Kind != KindUnknown || data.Items[2].OS != "" || data.Items[2].Browser != "" {
		t.Errorf("a session without a user agent = %+v, want an unknown device", data.Items[2])
	}
	if _, err := time.Parse(time.RFC3339, first.LastUsedAt); err != nil {
		t.Errorf("lastUsedAt %q is not RFC 3339", first.LastUsedAt)
	}
}

// The device list is for one of the devices on it: an access token alone,
// or with a refresh cookie that is not this user's live session, gets 401.
func TestListSessions_NeedsALiveSessionOfTheUsersOwn(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	seedSession(t, db, signer, user)
	other := fixtureUser(t)
	other.ID = uuid.New()
	otherCookie, _ := seedSession(t, db, signer, other)
	gone, goneSID := seedSession(t, db, signer, user)
	db.model().mu.Lock()
	delete(db.model().rows, goneSID)
	db.model().mu.Unlock()

	for name, cookie := range map[string]string{"no cookie": "", "another user's": otherCookie, "forged": "not.a.jwt", "a revoked session's": gone} {
		rec := httptest.NewRecorder()
		devicesRouter(h).ServeHTTP(rec, authed(http.MethodGet, "/api/auth/sessions", user, cookie))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401", name, rec.Code)
		}
	}
}

func TestListSessions_DBError500(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, _ := seedSession(t, db, signer, user)
	db.model().getErr = errors.New("connection reset")

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodGet, "/api/auth/sessions", user, cookie))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestDevices_SessionLookupError500(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, _ := seedSession(t, db, signer, user)
	db.model().heldErr = errors.New("connection reset")

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions", user, cookie))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

// A device the owner has just signed out keeps a working access token for
// up to 15 minutes, and its refresh cookie still verifies.  It must not be
// able to turn around and sign the owner's devices out.
func TestDevices_ARevokedDeviceCannotActOnTheOwnersSessions(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	ownerCookie, owner := seedSession(t, db, signer, user)
	intruderCookie, intruder := seedSession(t, db, signer, user)

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions/"+intruder.String(), user, ownerCookie))
	if rec.Code != http.StatusOK {
		t.Fatalf("owner's revoke: status %d", rec.Code)
	}

	for name, req := range map[string]*http.Request{
		"sign out others": authed(http.MethodDelete, "/api/auth/sessions", user, intruderCookie),
		"sign out owner":  authed(http.MethodDelete, "/api/auth/sessions/"+owner.String(), user, intruderCookie),
		"list":            authed(http.MethodGet, "/api/auth/sessions", user, intruderCookie),
	} {
		rec := httptest.NewRecorder()
		devicesRouter(h).ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s by the revoked device: status = %d, want 401", name, rec.Code)
		}
	}
	if db.model().session(owner) == nil {
		t.Fatal("the revoked device ended the owner's session")
	}
}

// -----------------------------------------------------------------------------
// DELETE /api/auth/sessions/{id}
// -----------------------------------------------------------------------------

func TestRevokeSession_EndsOnlyThatSession(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	thisCookie, this := seedSession(t, db, signer, user)
	_, other := seedSession(t, db, signer, user)
	_, third := seedSession(t, db, signer, user)

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions/"+other.String(), user, thisCookie))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var data RevokedData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.Revoked != 1 {
		t.Errorf("revoked = %d, want 1", data.Revoked)
	}
	if db.model().session(other) != nil {
		t.Error("the revoked session survived")
	}
	if db.model().session(this) == nil || db.model().session(third) == nil {
		t.Error("revoking one session ended another")
	}
	line := logs.assertOutcome(t, eventRevoke, outcomeEnded, "INFO")
	if line["sid"] != other.String() {
		t.Errorf("log sid = %v, want the revoked session", line["sid"])
	}
}

func TestRevokeSession_RefusesThisDevice(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, this := seedSession(t, db, signer, user)

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions/"+this.String(), user, cookie))

	assertError(t, rec, http.StatusBadRequest, codeValidation, msgRevokeCurrent)
	if db.model().session(this) == nil {
		t.Error("this device's session was ended through the device list")
	}
}

func TestRevokeSession_SomeoneElsesSessionEndsNothing(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, _ := seedSession(t, db, signer, user)
	stranger := fixtureUser(t)
	stranger.ID = uuid.New()
	_, theirs := seedSession(t, db, signer, stranger)

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions/"+theirs.String(), user, cookie))

	var data RevokedData
	decodeData(t, rec.Body.Bytes(), &data)
	if rec.Code != http.StatusOK || data.Revoked != 0 {
		t.Errorf("status %d revoked %d, want 200 and 0", rec.Code, data.Revoked)
	}
	if db.model().session(theirs) == nil {
		t.Error("a user ended another user's session")
	}
}

func TestRevokeSession_BadID400(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, _ := seedSession(t, db, signer, user)

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions/not-a-uuid", user, cookie))

	assertError(t, rec, http.StatusBadRequest, codeValidation, msgBadSessionID)
}

func TestRevokeSession_DBError500(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, _ := seedSession(t, db, signer, user)
	_, other := seedSession(t, db, signer, user)
	db.model().deleteErr = errors.New("connection reset")

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions/"+other.String(), user, cookie))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	logs.assertOutcome(t, eventRevoke, outcomeError, "ERROR")
}

// -----------------------------------------------------------------------------
// DELETE /api/auth/sessions
// -----------------------------------------------------------------------------

func TestRevokeOtherSessions_KeepsThisDevice(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, this := seedSession(t, db, signer, user)
	seedSession(t, db, signer, user)
	seedSession(t, db, signer, user)
	db.model().legacy[user.ID] = "pre-0052-token" // a device that has not refreshed since the deploy

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions", user, cookie))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var data RevokedData
	decodeData(t, rec.Body.Bytes(), &data)
	if data.Revoked != 3 {
		t.Errorf("revoked = %d, want 3 (two sessions and the pre-0052 token)", data.Revoked)
	}
	if n := len(db.model().rows); n != 1 || db.model().session(this) == nil {
		t.Errorf("%d sessions left, want only this device's", n)
	}
	if _, still := db.model().legacy[user.ID]; still {
		t.Error("the pre-0052 token survived sign-out-everywhere-else")
	}
	line := logs.assertOutcome(t, eventRevokeOthers, outcomeEnded, "INFO")
	if line["deleted"] != float64(3) {
		t.Errorf("deleted = %v, want 3", line["deleted"])
	}
}

// Without a live session of its own the request cannot be "everyone else".
func TestRevokeOtherSessions_NoLiveSession401(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	user := fixtureUser(t)
	_, sid := seedSession(t, db, signer, user)

	rec := httptest.NewRecorder()
	devicesRouter(h).ServeHTTP(rec, authed(http.MethodDelete, "/api/auth/sessions", user, ""))

	assertError(t, rec, http.StatusUnauthorized, codeNoToken, msgNoToken)
	if db.model().session(sid) == nil {
		t.Error("a request with no session of its own ended sessions")
	}
}
