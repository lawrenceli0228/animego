//go:build integration

// episode_titles_test.go — the five 0029 episode-title queries against a real
// Postgres.
//
// Migration 0029 moved three rules OUT of Go and INTO the SQL, on the argument
// that "a rule enforced by the query is inherited by a new writer and a rule
// enforced by a helper function is only inherited by a writer who remembers to
// call it".  That trade is only worth making if the SQL is actually right, and
// every one of these rules is expressed as an ON CONFLICT arm, a CASE ladder,
// or a WHERE conjunct — the three shapes that most reliably read as correct
// while being wrong.  A fake DB reports success for all of them.
//
// What each group below pins, and what silently breaks without it:
//
//	A. PRECEDENCE.  manual > ddp > bangumi > absent, scored by position in an
//	   array literal.  The comparison is >= rather than >, and that is the
//	   mechanism by which an airing show's titles get corrected: a source that
//	   could not overwrite its own earlier value would freeze episode 9's
//	   placeholder name forever.  A `>` typo passes every "the good source
//	   wins" test and only fails on the case nobody writes.
//
//	B. PER-FIELD precedence.  One row routinely holds a `name` from Bangumi
//	   beside a `name_cn` from dandanplay, because dandanplay returns ONE
//	   string per episode whose body is Chinese on some rows and Japanese on
//	   others.  Comparing either field against a single row-level source would
//	   overwrite the better value with the worse one.  Each field must be
//	   compared against ITS OWN source column.
//
//	C. EMPTY VALUES.  btrim + NULLIF on the way in, a WHERE that refuses a
//	   call with both fields blank, and DO UPDATE arms that keep the stored
//	   value when the incoming one is NULL.  Roughly a third of this table is
//	   rows whose two payload columns are both NULL, written before 0029 by an
//	   upsert with no COALESCE; new writes must not add to them.
//
//	D. THE BINDING IS PINNED.  The INSERT sources anime_id from anime_cache by
//	   `bgm_id = @bgm_id`, so a re-binding that lands between the fetch and the
//	   write produces zero rows instead of filing one upstream's episode names
//	   under another subject.  The Go-side re-read closes most of that window;
//	   this closes the rest.  Nothing else in the suite can observe it, because
//	   the wrong-data outcome and the correct outcome differ only in the
//	   database.
//
//	E. VALUE AND SOURCE MOVE TOGETHER.  A row whose name_cn was replaced while
//	   name_cn_source was left behind wears a label that licenses the NEXT
//	   writer to overwrite the wrong thing.  0029 records that no constraint
//	   can catch this: a CHECK sees the row after the write, not the
//	   transition into it.  So it has to be caught here.
//
//	F. SNAPSHOT RETRACTION.  An upsert says what the upstream returned and
//	   nothing about what it stopped returning, so a wrongly-bound entry keeps
//	   every stale row behind the few the new binding overwrites.  The
//	   retraction is scoped to one source and one anime, and its cardinality
//	   guard is the difference between "nothing changed" and "this source's
//	   entire contribution erased" on a transient upstream blip.
//
//	G/H. THE SWEEP.  Which airing rows are due another look, in which order,
//	   and the attempt stamp that moves a row to the back of the queue.  The
//	   ordering is the part that matters: it is what lets the scan read a
//	   prefix of the partial index and stop.
//
// Run with the command CI uses (.github/workflows/unit-tests.yml), so a failure
// here reproduces exactly:
//
//	go test -tags=integration -count=1 -timeout=600s ./test/integration/...
package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// The anilist_id block this file owns.  TruncateAll already isolates each test
// function, but a distinct block keeps a stray leftover attributable to the
// file that wrote it rather than to whichever test read it next.
//
// etBgmID is the binding every anime here is seeded with unless a case is
// specifically about the binding not matching.
const etBgmID = 9111

const (
	etOldName   = "OLD romaji episode name"
	etOldNameCn = "旧的中文集名"
	etNewName   = "NEW romaji episode name"
	etNewNameCn = "新的中文集名"
)

// ---------------------------------------------------------------------------
// Arrange / read helpers
// ---------------------------------------------------------------------------

// etSeedAnime inserts the anime_cache parent that anime_episode_titles.anime_id
// references.
//
// Every case needs one.  Without the parent row the FK rejects the write, and
// the upsert would report zero rows for a reason that has nothing to do with
// the property under test — indistinguishable, from Go, from the binding guard
// firing correctly.
func etSeedAnime(t *testing.T, ctx context.Context, pool *pgxpool.Pool, anilistID, bgmID int32) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_romaji, bgm_id)
		VALUES ($1, $2, $3)`,
		anilistID, "episode-title fixture", bgmID,
	)
	require.NoError(t, err, "seed anime_cache %d", anilistID)
}

// etSeedUnboundAnime inserts an anime_cache row with bgm_id NULL — an entry
// nothing upstream has been matched to yet, which is 29% of the catalogue.
func etSeedUnboundAnime(t *testing.T, ctx context.Context, pool *pgxpool.Pool, anilistID int32) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_romaji, bgm_id)
		VALUES ($1, $2, NULL)`,
		anilistID, "unbound episode-title fixture",
	)
	require.NoError(t, err, "seed unbound anime_cache %d", anilistID)
}

