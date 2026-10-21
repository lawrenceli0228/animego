package auth

// sessions_test.go — per-device refresh sessions (sessions.go).
//
// The headline test is TestLogin_ElsewhereDoesNotEndThisDevice: before
// migration 0052, signing in on a second device overwrote the account's one
// refresh slot and the first device's next refresh got a 401.  Every other
// test pins one branch of the refresh flow drawn at the top of sessions.go,
// and each asserts the `auth: session` outcome that branch logs.

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

func newSessionHandlers(t *testing.T, db *fakeAuthDB) (*Handlers, *jwtx.Signer, *sessionLog) {
	t.Helper()
	signer := newTestSigner(t)
	h := NewHandlers(db, signer, nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	return h, signer, captureSessionLog(h)
}

func postRefresh(h *Handlers, cookie string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookie})
	}
	rec := httptest.NewRecorder()
	h.Refresh(rec, req)
	return rec
}

func postLogout(h *Handlers, cookie string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: cookie})
	rec := httptest.NewRecorder()
	h.Logout(rec, req)
	return rec
}

func postLogin(t *testing.T, h *Handlers) *httptest.ResponseRecorder {
	t.Helper()
	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"correct-horse"}`)
	rec := httptest.NewRecorder()
	h.Login(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d; body=%s", rec.Code, rec.Body.String())
	}
	return rec
}

func refreshCookie(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	c := getSetCookie(rec, RefreshCookieName)
	if c == nil || c.Value == "" {
		t.Fatalf("no refresh cookie set; body=%s", rec.Body.String())
	}
	return c.Value
}

func loginDB(t *testing.T) (*fakeAuthDB, dbgen.User) {
	t.Helper()
	user := fixtureUser(t)
	db := &fakeAuthDB{getUserByEmail: func(_ context.Context, _ string) (dbgen.User, error) { return user, nil }}
	db.model().users[user.ID] = user
	return db, user
}

// -----------------------------------------------------------------------------
// Login / register
// -----------------------------------------------------------------------------

// The bug this whole change fixes: device A signs in, device B signs in with
// the same account, and A must still be able to refresh — and B after A
// signs in again.
func TestLogin_ElsewhereDoesNotEndThisDevice(t *testing.T) {
	t.Parallel()
	db, _ := loginDB(t)
	h, _, _ := newSessionHandlers(t, db)

	deviceA := refreshCookie(t, postLogin(t, h))
	deviceB := refreshCookie(t, postLogin(t, h))

	recA := postRefresh(h, deviceA)
	if recA.Code != http.StatusOK {
		t.Fatalf("device A refresh after B signed in: status %d, want 200; body=%s", recA.Code, recA.Body.String())
	}
	deviceA = refreshCookie(t, recA)

	deviceA2 := refreshCookie(t, postLogin(t, h)) // A signs in again, a third session
	if rec := postRefresh(h, deviceB); rec.Code != http.StatusOK {
		t.Fatalf("device B refresh after A signed in again: status %d, want 200", rec.Code)
	}
	if rec := postRefresh(h, deviceA); rec.Code != http.StatusOK {
		t.Fatalf("device A's first session after its second login: status %d, want 200", rec.Code)
	}
	if deviceA2 == deviceA {
		t.Fatal("two logins produced the same refresh token")
	}
}

func TestLogin_OpensSessionHoldingTheCookie(t *testing.T) {
	t.Parallel()
	db, user := loginDB(t)
	h, signer, logs := newSessionHandlers(t, db)
	_, otherSID := seedSession(t, db, signer, user)
	before := *db.model().session(otherSID)

	cookie := refreshCookie(t, postLogin(t, h))

	claims, err := signer.VerifyRefresh(cookie)
	if err != nil {
		t.Fatalf("refresh cookie does not verify: %v", err)
	}
	row := db.model().session(claims.SessionID)
	if row == nil {
		t.Fatal("login did not create the session its cookie names")
	}
	if row.TokenHash != hashToken(cookie) {
		t.Error("stored token_hash is not sha256(cookie)")
	}
	if row.TokenHash == cookie || len(row.TokenHash) != 64 {
		t.Errorf("token_hash %q is not a 64-char digest", row.TokenHash)
	}
	if after := db.model().session(otherSID); after == nil || after.TokenHash != before.TokenHash {
		t.Error("login touched the user's other session")
	}

	line := logs.assertOutcome(t, eventLogin, outcomeStarted, "INFO")
	if line["sid"] != claims.SessionID.String() || line["userId"] != user.ID.String() {
		t.Errorf("log sid/userId = %v/%v", line["sid"], line["userId"])
	}
	if line["sessions_after_prune"] != float64(2) {
		t.Errorf("sessions_after_prune = %v, want 2", line["sessions_after_prune"])
	}
}

// The prune keeps the new session plus the 19 most recently used others.
func TestLogin_PrunesToTwentyKeepingTheNewSession(t *testing.T) {
	t.Parallel()
	db, user := loginDB(t)
	h, signer, _ := newSessionHandlers(t, db)

	cookie := refreshCookie(t, postLogin(t, h))

	claims, _ := signer.VerifyRefresh(cookie)
	calls := db.model().pruneCalls
	if len(calls) != 1 {
		t.Fatalf("PruneUserSessions called %d times, want 1", len(calls))
	}
	want := pruneCall{userID: user.ID, keepID: claims.SessionID, keepOthers: maxSessionsPerUser - 1}
	if calls[0] != want {
		t.Errorf("prune call = %+v, want %+v", calls[0], want)
	}
}

func TestLogin_PruneFailureStillSignsIn(t *testing.T) {
	t.Parallel()
	db, _ := loginDB(t)
	db.model().pruneErr = errors.New("deadlock")
	h, _, logs := newSessionHandlers(t, db)

	rec := postLogin(t, h)

	refreshCookie(t, rec)
	line := logs.assertOutcome(t, eventLogin, outcomeStarted, "INFO")
	if _, ok := line["sessions_after_prune"]; ok {
		t.Error("sessions_after_prune logged although the prune failed")
	}
	if !bytes.Contains(logs.buf.Bytes(), []byte("auth: session prune failed")) {
		t.Error("prune failure not warned")
	}
}

func TestLogin_SessionWriteFailure_500(t *testing.T) {
	t.Parallel()
	db, _ := loginDB(t)
	db.model().createErr = errors.New("connection reset")
	h, _, logs := newSessionHandlers(t, db)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"correct-horse"}`)
	rec := httptest.NewRecorder()
	h.Login(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", body))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if getSetCookie(rec, RefreshCookieName) != nil {
		t.Error("refresh cookie set for a session that was never stored")
	}
	logs.assertOutcome(t, eventLogin, outcomeError, "ERROR")
}

