package admin

// set_password_test.go — POST /api/admin/users/:userId/password.
//
// This endpoint shipped with NO tests of any kind. users_test.go covers
// CreateUser, UpdateUser and DeleteUser across ~40 cases; SetUserPassword
// appears in none of them, even though fakeUserDB has had adminSetPasswordFn
// and adminSetPasswordCallCount wired the whole time — declared, never read.
// It is a live admin route (cmd/server/main.go registers it) that writes a
// credential, so "no coverage" is the wrong amount.
//
// Split into its own file rather than appended to users_test.go, which is
// already past the 800-line guideline.
//
// SCOPE NOTE: these tests pin the HANDLER — status codes, branch ordering,
// that the plaintext is bcrypt-hashed before it reaches the DB layer, and
// that nothing echoes it back. They cannot see what the SQL statement writes;
// a fake records arguments and knows nothing about columns. The column
// behaviour (clearing all three refresh-session columns) is pinned against a
// real Postgres in test/integration/user_session_columns_test.go.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// setPasswordRequest builds a request carrying both the chi userId param and
// admin claims, which is the combination this handler needs and the reason
// users_test.go grew chiCtxOver.
func setPasswordRequest(t *testing.T, targetID string, body string, withClaims bool) *http.Request {
	t.Helper()
	ctx := context.Background()
	if withClaims {
		ctx = withAdminClaims(t, ctx, uuid.New(), "root")
	}
	req := requestWithUserID(t, http.MethodPost, "/api/admin/users/"+targetID+"/password", body, targetID)
	return req.WithContext(chiCtxOver(t, ctx, targetID))
}

// assertNoWrite is the assertion most of the failure cases share: the
// credential write must not have happened.
func assertNoWrite(t *testing.T, db *fakeUserDB) {
	t.Helper()
	if n := atomic.LoadInt32(&db.adminSetPasswordCallCount); n != 0 {
		t.Errorf("AdminSetUserPassword called %d times, want 0 — a rejected request wrote a credential", n)
	}
}

// TestSetUserPassword_HappyPath_200 is the load-bearing one. Beyond the 200 it
// pins the two properties that would be silent if wrong: the value handed to
// the DB is a bcrypt hash of what the admin typed (not the plaintext, and not
// a hash of something else), and the response body carries no trace of it.
func TestSetUserPassword_HappyPath_200(t *testing.T) {
	t.Parallel()

	const plaintext = "correct-horse-battery"
	targetID := uuid.MustParse("11111111-1111-1111-1111-111111111111")

	var gotID uuid.UUID
	var gotStored string
	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, id uuid.UUID) (dbgen.User, error) {
			return fixtureDBUser(t, id, "victim"), nil
		},
		adminSetPasswordFn: func(_ context.Context, id uuid.UUID, password string) error {
			gotID, gotStored = id, password
			return nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, targetID.String(), `{"password":"`+plaintext+`"}`, true))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), `{"data":{"success":true}}`; got != want {
		t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
	}
	if n := atomic.LoadInt32(&db.adminSetPasswordCallCount); n != 1 {
		t.Fatalf("AdminSetUserPassword called %d times, want 1", n)
	}
	if gotID != targetID {
		t.Errorf("wrote to id %s, want %s — the password landed on the wrong account", gotID, targetID)
	}

	// The whole point of the endpoint. A handler that forgot to hash would
	// still return 200 and still call the DB with the right id.
	if gotStored == plaintext {
		t.Fatal("plaintext password reached the DB layer unhashed")
	}
	if err := jwtx.ComparePassword(gotStored, plaintext); err != nil {
		t.Errorf("stored value is not a bcrypt hash of the submitted password: %v", err)
	}
}

// TestSetUserPassword_ExactlySixChars_200 is the boundary. The check is
// `len(...) < 6`, so six must pass; a `<= 6` typo would be invisible without
// this and would reject a password the register form accepts.
func TestSetUserPassword_ExactlySixChars_200(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, id uuid.UUID) (dbgen.User, error) {
			return fixtureDBUser(t, id, "victim"), nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":"abcdef"}`, true))

	if rec.Code != http.StatusOK {
		t.Fatalf("six characters must be accepted; status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if n := atomic.LoadInt32(&db.adminSetPasswordCallCount); n != 1 {
		t.Errorf("AdminSetUserPassword called %d times, want 1", n)
	}
}

// TestSetUserPassword_TooShort_400 also pins BRANCH ORDER. getUserByIDFn is
// deliberately left unset, and fakeUserDB.GetUserByID panics when unset — so
// if validation ever moves after the lookup, this test fails loudly instead
// of quietly passing.
func TestSetUserPassword_TooShort_400(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":"short"}`, true))

	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", msgPasswordTooShort)
	assertNoWrite(t, db)
}

// TestSetUserPassword_EmptyPassword_400 — omitting the field decodes to "",
// which is length 0 and takes the same branch. Worth its own case because
// "missing" and "too short" are different mistakes for a caller to make.
func TestSetUserPassword_EmptyPassword_400(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{}`, true))

	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", msgPasswordTooShort)
	assertNoWrite(t, db)
}

// TestSetUserPassword_MalformedBody_400 — a decode failure must not fall
// through to the length check with a zero-value struct and produce the wrong
// error message.
func TestSetUserPassword_MalformedBody_400(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":`, true))

	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", msgInvalidRequestBody)
	assertNoWrite(t, db)
}