// etSeedSweepAnime inserts an anime_cache row carrying the three columns the
// candidate predicate reads.  bgmID <= 0 seeds bgm_id NULL; sweptAgo is a
// Postgres interval literal such as "27 hours", or "" for a row never swept.
//
// The stamp is computed by the DATABASE rather than in Go on purpose.  The
// predicate compares episode_titles_at against the server's own now(), so a
// Go-side time.Now() would put a 25-hour row and a 26-hour threshold at the
// mercy of clock skew between this process and the container — and the failure
// would read as a query bug rather than as the environment problem it is.
func etSeedSweepAnime(t *testing.T, ctx context.Context, pool *pgxpool.Pool,
	anilistID, bgmID int32, status, sweptAgo string,
) {
	t.Helper()
	var bgm *int32
	if bgmID > 0 {
		bgm = &bgmID
	}
	var ago *string
	if sweptAgo != "" {
		ago = &sweptAgo
	}
	// A NULL interval propagates: now() - NULL is NULL, which is exactly the
	// "never swept" state, so the never-swept case needs no second statement.
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_cache (anilist_id, title_romaji, bgm_id, status, episode_titles_at)
		VALUES ($1, $2, $3, $4, now() - ($5::text)::interval)`,
		anilistID, "sweep fixture", bgm, status, ago,
	)
	require.NoError(t, err, "seed sweep anime_cache %d", anilistID)
}

// etSeedTitle writes one anime_episode_titles row directly, with whatever
// per-field provenance a case needs.
//
// Direct SQL rather than the upsert under test: an arrange step built out of
// the query being tested cannot tell "the query wrote what I asked for" apart
// from "the query is broken in the same direction twice".  It is also the only
// way to produce the pre-0029 shape — a value with no source at all — which the
// precedence ladder has to score as 0.
func etSeedTitle(t *testing.T, ctx context.Context, pool *pgxpool.Pool,
	animeID, episode int32, nameCn, nameCnSource, name, nameSource *string,
) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO anime_episode_titles (
			anime_id, episode, name_cn, name_cn_source, name, name_source
		) VALUES ($1, $2, $3, $4, $5, $6)`,
		animeID, episode, nameCn, nameCnSource, name, nameSource,
	)
	require.NoError(t, err, "seed episode title %d/%d", animeID, episode)
}

// etTitle is one anime_episode_titles row as the assertions read it.  `present`
// distinguishes an absent row from a row whose four columns are all NULL —
// which is a real and populous state in this table, and the difference between
// "the upsert refused to insert" and "the upsert inserted an empty row".
type etTitle struct {
	present                                bool
	nameCn, nameCnSource, name, nameSource *string
}

func etRead(t *testing.T, ctx context.Context, pool *pgxpool.Pool, animeID, episode int32) etTitle {
	t.Helper()
	var r etTitle
	err := pool.QueryRow(ctx, `
		SELECT name_cn, name_cn_source, name, name_source
		FROM anime_episode_titles
		WHERE anime_id = $1 AND episode = $2`,
		animeID, episode,
	).Scan(&r.nameCn, &r.nameCnSource, &r.name, &r.nameSource)
	if errors.Is(err, pgx.ErrNoRows) {
		return etTitle{}
	}
	require.NoError(t, err, "read episode title %d/%d", animeID, episode)
	r.present = true
	return r
}

