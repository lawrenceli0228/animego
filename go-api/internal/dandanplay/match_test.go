package dandanplay

// match_test.go — orchestration tests for the 3-phase /match handler.
// Uses fake DandanClient + fake DBQuerier + fake BangumiSearcher
// (instead of testcontainers + httptest.NewServer) so the orchestration
// branches stay unit-testable in isolation.  PG-backed integration is
// covered in handlers_test.go.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ─── Fakes ─────────────────────────────────────────────────────────────────

// fakeClient is a programmable stand-in for *Client / DandanClient.
// Each method consults the corresponding handler if set, otherwise
// returns zero/nil.  Call counters let tests assert which orchestration
// branches fired.
type fakeClient struct {
	mu sync.Mutex

	matchFn        func(ctx context.Context, fileName, fileHash string, fileSize int64) (*MatchResult, error)
	episodesBgmFn  func(ctx context.Context, bgmID int32) (*EpisodeData, error)
	episodesDanFn  func(ctx context.Context, animeID int64) (*EpisodeData, error)
	searchFn       func(ctx context.Context, keyword string) ([]DandanAnime, error)
	commentsFn     func(ctx context.Context, episodeID int64) (*CommentsResponse, error)

	matchCalls        atomic.Int32
	matchInvocations  []matchCall
	episodesBgmCalls  atomic.Int32
	episodesDanCalls  atomic.Int32
	searchCalls       atomic.Int32
	commentsCalls     atomic.Int32
}

type matchCall struct {
	FileName string
	FileHash string
	FileSize int64
}

func (f *fakeClient) MatchCombined(ctx context.Context, fileName, fileHash string, fileSize int64) (*MatchResult, error) {
	f.matchCalls.Add(1)
	f.mu.Lock()
	f.matchInvocations = append(f.matchInvocations, matchCall{fileName, fileHash, fileSize})
	f.mu.Unlock()
	if f.matchFn == nil {
		return nil, nil
	}
	return f.matchFn(ctx, fileName, fileHash, fileSize)
}

func (f *fakeClient) FetchEpisodesByBgmID(ctx context.Context, bgmID int32) (*EpisodeData, error) {
	f.episodesBgmCalls.Add(1)
	if f.episodesBgmFn == nil {
		return nil, nil
	}
	return f.episodesBgmFn(ctx, bgmID)
}

func (f *fakeClient) FetchEpisodesByDandanAnimeID(ctx context.Context, animeID int64) (*EpisodeData, error) {
	f.episodesDanCalls.Add(1)
	if f.episodesDanFn == nil {
		return nil, nil
	}
	return f.episodesDanFn(ctx, animeID)
}

func (f *fakeClient) SearchAnime(ctx context.Context, keyword string) ([]DandanAnime, error) {
	f.searchCalls.Add(1)
	if f.searchFn == nil {
		return nil, nil
	}
	return f.searchFn(ctx, keyword)
}

func (f *fakeClient) FetchComments(ctx context.Context, episodeID int64) (*CommentsResponse, error) {
	f.commentsCalls.Add(1)
	if f.commentsFn == nil {
		return nil, nil
	}
	return f.commentsFn(ctx, episodeID)
}

// fakeDB is a programmable stand-in for DBQuerier with optional delay
// hooks so the 20s timeout test can simulate a slow Postgres.
type fakeDB struct {
	searchFn    func(ctx context.Context, pattern *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error)
	byBgmFn     func(ctx context.Context, bgmID *int32) (dbgen.GetAnimeByBgmIDRow, error)
	genresFn    func(ctx context.Context, animeID int32) ([]string, error)
	studiosFn   func(ctx context.Context, animeID int32) ([]string, error)

	searchCalls  atomic.Int32
	byBgmCalls   atomic.Int32
	genresCalls  atomic.Int32
	studiosCalls atomic.Int32
}

func (f *fakeDB) SearchAnimeCacheForDandanplay(ctx context.Context, pattern *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
	f.searchCalls.Add(1)
	if f.searchFn == nil {
		return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil
	}
	return f.searchFn(ctx, pattern)
}

func (f *fakeDB) GetAnimeByBgmID(ctx context.Context, bgmID *int32) (dbgen.GetAnimeByBgmIDRow, error) {
	f.byBgmCalls.Add(1)
	if f.byBgmFn == nil {
		return dbgen.GetAnimeByBgmIDRow{}, pgx.ErrNoRows
	}
	return f.byBgmFn(ctx, bgmID)
}

