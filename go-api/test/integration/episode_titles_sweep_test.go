//go:build integration

// episode_titles_sweep_test.go — the RELEASING sweep's decisions, against a
// real Postgres and two fake upstreams.
//
// Why this file exists: mutation testing on 2026-09-06 found that six
// deliberate breakages of EpisodeTitlesWorker.sweepOne all survived the whole
// suite.  windowTitles was well covered — it is a pure function and has its own
// table test — but everything around it was not: which upstream a row is routed
// to, whether the Bangumi fallback is reached at all, and whether a row that
// produced nothing is stamped so it moves to the back of the queue.  Those are
// the decisions the sweep is made of, and a passing CI run said nothing about
// any of them.
//
// It could not be covered anywhere else.  sweepOne is unexported, so an
// external test package cannot call it; the worker holds a concrete
// *dbgen.Queries and a pool on purpose (the write is a four-statement
// transaction shared with the CLI), so an in-memory double cannot stand in for
// the database half; and a tagged test inside internal/queue would never run,
// because CI's integration steps are scoped to ./test/integration/... — the
// exact rot the comment on that step describes.  What is left is the honest
// shape: drive the exported Work() over a seeded candidate row, fake only the
// two upstream clients, and read the result out of the database.
//
// Each test below names the decision it pins.  Run with:
//
//	go test -tags=integration -count=1 -timeout=600s ./test/integration/...
package integration

import (
	"context"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// The anilist_id block this file owns.
const (
	swAnilistID = 700001
	swBgmID     = 9201
)

// ---------------------------------------------------------------------------
// Fake upstreams
// ---------------------------------------------------------------------------

// swDDP answers FetchEpisodesByBgmID from a fixed value and counts the asks.
// A nil data with a nil error is dandanplay's ordinary "no entry for that id",
// which is the input that sends a row to the Bangumi fallback.
type swDDP struct {
	data  *dandanplay.EpisodeData
	err   error
	calls int
}

func (f *swDDP) FetchEpisodesByBgmID(_ context.Context, _ int32) (*dandanplay.EpisodeData, error) {
	f.calls++
	return f.data, f.err
}

// swBGM is the fallback upstream.  The call counters are load-bearing: several
// cases below assert that Bangumi was NOT asked, which is the only way to see
// that the row was routed to dandanplay rather than merely that dandanplay's
// titles happened to win.
type swBGM struct {
	subject   *bangumi.Subject
	eps       *bangumi.EpisodesResponse
	subjCalls int
	epsCalls  int
}

func (f *swBGM) Subject(_ context.Context, _ int) (*bangumi.Subject, error) {
	f.subjCalls++
	if f.subject == nil {
		return nil, bangumi.ErrNotFound
	}
	return f.subject, nil
}

func (f *swBGM) Episodes(_ context.Context, _ int) (*bangumi.EpisodesResponse, error) {
	f.epsCalls++
	if f.eps == nil {
		return nil, bangumi.ErrNotFound
	}
	return f.eps, nil
}

// ---------------------------------------------------------------------------
// Arrange helpers
// ---------------------------------------------------------------------------

// swSeedCandidate writes the anime_cache row the candidate query selects:
// RELEASING, bound, never swept, with the episode count the scope guard
// divides by.
//
// bgm_match_source is 'manual' so the Bangumi fallback's identity gate has an
// authoritative answer instead of a similarity score.  These tests are about
// routing and stamping; making the gate's verdict depend on how two strings
// compare would mean a change to the scorer could fail them for a reason none
// of them is about.
func swSeedCandidate(t *testing.T, ctx context.Context, pool *pgxpool.Pool,
	anilistID, bgmID, episodes int32, matchSource string,
) {
	t.Helper()
	var src *string
	if matchSource != "" {
		src = &matchSource
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (
			anilist_id, title_romaji, title_native, bgm_id, status, episodes,
			bgm_match_source, episode_titles_at
		) VALUES ($1, 'sweep fixture', 'スイープ', $2, 'RELEASING', $3, $4, NULL)`,
		anilistID, bgmID, episodes, src,
	)
	require.NoError(t, err, "seed sweep candidate %d", anilistID)
}

// swSeedIDMap adds the vendored map entry that makes LookupBgmIdMap speak.
func swSeedIDMap(t *testing.T, ctx context.Context, pool *pgxpool.Pool, anilistID, bgmID int32) {
	t.Helper()
	_, err := pool.Exec(ctx,
		`INSERT INTO bgm_id_map (anilist_id, bgm_id) VALUES ($1, $2)`, anilistID, bgmID)
	require.NoError(t, err, "seed bgm_id_map %d", anilistID)
}

// swDDPEpisodes builds a dandanplay payload numbered 1..n with distinguishable
// titles.  anilistID is dandanplay's own cross-link, which is the field the
// routing decision reads.
func swDDPEpisodes(anilistID int32, first, last int, titlePrefix string) *dandanplay.EpisodeData {
	d := &dandanplay.EpisodeData{AniListID: anilistID}
	for n := first; n <= last; n++ {
		d.Episodes = append(d.Episodes, dandanplay.DandanEpisode{
			RawEpisodeNumber: strconv.Itoa(n),
			Title:            titlePrefix + strconv.Itoa(n),
		})
	}
	return d
}

// swRun executes exactly one pass.
func swRun(t *testing.T, ctx context.Context, pool *pgxpool.Pool, ddp *swDDP, bgm queue.EpisodeTitlesBangumiClient) {
	t.Helper()
	t.Setenv("EPISODE_TITLES_SWEEP_ENABLED", "1")
	w := queue.NewEpisodeTitlesWorker(pool, dbgen.New(pool), ddp, bgm)
	require.NoError(t, w.Work(ctx, &river.Job[queue.EpisodeTitlesArgs]{}), "one sweep pass")
}

// swSwept reports whether the row carries an attempt stamp.
func swSwept(t *testing.T, ctx context.Context, pool *pgxpool.Pool, anilistID int32) bool {
	t.Helper()
	var stamped bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT episode_titles_at IS NOT NULL FROM anime_cache WHERE anilist_id = $1`,
		anilistID).Scan(&stamped))
	return stamped
}

