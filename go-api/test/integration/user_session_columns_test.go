//go:build integration

// user_session_columns_test.go — the refresh-session column writes on `users`,
// against a real Postgres.
//
// The three columns only mean anything together:
//
//	refresh_token           the currently-valid token
//	previous_refresh_token  honored for refreshGraceWindow (30 s) after a
//	                        rotation, so the loser of a concurrent refresh
//	                        is not logged out
//	refresh_rotated_at      when the rotation happened; gates that window
//
// ── WHY THESE PROPERTIES NEED A REAL DATABASE ──
// The handler tests use a hand-written fake (auth.fakeAuthDB) that records
// the arguments a method was called with.  That is the wrong instrument for
// every claim below, because every claim is about what a SQL string DOES:
// which columns it writes, which it leaves alone, and which rows it matches.
// A fake answers none of those and reports success regardless.
//
// The HTTP surface cannot substitute either.  The Refresh handler nil-guards
// `user.RefreshToken` before entering the grace branch, so a row with the old
// buggy shape (current NULL, previous loaded) and a row with the correct
// shape (all three NULL) both produce exactly 401.  Reading the columns is
// the only way to tell a correct revocation from an incomplete one.
//
// ── THE TWO BUGS THIS PINS ──
//  1. ResetUserPassword / AdminSetUserPassword used to null refresh_token
//     alone, leaving previous_refresh_token loaded.  For up to 30 s after a
//     password change the grace branch accepted the row and then dereferenced
//     a nil *refresh_token, panicking into a 500.  An availability bug, not a
//     credential leak — the signed token never reached the response writer.
//  2. RotateRefreshToken had no CAS predicate, so a rotation already in
//     flight would write a live token back over a logout or a password reset
//     that landed between the handler's read and its write.  That one DID
//     hand out credentials: the user pressed logout and stayed signed in,
//     with a fresh 7-day cookie.
//
// The CAS in particular is why the swap case below exists.  new_token and
// expected_token are both *string, so passing them in the wrong order
// compiles, type-checks, and passes every fake-based test — while matching
// zero rows, sending every refresh to the grace path, and 401-ing the whole
// site 30 seconds later.  Only asserting that the row actually changed
// catches it.
//
// Run with the command CI uses (.github/workflows/unit-tests.yml), so a
// failure here reproduces exactly:
//
//	go test -tags=integration -count=1 -timeout=600s ./test/integration/...
//
// -race is optional and slower; the package has no concurrency of its own.
package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// seededUser is a user row with EVERY session column loaded, which is the
// arrange step the rest of the suite is missing: insertPgUser (e2e) and
// seedSafetyUser both omit the refresh columns, so a statement that fails to
// clear them writes NULL over NULL and looks correct.
type seededUser struct {
	id        uuid.UUID
	updatedAt time.Time
	// rotatedAt is captured so the rotation test can assert the clock MOVED.
	// Comparing against a slack window instead ("after seed time minus a
	// minute") passes even when RotateRefreshToken stops writing the column
	// at all, because the seed already set it to now().
	rotatedAt time.Time
}

const (
	seedCurrentToken  = "T_current"
	seedPreviousToken = "T_previous"
	seedResetToken    = "R_reset"
	seedPassword      = "$2a$10$originalhashoriginalhashoriginalhashoriginalhashoriginal"
	newPassword       = "$2a$10$replacementhashreplacementhashreplacementhashreplacement"
)