func (f *fakeDB) GetAnimeGenresByID(ctx context.Context, animeID int32) ([]string, error) {
	f.genresCalls.Add(1)
	if f.genresFn == nil {
		return []string{}, nil
	}
	return f.genresFn(ctx, animeID)
}

func (f *fakeDB) GetAnimeStudiosByID(ctx context.Context, animeID int32) ([]string, error) {
	f.studiosCalls.Add(1)
	if f.studiosFn == nil {
		return []string{}, nil
	}
	return f.studiosFn(ctx, animeID)
}

// fakeBangumi stubs BangumiSearcher.  Default impl returns nil resp.
type fakeBangumi struct {
	searchFn func(ctx context.Context, keyword string) (*bangumi.SearchResponse, error)
	calls    atomic.Int32
}

func (f *fakeBangumi) Search(ctx context.Context, keyword string) (*bangumi.SearchResponse, error) {
	f.calls.Add(1)
	if f.searchFn == nil {
		return nil, bangumi.ErrNotFound
	}
	return f.searchFn(ctx, keyword)
}

// ─── Test helpers ──────────────────────────────────────────────────────────

func newTestHandlers(db DBQuerier, client DandanClient, bgm BangumiSearcher) *Handlers {
	return &Handlers{DB: db, Client: client, BangumiClient: bgm}
}

// strPtr is a tiny helper because Go disallows `&"x"`.
func strPtr(s string) *string { return &s }
func i32Ptr(n int32) *int32   { return &n }
func f64Ptr(f float64) *float64 { return &f }

func postMatch(t *testing.T, h *Handlers, body MatchRequest) *httptest.ResponseRecorder {
	t.Helper()
	buf, err := json.Marshal(body)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/api/dandanplay/match", bytes.NewReader(buf))
	rec := httptest.NewRecorder()
	h.Match(rec, req)
	return rec
}

// unmarshalMatch decodes the /match response into a flexible map so
// tests can assert on optional fields without modelling every shape.
func unmarshalMatch(t *testing.T, rec *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	var out map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), "body=%s", rec.Body.String())
	return out
}

// makeEpisodeData builds a 12-episode payload (numbered 1..12) for
// Phase 1/2 success paths.
func makeEpisodeData(animeID int64, title string) *EpisodeData {
	eps := make([]DandanEpisode, 0, 12)
	for i := 1; i <= 12; i++ {
		n := i
		eps = append(eps, DandanEpisode{
			DandanEpisodeID:  int64(animeID*100 + int64(i)),
			Title:            fmt.Sprintf("Ep %02d", i),
			RawEpisodeNumber: fmt.Sprintf("%d", i),
			Number:           &n,
		})
	}
	return &EpisodeData{
		DandanAnimeID: animeID,
		Title:         title,
		ImageURL:      "https://img/x.jpg",
		Episodes:      eps,
	}
}

// ─── Phase 1 happy path ────────────────────────────────────────────────────

func TestMatch_Phase1_ExactHash(t *testing.T) {
	client := &fakeClient{
		matchFn: func(_ context.Context, fileName, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{
				IsMatched:    true,
				AnimeID:      42,
				AnimeTitle:   "進撃の巨人",
				EpisodeID:    701,
				EpisodeTitle: "Ep 1",
			}, nil
		},
		episodesDanFn: func(_ context.Context, animeID int64) (*EpisodeData, error) {
			require.Equal(t, int64(42), animeID)
			return makeEpisodeData(42, "進撃の巨人"), nil
		},
	}
	db := &fakeDB{}
	h := newTestHandlers(db, client, nil)

	rec := postMatch(t, h, MatchRequest{
		FileName: "[Erai] AoT - 01 [1080p].mkv",
		Episodes: []int{1, 2, 3},
	})
	out := unmarshalMatch(t, rec)

	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.True(t, matched, "matched should be true; body=%s", rec.Body.String())

	var source string
	require.NoError(t, json.Unmarshal(out["source"], &source))
	assert.Equal(t, "dandanplay", source)

	// episodeMap should have entries for 1, 2, 3.
	var ep map[string]EpisodeMapEntry
	require.NoError(t, json.Unmarshal(out["episodeMap"], &ep))
	assert.Len(t, ep, 3)
	assert.Equal(t, int64(4201), ep["1"].DandanEpisodeID)
	assert.Equal(t, "Ep 01", ep["1"].Title)

	// One MatchCombined call (the upfront one); no per-file fallback
	// needed because exact-numeric mapping covered all 3 episodes.
	assert.Equal(t, int32(1), client.matchCalls.Load())
}

