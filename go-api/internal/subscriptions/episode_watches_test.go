package subscriptions

// episode_watches_test.go — the per-episode watch marks (migration 0024).
//
//	PUT    /api/subscriptions/{anilistId}/episodes/{episode}
//	DELETE /api/subscriptions/{anilistId}/episodes/{episode}
//
// Split from handlers_test.go / pg_test.go because it is a self-contained
// surface, but it shares their fixtures: fakeSubsDB + makeHandlersWithFakes
// + withUserClaims + assertError from handlers_test.go, pgHandlers +
// seedUser/seedAnime/seedSubscription + readProgress from pg_test.go, and
// the testcontainer TestMain owns for the whole package.
//
// Two layers, for two different kinds of claim:
//
//   - Fake-backed tests own the boundary: what reaches the database and
//     what is refused before it does, and — the one that matters — where
//     the user id comes from.
//   - PG-backed tests own the behaviour, because the whole feature is one
//     SQL statement.  A fake cannot fail the UNION/EXCEPT snapshot rules,
//     the recompute, or the primary key's idempotence, so asserting them
//     against a fake would assert nothing.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// newEpisodeReq builds a request with BOTH chi path params populated.
// newReq in handlers_test.go only injects :anilistId, and these two routes
// take a second segment.
func newEpisodeReq(t *testing.T, method, anilistID, episode string, parentCtx context.Context) *http.Request {
	t.Helper()
	// PathEscape the segments: the invalid-input tables hand over values a
	// URL cannot hold verbatim, and it is the chi route params below (not
	// the target string) that the handlers actually read.
	target := fmt.Sprintf("/api/subscriptions/%s/episodes/%s",
		url.PathEscape(anilistID), url.PathEscape(episode))
	req := httptest.NewRequest(method, target, nil)
	ctx := parentCtx
	if ctx == nil {
		ctx = req.Context()
	}
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", anilistID)
	rc.URLParams.Add("episode", episode)
	return req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rc))
}

// markEpisode / unmarkEpisode run one write against the handler and return
// the recorder.  anilistID and episode are strings so the invalid-input
// tables can hand over things an int32 cannot hold.
func markEpisode(t *testing.T, h *Handlers, ctx context.Context, anilistID, episode string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.MarkEpisodeWatched(rec, newEpisodeReq(t, http.MethodPut, anilistID, episode, ctx))
	return rec
}

func unmarkEpisode(t *testing.T, h *Handlers, ctx context.Context, anilistID, episode string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.UnmarkEpisodeWatched(rec, newEpisodeReq(t, http.MethodDelete, anilistID, episode, ctx))
	return rec
}

// newEpisodeListReq builds a PUT against the bulk route, which takes ONE
// path param and carries its episodes in the body.  The body is a raw
// string so the invalid-input tables can hand over JSON that no Go slice
// type could hold.
func newEpisodeListReq(t *testing.T, anilistID, body string, parentCtx context.Context) *http.Request {
	t.Helper()
	target := fmt.Sprintf("/api/subscriptions/%s/episodes", url.PathEscape(anilistID))
	req := httptest.NewRequest(http.MethodPut, target, strings.NewReader(body))
	ctx := parentCtx
	if ctx == nil {
		ctx = req.Context()
	}
	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", anilistID)
	return req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rc))
}

// markEpisodes runs one bulk write against the handler.
func markEpisodes(t *testing.T, h *Handlers, ctx context.Context, anilistID, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.MarkEpisodesWatched(rec, newEpisodeListReq(t, anilistID, body, ctx))
	return rec
}

// episodeListBody renders a well-formed bulk body, so the behavioural tests
// read as the sets they are about rather than as JSON.
func episodeListBody(episodes ...int32) string {
	parts := make([]string, len(episodes))
	for i, e := range episodes {
		parts[i] = strconv.Itoa(int(e))
	}
	return `{"episodes":[` + strings.Join(parts, ",") + `]}`
}

// decodeEpisodeWatch reads the {"data":{...}} envelope both writes return.
func decodeEpisodeWatch(t *testing.T, rec *httptest.ResponseRecorder) episodeWatchResp {
	t.Helper()
	var got episodeWatchResp
	decodeData(t, rec.Body.Bytes(), &got)
	return got
}

// readWatchedSet reads the stored set through the generated
// ListWatchedEpisodes query — deliberately NOT through the write's own
// return value, so a write that returns a plausible set while storing
// something else fails here instead of passing.
func readWatchedSet(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32) []int32 {
	t.Helper()
	got, err := dbgen.New(pool).ListWatchedEpisodes(context.Background(), userID, anilistID)
	require.NoError(t, err, "ListWatchedEpisodes")
	return got
}

// setCurrentEpisode writes subscriptions.current_episode directly, standing
// in for progress that arrived before this feature existed.
func setCurrentEpisode(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID, episode int32) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`UPDATE subscriptions SET current_episode = $3 WHERE user_id = $1 AND anilist_id = $2`,
		userID, anilistID, episode)
	require.NoError(t, err, "setCurrentEpisode")
}