// testCtx bounds every test in this file.  The package shares one Postgres
// and TruncateAll takes ACCESS EXCLUSIVE on 29 tables, so a connection still
// held by an earlier test's cleanup would block here forever.  That is not
// currently reachable — pgxpool.Close waits for checked-out connections and
// t.Cleanup is LIFO, so river clients stop before their pool closes — but an
// unbounded context turns any future regression into a whole-binary timeout
// panic dumping every goroutine, instead of one named test failing.
func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// seedUser inserts one fully-loaded user.
//
// Two schema details that are easy to get wrong and fail only at runtime:
// email must be lowercase (migration 0009 added CHECK (email = lower(email))),
// and role must be 'admin' or NULL — users_role_chk in 0001_init admits no
// 'user' value, so an ordinary account carries NULL there.
func seedUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) seededUser {
	t.Helper()

	var (
		id      uuid.UUID
		updated time.Time
		rotated time.Time
	)
	err := pool.QueryRow(ctx, `
		INSERT INTO users (
			username, email, password, role, is_public,
			refresh_token, previous_refresh_token, refresh_rotated_at,
			reset_password_token, reset_password_expires,
			avatar_url, backdrop_anilist_id
		) VALUES (
			$1, $2, $3, NULL, true,
			$4, $5, now(),
			$6, now() + interval '1 hour',
			'avatar-sentinel', 42
		)
		RETURNING id, updated_at, refresh_rotated_at`,
		name, name+"@example.com", seedPassword,
		seedCurrentToken, seedPreviousToken, seedResetToken,
	).Scan(&id, &updated, &rotated)
	require.NoError(t, err, "seed user %s", name)

	return seededUser{id: id, updatedAt: updated, rotatedAt: rotated}
}

// assertSessionCleared checks all three columns are NULL.
//
// refresh_rotated_at is asserted on .Valid rather than "differs from before".
// Setting it to now() instead of NULL is the most plausible wrong version of
// this change — it looks like bookkeeping — and a differs-from-before check
// would pass on it.
func assertSessionCleared(t *testing.T, u dbgen.User, label string) {
	t.Helper()
	assert.Nil(t, u.RefreshToken, "%s: refresh_token must be NULL", label)
	assert.Nil(t, u.PreviousRefreshToken,
		"%s: previous_refresh_token must be NULL — a loaded grace slot survives the revocation", label)
	assert.False(t, u.RefreshRotatedAt.Valid,
		"%s: refresh_rotated_at must be NULL, got %v", label, u.RefreshRotatedAt.Time)
}

// assertUntouchedFields pins the columns none of these statements may write.
// Without it, "the session columns are NULL" also passes for a statement that
// nulls half the row.
func assertUntouchedFields(t *testing.T, u dbgen.User, label string) {
	t.Helper()
	assert.True(t, u.IsPublic, "%s: is_public must be untouched", label)
	if assert.NotNil(t, u.AvatarUrl, "%s: avatar_url must be untouched", label) {
		assert.Equal(t, "avatar-sentinel", *u.AvatarUrl, "%s: avatar_url", label)
	}
	if assert.NotNil(t, u.BackdropAnilistID, "%s: backdrop_anilist_id must be untouched", label) {
		assert.Equal(t, int32(42), *u.BackdropAnilistID, "%s: backdrop_anilist_id", label)
	}
}

// TestResetUserPassword_ClearsAllThreeSessionColumns is case 1 + 2: the
// forgot-password write clears the session and the reset token, writes the
// new hash, and touches nothing else.
func TestResetUserPassword_ClearsAllThreeSessionColumns(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "resetuser")

	require.NoError(t, q.ResetUserPassword(ctx, seeded.id, newPassword))

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)

	assertSessionCleared(t, got, "ResetUserPassword")
	assert.Equal(t, newPassword, got.Password, "the new hash must land")
	assert.Nil(t, got.ResetPasswordToken, "reset_password_token must be consumed")
	assert.False(t, got.ResetPasswordExpires.Valid, "reset_password_expires must be cleared")

	assertUntouchedFields(t, got, "ResetUserPassword")

	// updated_at is asserted for its own sake, not as proof the row was
	// visited — the password assertion above is already that witness, since a
	// WHERE matching zero rows would leave seedPassword in place and fail
	// there first.  What this catches is dropping `updated_at = now()` from
	// the SET clause, which nothing else in this file would notice.
	assert.True(t, got.UpdatedAt.Time.After(seeded.updatedAt),
		"updated_at must advance (%v !> %v)", got.UpdatedAt.Time, seeded.updatedAt)
}

