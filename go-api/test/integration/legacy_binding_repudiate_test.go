//go:build integration

// legacy_binding_repudiate_test.go — RepudiateLegacyBangumiBinding against a
// real Postgres.
//
// The statement withdraws a pre-0011 binding together with everything that
// was copied out of it.  Two things can only be shown against a database:
//
//   - WHAT it clears.  Five data-modifying parts share one snapshot, and the
//     episode-title half splits rows by source, so the interesting failures
//     are a manual correction deleted along with the Bangumi names, or an
//     OpenCC title left behind after the title it was converted from is gone.
//   - WHICH rows it may touch.  The worker checks the same guards before it
//     calls, but the statement is the last line and must refuse on its own:
//     a moved binding, a recorded source, a human correction, an id-map
//     entry naming the pair.  Each refusal also has to leave the child
//     tables alone, which is a property of the CTEs joining through `target`
//     and not of the UPDATE.
//
// The fixture is the production row that motivated the statement: AniList
// 195604 (ブラッククローバー 第2期) bound to Bangumi 75989 (ラブライブ! 第2期),
// carrying that subject's name_cn as its Chinese title.  Ids are offset into
// a range no catalogue row uses.
//
// Hermeticity: one transaction, rolled back in t.Cleanup.
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
)

const (
	repudiateWrong     = int32(9960001) // the 195604 shape: legacy binding to another work
	repudiateKeepsHant = int32(9960002) // title_hant from a dataset, not a conversion
	repudiateMoved     = int32(9960003) // binding changed since the subject was fetched
	repudiateScored    = int32(9960004) // bound by the V1 scorer (source recorded)
	repudiateCorrected = int32(9960005) // an admin corrected it
	repudiateMapped    = int32(9960006) // the id map names this exact pair

	repudiateSubj      = int32(9970001)
	repudiateSubjOther = int32(9970009)
)