// readUpdatedAt is how the idempotence tests tell "nothing changed" from
// "changed to a value that happens to look the same".
func readUpdatedAt(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, anilistID int32) time.Time {
	t.Helper()
	var ts time.Time
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT updated_at FROM subscriptions WHERE user_id = $1 AND anilist_id = $2`,
		userID, anilistID).Scan(&ts), "readUpdatedAt")
	return ts
}

// -----------------------------------------------------------------------------
// the auth boundary — fake-backed, because the claim is about what the
// handler passes down, not about what SQL does with it
// -----------------------------------------------------------------------------

func TestEpisodeWatch_MissingAuth_401(t *testing.T) {
	t.Parallel()
	// A fake with no function pointers set panics on any call, so if either
	// handler ever reached the database without claims this test would
	// crash rather than quietly pass.
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)

	t.Run("mark", func(t *testing.T) {
		t.Parallel()
		rec := markEpisode(t, h, nil, "42", "3")
		assert.Equal(t, http.StatusUnauthorized, rec.Code, "body=%s", rec.Body.String())
	})
	t.Run("unmark", func(t *testing.T) {
		t.Parallel()
		rec := unmarkEpisode(t, h, nil, "42", "3")
		assert.Equal(t, http.StatusUnauthorized, rec.Code, "body=%s", rec.Body.String())
	})
}

// The IDOR boundary, stated as a unit test: the user id handed to the
// query is the one from the verified JWT claims, and nothing a caller can
// put in the URL — path segment, query string — can influence it.
//
// The two routes take no user-identifying path param at all, and that is
// the design.  This test exists so that if someone later adds one and
// wires the handler to read it, the assertion below fails immediately with
// a message naming the problem, rather than the change shipping and being
// found by a user reading somebody else's watch history.
func TestEpisodeWatch_UserIDComesFromClaimsOnly(t *testing.T) {
	t.Parallel()

	caller := uuid.New()
	victim := uuid.New()

	var seenMark, seenUnmark uuid.UUID
	db := &fakeSubsDB{
		markFn: func(_ context.Context, userID uuid.UUID, _ int32, _ int32) (dbgen.MarkEpisodeWatchedRow, error) {
			seenMark = userID
			return dbgen.MarkEpisodeWatchedRow{WatchedEpisodes: []int32{3}, CurrentEpisode: 3}, nil
		},
		unmarkFn: func(_ context.Context, userID uuid.UUID, _ int32, _ int32) (dbgen.UnmarkEpisodeWatchedRow, error) {
			seenUnmark = userID
			return dbgen.UnmarkEpisodeWatchedRow{WatchedEpisodes: []int32{}, CurrentEpisode: 0}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), caller, "alice")

	// Every channel a caller controls names the victim.  None of them is
	// read, so none of them can matter.
	hostile := fmt.Sprintf("/api/subscriptions/42/episodes/3?userId=%s&user_id=%s", victim, victim)

	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "42")
	rc.URLParams.Add("episode", "3")
	rc.URLParams.Add("userId", victim.String()) // a path param that does not exist on this route
	hostileCtx := context.WithValue(ctx, chi.RouteCtxKey, rc)

	rec := httptest.NewRecorder()
	h.MarkEpisodeWatched(rec, httptest.NewRequest(http.MethodPut, hostile, nil).WithContext(hostileCtx))
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	rec2 := httptest.NewRecorder()
	h.UnmarkEpisodeWatched(rec2, httptest.NewRequest(http.MethodDelete, hostile, nil).WithContext(hostileCtx))
	require.Equal(t, http.StatusOK, rec2.Code, "body=%s", rec2.Body.String())

	assert.Equal(t, caller, seenMark,
		"mark must scope to the JWT subject; a user id readable from the request is an IDOR")
	assert.Equal(t, caller, seenUnmark,
		"unmark must scope to the JWT subject; a user id readable from the request is an IDOR")
	assert.NotEqual(t, victim, seenMark)
	assert.NotEqual(t, victim, seenUnmark)
}

// -----------------------------------------------------------------------------
// input validation — and the proof that a rejected request never reaches
// the database, so the CHECK constraint stays a backstop and not an error
// path
// -----------------------------------------------------------------------------

func TestEpisodeWatch_InvalidEpisode_400_NeverReachesDB(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, raw string }{
		{"zero", "0"},
		{"negative", "-1"},
		{"above check bound", "5001"},
		{"far above check bound", "2147483647"},
		{"non-numeric", "abc"},
		{"empty", ""},
		{"fractional", "1.5"},
		{"leading plus with space", " 3"},
		// int32 overflow: 4294967297 == 2^32 + 1.  int32(int(4294967297))
		// is 1, so an Atoi-then-cast parser would accept this and mark
		// episode 1 — a different row than the one named.
		{"wraps int32 if cast", "4294967297"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			// No function pointers: any call panics the test.
			db := &fakeSubsDB{}
			h := makeHandlersWithFakes(db, nil, nil)
			ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

			rec := markEpisode(t, h, ctx, "42", tc.raw)
			assertError(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid episode number")

			rec2 := unmarkEpisode(t, h, ctx, "42", tc.raw)
			assertError(t, rec2, http.StatusBadRequest, "BAD_REQUEST", "Invalid episode number")

			assert.Zero(t, db.markCalls, "rejected episode must not reach the database")
			assert.Zero(t, db.unmarkCalls, "rejected episode must not reach the database")
		})
	}
}

// -----------------------------------------------------------------------------
// the bulk route's boundary — PUT /{anilistId}/episodes
// -----------------------------------------------------------------------------

func TestMarkEpisodes_MissingAuth_401(t *testing.T) {
	t.Parallel()
	// No function pointers: reaching the database without claims panics.
	h := makeHandlersWithFakes(&fakeSubsDB{}, nil, nil)
	rec := markEpisodes(t, h, nil, "42", episodeListBody(3, 5))
	assert.Equal(t, http.StatusUnauthorized, rec.Code, "body=%s", rec.Body.String())
}

// The IDOR boundary again, and on this route it needs restating rather than
// inheriting: the bulk write is the first one that takes a request BODY, so
// "a user id can only come from the JWT" now has one more channel to be
// wrong through.  It is not read, so it cannot matter — and this test is
// what makes that a checked fact rather than a reading of the handler.
func TestMarkEpisodes_UserIDComesFromClaimsOnly(t *testing.T) {
	t.Parallel()

	caller := uuid.New()
	victim := uuid.New()

	var seen uuid.UUID
	db := &fakeSubsDB{
		markManyFn: func(_ context.Context, userID uuid.UUID, _ int32, episodes []int32) (dbgen.MarkEpisodesWatchedRow, error) {
			seen = userID
			return dbgen.MarkEpisodesWatchedRow{WatchedEpisodes: episodes, CurrentEpisode: episodes[len(episodes)-1]}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), caller, "alice")

	body := fmt.Sprintf(`{"episodes":[3,5],"userId":"%s","user_id":"%s"}`, victim, victim)
	target := fmt.Sprintf("/api/subscriptions/42/episodes?userId=%s", victim)

	rc := chi.NewRouteContext()
	rc.URLParams.Add("anilistId", "42")
	rc.URLParams.Add("userId", victim.String()) // a param this route does not have
	req := httptest.NewRequest(http.MethodPut, target, strings.NewReader(body)).
		WithContext(context.WithValue(ctx, chi.RouteCtxKey, rc))

	rec := httptest.NewRecorder()
	h.MarkEpisodesWatched(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	assert.Equal(t, caller, seen,
		"the bulk write must scope to the JWT subject; a user id readable from path, query OR BODY is an IDOR")
	assert.NotEqual(t, victim, seen)
}

// The body's SHAPE, as distinct from its contents.  Everything here is a
// caller with nothing to write, and each is answered 400 rather than a
// successful-looking no-op that hides the bug.
func TestMarkEpisodes_InvalidBody_400_NeverReachesDB(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, body string }{
		{"empty body", ""},
		{"malformed json", `{"episodes":[3,`},
		{"null body", `null`},
		{"key absent", `{}`},
		{"explicit null", `{"episodes":null}`},
		{"empty array", `{"episodes":[]}`},
		{"not an array", `{"episodes":3}`},
		{"one past the cap", episodeListBody(capExceedingList()...)},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			db := &fakeSubsDB{}
			h := makeHandlersWithFakes(db, nil, nil)
			ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

			assertError(t, markEpisodes(t, h, ctx, "42", tc.body),
				http.StatusBadRequest, "VALIDATION_ERROR", "Invalid episode list")
			assert.Zero(t, db.markManyCalls, "a rejected body must not reach the database")
		})
	}
}

// capExceedingList builds the shortest array the cap refuses.
func capExceedingList() []int32 {
	out := make([]int32, maxEpisodesPerRequest+1)
	for i := range out {
		// Every member is individually valid, so the ONLY thing wrong with
		// this request is its length — otherwise the test would pass for
		// the wrong reason.
		out[i] = int32(i%maxEpisodeNumber) + 1
	}
	return out
}

// One bad member refuses the WHOLE request.  This is the property the
// batching depends on: the caller learns from one answer what happened to
// the set, so a partial write it cannot see is worse than a 400.
func TestMarkEpisodes_OneBadMemberRejectsTheWholeCall(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, body string }{
		{"zero", `{"episodes":[3,0,5]}`},
		{"negative", `{"episodes":[3,-1,5]}`},
		{"above check bound", `{"episodes":[3,5001,5]}`},
		{"far above check bound", `{"episodes":[3,2147483647,5]}`},
		{"fractional", `{"episodes":[3,1.5,5]}`},
		// 2^32 + 1.  int32(int(4294967297)) is 1, so a parser that cast
		// instead of range-checking would mark episode 1 — a different
		// episode than the one named, silently, inside a bulk write.
		{"wraps int32 if cast", `{"episodes":[3,4294967297,5]}`},
		{"bad member is last", `{"episodes":[3,5,0]}`},
		{"bad member is first", `{"episodes":[0,3,5]}`},
		// Not-a-number members answer the SAME message as out-of-range
		// ones.  json.Number would have split these: "3" silently accepted
		// as episode 3, "abc" refused as a malformed body — one rule, two
		// answers, depending on whether the garbage looked numeric.
		{"quoted number", `{"episodes":[3,"5"]}`},
		{"non-numeric string", `{"episodes":[3,"abc"]}`},
		{"null member", `{"episodes":[3,null]}`},
		{"boolean member", `{"episodes":[3,true]}`},
		{"object member", `{"episodes":[3,{"episode":5}]}`},
		{"nested array", `{"episodes":[3,[5]]}`},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			db := &fakeSubsDB{}
			h := makeHandlersWithFakes(db, nil, nil)
			ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

			// Same message the single-episode route answers, because it is
			// the same rule.
			assertError(t, markEpisodes(t, h, ctx, "42", tc.body),
				http.StatusBadRequest, "VALIDATION_ERROR", "Invalid episode number")
			assert.Zero(t, db.markManyCalls,
				"the valid members must not be written either — all or nothing")
		})
	}
}

// The cap is derived from the CHECK bound rather than picked, so an array
// exactly as long as the range of legal episodes is legal.  Pinned so a cap
// tightened to a round number fails here instead of refusing a real
// long-runner's first sync.
func TestMarkEpisodes_CapIsTheTightestThatRefusesNothingLegitimate(t *testing.T) {
	t.Parallel()
	assert.Equal(t, maxEpisodeNumber, maxEpisodesPerRequest,
		"a shorter cap can refuse a request a caller had a reason to send")

	full := make([]int32, maxEpisodesPerRequest)
	for i := range full {
		full[i] = int32(i) + 1
	}
	var got []int32
	db := &fakeSubsDB{
		markManyFn: func(_ context.Context, _ uuid.UUID, _ int32, episodes []int32) (dbgen.MarkEpisodesWatchedRow, error) {
			got = episodes
			return dbgen.MarkEpisodesWatchedRow{WatchedEpisodes: episodes, CurrentEpisode: maxEpisodeNumber}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	rec := markEpisodes(t, h, ctx, "42", episodeListBody(full...))
	require.Equal(t, http.StatusOK, rec.Code, "an array of every legal episode must be accepted")
	assert.Len(t, got, maxEpisodesPerRequest)
}

// A repeated episode is redundant, not invalid: the statement collapses it
// and the caller is not made responsible for de-duplicating a set it may
// describe however it likes.
func TestMarkEpisodes_DuplicatesArePassedThroughUntouched(t *testing.T) {
	t.Parallel()
	var got []int32
	db := &fakeSubsDB{
		markManyFn: func(_ context.Context, _ uuid.UUID, _ int32, episodes []int32) (dbgen.MarkEpisodesWatchedRow, error) {
			got = episodes
			return dbgen.MarkEpisodesWatchedRow{WatchedEpisodes: []int32{3, 5}, CurrentEpisode: 5}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	rec := markEpisodes(t, h, ctx, "42", `{"episodes":[3,5,3,5,3]}`)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.Equal(t, []int32{3, 5, 3, 5, 3}, got)
}

func TestMarkEpisodes_InvalidAnilistID_400_NeverReachesDB(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"0", "-5", "abc", "4294967297"} {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()
			db := &fakeSubsDB{}
			h := makeHandlersWithFakes(db, nil, nil)
			ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

			assertError(t, markEpisodes(t, h, ctx, raw, episodeListBody(3, 5)),
				http.StatusBadRequest, "BAD_REQUEST", "Invalid anime ID")
			assert.Zero(t, db.markManyCalls, "rejected anime id must not reach the database")
		})
	}
}

func TestMarkEpisodes_NoSubscription_404_NothingWritten(t *testing.T) {
	t.Parallel()
	db := &fakeSubsDB{
		markManyFn: func(_ context.Context, _ uuid.UUID, _ int32, _ []int32) (dbgen.MarkEpisodesWatchedRow, error) {
			return dbgen.MarkEpisodesWatchedRow{}, pgx.ErrNoRows
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	assertError(t, markEpisodes(t, h, ctx, "42", episodeListBody(3, 5)),
		http.StatusNotFound, "NOT_FOUND", "Subscription not found")
}

// §4 decision 4, on the route that needs it most.  The reconciler's
// episodes come from a LOCAL binding; a binding pointing at the wrong show
// is exactly what the ceiling catches, and it must keep catching it now
// that the reconciler no longer sends PATCH.  The MAXIMUM member is
// checked, because it dominates every other one.
func TestMarkEpisodes_AboveTotalEpisodeCount_400_NeverReachesDB(t *testing.T) {
	t.Parallel()
	total := int32(12)
	db := &fakeSubsDB{
		episodeCountFn: func(_ context.Context, _ int32) (*int32, error) { return &total, nil },
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	// 13 is buried in the middle, and the bound is still found.
	assertError(t, markEpisodes(t, h, ctx, "42", episodeListBody(1, 13, 2)),
		http.StatusBadRequest, "VALIDATION_ERROR", "Episode exceeds the total episode count")
	assert.Zero(t, db.markManyCalls, "a mis-bound push must write none of its episodes")
}

func TestMarkEpisodes_UpToTheTotalEpisodeCount_200(t *testing.T) {
	t.Parallel()
	total := int32(12)
	db := &fakeSubsDB{
		episodeCountFn: func(_ context.Context, _ int32) (*int32, error) { return &total, nil },
		markManyFn: func(_ context.Context, _ uuid.UUID, _ int32, episodes []int32) (dbgen.MarkEpisodesWatchedRow, error) {
			return dbgen.MarkEpisodesWatchedRow{WatchedEpisodes: episodes, CurrentEpisode: 12}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	// "Finished" is episode == total, not total - 1; the PATCH bound has
	// always accepted it and this one must agree.
	rec := markEpisodes(t, h, ctx, "42", episodeListBody(11, 12))
	assert.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
}

// The wire contract, pinned literally — the client replaces its whole grid
// from this body, and it is the same body the two per-episode routes emit.
func TestMarkEpisodes_ResponseShape(t *testing.T) {
	t.Parallel()
	db := &fakeSubsDB{
		markManyFn: func(_ context.Context, _ uuid.UUID, _ int32, _ []int32) (dbgen.MarkEpisodesWatchedRow, error) {
			// nil rather than []int32{} — the worst a driver could hand back.
			return dbgen.MarkEpisodesWatchedRow{WatchedEpisodes: nil, CurrentEpisode: 0}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	rec := markEpisodes(t, h, ctx, "42", episodeListBody(3))
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.JSONEq(t, `{"data":{"anilistId":42,"watchedEpisodes":[],"currentEpisode":0}}`, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"watchedEpisodes":[]`,
		"empty set must serialize as [], never null")
}

func TestEpisodeWatch_InvalidAnilistID_400_NeverReachesDB(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, raw string }{
		{"zero", "0"},
		{"negative", "-5"},
		{"non-numeric", "abc"},
		// The same overflow, on the other path param.  Cast carelessly,
		// 4294967297 addresses anime 1 — a real, popular row.
		{"wraps int32 if cast", "4294967297"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			db := &fakeSubsDB{}
			h := makeHandlersWithFakes(db, nil, nil)
			ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

			rec := markEpisode(t, h, ctx, tc.raw, "3")
			assertError(t, rec, http.StatusBadRequest, "BAD_REQUEST", "Invalid anime ID")

			rec2 := unmarkEpisode(t, h, ctx, tc.raw, "3")
			assertError(t, rec2, http.StatusBadRequest, "BAD_REQUEST", "Invalid anime ID")

			assert.Zero(t, db.markCalls, "rejected anime id must not reach the database")
			assert.Zero(t, db.unmarkCalls, "rejected anime id must not reach the database")
		})
	}
}

