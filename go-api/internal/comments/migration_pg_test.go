package comments

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// engagementTableShapeAfter0028 is community_engagement_daily as 0020 created
// it and 0028 widened it, read off a schema migrated up through 0054 with
// engagementTableShape.  0055's down migration has to reproduce it line for
// line.
var engagementTableShapeAfter0028 = []string{
	"column 01 event_date date NOT NULL DEFAULT CURRENT_DATE",
	"column 02 event_type text NOT NULL",
	"column 03 source text NOT NULL",
	"column 04 anilist_id integer NOT NULL DEFAULT 0",
	"column 05 episode integer NOT NULL DEFAULT 0",
	"column 06 authenticated boolean NOT NULL DEFAULT false",
	"column 07 event_count bigint NOT NULL DEFAULT 0",
	"column 08 updated_at timestamp with time zone NOT NULL DEFAULT now()",
	"constraint community_engagement_count_chk CHECK ((event_count >= 0))",
	"constraint community_engagement_daily_pkey PRIMARY KEY (event_date, event_type, source, anilist_id, episode, authenticated)",
	"constraint community_engagement_event_type_chk CHECK ((event_type = ANY (ARRAY['hot_discussions_impression'::text, 'discussion_open'::text, 'welcome_card_impression'::text, 'welcome_card_open'::text])))",
	"constraint community_engagement_source_chk CHECK ((source = ANY (ARRAY['home'::text, 'seasonal'::text])))",
	"constraint community_engagement_target_chk CHECK ((((event_type = ANY (ARRAY['hot_discussions_impression'::text, 'welcome_card_impression'::text, 'welcome_card_open'::text])) AND (anilist_id = 0) AND (episode = 0)) OR ((event_type = 'discussion_open'::text) AND (anilist_id > 0) AND (episode > 0))))",
	"index CREATE INDEX idx_community_engagement_daily_date ON public.community_engagement_daily USING btree (event_date DESC, event_type, source)",
	"index CREATE UNIQUE INDEX community_engagement_daily_pkey ON public.community_engagement_daily USING btree (event_date, event_type, source, anilist_id, episode, authenticated)",
}

// engagementTableShape renders community_engagement_daily from the catalog:
// every column in order with its type, nullability and default, every
// constraint by name with its definition, and every index with its
// definition.  Two tables with the same shape here accept and reject exactly
// the same rows.
func engagementTableShape(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT 'column ' || lpad(a.attnum::text, 2, '0') || ' ' || a.attname || ' '
		       || format_type(a.atttypid, a.atttypmod)
		       || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
		       || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
		FROM pg_attribute a
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE a.attrelid = 'community_engagement_daily'::regclass
		  AND a.attnum > 0
		  AND NOT a.attisdropped
		UNION ALL
		SELECT 'constraint ' || conname || ' ' || pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'community_engagement_daily'::regclass
		UNION ALL
		SELECT 'index ' || indexdef
		FROM pg_indexes
		WHERE tablename = 'community_engagement_daily'
		ORDER BY 1`)
	require.NoError(t, err)
	shape, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err)
	return shape
}

// TestMigration0055_PG checks that 0055 drops the engagement counters, that
// its down migration brings the table back exactly as 0020 + 0028 built it
// but without its rows, and that the trending query's index -- created by
// 0020 next to the counters -- survives every step.  A drop that took the
// index too would leave the trending endpoint correct and quietly slower,
// which no handler test can see.
func TestMigration0055_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)

	tableExists := func() bool {
		t.Helper()
		var name *string
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT to_regclass('community_engagement_daily')::text`).Scan(&name))
		return name != nil
	}
	trendingIndexes := func() int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT count(*)
			FROM pg_indexes
			WHERE tablename = 'episode_comments'
			  AND indexname = 'idx_episode_comments_recent_discovery'`).Scan(&n))
		return n
	}
	engagementRows := func() int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT count(*) FROM community_engagement_daily`).Scan(&n))
		return n
	}

	t.Run("up drops the counters and keeps the trending index", func(t *testing.T) {
		assert.False(t, tableExists())
		assert.Equal(t, 1, trendingIndexes())
	})

	t.Run("down recreates the table exactly as 0020 + 0028 left it", func(t *testing.T) {
		testutil.MigrateTo(t, uri, 54)
		require.True(t, tableExists())
		assert.Equal(t, engagementTableShapeAfter0028, engagementTableShape(t, ctx, pool))
		assert.Equal(t, 1, trendingIndexes())
	})

	t.Run("rows dropped by up do not come back with down", func(t *testing.T) {
		_, err := pool.Exec(ctx, `
			INSERT INTO community_engagement_daily (event_type, source, event_count)
			VALUES ('welcome_card_impression', 'home', 3)`)
		require.NoError(t, err)
		require.Equal(t, 1, engagementRows())

		testutil.MigrateTo(t, uri, 55)
		assert.False(t, tableExists())
		testutil.MigrateTo(t, uri, 54)
		assert.Zero(t, engagementRows(), "the down migration restores the table, not its data")
	})

	testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
	assert.False(t, tableExists())
	assert.Equal(t, 1, trendingIndexes())
}
