package admin

// enrichment_test.go — table-driven coverage for the seven
// /api/admin/enrichment* handlers.  Uses fake EnrichmentDB / Enqueuer /
// QueueController so tests run without Postgres or river.  The reset
// transaction path is exercised end-to-end against a fake Pool +
// fake txQuerier (the Pool interface is not satisfied by a stub, so the
// reset path is also exercised via a testcontainers Postgres integration
// test in handlers_test.go's existing fixture — here we test the
// non-transaction surfaces).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// ---------- fakes ----------

type fakeEnrichmentDB struct {
	mu sync.Mutex

	updateSelective func(ctx context.Context, titleChinese *string, bgmID *int32, bangumiScore *float64, anilistID int32) (dbgen.UpdateAnimeEnrichmentSelectiveRow, error)
	flag            func(ctx context.Context, anilistID int32, adminFlag *string) (dbgen.FlagAnimeEnrichmentRow, error)
	resetRow        func(ctx context.Context, anilistID int32) (dbgen.GetAnimeCacheRowForResetRow, error)
	listByVersion   func(ctx context.Context, v int32) ([]dbgen.ListAnimeForReEnrichByVersionRow, error)
	listV2WithBgm   func(ctx context.Context) ([]dbgen.ListEnrichedV2WithBgmRow, error)
	listV2NoBgm     func(ctx context.Context) ([]int32, error)
	promoteV3       func(ctx context.Context, ids []int32) error
	listHealCn      func(ctx context.Context) ([]dbgen.ListHealCnCandidatesRow, error)

	// recorded calls
	promoteCalls [][]int32
}

func (f *fakeEnrichmentDB) UpdateAnimeEnrichmentSelective(
	ctx context.Context,
	titleChinese *string,
	bgmID *int32,
	bangumiScore *float64,
	anilistID int32,
) (dbgen.UpdateAnimeEnrichmentSelectiveRow, error) {
	return f.updateSelective(ctx, titleChinese, bgmID, bangumiScore, anilistID)
}

func (f *fakeEnrichmentDB) FlagAnimeEnrichment(ctx context.Context, anilistID int32, adminFlag *string) (dbgen.FlagAnimeEnrichmentRow, error) {
	return f.flag(ctx, anilistID, adminFlag)
}

func (f *fakeEnrichmentDB) GetAnimeCacheRowForReset(ctx context.Context, anilistID int32) (dbgen.GetAnimeCacheRowForResetRow, error) {
	return f.resetRow(ctx, anilistID)
}

func (f *fakeEnrichmentDB) ListAnimeForReEnrichByVersion(ctx context.Context, v int32) ([]dbgen.ListAnimeForReEnrichByVersionRow, error) {
	return f.listByVersion(ctx, v)
}

func (f *fakeEnrichmentDB) ListEnrichedV2WithBgm(ctx context.Context) ([]dbgen.ListEnrichedV2WithBgmRow, error) {
	return f.listV2WithBgm(ctx)
}

func (f *fakeEnrichmentDB) ListEnrichedV2WithoutBgm(ctx context.Context) ([]int32, error) {
	return f.listV2NoBgm(ctx)
}

func (f *fakeEnrichmentDB) PromoteAnimeToV3(ctx context.Context, ids []int32) error {
	f.mu.Lock()
	f.promoteCalls = append(f.promoteCalls, append([]int32(nil), ids...))
	f.mu.Unlock()
	if f.promoteV3 != nil {
		return f.promoteV3(ctx, ids)
	}
	return nil
}

func (f *fakeEnrichmentDB) ListHealCnCandidates(ctx context.Context) ([]dbgen.ListHealCnCandidatesRow, error) {
	return f.listHealCn(ctx)
}

type spyEnqueuer struct {
	mu      sync.Mutex
	v1Calls [][]int32
	v2Calls [][]queue.BangumiV2Args
	v3Calls [][]queue.BangumiV3Args
	wsCalls []queue.WarmSeasonArgs

	v1Err error
	v2Err error
	v3Err error
	wsErr error
}

func (s *spyEnqueuer) EnqueueV1Many(ctx context.Context, ids []int32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.v1Calls = append(s.v1Calls, append([]int32(nil), ids...))
	return s.v1Err
}