// The bound the handler enforces and the bound the CHECK enforces are one
// bound written twice; this pins them equal so a change to either without
// the other is a failing test rather than a 500 in production.
func TestEpisodeWatch_HandlerBoundMatchesCheckConstraint(t *testing.T) {
	t.Parallel()
	assert.Equal(t, 5000, maxEpisodeNumber,
		"maxEpisodeNumber must match the CHECK on episode_watches.episode in migration 0024")
}

func TestEpisodeWatch_NoSubscription_404(t *testing.T) {
	t.Parallel()
	db := &fakeSubsDB{
		markFn: func(_ context.Context, _ uuid.UUID, _ int32, _ int32) (dbgen.MarkEpisodeWatchedRow, error) {
			return dbgen.MarkEpisodeWatchedRow{}, pgx.ErrNoRows
		},
		unmarkFn: func(_ context.Context, _ uuid.UUID, _ int32, _ int32) (dbgen.UnmarkEpisodeWatchedRow, error) {
			return dbgen.UnmarkEpisodeWatchedRow{}, pgx.ErrNoRows
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	assertError(t, markEpisode(t, h, ctx, "42", "3"),
		http.StatusNotFound, "NOT_FOUND", "Subscription not found")
	assertError(t, unmarkEpisode(t, h, ctx, "42", "3"),
		http.StatusNotFound, "NOT_FOUND", "Subscription not found")
}

// The wire contract, pinned literally: the client reconciles its whole
// grid from this body, so its shape is not an implementation detail.
func TestEpisodeWatch_ResponseShape(t *testing.T) {
	t.Parallel()
	db := &fakeSubsDB{
		markFn: func(_ context.Context, _ uuid.UUID, _ int32, _ int32) (dbgen.MarkEpisodeWatchedRow, error) {
			return dbgen.MarkEpisodeWatchedRow{WatchedEpisodes: []int32{1, 2, 5}, CurrentEpisode: 5}, nil
		},
		unmarkFn: func(_ context.Context, _ uuid.UUID, _ int32, _ int32) (dbgen.UnmarkEpisodeWatchedRow, error) {
			// nil rather than []int32{} — the worst case a driver could hand
			// back for an empty array.
			return dbgen.UnmarkEpisodeWatchedRow{WatchedEpisodes: nil, CurrentEpisode: 0}, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)
	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	rec := markEpisode(t, h, ctx, "42", "5")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.JSONEq(t,
		`{"data":{"anilistId":42,"watchedEpisodes":[1,2,5],"currentEpisode":5}}`,
		rec.Body.String())

	rec2 := unmarkEpisode(t, h, ctx, "42", "5")
	require.Equal(t, http.StatusOK, rec2.Code, "body=%s", rec2.Body.String())
	assert.JSONEq(t,
		`{"data":{"anilistId":42,"watchedEpisodes":[],"currentEpisode":0}}`,
		rec2.Body.String())
	assert.Contains(t, rec2.Body.String(), `"watchedEpisodes":[]`,
		"empty set must serialize as [], never null")
}

// -----------------------------------------------------------------------------
// routing — the two new routes share a subtree with `/{anilistId}`, and
// this repo has already been bitten once by chi pinning a param name into
// a radix node (see the /api/comments note in cmd/server/main.go)
// -----------------------------------------------------------------------------

func TestEpisodeRoutes_DoNotCollideWithTheSubscriptionRoutes(t *testing.T) {
	t.Parallel()

	var markedAnilist, markedEpisode int32
	var markedSet []int32
	var deletedSubscription bool
	db := &fakeSubsDB{
		markFn: func(_ context.Context, _ uuid.UUID, anilistID, episode int32) (dbgen.MarkEpisodeWatchedRow, error) {
			markedAnilist, markedEpisode = anilistID, episode
			return dbgen.MarkEpisodeWatchedRow{WatchedEpisodes: []int32{episode}, CurrentEpisode: episode}, nil
		},
		markManyFn: func(_ context.Context, _ uuid.UUID, _ int32, episodes []int32) (dbgen.MarkEpisodesWatchedRow, error) {
			markedSet = episodes
			return dbgen.MarkEpisodesWatchedRow{WatchedEpisodes: episodes, CurrentEpisode: episodes[len(episodes)-1]}, nil
		},
		unmarkFn: func(_ context.Context, _ uuid.UUID, _, episode int32) (dbgen.UnmarkEpisodeWatchedRow, error) {
			markedEpisode = episode
			return dbgen.UnmarkEpisodeWatchedRow{WatchedEpisodes: []int32{}, CurrentEpisode: 0}, nil
		},
		deleteFn: func(_ context.Context, _ uuid.UUID, _ int32) (int64, error) {
			deletedSubscription = true
			return 1, nil
		},
	}
	h := makeHandlersWithFakes(db, nil, nil)

	// Same registration order and shape as cmd/server/main.go's
	// /api/subscriptions block, minus the auth middleware (claims are
	// injected on the request context instead).
	r := chi.NewRouter()
	r.Route("/api/subscriptions", func(r chi.Router) {
		r.Get("/", h.ListSubscriptions)
		r.Post("/", h.CreateSubscription)
		r.Get("/{anilistId}", h.GetSubscriptionByAnilistID)
		r.Patch("/{anilistId}", h.UpdateSubscription)
		r.Delete("/{anilistId}", h.DeleteSubscription)
		r.Put("/{anilistId}/episodes", h.MarkEpisodesWatched)
		r.Put("/{anilistId}/episodes/{episode}", h.MarkEpisodeWatched)
		r.Delete("/{anilistId}/episodes/{episode}", h.UnmarkEpisodeWatched)
	})

	ctx := withUserClaims(t, context.Background(), uuid.New(), "alice")

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/subscriptions/42/episodes/7", nil).WithContext(ctx))
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.Equal(t, int32(42), markedAnilist, "both path params must bind, in the right order")
	assert.Equal(t, int32(7), markedEpisode)
	assert.Nil(t, markedSet, "the two-segment PUT must not reach the bulk handler")

	// The bulk PUT is one segment shallower, and `episodes` must not be
	// swallowed as an {episode} value by the deeper route.
	recBulk := httptest.NewRecorder()
	r.ServeHTTP(recBulk, httptest.NewRequest(http.MethodPut, "/api/subscriptions/42/episodes",
		strings.NewReader(episodeListBody(3, 5, 7))).WithContext(ctx))
	require.Equal(t, http.StatusOK, recBulk.Code, "body=%s", recBulk.Body.String())
	assert.Equal(t, []int32{3, 5, 7}, markedSet, "PUT on the one-segment path must mark the set")
	assert.Equal(t, int32(7), markedEpisode, "and must not have reached the single-episode handler")

	// The one-segment DELETE must still reach the subscription handler and
	// not be swallowed by the two-segment one.
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, httptest.NewRequest(http.MethodDelete, "/api/subscriptions/42", nil).WithContext(ctx))
	require.Equal(t, http.StatusOK, rec2.Code, "body=%s", rec2.Body.String())
	assert.True(t, deletedSubscription, "DELETE /{anilistId} must still delete the subscription")

	rec3 := httptest.NewRecorder()
	r.ServeHTTP(rec3, httptest.NewRequest(http.MethodDelete, "/api/subscriptions/42/episodes/7", nil).WithContext(ctx))
	require.Equal(t, http.StatusOK, rec3.Code, "body=%s", rec3.Body.String())
	assert.Equal(t, int32(7), markedEpisode, "DELETE on the two-segment path must unmark, not unsubscribe")
}

// -----------------------------------------------------------------------------
// behaviour — real SQL, because the feature IS the statement
// -----------------------------------------------------------------------------

// The whole reason the table exists: marking episode 5 marks episode 5,
// and says nothing at all about 1 through 4.
func TestPG_MarkEpisode_MarksOnlyThatEpisode(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	rec := markEpisode(t, h, ctx, "1", "5")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	got := decodeEpisodeWatch(t, rec)
	assert.Equal(t, int32(1), got.AnilistID)
	assert.Equal(t, []int32{5}, got.WatchedEpisodes,
		"the old rule would have claimed 1-4 as well; that claim was false")
	assert.Equal(t, int32(5), got.CurrentEpisode)

	assert.Equal(t, []int32{5}, readWatchedSet(t, pool, user, 1),
		"the stored set must match what the response promised")
	ep, lwt := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(5), ep, "current_episode is MAX over the set")
	assert.NotNil(t, lwt, "marking an episode watched IS a watch — last_watched_at moves")
}

func TestPG_MarkEpisode_IsIdempotent(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "5").Code)

	beforeUpdated := readUpdatedAt(t, pool, user, 1)
	_, beforeWatched := readProgress(t, pool, user, 1)
	require.NotNil(t, beforeWatched)

	rec := markEpisode(t, h, ctx, "1", "5")
	require.Equal(t, http.StatusOK, rec.Code, "a repeat mark is a success, not a conflict")

	got := decodeEpisodeWatch(t, rec)
	assert.Equal(t, []int32{5}, got.WatchedEpisodes)
	assert.Equal(t, []int32{5}, readWatchedSet(t, pool, user, 1), "no duplicate row")

	afterUpdated := readUpdatedAt(t, pool, user, 1)
	_, afterWatched := readProgress(t, pool, user, 1)
	assert.True(t, beforeUpdated.Equal(afterUpdated),
		"a mark that changed nothing must not reorder the continue-watching list")
	require.NotNil(t, afterWatched)
	assert.True(t, beforeWatched.Equal(*afterWatched),
		"a mark that changed nothing did not watch anything")
}