func TestMatch_Phase1_LooseMatchGate(t *testing.T) {
	// dandanplay returns isMatched=false but the title overlaps the
	// user keyword loosely — accept gate should still trigger.
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{
				IsMatched:  false,
				AnimeID:    77,
				AnimeTitle: "Kaguya-sama wa Kokurasetai",
			}, nil
		},
		episodesDanFn: func(_ context.Context, _ int64) (*EpisodeData, error) {
			return makeEpisodeData(77, "Kaguya-sama wa Kokurasetai"), nil
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{
		FileName: "Kaguya-sama - 03.mkv",
		Keyword:  "Kaguya-sama wa Kokurasetai",
		Episodes: []int{3},
	})
	out := unmarshalMatch(t, rec)
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.True(t, matched, "loose match should be accepted; body=%s", rec.Body.String())
}

func TestMatch_Phase1_LooseMatchRejectedWithoutKeyword(t *testing.T) {
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{
				IsMatched:  false,
				AnimeID:    77,
				AnimeTitle: "Some Anime",
			}, nil
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	// No keyword, no fallback phases (no episodes/files) → miss.
	rec := postMatch(t, h, MatchRequest{
		FileName: "Some Anime - 03.mkv",
	})
	out := unmarshalMatch(t, rec)
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.False(t, matched)
}

func TestMatch_Phase1_EmptyEpisodeMap_FallsThrough(t *testing.T) {
	// Phase 1 produces an episodeMap that's empty (no requested
	// episodes match the dandanplay episodes pool) → fall through.
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{
				IsMatched: true, AnimeID: 1,
			}, nil
		},
		episodesDanFn: func(_ context.Context, _ int64) (*EpisodeData, error) {
			return &EpisodeData{Title: "x", Episodes: []DandanEpisode{}}, nil
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{
		FileName: "x.mkv",
		Episodes: []int{1},
	})
	out := unmarshalMatch(t, rec)
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.False(t, matched, "no fall-through phases should yield miss")
}

// ─── Phase 2 happy path ────────────────────────────────────────────────────

func TestMatch_Phase2_CacheHit(t *testing.T) {
	bgmID := int32(123)
	row := dbgen.SearchAnimeCacheForDandanplayRow{
		AnilistID:    900,
		BgmID:        &bgmID,
		TitleChinese: strPtr("辉夜大小姐"),
		TitleNative:  strPtr("かぐや様"),
		Episodes:     i32Ptr(12),
	}
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return []dbgen.SearchAnimeCacheForDandanplayRow{row}, nil
		},
		genresFn: func(_ context.Context, _ int32) ([]string, error) {
			return []string{"Romance", "Comedy"}, nil
		},
	}
	client := &fakeClient{
		episodesBgmFn: func(_ context.Context, id int32) (*EpisodeData, error) {
			require.Equal(t, int32(123), id)
			return makeEpisodeData(int64(id), "Kaguya"), nil
		},
	}
	h := newTestHandlers(db, client, nil)
	rec := postMatch(t, h, MatchRequest{
		Keyword:  "Kaguya",
		Episodes: []int{1, 2},
	})
	out := unmarshalMatch(t, rec)

	var source string
	require.NoError(t, json.Unmarshal(out["source"], &source))
	assert.Equal(t, "animeCache", source)

	// siteAnime should carry genres from the parallel enrichment.
	var site map[string]any
	require.NoError(t, json.Unmarshal(out["siteAnime"], &site))
	assert.Contains(t, fmt.Sprint(site["genres"]), "Romance")
}

func TestMatch_Phase2_SkipsRowsWithoutBgmID(t *testing.T) {
	bgmID := int32(555)
	rows := []dbgen.SearchAnimeCacheForDandanplayRow{
		{AnilistID: 1, BgmID: nil},          // skipped
		{AnilistID: 2, BgmID: &bgmID},       // tried
	}
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return rows, nil
		},
	}
	var episodesCalledFor int32
	client := &fakeClient{
		episodesBgmFn: func(_ context.Context, id int32) (*EpisodeData, error) {
			episodesCalledFor = id
			return makeEpisodeData(int64(id), "x"), nil
		},
	}
	h := newTestHandlers(db, client, nil)
	rec := postMatch(t, h, MatchRequest{Keyword: "x", Episodes: []int{1}})
	_ = unmarshalMatch(t, rec)
	assert.Equal(t, int32(555), episodesCalledFor, "should skip nil-bgm row")
}

