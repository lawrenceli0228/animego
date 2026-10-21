//go:build integration

// user_sessions_test.go — per-device refresh sessions (migration 0052)
// against a real Postgres.
//
// The handler tests (internal/auth) run against a fake that models these
// statements' WHERE clauses.  This file is what keeps the model honest: every
// property below is a property of SQL — a CAS predicate, a trigger, a CHECK,
// a cascade, a row lock — and a fake can only agree with it by construction.
//
// The headline is TestSessions_LoginElsewhereDoesNotEndThisDevice: the real
// handlers on the real schema, two logins for one account, and both devices
// still refresh.  Before 0052 the second login overwrote the account's one
// refresh slot and the first device's next refresh was a 401.
//
// Run with the command CI uses (.github/workflows/unit-tests.yml):
//
//	go test -tags=integration -count=1 -timeout=600s ./test/integration/...
package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/auth"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func tsz(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func sessionSigner(t *testing.T) *jwtx.Signer {
	t.Helper()
	s, err := jwtx.NewSigner("it-access-secret", "it-refresh-secret", 15*time.Minute, 30*24*time.Hour)
	require.NoError(t, err)
	return s
}

// openSession does what auth.startSession does: sign, then insert.
func openSession(t *testing.T, ctx context.Context, q *dbgen.Queries, s *jwtx.Signer, userID uuid.UUID) (string, uuid.UUID) {
	t.Helper()
	sid := uuid.New()
	issued, err := s.SignRefresh(userID, sid)
	require.NoError(t, err)
	require.NoError(t, q.CreateUserSession(ctx, dbgen.CreateUserSessionParams{
		ID: sid, UserID: userID, TokenHash: sha(issued.Token),
		TokenJti: issued.JTI, TokenIat: tsz(issued.IssuedAt), TokenExp: tsz(issued.ExpiresAt),
	}))
	return issued.Token, sid
}

func rotate(ctx context.Context, q *dbgen.Queries, s *jwtx.Signer, userID, sid uuid.UUID, presented string) (string, error) {
	next, err := s.SignRefresh(userID, sid)
	if err != nil {
		return "", err
	}
	_, err = q.RotateUserSession(ctx, dbgen.RotateUserSessionParams{
		NewHash: sha(next.Token), NewJti: next.JTI, NewIat: tsz(next.IssuedAt), NewExp: tsz(next.ExpiresAt),
		ID: sid, UserID: userID, PresentedHash: sha(presented),
	})
	return next.Token, err
}

func sessionCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM user_sessions WHERE user_id = $1`, userID).Scan(&n))
	return n
}

func freshSessionDB(t *testing.T) (context.Context, *pgxpool.Pool, *dbgen.Queries) {
	t.Helper()
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	return ctx, pool, dbgen.New(pool)
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

func TestSessions_RotateMovesCurrentToGraceSlotAndSlidesExpiry(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "rotator")
	t0, sid := openSession(t, ctx, q, s, u.id)
	var expiresBefore time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT expires_at FROM user_sessions WHERE id = $1`, sid).Scan(&expiresBefore))
	time.Sleep(1100 * time.Millisecond) // the next token's exp is a whole second later

	next, err := s.SignRefresh(u.id, sid)
	require.NoError(t, err)
	row, err := q.RotateUserSession(ctx, dbgen.RotateUserSessionParams{
		NewHash: sha(next.Token), NewJti: next.JTI, NewIat: tsz(next.IssuedAt), NewExp: tsz(next.ExpiresAt),
		ID: sid, UserID: u.id, PresentedHash: sha(t0),
	})
	require.NoError(t, err)
	assert.Equal(t, "rotator", row.Username, "RETURNING carries the access token's username")

	got, err := q.GetUserSession(ctx, 30, sid, u.id)
	require.NoError(t, err)
	assert.Equal(t, sha(next.Token), got.TokenHash)
	require.NotNil(t, got.PreviousHash)
	assert.Equal(t, sha(t0), *got.PreviousHash)
	assert.True(t, got.RotatedAt.Valid, "rotated_at stamps the grace clock")
	assert.Equal(t, next.JTI, got.TokenJti)
	var expiresAfter time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT expires_at FROM user_sessions WHERE id = $1`, sid).Scan(&expiresAfter))
	assert.True(t, expiresAfter.After(expiresBefore), "expiry slides with use (%v !> %v)", expiresAfter, expiresBefore)
}

// NewHash and PresentedHash are both strings.  Swapped, the statement
// compiles and matches nothing — every refresh would fall to the grace path
// and then 401.  Only a real row shows it.
func TestSessions_RotateArgumentSwapMatchesNothing(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "swapper")
	t0, sid := openSession(t, ctx, q, s, u.id)
	next, err := s.SignRefresh(u.id, sid)
	require.NoError(t, err)

	_, err = q.RotateUserSession(ctx, dbgen.RotateUserSessionParams{
		NewHash: sha(t0), NewJti: next.JTI, NewIat: tsz(next.IssuedAt), NewExp: tsz(next.ExpiresAt),
		ID: sid, UserID: u.id, PresentedHash: sha(next.Token),
	})

	assert.ErrorIs(t, err, pgx.ErrNoRows)
	got, err := q.GetUserSession(ctx, 30, sid, u.id)
	require.NoError(t, err)
	assert.Equal(t, sha(t0), got.TokenHash, "the row must be untouched")
}

// Two sessions of one user rotate independently: the whole point.
func TestSessions_RotatingOneSessionLeavesTheOtherAlone(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "twodevices")
	a, sidA := openSession(t, ctx, q, s, u.id)
	b, sidB := openSession(t, ctx, q, s, u.id)

	_, err := rotate(ctx, q, s, u.id, sidA, a)
	require.NoError(t, err)

	gotB, err := q.GetUserSession(ctx, 30, sidB, u.id)
	require.NoError(t, err)
	assert.Equal(t, sha(b), gotB.TokenHash)
	assert.Nil(t, gotB.PreviousHash)
	_, err = rotate(ctx, q, s, u.id, sidB, b)
	assert.NoError(t, err, "device B still rotates after device A did")
}

// A token cannot rotate a session it does not belong to, even with the right
// user and a valid signature.
func TestSessions_RotateIsScopedToTheTokensOwnRow(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "scoped")
	other := seedUser(t, ctx, pool, "otheruser")
	a, sidA := openSession(t, ctx, q, s, u.id)
	_, sidB := openSession(t, ctx, q, s, u.id)

	_, err := rotate(ctx, q, s, u.id, sidB, a)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "A's token named B's sid")
	_, err = rotate(ctx, q, s, other.id, sidA, a)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "A's sid under another user id")
}

func TestSessions_RotateRefusesAnExpiredSession(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "expired")
	t0, sid := openSession(t, ctx, q, s, u.id)
	_, err := pool.Exec(ctx, `UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, sid)
	require.NoError(t, err)

	_, err = rotate(ctx, q, s, u.id, sid, t0)

	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

// The grace window re-sends the current token rebuilt from the stored
// claims.  That only works if the claims survive a round trip through
// timestamptz exactly; this is the real round trip.
func TestSessions_StoredClaimsRebuildTheCurrentToken(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "resigner")
	t0, sid := openSession(t, ctx, q, s, u.id)
	t1, err := rotate(ctx, q, s, u.id, sid, t0)
	require.NoError(t, err)

	got, err := q.GetUserSession(ctx, 30, sid, u.id)
	require.NoError(t, err)
	rebuilt, err := s.ResignRefresh(got.UserID, got.ID, got.TokenJti, got.TokenIat.Time, got.TokenExp.Time)
	require.NoError(t, err)

	assert.Equal(t, t1, rebuilt)
	assert.Equal(t, got.TokenHash, sha(rebuilt))
}

// The grace window is judged by the database's clock, the one that stamped
// rotated_at.
func TestSessions_GraceIsJudgedByTheDatabaseClock(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "graceclock")
	t0, sid := openSession(t, ctx, q, s, u.id)

	fresh, err := q.GetUserSession(ctx, 30, sid, u.id)
	require.NoError(t, err)
	assert.False(t, fresh.WithinGrace, "a session never rotated has no grace window")

	_, err = rotate(ctx, q, s, u.id, sid, t0)
	require.NoError(t, err)
	rotated, err := q.GetUserSession(ctx, 30, sid, u.id)
	require.NoError(t, err)
	assert.True(t, rotated.WithinGrace, "just rotated")

	_, err = pool.Exec(ctx, `UPDATE user_sessions SET rotated_at = now() - interval '31 seconds' WHERE id = $1`, sid)
	require.NoError(t, err)
	stale, err := q.GetUserSession(ctx, 30, sid, u.id)
	require.NoError(t, err)
	assert.False(t, stale.WithinGrace, "31 s after the rotation")
}