func TestPG_UnmarkEpisode_RemovesIt(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "3").Code)
	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "7").Code)
	require.Equal(t, []int32{3, 7}, readWatchedSet(t, pool, user, 1))

	rec := unmarkEpisode(t, h, ctx, "1", "3")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	got := decodeEpisodeWatch(t, rec)
	assert.Equal(t, []int32{7}, got.WatchedEpisodes)
	assert.Equal(t, []int32{7}, readWatchedSet(t, pool, user, 1))
}

// Unmarking something that was never marked is the state the caller asked
// for.  404-ing would force the UI to read before it can write.
func TestPG_UnmarkEpisode_AbsentIsNotAnError(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	ctx := withUserClaims(t, context.Background(), user, "alice")
	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "4").Code)
	beforeUpdated := readUpdatedAt(t, pool, user, 1)

	rec := unmarkEpisode(t, h, ctx, "1", "9")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	got := decodeEpisodeWatch(t, rec)
	assert.Equal(t, []int32{4}, got.WatchedEpisodes, "set unchanged")
	assert.Equal(t, int32(4), got.CurrentEpisode)
	assert.True(t, beforeUpdated.Equal(readUpdatedAt(t, pool, user, 1)),
		"a delete that deleted nothing must not bump updated_at")
}

// current_episode is COALESCE(MAX(episode), 0) over the set, at every step
// — including the step where the last mark goes and it has to reach 0.
func TestPG_CurrentEpisodeTracksMaxOfTheSet(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	steps := []struct {
		op      string
		episode string
		want    int32
		note    string
	}{
		{"mark", "3", 3, "first mark sets the max"},
		{"mark", "7", 7, "a higher mark raises it"},
		{"mark", "5", 7, "a lower mark does not lower the max"},
		{"unmark", "5", 7, "removing a non-max mark leaves the max alone"},
		{"unmark", "7", 3, "removing the max falls back to the next one down"},
		{"unmark", "3", 0, "removing the last mark returns to zero"},
	}
	for _, s := range steps {
		var rec *httptest.ResponseRecorder
		if s.op == "mark" {
			rec = markEpisode(t, h, ctx, "1", s.episode)
		} else {
			rec = unmarkEpisode(t, h, ctx, "1", s.episode)
		}
		require.Equal(t, http.StatusOK, rec.Code, "%s %s: body=%s", s.op, s.episode, rec.Body.String())

		got := decodeEpisodeWatch(t, rec)
		assert.Equal(t, s.want, got.CurrentEpisode, "%s %s: %s (response)", s.op, s.episode, s.note)

		stored, _ := readProgress(t, pool, user, 1)
		assert.Equal(t, s.want, stored, "%s %s: %s (stored)", s.op, s.episode, s.note)
	}

	assert.Empty(t, readWatchedSet(t, pool, user, 1), "every mark was removed")
}

