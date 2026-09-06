//go:build integration

// episode_titles_bangumi_retract_test.go — what the Bangumi branch of the
// sweep withdraws, and what it refuses to withdraw.
//
// The dandanplay branch has retracted since it was written; the Bangumi branch
// only ever upserted, so a list that shrank left its old tail in place under
// the fresh rows.  Wiring the withdrawal in is the easy half.  The half that
// needs pinning against a real database is the guard: Bangumi's list is
// routinely INCOMPLETE rather than shorter — measured 2026-09-06, 1,219 of the
// 6,041 anime holding Bangumi rows already hold fewer than their own season's
// episode count, and 282 have holes in the middle — so "the fetch did not
// mention it" cannot mean "delete it".
//
// Each test below is one row of that decision, end to end through the exported
// Work(), because the decision is made of a plan (a pure function, tested in
// internal/queue) AND two SQL statements whose scoping is the other half of the
// answer.  A test of either alone would pass while the pair deleted the wrong
// rows.
package integration

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// The anilist_id block this file owns.
const (
	retAnilistID = 700301
	retBgmID     = 9401
)

// retSeedCandidate is swSeedCandidate with a nullable episode count: the
// "AniList has no number for this entry" case is one of the answers under
// test, and it is the whole population the episodes_bgm worker writes.
func retSeedCandidate(t *testing.T, ctx context.Context, pool *pgxpool.Pool,
	anilistID, bgmID int32, episodes *int32,
) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (
			anilist_id, title_romaji, title_native, bgm_id, status, episodes,
			bgm_match_source, episode_titles_at
		) VALUES ($1, 'retract fixture', 'リトラクト', $2, 'RELEASING', $3, 'manual', NULL)`,
		anilistID, bgmID, episodes,
	)
	require.NoError(t, err, "seed retraction candidate %d", anilistID)
}

// retSeedBangumiRows writes episodes lo..hi as rows this source already holds,
// the state a previous pass would have left behind.
func retSeedBangumiRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool,
	anilistID int32, lo, hi int32, prefix string,
) {
	t.Helper()
	src := "bangumi"
	for n := lo; n <= hi; n++ {
		name := prefix + string(rune('0'+n%10))
		etSeedTitle(t, ctx, pool, anilistID, n, nil, nil, &name, &src)
	}
}

// retBGMEpisodes builds a Bangumi response listing main episodes lo..hi.
func retBGMEpisodes(lo, hi int, prefix string) *bangumi.EpisodesResponse {
	r := &bangumi.EpisodesResponse{}
	for n := lo; n <= hi; n++ {
		r.Eps = append(r.Eps, bangumi.Episode{
			Sort: float64(n), Type: 0, Name: prefix + string(rune('0'+n%10)),
		})
	}
	return r
}

func retI32(v int32) *int32 { return &v }

// ---------------------------------------------------------------------------
// What is withdrawn
// ---------------------------------------------------------------------------

// A tail past the season's episode count cannot belong to this entry whatever
// upstream is doing today: the grid renders 1..episodes, so those rows are
// invisible, and the writer will not produce them again.
//
// This is the population that took a hand-written DELETE in September 2026 —
// 21,001 rows across 960 anime — because no writer could reach it.
func TestBangumiSweepWithdrawsTheTailPastTheSeason(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	retSeedCandidate(t, ctx, pool, retAnilistID, retBgmID, retI32(3))
	retSeedBangumiRows(t, ctx, pool, retAnilistID, 1, 6, "stale-ep")

	ddp := &swDDP{} // no entry for that id — routes to the Bangumi branch
	bgm := &swBGM{
		subject: &bangumi.Subject{ID: retBgmID, Name: "リトラクト"},
		eps:     retBGMEpisodes(1, 3, "fresh-ep"),
	}
	swRun(t, ctx, pool, ddp, bgm)

	assert.Equal(t, 3, etCountTitles(t, ctx, pool, retAnilistID),
		"the three rows past the season must be gone, not merely emptied")

	for _, ep := range []int32{4, 5, 6} {
		assert.False(t, etRead(t, ctx, pool, retAnilistID, ep).present,
			"episode %d is past the season and must not survive the pass", ep)
	}

	kept := etRead(t, ctx, pool, retAnilistID, 1)
	require.True(t, kept.present, "the season's own episodes must survive")
	etAssertField(t, "ep1 name", kept.name, kept.nameSource, "fresh-ep1", "bangumi")

	assert.True(t, swSwept(t, ctx, pool, retAnilistID), "the row must still be stamped")
}

// The withdrawal is scoped to one source, and the row is only removed once
// nothing is left standing in it.  A row whose other column another upstream
// filled must survive with that column intact.
//
// Asserting the surviving row rather than just the count is the point: a
// retraction that deleted outright would pass a count-only assertion on the
// rows it was allowed to take and silently take this one with them.
func TestBangumiSweepWithdrawalSparesAnotherSourcesField(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	retSeedCandidate(t, ctx, pool, retAnilistID, retBgmID, retI32(2))
	retSeedBangumiRows(t, ctx, pool, retAnilistID, 1, 2, "stale-ep")

	// Episode 5 is past the season and holds one field from each source.
	bgmCn, bgmSrc := "撤回中文", "bangumi"
	ddpName, ddpSrc := "ddp-ep5", "ddp"
	etSeedTitle(t, ctx, pool, retAnilistID, 5, &bgmCn, &bgmSrc, &ddpName, &ddpSrc)

	ddp := &swDDP{}
	bgm := &swBGM{
		subject: &bangumi.Subject{ID: retBgmID, Name: "リトラクト"},
		eps:     retBGMEpisodes(1, 2, "fresh-ep"),
	}
	swRun(t, ctx, pool, ddp, bgm)

	got := etRead(t, ctx, pool, retAnilistID, 5)
	require.True(t, got.present,
		"a row still holding another source's value must not be deleted")
	etAssertField(t, "ep5 name_cn", got.nameCn, got.nameCnSource, "", "")
	etAssertField(t, "ep5 name", got.name, got.nameSource, "ddp-ep5", "ddp")
}

// ---------------------------------------------------------------------------
// What is refused — the guard
// ---------------------------------------------------------------------------

// ★ The failure the guard exists to prevent.
//
// Bangumi answers six of twelve episodes — a subject mid-edit, a degraded
// upstream, or simply a sparse entry, and the three are the same value here.
// cardinality(kept) > 0, the guard the retraction query already carries, sees
// a non-empty list and lets it through; only the season's window can tell that
// episodes 7-12 are inside the entry and therefore not disprovable.
//
// Getting this wrong deletes rows nobody can tell were ever there: they are
// single-source, so the clear empties them and the delete removes them.
func TestBangumiSweepRefusesToWithdrawInsideTheSeason(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	retSeedCandidate(t, ctx, pool, retAnilistID, retBgmID, retI32(12))
	retSeedBangumiRows(t, ctx, pool, retAnilistID, 1, 12, "stale-ep")

	ddp := &swDDP{}
	bgm := &swBGM{
		subject: &bangumi.Subject{ID: retBgmID, Name: "リトラクト"},
		eps:     retBGMEpisodes(1, 6, "fresh-ep"),
	}
	swRun(t, ctx, pool, ddp, bgm)

	assert.Equal(t, 12, etCountTitles(t, ctx, pool, retAnilistID),
		"a half-answered fetch must cost nothing")

	unanswered := etRead(t, ctx, pool, retAnilistID, 12)
	require.True(t, unanswered.present, "episode 12 must survive a fetch that stopped at 6")
	etAssertField(t, "ep12 name", unanswered.name, unanswered.nameSource, "stale-ep2", "bangumi")

	answered := etRead(t, ctx, pool, retAnilistID, 6)
	require.True(t, answered.present)
	etAssertField(t, "ep6 name", answered.name, answered.nameSource, "fresh-ep6", "bangumi")
}

// ★ With no episode count on the entry there is no window, so there is no
// question the withdrawal can answer — and it answers none.
//
// This is not a corner case: it is the entire population the episodes_bgm
// worker writes, which selects `WHERE ac.episodes IS NULL` precisely because
// deriving that number is its job.  A withdrawal that treated a missing count
// as zero would take every row those passes have ever written.
func TestBangumiSweepWithdrawsNothingWithoutASeasonLength(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	retSeedCandidate(t, ctx, pool, retAnilistID, retBgmID, nil)
	retSeedBangumiRows(t, ctx, pool, retAnilistID, 1, 6, "stale-ep")

	ddp := &swDDP{}
	bgm := &swBGM{
		subject: &bangumi.Subject{ID: retBgmID, Name: "リトラクト"},
		eps:     retBGMEpisodes(1, 3, "fresh-ep"),
	}
	swRun(t, ctx, pool, ddp, bgm)

	assert.Equal(t, 6, etCountTitles(t, ctx, pool, retAnilistID),
		"an unknown season length must protect every row this source holds")

	survivor := etRead(t, ctx, pool, retAnilistID, 6)
	require.True(t, survivor.present)
	etAssertField(t, "ep6 name", survivor.name, survivor.nameSource, "stale-ep6", "bangumi")
}

// An episode Bangumi lists but has not named yet is still an episode Bangumi
// lists.  The writer skips it — the row would be two NULLs — but the kept-set
// must carry it, or every unaired episode of an airing show would look like a
// row upstream had dropped.
//
// The sweep runs on airing shows, so this is the ordinary case, not the exotic
// one.
func TestBangumiSweepKeepsAnEpisodeListedWithoutAName(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	retSeedCandidate(t, ctx, pool, retAnilistID, retBgmID, retI32(4))
	retSeedBangumiRows(t, ctx, pool, retAnilistID, 1, 4, "stale-ep")

	ddp := &swDDP{}
	bgm := &swBGM{
		subject: &bangumi.Subject{ID: retBgmID, Name: "リトラクト"},
		eps: &bangumi.EpisodesResponse{Eps: []bangumi.Episode{
			{Sort: 1, Type: 0, Name: "fresh-ep1"},
			{Sort: 2, Type: 0, Name: "fresh-ep2"},
			{Sort: 3, Type: 0}, // aired, not yet titled
			{Sort: 4, Type: 0}, // not aired
		}},
	}
	swRun(t, ctx, pool, ddp, bgm)

	assert.Equal(t, 4, etCountTitles(t, ctx, pool, retAnilistID),
		"an unnamed episode is not a withdrawn episode")

	untitled := etRead(t, ctx, pool, retAnilistID, 3)
	require.True(t, untitled.present, "episode 3 must not be taken for a row upstream dropped")
	etAssertField(t, "ep3 name", untitled.name, untitled.nameSource, "stale-ep3", "bangumi")
}

// ★ Both verdicts on one anime, which is the only shape that proves the two
// are reached independently.
//
// Every case above exercises one verdict at a time, and one verdict at a time
// is not enough: with no tail to take, the withdrawal returns before it issues
// a statement at all, so a version that handed the retraction the raw fetch
// instead of the protected set — deleting every row inside the season the
// fetch did not happen to mention — passes all of them.  Found by mutation on
// 2026-09-06; this is the assertion that kills it.
func TestBangumiSweepTakesTheTailAndSparesTheGapInOnePass(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	retSeedCandidate(t, ctx, pool, retAnilistID, retBgmID, retI32(6))
	retSeedBangumiRows(t, ctx, pool, retAnilistID, 1, 6, "stale-ep")
	retSeedBangumiRows(t, ctx, pool, retAnilistID, 20, 20, "tail-ep")

	// A short answer: the season is six episodes and Bangumi named three.
	ddp := &swDDP{}
	bgm := &swBGM{
		subject: &bangumi.Subject{ID: retBgmID, Name: "リトラクト"},
		eps:     retBGMEpisodes(1, 3, "fresh-ep"),
	}
	swRun(t, ctx, pool, ddp, bgm)

	assert.Equal(t, 6, etCountTitles(t, ctx, pool, retAnilistID),
		"the tail goes and the six in-season rows stay")

	assert.False(t, etRead(t, ctx, pool, retAnilistID, 20).present,
		"episode 20 is past a six-episode season and must go")

	spared := etRead(t, ctx, pool, retAnilistID, 6)
	require.True(t, spared.present,
		"episode 6 is inside the season and the fetch's silence is not evidence against it")
	etAssertField(t, "ep6 name", spared.name, spared.nameSource, "stale-ep6", "bangumi")

	refreshed := etRead(t, ctx, pool, retAnilistID, 3)
	require.True(t, refreshed.present)
	etAssertField(t, "ep3 name", refreshed.name, refreshed.nameSource, "fresh-ep3", "bangumi")
}
