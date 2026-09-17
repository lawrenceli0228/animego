package anime

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestMigration0040_DeletesWhatKeepSynonymRefuses — the SQL allowlist in
// migration 0040 and the Go allowlist in anilist.KeepSynonym are two
// spellings of one table of code-point ranges. This drives both from the
// same list of cases: every synonym KeepSynonym refuses must be gone after
// the migration, and every one it keeps must still be there. A range edited
// on one side and not the other fails here, not in production.
func TestMigration0040_DeletesWhatKeepSynonymRefuses(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)

	testutil.MigrateTo(t, uri, 39)
	_, err := pool.Exec(ctx, `INSERT INTO anime_cache (anilist_id, title_romaji) VALUES (1, 'row')`)
	require.NoError(t, err)
	for _, c := range testutil.SynonymScriptCases {
		_, err := pool.Exec(ctx, `INSERT INTO anime_synonyms (anime_id, synonym) VALUES (1, $1)`, c.Synonym)
		require.NoError(t, err, "seed %q", c.Synonym)
	}

	testutil.MigrateTo(t, uri, 40)

	rows, err := pool.Query(ctx, `SELECT synonym FROM anime_synonyms WHERE anime_id = 1`)
	require.NoError(t, err)
	kept := map[string]bool{}
	for rows.Next() {
		var s string
		require.NoError(t, rows.Scan(&s))
		kept[s] = true
	}
	rows.Close()
	require.NoError(t, rows.Err())

	for _, c := range testutil.SynonymScriptCases {
		assert.Equal(t, c.Keep, kept[c.Synonym], "%q: KeepSynonym=%v, survived migration=%v", c.Synonym, c.Keep, kept[c.Synonym])
		assert.Equal(t, c.Keep, anilist.KeepSynonym(c.Synonym), "%q: the case table disagrees with KeepSynonym itself", c.Synonym)
	}

	testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
}
