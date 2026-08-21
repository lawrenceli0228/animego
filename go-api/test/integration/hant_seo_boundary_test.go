//go:build integration

package integration

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The SERP boundary is the load-bearing claim of migration 0022, and it is a
// claim about the database rather than about the code that reads it.
//
// The rule: a machine-converted Traditional title must never reach <title>,
// og:title, or JSON-LD name.  Simplified-to-Traditional conversion is a
// character mapping with a vocabulary layer on top; it does not know that
// Taiwan calls the show 進擊的巨人 and it cannot invent 鬼滅之刃.  Measured
// sentence accuracy is 85.3%, and the 15.4% it cannot produce correlates with
// popularity, so the errors land exactly on the titles people search for.
//
// Migration 0014 wrote the equivalent rule for description_cn as a comment and
// left enforcement to the writers.  That was enough while one job wrote the
// column.  It stopped being enough here: twelve queries project title_hant,
// nine hand-written DTOs carry it, and a reviewer looking at a render site
// cannot see whether the value beneath it was machine made.  So 0022 gives the
// safe value its own generated column and the SEO code reads that one.
//
// These tests exist because a generated column is only a boundary if it
// actually generates.  Every assertion below fails loudly if someone widens
// the source vocabulary, "simplifies" the CASE expression, or converts the
// column to a plain one during a future rewrite -- all of which would leave
// the application compiling, the queries succeeding, and machine-translated
// titles quietly flowing into Google.
func TestHantSeoBoundary(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)
	cli := newMongoClient(t, ctx)
	resetState(t, ctx, pool, cli)

	// One row per source value the CHECK admits, plus the unattributed case.
	// The ids are arbitrary but distinct so a failure names the row.
	rows := []struct {
		anilistID int
		title     string
		source    *string // nil => SQL NULL
		wantSEO   bool    // should title_hant_seo carry the title?
		why       string
	}{
		{80001, "進擊的巨人", ptr("wikipedia"), true, "a Hong Kong editor wrote it"},
		{80002, "鬼滅之刃", ptr("anilist"), true, "a Taiwanese dataset curator wrote it"},
		{80003, "咒術迴戰", ptr("manual"), true, "a human here wrote it"},
		{80004, "葬送的芙莉蓮", ptr("opencc"), false, "a character table produced it"},
		{80005, "無職轉生", nil, false, "nothing claims responsibility for it"},
	}

	for _, r := range rows {
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, title_chinese, title_hant, title_hant_source)
			VALUES ($1, $2, $3, $4)`,
			r.anilistID, "simplified placeholder", r.title, r.source,
		)
		require.NoError(t, err, "seed %d", r.anilistID)
	}

	t.Run("only human-sourced titles are exposed to search engines", func(t *testing.T) {
		for _, r := range rows {
			var seo *string
			err := pool.QueryRow(ctx,
				`SELECT title_hant_seo FROM anime_cache WHERE anilist_id=$1`, r.anilistID,
			).Scan(&seo)
			require.NoError(t, err)

			if r.wantSEO {
				require.NotNil(t, seo, "row %d (%s) should be SERP-eligible: %s", r.anilistID, deref(r.source), r.why)
				assert.Equal(t, r.title, *seo, "the exposed value must be the title itself, not a transform of it")
			} else {
				assert.Nil(t, seo, "row %d (%s) must NOT reach a search engine: %s", r.anilistID, deref(r.source), r.why)
			}
		}
	})

	// The interesting failure is not "opencc leaks on insert" -- it is
	// "a row was written by a dataset, then a later sweep overwrote it with a
	// conversion, and the SEO projection kept the old human value".  A STORED
	// generated column recomputes on UPDATE; a trigger-maintained one written
	// carelessly would not.  This is the test that tells them apart.
	t.Run("demoting a title to a machine source withdraws it from search", func(t *testing.T) {
		_, err := pool.Exec(ctx, `
			UPDATE anime_cache SET title_hant=$1, title_hant_source='opencc' WHERE anilist_id=$2`,
			"進擊的巨人", 80002,
		)
		require.NoError(t, err)

		var seo *string
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT title_hant_seo FROM anime_cache WHERE anilist_id=$1`, 80002).Scan(&seo))
		assert.Nil(t, seo, "the projection must follow the source on UPDATE, not just on INSERT")
	})

	t.Run("promoting a title to a human source restores it", func(t *testing.T) {
		_, err := pool.Exec(ctx, `
			UPDATE anime_cache SET title_hant_source='manual' WHERE anilist_id=$1`, 80004)
		require.NoError(t, err)

		var seo *string
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT title_hant_seo FROM anime_cache WHERE anilist_id=$1`, 80004).Scan(&seo))
		require.NotNil(t, seo, "a human sign-off should make an opencc row publishable")
		assert.Equal(t, "葬送的芙莉蓮", *seo)
	})

	// A boundary that a writer can step over is not a boundary.  Postgres
	// refuses direct writes to a generated column; this pins that we are
	// relying on a real generated column and not, say, a plain text column
	// that some backfill happens to keep in sync today.
	t.Run("the column cannot be written directly", func(t *testing.T) {
		_, err := pool.Exec(ctx, `
			UPDATE anime_cache SET title_hant_seo='偷渡的標題' WHERE anilist_id=$1`, 80004)
		require.Error(t, err, "a writer must not be able to hand-place a value into the SERP projection")

		// Match on SQLSTATE, not on the message. Postgres words this as
		// "can only be updated to DEFAULT" rather than mentioning generation,
		// and the wording is free to change between releases; 428C9 is not.
		var pgErr *pgconn.PgError
		require.ErrorAs(t, err, &pgErr, "expected a Postgres error, got: %v", err)
		assert.Equal(t, "428C9", pgErr.Code,
			"expected ERRCODE_GENERATED_ALWAYS; got %s: %s", pgErr.Code, pgErr.Message)
	})

	t.Run("the source vocabulary is constrained", func(t *testing.T) {
		_, err := pool.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, title_hant, title_hant_source)
			VALUES (80006, '測試', 'gpt-5')`)
		require.Error(t, err, "an unrecognised provenance must not be storable")
		assert.Contains(t, err.Error(), "anime_cache_title_hant_source_check")

		// description_hant is narrower on purpose: no dataset carries a
		// Traditional synopsis, so 'anilist' would name a tier that does not
		// exist.  If someone widens it, they should have to change this test.
		_, err = pool.Exec(ctx, `
			INSERT INTO anime_cache (anilist_id, description_hant, description_hant_source)
			VALUES (80007, '測試簡介', 'anilist')`)
		require.Error(t, err, "description_hant has only conversion and human tiers")
		assert.Contains(t, err.Error(), "anime_cache_description_hant_source_check")
	})

	// The expression is a whitelist rather than "<> 'opencc'" so that a future
	// migration widening the CHECK without touching the projection leaves the
	// new tier OUT of search results rather than silently in them.  Admitting
	// a source to the SERP should cost a migration.  Assert the shape, since
	// the behavioural difference only appears in a migration nobody has
	// written yet -- by which time this test is the only surviving record of
	// why it was written this way.
	t.Run("the projection fails closed", func(t *testing.T) {
		var expr string
		err := pool.QueryRow(ctx, `
			SELECT pg_get_expr(d.adbin, d.adrelid)
			  FROM pg_attrdef d
			  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
			 WHERE d.adrelid = 'anime_cache'::regclass AND a.attname = 'title_hant_seo'`,
		).Scan(&expr)
		require.NoError(t, err, "title_hant_seo must have a generation expression")

		assert.NotContains(t, expr, "opencc",
			"the expression must name the sources it ADMITS, not the one it excludes -- "+
				"a denylist silently admits every tier added after it was written")
		for _, allowed := range []string{"wikipedia", "anilist", "manual"} {
			assert.Contains(t, expr, allowed, "%q should be an admitted source", allowed)
		}

		// attgenerated is "char" (OID 18), not text -- pgx cannot scan that
		// into a *string in binary format, so cast it server-side.
		var generated string
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT attgenerated::text FROM pg_attribute
			 WHERE attrelid='anime_cache'::regclass AND attname='title_hant_seo'`).Scan(&generated))
		assert.Equal(t, "s", generated, "must be STORED (attgenerated='s'), not a plain default")
	})

	// search_vec is GENERATED over the four original title columns and does
	// NOT include title_hant.  That is deliberate -- widening it on PG16 means
	// dropping and re-adding the column plus rebuilding a GIN index, and
	// search_vec has no application consumer.  Recorded as a test so the
	// omission reads as a decision rather than an oversight when someone
	// wonders why a Traditional-only title is unsearchable.
	t.Run("search_vec deliberately excludes title_hant", func(t *testing.T) {
		var expr string
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT pg_get_expr(d.adbin, d.adrelid)
			  FROM pg_attrdef d
			  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
			 WHERE d.adrelid = 'anime_cache'::regclass AND a.attname = 'search_vec'`).Scan(&expr))
		assert.NotContains(t, expr, "title_hant",
			"if this changed, the omission note in 0022 and anime/handlers.go:484 both need updating")
	})
}

func ptr(s string) *string { return &s }

func deref(s *string) string {
	if s == nil {
		return "NULL"
	}
	return *s
}