// ---------------------------------------------------------------------------
// The races the CAS exists for
// ---------------------------------------------------------------------------

func TestSessions_RotationLosesRaceAgainstLogout(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "logoutrace")
	t0, sid := openSession(t, ctx, q, s, u.id)

	n, err := q.DeleteUserSessionIfHeld(ctx, sid, u.id, sha(t0)) // logout lands first
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
	_, err = rotate(ctx, q, s, u.id, sid, t0) // the in-flight rotation

	assert.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Zero(t, sessionCount(t, ctx, pool, u.id), "a rotation must not resurrect a logged-out session")
}

func TestSessions_RotationLosesRaceAgainstPasswordReset(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "resetrace")
	t0, sid := openSession(t, ctx, q, s, u.id)

	require.NoError(t, q.ResetUserPassword(ctx, u.id, newPassword))
	_, err := rotate(ctx, q, s, u.id, sid, t0)

	assert.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Zero(t, sessionCount(t, ctx, pool, u.id))
}

// ---------------------------------------------------------------------------
// Password trigger, cascade, CHECKs
// ---------------------------------------------------------------------------

// Every statement that writes a password ends every session of that user,
// and none of anyone else's — through the trigger, not the statements.
func TestSessions_EveryPasswordWriteEndsThatUsersSessions(t *testing.T) {
	writes := map[string]func(context.Context, *dbgen.Queries, uuid.UUID) error{
		"ResetUserPassword": func(ctx context.Context, q *dbgen.Queries, id uuid.UUID) error {
			return q.ResetUserPassword(ctx, id, newPassword)
		},
		"AdminSetUserPassword": func(ctx context.Context, q *dbgen.Queries, id uuid.UUID) error {
			return q.AdminSetUserPassword(ctx, id, newPassword)
		},
		"UpdateUserPassword": func(ctx context.Context, q *dbgen.Queries, id uuid.UUID) error {
			return q.UpdateUserPassword(ctx, id, newPassword)
		},
	}
	for name, write := range writes {
		t.Run(name, func(t *testing.T) {
			ctx, pool, q := freshSessionDB(t)
			s := sessionSigner(t)
			u := seedUser(t, ctx, pool, "pwtarget")
			bystander := seedUser(t, ctx, pool, "pwbystander")
			openSession(t, ctx, q, s, u.id)
			openSession(t, ctx, q, s, u.id)
			openSession(t, ctx, q, s, bystander.id)

			require.NoError(t, write(ctx, q, u.id))

			assert.Zero(t, sessionCount(t, ctx, pool, u.id), "%s left a session alive", name)
			assert.Equal(t, 1, sessionCount(t, ctx, pool, bystander.id), "%s ended another user's session", name)
		})
	}
}

// The trigger's WHEN clause: a users write that does not change the password
// (a rename, a privacy toggle, the same hash written back) ends nothing.
func TestSessions_NonPasswordUserWritesKeepSessions(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "keeper")
	openSession(t, ctx, q, s, u.id)

	require.NoError(t, q.SetUserPublic(ctx, u.id, false))
	_, err := q.UpdateUsername(ctx, u.id, "keeper2")
	require.NoError(t, err)
	require.NoError(t, q.UpdateUserPassword(ctx, u.id, seedPassword)) // unchanged value

	assert.Equal(t, 1, sessionCount(t, ctx, pool, u.id))
}

func TestSessions_DeletingTheUserCascades(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "deleted")
	openSession(t, ctx, q, s, u.id)

	_, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, u.id)
	require.NoError(t, err)

	assert.Zero(t, sessionCount(t, ctx, pool, u.id))
}

