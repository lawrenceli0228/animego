package auth

// fake_sessions_test.go — an in-memory user_sessions for fakeAuthDB.
//
// It MODELS THE WHERE CLAUSES of queries/sessions.sql rather than recording
// calls: RotateUserSession only swaps when the presented hash is the row's
// current one, DeleteUserSessionIfHeld only deletes for the current or
// grace-slot hash, adoption only succeeds while the users row still holds the
// presented token.  A fake that always succeeded would let a handler that
// passed the wrong hash, or the wrong row id, pass every test here while
// matching nothing in production.  test/integration/user_sessions_test.go
// pins the real SQL to the same behaviour.

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// fakeSessionRow is one user_sessions row.
type fakeSessionRow struct {
	dbgen.GetUserSessionRow
	ExpiresAt  time.Time
	LastUsedAt time.Time
	LegacyHash *string
}

// sessionModel is the table plus the pre-0052 users.refresh_token column the
// adoption reads.  Errors injected per statement; nil means "behave".
type sessionModel struct {
	mu     sync.Mutex
	rows   map[uuid.UUID]*fakeSessionRow
	users  map[uuid.UUID]dbgen.User // username/role for RETURNING and joins
	legacy map[uuid.UUID]string     // users.refresh_token, pre-0052
	// passwords is users.password where a test sets it; StartUserSession
	// refuses a verified hash that differs (LockUserForNewSession).
	passwords map[uuid.UUID]string

	createErr, pruneErr, rotateErr, getErr, deleteErr, adoptErr error

	pruneCalls []pruneCall
	writes     int // statements that changed or would change a row
}

type pruneCall struct {
	userID, keepID uuid.UUID
	keepOthers     int32
}

func (f *fakeAuthDB) model() *sessionModel {
	if f.sess == nil {
		f.sess = &sessionModel{
			rows:      map[uuid.UUID]*fakeSessionRow{},
			users:     map[uuid.UUID]dbgen.User{},
			legacy:    map[uuid.UUID]string{},
			passwords: map[uuid.UUID]string{},
		}
	}
	return f.sess
}

func (m *sessionModel) userFields(uid uuid.UUID) (string, *string) {
	if u, ok := m.users[uid]; ok {
		return u.Username, u.Role
	}
	return "tester", nil
}

func (f *fakeAuthDB) StartUserSession(_ context.Context, verifiedPassword string, arg dbgen.CreateUserSessionParams) error {
	m := f.model()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writes++
	if m.createErr != nil {
		return m.createErr
	}
	if current, ok := m.passwords[arg.UserID]; ok && current != verifiedPassword {
		return ErrPasswordChanged
	}
	username, role := m.userFields(arg.UserID)
	m.rows[arg.ID] = &fakeSessionRow{
		GetUserSessionRow: dbgen.GetUserSessionRow{
			ID: arg.ID, UserID: arg.UserID, TokenHash: arg.TokenHash,
			TokenJti: arg.TokenJti, TokenIat: arg.TokenIat, TokenExp: arg.TokenExp,
			Username: username, Role: role,
		},
		ExpiresAt:  arg.TokenExp.Time,
		LastUsedAt: time.Now(),
	}
	return nil
}

func (f *fakeAuthDB) PruneUserSessions(_ context.Context, userID, keepID uuid.UUID, keepOthers int32) (int64, error) {
	m := f.model()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneCalls = append(m.pruneCalls, pruneCall{userID, keepID, keepOthers})
	if m.pruneErr != nil {
		return 0, m.pruneErr
	}
	now := time.Now()
	var live []*fakeSessionRow
	for id, r := range m.rows {
		if r.UserID != userID || id == keepID {
			continue
		}
		if !r.ExpiresAt.After(now) {
			delete(m.rows, id)
			continue
		}
		live = append(live, r)
	}
	sort.Slice(live, func(i, j int) bool { return live[i].LastUsedAt.After(live[j].LastUsedAt) })
	for i, r := range live {
		if i >= int(keepOthers) {
			delete(m.rows, r.ID)
		}
	}
	var n int64
	for _, r := range m.rows {
		if r.UserID == userID {
			n++
		}
	}
	return n, nil
}