// The recompute sits on the HUMAN side of the monotonic line: a person
// unchecking a box may move current_episode down, exactly as the detail
// page's ± buttons may.  The monotonic guard exists to stop a stale replay
// from doing this by accident, not to stop a user from doing it on purpose.
func TestPG_UnmarkEpisode_MayLowerCurrentEpisode(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "12").Code)
	stored, _ := readProgress(t, pool, user, 1)
	require.Equal(t, int32(12), stored)

	// A monotonic push at the same episode — the automated sync path,
	// which must NOT be what decides whether the correction below sticks.
	require.Equal(t, http.StatusOK,
		patchSubscription(t, h, user, 1, `{"currentEpisode":12,"monotonic":true}`).Code)

	rec := unmarkEpisode(t, h, ctx, "1", "12")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	stored, _ = readProgress(t, pool, user, 1)
	assert.Equal(t, int32(0), stored,
		"a human correcting the record moves the number down; no GREATEST on this path")
}

// Marking an episode of an anime the caller has no subscription to writes
// nothing and answers 404.  The alternative the code rejects is not the
// 404 — it is succeeding, storing a watch row that no consumer of
// subscriptions can ever see.
func TestPG_MarkEpisode_WithoutSubscription_404AndWritesNothing(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲") // cached, but never subscribed

	ctx := withUserClaims(t, context.Background(), user, "alice")
	assertError(t, markEpisode(t, h, ctx, "1", "3"),
		http.StatusNotFound, "NOT_FOUND", "Subscription not found")
	assertError(t, unmarkEpisode(t, h, ctx, "1", "3"),
		http.StatusNotFound, "NOT_FOUND", "Subscription not found")

	assert.Empty(t, readWatchedSet(t, pool, user, 1),
		"a 404 must not leave a row behind")
}

// The IDOR boundary against a real database and a real second user.
//
// If the write ever keyed off anything a caller supplies rather than the
// JWT subject, bob's requests below would reach into alice's rows — and
// the assertions on alice's set are what would fail, loudly, naming the
// row that moved.
func TestPG_EpisodeWatch_CannotTouchAnotherUsersRows(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, alice, 1, "watching")
	seedSubscription(t, pool, bob, 1, "watching")

	aliceCtx := withUserClaims(t, context.Background(), alice, "alice")
	bobCtx := withUserClaims(t, context.Background(), bob, "bob")

	for _, ep := range []string{"1", "2", "3"} {
		require.Equal(t, http.StatusOK, markEpisode(t, h, aliceCtx, "1", ep).Code)
	}
	require.Equal(t, []int32{1, 2, 3}, readWatchedSet(t, pool, alice, 1))

	// Bob, authenticated as himself, aims every write at the same anime.
	rec := markEpisode(t, h, bobCtx, "1", "9")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.Equal(t, []int32{9}, decodeEpisodeWatch(t, rec).WatchedEpisodes,
		"bob must see his own set, not alice's")

	rec2 := unmarkEpisode(t, h, bobCtx, "1", "2")
	require.Equal(t, http.StatusOK, rec2.Code, "body=%s", rec2.Body.String())
	assert.Equal(t, []int32{9}, decodeEpisodeWatch(t, rec2).WatchedEpisodes)

	assert.Equal(t, []int32{1, 2, 3}, readWatchedSet(t, pool, alice, 1),
		"bob's unmark must not have reached episode 2 of ALICE's row")
	assert.Equal(t, []int32{9}, readWatchedSet(t, pool, bob, 1))

	aliceEp, _ := readProgress(t, pool, alice, 1)
	bobEp, _ := readProgress(t, pool, bob, 1)
	assert.Equal(t, int32(3), aliceEp, "alice's derived progress must be untouched")
	assert.Equal(t, int32(9), bobEp)
}