// The password changed between the login checking it and the session being
// written (a reset landing mid-login): refused like a wrong password, and no
// session is left behind for a password that no longer works.
func TestLogin_PasswordChangedMidLoginIsRefused(t *testing.T) {
	t.Parallel()
	db, user := loginDB(t)
	db.model().passwords[user.ID] = "$2a$10$the-hash-after-the-reset"
	h, _, logs := newSessionHandlers(t, db)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"correct-horse"}`)
	rec := httptest.NewRecorder()
	h.Login(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", body))

	assertError(t, rec, http.StatusUnauthorized, codeInvalidCredentials, msgInvalidCredentials)
	if getSetCookie(rec, RefreshCookieName) != nil {
		t.Error("refresh cookie set for a refused login")
	}
	if n := len(db.model().rows); n != 0 {
		t.Errorf("%d sessions written for a refused login", n)
	}
	logs.assertOutcome(t, eventLogin, outcomePasswordChanged, "INFO")
}

func TestRegister_LogsSessionStart(t *testing.T) {
	t.Parallel()
	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail:    func(_ context.Context, _ string) (dbgen.User, error) { return dbgen.User{}, pgx.ErrNoRows },
		getUserByUsername: func(_ context.Context, _ string) (dbgen.User, error) { return dbgen.User{}, pgx.ErrNoRows },
		createUser:        func(_ context.Context, _, _, _ string) (dbgen.User, error) { return user, nil },
	}
	h, _, logs := newSessionHandlers(t, db)

	body := bytes.NewBufferString(`{"username":"lawrence","email":"new@example.com","password":"correct-horse"}`)
	rec := httptest.NewRecorder()
	h.Register(rec, httptest.NewRequest(http.MethodPost, "/api/auth/register", body))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", rec.Code)
	}
	logs.assertOutcome(t, eventRegister, outcomeStarted, "INFO")
}

// -----------------------------------------------------------------------------
// Refresh
// -----------------------------------------------------------------------------

func TestRefresh_RotatesOnlyThisSession(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, sid := seedSession(t, db, signer, user)
	_, otherSID := seedSession(t, db, signer, user)
	other := *db.model().session(otherSID)

	rec := postRefresh(h, cookie)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	next := refreshCookie(t, rec)
	claims, err := signer.VerifyRefresh(next)
	if err != nil || claims.SessionID != sid {
		t.Fatalf("new cookie names session %v (err %v), want %v", claims, err, sid)
	}
	row := db.model().session(sid)
	if row.TokenHash != hashToken(next) {
		t.Error("token_hash is not the new cookie's digest")
	}
	if row.PreviousHash == nil || *row.PreviousHash != hashToken(cookie) {
		t.Error("previous_hash does not hold the presented token's digest")
	}
	if after := db.model().session(otherSID); after.TokenHash != other.TokenHash {
		t.Error("refresh rotated the user's other session")
	}
	if getSetCookie(rec, sessionCookieName) == nil {
		t.Error("access cookie not set")
	}
	logs.assertOutcome(t, eventRefresh, outcomeRotated, "INFO")
}

// The losing side of two concurrent refreshes gets the session's CURRENT
// token back, rebuilt from the stored claims, and nothing rotates again.
func TestRefresh_GraceResendsTheCurrentToken(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	cookie, sid := seedSession(t, db, signer, fixtureUser(t))
	current := refreshCookie(t, postRefresh(h, cookie))
	logs.buf.Reset()

	rec := postRefresh(h, cookie)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := refreshCookie(t, rec); got != current {
		t.Error("grace response did not carry the session's current token byte for byte")
	}
	if row := db.model().session(sid); row.TokenHash != hashToken(current) {
		t.Error("grace rotated the session again")
	}
	logs.assertOutcome(t, eventRefresh, outcomeGrace, "INFO")
}

// If the rebuilt token does not hash to token_hash (a JWT library change, a
// tampered row), the client gets an access token and keeps its cookie.
func TestRefresh_GraceMismatchSendsAccessOnly(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	cookie, sid := seedSession(t, db, signer, fixtureUser(t))
	postRefresh(h, cookie)
	db.model().mu.Lock()
	db.model().rows[sid].TokenJti = uuid.New() // the stored claims no longer rebuild the token
	db.model().mu.Unlock()
	logs.buf.Reset()

	rec := postRefresh(h, cookie)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if getSetCookie(rec, RefreshCookieName) != nil {
		t.Error("a refresh cookie was sent although it does not match the session")
	}
	if getSetCookie(rec, sessionCookieName) == nil {
		t.Error("no access cookie")
	}
	logs.assertOutcome(t, eventRefresh, outcomeGraceMismatch, "WARN")
}

// An old token presented after the grace window ends that session — and
// only that one.
func TestRefresh_ReuseAfterGraceRevokesOnlyThatSession(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, sid := seedSession(t, db, signer, user)
	_, otherSID := seedSession(t, db, signer, user)
	postRefresh(h, cookie)
	db.model().backdate(sid, refreshGraceWindow+time.Second)
	logs.buf.Reset()

	rec := postRefresh(h, cookie)

	assertError(t, rec, http.StatusUnauthorized, codeInvalidToken, msgInvalidToken)
	if db.model().session(sid) != nil {
		t.Error("the reused session survived")
	}
	if db.model().session(otherSID) == nil {
		t.Error("reuse on one device ended another device's session")
	}
	logs.assertOutcome(t, eventRefresh, outcomeReuseRevoked, "WARN")
}

// A token two rotations old matches neither slot: also reuse.
func TestRefresh_TokenTwoRotationsOldIsReuse(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	t0, sid := seedSession(t, db, signer, fixtureUser(t))
	t1 := refreshCookie(t, postRefresh(h, t0))
	postRefresh(h, t1)
	logs.buf.Reset()

	rec := postRefresh(h, t0)

	assertError(t, rec, http.StatusUnauthorized, codeInvalidToken, msgInvalidToken)
	if db.model().session(sid) != nil {
		t.Error("session survived a replay of a token two rotations old")
	}
	logs.assertOutcome(t, eventRefresh, outcomeReuseRevoked, "WARN")
}

func TestRefresh_SessionGone401(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	issued, err := signer.SignRefresh(fixtureUser(t).ID, uuid.New()) // never stored, or since deleted
	if err != nil {
		t.Fatal(err)
	}

	rec := postRefresh(h, issued.Token)

	assertError(t, rec, http.StatusUnauthorized, codeInvalidToken, msgInvalidToken)
	logs.assertOutcome(t, eventRefresh, outcomeNotFound, "INFO")
}

// A session past expires_at refuses its own current token (the CAS checks
// expiry) and is not treated as reuse.
func TestRefresh_ExpiredSessionIsNotReuse(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	cookie, sid := seedSession(t, db, signer, fixtureUser(t))
	db.model().mu.Lock()
	db.model().rows[sid].ExpiresAt = time.Now().Add(-time.Minute)
	db.model().mu.Unlock()

	rec := postRefresh(h, cookie)

	assertError(t, rec, http.StatusUnauthorized, codeInvalidToken, msgInvalidToken)
	if db.model().session(sid) == nil {
		t.Error("an expired session was deleted as if its token had been stolen")
	}
	logs.assertOutcome(t, eventRefresh, outcomeNotFound, "INFO")
}

func TestRefresh_RotateDBError500(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	cookie, _ := seedSession(t, db, signer, fixtureUser(t))
	db.model().rotateErr = errors.New("connection reset")

	rec := postRefresh(h, cookie)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	logs.assertOutcome(t, eventRefresh, outcomeError, "ERROR")
}

func TestRefresh_ReadAfterMissDBError500(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	issued, _ := signer.SignRefresh(fixtureUser(t).ID, uuid.New())
	db.model().getErr = errors.New("connection reset")

	rec := postRefresh(h, issued.Token)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	logs.assertOutcome(t, eventRefresh, outcomeError, "ERROR")
}

// A failed revocation is still a 401 — the token is refused either way —
// and both the failure and the reuse are logged.
func TestRefresh_ReuseDeleteFailureStill401(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	cookie, sid := seedSession(t, db, signer, fixtureUser(t))
	postRefresh(h, cookie)
	db.model().backdate(sid, refreshGraceWindow+time.Second)
	db.model().deleteErr = errors.New("connection reset")
	logs.buf.Reset()

	rec := postRefresh(h, cookie)

	assertError(t, rec, http.StatusUnauthorized, codeInvalidToken, msgInvalidToken)
	lines := logs.lines(t)
	if len(lines) != 2 || lines[0]["outcome"] != outcomeError || lines[1]["outcome"] != outcomeReuseRevoked {
		t.Errorf("want error then reuse_revoked, got %v", lines)
	}
}

// -----------------------------------------------------------------------------
// Refresh with a pre-0052 token (no sid)
// -----------------------------------------------------------------------------

func TestRefresh_LegacyTokenIsAdopted(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	legacy := legacyRefreshToken(t, user.ID)
	db.model().legacy[user.ID] = legacy

	rec := postRefresh(h, legacy)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — the deploy must not sign anyone out; body=%s", rec.Code, rec.Body.String())
	}
	next := refreshCookie(t, rec)
	claims, err := signer.VerifyRefresh(next)
	if err != nil || claims.SessionID == uuid.Nil {
		t.Fatalf("adopted cookie has no session id (err %v)", err)
	}
	row := db.model().session(claims.SessionID)
	if row == nil || row.TokenHash != hashToken(next) {
		t.Fatal("no session holding the new cookie")
	}
	if row.LegacyHash == nil || *row.LegacyHash != hashToken(legacy) {
		t.Error("legacy_hash does not record the adopted token")
	}
	if row.PreviousHash == nil || *row.PreviousHash != hashToken(legacy) || !row.RotatedAt.Valid {
		t.Error("the adopted token is not in the grace slot")
	}
	if _, still := db.model().legacy[user.ID]; still {
		t.Error("users.refresh_token still holds the adopted token")
	}
	line := logs.assertOutcome(t, eventRefresh, outcomeLegacyAdopted, "INFO")
	if line["sid"] != claims.SessionID.String() {
		t.Errorf("log sid = %v, want the new session", line["sid"])
	}
}

// A second request racing the adoption with the same old cookie is answered
// from the grace slot with the adopted session's token.
func TestRefresh_LegacyTokenRaceGetsGrace(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, _, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	legacy := legacyRefreshToken(t, user.ID)
	db.model().legacy[user.ID] = legacy
	adopted := refreshCookie(t, postRefresh(h, legacy))
	logs.buf.Reset()

	rec := postRefresh(h, legacy)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := refreshCookie(t, rec); got != adopted {
		t.Error("the racing request did not get the adopted session's token")
	}
	logs.assertOutcome(t, eventRefresh, outcomeLegacyGrace, "INFO")
}

// An adopted old token replayed later is reuse: it cannot be adopted a second
// time, and the session it became ends.
func TestRefresh_LegacyTokenReplayRevokes(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	legacy := legacyRefreshToken(t, user.ID)
	db.model().legacy[user.ID] = legacy
	claims, _ := signer.VerifyRefresh(refreshCookie(t, postRefresh(h, legacy)))
	db.model().backdate(claims.SessionID, refreshGraceWindow+time.Second)
	logs.buf.Reset()

	rec := postRefresh(h, legacy)

	assertError(t, rec, http.StatusUnauthorized, codeInvalidToken, msgInvalidToken)
	if db.model().session(claims.SessionID) != nil {
		t.Error("replaying the adopted token left its session alive")
	}
	line := logs.assertOutcome(t, eventRefresh, outcomeReuseRevoked, "WARN")
	if line["legacy"] != true {
		t.Error("reuse line does not say the token was a legacy one")
	}
}

// A pre-0052 token the users row no longer holds (logged out, password
// changed, a newer login on the old build) and that was never adopted.
func TestRefresh_LegacyTokenUnmatched401(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, _, logs := newSessionHandlers(t, db)

	rec := postRefresh(h, legacyRefreshToken(t, fixtureUser(t).ID))

	assertError(t, rec, http.StatusUnauthorized, codeInvalidToken, msgInvalidToken)
	logs.assertOutcome(t, eventRefresh, outcomeLegacyUnmatched, "INFO")
}

func TestRefresh_LegacyAdoptionError500(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, _, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	legacy := legacyRefreshToken(t, user.ID)
	db.model().legacy[user.ID] = legacy
	db.model().adoptErr = errors.New("serialization failure")

	rec := postRefresh(h, legacy)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if db.model().legacy[user.ID] != legacy {
		t.Error("a failed adoption lost the old token")
	}
	logs.assertOutcome(t, eventRefresh, outcomeError, "ERROR")
}

// -----------------------------------------------------------------------------
// Logout
// -----------------------------------------------------------------------------

// Also the regression guard for logout-after-the-access-token-expired: no
// access claims are in ctx here, only the refresh cookie.
func TestLogout_EndsOnlyThisSession(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	cookie, sid := seedSession(t, db, signer, user)
	_, otherSID := seedSession(t, db, signer, user)

	rec := postLogout(h, cookie)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	assertAuthCookiesCleared(t, rec)
	if db.model().session(sid) != nil {
		t.Error("logout left this device's session alive")
	}
	if db.model().session(otherSID) == nil {
		t.Error("logout on one device ended another device's session")
	}
	line := logs.assertOutcome(t, eventLogout, outcomeEnded, "INFO")
	if line["deleted"] != float64(1) {
		t.Errorf("deleted = %v, want 1", line["deleted"])
	}
}

// A tab that refreshed a moment ago holds the grace-slot token and must
// still be able to log itself out.
func TestLogout_GraceSlotTokenStillEnds(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, _ := newSessionHandlers(t, db)
	cookie, sid := seedSession(t, db, signer, fixtureUser(t))
	postRefresh(h, cookie)

	postLogout(h, cookie)

	if db.model().session(sid) != nil {
		t.Error("the grace-slot token could not end its session")
	}
}

// A signature outlives the token it signs: a token two rotations old must
// not be usable to log its former owner out.
func TestLogout_StaleTokenEndsNothing(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	t0, sid := seedSession(t, db, signer, fixtureUser(t))
	t1 := refreshCookie(t, postRefresh(h, t0))
	postRefresh(h, t1)
	logs.buf.Reset()

	rec := postLogout(h, t0)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	assertAuthCookiesCleared(t, rec)
	if db.model().session(sid) == nil {
		t.Error("a stale token ended the live session")
	}
	line := logs.assertOutcome(t, eventLogout, outcomeEnded, "INFO")
	if line["deleted"] != float64(0) {
		t.Errorf("deleted = %v, want 0", line["deleted"])
	}
}

// A pre-0052 cookie logs out on the users row AND ends the session a racing
// refresh may have adopted it into.
func TestLogout_LegacyCookieEndsAdoptedSessionToo(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{clearCASEnabled: true}
	h, signer, logs := newSessionHandlers(t, db)
	user := fixtureUser(t)
	legacy := legacyRefreshToken(t, user.ID)
	db.model().legacy[user.ID] = legacy
	claims, _ := signer.VerifyRefresh(refreshCookie(t, postRefresh(h, legacy)))
	db.clearCASCurrent = &legacy // as if the old build had written it back meanwhile
	logs.buf.Reset()

	rec := postLogout(h, legacy)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if db.clearCallCount != 1 || db.clearCalledID != user.ID {
		t.Errorf("users-row clear calls = %d for %v", db.clearCallCount, db.clearCalledID)
	}
	if db.model().session(claims.SessionID) != nil {
		t.Error("the session adopted from this cookie survived its logout")
	}
	line := logs.assertOutcome(t, eventLogout, outcomeEnded, "INFO")
	if line["deleted"] != float64(2) || line["legacy"] != true {
		t.Errorf("deleted/legacy = %v/%v, want 2/true", line["deleted"], line["legacy"])
	}
}

func TestLogout_DBErrorStillClearsCookies(t *testing.T) {
	t.Parallel()
	db := &fakeAuthDB{}
	h, signer, logs := newSessionHandlers(t, db)
	cookie, _ := seedSession(t, db, signer, fixtureUser(t))
	db.model().deleteErr = errors.New("connection reset")

	rec := postLogout(h, cookie)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — logout must always succeed", rec.Code)
	}
	assertAuthCookiesCleared(t, rec)
	logs.assertOutcome(t, eventLogout, outcomeError, "ERROR")
}
