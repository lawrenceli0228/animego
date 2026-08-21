package admin

// hant_test.go — the zh-Hant drift monitor, against the real schema.
//
// The counters and the run-state flag are both SQL, so they are exercised
// through the same testcontainer Postgres the rest of this package uses
// rather than through a fake querier.  A fake would prove the handler
// copies six int64s, which is not the part that can be wrong: what can be
// wrong is the predicate behind titleBehind, the whitelist behind
// serpEligible, and the state list behind running — none of which exist
// in Go.
//
// The enqueuer stays a fake: what the button has to get right is
// reporting whether river took the job, not river itself.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// ─── fixtures ────────────────────────────────────────────────────────────────

// fakeHantEnq records presses and answers with whatever the test set.
type fakeHantEnq struct {
	inserted bool
	err      error
	calls    int
}

func (f *fakeHantEnq) EnqueueHantBackfillNow(context.Context) (bool, error) {
	f.calls++
	return f.inserted, f.err
}

// erroringHantQuerier fails whichever of the two reads the test names.
// Only used for the failure paths; the happy paths go through real SQL.
type erroringHantQuerier struct {
	statsErr error
	jobErr   error
}

func (e erroringHantQuerier) GetHantStats(context.Context) (dbgen.GetHantStatsRow, error) {
	return dbgen.GetHantStatsRow{}, e.statsErr
}

func (e erroringHantQuerier) GetHantBackfillJobStatus(context.Context) (dbgen.GetHantBackfillJobStatusRow, error) {
	return dbgen.GetHantBackfillJobStatusRow{}, e.jobErr
}

// makeHantHandlers spins a fresh pool + HantHandlers for one test.
func makeHantHandlers(t *testing.T) (*HantHandlers, *fakeHantEnq, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	enq := &fakeHantEnq{}
	return NewHantHandlers(dbgen.New(pool), enq), enq, pool
}

// hantSeed is one anime_cache row's zh-Hant-relevant columns.
type hantSeed struct {
	AnilistID       int32
	TitleChinese    string
	DescriptionCN   string
	TitleHant       string
	TitleHantSource string
	DescHant        string
	DescHantSource  string
}

func seedHantAnime(t *testing.T, pool *pgxpool.Pool, s hantSeed) {
	t.Helper()
	str := func(v string) *string {
		if v == "" {
			return nil
		}
		return &v
	}
	_, err := pool.Exec(context.Background(), `
		INSERT INTO anime_cache (
			anilist_id, title_chinese, description_cn,
			title_hant, title_hant_source,
			description_hant, description_hant_source, cached_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
		s.AnilistID, str(s.TitleChinese), str(s.DescriptionCN),
		str(s.TitleHant), str(s.TitleHantSource),
		str(s.DescHant), str(s.DescHantSource),
	)
	require.NoError(t, err, "seedHantAnime %d", s.AnilistID)
}

// seedRiverJob inserts one river_job row directly.  River's own client
// cannot produce a `discarded` or a back-dated `completed` on demand, and
// those are exactly the rows the query has to treat correctly.
func seedRiverJob(t *testing.T, pool *pgxpool.Pool, kind, state string, finalizedAt *time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO river_job (state, kind, max_attempts, args, finalized_at)
		VALUES ($1::river_job_state, $2, 1, '{}'::jsonb, $3)`,
		state, kind, finalizedAt,
	)
	require.NoError(t, err, "seedRiverJob %s/%s", kind, state)
}

