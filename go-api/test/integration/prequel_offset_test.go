//go:build integration

// prequel_offset_test.go — GetAbsoluteEpisodeOffset against a real Postgres.
//
// The query is a recursive CTE, which is the shape that most reliably looks
// correct while being wrong. Every case below is a property of the walk that
// no amount of reading proves:
//
//   - the anchor's OWN episodes must not be counted (the offset is what
//     precedes it, and an off-by-one-season here silently renumbers a whole
//     library),
//   - a chain that ends because an ancestor is not cached must report
//     unknown, not 0 — anime_cache holds what has been fetched, so this is
//     the ordinary case rather than the exotic one,
//   - a TV ancestor with a NULL episode count must report unknown, because
//     coalesce(...,0) there produces a plausible wrong number instead of no
//     number, and airing rows routinely have NULL,
//   - a cycle must terminate.
//
// The bug that motivated all of it: a user's only file was the finale of a
// 10-episode second season, numbered 38 by a group that counts continuously
// across seasons. The display layer inferred the shift as `lowest - 1` = 37
// and rendered it in slot 1, and the watch push sent 38 into a range check
// that rejects anything past 10 — so that season's progress had never synced
// at all. Both wanted this one number: 28.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

func TestAbsoluteEpisodeOffset(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)

	// A pointer so a case can express `episodes` IS NULL, which is the whole
	// subject of two of the cases below.
	ep := func(n int) *int { return &n }

	seed := func(anilistID int, format string, episodes *int) {
		t.Helper()
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, format, episodes)
			VALUES ($1, $2, $3)`,
			anilistID, format, episodes,
		)
		require.NoError(t, err, "seed anime %d", anilistID)
	}

	// `anime_id` carries the FK to anime_cache; `anilist_id` — the thing the
	// edge POINTS AT — does not. That asymmetry is what lets a season name a
	// prequel this cache has never fetched, which is the ordinary case at 76%
	// relation coverage and one of the cases below.
	prequel := func(animeID, prequelID int) {
		t.Helper()
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_relations (anime_id, anilist_id, relation_type)
			VALUES ($1, $2, 'PREQUEL')`,
			animeID, prequelID,
		)
		require.NoError(t, err, "seed prequel %d <- %d", prequelID, animeID)
	}

	// The real franchise, with the real numbers. 154587 <- 182255 <- 209939.
	// Verified against production before this test was written: the same walk
	// returns 0 / 28 / 38 there.
	seed(154587, "TV", ep(28)) // season one
	seed(182255, "TV", ep(10)) // season two — the reported case
	seed(209939, "TV", nil)    // season three, not yet aired
	prequel(182255, 154587)
	prequel(209939, 182255)

	// A season with no prequel edge at all.
	seed(300001, "TV", ep(12))

	// A season naming a prequel that was never fetched into the cache.
	seed(300002, "TV", ep(12))
	prequel(300002, 999999)

	// A TV ancestor that exists but has no episode count yet (airing).
	seed(300010, "TV", nil)
	seed(300011, "TV", ep(12))
	prequel(300011, 300010)

	// A movie sits in the chain: walked through, contributes nothing, and its
	// own NULL episode count is not a gap.
	seed(300020, "TV", ep(24))
	seed(300021, "MOVIE", nil)
	seed(300022, "TV", ep(12))
	prequel(300021, 300020)
	prequel(300022, 300021)

	// Two prequels on one season: ambiguity, not addition.
	seed(300040, "TV", ep(12))
	seed(300041, "TV", ep(12))
	seed(300042, "TV", ep(12))
	prequel(300042, 300040)
	prequel(300042, 300041)

	// A two-hop cycle — nothing in the schema forbids one.
	seed(300030, "TV", ep(12))
	seed(300031, "TV", ep(12))
	prequel(300030, 300031)
	prequel(300031, 300030)

	q := dbgen.New(pool)

	cases := []struct {
		name      string
		anilistID int32
		wantKnown bool
		wantOff   int32
		why       string
	}{
		{
			name: "season two of a real franchise", anilistID: 182255,
			wantKnown: true, wantOff: 28,
			why: "28 episodes of season one precede it — this is the number that turns a file named 38 into episode 10",
		},
		{
			name: "the anchor's own episodes are never counted", anilistID: 154587,
			wantKnown: true, wantOff: 0,
			why: "season one has nothing before it; counting its own 28 would push every later season a season too far",
		},
		{
			name: "a season whose own count is unknown still has a known offset", anilistID: 209939,
			wantKnown: true, wantOff: 38,
			why: "28 + 10 precede it; the anchor's own NULL episodes says nothing about what came before",
		},
		{
			name: "no prequel is zero, and zero is KNOWN", anilistID: 300001,
			wantKnown: true, wantOff: 0,
			why: "this is the case a nullable-int return would have made indistinguishable from unknown",
		},
		{
			name: "prequel named but not cached is unknown", anilistID: 300002,
			wantKnown: false,
			why: "anime_cache holds what was fetched; a chain that runs off the end of it has not been accounted for",
		},
		{
			name: "TV ancestor with NULL episodes is unknown", anilistID: 300011,
			wantKnown: false,
			why: "coalescing that to 0 would return 0 — a plausible wrong offset, which is worse than none",
		},
		{
			name: "a movie in the chain is walked through, not counted", anilistID: 300022,
			wantKnown: true, wantOff: 24,
			why: "a film consumes no episode numbers, so its own NULL count is not a gap and its position is not a wall",
		},
		{
			name: "two prequels is ambiguous, not additive", anilistID: 300042,
			wantKnown: false,
			why: "summing both would return 24 with full confidence and be a whole season wrong",
		},
		{
			name: "a cycle terminates", anilistID: 300030,
			wantKnown: false,
			why: "the depth bound stops it; reporting unknown is correct because the chain never resolved",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			row, err := q.GetAbsoluteEpisodeOffset(ctx, c.anilistID)
			require.NoError(t, err)
			require.NotNil(t, row.Known, "known must never be SQL NULL — a caller cannot branch on nil")
			assert.Equal(t, c.wantKnown, *row.Known, c.why)
			if c.wantKnown {
				assert.Equal(t, c.wantOff, row.AbsoluteOffset, c.why)
			}
		})
	}

	t.Run("an anilist id absent from the cache returns no row", func(t *testing.T) {
		// Not an error condition to hide: the caller has to treat "no row"
		// exactly like known=false, and a test that never exercised it would
		// let a nil-deref ship.
		_, err := q.GetAbsoluteEpisodeOffset(ctx, 424242)
		require.Error(t, err, "an uncached anchor has no chain to walk")
	})
}