// GET /api/subscriptions/{anilistId} carries the set, read in the same
// statement as the integer it summarises.
func TestPG_GetSubscription_CarriesTheWatchedSet(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	// Before any mark: an empty array, not null.
	req := newReq(t, http.MethodGet, "/api/subscriptions/1", "", "1", ctx)
	rec := httptest.NewRecorder()
	h.GetSubscriptionByAnilistID(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"watchedEpisodes":[]`)

	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "2").Code)
	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "6").Code)

	req2 := newReq(t, http.MethodGet, "/api/subscriptions/1", "", "1", ctx)
	rec2 := httptest.NewRecorder()
	h.GetSubscriptionByAnilistID(rec2, req2)
	require.Equal(t, http.StatusOK, rec2.Code, "body=%s", rec2.Body.String())

	var got dbgen.GetSubscriptionRow
	decodeData(t, rec2.Body.Bytes(), &got)
	assert.Equal(t, []int32{2, 6}, got.WatchedEpisodes, "ascending, and a set rather than a prefix")
	assert.Equal(t, int32(6), got.CurrentEpisode, "the integer beside the set is MAX of it")
}

// The list endpoint deliberately does NOT gain the array — the card it
// feeds renders the derived integer and nothing else.
func TestPG_ListSubscriptions_DoesNotCarryTheWatchedSet(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")
	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "4").Code)

	req := newReq(t, http.MethodGet, "/api/subscriptions", "", "", ctx)
	rec := httptest.NewRecorder()
	h.ListSubscriptions(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	assert.NotContains(t, rec.Body.String(), "watchedEpisodes",
		"an array per row is bandwidth the card does not read")
	assert.Contains(t, rec.Body.String(), `"currentEpisode":4`,
		"the derived integer still reaches the card")
}

// -----------------------------------------------------------------------------
// the automated progress path also writes the set (migration 0024)
//
// PATCH marks exactly the episode it records — never 1..N, which is the
// inference this whole feature exists to delete.
// -----------------------------------------------------------------------------

// The regression this closes, stated as the scenario that produces it.
//
// Without the watch row, a reader who watched twelve episodes in the player
// would open the detail page to an EMPTY grid, and their first click on
// episode 1 would recompute current_episode from {1} — silently destroying
// twelve episodes of correctly recorded progress.  Progress loss on a click
// is far worse than the over-eager checkmark this feature removes, which is
// why the automated path had to write the set before this could ship.
func TestPG_ClickingAnEpisodeAfterAutomatedSync_DoesNotLoseProgress(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	// The player finishes episode 12.
	require.Equal(t, http.StatusOK,
		patchSubscription(t, h, user, 1, `{"currentEpisode":12,"monotonic":true}`).Code)
	require.Equal(t, []int32{12}, readWatchedSet(t, pool, user, 1),
		"the sync marks the episode it observed, and only that one")

	// The user now clicks episode 1 in the grid.
	rec := markEpisode(t, h, ctx, "1", "1")
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	got := decodeEpisodeWatch(t, rec)
	assert.Equal(t, []int32{1, 12}, got.WatchedEpisodes)
	assert.Equal(t, int32(12), got.CurrentEpisode,
		"clicking episode 1 must not claw progress back from 12")

	stored, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(12), stored)
}

// The coordinator's worked example, verbatim: player finishes 12, user
// clicks 1, 2 and 3, set is {1,2,3,12} and current_episode is still 12.
func TestPG_AutomatedSyncThenManualClicks_ProduceTheUnionOfBoth(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	require.Equal(t, http.StatusOK,
		patchSubscription(t, h, user, 1, `{"currentEpisode":12,"monotonic":true}`).Code)
	for _, ep := range []string{"1", "2", "3"} {
		require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", ep).Code)
	}

	assert.Equal(t, []int32{1, 2, 3, 12}, readWatchedSet(t, pool, user, 1),
		"a set, not a range — 4 through 11 were never watched and are not claimed")
	stored, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(12), stored)
}

// The two monotonic arms, side by side, because the difference between them
// is the entire subtlety of this change.
func TestPG_MonotonicStaleReplay_HoldsProgressButStillRecordsTheEpisode(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	require.Equal(t, http.StatusOK,
		patchSubscription(t, h, user, 1, `{"currentEpisode":12,"monotonic":true}`).Code)

	// A stale tab replaying an old, LOWER high-water mark.
	require.Equal(t, http.StatusOK,
		patchSubscription(t, h, user, 1, `{"currentEpisode":3,"monotonic":true}`).Code)

	stored, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(12), stored,
		"GREATEST still refuses to move current_episode backwards")
	assert.Equal(t, []int32{3, 12}, readWatchedSet(t, pool, user, 1),
		"but episode 3 really was watched, so the mark lands; it is below the max, "+
			"so recording it cannot lower anything")
}

// The ± buttons. Non-monotonic, so the requested episode simply becomes the
// position — and is marked.
func TestPG_NonMonotonicProgress_MarksTheRequestedEpisode(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	require.Equal(t, http.StatusOK, patchSubscription(t, h, user, 1, `{"currentEpisode":6}`).Code)

	stored, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(6), stored)
	assert.Equal(t, []int32{6}, readWatchedSet(t, pool, user, 1),
		"one press asserts one episode, not six")
}

// Under monotonic, current_episode and MAX(set) both become
// MAX(previous, requested) — so if they agreed before a push they agree
// after it, at every step.  This is the property that stops the automated
// path from ever drifting away from the set again.
func TestPG_MonotonicProgress_KeepsTheDerivedValueAgreeingWithTheSet(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")

	for _, episode := range []int32{1, 2, 5, 3, 5, 9, 4} {
		body := fmt.Sprintf(`{"currentEpisode":%d,"monotonic":true}`, episode)
		require.Equal(t, http.StatusOK, patchSubscription(t, h, user, 1, body).Code,
			"push %d", episode)

		stored, _ := readProgress(t, pool, user, 1)
		set := readWatchedSet(t, pool, user, 1)
		require.NotEmpty(t, set)
		assert.Equal(t, set[len(set)-1], stored,
			"after pushing %d: current_episode must equal MAX(set)", episode)
	}

	assert.Equal(t, []int32{1, 2, 3, 4, 5, 9}, readWatchedSet(t, pool, user, 1),
		"every distinct episode pushed is recorded exactly once")
}

// A push that repeats an episode already in the set is a true no-op, and a
// push that repairs a missing row must not reorder the user's list: repairing
// history is not the same event as watching something.
func TestPG_MonotonicProgress_RepairsAMissingMarkWithoutReorderingTheList(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	// Progress with no marks behind it.  Constructed by hand because the
	// system can no longer produce it — which is the point: this pins the
	// self-heal for a row that somehow drifted anyway.
	seedWatchedSubscription(t, pool, user, 1, "watching", 7)
	_, err := pool.Exec(context.Background(),
		`DELETE FROM episode_watches WHERE user_id = $1 AND anilist_id = 1`, user)
	require.NoError(t, err)
	require.Empty(t, readWatchedSet(t, pool, user, 1))

	before := readUpdatedAt(t, pool, user, 1)
	require.Equal(t, http.StatusOK,
		patchSubscription(t, h, user, 1, `{"currentEpisode":7,"monotonic":true}`).Code)

	assert.Equal(t, []int32{7}, readWatchedSet(t, pool, user, 1), "the missing mark is repaired")
	assert.True(t, before.Equal(readUpdatedAt(t, pool, user, 1)),
		"a repair must not jump an untouched show to the front of continue-watching")
}

// Three PATCH shapes that record no episode — and therefore, since
// current_episode is derived, move nothing.
func TestPG_Progress_RecordsNothingAndSoMovesNothing(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"status only", `{"status":"completed"}`},
		{"score only", `{"score":8}`},
		// Zero is not an episode, so it inserts nothing — which means it no
		// longer resets progress either.  A true reset is unmarking.
		{"currentEpisode zero", `{"currentEpisode":0}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, pool := pgHandlers(t)
			defer pool.Close()

			user := seedUser(t, pool, "alice", "alice@example.com")
			seedAnime(t, pool, 1, "A", "甲")
			// Seeded WITH progress, so "nothing moved" is a real assertion
			// rather than a comparison of two zeroes.
			seedWatchedSubscription(t, pool, user, 1, "watching", 4)

			require.Equal(t, http.StatusOK, patchSubscription(t, h, user, 1, tc.body).Code)

			assert.Equal(t, []int32{1, 2, 3, 4}, readWatchedSet(t, pool, user, 1),
				"%s has no episode to record", tc.name)
			stored, _ := readProgress(t, pool, user, 1)
			assert.Equal(t, int32(4), stored,
				"%s must leave the derived value where the set puts it", tc.name)
		})
	}
}

// An episode outside the recordable range must not turn an otherwise valid
// PATCH into a constraint violation the caller sees as a 500.  Because
// current_episode is derived, an unrecordable episode also moves nothing —
// the row simply does not change, rather than storing a number the set
// cannot back up.  Unreachable from any real client (the bound sits above
// every catalogued run length), but a 500 here would be a denial of service
// on one hand-crafted request.
func TestPG_Progress_AboveRecordableRange_RecordsAndMovesNothing(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲") // episodes IS NULL, so the PATCH has no upper bound
	seedWatchedSubscription(t, pool, user, 1, "watching", 4)

	body := fmt.Sprintf(`{"currentEpisode":%d}`, maxEpisodeNumber+1)
	rec := patchSubscription(t, h, user, 1, body)
	require.Equal(t, http.StatusOK, rec.Code,
		"the CHECK must not surface as a 500; body=%s", rec.Body.String())

	assert.Equal(t, []int32{1, 2, 3, 4}, readWatchedSet(t, pool, user, 1),
		"nothing outside the range is recorded")
	stored, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(4), stored,
		"and because the value is derived, nothing outside the range moves it either")
}

// -----------------------------------------------------------------------------
// the bulk write's behaviour — real SQL, because the union IS the statement
// -----------------------------------------------------------------------------

// The gap this endpoint exists to close, end to end at the SQL layer: the
// library knows five episodes, the server knows one, and after one request
// the server knows all five.  Before this route, the reconciler could only
// push the MAXIMUM, so everything below it stayed unmarked and the same
// reader saw "5/14" in one place and "1/14" in another.
func TestPG_MarkEpisodes_MarksEveryEpisodeInTheSet(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	// The server holding only the high-water mark: exactly what a PATCH
	// from the old reconciler left behind.
	require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "9").Code)
	require.Equal(t, []int32{9}, readWatchedSet(t, pool, user, 1))

	rec := markEpisodes(t, h, ctx, "1", episodeListBody(3, 5, 7, 8, 9))
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	assert.Equal(t, []int32{3, 5, 7, 8, 9}, readWatchedSet(t, pool, user, 1))
	stored, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(9), stored, "the maximum did not move, and did not have to")
	assert.Equal(t, episodeWatchResp{
		AnilistID:       1,
		WatchedEpisodes: []int32{3, 5, 7, 8, 9},
		CurrentEpisode:  9,
	}, decodeEpisodeWatch(t, rec), "the response is the post-write set, not an echo of the request")
}

// UNION, NEVER REPLACE.  Another device's marks are not this caller's to
// delete, and a replace would delete them with no record that it had.
func TestPG_MarkEpisodes_UnionsWithMarksItNeverHeardOf(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	// Marks from somewhere else — a second device, or the website's grid.
	for _, ep := range []string{"1", "2", "12"} {
		require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", ep).Code)
	}

	// A push that knows nothing about 1, 2 or 12.
	rec := markEpisodes(t, h, ctx, "1", episodeListBody(3, 5))
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())

	assert.Equal(t, []int32{1, 2, 3, 5, 12}, readWatchedSet(t, pool, user, 1),
		"the foreign marks must survive; a replace would have left {3,5}")
	stored, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(12), stored,
		"and the derived value must still describe the whole set, not the pushed part of it")
}