// getHantStats drives the handler and decodes the envelope.
func getHantStats(t *testing.T, h *HantHandlers) (int, HantStatsResp) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.GetHantStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/hant/stats", nil))
	if rec.Code != http.StatusOK {
		return rec.Code, HantStatsResp{}
	}
	var env struct {
		Data HantStatsResp `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), "body: %s", rec.Body.String())
	return rec.Code, env.Data
}

// ─── counters ────────────────────────────────────────────────────────────────

// The two *Behind counters are the whole reason this endpoint exists, and
// the thing they must not be is "total minus filled".  A row with no
// Chinese title is out of the ladder's reach, not behind it; counting it
// would leave the panel permanently non-zero, which makes it something an
// operator learns to ignore.
func TestGetHantStatsCounters(t *testing.T) {
	h, _, pool := makeHantHandlers(t)

	rows := []hantSeed{
		// Fully converted from a dataset: counts everywhere, behind nowhere.
		{AnilistID: 1, TitleChinese: "星际牛仔", DescriptionCN: "简介一。",
			TitleHant: "星際牛仔", TitleHantSource: "anilist",
			DescHant: "簡介一。", DescHantSource: "opencc"},
		// Machine-converted title: covered, but NOT SERP-eligible.
		{AnilistID: 2, TitleChinese: "鬼灭之刃", TitleHant: "鬼滅之刃", TitleHantSource: "opencc"},
		// The drift this endpoint is for: sources present, Traditional absent.
		{AnilistID: 3, TitleChinese: "咒术回战", DescriptionCN: "简介三。"},
		// Out of reach: nothing to convert from, so behind nothing.
		{AnilistID: 4},
		// Behind on the synopsis only.
		{AnilistID: 5, TitleChinese: "葬送的芙莉莲", DescriptionCN: "简介五。",
			TitleHant: "葬送的芙莉蓮", TitleHantSource: "manual"},
	}
	for _, r := range rows {
		seedHantAnime(t, pool, r)
	}

	code, got := getHantStats(t, h)
	require.Equal(t, http.StatusOK, code)

	assert.Equal(t, int64(5), got.Total)
	assert.Equal(t, int64(3), got.TitleHant, "rows 1, 2 and 5 have a Traditional title")
	assert.Equal(t, int64(1), got.DescHant, "only row 1 has a Traditional synopsis")
	// Row 2's title came from opencc, which migration 0022's generated
	// column excludes; rows 1 (anilist) and 5 (manual) are admitted.
	assert.Equal(t, int64(2), got.SerpEligible,
		"serpEligible must follow title_hant_seo's whitelist, not count every filled title")
	assert.Equal(t, int64(1), got.TitleBehind, "only row 3 has a Chinese title and no Traditional one")
	assert.Equal(t, int64(2), got.DescBehind, "rows 3 and 5 have a Chinese synopsis and no Traditional one")
}

// An empty catalogue must answer zeros rather than fail — a fresh database
// is the state a first deploy is in, and a 500 there reads as a broken
// endpoint.
func TestGetHantStatsOnAnEmptyTable(t *testing.T) {
	h, _, _ := makeHantHandlers(t)

	code, got := getHantStats(t, h)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, HantStatsResp{}, got)
	assert.Nil(t, got.LastRunAt)
	assert.False(t, got.Running)
}

// ─── run state ───────────────────────────────────────────────────────────────

// `running` has to mean "a second press would be folded into this one",
// which is the same set of states HantBackfillArgs deduplicates over.
// Terminal states must NOT count: a discarded sweep is finished, badly,
// and reporting it as running would leave the button greyed out forever.
func TestGetHantStatsRunningFollowsNonTerminalStates(t *testing.T) {
	cases := []struct {
		state string
		want  bool
	}{
		{"available", true},
		{"pending", true},
		{"running", true},
		{"retryable", true},
		{"scheduled", true},
		{"completed", false},
		{"cancelled", false},
		{"discarded", false},
	}

	for _, tc := range cases {
		t.Run(tc.state, func(t *testing.T) {
			h, _, pool := makeHantHandlers(t)
			var finalized *time.Time
			if tc.state == "completed" || tc.state == "cancelled" || tc.state == "discarded" {
				// river_job's CHECK requires finalized_at on terminal rows.
				now := time.Now().UTC()
				finalized = &now
			}
			seedRiverJob(t, pool, "hant_backfill", tc.state, finalized)

			code, got := getHantStats(t, h)
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, tc.want, got.Running)
		})
	}
}

// Another kind's job must not be mistaken for this one.  Both description
// sweeps run far more often than this one, so a query that dropped the
// kind filter would report "running" essentially always.
func TestGetHantStatsIgnoresOtherJobKinds(t *testing.T) {
	h, _, pool := makeHantHandlers(t)
	seedRiverJob(t, pool, "description_backfill", "running", nil)
	seedRiverJob(t, pool, "bangumi_v1", "available", nil)

	code, got := getHantStats(t, h)
	require.Equal(t, http.StatusOK, code)
	assert.False(t, got.Running, "another kind's job is not this sweep")
	assert.Nil(t, got.LastRunAt)
}

// lastRunAt is the last SUCCESS.  A sweep that exhausted its retries also
// carries a finalized_at, and reporting that would tell an operator the
// drift had been cleared when it had not.
func TestGetHantStatsLastRunAtIsTheLatestSuccess(t *testing.T) {
	h, _, pool := makeHantHandlers(t)

	old := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	recent := time.Date(2026, 8, 21, 4, 29, 51, 0, time.UTC)
	later := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)

	seedRiverJob(t, pool, "hant_backfill", "completed", &old)
	seedRiverJob(t, pool, "hant_backfill", "completed", &recent)
	// Finished later, but gave up rather than succeeded.
	seedRiverJob(t, pool, "hant_backfill", "discarded", &later)

	code, got := getHantStats(t, h)
	require.Equal(t, http.StatusOK, code)
	require.NotNil(t, got.LastRunAt)
	assert.True(t, got.LastRunAt.Equal(recent),
		"lastRunAt = %v, want the latest COMPLETED run (%v); a discarded job finished, it did not run", got.LastRunAt, recent)
	assert.Equal(t, time.UTC, got.LastRunAt.Location(),
		"the timestamp is rendered into an admin page; it has to be UTC rather than the container's local zone")
}

// ─── failure paths ───────────────────────────────────────────────────────────

// Neither read is soft-failed.  Unlike the description-coverage block on
// /api/admin/stats — which is one panel among many and may render zeros —
// this endpoint IS the panel: zeros here say "nothing is behind, nothing
// is running", which is precisely the reading that makes an operator do
// nothing.
func TestGetHantStatsFailsLoudly(t *testing.T) {
	boom := errors.New("relation \"anime_cache\" does not exist")

	cases := []struct {
		name string
		q    erroringHantQuerier
	}{
		{"the coverage query failed", erroringHantQuerier{statsErr: boom}},
		{"the job-state query failed", erroringHantQuerier{jobErr: boom}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHantHandlers(tc.q, &fakeHantEnq{})
			rec := httptest.NewRecorder()
			h.GetHantStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/hant/stats", nil))

			assert.Equal(t, http.StatusInternalServerError, rec.Code)
			assert.NotContains(t, rec.Body.String(), "does not exist",
				"the cause belongs in the log, not in the response body")
		})
	}
}

// ─── the button ──────────────────────────────────────────────────────────────

// The response must distinguish "scheduled" from "folded into the one
// already in flight".  Answering `enqueued: true` either way would let an
// operator believe a second pass had been queued, and then read the
// unchanged counters as the sweep having failed.
func TestBackfillHant(t *testing.T) {
	cases := []struct {
		name         string
		enq          *fakeHantEnq
		wantCode     int
		wantEnqueued bool
		wantMsg      string
	}{
		{
			name:         "river took the job",
			enq:          &fakeHantEnq{inserted: true},
			wantCode:     http.StatusOK,
			wantEnqueued: true,
			wantMsg:      hantEnqueuedMsg,
		},
		{
			name:         "a sweep was already queued or running",
			enq:          &fakeHantEnq{inserted: false},
			wantCode:     http.StatusOK,
			wantEnqueued: false,
			wantMsg:      hantAlreadyRunningMsg,
		},
		{
			name:     "the insert failed",
			enq:      &fakeHantEnq{err: errors.New("connection refused")},
			wantCode: http.StatusInternalServerError,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHantHandlers(erroringHantQuerier{}, tc.enq)
			rec := httptest.NewRecorder()
			h.BackfillHant(rec, httptest.NewRequest(http.MethodPost, "/api/admin/hant/backfill", nil))

			require.Equal(t, tc.wantCode, rec.Code, "body: %s", rec.Body.String())
			assert.Equal(t, 1, tc.enq.calls, "the handler must enqueue inline, not in a goroutine it cannot report on")
			if tc.wantCode != http.StatusOK {
				return
			}

			var env struct {
				Data HantBackfillResp `json:"data"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), "body: %s", rec.Body.String())
			assert.Equal(t, tc.wantEnqueued, env.Data.Enqueued)
			assert.Equal(t, tc.wantMsg, env.Data.Message)
		})
	}
}