// TestAdminSetUserPassword_ClearsSessionButKeepsResetToken is case 3.  The
// asymmetry with ResetUserPassword — same session clearing, but the
// reset-token columns are deliberately left alone — is documented in
// users.sql and checked nowhere else.  It is exactly the property a
// copy-paste between the two adjacent statements would break.
func TestAdminSetUserPassword_ClearsSessionButKeepsResetToken(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "adminuser")

	require.NoError(t, q.AdminSetUserPassword(ctx, seeded.id, newPassword))

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)

	assertSessionCleared(t, got, "AdminSetUserPassword")
	assert.Equal(t, newPassword, got.Password)
	assertUntouchedFields(t, got, "AdminSetUserPassword")

	if assert.NotNil(t, got.ResetPasswordToken,
		"AdminSetUserPassword must NOT consume the reset token — that belongs to the self-serve flow") {
		assert.Equal(t, seedResetToken, *got.ResetPasswordToken)
	}
	assert.True(t, got.ResetPasswordExpires.Valid,
		"AdminSetUserPassword must leave reset_password_expires alone")
}

// TestUpdateUserPassword_ClearsSessionAndLeavesResetToken is case 4.  The
// statement is dormant, and that is the reason to test it rather than a reason
// to skip it: the shape it ships in is the shape its first caller will trust.
//
// Named for what it asserts rather than "matches its siblings", because the
// siblings do not agree with each other — ResetUserPassword consumes the
// reset-token columns and AdminSetUserPassword deliberately does not. This one
// matches AdminSetUserPassword, and the reset-token half is asserted below so
// that claim is checked rather than implied.
func TestUpdateUserPassword_ClearsSessionAndLeavesResetToken(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "dormantuser")

	require.NoError(t, q.UpdateUserPassword(ctx, seeded.id, newPassword))

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)

	assertSessionCleared(t, got, "UpdateUserPassword")
	assert.Equal(t, newPassword, got.Password)
	assertUntouchedFields(t, got, "UpdateUserPassword")

	if assert.NotNil(t, got.ResetPasswordToken,
		"UpdateUserPassword must not consume the reset token — it is not the forgot-password flow") {
		assert.Equal(t, seedResetToken, *got.ResetPasswordToken)
	}
	assert.True(t, got.ResetPasswordExpires.Valid, "reset_password_expires must be left alone")
}

// TestPasswordWrites_DoNotTouchOtherUsers is case 5: the WHERE clause is
// scoped.  Cheap, and it is the row-level equivalent of the CAS predicate
// below — both are "this statement matched the right thing", which is the
// class of property a fake cannot represent.
func TestPasswordWrites_DoNotTouchOtherUsers(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	target := seedUser(t, ctx, pool, "target")
	bystander := seedUser(t, ctx, pool, "bystander")

	require.NoError(t, q.ResetUserPassword(ctx, target.id, newPassword))
	require.NoError(t, q.AdminSetUserPassword(ctx, target.id, newPassword))

	// Prove the writes landed somewhere first.  Without this the whole test
	// passes against a statement whose WHERE matches nothing — "the bystander
	// is unchanged" is trivially true when NOBODY changed.
	hit, err := q.GetUserByID(ctx, target.id)
	require.NoError(t, err)
	assertSessionCleared(t, hit, "target")

	got, err := q.GetUserByID(ctx, bystander.id)
	require.NoError(t, err)

	if assert.NotNil(t, got.RefreshToken, "bystander lost their session to another user's password change") {
		assert.Equal(t, seedCurrentToken, *got.RefreshToken)
	}
	if assert.NotNil(t, got.PreviousRefreshToken) {
		assert.Equal(t, seedPreviousToken, *got.PreviousRefreshToken)
	}
	assert.True(t, got.RefreshRotatedAt.Valid, "bystander's grace clock was cleared")
	assert.Equal(t, seedPassword, got.Password, "bystander's password was overwritten")
}