func TestRepudiateLegacyBangumiBinding(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	var held int
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT count(*) FROM anime_cache WHERE anilist_id BETWEEN 9960000 AND 9969999
		   OR bgm_id BETWEEN 9970000 AND 9979999`).Scan(&held))
	require.Zero(t, held, "fixture id ranges must be unused before seeding")

	// seed writes a fully enriched legacy row: every column the statement is
	// supposed to clear holds a value, so a column it forgets stays visible.
	seed := func(anilistID, bgmID int32, source, adminFlag *string, hantSource string) {
		t.Helper()
		_, err := tx.Exec(ctx, `
			INSERT INTO anime_cache (
				anilist_id, title_native, title_romaji, season_year,
				bgm_id, bgm_match_source, admin_flag, bangumi_version,
				title_chinese, bangumi_score, bangumi_votes,
				title_hant, title_hant_source, title_hant_source_hash,
				episodes_bgm, episodes_bgm_at, episodes_bgm_attempted_at,
				episodes_bgm_outcome, episodes_bgm_reason,
				episode_titles_at, bangumi_rating_checked_at, bangumi_subject_unreadable_at)
			VALUES ($1, 'ブラッククローバー 第2期', 'Black Clover 2nd Season', 2026,
				$2, $3, $4, 3,
				'Love Live! 第二季', 7.3, 7545,
				'Love Live! 第二季(hant)', $5, 'hash',
				13, now(), now(), 'rejected', 'title similarity 0.17 below floor 0.45',
				now(), now(), now())`,
			anilistID, bgmID, source, adminFlag, hantSource)
		require.NoError(t, err, "seed anime_cache %d", anilistID)

		// Episode names in every shape the source split has to handle.
		_, err = tx.Exec(ctx, `
			INSERT INTO anime_episode_titles (anime_id, episode, name, name_source, name_cn, name_cn_source) VALUES
				($1, 1, 'もぎゅっと"love"で接近中!', 'bangumi', NULL, NULL),        -- Bangumi only
				($1, 2, '僕らのLIVE', 'bangumi', '我们的LIVE', 'bangumi'),          -- Bangumi, both halves
				($1, 3, 'Bangumi name', 'bangumi', '人工修正', 'manual'),            -- mixed: a human fixed the CN half
				($1, 4, 'dandanplay name', 'ddp', NULL, NULL),                     -- vouched for elsewhere
				($1, 5, NULL, NULL, NULL, NULL)                                     -- empty: the episode list's shape`,
			anilistID)
		require.NoError(t, err, "seed anime_episode_titles %d", anilistID)

		_, err = tx.Exec(ctx, `
			INSERT INTO anime_tags (anime_id, source, name, rank) VALUES
				($1, 'bangumi', '偶像', 120),
				($1, 'anilist', 'Magic', 90)`, anilistID)
		require.NoError(t, err, "seed anime_tags %d", anilistID)
	}
	str := func(s string) *string { return &s }
	seed(repudiateWrong, repudiateSubj, nil, nil, "opencc")
	seed(repudiateKeepsHant, repudiateSubj+1, nil, nil, "anilist")
	seed(repudiateMoved, repudiateSubjOther, nil, nil, "opencc")
	seed(repudiateScored, repudiateSubj+3, str("fuzzy_high"), nil, "opencc")
	seed(repudiateCorrected, repudiateSubj+4, nil, str("manually-corrected"), "opencc")
	seed(repudiateMapped, repudiateSubj+5, nil, nil, "opencc")
	_, err = tx.Exec(ctx, `INSERT INTO bgm_id_map (anilist_id, bgm_id) VALUES ($1, $2)`, repudiateMapped, repudiateSubj+5)
	require.NoError(t, err, "seed bgm_id_map")

	q := dbgen.New(tx)

	type rowState struct {
		bgmID         *int32
		titleChinese  *string
		score         *float64
		votes         *int32
		titleHant     *string
		hantSource    *string
		hantHash      *string
		episodesBgm   *int32
		ebgmOutcome   *string
		ebgmAttempted *string
		titlesAt      *string
		ratingAt      *string
		unreadableAt  *string
		version       int32
	}
	read := func(anilistID int32) rowState {
		t.Helper()
		var s rowState
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT bgm_id, title_chinese, bangumi_score::float8, bangumi_votes,
			       title_hant, title_hant_source, title_hant_source_hash,
			       episodes_bgm, episodes_bgm_outcome, episodes_bgm_attempted_at::text,
			       episode_titles_at::text, bangumi_rating_checked_at::text,
			       bangumi_subject_unreadable_at::text, bangumi_version
			FROM anime_cache WHERE anilist_id = $1`, anilistID).Scan(
			&s.bgmID, &s.titleChinese, &s.score, &s.votes,
			&s.titleHant, &s.hantSource, &s.hantHash,
			&s.episodesBgm, &s.ebgmOutcome, &s.ebgmAttempted,
			&s.titlesAt, &s.ratingAt, &s.unreadableAt, &s.version))
		return s
	}
	type titleRow struct {
		episode              int32
		name, nameCN         *string
		nameSource, cnSource *string
	}
	titles := func(anilistID int32) map[int32]titleRow {
		t.Helper()
		rows, err := tx.Query(ctx, `
			SELECT episode, name, name_cn, name_source, name_cn_source
			FROM anime_episode_titles WHERE anime_id = $1`, anilistID)
		require.NoError(t, err)
		defer rows.Close()
		out := map[int32]titleRow{}
		for rows.Next() {
			var r titleRow
			require.NoError(t, rows.Scan(&r.episode, &r.name, &r.nameCN, &r.nameSource, &r.cnSource))
			out[r.episode] = r
		}
		require.NoError(t, rows.Err())
		return out
	}
	tagSources := func(anilistID int32) []string {
		t.Helper()
		rows, err := tx.Query(ctx, `SELECT source FROM anime_tags WHERE anime_id = $1 ORDER BY source`, anilistID)
		require.NoError(t, err)
		defer rows.Close()
		var out []string
		for rows.Next() {
			var s string
			require.NoError(t, rows.Scan(&s))
			out = append(out, s)
		}
		require.NoError(t, rows.Err())
		return out
	}
	assertUntouched := func(t *testing.T, anilistID, bgmID int32) {
		t.Helper()
		s := read(anilistID)
		require.NotNil(t, s.bgmID)
		assert.Equal(t, bgmID, *s.bgmID, "a refused row keeps its binding")
		require.NotNil(t, s.titleChinese)
		assert.Equal(t, "Love Live! 第二季", *s.titleChinese)
		assert.Equal(t, int32(3), s.version)
		assert.Len(t, titles(anilistID), 5, "a refused row keeps every episode name")
		assert.Equal(t, []string{"anilist", "bangumi"}, tagSources(anilistID), "a refused row keeps its tags")
	}

	t.Run("a legacy binding to another work is withdrawn with everything copied from it", func(t *testing.T) {
		n, err := q.RepudiateLegacyBangumiBinding(ctx, repudiateWrong, repudiateSubj)
		require.NoError(t, err)
		assert.EqualValues(t, 1, n)

		s := read(repudiateWrong)
		assert.Nil(t, s.bgmID, "the binding itself")
		assert.Nil(t, s.titleChinese, "the other show's name_cn")
		assert.Nil(t, s.score, "the other show's rating")
		assert.Nil(t, s.votes)
		assert.Nil(t, s.titleHant, "an OpenCC conversion of the title being withdrawn")
		assert.Nil(t, s.hantSource)
		assert.Nil(t, s.hantHash)
		assert.Nil(t, s.episodesBgm, "a count inferred from the other show's episode list")
		assert.Nil(t, s.ebgmOutcome)
		assert.Nil(t, s.ebgmAttempted)
		assert.Nil(t, s.titlesAt, "stamps that mean 'attempted against this binding'")
		assert.Nil(t, s.ratingAt)
		assert.Nil(t, s.unreadableAt)
		assert.Equal(t, int32(0), s.version, "version 0 is what puts the row back in front of V1")

		got := titles(repudiateWrong)
		assert.NotContains(t, got, int32(1), "a Bangumi-only row is deleted")
		assert.NotContains(t, got, int32(2), "a row whose both halves are Bangumi's is deleted")
		assert.NotContains(t, got, int32(5), "an empty row is the other show's episode list too")
		if assert.Contains(t, got, int32(3), "a row a human touched survives") {
			assert.Nil(t, got[3].name, "its Bangumi half is withdrawn")
			assert.Nil(t, got[3].nameSource)
			require.NotNil(t, got[3].nameCN)
			assert.Equal(t, "人工修正", *got[3].nameCN, "the manual half is kept")
			require.NotNil(t, got[3].cnSource)
			assert.Equal(t, "manual", *got[3].cnSource)
		}
		if assert.Contains(t, got, int32(4), "dandanplay names were vouched for by its own cross-link") {
			require.NotNil(t, got[4].name)
			assert.Equal(t, "dandanplay name", *got[4].name)
		}

		assert.Equal(t, []string{"anilist"}, tagSources(repudiateWrong), "Bangumi tags go, AniList tags stay")
	})

	t.Run("a Traditional title from a dataset is not a conversion and is kept", func(t *testing.T) {
		n, err := q.RepudiateLegacyBangumiBinding(ctx, repudiateKeepsHant, repudiateSubj+1)
		require.NoError(t, err)
		assert.EqualValues(t, 1, n)

		s := read(repudiateKeepsHant)
		assert.Nil(t, s.titleChinese)
		require.NotNil(t, s.titleHant, "AniList's own zh-Hant title did not come from the binding")
		require.NotNil(t, s.hantSource)
		assert.Equal(t, "anilist", *s.hantSource)
	})

	t.Run("a binding that moved since the fetch is left alone, children included", func(t *testing.T) {
		n, err := q.RepudiateLegacyBangumiBinding(ctx, repudiateMoved, repudiateSubj)
		require.NoError(t, err)
		assert.Zero(t, n, "the verdict was about a subject this row no longer holds")
		assertUntouched(t, repudiateMoved, repudiateSubjOther)
	})

	t.Run("a binding with a recorded source is not legacy", func(t *testing.T) {
		n, err := q.RepudiateLegacyBangumiBinding(ctx, repudiateScored, repudiateSubj+3)
		require.NoError(t, err)
		assert.Zero(t, n)
		assertUntouched(t, repudiateScored, repudiateSubj+3)
	})

	t.Run("an admin correction outranks the check", func(t *testing.T) {
		n, err := q.RepudiateLegacyBangumiBinding(ctx, repudiateCorrected, repudiateSubj+4)
		require.NoError(t, err)
		assert.Zero(t, n)
		assertUntouched(t, repudiateCorrected, repudiateSubj+4)
	})

	t.Run("an id-map entry naming the pair outranks the check", func(t *testing.T) {
		n, err := q.RepudiateLegacyBangumiBinding(ctx, repudiateMapped, repudiateSubj+5)
		require.NoError(t, err)
		assert.Zero(t, n)
		assertUntouched(t, repudiateMapped, repudiateSubj+5)
	})

	t.Run("the withdrawn row is V1's work again and no longer the rating sweep's", func(t *testing.T) {
		ids, err := q.ListUnenrichedAnilistIDs(ctx, 100000, 0)
		require.NoError(t, err)
		assert.Contains(t, ids, repudiateWrong, "the orphan scan must offer it to V1")

		identity, err := q.GetBangumiBindingIdentity(ctx, repudiateWrong)
		require.NoError(t, err)
		assert.Nil(t, identity.BgmID, "nothing left for the rating sweep or V2 to read")
	})

	t.Run("the identity read returns what the check compares", func(t *testing.T) {
		identity, err := q.GetBangumiBindingIdentity(ctx, repudiateMapped)
		require.NoError(t, err)
		assert.True(t, identity.IDMapAgrees, "the map names this pair")
		require.NotNil(t, identity.TitleNative)
		assert.Equal(t, "ブラッククローバー 第2期", *identity.TitleNative)
		require.NotNil(t, identity.SeasonYear)
		assert.Equal(t, int32(2026), *identity.SeasonYear)

		identity, err = q.GetBangumiBindingIdentity(ctx, repudiateScored)
		require.NoError(t, err)
		assert.False(t, identity.IDMapAgrees, "no map row is not agreement")
		require.NotNil(t, identity.BgmMatchSource)
		assert.Equal(t, "fuzzy_high", *identity.BgmMatchSource)
	})
}