// No subscription, no marks — the database rule and the handler rule
// agreeing.  Nothing is written and nothing is invented.
func TestPG_MarkEpisodes_NoSubscription_404_WritesNothing(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲") // cached, but never subscribed to
	ctx := withUserClaims(t, context.Background(), user, "alice")

	assertError(t, markEpisodes(t, h, ctx, "1", episodeListBody(3, 5)),
		http.StatusNotFound, "NOT_FOUND", "Subscription not found")

	var rows int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM episode_watches WHERE user_id = $1`, user).Scan(&rows))
	assert.Zero(t, rows, "a 404 must leave the table untouched")
}

// A push naming somebody else's subscription writes nothing, because the
// statement reads its keys from a row proven to belong to the caller.
func TestPG_MarkEpisodes_CannotWriteAnotherUsersSubscription(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, bob, 1, "watching")

	// Alice is signed in and has no subscription to anime 1; Bob does.
	aliceCtx := withUserClaims(t, context.Background(), alice, "alice")
	assertError(t, markEpisodes(t, h, aliceCtx, "1", episodeListBody(3, 5)),
		http.StatusNotFound, "NOT_FOUND", "Subscription not found")

	assert.Empty(t, readWatchedSet(t, pool, bob, 1), "Bob's set must be untouched")
	stored, _ := readProgress(t, pool, bob, 1)
	assert.Zero(t, stored)
}

// Idempotent, and idempotent in the strong sense: a replayed push does not
// claim a viewing that did not happen (last_watched_at) and does not
// reorder the home page's continue-watching row (updated_at).
func TestPG_MarkEpisodes_ReplayChangesNothing(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	require.Equal(t, http.StatusOK, markEpisodes(t, h, ctx, "1", episodeListBody(3, 5, 9)).Code)
	before := readUpdatedAt(t, pool, user, 1)
	_, watchedBefore := readProgress(t, pool, user, 1)

	require.Equal(t, http.StatusOK, markEpisodes(t, h, ctx, "1", episodeListBody(3, 5, 9)).Code)

	assert.Equal(t, []int32{3, 5, 9}, readWatchedSet(t, pool, user, 1))
	assert.Equal(t, before, readUpdatedAt(t, pool, user, 1),
		"a replay must not jump an untouched show to the front of the list")
	_, watchedAfter := readProgress(t, pool, user, 1)
	assert.Equal(t, watchedBefore, watchedAfter,
		"and must not claim an episode was watched again")
}

// The feed.  A bulk push is not a checkbox — it is the same "the reader got
// further" event PATCH has always written — so it writes ONE event when
// current_episode advances and none when it does not.  Without this, moving
// the reconciler off PATCH would empty the activity feed with no error.
func TestPG_MarkEpisodes_WritesOneWatchEventPerAdvance(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	require.Equal(t, http.StatusOK, markEpisodes(t, h, ctx, "1", episodeListBody(3, 5, 9)).Code)
	assert.Equal(t, 1, countWatchEvents(t, pool, user),
		"five episodes in one push is one event, not five")

	require.Equal(t, http.StatusOK, markEpisodes(t, h, ctx, "1", episodeListBody(3, 5, 9)).Code)
	assert.Equal(t, 1, countWatchEvents(t, pool, user), "a replay is not an event")

	// Filling a gap BELOW the maximum repairs history; it does not advance
	// progress, so it is not feed-worthy either.
	require.Equal(t, http.StatusOK, markEpisodes(t, h, ctx, "1", episodeListBody(1, 2)).Code)
	assert.Equal(t, []int32{1, 2, 3, 5, 9}, readWatchedSet(t, pool, user, 1))
	assert.Equal(t, 1, countWatchEvents(t, pool, user),
		"repairing history is not the same event as watching something")

	require.Equal(t, http.StatusOK, markEpisodes(t, h, ctx, "1", episodeListBody(10)).Code)
	assert.Equal(t, 2, countWatchEvents(t, pool, user), "an advance is")
}

// -----------------------------------------------------------------------------
// THE contract, in one test
// -----------------------------------------------------------------------------

// current_episode == COALESCE(MAX(episode), 0) over episode_watches, after
// every write the API can perform.
//
// This is deliberately one sequential walk rather than the property
// scattered across a dozen cases: the invariant is now the entire contract
// of this surface, and a single test that carries state from one write to
// the next is what catches a path that only breaks it in combination.  Once
// it holds everywhere, the monotonic guarantee is a consequence of it —
// nothing was removed, so nothing can go backwards — rather than a separate
// rule that a caller could forget to ask for.
func TestPG_DerivedProgressInvariant_HoldsAfterEveryWritePath(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	patch := func(body string) func() int {
		return func() int { return patchSubscription(t, h, user, 1, body).Code }
	}
	mark := func(ep string) func() int {
		return func() int { return markEpisode(t, h, ctx, "1", ep).Code }
	}
	unmark := func(ep string) func() int {
		return func() int { return unmarkEpisode(t, h, ctx, "1", ep).Code }
	}
	markMany := func(eps ...int32) func() int {
		return func() int { return markEpisodes(t, h, ctx, "1", episodeListBody(eps...)).Code }
	}

	steps := []struct {
		name    string
		write   func() int
		wantSet []int32
		want    int32
	}{
		{"monotonic push to 12", patch(`{"currentEpisode":12,"monotonic":true}`),
			[]int32{12}, 12},
		{"stale replay at 3", patch(`{"currentEpisode":3,"monotonic":true}`),
			[]int32{3, 12}, 12},
		{"non-monotonic PATCH at a LOWER number", patch(`{"currentEpisode":5}`),
			[]int32{3, 5, 12}, 12},
		{"mark episode 1", mark("1"),
			[]int32{1, 3, 5, 12}, 12},
		{"mark episode 1 again", mark("1"),
			[]int32{1, 3, 5, 12}, 12},
		// The bulk write, threaded through the same walk rather than tested
		// beside it: it has to hold the invariant in COMBINATION with the
		// other paths, not only from a clean row.
		{"bulk push filling gaps below the maximum", markMany(2, 4, 6),
			[]int32{1, 2, 3, 4, 5, 6, 12}, 12},
		{"bulk push that is entirely a replay", markMany(2, 4, 6),
			[]int32{1, 2, 3, 4, 5, 6, 12}, 12},
		{"bulk push straddling the maximum", markMany(11, 13),
			[]int32{1, 2, 3, 4, 5, 6, 11, 12, 13}, 13},
		{"unmark 13 — the maximum a bulk push set falls again", unmark("13"),
			[]int32{1, 2, 3, 4, 5, 6, 11, 12}, 12},
		{"bulk push of duplicates only", markMany(4, 4, 4),
			[]int32{1, 2, 3, 4, 5, 6, 11, 12}, 12},
		{"unmark 3 — not the maximum", unmark("3"),
			[]int32{1, 2, 4, 5, 6, 11, 12}, 12},
		{"unmark 12 — the maximum falls", unmark("12"),
			[]int32{1, 2, 4, 5, 6, 11}, 11},
		{"unmark 9 — never marked", unmark("9"),
			[]int32{1, 2, 4, 5, 6, 11}, 11},
		{"status-only PATCH", patch(`{"status":"completed"}`),
			[]int32{1, 2, 4, 5, 6, 11}, 11},
		{"currentEpisode 0 is not a reset", patch(`{"currentEpisode":0}`),
			[]int32{1, 2, 4, 5, 6, 11}, 11},
		{"unmark down to one mark", unmark("11"),
			[]int32{1, 2, 4, 5, 6}, 6},
		{"unmark the rest", func() int {
			for _, ep := range []string{"1", "2", "4", "5", "6"} {
				if code := unmarkEpisode(t, h, ctx, "1", ep).Code; code != http.StatusOK {
					return code
				}
			}
			return http.StatusOK
		}, []int32{}, 0},
		{"bulk push after emptying", markMany(2, 7),
			[]int32{2, 7}, 7},
		{"monotonic push after a bulk push", patch(`{"currentEpisode":3,"monotonic":true}`),
			[]int32{2, 3, 7}, 7},
	}

	for i, s := range steps {
		require.Equal(t, http.StatusOK, s.write(), "step %d (%s) must succeed", i, s.name)

		set := readWatchedSet(t, pool, user, 1)
		stored, _ := readProgress(t, pool, user, 1)

		assert.Equal(t, s.wantSet, set, "step %d (%s): stored set", i, s.name)
		assert.Equal(t, s.want, stored, "step %d (%s): derived value", i, s.name)

		// The invariant itself, restated from the data rather than from the
		// expectation above — so a step whose wantSet and want are BOTH
		// wrong in the same direction still fails here.
		var derived int32
		require.NoError(t, pool.QueryRow(context.Background(),
			`SELECT COALESCE(MAX(episode), 0) FROM episode_watches
			 WHERE user_id = $1 AND anilist_id = $2`, user, int32(1)).Scan(&derived))
		assert.Equal(t, derived, stored,
			"step %d (%s): current_episode must equal COALESCE(MAX(episode), 0)", i, s.name)
	}
}

// -----------------------------------------------------------------------------
// the backfill — executed from the shipped migration file, not from a copy
// of it pasted into the test
// -----------------------------------------------------------------------------

// migrationSQL reads one migration file so the test exercises the exact
// text that will run against production.
func migrationSQL(t *testing.T, name string) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	require.True(t, ok, "runtime.Caller")
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations", name)
	b, err := os.ReadFile(path)
	require.NoError(t, err, "read %s", name)
	return string(b)
}

// A subscription sitting at episode N yields exactly rows 1..N.
//
// The testcontainer already ran 0024 at startup, against an empty
// database, so there was nothing to promote then.  Re-running the file
// here after seeding is what puts the backfill in front of real rows —
// and it doubles as proof that the migration is idempotent, since CREATE
// TABLE IF NOT EXISTS and ON CONFLICT DO NOTHING are the only reason a
// second run can succeed at all.
func TestPG_Backfill_PromotesInferredProgressToRows(t *testing.T) {
	_, pool := pgHandlers(t)
	defer pool.Close()

	alice := seedUser(t, pool, "alice", "alice@example.com")
	bob := seedUser(t, pool, "bob", "bob@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedAnime(t, pool, 2, "B", "乙")

	seedSubscription(t, pool, alice, 1, "watching")
	setCurrentEpisode(t, pool, alice, 1, 4)

	// Progress zero: nothing was ever claimed, so nothing may be asserted.
	seedSubscription(t, pool, alice, 2, "plan_to_watch")

	// A second user, to prove the promotion is per (user, anime).
	seedSubscription(t, pool, bob, 1, "watching")
	setCurrentEpisode(t, pool, bob, 1, 2)

	_, err := pool.Exec(context.Background(), migrationSQL(t, "0024_episode_watches.up.sql"))
	require.NoError(t, err, "re-running the up migration must be safe")

	assert.Equal(t, []int32{1, 2, 3, 4}, readWatchedSet(t, pool, alice, 1),
		"episode 4 means episodes 1-4, which is exactly what the UI has been drawing")
	assert.Empty(t, readWatchedSet(t, pool, alice, 2),
		"current_episode 0 claimed nothing, so it promotes nothing")
	assert.Equal(t, []int32{1, 2}, readWatchedSet(t, pool, bob, 1))

	// Idempotent: a second run converges instead of erroring or doubling.
	_, err = pool.Exec(context.Background(), migrationSQL(t, "0024_episode_watches.up.sql"))
	require.NoError(t, err, "the migration must be re-runnable")
	assert.Equal(t, []int32{1, 2, 3, 4}, readWatchedSet(t, pool, alice, 1))
}

// current_episode has no upper-bound constraint of its own, so the
// backfill has to clamp before generate_series turns a wild value into a
// row count.  Without LEAST(), this row alone aborts the migration.
func TestPG_Backfill_ClampsProgressAboveTheCheckBound(t *testing.T) {
	_, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	setCurrentEpisode(t, pool, user, 1, 9001)

	_, err := pool.Exec(context.Background(), migrationSQL(t, "0024_episode_watches.up.sql"))
	require.NoError(t, err, "a wild current_episode must not abort the migration")

	var count, maxEpisode int32
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT COUNT(*), COALESCE(MAX(episode), 0) FROM episode_watches
		 WHERE user_id = $1 AND anilist_id = $2`, user, int32(1),
	).Scan(&count, &maxEpisode))

	assert.Equal(t, int32(maxEpisodeNumber), count, "clamped to the CHECK bound, not the column value")
	assert.Equal(t, int32(maxEpisodeNumber), maxEpisode)
}