// TestRotateRefreshToken_CASMatchesAndRotates is the happy path, and the one
// that catches an argument swap.  Asserting the ROW CHANGED is the point: a
// swapped call matches zero rows, which surfaces as ErrNoRows here but as a
// silent fall-to-grace in production.
func TestRotateRefreshToken_CASMatchesAndRotates(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "rotateuser")

	// Promote to admin purely so the RETURNING assertion below has a non-NULL
	// role to prove.  Ordinary accounts carry NULL, and "nil came back" is
	// equally consistent with the column never being read.
	_, err := pool.Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, seeded.id)
	require.NoError(t, err, "promote seed user")

	newTok := "T_new"
	expected := seedCurrentToken
	row, err := q.RotateRefreshToken(ctx, &newTok, seeded.id, &expected)
	require.NoError(t, err, "CAS must match when the expected token is current")

	// RETURNING feeds SignAccess directly, so wrong values here mint a token
	// carrying the wrong identity or the wrong privilege rather than failing.
	assert.Equal(t, "rotateuser", row.Username)
	if assert.NotNil(t, row.Role, "role must survive RETURNING — SignAccess puts it in the JWT") {
		assert.Equal(t, "admin", *row.Role)
	}

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)

	if assert.NotNil(t, got.RefreshToken) {
		assert.Equal(t, newTok, *got.RefreshToken, "current slot must hold the new token")
	}
	if assert.NotNil(t, got.PreviousRefreshToken) {
		assert.Equal(t, seedCurrentToken, *got.PreviousRefreshToken,
			"the old current token must move into the grace slot, not the caller's new one")
	}
	assert.True(t, got.RefreshRotatedAt.Valid, "the grace window needs a clock")
	assert.True(t, got.RefreshRotatedAt.Time.After(seeded.rotatedAt),
		"refresh_rotated_at must be re-stamped BY THIS ROTATION (%v must be after the seeded %v); "+
			"a stale clock means the 30s window is measured from someone else's rotation",
		got.RefreshRotatedAt.Time, seeded.rotatedAt)
}

// TestRotateRefreshToken_ArgumentSwapMatchesNothing states the failure mode
// explicitly instead of leaving it implied.  Both parameters are *string, so
// this call is indistinguishable from the correct one to the compiler and to
// every fake in the tree.
func TestRotateRefreshToken_ArgumentSwapMatchesNothing(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "swapuser")

	newTok := "T_new"
	expected := seedCurrentToken

	// Deliberately reversed: expected passed as new_token, new passed as
	// expected_token.
	_, err := q.RotateRefreshToken(ctx, &expected, seeded.id, &newTok)
	assert.True(t, errors.Is(err, pgx.ErrNoRows),
		"a swapped CAS must match nothing; got err=%v — if this ever returns a row, "+
			"the predicate is not doing its job and every refresh silently falls to grace", err)

	// A missed CAS must write NOTHING — all four columns the statement would
	// otherwise touch. Checking only refresh_token would pass a predicate that
	// blocks the token swap but still stamps the clock.
	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)
	if assert.NotNil(t, got.RefreshToken) {
		assert.Equal(t, seedCurrentToken, *got.RefreshToken, "a missed CAS must not write refresh_token")
	}
	if assert.NotNil(t, got.PreviousRefreshToken) {
		assert.Equal(t, seedPreviousToken, *got.PreviousRefreshToken, "a missed CAS must not write the grace slot")
	}
	assert.Equal(t, seeded.rotatedAt, got.RefreshRotatedAt.Time, "a missed CAS must not re-stamp the clock")
	assert.Equal(t, seeded.updatedAt, got.UpdatedAt.Time, "a missed CAS must not bump updated_at")
}

