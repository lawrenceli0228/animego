package admin

// enrichment_pg_test.go — Reset transaction path against the
// testcontainers Postgres shared by handlers_test.go's TestMain.  Lives
// in a separate file so the fake-only unit tests in enrichment_test.go
// stay fast and DB-free while the transaction-correctness checks here
// hit real SQL.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// newEnrichmentHandlersForPG builds a real-DB-backed EnrichmentHandlers
// pointed at the testcontainers pool.  Enqueuer is a spy so we can
// verify the V1 dispatch fires (without standing up river).
func newEnrichmentHandlersForPG(t *testing.T, pool *pgxpool.Pool) (*EnrichmentHandlers, *spyEnqueuer) {
	t.Helper()
	enq := &spyEnqueuer{}
	h := &EnrichmentHandlers{
		Pool:         pool,
		DB:           dbgen.New(pool),
		NewTxQuerier: defaultNewTxQuerier,
		Enq:          enq,
		QueueCtrl:    nil,
	}
	return h, enq
}

func TestResetEnrichment_HappyPath_PG(t *testing.T) {
	ctx := context.Background()
	_, pool := makeHandlers(t)
	h, enq := newEnrichmentHandlersForPG(t, pool)

	const id = int32(40001)
	bgm := int32(7777)
	flag := "needs-review"
	score := 8.5

	seedAnime(t, pool, animeSeed{
		AnilistID:      id,
		TitleRomaji:    "Test Show",
		TitleNative:    "テストショー",
		TitleChinese:   "测试节目",
		BgmID:          &bgm,
		BangumiVersion: 2,
		BangumiScore:   &score,
		AdminFlag:      &flag,
	})

	// Seed a character + episode title row so we can prove the DELETEs
	// in the reset transaction actually fired.
	if _, err := pool.Exec(ctx, `
		INSERT INTO anime_characters (anime_id, display_order, name_ja)
		VALUES ($1, 1, $2)`, id, "テストキャラ"); err != nil {
		t.Fatalf("seed character: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO anime_episode_titles (anime_id, episode, name)
		VALUES ($1, 1, $2)`, id, "Ep 1 — Pilot"); err != nil {
		t.Fatalf("seed episode title: %v", err)
	}

	// Reset.
	req := newReqWithChiParam(http.MethodPost, "/api/admin/enrichment/"+strconv.Itoa(int(id))+"/reset", "anilistId", strconv.Itoa(int(id)), "")
	rec := httptest.NewRecorder()
	h.ResetEnrichment(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, body=%s", rec.Code, rec.Body.String())
	}

	// Verify enrichment cleared.
	var (
		gotVersion int32
		gotChinese *string
		gotBgmID   *int32
		gotScore   *float64
		gotFlag    *string
	)
	err := pool.QueryRow(ctx, `
		SELECT bangumi_version, title_chinese, bgm_id, bangumi_score, admin_flag
		FROM anime_cache WHERE anilist_id = $1`, id).
		Scan(&gotVersion, &gotChinese, &gotBgmID, &gotScore, &gotFlag)
	if err != nil {
		t.Fatalf("post-reset SELECT: %v", err)
	}
	if gotVersion != 0 {
		t.Errorf("bangumi_version=%d, want 0", gotVersion)
	}
	if gotChinese != nil {
		t.Errorf("title_chinese=%v, want nil", *gotChinese)
	}
	if gotBgmID != nil {
		t.Errorf("bgm_id=%v, want nil", *gotBgmID)
	}
	if gotScore != nil {
		t.Errorf("bangumi_score=%v, want nil", *gotScore)
	}
	if gotFlag != nil {
		t.Errorf("admin_flag=%v, want nil", *gotFlag)
	}

	// Verify child rows deleted.
	var charCount, epCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM anime_characters WHERE anime_id = $1`, id).Scan(&charCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM anime_episode_titles WHERE anime_id = $1`, id).Scan(&epCount); err != nil {
		t.Fatal(err)
	}
	if charCount != 0 || epCount != 0 {
		t.Errorf("post-reset child counts: characters=%d episode_titles=%d, want both 0", charCount, epCount)
	}

	// Verify V1 dispatched.
	if len(enq.v1Calls) != 1 || len(enq.v1Calls[0]) != 1 || enq.v1Calls[0][0] != id {
		t.Errorf("v1Calls=%v, want one call with id %d", enq.v1Calls, id)
	}
}

func TestReEnrich_V2_PromoteAndEnqueue_PG(t *testing.T) {
	ctx := context.Background()
	_, pool := makeHandlers(t)
	h, enq := newEnrichmentHandlersForPG(t, pool)

	bgm := int32(8888)
	seedAnime(t, pool, animeSeed{
		AnilistID:      50001,
		TitleRomaji:    "A",
		BgmID:          &bgm,
		BangumiVersion: 2,
	})
	seedAnime(t, pool, animeSeed{
		AnilistID:      50002,
		TitleRomaji:    "B",
		BgmID:          nil, // will be promoted directly to v3
		BangumiVersion: 2,
	})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/re-enrich?version=2", nil)
	rec := httptest.NewRecorder()
	h.ReEnrich(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, body=%s", rec.Code, rec.Body.String())
	}

	// Verify the no-bgm row got promoted to v3.
	var v int32
	if err := pool.QueryRow(ctx, `SELECT bangumi_version FROM anime_cache WHERE anilist_id = 50002`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != 3 {
		t.Errorf("anilist_id=50002 bangumi_version=%d, want 3", v)
	}

	// Verify the with-bgm row got a V3 enqueue.
	if len(enq.v3Calls) != 1 || len(enq.v3Calls[0]) != 1 {
		t.Fatalf("v3Calls=%v, want one call with one job", enq.v3Calls)
	}
	job := enq.v3Calls[0][0]
	if job.AnilistID != 50001 || job.BgmID != int(bgm) {
		t.Errorf("V3 job=%+v, want anilist=50001 bgm=%d", job, bgm)
	}
}

func TestHealCn_PG(t *testing.T) {
	_, pool := makeHandlers(t)
	h, enq := newEnrichmentHandlersForPG(t, pool)

	bgm := int32(9999)
	// candidate: bgm_id set, version=2, title_chinese null
	seedAnime(t, pool, animeSeed{
		AnilistID:      60001,
		TitleRomaji:    "Heal Me",
		BgmID:          &bgm,
		BangumiVersion: 2,
	})
	// not a candidate (title_chinese present)
	seedAnime(t, pool, animeSeed{
		AnilistID:      60002,
		TitleRomaji:    "Already Healed",
		TitleChinese:   "已治愈",
		BgmID:          &bgm,
		BangumiVersion: 2,
	})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/enrichment/heal-cn", nil)
	rec := httptest.NewRecorder()
	h.HealCn(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if len(enq.v3Calls) != 1 || len(enq.v3Calls[0]) != 1 || enq.v3Calls[0][0].AnilistID != 60001 {
		t.Errorf("v3Calls=%v, want one job for anilist 60001 only", enq.v3Calls)
	}

	// Use queue package symbol so unused-import guard stays happy.
	_ = queue.BangumiV3QueueName
}