func TestMatch_Phase2_CandidateMissesFallThrough(t *testing.T) {
	// First candidate's episodes endpoint returns nil → continue.
	// Second candidate succeeds.
	bgmA := int32(1)
	bgmB := int32(2)
	rows := []dbgen.SearchAnimeCacheForDandanplayRow{
		{AnilistID: 10, BgmID: &bgmA},
		{AnilistID: 20, BgmID: &bgmB},
	}
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return rows, nil
		},
	}
	client := &fakeClient{
		episodesBgmFn: func(_ context.Context, id int32) (*EpisodeData, error) {
			if id == 1 {
				return nil, nil // miss
			}
			return makeEpisodeData(int64(id), "x"), nil
		},
	}
	h := newTestHandlers(db, client, nil)
	rec := postMatch(t, h, MatchRequest{Keyword: "x", Episodes: []int{1}})
	out := unmarshalMatch(t, rec)
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.True(t, matched)
}

// ─── Phase 3: per-file matching ────────────────────────────────────────────

func TestMatch_Phase3_PerFileSuccess(t *testing.T) {
	// No Phase 1 / Phase 2 inputs → directly into Phase 3.  Each file
	// resolves to a distinct episodeId.
	client := &fakeClient{
		matchFn: func(_ context.Context, fileName, _ string, _ int64) (*MatchResult, error) {
			// fileName encodes the episode number.
			switch {
			case strings.Contains(fileName, "01"):
				return &MatchResult{IsMatched: true, EpisodeID: 1001, EpisodeTitle: "Ep1"}, nil
			case strings.Contains(fileName, "02"):
				return &MatchResult{IsMatched: true, EpisodeID: 1002, EpisodeTitle: "Ep2"}, nil
			}
			return nil, nil
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{
		Episodes: []int{1, 2},
		Files: []MatchFileInfo{
			{Episode: 1, FileName: "01.mkv"},
			{Episode: 2, FileName: "02.mkv"},
		},
	})
	out := unmarshalMatch(t, rec)
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.True(t, matched, "body=%s", rec.Body.String())

	// Phase 3 emits `anime: {}` (empty object), siteAnime null.
	assert.Equal(t, "{}", string(out["anime"]))
	assert.Equal(t, "null", string(out["siteAnime"]))

	var src string
	require.NoError(t, json.Unmarshal(out["source"], &src))
	assert.Equal(t, "dandanplay", src)
}

func TestMatch_Phase3_StrictGate_RejectsLooseMatch(t *testing.T) {
	// Phase 3 should NOT honour the Phase 1 loose-match relaxation —
	// isMatched=false must reject even when title is plausible.
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{IsMatched: false, AnimeTitle: "Anything", EpisodeID: 1}, nil
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{
		Episodes: []int{1},
		Files:    []MatchFileInfo{{Episode: 1, FileName: "x.mkv"}},
	})
	out := unmarshalMatch(t, rec)
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.False(t, matched, "loose match must NOT be accepted in Phase 3")
}

func TestMatch_Phase3_DedupesUsedEpisodeIDs(t *testing.T) {
	// Two file infos resolve to the SAME dandan EpisodeID — second
	// should be dropped (Phase 3 dedup via usedIDs).
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{IsMatched: true, EpisodeID: 999, EpisodeTitle: "Same"}, nil
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{
		Episodes: []int{1, 2},
		Files: []MatchFileInfo{
			{Episode: 1, FileName: "a.mkv"},
			{Episode: 2, FileName: "b.mkv"},
		},
	})
	out := unmarshalMatch(t, rec)
	var ep map[string]EpisodeMapEntry
	require.NoError(t, json.Unmarshal(out["episodeMap"], &ep))
	assert.Len(t, ep, 1, "second file should be deduped")
}

// ─── Total miss ────────────────────────────────────────────────────────────

func TestMatch_TotalMiss(t *testing.T) {
	h := newTestHandlers(&fakeDB{}, &fakeClient{}, nil)
	rec := postMatch(t, h, MatchRequest{})
	require.Equal(t, http.StatusOK, rec.Code)
	// Express miss is exactly `{"matched":false}` — verify byte
	// shape (no nulls for other fields).
	assert.JSONEq(t, `{"matched":false}`, rec.Body.String())
}