func (f *fakeAuthDB) RotateUserSession(_ context.Context, arg dbgen.RotateUserSessionParams) (dbgen.RotateUserSessionRow, error) {
	m := f.model()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writes++
	if m.rotateErr != nil {
		return dbgen.RotateUserSessionRow{}, m.rotateErr
	}
	r, ok := m.rows[arg.ID]
	if !ok || r.UserID != arg.UserID || r.TokenHash != arg.PresentedHash || !r.ExpiresAt.After(time.Now()) {
		return dbgen.RotateUserSessionRow{}, pgx.ErrNoRows
	}
	prev := r.TokenHash
	r.PreviousHash = &prev
	r.TokenHash = arg.NewHash
	r.TokenJti, r.TokenIat, r.TokenExp = arg.NewJti, arg.NewIat, arg.NewExp
	r.RotatedAt = timestamptz(time.Now())
	r.LastUsedAt = time.Now()
	r.ExpiresAt = arg.NewExp.Time
	return dbgen.RotateUserSessionRow{Username: r.Username, Role: r.Role}, nil
}

// withGrace is the row as GetUserSession returns it: within_grace judged at
// read time, as the SQL does.
func (r *fakeSessionRow) withGrace(graceSeconds int32) dbgen.GetUserSessionRow {
	out := r.GetUserSessionRow
	out.WithinGrace = r.RotatedAt.Valid && time.Since(r.RotatedAt.Time) < time.Duration(graceSeconds)*time.Second
	return out
}

func (f *fakeAuthDB) GetUserSession(_ context.Context, graceSeconds int32, id, userID uuid.UUID) (dbgen.GetUserSessionRow, error) {
	m := f.model()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.getErr != nil {
		return dbgen.GetUserSessionRow{}, m.getErr
	}
	r, ok := m.rows[id]
	if !ok || r.UserID != userID {
		return dbgen.GetUserSessionRow{}, pgx.ErrNoRows
	}
	return r.withGrace(graceSeconds), nil
}

func (f *fakeAuthDB) GetUserSessionByLegacyHash(_ context.Context, graceSeconds int32, userID uuid.UUID, legacyHash *string) (dbgen.GetUserSessionByLegacyHashRow, error) {
	m := f.model()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.getErr != nil {
		return dbgen.GetUserSessionByLegacyHashRow{}, m.getErr
	}
	for _, r := range m.rows {
		if r.UserID == userID && r.LegacyHash != nil && legacyHash != nil && *r.LegacyHash == *legacyHash {
			return dbgen.GetUserSessionByLegacyHashRow(r.withGrace(graceSeconds)), nil
		}
	}
	return dbgen.GetUserSessionByLegacyHashRow{}, pgx.ErrNoRows
}

func (f *fakeAuthDB) deleteWhere(match func(*fakeSessionRow) bool) (int64, error) {
	m := f.model()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writes++
	if m.deleteErr != nil {
		return 0, m.deleteErr
	}
	var n int64
	for id, r := range m.rows {
		if match(r) {
			delete(m.rows, id)
			n++
		}
	}
	return n, nil
}

func (f *fakeAuthDB) DeleteUserSession(_ context.Context, id, userID uuid.UUID) (int64, error) {
	return f.deleteWhere(func(r *fakeSessionRow) bool { return r.ID == id && r.UserID == userID })
}

func (f *fakeAuthDB) DeleteUserSessionIfHeld(_ context.Context, id, userID uuid.UUID, presentedHash string) (int64, error) {
	return f.deleteWhere(func(r *fakeSessionRow) bool {
		held := r.TokenHash == presentedHash || (r.PreviousHash != nil && *r.PreviousHash == presentedHash)
		return r.ID == id && r.UserID == userID && held
	})
}

func (f *fakeAuthDB) DeleteUserSessionByLegacyHash(_ context.Context, userID uuid.UUID, legacyHash *string) (int64, error) {
	return f.deleteWhere(func(r *fakeSessionRow) bool {
		return r.UserID == userID && r.LegacyHash != nil && legacyHash != nil && *r.LegacyHash == *legacyHash
	})
}