func (s *spyEnqueuer) EnqueueV2Many(ctx context.Context, jobs []queue.BangumiV2Args) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.v2Calls = append(s.v2Calls, append([]queue.BangumiV2Args(nil), jobs...))
	return s.v2Err
}

func (s *spyEnqueuer) EnqueueV3Many(ctx context.Context, jobs []queue.BangumiV3Args) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.v3Calls = append(s.v3Calls, append([]queue.BangumiV3Args(nil), jobs...))
	return s.v3Err
}

func (s *spyEnqueuer) EnqueueWarmSeasonNow(ctx context.Context, args queue.WarmSeasonArgs) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wsCalls = append(s.wsCalls, args)
	return s.wsErr
}

type fakeQueueController struct {
	mu sync.Mutex

	paused  bool
	pauseErr error
	resumeErr error
	getErr error
}

func (f *fakeQueueController) QueuePause(ctx context.Context, name string, opts *river.QueuePauseOpts) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pauseErr != nil {
		return f.pauseErr
	}
	f.paused = true
	return nil
}

func (f *fakeQueueController) QueueResume(ctx context.Context, name string, opts *river.QueuePauseOpts) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.resumeErr != nil {
		return f.resumeErr
	}
	f.paused = false
	return nil
}

func (f *fakeQueueController) QueueGet(ctx context.Context, name string) (*rivertype.Queue, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return nil, f.getErr
	}
	q := &rivertype.Queue{Name: name}
	if f.paused {
		// rivertype.Queue.PausedAt is *time.Time; using a sentinel.
		// We don't read the timestamp value — only nil/non-nil.
		t := pausedSentinel
		q.PausedAt = &t
	}
	return q, nil
}

var pausedSentinel = mustParseTime("2024-01-01T00:00:00Z")

func mustParseTime(s string) (t time.Time) {
	tt, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return tt
}

// ---------- handler-level tests ----------

func newEnrichmentHandlersWithFakes(db EnrichmentDB, enq queue.Enqueuer, qc queue.QueueController) *EnrichmentHandlers {
	return &EnrichmentHandlers{
		Pool:         nil, // unused unless reset path
		DB:           db,
		NewTxQuerier: defaultNewTxQuerier,
		Enq:          enq,
		QueueCtrl:    qc,
	}
}

func newReqWithChiParam(method, target string, paramKey, paramVal string, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(paramKey, paramVal)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// --- UpdateEnrichment ---

func TestUpdateEnrichment_InvalidAnilistID(t *testing.T) {
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, nil)
	req := newReqWithChiParam(http.MethodPatch, "/api/admin/enrichment/abc", "anilistId", "abc", `{"titleChinese":"x"}`)
	rec := httptest.NewRecorder()
	h.UpdateEnrichment(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), msgInvalidAnilistID) {
		t.Fatalf("body=%q, want 中文 message %q", rec.Body.String(), msgInvalidAnilistID)
	}
}

func TestUpdateEnrichment_EmptyBody(t *testing.T) {
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, nil)
	req := newReqWithChiParam(http.MethodPatch, "/api/admin/enrichment/123", "anilistId", "123", `{}`)
	rec := httptest.NewRecorder()
	h.UpdateEnrichment(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), msgNoFieldsToUpdate) {
		t.Fatalf("body=%q, want %q", rec.Body.String(), msgNoFieldsToUpdate)
	}
}

func TestUpdateEnrichment_NotFound(t *testing.T) {
	db := &fakeEnrichmentDB{
		updateSelective: func(_ context.Context, _ *string, _ *int32, _ *float64, _ int32) (dbgen.UpdateAnimeEnrichmentSelectiveRow, error) {
			return dbgen.UpdateAnimeEnrichmentSelectiveRow{}, pgx.ErrNoRows
		},
	}
	h := newEnrichmentHandlersWithFakes(db, &spyEnqueuer{}, nil)
	req := newReqWithChiParam(http.MethodPatch, "/api/admin/enrichment/123", "anilistId", "123", `{"titleChinese":"x"}`)
	rec := httptest.NewRecorder()
	h.UpdateEnrichment(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), msgAnimeNotFound) {
		t.Fatalf("body=%q, want %q", rec.Body.String(), msgAnimeNotFound)
	}
}

