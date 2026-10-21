//go:build integration

// user_sessions_devices_test.go — the device list (migration 0053) against a
// real Postgres: the device columns, their CHECKs, the list query and the
// "sign out other devices" transaction.  Helpers come from
// user_sessions_test.go and user_session_columns_test.go.
//
// Run with:
//
//	go test -tags=integration -count=1 -timeout=600s ./test/integration/...
package integration

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/auth"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// openDevice opens a session the way auth.startSession does, with device
// columns.
func openDevice(t *testing.T, ctx context.Context, q *dbgen.Queries, s *jwtx.Signer, userID uuid.UUID, ua, country, city *string) (string, uuid.UUID) {
	t.Helper()
	sid := uuid.New()
	issued, err := s.SignRefresh(userID, sid)
	require.NoError(t, err)
	require.NoError(t, q.CreateUserSession(ctx, dbgen.CreateUserSessionParams{
		ID: sid, UserID: userID, TokenHash: sha(issued.Token),
		TokenJti: issued.JTI, TokenIat: tsz(issued.IssuedAt), TokenExp: tsz(issued.ExpiresAt),
		UserAgent: ua, Country: country, City: city,
	}))
	return issued.Token, sid
}

func deviceCols(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sid uuid.UUID) (ua, country, city *string) {
	t.Helper()
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT user_agent, country, city FROM user_sessions WHERE id = $1`, sid).Scan(&ua, &country, &city))
	return ua, country, city
}

func TestDevices_RotationFollowsTheLatestRequestAndKeepsWhatItDoesNotState(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "rotdevice")
	t0, sid := openDevice(t, ctx, q, s, u.id, ptr("UA-mac"), ptr("CN"), ptr("Shanghai"))

	next, err := s.SignRefresh(u.id, sid)
	require.NoError(t, err)
	_, err = q.RotateUserSession(ctx, dbgen.RotateUserSessionParams{
		NewHash: sha(next.Token), NewJti: next.JTI, NewIat: tsz(next.IssuedAt), NewExp: tsz(next.ExpiresAt),
		ID: sid, UserID: u.id, PresentedHash: sha(t0),
		UserAgent: ptr("UA-mac-updated"), // no location this time
	})
	require.NoError(t, err)

	ua, country, city := deviceCols(t, ctx, pool, sid)
	require.NotNil(t, ua)
	assert.Equal(t, "UA-mac-updated", *ua)
	if assert.NotNil(t, country) && assert.NotNil(t, city) {
		assert.Equal(t, "CN", *country, "an unstated country must not wipe the stored one")
		assert.Equal(t, "Shanghai", *city)
	}
}

func TestDevices_ChecksRefuseMalformedValues(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "devchecks")
	_, sid := openDevice(t, ctx, q, s, u.id, nil, nil, nil)

	for constraint, stmt := range map[string]string{
		"user_sessions_country_chk":        `UPDATE user_sessions SET country = 'cn' WHERE id = $1`,
		"user_sessions_city_len_chk":       `UPDATE user_sessions SET city = '' WHERE id = $1`,
		"user_sessions_user_agent_len_chk": `UPDATE user_sessions SET user_agent = repeat('x', 513) WHERE id = $1`,
	} {
		_, err := pool.Exec(ctx, stmt, sid)
		assertCheckViolation(t, err, constraint)
	}
}

func TestDevices_ListIsTheUsersLiveSessionsMostRecentFirst(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	u := seedUser(t, ctx, pool, "lister")
	other := seedUser(t, ctx, pool, "otherlister")
	_, old := openDevice(t, ctx, q, s, u.id, nil, nil, nil)
	_, recent := openDevice(t, ctx, q, s, u.id, ptr("UA"), ptr("JP"), nil)
	_, expired := openDevice(t, ctx, q, s, u.id, nil, nil, nil)
	openDevice(t, ctx, q, s, other.id, nil, nil, nil)
	_, err := pool.Exec(ctx, `UPDATE user_sessions SET last_used_at = now() - interval '2 days' WHERE id = $1`, old)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, expired)
	require.NoError(t, err)

	rows, err := q.ListUserSessions(ctx, u.id)
	require.NoError(t, err)

	require.Len(t, rows, 2, "expired sessions and other users' sessions are not listed")
	assert.Equal(t, recent, rows[0].ID)
	assert.Equal(t, old, rows[1].ID)
	require.NotNil(t, rows[0].Country)
	assert.Equal(t, "JP", *rows[0].Country)
	assert.True(t, rows[0].CreatedAt.Valid && rows[0].LastUsedAt.Valid)
}

// Sign out other devices: every other row of the user, the pre-0052 token
// on the users row, nothing of anyone else's, and this device untouched.
func TestDevices_RevokeOtherSessionsKeepsThisDeviceOnly(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	s := sessionSigner(t)
	store := auth.NewStore(pool)
	u := seedUser(t, ctx, pool, "revoker") // seeded with a pre-0052 token on the row
	bystander := seedUser(t, ctx, pool, "revokebystander")
	_, keep := openDevice(t, ctx, q, s, u.id, nil, nil, nil)
	openDevice(t, ctx, q, s, u.id, nil, nil, nil)
	openDevice(t, ctx, q, s, u.id, nil, nil, nil)
	openDevice(t, ctx, q, s, bystander.id, nil, nil, nil)

	n, err := store.RevokeOtherSessions(ctx, u.id, keep)
	require.NoError(t, err)

	assert.Equal(t, int64(3), n, "two sessions and the pre-0052 token")
	assert.Equal(t, 1, sessionCount(t, ctx, pool, u.id))
	_, err = q.GetUserSession(ctx, 30, keep, u.id)
	assert.NoError(t, err, "this device's session was ended")
	user, err := q.GetUserByID(ctx, u.id)
	require.NoError(t, err)
	assertSessionCleared(t, user, "RevokeOtherSessions")
	assert.Equal(t, 1, sessionCount(t, ctx, pool, bystander.id), "another user's session was ended")
	bystanderRow, err := q.GetUserByID(ctx, bystander.id)
	require.NoError(t, err)
	assert.NotNil(t, bystanderRow.RefreshToken, "another user's pre-0052 token was cleared")
}

// The real handlers on the real schema: a login records its device, the
// list names it and marks it, and signing out the other devices leaves it.
func TestDevices_EndToEnd(t *testing.T) {
	ctx, pool, q := freshSessionDB(t)
	signer := sessionSigner(t)
	h := auth.NewHandlers(auth.NewStore(pool), signer, nil, "http://localhost:3000", 15*time.Minute, 30*24*time.Hour, false)
	hash, err := jwtx.HashPassword("correct-horse")
	require.NoError(t, err)
	_, err = q.CreateUser(ctx, "devicesuser", "devicesuser@example.com", hash)
	require.NoError(t, err)

	login := func(ua string) (refresh, access string) {
		body := bytes.NewBufferString(`{"email":"devicesuser@example.com","password":"correct-horse"}`)
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
		req.Header.Set("User-Agent", ua)
		req.Header.Set("CF-IPCountry", "CN")
		rec := httptest.NewRecorder()
		h.Login(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		return cookieValue(t, rec, auth.RefreshCookieName), cookieValue(t, rec, "session")
	}
	macRefresh, macAccess := login("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
	login("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")

	router := chi.NewRouter()
	router.With(jwtx.RequireAuth(signer)).Get("/api/auth/sessions", h.ListSessions)
	router.With(jwtx.RequireAuth(signer)).Delete("/api/auth/sessions", h.RevokeOtherSessions)
	call := func(method string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/auth/sessions", nil)
		req.Header.Set("Authorization", "Bearer "+macAccess)
		req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: macRefresh})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	list := call(http.MethodGet)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	assert.Contains(t, list.Body.String(), `"current":true,"kind":"laptop","os":"Mac","browser":"Chrome","city":null,"country":"CN"`)
	assert.Contains(t, list.Body.String(), `"current":false,"kind":"phone","os":"iPhone","browser":"Safari"`)

	revoke := call(http.MethodDelete)
	require.Equal(t, http.StatusOK, revoke.Code, revoke.Body.String())
	assert.Contains(t, revoke.Body.String(), `"revoked":1`)
	assert.Equal(t, 1, countSessionsByEmail(t, ctx, pool, "devicesuser@example.com"))
}

func countSessionsByEmail(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1`, email).Scan(&n))
	return n
}