// Nothing usable is stored: a raw token where a digest belongs is a
// constraint violation, as is a grace hash without its clock.
func TestSessions_ChecksRefuseRawTokensAndHalfGraceSlots(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "checks")
	issued, err := s.SignRefresh(u.id, uuid.New())
	require.NoError(t, err)

	err = q.CreateUserSession(ctx, dbgen.CreateUserSessionParams{
		ID: uuid.New(), UserID: u.id, TokenHash: issued.Token,
		TokenJti: issued.JTI, TokenIat: tsz(issued.IssuedAt), TokenExp: tsz(issued.ExpiresAt),
	})
	assertCheckViolation(t, err, "user_sessions_token_hash_chk")

	_, sid := openSession(t, ctx, q, s, u.id)
	_, err = pool.Exec(ctx, `UPDATE user_sessions SET previous_hash = $2 WHERE id = $1`, sid, sha("x"))
	assertCheckViolation(t, err, "user_sessions_grace_pair_chk")
	_, err = pool.Exec(ctx, `UPDATE user_sessions SET legacy_hash = $2 WHERE id = $1`, sid, "T_current")
	assertCheckViolation(t, err, "user_sessions_legacy_hash_chk")
}

func assertCheckViolation(t *testing.T, err error, constraint string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if assert.True(t, errors.As(err, &pgErr), "want a check violation on %s, got %v", constraint, err) {
		assert.Equal(t, "23514", pgErr.Code)
		assert.Equal(t, constraint, pgErr.ConstraintName)
	}
}

// ---------------------------------------------------------------------------
// Opening a session against a password change
// ---------------------------------------------------------------------------

func TestSessions_StartRefusesAPasswordThatChanged(t *testing.T) {
	ctx, pool, _ := freshSessionDB(t)
	s := sessionSigner(t)
	store := auth.NewStore(pool)
	u := seedUser(t, ctx, pool, "changedpw")
	issued, err := s.SignRefresh(u.id, uuid.New())
	require.NoError(t, err)
	arg := dbgen.CreateUserSessionParams{
		ID: uuid.New(), UserID: u.id, TokenHash: sha(issued.Token),
		TokenJti: issued.JTI, TokenIat: tsz(issued.IssuedAt), TokenExp: tsz(issued.ExpiresAt),
	}

	err = store.StartUserSession(ctx, newPassword, arg) // the row holds seedPassword

	assert.ErrorIs(t, err, auth.ErrPasswordChanged)
	assert.Zero(t, sessionCount(t, ctx, pool, u.id))
	require.NoError(t, store.StartUserSession(ctx, seedPassword, arg))
	assert.Equal(t, 1, sessionCount(t, ctx, pool, u.id))
}