// ---------------------------------------------------------------------------
// Routing: which upstream answers for this row
// ---------------------------------------------------------------------------

// The id map vouching for the binding is what lets a dandanplay entry be used
// even though the entry names a different AniList id.
//
// dandanplay's own cross-links are incomplete and sometimes wrong, so its
// `anilistId` disagreeing is not by itself evidence against the binding — it
// is only evidence when nothing else vouches. Reading the condition the other
// way round (fall back precisely when the map DOES speak) inverts the meaning
// of every field involved, and no assertion in the suite noticed.
func TestSweepUsesDandanplayWhenTheIDMapVouches(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	swSeedCandidate(t, ctx, pool, swAnilistID, swBgmID, 2, "")
	swSeedIDMap(t, ctx, pool, swAnilistID, swBgmID)

	ddp := &swDDP{data: swDDPEpisodes(999999, 1, 2, "ddp-ep")}
	bgm := &swBGM{}
	swRun(t, ctx, pool, ddp, bgm)

	got := etRead(t, ctx, pool, swAnilistID, 1)
	require.True(t, got.present, "the vouched-for dandanplay list must be written")
	require.NotNil(t, got.name)
	assert.Equal(t, "ddp-ep1", *got.name)
	assert.Equal(t, 0, bgm.subjCalls, "Bangumi must not be asked when dandanplay answered")
}

// With nothing vouching for the binding, a dandanplay entry that names another
// anime is not an answer, and the row goes to Bangumi rather than nowhere.
//
// Deleting the id-mismatch arm leaves a condition that only catches a missing
// entry, so this row would be written from an entry that describes a different
// show — the failure the arm exists to prevent, and one that is invisible
// unless the two upstreams return different text.
func TestSweepFallsBackWhenNothingVouchesAndTheEntryNamesAnother(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	swSeedCandidate(t, ctx, pool, swAnilistID, swBgmID, 2, "manual")

	ddp := &swDDP{data: swDDPEpisodes(888888, 1, 2, "ddp-ep")}
	bgm := &swBGM{
		subject: &bangumi.Subject{ID: swBgmID, Name: "スイープ"},
		eps: &bangumi.EpisodesResponse{Eps: []bangumi.Episode{
			{Sort: 1, Type: 0, Name: "bgm-ep1"},
			{Sort: 2, Type: 0, Name: "bgm-ep2"},
		}},
	}
	swRun(t, ctx, pool, ddp, bgm)

	got := etRead(t, ctx, pool, swAnilistID, 1)
	require.True(t, got.present, "the fallback must write something")
	require.NotNil(t, got.name)
	assert.Equal(t, "bgm-ep1", *got.name, "the row must come from Bangumi, not from the entry naming another anime")
	assert.Equal(t, 1, bgm.epsCalls, "Bangumi must actually be asked")
}

