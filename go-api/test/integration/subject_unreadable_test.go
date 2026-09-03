//go:build integration

// subject_unreadable_test.go — MarkBangumiSubjectUnreadable against a real
// Postgres, and the four producer queries that have to stop seeing a row
// once it has been marked.
//
// The statement under test is three lines of SQL, and each line is load
// bearing for a different reason.  None of them can be shown to hold from a
// unit test, because all three are properties of the statement rather than of
// the Go around it — the worker passes two integers and reads a row count.
//
//	GREATEST(bangumi_version, 3)   a ratchet, because the statement is reached
//	                               from two directions and one of them arrives
//	                               already terminal
//	bgm_id = <the id we probed>    a pin, because the verdict is about one
//	                               subject and a rebind must not inherit it
//	bangumi_subject_unreadable_at  the part bangumi_version cannot carry
//
// The last subtest is the one that matters most, and it asserts the PURPOSE
// rather than the mechanism: after the mark, the row must be invisible to
// every producer in the enrichment pipeline.  That is the whole point of the
// change — a row upstream will not serve us has to stop being counted as
// outstanding work — and it is exactly the kind of property that regresses
// silently, because the failure mode is a button in the admin surface that
// enqueues jobs which cannot finish.  Version 1 was already such a state; a
// future edit that moved the terminal version, or widened a producer's
// filter, would recreate it with no test failing anywhere else.
//
// Hermeticity.  Everything runs inside one transaction rolled back in
// t.Cleanup, so nothing seeded here survives the test.  The producer queries
// are catalogue-wide, so their assertions are written as "must not contain
// this fixture's id" rather than "must be empty" — a stronger claim would
// only be true on an empty database and would fail for the wrong reason on a
// developer's.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// Fixture ids, held far above anything the catalogue contains, in both id
// spaces.  Named for the state each row is seeded in, since that state is
// what every subtest is about.
const (
	unreadableStranded = int32(9930011) // version 1, the shape the defect produced
	unreadableTerminal = int32(9930012) // version 3 already; must not move
	unreadablePinned   = int32(9930013) // probed under a different binding
	unreadableRecovers = int32(9930014) // marked, then read successfully

	unreadableSubjStranded = int32(9940011)
	unreadableSubjTerminal = int32(9940012)
	unreadableSubjPinned   = int32(9940013)
	unreadableSubjOther    = int32(9940019) // what the pinned row actually holds
	unreadableSubjRecovers = int32(9940014)
)

// unreadableSeededAt is a timestamp no writer would produce, so a row still
// wearing it was not written to.  A sentinel rather than a clock reading
// because now() inside a transaction returns the transaction's start time,
// which would be indistinguishable from the seed's.
var unreadableSeededAt = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