func TestUpdateEnrichment_Happy(t *testing.T) {
	cn := "我的英雄"
	romaji := "Boku no Hero"
	flag := "manually-corrected"
	bgm := int32(123)
	score := 8.5
	db := &fakeEnrichmentDB{
		updateSelective: func(_ context.Context, titleChinese *string, bgmID *int32, _ *float64, _ int32) (dbgen.UpdateAnimeEnrichmentSelectiveRow, error) {
			if titleChinese == nil || *titleChinese != cn {
				t.Errorf("titleChinese: got %v, want %q", titleChinese, cn)
			}
			if bgmID == nil || *bgmID != bgm {
				t.Errorf("bgmID: got %v, want %d", bgmID, bgm)
			}
			return dbgen.UpdateAnimeEnrichmentSelectiveRow{
				AnilistID:    321,
				TitleRomaji:  &romaji,
				TitleChinese: &cn,
				BgmID:        &bgm,
				BangumiScore: &score,
				AdminFlag:    &flag,
			}, nil
		},
	}
	h := newEnrichmentHandlersWithFakes(db, &spyEnqueuer{}, nil)
	body, _ := json.Marshal(map[string]any{"titleChinese": cn, "bgmId": bgm})
	req := newReqWithChiParam(http.MethodPatch, "/api/admin/enrichment/321", "anilistId", "321", string(body))
	rec := httptest.NewRecorder()
	h.UpdateEnrichment(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	data := got["data"]
	if data["adminFlag"] != flag {
		t.Errorf("adminFlag=%v, want %q", data["adminFlag"], flag)
	}
}

// --- FlagEnrichment ---

func TestFlagEnrichment_InvalidFlagValue(t *testing.T) {
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, nil)
	req := newReqWithChiParam(http.MethodPost, "/api/admin/enrichment/1/flag", "anilistId", "1", `{"flag":"unknown"}`)
	rec := httptest.NewRecorder()
	h.FlagEnrichment(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), msgInvalidFlagValue) {
		t.Fatalf("body=%q, want %q", rec.Body.String(), msgInvalidFlagValue)
	}
}

func TestFlagEnrichment_NullFlag_Clears(t *testing.T) {
	called := false
	db := &fakeEnrichmentDB{
		flag: func(_ context.Context, _ int32, adminFlag *string) (dbgen.FlagAnimeEnrichmentRow, error) {
			called = true
			if adminFlag != nil {
				t.Errorf("expected nil flag, got %v", adminFlag)
			}
			return dbgen.FlagAnimeEnrichmentRow{AnilistID: 99}, nil
		},
	}
	h := newEnrichmentHandlersWithFakes(db, &spyEnqueuer{}, nil)
	req := newReqWithChiParam(http.MethodPost, "/api/admin/enrichment/99/flag", "anilistId", "99", `{"flag":null}`)
	rec := httptest.NewRecorder()
	h.FlagEnrichment(rec, req)

	if !called {
		t.Fatal("FlagAnimeEnrichment not invoked")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", rec.Code)
	}
}

func TestFlagEnrichment_NotFound(t *testing.T) {
	db := &fakeEnrichmentDB{
		flag: func(_ context.Context, _ int32, _ *string) (dbgen.FlagAnimeEnrichmentRow, error) {
			return dbgen.FlagAnimeEnrichmentRow{}, pgx.ErrNoRows
		},
	}
	h := newEnrichmentHandlersWithFakes(db, &spyEnqueuer{}, nil)
	req := newReqWithChiParam(http.MethodPost, "/api/admin/enrichment/1/flag", "anilistId", "1", `{"flag":"needs-review"}`)
	rec := httptest.NewRecorder()
	h.FlagEnrichment(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", rec.Code)
	}
}

// --- ReEnrich ---

func TestReEnrich_InvalidVersion(t *testing.T) {
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, nil)
	for _, v := range []string{"", "3", "abc", "-1"} {
		t.Run("v="+v, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/re-enrich?version="+v, nil)
			rec := httptest.NewRecorder()
			h.ReEnrich(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status=%d, want 400", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), msgInvalidVersion) {
				t.Fatalf("body=%q, want %q", rec.Body.String(), msgInvalidVersion)
			}
		})
	}
}