func TestMatch_BadJSON_TreatedAsMiss(t *testing.T) {
	h := newTestHandlers(&fakeDB{}, &fakeClient{}, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/dandanplay/match", strings.NewReader("not json"))
	rec := httptest.NewRecorder()
	h.Match(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"matched":false}`, rec.Body.String())
}

// ─── findSiteAnime: Bangumi 2s timeout ────────────────────────────────────

func TestMatch_FindSiteAnime_BangumiFallbackTimeout(t *testing.T) {
	// Bangumi.Search blocks past the 2s budget — must NOT block the
	// /match handler.  Phase 1 still succeeds; siteAnime ends up null.
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{IsMatched: true, AnimeID: 1, AnimeTitle: "Foo"}, nil
		},
		episodesDanFn: func(_ context.Context, _ int64) (*EpisodeData, error) {
			return makeEpisodeData(1, "Foo"), nil
		},
	}
	// DB cache search returns empty (forces fall-through to Bangumi).
	db := &fakeDB{}
	bgm := &fakeBangumi{
		searchFn: func(ctx context.Context, _ string) (*bangumi.SearchResponse, error) {
			// Honour ctx cancellation — what *bangumi.Client does in
			// production.  Should be cancelled by the 2s budget.
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(10 * time.Second):
				return nil, errors.New("should not reach")
			}
		},
	}
	h := newTestHandlers(db, client, bgm)

	start := time.Now()
	rec := postMatch(t, h, MatchRequest{
		FileName: "x.mkv",
		Episodes: []int{1},
	})
	elapsed := time.Since(start)

	// Must come back well under the overall 20s cap — confirms the
	// 2s Bangumi sub-budget fired.
	assert.Less(t, elapsed, 5*time.Second, "Bangumi fallback must time out at 2s; got %v", elapsed)

	out := unmarshalMatch(t, rec)
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.True(t, matched, "Phase 1 should still succeed despite Bangumi timeout")
	// siteAnime should be null because the Bangumi fallback failed.
	assert.Equal(t, "null", string(out["siteAnime"]))
}

func TestMatch_FindSiteAnime_BangumiNilClient(t *testing.T) {
	// Nil BangumiClient is allowed — findSiteAnime short-circuits.
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{IsMatched: true, AnimeID: 1, AnimeTitle: "Foo"}, nil
		},
		episodesDanFn: func(_ context.Context, _ int64) (*EpisodeData, error) {
			return makeEpisodeData(1, "Foo"), nil
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{FileName: "x.mkv", Episodes: []int{1}})
	out := unmarshalMatch(t, rec)
	assert.Equal(t, "null", string(out["siteAnime"]))
}

// ─── 20s overall timeout ──────────────────────────────────────────────────

func TestMatch_OverallTimeout(t *testing.T) {
	// Stub the client so Phase 1's MatchCombined blocks until ctx is
	// cancelled.  The handler-level 20s cap will fire — but at 20s
	// that's too long for unit tests.  Override matchTimeout via a
	// local Handlers field is impossible, so we use a tighter
	// per-request context via httptest.NewRequestWithContext.
	client := &fakeClient{
		matchFn: func(ctx context.Context, _, _ string, _ int64) (*MatchResult, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	buf, _ := json.Marshal(MatchRequest{FileName: "x.mkv", Episodes: []int{1}})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(buf)).WithContext(ctx)
	rec := httptest.NewRecorder()
	h.Match(rec, req)
	// Either we hit the handler-internal timeout branch (500) or
	// fall-through miss (`{matched:false}`) depending on which ctx
	// fires first.  Both are acceptable — what we care about is the
	// handler doesn't hang.
	assert.Contains(t, []int{http.StatusOK, http.StatusInternalServerError}, rec.Code)
}

// ─── Per-file unmapped fallback ───────────────────────────────────────────

// ─── findSiteAnime / bangumiFallback level-by-level coverage ──────────────

func TestFindSiteAnime_Level1_TitleHit(t *testing.T) {
	row := dbgen.SearchAnimeCacheForDandanplayRow{AnilistID: 1, TitleNative: strPtr("Hit")}
	db := &fakeDB{
		searchFn: func(_ context.Context, pattern *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			// Called with the title pattern — return immediately.
			return []dbgen.SearchAnimeCacheForDandanplayRow{row}, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, nil)
	got := h.findSiteAnime(context.Background(), "Hit Title", "different keyword")
	require.NotNil(t, got)
	assert.Equal(t, int32(1), got.AnilistID)
	assert.Equal(t, int32(1), db.searchCalls.Load(), "should stop after level 1 hit")
}

func TestFindSiteAnime_Level2_KeywordHit(t *testing.T) {
	row := dbgen.SearchAnimeCacheForDandanplayRow{AnilistID: 2}
	calls := atomic.Int32{}
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			if calls.Add(1) == 1 {
				return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil // level 1 miss
			}
			return []dbgen.SearchAnimeCacheForDandanplayRow{row}, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, nil)
	got := h.findSiteAnime(context.Background(), "title-x", "keyword-y")
	require.NotNil(t, got)
	assert.Equal(t, int32(2), got.AnilistID)
	assert.Equal(t, int32(2), calls.Load(), "should call twice (level 1 + level 2)")
}

func TestFindSiteAnime_Level2_SkippedWhenSameAsTitle(t *testing.T) {
	calls := atomic.Int32{}
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			calls.Add(1)
			return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, nil)
	// title == userKeyword → level 2 should be skipped.
	got := h.findSiteAnime(context.Background(), "same", "same")
	assert.Nil(t, got)
	assert.Equal(t, int32(1), calls.Load(), "level 2 skipped when title==keyword")
}

func TestFindSiteAnime_Level3_BangumiSuccess(t *testing.T) {
	bgmID := int32(99)
	rowDB := dbgen.GetAnimeByBgmIDRow{AnilistID: 999, BgmID: &bgmID}
	db := &fakeDB{
		// Levels 1+2 miss.
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil
		},
		byBgmFn: func(_ context.Context, id *int32) (dbgen.GetAnimeByBgmIDRow, error) {
			require.NotNil(t, id)
			assert.Equal(t, int32(99), *id)
			return rowDB, nil
		},
	}
	bgm := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{List: []bangumi.SearchResult{
				{ID: 99, Name: "Some title"},
			}}, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, bgm)
	got := h.findSiteAnime(context.Background(), "Some title", "")
	require.NotNil(t, got)
	assert.Equal(t, int32(999), got.AnilistID)
	assert.Equal(t, int32(1), bgm.calls.Load())
	assert.Equal(t, int32(1), db.byBgmCalls.Load())
}

func TestFindSiteAnime_Level3_BangumiExactNativeMatchPreferred(t *testing.T) {
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil
		},
		byBgmFn: func(_ context.Context, id *int32) (dbgen.GetAnimeByBgmIDRow, error) {
			require.NotNil(t, id)
			assert.Equal(t, int32(777), *id, "should pick exact-native hit, not list[0]")
			return dbgen.GetAnimeByBgmIDRow{AnilistID: 777, BgmID: id}, nil
		},
	}
	bgm := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{List: []bangumi.SearchResult{
				{ID: 1, Name: "OtherTitle"},
				{ID: 777, Name: "MatchingTitle"},
			}}, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, bgm)
	got := h.findSiteAnime(context.Background(), "MatchingTitle", "")
	require.NotNil(t, got)
	assert.Equal(t, int32(777), got.AnilistID)
}

func TestFindSiteAnime_Level3_BangumiEmptyList(t *testing.T) {
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil
		},
	}
	bgm := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{List: nil}, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, bgm)
	got := h.findSiteAnime(context.Background(), "x", "")
	assert.Nil(t, got)
}

func TestFindSiteAnime_Level3_BgmIDZero(t *testing.T) {
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil
		},
	}
	bgm := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			// ID=0 → caller treats as a miss.
			return &bangumi.SearchResponse{List: []bangumi.SearchResult{{ID: 0, Name: "x"}}}, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, bgm)
	got := h.findSiteAnime(context.Background(), "x", "")
	assert.Nil(t, got)
}

func TestFindSiteAnime_Level3_EmptyKeyword(t *testing.T) {
	// title="", keyword="" → bangumiFallback short-circuits.
	db := &fakeDB{}
	bgm := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			t.Fatal("bangumi search should not be called with empty keyword")
			return nil, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, bgm)
	got := h.findSiteAnime(context.Background(), "", "")
	assert.Nil(t, got)
	assert.Equal(t, int32(0), bgm.calls.Load())
}

func TestFindSiteAnime_DBError_Logged_Continues(t *testing.T) {
	// Level 1 returns an error — level 3 (bangumi) still runs.
	errDB := errors.New("postgres unavailable")
	calls := atomic.Int32{}
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			calls.Add(1)
			return nil, errDB
		},
	}
	h := newTestHandlers(db, &fakeClient{}, nil)
	got := h.findSiteAnime(context.Background(), "title", "kw")
	assert.Nil(t, got, "all levels miss → nil")
	// Level 1 + level 2 both ran despite DB errors.
	assert.Equal(t, int32(2), calls.Load())
}

func TestBangumiFallback_GetByBgmIDError(t *testing.T) {
	bgmErr := errors.New("db boom")
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return []dbgen.SearchAnimeCacheForDandanplayRow{}, nil
		},
		byBgmFn: func(_ context.Context, _ *int32) (dbgen.GetAnimeByBgmIDRow, error) {
			return dbgen.GetAnimeByBgmIDRow{}, bgmErr
		},
	}
	bgm := &fakeBangumi{
		searchFn: func(_ context.Context, _ string) (*bangumi.SearchResponse, error) {
			return &bangumi.SearchResponse{List: []bangumi.SearchResult{{ID: 5, Name: "x"}}}, nil
		},
	}
	h := newTestHandlers(db, &fakeClient{}, bgm)
	got := h.findSiteAnime(context.Background(), "x", "")
	assert.Nil(t, got)
}

func TestRowFromBgmRow_PreservesAllFields(t *testing.T) {
	bgmID := int32(42)
	in := dbgen.GetAnimeByBgmIDRow{
		AnilistID:    7,
		TitleNative:  strPtr("ネイティブ"),
		TitleRomaji:  strPtr("Romaji"),
		Episodes:     i32Ptr(13),
		BgmID:        &bgmID,
		AverageScore: f64Ptr(85.5),
	}
	out := rowFromBgmRow(in)
	require.NotNil(t, out)
	assert.Equal(t, in.AnilistID, out.AnilistID)
	assert.Equal(t, *in.TitleNative, *out.TitleNative)
	assert.Equal(t, *in.BgmID, *out.BgmID)
	assert.Equal(t, *in.AverageScore, *out.AverageScore)
}

func TestPickSiteAnime_NilRow(t *testing.T) {
	h := newTestHandlers(&fakeDB{}, &fakeClient{}, nil)
	assert.Nil(t, h.pickSiteAnime(context.Background(), nil))
}

func TestPickSiteAnime_GenresStudiosError_DowngradesToEmpty(t *testing.T) {
	row := &dbgen.SearchAnimeCacheForDandanplayRow{AnilistID: 100, TitleNative: strPtr("X")}
	db := &fakeDB{
		genresFn:  func(_ context.Context, _ int32) ([]string, error) { return nil, errors.New("genres boom") },
		studiosFn: func(_ context.Context, _ int32) ([]string, error) { return nil, errors.New("studios boom") },
	}
	h := newTestHandlers(db, &fakeClient{}, nil)
	got := h.pickSiteAnime(context.Background(), row)
	require.NotNil(t, got)
	assert.Equal(t, []string{}, got.Genres)
	assert.Equal(t, []string{}, got.Studios)
}

// ─── Search empty-token keyword ───────────────────────────────────────────

func TestSearch_KeywordTokenless_EmptyResults(t *testing.T) {
	calls := atomic.Int32{}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// SearchAnime is still called with the punctuation-only string;
		// the client trims it but the network may still fire.  Either
		// way, this test focuses on the empty cache results path.
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"animes":[]}`))
	}))
	t.Cleanup(backend.Close)
	_ = backend // keep referenced

	db := &fakeDB{}
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			return []DandanAnime{}, nil
		},
	}
	h := newTestHandlers(db, client, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/search?keyword=!!!", nil)
	rec := httptest.NewRecorder()
	h.Search(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body=%s", rec.Body.String())
	// `!!!` tokenises to nothing → cache returns []; dandanplay
	// SearchAnime still runs but returns [].  Net result: empty.
	var out struct {
		Results []any `json:"results"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Empty(t, out.Results)
}

func TestSearch_CacheError_500(t *testing.T) {
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			return []DandanAnime{}, nil
		},
	}
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return nil, errors.New("db boom")
		},
	}
	h := newTestHandlers(db, client, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/dandanplay/search?keyword=x", nil)
	rec := httptest.NewRecorder()
	h.Search(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

// ─── GetComments client error path ────────────────────────────────────────

func TestGetComments_ClientError_500(t *testing.T) {
	client := &fakeClient{
		commentsFn: func(_ context.Context, _ int64) (*CommentsResponse, error) {
			return nil, errors.New("transport boom")
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/comments/42", "episodeId", "42")
	rec := httptest.NewRecorder()
	h.GetComments(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), `"error":"comments fetch failed"`)
}

// ─── GetEpisodes client transport error ───────────────────────────────────

func TestGetEpisodes_ClientError_500(t *testing.T) {
	client := &fakeClient{
		episodesDanFn: func(_ context.Context, _ int64) (*EpisodeData, error) {
			return nil, errors.New("transport boom")
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/episodes/9", "animeId", "9")
	rec := httptest.NewRecorder()
	h.GetEpisodes(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestGetEpisodes_BgmIDPath_ClientError(t *testing.T) {
	client := &fakeClient{
		episodesBgmFn: func(_ context.Context, _ int32) (*EpisodeData, error) {
			return nil, errors.New("transport boom")
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	req := reqWithParam(http.MethodGet, "/api/dandanplay/episodes/9", "animeId", "9")
	req.URL.RawQuery = "bgmId=1"
	rec := httptest.NewRecorder()
	h.GetEpisodes(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

// ─── Phase 2 specific error paths ─────────────────────────────────────────

func TestMatch_Phase2_CacheSearchError_FallsThrough(t *testing.T) {
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return nil, errors.New("db boom")
		},
	}
	h := newTestHandlers(db, &fakeClient{}, nil)
	rec := postMatch(t, h, MatchRequest{Keyword: "x", Episodes: []int{1}})
	// Phase 2 cache error → falls through; no files → final miss.
	var matched bool
	out := unmarshalMatch(t, rec)
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.False(t, matched)
}

func TestMatch_Phase2_EpisodesFetchError_ContinuesToNext(t *testing.T) {
	bgmA := int32(1)
	bgmB := int32(2)
	db := &fakeDB{
		searchFn: func(_ context.Context, _ *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			return []dbgen.SearchAnimeCacheForDandanplayRow{
				{AnilistID: 10, BgmID: &bgmA},
				{AnilistID: 20, BgmID: &bgmB},
			}, nil
		},
	}
	client := &fakeClient{
		episodesBgmFn: func(_ context.Context, id int32) (*EpisodeData, error) {
			if id == 1 {
				return nil, errors.New("upstream boom")
			}
			return makeEpisodeData(int64(id), "x"), nil
		},
	}
	h := newTestHandlers(db, client, nil)
	rec := postMatch(t, h, MatchRequest{Keyword: "x", Episodes: []int{1}})
	out := unmarshalMatch(t, rec)
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.True(t, matched, "second candidate should win")
}

// ─── Phase 1 error paths ──────────────────────────────────────────────────

func TestMatch_Phase1_MatchError_FallsThrough(t *testing.T) {
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return nil, errors.New("match boom")
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{FileName: "x.mkv", Episodes: []int{1}})
	var matched bool
	out := unmarshalMatch(t, rec)
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.False(t, matched)
}

func TestMatch_Phase1_EpisodesFetchError_FallsThrough(t *testing.T) {
	client := &fakeClient{
		matchFn: func(_ context.Context, _, _ string, _ int64) (*MatchResult, error) {
			return &MatchResult{IsMatched: true, AnimeID: 1}, nil
		},
		episodesDanFn: func(_ context.Context, _ int64) (*EpisodeData, error) {
			return nil, errors.New("episodes boom")
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{FileName: "x.mkv", Episodes: []int{1}})
	var matched bool
	out := unmarshalMatch(t, rec)
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	assert.False(t, matched)
}

func TestMatchUnmappedFiles_FillsGaps(t *testing.T) {
	// Phase 1 succeeds for episode 1 via the upfront combined match,
	// but episodes 2 and 3 require the per-file fallback to resolve.
	client := &fakeClient{
		matchFn: func(_ context.Context, fileName, _ string, _ int64) (*MatchResult, error) {
			switch {
			case strings.Contains(fileName, "first"):
				return &MatchResult{
					IsMatched:  true,
					AnimeID:    1,
					AnimeTitle: "Foo",
					EpisodeID:  101,
				}, nil
			case strings.Contains(fileName, "ep2"):
				return &MatchResult{IsMatched: true, EpisodeID: 102, EpisodeTitle: "Ep2"}, nil
			case strings.Contains(fileName, "ep3"):
				return &MatchResult{IsMatched: true, EpisodeID: 103, EpisodeTitle: "Ep3"}, nil
			}
			return nil, nil
		},
		episodesDanFn: func(_ context.Context, _ int64) (*EpisodeData, error) {
			// Only episode 1 in the pool — episodes 2/3 will be
			// missing from BuildEpisodeMap and require the per-file
			// fallback.
			one := 1
			return &EpisodeData{
				Title: "Foo",
				Episodes: []DandanEpisode{
					{DandanEpisodeID: 101, Title: "Ep1", RawEpisodeNumber: "1", Number: &one},
				},
			}, nil
		},
	}
	h := newTestHandlers(&fakeDB{}, client, nil)
	rec := postMatch(t, h, MatchRequest{
		FileName: "first.mkv",
		Episodes: []int{1, 2, 3},
		Files: []MatchFileInfo{
			{Episode: 2, FileName: "ep2.mkv"},
			{Episode: 3, FileName: "ep3.mkv"},
		},
	})
	out := unmarshalMatch(t, rec)
	var ep map[string]EpisodeMapEntry
	require.NoError(t, json.Unmarshal(out["episodeMap"], &ep))
	assert.Len(t, ep, 3, "all three episodes should be mapped via per-file fallback")
}