// etCountTitles counts the rows one anime holds, so "inserted nothing" is an
// assertion about the table rather than about one key the test happened to look
// up.
func etCountTitles(t *testing.T, ctx context.Context, pool *pgxpool.Pool, animeID int32) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM anime_episode_titles WHERE anime_id = $1`, animeID).Scan(&n))
	return n
}

// etAssertField checks a value and ITS OWN source column together.  Empty
// wantValue / wantSource mean SQL NULL.
//
// This is property E, in one place.  Asserting the value alone would pass on a
// row whose name_cn was replaced while name_cn_source kept the previous
// upstream's label — a row that then licenses the next writer to overwrite the
// wrong thing.  Asserting the source alone would pass on the mirror image.  No
// CHECK constraint can catch either, because a constraint sees the row after
// the write rather than the transition into it, so the pairing is only ever
// checked here.
func etAssertField(t *testing.T, label string, gotValue, gotSource *string, wantValue, wantSource string) {
	t.Helper()
	if wantValue == "" {
		assert.Nil(t, gotValue, "%s: value must be NULL, got %q", label, deref(gotValue))
	} else if assert.NotNil(t, gotValue, "%s: value must be present", label) {
		assert.Equal(t, wantValue, *gotValue, "%s: value", label)
	}
	if wantSource == "" {
		assert.Nil(t, gotSource, "%s: a NULL value carries no provenance, got %q", label, deref(gotSource))
	} else if assert.NotNil(t, gotSource, "%s: source must be present", label) {
		assert.Equal(t, wantSource, *gotSource,
			"%s: the source column must name whoever supplied the value standing in the row", label)
	}
}

// etUpsert is UpsertEpisodeTitleSourced with the two parameters every case in
// this file shares spelled once.
func etUpsert(ctx context.Context, q *dbgen.Queries, animeID, episode int32, nameCn, name, source string) (int64, error) {
	return q.UpsertEpisodeTitleSourced(ctx, dbgen.UpsertEpisodeTitleSourcedParams{
		Episode: episode,
		NameCn:  nameCn,
		Name:    name,
		Source:  source,
		AnimeID: animeID,
		BgmID:   etBgmID,
	})
}

// ---------------------------------------------------------------------------
// A.  Precedence
// ---------------------------------------------------------------------------

// TestEpisodeTitleUpsertPrecedence walks the full matrix: what is already in
// the row × who is writing.
//
// Both payload columns are seeded from the same source in each case so the
// matrix stays a matrix; the case where the two columns disagree is
// TestEpisodeTitleUpsertPerFieldPrecedence below, and it is the reason the two
// source columns exist at all.
func TestEpisodeTitleUpsertPrecedence(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const animeID = 7700100
	etSeedAnime(t, ctx, pool, animeID, etBgmID)

	cases := []struct {
		name string
		// existing is the source already on both columns; "" seeds a value
		// with no source at all, which is the pre-0029 shape.
		existing string
		incoming string
		wantWin  bool
		why      string
	}{
		{
			name: "bangumi fills a column nobody has claimed", existing: "", incoming: "bangumi", wantWin: true,
			why: "an absent source scores 0, so any real upstream may claim it — every row written before 0029 is this shape",
		},
		{
			name: "ddp fills a column nobody has claimed", existing: "", incoming: "ddp", wantWin: true,
			why: "same rule, and this is the path by which dandanplay first reaches the legacy rows",
		},
		{
			name: "manual fills a column nobody has claimed", existing: "", incoming: "manual", wantWin: true,
			why: "the top of the ladder is not a special case at the bottom of it",
		},
		{
			name: "★ bangumi overwrites its own earlier value", existing: "bangumi", incoming: "bangumi", wantWin: true,
			why: "the comparison is >= and not >, deliberately: an airing show's episode 9 gets its real name a week late, and a source that could not correct itself would freeze the placeholder forever",
		},
		{
			name: "ddp outranks bangumi", existing: "bangumi", incoming: "ddp", wantWin: true,
			why: "ddp is the later, more specific upstream in the vocabulary order",
		},
		{
			name: "manual outranks bangumi", existing: "bangumi", incoming: "manual", wantWin: true,
			why: "a human decision beats any fetch",
		},
		{
			name: "bangumi cannot overwrite ddp", existing: "ddp", incoming: "bangumi", wantWin: false,
			why: "the nightly bangumi pass must not undo what dandanplay filled in — this is the arm that makes precedence worth having",
		},
		{
			name: "★ ddp overwrites its own earlier value", existing: "ddp", incoming: "ddp", wantWin: true,
			why: "same >= as above, on the source that re-fetches most often",
		},
		{
			name: "manual outranks ddp", existing: "ddp", incoming: "manual", wantWin: true,
			why: "a human decision beats any fetch",
		},
		{
			name: "bangumi cannot overwrite manual", existing: "manual", incoming: "bangumi", wantWin: false,
			why: "no automated pass may undo a human correction; nothing writes 'manual' today, and this is why the value was admitted early",
		},
		{
			name: "ddp cannot overwrite manual", existing: "manual", incoming: "ddp", wantWin: false,
			why: "same, for the other upstream",
		},
		{
			name: "★ manual overwrites its own earlier value", existing: "manual", incoming: "manual", wantWin: true,
			why: "a second human correction must land; > instead of >= would make the first edit permanent",
		},
	}

	for i, c := range cases {
		c := c
		episode := int32(i + 1)
		t.Run(c.name, func(t *testing.T) {
			var src *string
			if c.existing != "" {
				src = ptr(c.existing)
			}
			etSeedTitle(t, ctx, pool, animeID, episode, ptr(etOldNameCn), src, ptr(etOldName), src)

			rows, err := etUpsert(ctx, q, animeID, episode, etNewNameCn, etNewName, c.incoming)
			require.NoError(t, err)

			// One row, whether or not the values changed.  ON CONFLICT DO
			// UPDATE reports the row as visited, so a caller must never read
			// this count as "the write won" — the precedence CASE runs inside
			// an UPDATE that has already been counted.
			assert.Equal(t, int64(1), rows,
				"a conflicting upsert always reports one affected row; rows-affected is not the precedence verdict")

			got := etRead(t, ctx, pool, animeID, episode)
			require.True(t, got.present, "the row must still exist")

			wantName, wantNameCn, wantSource := etOldName, etOldNameCn, c.existing
			if c.wantWin {
				wantName, wantNameCn, wantSource = etNewName, etNewNameCn, c.incoming
			}
			etAssertField(t, "name_cn ("+c.why+")", got.nameCn, got.nameCnSource, wantNameCn, wantSource)
			etAssertField(t, "name ("+c.why+")", got.name, got.nameSource, wantName, wantSource)
		})
	}

	t.Run("an episode nobody has written yet is inserted with its source", func(t *testing.T) {
		// The INSERT arm, which the twelve cases above never reach: they all
		// conflict.  A ladder that scored correctly but a SELECT list that
		// dropped a source column would pass all of them and fail here.
		const episode = 90
		rows, err := etUpsert(ctx, q, animeID, episode, etNewNameCn, etNewName, "ddp")
		require.NoError(t, err)
		assert.Equal(t, int64(1), rows)

		got := etRead(t, ctx, pool, animeID, episode)
		require.True(t, got.present, "a first write must create the row")
		etAssertField(t, "name_cn", got.nameCn, got.nameCnSource, etNewNameCn, "ddp")
		etAssertField(t, "name", got.name, got.nameSource, etNewName, "ddp")
	})
}

// ---------------------------------------------------------------------------
// B.  Per-field independence
// ---------------------------------------------------------------------------

// TestEpisodeTitleUpsertPerFieldPrecedence is the property a single row-level
// source column could not express.
//
// dandanplay returns ONE string per episode and its body is Chinese on some
// rows and Japanese on others, so one dandanplay value lands in name_cn on one
// episode and in name on the next.  Beside a Bangumi pass that fills both, the
// ordinary steady state of this table is a row whose two columns come from two
// different upstreams.  Labelling such a row 'ddp' or 'bangumi' would be a
// false claim either way, and precedence computed from a false claim overwrites
// the better value with the worse one — which is the bug this test exists to
// make impossible.
func TestEpisodeTitleUpsertPerFieldPrecedence(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const animeID = 7700200
	etSeedAnime(t, ctx, pool, animeID, etBgmID)

	t.Run("bangumi corrects the bangumi field and leaves the ddp field alone", func(t *testing.T) {
		const episode = 1
		etSeedTitle(t, ctx, pool, animeID, episode,
			ptr(etOldNameCn), ptr("ddp"), // Chinese title came from dandanplay
			ptr(etOldName), ptr("bangumi"), // Japanese title came from Bangumi
		)

		rows, err := etUpsert(ctx, q, animeID, episode, etNewNameCn, etNewName, "bangumi")
		require.NoError(t, err)
		require.Equal(t, int64(1), rows)

		got := etRead(t, ctx, pool, animeID, episode)
		require.True(t, got.present)
		etAssertField(t, "name_cn: ddp outranks the incoming bangumi and must survive",
			got.nameCn, got.nameCnSource, etOldNameCn, "ddp")
		etAssertField(t, "name: bangumi may correct its own earlier value",
			got.name, got.nameSource, etNewName, "bangumi")
	})

	t.Run("ddp corrects the bangumi field and leaves the manual field alone", func(t *testing.T) {
		// The mirror image, so a pass is not an artefact of which column
		// happened to be the loser.  If the two fields were ever compared
		// against one shared source column, exactly one of these two subtests
		// would fail whichever column that column was.
		const episode = 2
		etSeedTitle(t, ctx, pool, animeID, episode,
			ptr(etOldNameCn), ptr("bangumi"),
			ptr(etOldName), ptr("manual"),
		)

		rows, err := etUpsert(ctx, q, animeID, episode, etNewNameCn, etNewName, "ddp")
		require.NoError(t, err)
		require.Equal(t, int64(1), rows)

		got := etRead(t, ctx, pool, animeID, episode)
		require.True(t, got.present)
		etAssertField(t, "name_cn: ddp outranks bangumi",
			got.nameCn, got.nameCnSource, etNewNameCn, "ddp")
		etAssertField(t, "name: a human correction stands",
			got.name, got.nameSource, etOldName, "manual")
	})
}

// ---------------------------------------------------------------------------
// C.  Empty values
// ---------------------------------------------------------------------------

// TestEpisodeTitleUpsertRejectsEmptyValues pins the btrim + NULLIF gate.
//
// Roughly a third of anime_episode_titles is rows whose two payload columns are
// both NULL — written before 0029 by a transform with no name check and an
// upsert with no COALESCE.  They render exactly like a missing row, so they
// cost the reader nothing, but they made "does this anime have titles?"
// unanswerable by counting rows.  Every case here is about new writes being
// unable to add to that population, or to erase a real value with a blank one.
func TestEpisodeTitleUpsertRejectsEmptyValues(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const animeID = 7700300
	etSeedAnime(t, ctx, pool, animeID, etBgmID)

	t.Run("an empty name_cn leaves the stored value AND its source alone", func(t *testing.T) {
		const episode = 1
		etSeedTitle(t, ctx, pool, animeID, episode,
			ptr(etOldNameCn), ptr("bangumi"),
			ptr(etOldName), ptr("bangumi"),
		)

		// A dandanplay row whose single string was Japanese: name is filled,
		// name_cn is not.  ddp outranks bangumi, so if the empty value were
		// allowed through it would win the comparison and blank the column.
		rows, err := etUpsert(ctx, q, animeID, episode, "", etNewName, "ddp")
		require.NoError(t, err)
		require.Equal(t, int64(1), rows)

		got := etRead(t, ctx, pool, animeID, episode)
		etAssertField(t, "name_cn must keep both its value and its bangumi label",
			got.nameCn, got.nameCnSource, etOldNameCn, "bangumi")
		etAssertField(t, "name is the field the call actually carried",
			got.name, got.nameSource, etNewName, "ddp")
	})

	t.Run("both fields empty affects no rows and inserts nothing", func(t *testing.T) {
		const episode = 2
		rows, err := etUpsert(ctx, q, animeID, episode, "", "", "ddp")
		require.NoError(t, err)
		assert.Equal(t, int64(0), rows, "the WHERE must refuse a call carrying no value at all")
		assert.False(t, etRead(t, ctx, pool, animeID, episode).present,
			"no row may appear: an all-NULL row is invisible to the reader and permanent in the table")
	})

	t.Run("both fields empty cannot reach an existing row either", func(t *testing.T) {
		// The refusal is in the WHERE of the INSERT's SELECT, so the statement
		// never reaches ON CONFLICT.  Worth its own case because a guard
		// written into the DO UPDATE arms instead would still count the row.
		const episode = 3
		etSeedTitle(t, ctx, pool, animeID, episode,
			ptr(etOldNameCn), ptr("bangumi"),
			ptr(etOldName), ptr("bangumi"),
		)

		rows, err := etUpsert(ctx, q, animeID, episode, "", "", "manual")
		require.NoError(t, err)
		assert.Equal(t, int64(0), rows, "an empty call is refused before the conflict is considered")

		got := etRead(t, ctx, pool, animeID, episode)
		etAssertField(t, "name_cn", got.nameCn, got.nameCnSource, etOldNameCn, "bangumi")
		etAssertField(t, "name", got.name, got.nameSource, etOldName, "bangumi")
	})

	t.Run("whitespace is empty: a blank-looking call inserts nothing", func(t *testing.T) {
		// btrim runs before NULLIF, so "   " is indistinguishable from "".
		// Upstreams do emit padded strings, and a bare NULLIF(x, '') would let
		// one through as a real value that renders as an empty episode title.
		//
		// Spaces only.  btrim's DEFAULT character set is the ASCII space and
		// nothing else — see TestEpisodeTitleUpsertNonSpaceWhitespaceLands
		// below, which is about that gap rather than about this rule.
		const episode = 4
		rows, err := etUpsert(ctx, q, animeID, episode, "   ", "     ", "ddp")
		require.NoError(t, err)
		assert.Equal(t, int64(0), rows, "whitespace must be treated exactly like empty")
		assert.False(t, etRead(t, ctx, pool, animeID, episode).present, "no row may appear")
	})

	t.Run("whitespace cannot blank a stored value", func(t *testing.T) {
		const episode = 5
		etSeedTitle(t, ctx, pool, animeID, episode,
			ptr(etOldNameCn), ptr("bangumi"),
			ptr(etOldName), ptr("bangumi"),
		)

		rows, err := etUpsert(ctx, q, animeID, episode, "   ", etNewName, "manual")
		require.NoError(t, err)
		require.Equal(t, int64(1), rows)

		got := etRead(t, ctx, pool, animeID, episode)
		etAssertField(t, "name_cn: a whitespace value is no value, even from manual",
			got.nameCn, got.nameCnSource, etOldNameCn, "bangumi")
		etAssertField(t, "name: the field that carried something still lands",
			got.name, got.nameSource, etNewName, "manual")
	})

	t.Run("surrounding whitespace is trimmed off a value that does land", func(t *testing.T) {
		// The same btrim that decides emptiness also decides what gets stored,
		// so this is the other half of the same expression rather than a new
		// claim.
		const episode = 6
		rows, err := etUpsert(ctx, q, animeID, episode, "  "+etNewNameCn+"  ", " "+etNewName+" ", "ddp")
		require.NoError(t, err)
		require.Equal(t, int64(1), rows)

		got := etRead(t, ctx, pool, animeID, episode)
		etAssertField(t, "name_cn", got.nameCn, got.nameCnSource, etNewNameCn, "ddp")
		etAssertField(t, "name", got.name, got.nameSource, etNewName, "ddp")
	})

	t.Run("the refused calls left the table exactly as large as the writes that landed", func(t *testing.T) {
		// Three subtests above assert "no row appeared" at one key each.  This
		// counts, so an insert that landed under some OTHER episode number —
		// the shape a mis-ordered parameter list produces — is also caught.
		assert.Equal(t, 4, etCountTitles(t, ctx, pool, animeID),
			"episodes 1, 3, 5 were seeded and 6 was written; 2 and 4 must not exist")
	})
}

// TestEpisodeTitleUpsertNonSpaceWhitespaceLands is EXPECTED TO FAIL, and it is
// left failing on purpose rather than fixed or deleted.
//
// UpsertEpisodeTitleSourced's doc comment states the rule as "btrim + NULLIF
// turn ” and whitespace into NULL on the way in".  btrim's default character
// set is the ASCII space U+0020 and nothing else, so the statement implements
// that rule for "   " only.  Verified directly against the same image this test
// runs on:
//
//	btrim('   ')          -> ''            -> NULLIF -> NULL   (refused)
//	btrim(E'\t')          -> E'\t'         -> NULLIF -> E'\t'  (LANDS)
//	btrim(E'\n')          -> E'\n'         -> NULLIF -> E'\n'  (LANDS)
//	btrim(U&'\3000')      -> U+3000        -> NULLIF -> U+3000 (LANDS)
//
// U+3000 IDEOGRAPHIC SPACE is the one that makes this reachable rather than
// theoretical: it is the ordinary space character in Japanese and Chinese text,
// and both upstreams feeding this table are CJK sources.  A Bangumi episode
// whose name_cn is a single U+3000, or a dandanplay episodeTitle that is one
// stray newline, is written here as a real value with a real source label.  It
// then (a) renders as a blank episode title rather than as a missing one, and
// (b) claims the column at its source's precedence, so the next pass carrying
// the actual name is compared against it rather than against an unclaimed
// column — and if that next pass is a LOWER source, the blank wins.
//
// That is the population 0029 set out to stop growing: rows that "render
// exactly like a missing row" but are not one.
//
// The fix belongs in the query, not here — btrim(x, E' \t\r\n　') or a
// regexp test — and this file is not allowed to make it.  Delete this test only
// together with a change to the statement it describes.
func TestEpisodeTitleUpsertNonSpaceWhitespaceLands(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const animeID = 7700900
	etSeedAnime(t, ctx, pool, animeID, etBgmID)

	cases := []struct {
		name  string
		value string
	}{
		{name: "a lone tab", value: "\t"},
		{name: "a lone newline", value: "\n"},
		{name: "a lone U+3000 ideographic space", value: "　"},
	}

	for i, c := range cases {
		c := c
		episode := int32(i + 1)
		t.Run(c.name, func(t *testing.T) {
			rows, err := etUpsert(ctx, q, animeID, episode, c.value, c.value, "ddp")
			require.NoError(t, err)

			assert.Equal(t, int64(0), rows,
				"a value made only of whitespace carries no title and must be refused like ''")
			got := etRead(t, ctx, pool, animeID, episode)
			assert.False(t, got.present,
				"no row may appear: %q lands as a real value wearing a real source label, which is both a blank episode title and a precedence claim against the next writer",
				c.value)
		})
	}
}

// ---------------------------------------------------------------------------
// D.  The binding is pinned
// ---------------------------------------------------------------------------

// TestEpisodeTitleUpsertPinsTheBinding is the race guard, and it is the one
// property in this file that has no observable effect anywhere except the
// database.
//
// A worker reads an anime's bgm_id, fetches that subject's episode list, and
// writes it back.  If an admin re-binding lands in between, the write is
// holding one subject's episode names and a row that now points at another.
// The Go-side re-read closes most of that window; this closes the rest, and it
// converts the failure from wrong data that nobody will ever notice into a
// zero-row result the caller can see.
func TestEpisodeTitleUpsertPinsTheBinding(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const (
		animeID   = 7700400
		boundBgm  = 111
		staleBgm  = 222
		unboundID = 7700410
	)
	etSeedAnime(t, ctx, pool, animeID, boundBgm)
	etSeedUnboundAnime(t, ctx, pool, unboundID)

	// The two subtests below run in order against the same episode on purpose:
	// the second is what proves the first failed for the right reason.  A
	// mis-typed column name would also produce zero rows, and only a call that
	// then SUCCEEDS distinguishes the guard from a broken statement.
	const episode = 1

	t.Run("a write carrying a stale binding lands nothing", func(t *testing.T) {
		rows, err := q.UpsertEpisodeTitleSourced(ctx, dbgen.UpsertEpisodeTitleSourcedParams{
			Episode: episode, NameCn: etNewNameCn, Name: etNewName,
			Source: "bangumi", AnimeID: animeID, BgmID: staleBgm,
		})
		require.NoError(t, err, "a lost race is a zero-row result, not an error")
		assert.Equal(t, int64(0), rows,
			"bgm_id 222 does not match the row's 111, so the INSERT's SELECT returns no row to insert")
		assert.False(t, etRead(t, ctx, pool, animeID, episode).present,
			"nothing may be filed under a subject the anime is no longer bound to")
		assert.Equal(t, 0, etCountTitles(t, ctx, pool, animeID),
			"and not under any other episode number either")
	})

	t.Run("the same write under the row's actual binding lands", func(t *testing.T) {
		rows, err := q.UpsertEpisodeTitleSourced(ctx, dbgen.UpsertEpisodeTitleSourcedParams{
			Episode: episode, NameCn: etNewNameCn, Name: etNewName,
			Source: "bangumi", AnimeID: animeID, BgmID: boundBgm,
		})
		require.NoError(t, err)
		assert.Equal(t, int64(1), rows, "the guard must admit the binding the row actually holds")

		got := etRead(t, ctx, pool, animeID, episode)
		require.True(t, got.present)
		etAssertField(t, "name_cn", got.nameCn, got.nameCnSource, etNewNameCn, "bangumi")
		etAssertField(t, "name", got.name, got.nameSource, etNewName, "bangumi")
	})

	t.Run("an anime with no binding at all cannot be written to", func(t *testing.T) {
		// `ac.bgm_id = $n` against NULL is NULL, not false, and NULL does not
		// qualify a row — so an unbound entry is unreachable through this
		// query.  That is correct (nothing upstream has been matched to it),
		// and worth pinning because a future `coalesce(ac.bgm_id, ...)` written
		// to "handle" NULL would open exactly the door this guard closes.
		rows, err := q.UpsertEpisodeTitleSourced(ctx, dbgen.UpsertEpisodeTitleSourcedParams{
			Episode: 1, NameCn: etNewNameCn, Name: etNewName,
			Source: "ddp", AnimeID: unboundID, BgmID: 0,
		})
		require.NoError(t, err)
		assert.Equal(t, int64(0), rows)
		assert.Equal(t, 0, etCountTitles(t, ctx, pool, unboundID))
	})
}

// ---------------------------------------------------------------------------
// E.  Value and source move together
// ---------------------------------------------------------------------------

// TestEpisodeTitleUpsertMovesValueAndSourceTogether isolates the pairing 0029
// records as unenforceable by the schema: "a CHECK sees the row after the
// write and cannot tell whether name_cn was replaced while name_cn_source was
// left behind, which would leave a dandanplay string wearing a 'bangumi'
// label."
//
// The damage is not the wrong label itself.  It is that the label is read by
// the NEXT write's precedence comparison, so a fresh ddp value labelled
// 'bangumi' invites the following bangumi pass to overwrite it — one mislabel
// silently demotes the value forever after.
func TestEpisodeTitleUpsertMovesValueAndSourceTogether(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const animeID = 7700500
	etSeedAnime(t, ctx, pool, animeID, etBgmID)

	t.Run("a landed value is relabelled to whoever supplied it", func(t *testing.T) {
		const episode = 1
		etSeedTitle(t, ctx, pool, animeID, episode,
			ptr(etOldNameCn), ptr("bangumi"),
			ptr(etOldName), ptr("bangumi"),
		)

		rows, err := etUpsert(ctx, q, animeID, episode, etNewNameCn, etNewName, "ddp")
		require.NoError(t, err)
		require.Equal(t, int64(1), rows)

		got := etRead(t, ctx, pool, animeID, episode)
		etAssertField(t, "name_cn", got.nameCn, got.nameCnSource, etNewNameCn, "ddp")
		etAssertField(t, "name", got.name, got.nameSource, etNewName, "ddp")
	})

	t.Run("a rejected write leaves both the value and its old label", func(t *testing.T) {
		// The mirror: the source column must not advance on a write whose
		// value did not. A 'manual' row relabelled 'ddp' while keeping the
		// human's text would be quietly demoted to overwritable.
		const episode = 2
		etSeedTitle(t, ctx, pool, animeID, episode,
			ptr(etOldNameCn), ptr("manual"),
			ptr(etOldName), ptr("manual"),
		)

		rows, err := etUpsert(ctx, q, animeID, episode, etNewNameCn, etNewName, "ddp")
		require.NoError(t, err)
		require.Equal(t, int64(1), rows)

		got := etRead(t, ctx, pool, animeID, episode)
		etAssertField(t, "name_cn", got.nameCn, got.nameCnSource, etOldNameCn, "manual")
		etAssertField(t, "name", got.name, got.nameSource, etOldName, "manual")
	})
}

// ---------------------------------------------------------------------------
// F.  Snapshot retraction
// ---------------------------------------------------------------------------

// TestEpisodeTitleSnapshotRetraction covers the pair of statements that give an
// upsert-shaped write snapshot semantics.
//
// Upserting a fetch writes the episodes the upstream returned and says nothing
// about the ones it stopped returning.  An entry bound to the wrong subject
// therefore keeps every stale row the old binding left behind, with the few
// correct new rows sitting in front of them — on a three-episode ONA bound to a
// full series, three corrected rows in front of hundreds of wrong ones.
//
// The retraction is scoped to one source because a writer may withdraw what it
// said and may not touch what another source filled in; the deletion is scoped
// to the episodes the retraction actually touched because this table's
// long-standing all-NULL rows are the only record that an episode number exists
// at all for entries whose catalogue episode count is unknown.
func TestEpisodeTitleSnapshotRetraction(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const (
		wholeSourceID = 7700600 // five ddp episodes, two kept
		mixedID       = 7700610 // one mixed row beside a ddp-only one
		guardID       = 7700620 // the empty-kept-set case
	)
	etSeedAnime(t, ctx, pool, wholeSourceID, etBgmID)
	etSeedAnime(t, ctx, pool, mixedID, etBgmID)
	etSeedAnime(t, ctx, pool, guardID, etBgmID)

	t.Run("episodes outside the kept set lose this source's fields", func(t *testing.T) {
		for ep := int32(1); ep <= 5; ep++ {
			etSeedTitle(t, ctx, pool, wholeSourceID, ep,
				ptr(etOldNameCn), ptr("ddp"),
				ptr(etOldName), ptr("ddp"),
			)
		}

		cleared, err := q.ClearEpisodeTitlesBySourceOutside(ctx, "ddp", wholeSourceID, []int32{1, 2})
		require.NoError(t, err)
		// ElementsMatch, not Equal: RETURNING from an UPDATE has no ORDER BY,
		// so the order is whatever the scan produced.
		assert.ElementsMatch(t, []int32{3, 4, 5}, cleared,
			"the caller feeds this straight to DeleteEmptyEpisodeTitles, so it must be exactly the rows that were emptied")

		for _, ep := range []int32{3, 4, 5} {
			got := etRead(t, ctx, pool, wholeSourceID, ep)
			require.True(t, got.present, "episode %d must still exist — retraction empties, it does not delete", ep)
			etAssertField(t, "retracted name_cn", got.nameCn, got.nameCnSource, "", "")
			etAssertField(t, "retracted name", got.name, got.nameSource, "", "")
		}
		for _, ep := range []int32{1, 2} {
			got := etRead(t, ctx, pool, wholeSourceID, ep)
			require.True(t, got.present)
			etAssertField(t, "kept name_cn", got.nameCn, got.nameCnSource, etOldNameCn, "ddp")
			etAssertField(t, "kept name", got.name, got.nameSource, etOldName, "ddp")
		}
	})

	// The next two subtests are one story told in two steps against mixedID:
	// the retraction, then the deletion that consumes its result.  Episode 1
	// holds a name_cn from dandanplay beside a name from Bangumi; episode 3
	// holds only dandanplay values; episode 2 is kept.
	var mixedCleared []int32

	t.Run("a field owned by another source survives the retraction", func(t *testing.T) {
		etSeedTitle(t, ctx, pool, mixedID, 1,
			ptr(etOldNameCn), ptr("ddp"),
			ptr(etOldName), ptr("bangumi"),
		)
		etSeedTitle(t, ctx, pool, mixedID, 2,
			ptr(etOldNameCn), ptr("ddp"),
			ptr(etOldName), ptr("ddp"),
		)
		etSeedTitle(t, ctx, pool, mixedID, 3,
			ptr(etOldNameCn), ptr("ddp"),
			ptr(etOldName), ptr("ddp"),
		)

		var err error
		mixedCleared, err = q.ClearEpisodeTitlesBySourceOutside(ctx, "ddp", mixedID, []int32{2})
		require.NoError(t, err)
		assert.ElementsMatch(t, []int32{1, 3}, mixedCleared,
			"a row is touched if EITHER of its fields belongs to the retracting source")

		mixed := etRead(t, ctx, pool, mixedID, 1)
		require.True(t, mixed.present)
		etAssertField(t, "the retracting source's own field goes",
			mixed.nameCn, mixed.nameCnSource, "", "")
		etAssertField(t, "the other source's field is none of dandanplay's business",
			mixed.name, mixed.nameSource, etOldName, "bangumi")
	})

	t.Run("DeleteEmptyEpisodeTitles removes only the rows left fully empty", func(t *testing.T) {
		require.NotEmpty(t, mixedCleared, "the retraction step must have run first")

		deleted, err := q.DeleteEmptyEpisodeTitles(ctx, mixedID, mixedCleared)
		require.NoError(t, err)
		assert.Equal(t, int64(1), deleted, "only episode 3 was left with nothing in either column")

		assert.False(t, etRead(t, ctx, pool, mixedID, 3).present,
			"a row emptied by the retraction carries no information and goes")

		survivor := etRead(t, ctx, pool, mixedID, 1)
		require.True(t, survivor.present,
			"a row still holding another source's title must NOT be deleted — this is why the pair is two statements rather than one CTE, which would test the pre-UPDATE values")
		etAssertField(t, "the surviving Bangumi name", survivor.name, survivor.nameSource, etOldName, "bangumi")

		kept := etRead(t, ctx, pool, mixedID, 2)
		require.True(t, kept.present, "an episode inside the kept set was never a candidate for deletion")
		etAssertField(t, "kept name_cn", kept.nameCn, kept.nameCnSource, etOldNameCn, "ddp")
	})

	t.Run("★ an empty kept set retracts nothing", func(t *testing.T) {
		// The cardinality guard.  Without it, every row is "outside" an empty
		// kept set, so one upstream blip — a transient error, a subject
		// mid-edit — erases this source's entire contribution for the anime.
		// Callers are specified never to reach the query with an empty
		// snapshot, but a convention is the wrong place to keep the difference
		// between "nothing changed" and "everything erased".
		for ep := int32(1); ep <= 2; ep++ {
			etSeedTitle(t, ctx, pool, guardID, ep,
				ptr(etOldNameCn), ptr("ddp"),
				ptr(etOldName), ptr("ddp"),
			)
		}

		cleared, err := q.ClearEpisodeTitlesBySourceOutside(ctx, "ddp", guardID, []int32{})
		require.NoError(t, err)
		assert.Empty(t, cleared, "an empty snapshot must retract nothing at all")

		for ep := int32(1); ep <= 2; ep++ {
			got := etRead(t, ctx, pool, guardID, ep)
			require.True(t, got.present, "episode %d must survive", ep)
			etAssertField(t, "untouched name_cn", got.nameCn, got.nameCnSource, etOldNameCn, "ddp")
			etAssertField(t, "untouched name", got.name, got.nameSource, etOldName, "ddp")
		}
	})
}

// ---------------------------------------------------------------------------
// G.  The candidate query
// ---------------------------------------------------------------------------

// TestEpisodeTitleReleasingCandidates pins the sweep's predicate and its order.
//
// The order is not cosmetic.  0029's partial index leads on episode_titles_at
// NULLS FIRST precisely so an ordered scan reads its qualifying prefix and
// stops; the rows the freshness arm rejects — which cannot appear in an index
// predicate at all, because now() is STABLE and index predicates admit only
// IMMUTABLE expressions — sort last, behind everything the sweep wants.  Lose
// NULLS FIRST and the query still returns the right SET while walking past the
// whole recently-swept tail, and the shows that have never been swept at all go
// to the back of the queue.
func TestEpisodeTitleReleasingCandidates(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const (
		// Deliberately the LOWEST id in the set: it is stamped, so it must
		// still sort last.  Ordering by anilist_id alone would put it first,
		// which is the arrangement that tells a working NULLS FIRST apart from
		// one that only looks right on ascending ids.
		stampedStale = 7700701
		neverSweptA  = 7700702
		neverSweptB  = 7700703
		stampedFresh = 7700704
		finished     = 7700705
		unbound      = 7700706
	)

	etSeedSweepAnime(t, ctx, pool, stampedStale, 5001, "RELEASING", "27 hours")
	etSeedSweepAnime(t, ctx, pool, neverSweptA, 5002, "RELEASING", "")
	etSeedSweepAnime(t, ctx, pool, neverSweptB, 5003, "RELEASING", "")
	etSeedSweepAnime(t, ctx, pool, stampedFresh, 5004, "RELEASING", "25 hours")
	etSeedSweepAnime(t, ctx, pool, finished, 5005, "FINISHED", "")
	etSeedSweepAnime(t, ctx, pool, unbound, 0, "RELEASING", "")

	// The sweep's own constant.  Constructed per call because pgtype.Interval
	// is a mutable struct, matching internal/queue/bangumi_episodes.go.
	staleAfter := func() pgtype.Interval {
		return pgtype.Interval{Microseconds: (26 * time.Hour).Microseconds(), Valid: true}
	}

	t.Run("the predicate admits exactly the airing, bound, stale rows", func(t *testing.T) {
		rows, err := q.ListReleasingEpisodeTitleCandidates(ctx, staleAfter(), 10)
		require.NoError(t, err)

		got := make([]int32, 0, len(rows))
		for _, r := range rows {
			got = append(got, r.AnilistID)
		}
		// Equal, not ElementsMatch: the order IS the property.
		assert.Equal(t, []int32{neverSweptA, neverSweptB, stampedStale}, got,
			"never-swept rows first (by id among themselves), then the stale-stamped one — even though the stamped row has the lowest id")

		assert.NotContains(t, got, int32(stampedFresh),
			"25 hours is inside a 26-hour window: re-asking that soon returns the client's cached body, writes nothing, and burns the row's slot for the day")
		assert.NotContains(t, got, int32(finished),
			"a finished show's titles are settled; the one-off backfill owns those, and keeping them out is what lets this sweep run on one timestamp with no outcome bookkeeping")
		assert.NotContains(t, got, int32(unbound),
			"there is no upstream subject to ask about")

		require.Len(t, rows, 3)
		for _, r := range rows {
			require.NotNil(t, r.BgmID,
				"bgm_id must come back non-NULL for id %d — the caller fetches with it and the predicate already promised it exists", r.AnilistID)
		}
		assert.Equal(t, int32(5002), *rows[0].BgmID, "each row must carry ITS OWN binding")
		assert.Equal(t, int32(5001), *rows[2].BgmID)
	})

	t.Run("rowLimit truncates the ordered prefix", func(t *testing.T) {
		// The batch bound is what keeps one pass from taking the whole airing
		// slice at once; it must cut from the BACK of the order, so a smaller
		// limit is a prefix of the larger result rather than a different set.
		rows, err := q.ListReleasingEpisodeTitleCandidates(ctx, staleAfter(), 2)
		require.NoError(t, err)
		require.Len(t, rows, 2)
		assert.Equal(t, int32(neverSweptA), rows[0].AnilistID)
		assert.Equal(t, int32(neverSweptB), rows[1].AnilistID)
	})

	t.Run("a wider staleness window admits the recently-swept row", func(t *testing.T) {
		// Proves stampedFresh was excluded by the interval PARAMETER rather
		// than by something else about the row — without this, a query that
		// ignored stale_after entirely and hard-coded a threshold would pass
		// the first subtest.
		wide := pgtype.Interval{Microseconds: (1 * time.Hour).Microseconds(), Valid: true}
		rows, err := q.ListReleasingEpisodeTitleCandidates(ctx, wide, 10)
		require.NoError(t, err)

		got := make([]int32, 0, len(rows))
		for _, r := range rows {
			got = append(got, r.AnilistID)
		}
		assert.Equal(t, []int32{neverSweptA, neverSweptB, stampedStale, stampedFresh}, got,
			"never-swept first, then OLDEST-swept: the ordering is ascending on the timestamp, so the row swept 27 hours ago is served before the one swept 25 hours ago")
	})
}

// ---------------------------------------------------------------------------
// H.  The attempt stamp
// ---------------------------------------------------------------------------

// etReadStamp returns anime_cache.episode_titles_at plus whether the DATABASE
// considers it recent.
//
// Freshness is evaluated inside Postgres, against the same now() the stamp was
// written from, rather than by comparing to a Go-side time.Now(): the two
// clocks are not the same clock, and a skewed container would fail this for a
// reason that has nothing to do with the statement under test.
func etReadStamp(t *testing.T, ctx context.Context, pool *pgxpool.Pool, anilistID int32) (pgtype.Timestamptz, bool) {
	t.Helper()
	var stamp pgtype.Timestamptz
	var fresh *bool
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT episode_titles_at,
		       episode_titles_at > now() - interval '1 minute'
		FROM anime_cache
		WHERE anilist_id = $1`, anilistID).Scan(&stamp, &fresh),
		"read episode_titles_at for %d", anilistID)
	return stamp, fresh != nil && *fresh
}