// TestSetUserPassword_InvalidUUID_400 pins that the id is parsed before the
// body is read at all — an unparseable id should not consume the request body
// or reach any DB method (both fake methods panic when unset).
func TestSetUserPassword_InvalidUUID_400(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, "not-a-uuid", `{"password":"correct-horse"}`, true))

	assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid user ID")
	assertNoWrite(t, db)
}

// TestSetUserPassword_UserNotFound_404 is the case the handler's own comment
// calls out: the UPDATE is a silent no-op against a missing id, so without the
// pre-check the endpoint would answer 200 for an account that does not exist
// and an admin would believe they had locked someone out.
func TestSetUserPassword_UserNotFound_404(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, _ uuid.UUID) (dbgen.User, error) {
			return dbgen.User{}, pgx.ErrNoRows
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":"correct-horse"}`, true))

	assertErrorEnvelope(t, rec, http.StatusNotFound, "NOT_FOUND", msgUserNotFound)
	assertNoWrite(t, db)
}

// TestSetUserPassword_LookupError_500 — a lookup failure that is NOT
// ErrNoRows must not be reported as "user not found", which would send an
// admin chasing a nonexistent account during an outage.
func TestSetUserPassword_LookupError_500(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, _ uuid.UUID) (dbgen.User, error) {
			return dbgen.User{}, errors.New("connection refused")
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":"correct-horse"}`, true))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	assertNoWrite(t, db)
}

// TestSetUserPassword_WriteError_500 — the write failing must surface as 500.
// A handler that ignored the error would answer `success: true` for a password
// that was never changed, which is the worst possible lie for this endpoint.
func TestSetUserPassword_WriteError_500(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, id uuid.UUID) (dbgen.User, error) {
			return fixtureDBUser(t, id, "victim"), nil
		},
		adminSetPasswordFn: func(_ context.Context, _ uuid.UUID, _ string) error {
			return errors.New("write failed")
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":"correct-horse"}`, true))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); body == `{"data":{"success":true}}` {
		t.Error("reported success for a write that failed")
	}
}

// TestSetUserPassword_MissingClaims_StillSucceeds documents a real asymmetry
// with DeleteUser, which 500s when claims are absent. Here the claims are read
// only to name the acting admin in the audit log, so the write proceeds
// without them.
//
// That is defensible — the route sits behind admin middleware, so claims are
// present in production, and failing a credential write because a log line
// could not be attributed would be the wrong trade. It is pinned rather than
// left implicit because the consequence is an unattributed password change,
// and someone should have to change this test to make that state reachable
// more often.
func TestSetUserPassword_MissingClaims_StillSucceeds(t *testing.T) {
	t.Parallel()

	db := &fakeUserDB{
		getUserByIDFn: func(_ context.Context, id uuid.UUID) (dbgen.User, error) {
			return fixtureDBUser(t, id, "victim"), nil
		},
	}
	h := NewUserHandlers(db, fakeEnqueuer{})

	rec := httptest.NewRecorder()
	h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":"correct-horse"}`, false))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if n := atomic.LoadInt32(&db.adminSetPasswordCallCount); n != 1 {
		t.Errorf("AdminSetUserPassword called %d times, want 1", n)
	}
}

// TestSetUserPassword_LengthCountsRunesNotBytes pins the alignment with the
// register form, which is the thing the doc comment claims and — until this
// was fixed — did not do.
//
// Register validates with go-playground/validator's `min=6` (auth/types.go),
// which counts RUNES for strings. This handler used len(req.Password) < 6,
// which counts BYTES, so "密码密码" — four characters, twelve bytes — was
// rejected by the public form and accepted here. An admin-only endpoint being
// the weakest place in the system to set a password is the wrong way round,
// and the divergence was invisible because both sites read `6`.
//
// Two cases, because only the pair distinguishes rune-counting from
// byte-counting: a short multibyte password must fail, and a six-rune
// multibyte password must pass.
func TestSetUserPassword_LengthCountsRunesNotBytes(t *testing.T) {
	t.Parallel()

	newDB := func() *fakeUserDB {
		return &fakeUserDB{
			getUserByIDFn: func(_ context.Context, id uuid.UUID) (dbgen.User, error) {
				return fixtureDBUser(t, id, "victim"), nil
			},
		}
	}

	t.Run("four CJK runes are rejected despite being twelve bytes", func(t *testing.T) {
		t.Parallel()
		db := newDB()
		h := NewUserHandlers(db, fakeEnqueuer{})

		rec := httptest.NewRecorder()
		h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":"密码密码"}`, true))

		assertErrorEnvelope(t, rec, http.StatusBadRequest, "BAD_REQUEST", msgPasswordTooShort)
		assertNoWrite(t, db)
	})

	t.Run("six CJK runes are accepted", func(t *testing.T) {
		t.Parallel()
		db := newDB()
		h := NewUserHandlers(db, fakeEnqueuer{})

		rec := httptest.NewRecorder()
		h.SetUserPassword(rec, setPasswordRequest(t, uuid.New().String(), `{"password":"密码密码密码"}`, true))

		if rec.Code != http.StatusOK {
			t.Fatalf("six runes must pass; status = %d, body=%s", rec.Code, rec.Body.String())
		}
		if n := atomic.LoadInt32(&db.adminSetPasswordCallCount); n != 1 {
			t.Errorf("AdminSetUserPassword called %d times, want 1", n)
		}
	})
}