// TestRotateRefreshToken_LosesRaceAgainstLogout is the reason the predicate
// exists.  Without it the UPDATE is unconditional and writes a live 7-day
// token back over a logout that landed first — the user presses logout and
// stays signed in.
func TestRotateRefreshToken_LosesRaceAgainstLogout(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "raceuser")

	// The logout lands between the in-flight handler's read and its write.
	require.NoError(t, q.UpdateUserRefreshToken(ctx, seeded.id, nil))

	// The in-flight rotation still believes the pre-logout token is current.
	newTok := "T_new"
	expected := seedCurrentToken
	_, err := q.RotateRefreshToken(ctx, &newTok, seeded.id, &expected)
	assert.True(t, errors.Is(err, pgx.ErrNoRows),
		"a rotation racing a logout must match nothing; got err=%v", err)

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)
	assert.Nil(t, got.RefreshToken,
		"the logout must stick — a resurrected token here is a 7-day session the user asked to end")
	assert.Nil(t, got.PreviousRefreshToken, "logout must clear the grace slot too")
	assert.False(t, got.RefreshRotatedAt.Valid, "logout must clear the grace clock too")
}

// TestRotateRefreshToken_LosesRaceAgainstPasswordReset is the same race with
// the password reset in the middle, which is the version that matters: the
// user is resetting precisely because they believe someone else has their
// credential.  It also pins the interaction between the two fixes — the CAS
// blocks the write, and the reset having cleared all three columns means
// there is no grace slot for the loser to fall back onto.
func TestRotateRefreshToken_LosesRaceAgainstPasswordReset(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "resetraceuser")

	require.NoError(t, q.ResetUserPassword(ctx, seeded.id, newPassword))

	newTok := "T_new"
	expected := seedCurrentToken
	_, err := q.RotateRefreshToken(ctx, &newTok, seeded.id, &expected)
	assert.True(t, errors.Is(err, pgx.ErrNoRows),
		"a rotation racing a password reset must match nothing; got err=%v", err)

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)
	assertSessionCleared(t, got, "reset then losing rotation")
}

// TestRotateRefreshToken_DeletedUserMatchesNothing covers the id half of the
// predicate against a row that really existed and really was deleted, which is
// the situation the handler meets when an admin removes an account while one
// of its tabs has a refresh in flight.
//
// Seeding and deleting rather than rotating a random uuid against an empty
// table: the random-uuid version would pass against `WHERE id = $1` with no
// CAS at all, and against essentially any schema, so it asserted nothing about
// this statement.
func TestRotateRefreshToken_DeletedUserMatchesNothing(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "deleteduser")
	_, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, seeded.id)
	require.NoError(t, err, "delete seed user")

	newTok := "T_new"
	expected := seedCurrentToken
	_, err = q.RotateRefreshToken(ctx, &newTok, seeded.id, &expected)
	assert.True(t, errors.Is(err, pgx.ErrNoRows),
		"rotating a deleted user must match nothing; got err=%v", err)

	_, err = q.GetUserByID(ctx, seeded.id)
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "the row must stay deleted, got err=%v", err)
}

// ---------------------------------------------------------------------------
// ClearRefreshTokenIfMatches — logout's predicated write
// ---------------------------------------------------------------------------

// TestClearRefreshToken_MatchesCurrent is the ordinary logout: the tab holds
// the row's live token, so the session ends.
//
// This is also the case that proves adding the predicate did not reinstate the
// bug that took logout off RequireAuth. That bug was about an expired ACCESS
// token; the refresh cookie of an idle tab is still the row's current value,
// so the predicate matches and the row clears.
func TestClearRefreshToken_MatchesCurrent(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "logoutcurrent")

	presented := seedCurrentToken
	n, err := q.ClearRefreshTokenIfMatches(ctx, seeded.id, &presented)
	require.NoError(t, err)
	assert.EqualValues(t, 1, n, "the live token must match")

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)
	assertSessionCleared(t, got, "ClearRefreshTokenIfMatches(current)")
	assertUntouchedFields(t, got, "ClearRefreshTokenIfMatches(current)")
	assert.Equal(t, seedPassword, got.Password, "logout must not touch the password")
}