// A dandanplay entry that vouches for itself but carries no usable title is
// still a row with no titles, and the fallback is what it is for.
//
// Ending the pass at `empty` here reads as correct — the list really was
// empty — and quietly gives up on a row Bangumi could have answered.
func TestSweepFallsBackWhenDandanplayHasNoUsableTitles(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	swSeedCandidate(t, ctx, pool, swAnilistID, swBgmID, 2, "manual")

	// Numbered but nameless: Usable() drops every one of them.
	ddp := &swDDP{data: &dandanplay.EpisodeData{
		AniListID: swAnilistID,
		Episodes: []dandanplay.DandanEpisode{
			{RawEpisodeNumber: "1", Title: ""},
			{RawEpisodeNumber: "2", Title: ""},
		},
	}}
	bgm := &swBGM{
		subject: &bangumi.Subject{ID: swBgmID, Name: "スイープ"},
		eps: &bangumi.EpisodesResponse{Eps: []bangumi.Episode{
			{Sort: 1, Type: 0, Name: "bgm-ep1"},
		}},
	}
	swRun(t, ctx, pool, ddp, bgm)

	got := etRead(t, ctx, pool, swAnilistID, 1)
	require.True(t, got.present, "an empty dandanplay list must not end the row")
	require.NotNil(t, got.name)
	assert.Equal(t, "bgm-ep1", *got.name)
}

// ---------------------------------------------------------------------------
// The window: a list wider than the entry is sliced, not refused
// ---------------------------------------------------------------------------

// A sequel's subject lists the whole franchise. The offset says which slice is
// this season, so there is something better to do than refuse.
//
// This is the sweep's half of the rule normalizeEpisodeTitles enforces on the
// Bangumi side; both reach it through episodeBound, so a regression in either
// makes the two writers disagree about where a season begins while writing the
// same table.
func TestSweepWindowsAListWiderThanTheEntry(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	// Season one ran 28; this is season two, 10 episodes, so the franchise's
	// continuous numbering puts it at 29..38.
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_romaji, format, episodes)
		VALUES (700010, 'season one', 'TV', 28)`)
	require.NoError(t, err)
	swSeedCandidate(t, ctx, pool, swAnilistID, swBgmID, 10, "manual")
	_, err = pool.Exec(ctx, `
		INSERT INTO anime_relations (anime_id, anilist_id, relation_type)
		VALUES ($1, 700010, 'PREQUEL')`, swAnilistID)
	require.NoError(t, err)

	ddp := &swDDP{data: swDDPEpisodes(swAnilistID, 1, 38, "ddp-ep")}
	swRun(t, ctx, pool, ddp, &swBGM{})

	assert.Equal(t, 10, etCountTitles(t, ctx, pool, swAnilistID),
		"only this season's slice of the franchise list may land")
	got := etRead(t, ctx, pool, swAnilistID, 1)
	require.True(t, got.present, "slot 1 must be filled")
	require.NotNil(t, got.name)
	assert.Equal(t, "ddp-ep29", *got.name,
		"slot 1 holds the franchise's episode 29, not its episode 1")
}

// ---------------------------------------------------------------------------
// The attempt stamp: a row that produced nothing still moves to the back
// ---------------------------------------------------------------------------

// Candidacy in this sweep IS the attempt stamp — there is no outcome
// bookkeeping — so a row that writes nothing and is not stamped stays at the
// head of every future batch forever. 0029's section C records that as the
// failure two earlier sweeps had to add columns to escape.
//
// Both outcomes that write nothing need it, and they are stamped by two
// separate statements, so they need two tests.
func TestSweepStampsARejectedRow(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	// No match source and a subject whose name is nothing like the entry's:
	// the fallback's identity gate refuses, which is `rejected`.
	swSeedCandidate(t, ctx, pool, swAnilistID, swBgmID, 2, "")

	ddp := &swDDP{}
	bgm := &swBGM{subject: &bangumi.Subject{ID: swBgmID, Name: "まったく別の作品"}}
	swRun(t, ctx, pool, ddp, bgm)

	assert.Equal(t, 0, etCountTitles(t, ctx, pool, swAnilistID), "a refused row writes nothing")
	assert.True(t, swSwept(t, ctx, pool, swAnilistID),
		"a refused row must still be stamped or it holds the head of every batch")
}

func TestSweepStampsARowThatProducedNothing(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	swSeedCandidate(t, ctx, pool, swAnilistID, swBgmID, 2, "manual")

	// Neither upstream has anything: dandanplay has no entry for the id, and
	// Bangumi's subject is absent.
	ddp := &swDDP{}
	bgm := &swBGM{}
	swRun(t, ctx, pool, ddp, bgm)

	assert.Equal(t, 0, etCountTitles(t, ctx, pool, swAnilistID), "nothing to write")
	assert.True(t, swSwept(t, ctx, pool, swAnilistID),
		"an empty row must still be stamped")
}