// pgCheckViolation is the Postgres SQLSTATE for a CHECK failure.  The
// constraint tests assert on the code rather than on "an error happened",
// because episode_watches now carries three foreign keys as well and
// `assert.Error` alone would pass for the wrong reason.
const pgCheckViolation = "23514"

// sqlState returns the SQLSTATE of a pg error, or "" for anything else.
func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// The CHECK is the backstop for every writer that is not the handler.
func TestPG_EpisodeWatches_CheckConstraintRejectsOutOfRange(t *testing.T) {
	_, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	// The composite FK needs a subscription, so this test can only reach the
	// CHECK once one exists — which is itself worth pinning.
	seedSubscription(t, pool, user, 1, "watching")

	for _, episode := range []int32{0, -1, maxEpisodeNumber + 1} {
		_, err := pool.Exec(context.Background(),
			`INSERT INTO episode_watches (user_id, anilist_id, episode) VALUES ($1, 1, $2)`,
			user, episode)
		require.Error(t, err, "episode %d must be refused", episode)
		assert.Equal(t, pgCheckViolation, sqlState(err),
			"episode %d must be refused by the CHECK, not by something else", episode)
	}
}

// -----------------------------------------------------------------------------
// cascades — the marks belong to the subscription, and nothing may outlive it
// -----------------------------------------------------------------------------

// A watch row cannot exist without a subscription.  The handler answers 404
// before it gets here, but the rule is in the schema so a writer that
// skipped the handler cannot create an orphan either.
func TestPG_EpisodeWatches_CannotBeOrphaned(t *testing.T) {
	_, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲") // user + title exist; subscription does not

	_, err := pool.Exec(context.Background(),
		`INSERT INTO episode_watches (user_id, anilist_id, episode) VALUES ($1, 1, 3)`, user)
	require.Error(t, err)
	assert.Equal(t, pgForeignKeyViolation, sqlState(err),
		"a mark with no subscription must be refused by the composite FK")
}

func TestPG_EpisodeWatches_CascadeFromEveryParent(t *testing.T) {
	countWatches := func(pool *pgxpool.Pool) int {
		var n int
		require.NoError(t, pool.QueryRow(context.Background(),
			`SELECT count(*) FROM episode_watches`).Scan(&n))
		return n
	}

	// Each case seeds the same shape, then deletes one parent and requires
	// the marks to be gone.  Three parents, three routes to the same rule:
	// deleting the subscription cascades directly; deleting the user or the
	// title cascades to subscriptions first (both of ITS FKs are ON DELETE
	// CASCADE) and from there to here.
	cases := []struct {
		name   string
		delete func(t *testing.T, pool *pgxpool.Pool, user uuid.UUID)
	}{
		{"subscription", func(t *testing.T, pool *pgxpool.Pool, user uuid.UUID) {
			_, err := pool.Exec(context.Background(),
				`DELETE FROM subscriptions WHERE user_id = $1 AND anilist_id = 1`, user)
			require.NoError(t, err)
		}},
		{"user", func(t *testing.T, pool *pgxpool.Pool, user uuid.UUID) {
			_, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, user)
			require.NoError(t, err)
		}},
		{"anime_cache", func(t *testing.T, pool *pgxpool.Pool, _ uuid.UUID) {
			_, err := pool.Exec(context.Background(),
				`DELETE FROM anime_cache WHERE anilist_id = 1`)
			require.NoError(t, err)
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, pool := pgHandlers(t)
			defer pool.Close()

			user := seedUser(t, pool, "alice", "alice@example.com")
			seedAnime(t, pool, 1, "A", "甲")
			seedSubscription(t, pool, user, 1, "watching")
			ctx := withUserClaims(t, context.Background(), user, "alice")
			require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", "3").Code)
			require.Equal(t, 1, countWatches(pool))

			tc.delete(t, pool, user)
			assert.Zero(t, countWatches(pool), "deleting the %s must take the marks with it", tc.name)
		})
	}
}

// The bug the composite FK exists to prevent, end to end through the
// handlers: unsubscribing throws the marks away, so resubscribing starts
// from an empty set rather than resurrecting a history the user discarded.
func TestPG_Unsubscribe_DoesNotResurrectMarksOnResubscribe(t *testing.T) {
	h, pool := pgHandlers(t)
	defer pool.Close()

	user := seedUser(t, pool, "alice", "alice@example.com")
	seedAnime(t, pool, 1, "A", "甲")
	seedSubscription(t, pool, user, 1, "watching")
	ctx := withUserClaims(t, context.Background(), user, "alice")

	for _, ep := range []string{"1", "2", "3"} {
		require.Equal(t, http.StatusOK, markEpisode(t, h, ctx, "1", ep).Code)
	}
	require.Equal(t, []int32{1, 2, 3}, readWatchedSet(t, pool, user, 1))

	del := httptest.NewRecorder()
	h.DeleteSubscription(del, newReq(t, http.MethodDelete, "/api/subscriptions/1", "", "1", ctx))
	require.Equal(t, http.StatusOK, del.Code, "body=%s", del.Body.String())
	assert.Empty(t, readWatchedSet(t, pool, user, 1), "unsubscribing discards the marks")

	create := httptest.NewRecorder()
	h.CreateSubscription(create, newReq(t, http.MethodPost, "/api/subscriptions",
		`{"anilistId":1,"status":"watching"}`, "", ctx))
	require.Equal(t, http.StatusCreated, create.Code, "body=%s", create.Body.String())

	assert.Empty(t, readWatchedSet(t, pool, user, 1),
		"resubscribing must not resurrect the old set")
	ep, _ := readProgress(t, pool, user, 1)
	assert.Equal(t, int32(0), ep, "and current_episode starts from zero, not from a ghost set")
}
