//go:build integration

// id_map_bind_test.go — ListIdMapBindCandidates and BindBgmIdsFromIdMap
// against a real Postgres, on a fixture shaped like the three cases they
// exist to tell apart.
//
// Both queries are pure SQL: the Go around them chooses nothing, so this is
// the only place their guards can be shown to still hold.  And a guard that
// quietly stopped holding does not surface as an error.  It surfaces as
// another show's Chinese title and synopsis on a public anime page, for as
// long as nobody happens to look.
//
// Three properties need a real database rather than a unit test, because
// each of them is a property of the executor rather than of our code:
//
//  1. `claims = 1` defends against a rule of statement execution — a
//     data-modifying statement cannot see its own writes.  Two unbound rows
//     mapping to the same subject would BOTH pass the NOT EXISTS check
//     inside one statement and both be bound.  Nothing about the SQL text
//     looks wrong when this happens; only running it shows it.
//
//  2. Nothing downstream would catch that double binding.  anime_cache.bgm_id
//     carries no unique index (it cannot yet — the catalogue already holds
//     subjects bound to more than one row), so the guard is not a
//     belt-and-braces on top of a constraint.  It is the constraint.
//
//  3. The LIMIT sits inside the `eligible` CTE, i.e. AFTER both guards, and
//     that placement is load-bearing rather than cosmetic.  Refusals are
//     permanent: a twice-claimed subject stays twice-claimed until a human
//     adjudicates it.  So if the LIMIT ever moved above the guards, every
//     batch would re-draw the same refused prefix of the catalogue (the
//     ORDER BY is stable), bind fewer rows than it was asked for — possibly
//     none — and the sweep would keep running without making progress.
//
// A fourth property is not about the executor but about a queue outside the
// database: this statement is the exit from the admin review queue for every
// row V1 parked as 'needs-review' before the map had an answer.  Clearing the
// wrong flag there is unrecoverable by hand at catalogue scale in one
// direction, and in the other it leaves settled rows queued for a review that
// will never have anything left to decide.
//
// Hermeticity.  BindBgmIdsFromIdMap is catalogue-wide: it takes no id, and a
// generous LIMIT would happily bind whatever else the database holds, which
// would make the batch-size assertions below meaningless.  Two things scope
// it to this fixture:
//
//   - The whole test runs inside one transaction that is rolled back in
//     t.Cleanup, so nothing it writes — including the neutralisation below —
//     outlives it.
//   - Inside that transaction bgm_id_map is emptied before the fixture is
//     seeded.  The JOIN to that table is the only funnel into either query,
//     so a catalogue-wide statement then operates on exactly these eight
//     rows and the assertions can name the full result set.
//
// The one path that still reaches outside the fixture is the NOT EXISTS
// sub-select, which scans all of anime_cache for a row already holding the
// subject.  A precondition check asserts the fixture's bgm_id range is unheld
// before seeding, so a collision fails with a sentence rather than as an
// inexplicable refusal.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// Fixture ids, in both id spaces, held far above anything either the
// catalogue or the vendored map contains.  The AniList ids are ordered so
// that every REFUSED row sorts BEFORE every bindable one: that ordering is
// what makes the batch-size subtest able to tell "the LIMIT counts bound
// rows" apart from "the LIMIT counts candidates", since the two answers
// differ only when refusals come first.
const (
	idmapClaimantA = int32(9910011) // maps to the same subject as B
	idmapClaimantB = int32(9910012) // maps to the same subject as A
	idmapLoser     = int32(9910021) // wants a subject the holder already has
	idmapHolder    = int32(9910022) // bound already; the incumbent
	idmapUnmapped  = int32(9910031) // no bgm_id_map row at all
	idmapFreeLow   = int32(9910041)
	idmapFreeMid   = int32(9910042)
	idmapFreeHigh  = int32(9910043)
	idmapReviewed  = int32(9910051) // parked by V1 as 'needs-review'
	idmapCorrected = int32(9910052) // carries a human's 'manually-corrected'

	idmapSubjectShared    = int32(9920011) // claimed by A and B
	idmapSubjectHeld      = int32(9920021) // held by idmapHolder
	idmapSubjectHolder    = int32(9920099) // what the map says about the holder
	idmapSubjectLow       = int32(9920041)
	idmapSubjectMid       = int32(9920042)
	idmapSubjectHigh      = int32(9920043)
	idmapSubjectReviewed  = int32(9920051)
	idmapSubjectCorrected = int32(9920052)
)