// ─── wire contract ───────────────────────────────────────────────────────────

// The admin UI is built against these keys in another codebase, so the
// envelope is asserted as bytes rather than through the Go struct.  A
// renamed field, a dropped `data` wrapper, or an omitempty that makes
// lastRunAt vanish on a fresh install would all round-trip perfectly
// through HantStatsResp and break the page.
func TestHantEndpointsWireShape(t *testing.T) {
	h, enq, pool := makeHantHandlers(t)
	seedHantAnime(t, pool, hantSeed{
		AnilistID: 1, TitleChinese: "星际牛仔", DescriptionCN: "简介。",
		TitleHant: "星際牛仔", TitleHantSource: "anilist",
	})

	t.Run("stats", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.GetHantStats(rec, httptest.NewRequest(http.MethodGet, "/api/admin/hant/stats", nil))
		require.Equal(t, http.StatusOK, rec.Code)
		t.Logf("GET /api/admin/hant/stats -> %s", rec.Body.String())

		var env map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
		require.Contains(t, env, "data", "the envelope must be {\"data\": ...}")

		var fields map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(env["data"], &fields))
		for _, key := range []string{
			"total", "titleHant", "descHant", "serpEligible",
			"titleBehind", "descBehind", "lastRunAt", "running",
		} {
			assert.Contains(t, fields, key)
		}
		assert.Len(t, fields, 8, "an extra key is a contract change: %s", env["data"])
		assert.JSONEq(t, "null", string(fields["lastRunAt"]),
			"never-run must serialise as an explicit null, not as a missing key or a zero time")
	})

	t.Run("backfill", func(t *testing.T) {
		enq.inserted = true
		rec := httptest.NewRecorder()
		h.BackfillHant(rec, httptest.NewRequest(http.MethodPost, "/api/admin/hant/backfill", nil))
		require.Equal(t, http.StatusOK, rec.Code)
		t.Logf("POST /api/admin/hant/backfill -> %s", rec.Body.String())

		var env struct {
			Data map[string]json.RawMessage `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
		assert.Contains(t, env.Data, "enqueued")
		assert.Contains(t, env.Data, "message")
		assert.Len(t, env.Data, 2, "an extra key is a contract change: %s", rec.Body.String())
	})
}

// A nil dependency must crash at boot rather than at request time: an
// endpoint wired to a nil enqueuer would answer 200 to every press while
// scheduling nothing, which is indistinguishable from a healthy button.
func TestNewHantHandlersRefusesNilDependencies(t *testing.T) {
	assert.Panics(t, func() { NewHantHandlers(nil, &fakeHantEnq{}) })
	assert.Panics(t, func() { NewHantHandlers(erroringHantQuerier{}, nil) })
}