func (f *fakeAuthDB) AdoptLegacySession(_ context.Context, p AdoptLegacySessionParams) (dbgen.ClaimLegacyRefreshTokenRow, error) {
	m := f.model()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writes++
	if m.adoptErr != nil {
		return dbgen.ClaimLegacyRefreshTokenRow{}, m.adoptErr
	}
	if held, ok := m.legacy[p.UserID]; !ok || held != p.PresentedToken {
		return dbgen.ClaimLegacyRefreshTokenRow{}, pgx.ErrNoRows
	}
	for _, r := range m.rows {
		if r.LegacyHash != nil && p.Session.LegacyHash != nil && *r.LegacyHash == *p.Session.LegacyHash {
			return dbgen.ClaimLegacyRefreshTokenRow{}, pgx.ErrNoRows // UNIQUE conflict
		}
	}
	delete(m.legacy, p.UserID)
	username, role := m.userFields(p.UserID)
	s := p.Session
	m.rows[s.ID] = &fakeSessionRow{
		GetUserSessionRow: dbgen.GetUserSessionRow{
			ID: s.ID, UserID: s.UserID, TokenHash: s.TokenHash,
			PreviousHash: s.LegacyHash, RotatedAt: timestamptz(time.Now()),
			TokenJti: s.TokenJti, TokenIat: s.TokenIat, TokenExp: s.TokenExp,
			Username: username, Role: role,
		},
		ExpiresAt:  s.TokenExp.Time,
		LastUsedAt: time.Now(),
		LegacyHash: s.LegacyHash,
	}
	return dbgen.ClaimLegacyRefreshTokenRow{Username: username, Role: role}, nil
}

// -----------------------------------------------------------------------------
// Helpers for the session tests.
// -----------------------------------------------------------------------------

// seedSession opens a session for user the way startSession would and
// returns its refresh token.
func seedSession(t *testing.T, db *fakeAuthDB, signer *jwtx.Signer, user dbgen.User) (string, uuid.UUID) {
	t.Helper()
	m := db.model()
	m.mu.Lock()
	m.users[user.ID] = user
	m.mu.Unlock()
	sid := uuid.New()
	issued, err := signer.SignRefresh(user.ID, sid)
	if err != nil {
		t.Fatalf("SignRefresh: %v", err)
	}
	if err := db.StartUserSession(context.Background(), user.Password, dbgen.CreateUserSessionParams{
		ID: sid, UserID: user.ID, TokenHash: hashToken(issued.Token),
		TokenJti: issued.JTI, TokenIat: timestamptz(issued.IssuedAt), TokenExp: timestamptz(issued.ExpiresAt),
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	m.writes = 0
	return issued.Token, sid
}

// session returns a copy of the row, or nil when it no longer exists.
func (m *sessionModel) session(id uuid.UUID) *fakeSessionRow {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok {
		return nil
	}
	cp := *r
	return &cp
}

// backdate moves a session's last rotation into the past, standing in for
// the 30 s grace window running out without a test that sleeps.
func (m *sessionModel) backdate(id uuid.UUID, by time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[id].RotatedAt = timestamptz(m.rows[id].RotatedAt.Time.Add(-by))
}

// legacyRefreshToken signs a refresh token in the pre-0052 shape: userId,
// iat and exp, no sid and no jti.
func legacyRefreshToken(t *testing.T, userID uuid.UUID) string {
	t.Helper()
	now := time.Now()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId": userID.String(),
		"iat":    now.Unix(),
		"exp":    now.Add(time.Hour).Unix(),
	}).SignedString([]byte("test-refresh-secret"))
	if err != nil {
		t.Fatalf("sign legacy token: %v", err)
	}
	return tok
}

// sessionLog captures h's `auth: session` lines.
type sessionLog struct{ buf bytes.Buffer }

func captureSessionLog(h *Handlers) *sessionLog {
	l := &sessionLog{}
	h.logger = slog.New(slog.NewJSONHandler(&l.buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return l
}

// lines returns every logged line with msg "auth: session".
func (l *sessionLog) lines(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(l.buf.String()), "\n") {
		if raw == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatalf("log line is not JSON: %q", raw)
		}
		if m["msg"] == "auth: session" {
			out = append(out, m)
		}
	}
	return out
}

// only asserts exactly one `auth: session` line and returns it.
func (l *sessionLog) only(t *testing.T) map[string]any {
	t.Helper()
	lines := l.lines(t)
	if len(lines) != 1 {
		t.Fatalf("want exactly one auth: session line, got %d: %s", len(lines), l.buf.String())
	}
	return lines[0]
}

// assertOutcome checks the single line's event, outcome and level.
func (l *sessionLog) assertOutcome(t *testing.T, event, outcome, level string) map[string]any {
	t.Helper()
	line := l.only(t)
	if line["event"] != event || line["outcome"] != outcome || line["level"] != level {
		t.Errorf("auth: session line = event %v / outcome %v / level %v, want %s / %s / %s",
			line["event"], line["outcome"], line["level"], event, outcome, level)
	}
	return line
}