// TestClearRefreshToken_MatchesGraceSlot keeps the predicate from being too
// tight. A tab that refreshed a moment ago is holding the token that just
// moved into previous_refresh_token — a legitimate session that must be able
// to end itself. Matching only refresh_token would 200-and-do-nothing for
// exactly the users who were most recently active.
func TestClearRefreshToken_MatchesGraceSlot(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "logoutgrace")

	presented := seedPreviousToken
	n, err := q.ClearRefreshTokenIfMatches(ctx, seeded.id, &presented)
	require.NoError(t, err)
	assert.EqualValues(t, 1, n, "the grace-slot token belongs to a live session")

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)
	assertSessionCleared(t, got, "ClearRefreshTokenIfMatches(grace)")
}

// TestClearRefreshToken_StaleTokenClearsNothing is the reason the predicate
// exists. A refresh token stays signature-valid for its full 7-day TTL, so a
// revoked one still verifies; without the predicate, replaying it would null
// whatever session the row currently holds, turning a dead credential into a
// week-long forced-logout weapon aimed at one user.
func TestClearRefreshToken_StaleTokenClearsNothing(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "logoutstale")

	stale := "a-token-this-row-no-longer-holds"
	n, err := q.ClearRefreshTokenIfMatches(ctx, seeded.id, &stale)
	require.NoError(t, err)
	assert.EqualValues(t, 0, n, "a token the row does not hold must match nothing")

	got, err := q.GetUserByID(ctx, seeded.id)
	require.NoError(t, err)
	if assert.NotNil(t, got.RefreshToken, "the live session was destroyed by a stale token") {
		assert.Equal(t, seedCurrentToken, *got.RefreshToken)
	}
	if assert.NotNil(t, got.PreviousRefreshToken) {
		assert.Equal(t, seedPreviousToken, *got.PreviousRefreshToken)
	}
	assert.Equal(t, seeded.updatedAt, got.UpdatedAt.Time, "a non-matching clear must not bump updated_at")
}

// TestClearRefreshToken_WrongUserClearsNothing covers the id half. The token
// here is a real live token — for somebody else's row.
func TestClearRefreshToken_WrongUserClearsNothing(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	victim := seedUser(t, ctx, pool, "logoutvictim")
	other := seedUser(t, ctx, pool, "logoutother")

	presented := seedCurrentToken
	n, err := q.ClearRefreshTokenIfMatches(ctx, other.id, &presented)
	require.NoError(t, err)
	assert.EqualValues(t, 1, n, "it matched the row it was aimed at")

	got, err := q.GetUserByID(ctx, victim.id)
	require.NoError(t, err)
	assert.NotNil(t, got.RefreshToken,
		"logging out one account must not end another's, even when both hold the same token value")
}

// TestClearRefreshToken_NullRowMatchesNothing pins the SQL NULL semantics that
// make the predicate safe on an already-logged-out row: `NULL = NULL` is NULL,
// not true, so a caller presenting anything against a cleared row matches zero
// rows rather than "succeeding" against an empty session.
func TestClearRefreshToken_NullRowMatchesNothing(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	seeded := seedUser(t, ctx, pool, "logouttwice")

	presented := seedCurrentToken
	first, err := q.ClearRefreshTokenIfMatches(ctx, seeded.id, &presented)
	require.NoError(t, err)
	require.EqualValues(t, 1, first)

	second, err := q.ClearRefreshTokenIfMatches(ctx, seeded.id, &presented)
	require.NoError(t, err)
	assert.EqualValues(t, 0, second, "a second logout is a no-op, not an error")
}