// A login that checked the old password while a reset was committing must
// not leave a session behind: the reset's trigger has already run, so
// nothing would ever end it.  The reset is held open by hand and the login
// is confirmed waiting on the users row before the reset commits, so this is
// the race every time.
func TestSessions_LoginRacingAPasswordResetIsRefused(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	signer := sessionSigner(t)
	h := auth.NewHandlers(auth.NewStore(pool), signer, nil, "http://localhost:3000", 15*time.Minute, 30*24*time.Hour, false)
	oldHash, err := jwtx.HashPassword("correct-horse")
	require.NoError(t, err)
	user, err := q.CreateUser(ctx, "resetrace2", "resetrace2@example.com", oldHash)
	require.NoError(t, err)

	reset, err := pool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = reset.Rollback(context.Background()) })
	require.NoError(t, dbgen.New(reset).ResetUserPassword(ctx, user.ID, newPassword))

	done := make(chan int, 1)
	go func() {
		body := bytes.NewBufferString(`{"email":"resetrace2@example.com","password":"correct-horse"}`)
		rec := httptest.NewRecorder()
		h.Login(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", body))
		done <- rec.Code
	}()
	waitForLockWait(t, ctx, pool)
	require.NoError(t, reset.Commit(ctx))

	select {
	case code := <-done:
		assert.Equal(t, http.StatusUnauthorized, code, "a login with the password the reset just replaced")
	case <-time.After(10 * time.Second):
		t.Fatal("the login never returned")
	}
	assert.Zero(t, sessionCount(t, ctx, pool, user.ID), "a session outlived the password reset")
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

func TestSessions_PruneKeepsNewSessionAndMostRecentlyUsed(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "pruned")
	bystander := seedUser(t, ctx, pool, "notpruned")
	openSession(t, ctx, q, s, bystander.id)

	var older []uuid.UUID
	for i := 0; i < 21; i++ {
		_, sid := openSession(t, ctx, q, s, u.id)
		_, err := pool.Exec(ctx, `UPDATE user_sessions SET last_used_at = now() - make_interval(mins => $2) WHERE id = $1`, sid, 100-i)
		require.NoError(t, err)
		older = append(older, sid) // older[0] is the least recently used
	}
	_, expired := openSession(t, ctx, q, s, u.id)
	_, err := pool.Exec(ctx, `UPDATE user_sessions SET expires_at = now() - interval '1 minute', last_used_at = now() WHERE id = $1`, expired)
	require.NoError(t, err)
	// The new session, last used long ago by the clock of a skewed row: it
	// must survive on keep_id alone, not on sort order.
	_, keep := openSession(t, ctx, q, s, u.id)
	_, err = pool.Exec(ctx, `UPDATE user_sessions SET last_used_at = now() - interval '1 year' WHERE id = $1`, keep)
	require.NoError(t, err)

	remaining, err := q.PruneUserSessions(ctx, u.id, keep, 19)
	require.NoError(t, err)

	assert.Equal(t, int64(20), remaining)
	assert.Equal(t, 20, sessionCount(t, ctx, pool, u.id))
	exists := func(id uuid.UUID) bool {
		_, err := q.GetUserSession(ctx, 30, id, u.id)
		return err == nil
	}
	assert.True(t, exists(keep), "the session just created was pruned")
	assert.False(t, exists(expired), "an expired session survived")
	assert.False(t, exists(older[0]), "the least recently used live session survived")
	assert.False(t, exists(older[1]), "the second least recently used live session survived")
	assert.True(t, exists(older[2]))
	assert.Equal(t, 1, sessionCount(t, ctx, pool, bystander.id), "prune reached another user")
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

func TestSessions_DeleteIfHeldMatchesCurrentOrGraceSlotOnly(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "logouter")
	other := seedUser(t, ctx, pool, "logoutother")

	t0, sid := openSession(t, ctx, q, s, u.id)
	t1, err := rotate(ctx, q, s, u.id, sid, t0)
	require.NoError(t, err)
	t2, err := rotate(ctx, q, s, u.id, sid, t1)
	require.NoError(t, err)

	n, err := q.DeleteUserSessionIfHeld(ctx, sid, u.id, sha(t0))
	require.NoError(t, err)
	assert.Zero(t, n, "a token two rotations old must not log its owner out")
	n, err = q.DeleteUserSessionIfHeld(ctx, sid, other.id, sha(t2))
	require.NoError(t, err)
	assert.Zero(t, n, "another user id must not match")

	n, err = q.DeleteUserSessionIfHeld(ctx, sid, u.id, sha(t1))
	require.NoError(t, err)
	assert.Equal(t, int64(1), n, "the grace-slot token ends its session")

	t3, sid2 := openSession(t, ctx, q, s, u.id)
	n, err = q.DeleteUserSessionIfHeld(ctx, sid2, u.id, sha(t3))
	require.NoError(t, err)
	assert.Equal(t, int64(1), n, "the current token ends its session")
}

// ---------------------------------------------------------------------------
// Adoption of pre-0052 tokens
// ---------------------------------------------------------------------------

const legacyToken = "legacy.refresh.token"

func setLegacyToken(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id uuid.UUID, tok string) {
	t.Helper()
	_, err := pool.Exec(ctx, `UPDATE users SET refresh_token = $2, previous_refresh_token = NULL, refresh_rotated_at = NULL WHERE id = $1`, id, tok)
	require.NoError(t, err)
}

func adoptParams(t *testing.T, s *jwtx.Signer, userID uuid.UUID, presented string) (auth.AdoptLegacySessionParams, string) {
	t.Helper()
	sid := uuid.New()
	next, err := s.SignRefresh(userID, sid)
	require.NoError(t, err)
	h := sha(presented)
	return auth.AdoptLegacySessionParams{
		UserID:         userID,
		PresentedToken: presented,
		Session: dbgen.InsertAdoptedSessionParams{
			ID: sid, UserID: userID, TokenHash: sha(next.Token), LegacyHash: &h,
			TokenJti: next.JTI, TokenIat: tsz(next.IssuedAt), TokenExp: tsz(next.ExpiresAt),
		},
	}, next.Token
}

