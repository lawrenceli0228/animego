package auth

// login_observer_test.go -- the login half of the activity record.
//
// login_count on user_activity_daily (migration 0025) has exactly one writer:
// the hook this file exercises.  Nothing else in the codebase increments it,
// so if the hook stops firing the column silently reads zero forever and the
// admin panel reports that nobody has logged in since the day it broke.
//
// The middleware that records everything else structurally cannot cover this:
// it attributes from a verified access token, and nobody holds one at the
// moment they are logging in.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// spyLoginObserver records every call so a test can assert both that the hook
// fired and, just as importantly, that it did not.
type spyLoginObserver struct {
	mu    sync.Mutex
	calls []uuid.UUID
}

func (s *spyLoginObserver) Login(userID uuid.UUID, _ time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, userID)
}

func (s *spyLoginObserver) seen() []uuid.UUID {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]uuid.UUID, len(s.calls))
	copy(out, s.calls)
	return out
}

func TestLogin_NotifiesObserverOnSuccess(t *testing.T) {
	t.Parallel()

	user := fixtureUser(t)
	db := &fakeAuthDB{
		getUserByEmail: func(_ context.Context, _ string) (dbgen.User, error) { return user, nil },
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
	spy := &spyLoginObserver{}
	h.SetLoginObserver(spy)

	body := bytes.NewBufferString(`{"email":"lawrence@example.com","password":"correct-horse"}`)
	rec := httptest.NewRecorder()
	h.Login(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", body))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	seen := spy.seen()
	if len(seen) != 1 {
		t.Fatalf("observer calls = %d, want exactly 1", len(seen))
	}
	// Attributed to the account that authenticated, not to whatever the request
	// body claimed.
	if seen[0] != user.ID {
		t.Fatalf("observer got %s, want the authenticated user %s", seen[0], user.ID)
	}
}

// TestLogin_DoesNotNotifyObserverOnFailure is the half that gives the number
// its meaning.  login_count is documented as "somebody got in", not "somebody
// tried" -- and a counter that also moved on failures would turn a credential-
// stuffing run into a spike that reads as engagement.
func TestLogin_DoesNotNotifyObserverOnFailure(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		db   *fakeAuthDB
		body string
	}{
		{
			name: "unknown email",
			db: &fakeAuthDB{
				getUserByEmail: func(_ context.Context, _ string) (dbgen.User, error) {
					return dbgen.User{}, pgx.ErrNoRows
				},
			},
			body: `{"email":"nobody@example.com","password":"correct-horse"}`,
		},
		{
			name: "wrong password",
			db: &fakeAuthDB{
				getUserByEmail: func(_ context.Context, _ string) (dbgen.User, error) {
					return fixtureUser(t), nil
				},
			},
			body: `{"email":"lawrence@example.com","password":"not-the-password"}`,
		},
		{
			name: "malformed body never reaches the password check",
			db:   &fakeAuthDB{},
			body: `{"email":"not-an-email"}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := NewHandlers(tc.db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)
			spy := &spyLoginObserver{}
			h.SetLoginObserver(spy)

			rec := httptest.NewRecorder()
			h.Login(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login",
				bytes.NewBufferString(tc.body)))

			if rec.Code == http.StatusOK {
				t.Fatalf("expected a failure status, got 200: %s", rec.Body.String())
			}
			if seen := spy.seen(); len(seen) != 0 {
				t.Fatalf("observer fired %d time(s) on a failed login; want 0", len(seen))
			}
		})
	}
}

// TestLogin_WorksWithNoObserver: the hook is optional wiring, and every test
// in this package that predates it constructs Handlers without one.  A nil
// observer must be a no-op rather than a nil-pointer dereference on the one
// endpoint every user passes through.
func TestLogin_WorksWithNoObserver(t *testing.T) {
	t.Parallel()

	db := &fakeAuthDB{
		getUserByEmail: func(_ context.Context, _ string) (dbgen.User, error) { return fixtureUser(t), nil },
	}
	h := NewHandlers(db, newTestSigner(t), nil, "http://localhost:3000", 15*time.Minute, 7*24*time.Hour, false)

	rec := httptest.NewRecorder()
	h.Login(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login",
		bytes.NewBufferString(`{"email":"lawrence@example.com","password":"correct-horse"}`)))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}