// idmapSeededAt is a timestamp no writer would ever produce, so it doubles as
// a touch detector: `updated_at = now()` in the UPDATE moves a row off it, and
// a row still wearing it was not written to.  A sentinel rather than a
// before/after clock reading because now() inside a transaction is the
// transaction's own start time — it would be identical to the seed's.
var idmapSeededAt = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

func TestIdMapBind(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	// The rollback IS the cleanup: every row seeded below and every row the
	// bind writes disappears with it, as does the emptied bgm_id_map.
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	_, err = tx.Exec(ctx, `DELETE FROM bgm_id_map`)
	require.NoError(t, err, "neutralise the vendored map for the duration of the transaction")

	var held int
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT count(*) FROM anime_cache WHERE bgm_id BETWEEN 9920000 AND 9929999`).Scan(&held))
	require.Zero(t, held,
		"a pre-existing row holding a fixture subject would turn every bindable row into a refusal, which reads as a query bug rather than as a dirty database")

	bgm := func(id int32) *int32 { return &id }
	src := func(s string) *string { return &s }

	// admin_flag is constrained to 'needs-review' / 'manually-corrected' /
	// NULL by anime_cache_admin_flag_chk, so those are the only three states
	// this fixture can express — and all three appear below.
	seed := func(anilistID int32, romaji, native string, year int32, bgmID *int32, matchSource, adminFlag *string) {
		t.Helper()
		_, err := tx.Exec(ctx, `
			INSERT INTO anime_cache
			    (anilist_id, title_romaji, title_native, season_year,
			     bgm_id, bgm_match_source, admin_flag, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			anilistID, romaji, native, year, bgmID, matchSource, adminFlag, idmapSeededAt)
		require.NoError(t, err, "seed anime_cache %d", anilistID)
	}

	mapEntry := func(anilistID, bgmID int32) {
		t.Helper()
		_, err := tx.Exec(ctx, `
			INSERT INTO bgm_id_map (anilist_id, bgm_id, source)
			VALUES ($1, $2, 'mal')`, anilistID, bgmID)
		require.NoError(t, err, "seed bgm_id_map %d -> %d", anilistID, bgmID)
	}

	// Two unbound rows the map sends to one subject.  This is the shape that
	// actually occurs — a show and its own prequel special can share a
	// Bangumi subject — and the reason neither may be bound is that nothing
	// in the data says which of the two the subject belongs to.
	seed(idmapClaimantA, "Idmap Claimant A", "アイドマップ・クレイマントA", 2021, nil, nil, nil)
	seed(idmapClaimantB, "Idmap Claimant B", "アイドマップ・クレイマントB", 2021, nil, nil, nil)
	mapEntry(idmapClaimantA, idmapSubjectShared)
	mapEntry(idmapClaimantB, idmapSubjectShared)

	// An unbound row whose map answer is already worn by somebody else.  The
	// holder is bound and therefore not a candidate at all; its own map entry
	// deliberately names a DIFFERENT subject, so the fixture also says what
	// happens to a bound row the map disagrees with: nothing.
	seed(idmapLoser, "Idmap Loser", "アイドマップ・ルーザー", 2022, nil, nil, nil)
	seed(idmapHolder, "Idmap Holder", "アイドマップ・ホルダー", 2022, bgm(idmapSubjectHeld), src("manual"), nil)
	mapEntry(idmapLoser, idmapSubjectHeld)
	mapEntry(idmapHolder, idmapSubjectHolder)

	// A row the map has never heard of.  It is the majority shape in the
	// catalogue, and the query must reach it neither as a candidate nor as a
	// write.
	seed(idmapUnmapped, "Idmap Unmapped", "アイドマップ・アンマップド", 2023, nil, nil, nil)

	// Three rows nobody contests.  Three rather than one so a LIMIT smaller
	// than the bindable set can be shown to cap the batch.
	seed(idmapFreeLow, "Idmap Free Low", "アイドマップ・フリー1", 2024, nil, nil, nil)
	seed(idmapFreeMid, "Idmap Free Mid", "アイドマップ・フリー2", 2024, nil, nil, nil)
	seed(idmapFreeHigh, "Idmap Free High", "アイドマップ・フリー3", 2024, nil, nil, nil)
	mapEntry(idmapFreeLow, idmapSubjectLow)
	mapEntry(idmapFreeMid, idmapSubjectMid)
	mapEntry(idmapFreeHigh, idmapSubjectHigh)

	// Two bindable rows carrying the two admin_flag states, seeded with ids
	// above the plain bindable three so they fall outside the first batch and
	// the batch-size subtest keeps its exact expectations.
	//
	// The 'needs-review' one wears V1's park shape exactly — no bgm_id, a
	// 'fuzzy_low' label, the flag — because that is the row this clause was
	// written for: V1 could not decide, so it asked a human, and the map
	// arriving afterwards answers the question the human was queued to
	// answer.
	seed(idmapReviewed, "Idmap Reviewed", "アイドマップ・レビュード", 2025, nil, src("fuzzy_low"), src("needs-review"))
	seed(idmapCorrected, "Idmap Corrected", "アイドマップ・コレクテッド", 2025, nil, nil, src("manually-corrected"))
	mapEntry(idmapReviewed, idmapSubjectReviewed)
	mapEntry(idmapCorrected, idmapSubjectCorrected)

	q := dbgen.New(tx)

	// updatedMicro rather than a time.Time so snapshots compare by value:
	// reflect.DeepEqual on time.Time compares the representation (wall clock,
	// monotonic reading, location pointer) rather than the instant.  The
	// column's own resolution is microseconds, so nothing is lost.
	type animeRow struct {
		bgmID        *int32
		matchSource  *string
		adminFlag    *string
		updatedMicro int64
	}
	read := func(t *testing.T, anilistID int32) animeRow {
		t.Helper()
		var r animeRow
		var updated time.Time
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT bgm_id, bgm_match_source, admin_flag, updated_at
			FROM anime_cache WHERE anilist_id = $1`, anilistID).
			Scan(&r.bgmID, &r.matchSource, &r.adminFlag, &updated), "read anime_cache %d", anilistID)
		r.updatedMicro = updated.UnixMicro()
		return r
	}
	untouched := func(t *testing.T, anilistID int32, why string) {
		t.Helper()
		got := read(t, anilistID)
		assert.Equal(t, idmapSeededAt.UnixMicro(), got.updatedMicro, why)
	}

	fixture := []int32{
		idmapClaimantA, idmapClaimantB, idmapLoser, idmapHolder,
		idmapUnmapped, idmapFreeLow, idmapFreeMid, idmapFreeHigh,
		idmapReviewed, idmapCorrected,
	}
	snapshot := func(t *testing.T) []animeRow {
		t.Helper()
		rows := make([]animeRow, 0, len(fixture))
		for _, id := range fixture {
			rows = append(rows, read(t, id))
		}
		return rows
	}

	// The subtests run in order against one shared fixture: the first reads
	// the verdicts before anything is written, the rest walk the same rows
	// through two batches and a third no-op call.
	t.Run("the preview classifies all three cases", func(t *testing.T) {
		got, err := q.ListIdMapBindCandidates(ctx)
		require.NoError(t, err, "ListIdMapBindCandidates")

		// Asserting the WHOLE result set rather than a filtered view is
		// deliberate: the query takes no id, so this doubles as the proof
		// that the emptied bgm_id_map really did scope it to the fixture.
		// A stray row here means the hermeticity argument above has a hole.
		type candidate struct {
			anilistID int32
			bgmID     int32
			verdict   string
		}
		flat := make([]candidate, 0, len(got))
		for _, r := range got {
			flat = append(flat, candidate{r.AnilistID, r.BgmID, r.Verdict})
		}
		assert.Equal(t, []candidate{
			// Ordered by anilist_id, which is the query's own ORDER BY.
			{idmapClaimantA, idmapSubjectShared, "subject-claimed-twice"},
			{idmapClaimantB, idmapSubjectShared, "subject-claimed-twice"},
			{idmapLoser, idmapSubjectHeld, "subject-already-bound"},
			{idmapFreeLow, idmapSubjectLow, "bindable"},
			{idmapFreeMid, idmapSubjectMid, "bindable"},
			{idmapFreeHigh, idmapSubjectHigh, "bindable"},
			{idmapReviewed, idmapSubjectReviewed, "bindable"},
			{idmapCorrected, idmapSubjectCorrected, "bindable"},
		}, flat,
			"the bound holder and the unmapped row are not candidates at all; the other eight each carry the verdict the bind will act on")

		// The refusals are the rows a human has to adjudicate, and the only
		// material they get for it is what this query returns.  A refusal
		// that arrived without its titles or its year would be unreadable —
		// two AniList ids and a subject number say nothing about which show
		// the subject belongs to.
		for _, r := range got {
			if r.AnilistID != idmapClaimantA {
				continue
			}
			require.NotNil(t, r.TitleRomaji)
			require.NotNil(t, r.TitleNative)
			require.NotNil(t, r.SeasonYear)
			assert.Equal(t, "Idmap Claimant A", *r.TitleRomaji)
			assert.Equal(t, "アイドマップ・クレイマントA", *r.TitleNative)
			assert.Equal(t, int32(2021), *r.SeasonYear,
				"the year is how a reviewer separates a show from its own prequel special")
		}
	})

	t.Run("refusals do not consume the batch's limit", func(t *testing.T) {
		bound, err := q.BindBgmIdsFromIdMap(ctx, 2)
		require.NoError(t, err, "BindBgmIdsFromIdMap")

		// Three refusals sort ahead of every bindable row, so a LIMIT applied
		// before the guards would have returned nothing here, and one applied
		// to candidates-then-filtered would have returned fewer than two.
		// ElementsMatch rather than Equal: RETURNING has no ORDER BY, so the
		// row order is the executor's business and asserting it would buy a
		// flake instead of a property.
		assert.ElementsMatch(t, []dbgen.BindBgmIdsFromIdMapRow{
			{AnilistID: idmapFreeLow, BgmID: idmapSubjectLow},
			{AnilistID: idmapFreeMid, BgmID: idmapSubjectMid},
		}, bound,
			"a batch of 2 must be 2 BOUND rows; refusals are permanent, so a limit that counted them would re-draw the same refused prefix forever and the sweep would never finish")

		// ...and the limit is still a cap.  Without this the subtest above
		// would also pass an implementation that ignored `lim` entirely.
		assert.Nil(t, read(t, idmapFreeHigh).bgmID,
			"the third bindable row is beyond a batch of 2 and must wait for the next one")
	})

	t.Run("a bound row records how it was bound", func(t *testing.T) {
		for _, c := range []struct {
			anilistID int32
			subject   int32
		}{
			{idmapFreeLow, idmapSubjectLow},
			{idmapFreeMid, idmapSubjectMid},
		} {
			got := read(t, c.anilistID)
			require.NotNil(t, got.bgmID, "row %d must be bound", c.anilistID)
			assert.Equal(t, c.subject, *got.bgmID, "the map's answer, unaltered")
			require.NotNil(t, got.matchSource, "row %d must be labelled", c.anilistID)
			assert.Equal(t, "id_map", *got.matchSource,
				"the label is what lets a later audit find every binding this sweep made and undo exactly those")
			assert.Greater(t, got.updatedMicro, idmapSeededAt.UnixMicro(),
				"the row was written, so it must not still wear the seed timestamp")
		}
	})

	t.Run("a generous limit does not soften the refusals", func(t *testing.T) {
		bound, err := q.BindBgmIdsFromIdMap(ctx, 10)
		require.NoError(t, err, "BindBgmIdsFromIdMap")

		// A limit larger than the whole candidate set: what is left is the row
		// the previous batch could not fit, plus the two flagged ones.  If
		// either guard were a function of batch size rather than of the data,
		// the three refused rows would come through here too.
		assert.ElementsMatch(t, []dbgen.BindBgmIdsFromIdMapRow{
			{AnilistID: idmapFreeHigh, BgmID: idmapSubjectHigh},
			{AnilistID: idmapReviewed, BgmID: idmapSubjectReviewed},
			{AnilistID: idmapCorrected, BgmID: idmapSubjectCorrected},
		}, bound,
			"the refusals are a property of the catalogue, not of how many rows were asked for")
	})

	t.Run("binding a reviewed row closes its review", func(t *testing.T) {
		got := read(t, idmapReviewed)
		require.NotNil(t, got.bgmID, "the flag is not a refusal — the row binds like any other")
		assert.Equal(t, idmapSubjectReviewed, *got.bgmID)
		assert.Nil(t, got.adminFlag,
			"'needs-review' is a question, and the map answering it IS the answer; leaving the flag parks a settled row in the admin queue for good")
		require.NotNil(t, got.matchSource)
		assert.Equal(t, "id_map", *got.matchSource,
			"the label must describe the binding the row now carries, not the fuzzy guess that was abandoned")
	})

	t.Run("a human's correction is not cleared", func(t *testing.T) {
		got := read(t, idmapCorrected)
		require.NotNil(t, got.bgmID, "this row binds too; only the flag's treatment differs")
		assert.Equal(t, idmapSubjectCorrected, *got.bgmID)
		require.NotNil(t, got.adminFlag,
			"the CASE has exactly one branch that clears, and this value is not it")
		assert.Equal(t, "manually-corrected", *got.adminFlag,
			"that flag records a decision somebody already made rather than a pending request for one; clearing it would silently drop the audit trail for every hand-fixed row the map later touches")
	})

	t.Run("neither claimant of a twice-claimed subject is bound", func(t *testing.T) {
		// The one the guards exist for.  A statement cannot see its own
		// writes, so without `claims = 1` both of these would pass NOT EXISTS
		// in the same pass and both end up holding 9920011 — and with no
		// unique index on bgm_id, nothing beneath would object.  The symptom
		// would surface much later and somewhere else: GetAnimeByBgmID is a
		// :one query, so every subsequent Bangumi write for that subject
		// would land on an arbitrary one of the two.
		assert.Nil(t, read(t, idmapClaimantA).bgmID, "A is one of two claimants and nothing says it is the right one")
		assert.Nil(t, read(t, idmapClaimantB).bgmID, "B is the other; refusing only one of them would be a coin toss, not a decision")
		untouched(t, idmapClaimantA, "a refused row must not be written to at all")
		untouched(t, idmapClaimantB, "a refused row must not be written to at all")
	})

	t.Run("a subject stays with the row that already holds it", func(t *testing.T) {
		assert.Nil(t, read(t, idmapLoser).bgmID,
			"the map's answer is already worn by another row, and the incumbent binding is the older evidence")
		untouched(t, idmapLoser, "a refused row must not be written to at all")

		holder := read(t, idmapHolder)
		require.NotNil(t, holder.bgmID)
		assert.Equal(t, idmapSubjectHeld, *holder.bgmID,
			"the map says this row belongs to a different subject; a bound row is never re-bound, so the disagreement is left alone")
		require.NotNil(t, holder.matchSource)
		assert.Equal(t, "manual", *holder.matchSource,
			"overwriting an existing label with 'id_map' would erase the provenance of a decision a human made")
		untouched(t, idmapHolder, "`bgm_id IS NULL` excludes bound rows from the candidate set entirely")
	})

	t.Run("a row the map has never heard of is never touched", func(t *testing.T) {
		got := read(t, idmapUnmapped)
		assert.Nil(t, got.bgmID, "there is no answer to write")
		assert.Nil(t, got.matchSource, "and therefore nothing to label")
		untouched(t, idmapUnmapped, "the inner JOIN is what keeps the sweep off the rest of the catalogue")
	})

	t.Run("running the bind again binds nothing", func(t *testing.T) {
		before := snapshot(t)
		bound, err := q.BindBgmIdsFromIdMap(ctx, 10)
		require.NoError(t, err, "BindBgmIdsFromIdMap")
		assert.Empty(t, bound,
			"every bindable row now has a bgm_id, and `bgm_id IS NULL` is the whole candidate set — a sweep that re-ran on a schedule must cost nothing")
		assert.Equal(t, before, snapshot(t),
			"no timestamps moved either: an idempotent statement that still rewrote updated_at would churn the rows it claims not to touch")
	})

	t.Run("no subject ends up held twice", func(t *testing.T) {
		// The invariant all of the above serves, asserted directly rather
		// than inferred from the per-row assertions — this is the shape that
		// no index and no downstream query would reject.
		var dupes int
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT count(*) FROM (
			    SELECT bgm_id FROM anime_cache
			    WHERE bgm_id BETWEEN 9920000 AND 9929999
			    GROUP BY bgm_id HAVING count(*) > 1
			) d`).Scan(&dupes))
		assert.Zero(t, dupes, "one bgm.tv subject, at most one anime_cache row")

		var claimed int
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT count(*) FROM anime_cache WHERE bgm_id = $1`, idmapSubjectShared).Scan(&claimed))
		assert.Zero(t, claimed,
			"the contested subject belongs to nobody until a human says whose it is")
	})
}

// TestIdMapBindConcurrentClaim pins the one guard the single-statement tests
// above structurally cannot reach: the `AND a.bgm_id IS NULL` re-check on the
// UPDATE itself.
//
// Inside one statement that clause is dead weight.  The `eligible` CTE already
// selected on `bgm_id IS NULL`, and a statement evaluates its CTEs and its
// UPDATE against one snapshot, so the re-check can only ever agree with the
// CTE.  Deleting it leaves every subtest in TestIdMapBind green — verified by
// mutation, which is the reason this test exists rather than a note saying the
// clause looks important.
//
// It stops being dead weight the moment another writer touches the same row.
// Postgres does not simply skip a row a concurrent transaction has locked: the
// UPDATE blocks, and when that transaction commits the executor re-evaluates
// the WHERE clause against the row's NEW version (EvalPlanQual).  That
// re-evaluation is the only thing standing between this sweep and silently
// overwriting a binding somebody else just wrote — a manual admin correction,
// say — with the map's answer.
//
// The sweep's own queue runs at MaxWorkers 1, so two copies of THIS statement
// cannot race.  That is not the same as the row being safe: anime_cache.bgm_id
// is written by the V1 worker, the admin surface, and the heal CLI, none of
// which coordinate with the sweep.
//
// Why the wait-for-lock step is not optional: without it the bind can finish
// before the rival's UPDATE takes its lock, and then the assertions hold for
// the wrong reason — the row was never contended and the CAS was never
// consulted.  The test would pass with the clause deleted.
func TestIdMapBindConcurrentClaim(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)

	// A committed fixture, not a rolled-back one: two transactions have to see
	// it, which is exactly what the isolation trick in TestIdMapBind rules out.
	// TruncateAll gives the clean slate that keeps a catalogue-wide statement
	// scoped to this one row.
	testutil.TruncateAll(t, ctx, pool)

	const (
		casAnilist      = int32(9930001)
		casMapSubject   = int32(9930099) // what the map would bind
		casRivalSubject = int32(9930088) // what the other writer binds first
	)

	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_romaji, bgm_id, updated_at)
		VALUES ($1, 'Idmap CAS Fixture', NULL, $2)`, casAnilist, idmapSeededAt)
	require.NoError(t, err, "seed anime_cache")
	_, err = pool.Exec(ctx, `
		INSERT INTO bgm_id_map (anilist_id, bgm_id, source) VALUES ($1, $2, 'mal')`,
		casAnilist, casMapSubject)
	require.NoError(t, err, "seed bgm_id_map")
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM bgm_id_map WHERE anilist_id = $1`, casAnilist)
		_, _ = pool.Exec(bg, `DELETE FROM anime_cache WHERE anilist_id = $1`, casAnilist)
	})

	// The rival writer: binds a different subject and holds the row lock.  Any
	// of V1, the admin surface, or the heal CLI can be on this side in
	// production; 'manual' is the label that makes losing the race worst.
	rival, err := pool.Begin(ctx)
	require.NoError(t, err, "begin rival transaction")
	defer func() { _ = rival.Rollback(context.Background()) }()
	_, err = rival.Exec(ctx, `
		UPDATE anime_cache SET bgm_id = $1, bgm_match_source = 'manual'
		WHERE anilist_id = $2`, casRivalSubject, casAnilist)
	require.NoError(t, err, "rival binds the row")

	type outcome struct {
		rows []dbgen.BindBgmIdsFromIdMapRow
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		// A deadline rather than the parent context: if the CAS were removed
		// AND the rival never committed, this would block forever and the test
		// would time out with no explanation.
		bindCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		tx, err := pool.Begin(bindCtx)
		if err != nil {
			done <- outcome{err: err}
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		rows, err := dbgen.New(pool).WithTx(tx).BindBgmIdsFromIdMap(bindCtx, 200)
		if err == nil {
			err = tx.Commit(bindCtx)
		}
		done <- outcome{rows: rows, err: err}
	}()

	requireBlockedOnLock(t, ctx, pool)

	// The rival wins the row.  The bind unblocks into EvalPlanQual.
	require.NoError(t, rival.Commit(ctx), "rival commit")

	var out outcome
	select {
	case out = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the bind never returned after the rival committed")
	}
	require.NoError(t, out.err, "the bind must lose the row quietly, not error")
	assert.Empty(t, out.rows,
		"the row was no longer unbound when the UPDATE reached it, so it must not appear as bound")

	var bgmID *int32
	var source *string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT bgm_id, bgm_match_source FROM anime_cache WHERE anilist_id = $1`,
		casAnilist).Scan(&bgmID, &source))
	require.NotNil(t, bgmID)
	assert.Equal(t, casRivalSubject, *bgmID,
		"the sweep must not overwrite a binding another writer committed first")
	require.NotNil(t, source)
	assert.Equal(t, "manual", *source,
		"losing the row means writing none of its columns, not just none of its bgm_id")
}

// requireBlockedOnLock waits until some backend is stalled on a row lock while
// running the bind, and fails if that never happens.
//
// Matching on the statement text is what makes this specific: pg_stat_activity
// carries the query, and sqlc prefixes every statement with its own
// `-- name: <Query>` comment, so the wait being observed is provably the
// bind's and not some unrelated backend's.
func requireBlockedOnLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT count(*) FROM pg_stat_activity
			WHERE wait_event_type = 'Lock'
			  AND query LIKE '%BindBgmIdsFromIdMap%'`).Scan(&n))
		if n > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the bind never blocked on the rival's row lock; the race this test " +
		"is about did not happen, so a pass here would prove nothing")
}