func TestSessions_AdoptionMovesTheTokenOffTheUsersRow(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	store := auth.NewStore(pool)
	u := seedUser(t, ctx, pool, "adopter")
	setLegacyToken(t, ctx, pool, u.id, legacyToken)
	p, next := adoptParams(t, s, u.id, legacyToken)

	row, err := store.AdoptLegacySession(ctx, p)
	require.NoError(t, err)
	assert.Equal(t, "adopter", row.Username)

	user, err := q.GetUserByID(ctx, u.id)
	require.NoError(t, err)
	assertSessionCleared(t, user, "adoption")
	h := sha(legacyToken)
	adopted, err := q.GetUserSessionByLegacyHash(ctx, 30, u.id, &h)
	require.NoError(t, err)
	assert.Equal(t, p.Session.ID, adopted.ID)
	assert.Equal(t, sha(next), adopted.TokenHash)
	require.NotNil(t, adopted.PreviousHash)
	assert.Equal(t, h, *adopted.PreviousHash, "the old token sits in the grace slot")
	assert.True(t, adopted.RotatedAt.Valid)

	// Once only: the same old token cannot be adopted again.
	p2, _ := adoptParams(t, s, u.id, legacyToken)
	_, err = store.AdoptLegacySession(ctx, p2)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Equal(t, 1, sessionCount(t, ctx, pool, u.id))
}

func TestSessions_AdoptionNeedsTheTokenTheRowHolds(t *testing.T) {
	ctx, pool, _ := freshSessionDB(t)
	s := sessionSigner(t)
	store := auth.NewStore(pool)
	u := seedUser(t, ctx, pool, "notheld") // holds T_current
	p, _ := adoptParams(t, s, u.id, legacyToken)

	_, err := store.AdoptLegacySession(ctx, p)

	assert.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Zero(t, sessionCount(t, ctx, pool, u.id))
}

// A legacy_hash conflict rolls back the claim too: the users row keeps the
// token rather than losing it to a session that was never written.
func TestSessions_AdoptionConflictRollsBackTheClaim(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	store := auth.NewStore(pool)
	u := seedUser(t, ctx, pool, "conflicted")
	setLegacyToken(t, ctx, pool, u.id, legacyToken)
	first, _ := adoptParams(t, s, u.id, legacyToken)
	_, err := q.InsertAdoptedSession(ctx, first.Session) // as if adopted already
	require.NoError(t, err)
	p, _ := adoptParams(t, s, u.id, legacyToken)

	_, err = store.AdoptLegacySession(ctx, p)

	assert.ErrorIs(t, err, pgx.ErrNoRows)
	user, err := q.GetUserByID(ctx, u.id)
	require.NoError(t, err)
	if assert.NotNil(t, user.RefreshToken, "the claim was not rolled back") {
		assert.Equal(t, legacyToken, *user.RefreshToken)
	}
}

// Two refreshes adopting the same old token at once: the second blocks on
// the users row lock, re-checks the predicate after the first commits,
// matches nothing, and writes nothing.  The first transaction is held open by
// hand and the second is confirmed waiting before it is released, so this is
// the race every time rather than whenever the scheduler obliges.
func TestSessions_ConcurrentAdoptionYieldsOneSession(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	store := auth.NewStore(pool)
	u := seedUser(t, ctx, pool, "racer")
	setLegacyToken(t, ctx, pool, u.id, legacyToken)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	first, _ := adoptParams(t, s, u.id, legacyToken)
	_, err = dbgen.New(tx).ClaimLegacyRefreshToken(ctx, u.id, &first.PresentedToken)
	require.NoError(t, err)

	second, _ := adoptParams(t, s, u.id, legacyToken)
	done := make(chan error, 1)
	go func() {
		_, err := store.AdoptLegacySession(ctx, second)
		done <- err
	}()
	waitForLockWait(t, ctx, pool)

	_, err = dbgen.New(tx).InsertAdoptedSession(ctx, first.Session)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))

	select {
	case err := <-done:
		assert.ErrorIs(t, err, pgx.ErrNoRows)
	case <-time.After(10 * time.Second):
		t.Fatal("the second adoption never returned")
	}
	assert.Equal(t, 1, sessionCount(t, ctx, pool, u.id))
	h := sha(legacyToken)
	adopted, err := q.GetUserSessionByLegacyHash(ctx, 30, u.id, &h)
	require.NoError(t, err)
	assert.Equal(t, first.Session.ID, adopted.ID, "the session is the first adopter's")
}