func TestMarkBangumiSubjectUnreadable(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	// A collision on the fixture's subject range would make a pin refusal
	// look like a pin working.  Fail with a sentence instead.
	var held int
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT count(*) FROM anime_cache WHERE bgm_id BETWEEN 9940000 AND 9949999`).Scan(&held))
	require.Zero(t, held, "fixture subject range must be unheld before seeding")

	seed := func(anilistID, bgmID, version int32) {
		t.Helper()
		_, err := tx.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, title_native, bgm_id, bangumi_version, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $5)`,
			anilistID, "fixture", bgmID, version, unreadableSeededAt)
		require.NoError(t, err, "seed %d", anilistID)
	}
	seed(unreadableStranded, unreadableSubjStranded, 1)
	seed(unreadableTerminal, unreadableSubjTerminal, 3)
	seed(unreadablePinned, unreadableSubjOther, 1)
	seed(unreadableRecovers, unreadableSubjRecovers, 1)

	q := dbgen.New(tx)

	type rowState struct {
		version    int32
		unreadable *time.Time
		updatedAt  time.Time
		bgmID      *int32
	}
	read := func(anilistID int32) rowState {
		t.Helper()
		var s rowState
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT bangumi_version, bangumi_subject_unreadable_at, updated_at, bgm_id
			FROM anime_cache WHERE anilist_id = $1`, anilistID).
			Scan(&s.version, &s.unreadable, &s.updatedAt, &s.bgmID))
		return s
	}

	t.Run("a stranded version-1 row is promoted to terminal and stamped", func(t *testing.T) {
		before := read(unreadableStranded)
		require.Equal(t, int32(1), before.version)
		require.Nil(t, before.unreadable, "seeded rows start unstamped")

		n, err := q.MarkBangumiSubjectUnreadable(ctx, unreadableStranded, unreadableSubjStranded)
		require.NoError(t, err)
		assert.EqualValues(t, 1, n, "the row the worker probed must be the row it writes")

		after := read(unreadableStranded)
		assert.Equal(t, int32(3), after.version, "version 1 is the unreachable state; the mark exists to leave it")
		assert.NotNil(t, after.unreadable, "the stamp is the part bangumi_version cannot carry")
		assert.False(t, unreadableSeededAt.Equal(after.updatedAt), "updated_at must move off the sentinel")

		require.NotNil(t, after.bgmID)
		assert.Equal(t, unreadableSubjStranded, *after.bgmID,
			"the binding is correct, merely unreadable — clearing it would discard work a token would make valuable and hand the subject back to the id-map sweep")
	})

	t.Run("an already-terminal row is not moved by the ratchet", func(t *testing.T) {
		n, err := q.MarkBangumiSubjectUnreadable(ctx, unreadableTerminal, unreadableSubjTerminal)
		require.NoError(t, err)
		assert.EqualValues(t, 1, n)

		after := read(unreadableTerminal)
		assert.Equal(t, int32(3), after.version,
			"GREATEST, not a bare assignment: this statement is also reached from an id-map-sweep chain on a legacy version-3 row, and a bare assignment is how 750 rows were pulled from 3 back to 2 in one pass")
		assert.NotNil(t, after.unreadable, "terminal already, but the reason still has to be recorded")
	})

	t.Run("a moved binding refuses the verdict and touches nothing", func(t *testing.T) {
		before := read(unreadablePinned)

		// The worker probed unreadableSubjPinned; the row holds a different
		// subject, which is what a rebind between fetch and write looks like.
		n, err := q.MarkBangumiSubjectUnreadable(ctx, unreadablePinned, unreadableSubjPinned)
		require.NoError(t, err, "a refusal is a zero-row result, not an error")
		assert.EqualValues(t, 0, n, "the worker reports this rather than mistaking it for a write")

		after := read(unreadablePinned)
		assert.Equal(t, before.version, after.version, "the new binding deserves its own probe, not the old one's verdict")
		assert.Nil(t, after.unreadable)
		// Compared as an instant, not as a struct: pgx hands timestamptz back
		// in the process's local zone, so a field-wise Equal fails on the
		// offset alone and would report a write that never happened.
		assert.True(t, unreadableSeededAt.Equal(after.updatedAt),
			"sentinel intact — the statement wrote nothing at all")
	})

	t.Run("a subject that becomes readable loses the stamp", func(t *testing.T) {
		n, err := q.MarkBangumiSubjectUnreadable(ctx, unreadableRecovers, unreadableSubjRecovers)
		require.NoError(t, err)
		require.EqualValues(t, 1, n)
		require.NotNil(t, read(unreadableRecovers).unreadable, "precondition: stamped")

		score := 7.5
		votes := int32(200)
		cn := "测试"
		require.NoError(t, q.UpdateBangumiV2(ctx, unreadableRecovers, &score, &votes, &cn))

		after := read(unreadableRecovers)
		assert.Nil(t, after.unreadable,
			"a successful subject read is the only evidence that retires a not-found observation; a marker with no path back to NULL eventually lies")
		assert.Equal(t, int32(2), after.version, "V2 completing is still what V2 completing has always been")
	})

	// ---------------------------------------------------------------------
	// The payoff.  Every producer that could hand this row back to the queue
	// must now step over it.
	// ---------------------------------------------------------------------
	t.Run("the marked row is invisible to every enrichment producer", func(t *testing.T) {
		marked := read(unreadableStranded)
		require.Equal(t, int32(3), marked.version, "precondition: the first subtest ran")

		reEnrichV0, err := q.ListAnimeForReEnrichByVersion(ctx, 0)
		require.NoError(t, err)
		assert.NotContains(t, reEnrichIDs(reEnrichV0), unreadableStranded, "re-enrich v0")

		reEnrichV1, err := q.ListAnimeForReEnrichByVersion(ctx, 1)
		require.NoError(t, err)
		assert.NotContains(t, reEnrichIDs(reEnrichV1), unreadableStranded,
			"the Re-enrich v1 button is what re-enqueued the job that could not finish; after the mark it must have nothing to say about this row")

		reEnrichV2, err := q.ListAnimeForReEnrichByVersion(ctx, 2)
		require.NoError(t, err)
		assert.NotContains(t, reEnrichIDs(reEnrichV2), unreadableStranded, "re-enrich v2")

		healCn, err := q.ListHealCnCandidates(ctx)
		require.NoError(t, err)
		healIDs := make([]int32, 0, len(healCn))
		for _, r := range healCn {
			healIDs = append(healIDs, r.AnilistID)
		}
		assert.NotContains(t, healIDs, unreadableStranded,
			"terminal must not mean 'moved to the other button' — heal-CN takes version 2, and landing there would re-enqueue V3 jobs against the same unreadable subject")

		// The orphan scan is paginated; ask for the whole table.
		var total int64
		require.NoError(t, tx.QueryRow(ctx, `SELECT count(*) FROM anime_cache`).Scan(&total))
		orphans, err := q.ListUnenrichedAnilistIDs(ctx, int32(total), 0)
		require.NoError(t, err)
		assert.NotContains(t, orphans, unreadableStranded, "orphan scan")
	})
}

// reEnrichIDs flattens the re-enrich batch reader's rows to the ids the
// assertions name.
func reEnrichIDs(rows []dbgen.ListAnimeForReEnrichByVersionRow) []int32 {
	ids := make([]int32, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.AnilistID)
	}
	return ids
}