func TestReEnrich_V0_EnqueuesV1(t *testing.T) {
	db := &fakeEnrichmentDB{
		listByVersion: func(_ context.Context, v int32) ([]dbgen.ListAnimeForReEnrichByVersionRow, error) {
			if v != 0 {
				t.Errorf("version=%d, want 0", v)
			}
			return []dbgen.ListAnimeForReEnrichByVersionRow{
				{AnilistID: 1}, {AnilistID: 2},
			}, nil
		},
	}
	enq := &spyEnqueuer{}
	h := newEnrichmentHandlersWithFakes(db, enq, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/re-enrich?version=0", nil)
	rec := httptest.NewRecorder()
	h.ReEnrich(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if len(enq.v1Calls) != 1 || len(enq.v1Calls[0]) != 2 {
		t.Fatalf("v1Calls=%v, want 1 call with 2 ids", enq.v1Calls)
	}
}

func TestReEnrich_V1_SkipsNoBgm(t *testing.T) {
	bgm := int32(42)
	db := &fakeEnrichmentDB{
		listByVersion: func(_ context.Context, v int32) ([]dbgen.ListAnimeForReEnrichByVersionRow, error) {
			if v != 1 {
				t.Errorf("version=%d, want 1", v)
			}
			return []dbgen.ListAnimeForReEnrichByVersionRow{
				{AnilistID: 1, BgmID: &bgm},
				{AnilistID: 2, BgmID: nil}, // skipped
				{AnilistID: 3, BgmID: &bgm},
			}, nil
		},
	}
	enq := &spyEnqueuer{}
	h := newEnrichmentHandlersWithFakes(db, enq, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/re-enrich?version=1", nil)
	rec := httptest.NewRecorder()
	h.ReEnrich(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if len(enq.v2Calls) != 1 || len(enq.v2Calls[0]) != 2 {
		t.Fatalf("v2Calls=%v, want 1 call with 2 jobs (skip no-bgm)", enq.v2Calls)
	}

	// Response.enqueued = len(rows) per Express semantics (includes skipped).
	var resp struct {
		Data reEnrichResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Data.Enqueued != 3 {
		t.Errorf("enqueued=%d, want 3 (rows considered, incl. skipped)", resp.Data.Enqueued)
	}
}

func TestReEnrich_V2_SplitsByBgm(t *testing.T) {
	bgm := int32(7)
	db := &fakeEnrichmentDB{
		listV2WithBgm: func(_ context.Context) ([]dbgen.ListEnrichedV2WithBgmRow, error) {
			return []dbgen.ListEnrichedV2WithBgmRow{
				{AnilistID: 10, BgmID: &bgm},
			}, nil
		},
		listV2NoBgm: func(_ context.Context) ([]int32, error) {
			return []int32{20, 30}, nil
		},
	}
	enq := &spyEnqueuer{}
	h := newEnrichmentHandlersWithFakes(db, enq, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/re-enrich?version=2", nil)
	rec := httptest.NewRecorder()
	h.ReEnrich(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if len(db.promoteCalls) != 1 || len(db.promoteCalls[0]) != 2 {
		t.Fatalf("promoteCalls=%v, want 1 call with 2 ids", db.promoteCalls)
	}
	if len(enq.v3Calls) != 1 || len(enq.v3Calls[0]) != 1 {
		t.Fatalf("v3Calls=%v, want 1 call with 1 job", enq.v3Calls)
	}

	var resp struct {
		Data reEnrichResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Data.Enqueued != 3 || resp.Data.Version != 2 {
		t.Errorf("data=%+v, want enqueued=3 version=2", resp.Data)
	}
}

// --- HealCn ---

func TestHealCn_Empty(t *testing.T) {
	db := &fakeEnrichmentDB{
		listHealCn: func(_ context.Context) ([]dbgen.ListHealCnCandidatesRow, error) {
			return nil, nil
		},
	}
	enq := &spyEnqueuer{}
	h := newEnrichmentHandlersWithFakes(db, enq, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/heal-cn", nil)
	rec := httptest.NewRecorder()
	h.HealCn(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if len(enq.v3Calls) != 0 {
		t.Errorf("v3Calls=%v, want 0 (empty input)", enq.v3Calls)
	}
}

func TestHealCn_Happy(t *testing.T) {
	bgm := int32(99)
	db := &fakeEnrichmentDB{
		listHealCn: func(_ context.Context) ([]dbgen.ListHealCnCandidatesRow, error) {
			return []dbgen.ListHealCnCandidatesRow{
				{AnilistID: 1, BgmID: &bgm}, {AnilistID: 2, BgmID: &bgm},
			}, nil
		},
	}
	enq := &spyEnqueuer{}
	h := newEnrichmentHandlersWithFakes(db, enq, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/heal-cn", nil)
	rec := httptest.NewRecorder()
	h.HealCn(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if len(enq.v3Calls) != 1 || len(enq.v3Calls[0]) != 2 {
		t.Fatalf("v3Calls=%v, want 1 call with 2 jobs", enq.v3Calls)
	}
}

// --- Pause / Resume ---

func TestPauseHeal_CallsQueueCtrl(t *testing.T) {
	qc := &fakeQueueController{}
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, qc)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/heal-cn/pause", nil)
	rec := httptest.NewRecorder()
	h.PauseHeal(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if !qc.paused {
		t.Error("QueueController not paused")
	}
	if !strings.Contains(rec.Body.String(), `"paused":true`) {
		t.Errorf("body=%q, want paused:true", rec.Body.String())
	}
}

func TestResumeHeal_CallsQueueCtrl(t *testing.T) {
	qc := &fakeQueueController{paused: true}
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, qc)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/heal-cn/resume", nil)
	rec := httptest.NewRecorder()
	h.ResumeHeal(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if qc.paused {
		t.Error("QueueController still paused")
	}
}

func TestPauseHeal_NilCtrl_StillReturns200(t *testing.T) {
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/heal-cn/pause", nil)
	rec := httptest.NewRecorder()
	h.PauseHeal(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", rec.Code)
	}
}

func TestPauseHeal_QueueError(t *testing.T) {
	qc := &fakeQueueController{pauseErr: errors.New("queue down")}
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, qc)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/heal-cn/pause", nil)
	rec := httptest.NewRecorder()
	h.PauseHeal(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500", rec.Code)
	}
}

// --- Reset (non-transaction path: not-found + invalid id) ---

func TestResetEnrichment_InvalidID(t *testing.T) {
	h := newEnrichmentHandlersWithFakes(&fakeEnrichmentDB{}, &spyEnqueuer{}, nil)
	req := newReqWithChiParam(http.MethodPost, "/api/admin/enrichment/abc/reset", "anilistId", "abc", "")
	rec := httptest.NewRecorder()
	h.ResetEnrichment(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d", rec.Code)
	}
}

func TestResetEnrichment_NotFound(t *testing.T) {
	db := &fakeEnrichmentDB{
		resetRow: func(_ context.Context, _ int32) (dbgen.GetAnimeCacheRowForResetRow, error) {
			return dbgen.GetAnimeCacheRowForResetRow{}, pgx.ErrNoRows
		},
	}
	h := newEnrichmentHandlersWithFakes(db, &spyEnqueuer{}, nil)
	req := newReqWithChiParam(http.MethodPost, "/api/admin/enrichment/9999/reset", "anilistId", "9999", "")
	rec := httptest.NewRecorder()
	h.ResetEnrichment(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d", rec.Code)
	}
}

// ---------- parseAnilistID + decodeJSONBody unit ----------

func TestParseAnilistID(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		want int32
	}{
		{"0", false, 0},
		{"-1", false, 0},
		{"abc", false, 0},
		{"", false, 0},
		{"1", true, 1},
		{"2147483647", true, 2147483647},
	}
	for _, c := range cases {
		got, ok := parseAnilistID(c.in)
		if ok != c.ok || got != c.want {
			t.Errorf("parseAnilistID(%q)=(%d,%v), want (%d,%v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestDecodeJSONBody_EmptyBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	var v map[string]any
	if err := decodeJSONBody(req, &v); err != nil {
		t.Errorf("err=%v, want nil for empty body", err)
	}
}

func TestDecodeJSONBody_RejectsUnknownFields(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(`{"unexpected":1}`))
	var v struct {
		Known string `json:"known"`
	}
	if err := decodeJSONBody(req, &v); err == nil {
		t.Error("expected error for unknown field")
	}
}