// waitForLockWait polls until some backend is blocked on a lock.
func waitForLockWait(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`).Scan(&waiting))
		if waiting > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("nothing blocked on the users row lock")
}

// Logout with an old cookie also ends the session a racing refresh adopted
// it into.
func TestSessions_DeleteByLegacyHash(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	store := auth.NewStore(pool)
	u := seedUser(t, ctx, pool, "legacylogout")
	setLegacyToken(t, ctx, pool, u.id, legacyToken)
	p, _ := adoptParams(t, s, u.id, legacyToken)
	_, err := store.AdoptLegacySession(ctx, p)
	require.NoError(t, err)
	openSession(t, ctx, q, s, u.id) // another device, untouched

	h := sha(legacyToken)
	n, err := q.DeleteUserSessionByLegacyHash(ctx, u.id, &h)
	require.NoError(t, err)

	assert.Equal(t, int64(1), n)
	assert.Equal(t, 1, sessionCount(t, ctx, pool, u.id))
}

// ---------------------------------------------------------------------------
// End to end: the real handlers on the real schema
// ---------------------------------------------------------------------------

func TestSessions_LoginElsewhereDoesNotEndThisDevice(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	signer := sessionSigner(t)
	h := auth.NewHandlers(auth.NewStore(pool), signer, nil, "http://localhost:3000", 15*time.Minute, 30*24*time.Hour, false)
	hash, err := jwtx.HashPassword("correct-horse")
	require.NoError(t, err)
	_, err = q.CreateUser(ctx, "twobrowsers", "twobrowsers@example.com", hash)
	require.NoError(t, err)

	login := func() string {
		body := bytes.NewBufferString(`{"email":"twobrowsers@example.com","password":"correct-horse"}`)
		rec := httptest.NewRecorder()
		h.Login(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", body))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		return cookieValue(t, rec, auth.RefreshCookieName)
	}
	refresh := func(cookie string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
		req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: cookie})
		rec := httptest.NewRecorder()
		h.Refresh(rec, req)
		return rec
	}

	browserA := login()
	browserB := login()

	recA := refresh(browserA)
	require.Equal(t, http.StatusOK, recA.Code, "browser A was signed out by browser B's login: %s", recA.Body.String())
	browserA = cookieValue(t, recA, auth.RefreshCookieName)
	recB := refresh(browserB)
	require.Equal(t, http.StatusOK, recB.Code, "browser B: %s", recB.Body.String())

	// Logout on B leaves A signed in.
	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: cookieValue(t, recB, auth.RefreshCookieName)})
	h.Logout(httptest.NewRecorder(), req)
	assert.Equal(t, http.StatusOK, refresh(browserA).Code, "browser B's logout signed browser A out")
}

// A browser signed in before the deploy keeps its session across it.
func TestSessions_LegacyCookieSurvivesTheDeploy(t *testing.T) {
	ctx, pool, _ := freshSessionDB(t)
	signer := sessionSigner(t)
	h := auth.NewHandlers(auth.NewStore(pool), signer, nil, "http://localhost:3000", 15*time.Minute, 30*24*time.Hour, false)
	u := seedUser(t, ctx, pool, "predeploy")
	legacy, err := legacyJWT(u.id)
	require.NoError(t, err)
	setLegacyToken(t, ctx, pool, u.id, legacy)

	refresh := func(cookie string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
		req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: cookie})
		rec := httptest.NewRecorder()
		h.Refresh(rec, req)
		return rec
	}

	first := refresh(legacy)
	require.Equal(t, http.StatusOK, first.Code, first.Body.String())
	adopted := cookieValue(t, first, auth.RefreshCookieName)
	claims, err := signer.VerifyRefresh(adopted)
	require.NoError(t, err)
	assert.NotEqual(t, uuid.Nil, claims.SessionID, "the adopted cookie names its session")

	second := refresh(adopted)
	assert.Equal(t, http.StatusOK, second.Code, "the adopted session rotates normally: %s", second.Body.String())
}

func cookieValue(t *testing.T, rec *httptest.ResponseRecorder, name string) string {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == name && c.Value != "" {
			return c.Value
		}
	}
	t.Fatalf("no %s cookie in response: %s", name, rec.Body.String())
	return ""
}

// legacyJWT signs a refresh token in the pre-0052 shape (no sid, no jti)
// with sessionSigner's refresh secret.
func legacyJWT(userID uuid.UUID) (string, error) {
	now := time.Now()
	return jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId": userID.String(),
		"iat":    now.Unix(),
		"exp":    now.Add(time.Hour).Unix(),
	}).SignedString([]byte("it-refresh-secret"))
}