// TestEpisodeTitleTouchStamp covers the write that makes the sweep terminate.
//
// The stamp is an ATTEMPT stamp, not a success stamp: it is written whether or
// not the pass produced a title, and that is precisely what stops a show whose
// upstream has nothing from holding the front of every batch and starving the
// rows behind it (0029 section C, and 0015's arithmetic before it).  The
// binding predicate is the same race guard as the upsert's: a row re-bound
// during the fetch must NOT be stamped, so the next pass re-asks under the
// binding it now holds rather than resting on an attempt made against the old
// one.
func TestEpisodeTitleTouchStamp(t *testing.T) {
	ctx := testCtx(t)
	pool := newPGPool(t, ctx)
	testutil.TruncateAll(t, ctx, pool)
	q := dbgen.New(pool)

	const (
		stampedID = 7700800
		reboundID = 7700810
		boundBgm  = 4321
		otherBgm  = 8765
	)

	t.Run("a matching binding stamps the row", func(t *testing.T) {
		etSeedSweepAnime(t, ctx, pool, stampedID, boundBgm, "RELEASING", "")
		before, _ := etReadStamp(t, ctx, pool, stampedID)
		require.False(t, before.Valid, "the fixture starts never-swept, or the assertion below proves nothing")

		rows, err := q.TouchEpisodeTitlesAt(ctx, stampedID, boundBgm)
		require.NoError(t, err)
		assert.Equal(t, int64(1), rows)

		after, fresh := etReadStamp(t, ctx, pool, stampedID)
		assert.True(t, after.Valid, "episode_titles_at must no longer be NULL")
		assert.True(t, fresh, "the stamp must be now(), not some inherited value (got %v)", after.Time)
	})

	t.Run("a row re-bound during the fetch is not stamped", func(t *testing.T) {
		// Seeded with an OLD stamp rather than NULL: NULL over NULL is
		// indistinguishable from a no-op, so a statement that dropped its
		// bgm_id predicate would still pass against a never-swept fixture only
		// by luck.  Here a stray write would visibly move the clock.
		etSeedSweepAnime(t, ctx, pool, reboundID, boundBgm, "RELEASING", "30 days")
		before, beforeFresh := etReadStamp(t, ctx, pool, reboundID)
		require.True(t, before.Valid)
		require.False(t, beforeFresh, "the fixture's stamp must start stale")

		rows, err := q.TouchEpisodeTitlesAt(ctx, reboundID, otherBgm)
		require.NoError(t, err, "a lost race is a zero-row result, not an error")
		assert.Equal(t, int64(0), rows, "the binding no longer matches, so there is nothing to stamp")

		after, afterFresh := etReadStamp(t, ctx, pool, reboundID)
		assert.False(t, afterFresh, "the column must not have been advanced to now()")
		assert.True(t, after.Time.Equal(before.Time),
			"the stamp must be byte-for-byte what it was (%v -> %v)", before.Time, after.Time)
	})
}
