package admin

// list_enrichment_test.go — pure unit tests for the SQL builder.
// Verifies every filter / q / sort / order branch without needing
// a live Postgres (the handler-level test covers the executed-SQL
// integration path).

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildEnrichmentListSQL_NoFilters_DefaultSort(t *testing.T) {
	t.Parallel()

	listSQL, countSQL, args := buildEnrichmentListSQL(enrichmentListParams{Page: 1})

	assert.NotContains(t, listSQL, " WHERE ")
	assert.NotContains(t, countSQL, " WHERE ")
	assert.Contains(t, listSQL, "ORDER BY cached_at DESC")
	assert.Contains(t, listSQL, "LIMIT 30")
	assert.Contains(t, listSQL, "OFFSET 0")
	assert.Empty(t, args)
}

func TestBuildEnrichmentListSQL_FilterNeedsReview(t *testing.T) {
	t.Parallel()

	listSQL, countSQL, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:   1,
		Filter: "needs-review",
	})

	assert.Contains(t, listSQL, " WHERE admin_flag = $1")
	assert.Contains(t, countSQL, " WHERE admin_flag = $1")
	require.Len(t, args, 1)
	assert.Equal(t, "needs-review", args[0])
}

func TestBuildEnrichmentListSQL_FilterManuallyCorrected(t *testing.T) {
	t.Parallel()

	listSQL, _, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:   1,
		Filter: "manually-corrected",
	})

	assert.Contains(t, listSQL, " WHERE admin_flag = $1")
	require.Len(t, args, 1)
	assert.Equal(t, "manually-corrected", args[0])
}

func TestBuildEnrichmentListSQL_FilterUnenriched(t *testing.T) {
	t.Parallel()

	listSQL, _, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:   1,
		Filter: "unenriched",
	})

	assert.Contains(t, listSQL, " WHERE bangumi_version = $1")
	require.Len(t, args, 1)
	assert.Equal(t, int32(0), args[0])
}

func TestBuildEnrichmentListSQL_FilterNoCN_NoParam(t *testing.T) {
	t.Parallel()

	listSQL, _, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:   1,
		Filter: "no-cn",
	})

	// no-cn uses literal column predicates — no parameters
	assert.Contains(t, listSQL, "bgm_id IS NOT NULL AND title_chinese IS NULL")
	assert.Empty(t, args)
}

func TestBuildEnrichmentListSQL_FilterUnknown_NoWhere(t *testing.T) {
	t.Parallel()

	listSQL, _, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:   1,
		Filter: "garbage-value",
	})

	assert.NotContains(t, listSQL, " WHERE ")
	assert.Empty(t, args)
}

func TestBuildEnrichmentListSQL_QueryStrictInteger_AnilistID(t *testing.T) {
	t.Parallel()

	listSQL, countSQL, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:  1,
		Query: "12345",
	})

	assert.Contains(t, listSQL, "anilist_id = $1")
	assert.Contains(t, countSQL, "anilist_id = $1")
	require.Len(t, args, 1)
	assert.Equal(t, int32(12345), args[0])
}

func TestBuildEnrichmentListSQL_QueryLeadingZero_FallsToILIKE(t *testing.T) {
	t.Parallel()

	// "01" parses to 1 but strconv.Itoa(1) != "01" → strict-int check fails
	listSQL, _, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:  1,
		Query: "01",
	})

	// Falls through to ILIKE on 3 title fields, sharing $1 placeholder.
	assert.Contains(t, listSQL, "title_romaji ILIKE $1")
	assert.Contains(t, listSQL, "title_chinese ILIKE $1")
	assert.Contains(t, listSQL, "title_native ILIKE $1")
	require.Len(t, args, 1)
	assert.Equal(t, "%01%", args[0])
}

func TestBuildEnrichmentListSQL_QueryText_ILIKEPattern(t *testing.T) {
	t.Parallel()

	listSQL, countSQL, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:  1,
		Query: "进击的",
	})

	assert.Contains(t, listSQL, "title_romaji ILIKE $1")
	assert.Contains(t, listSQL, "title_chinese ILIKE $1")
	assert.Contains(t, listSQL, "title_native ILIKE $1")
	assert.Contains(t, countSQL, "ILIKE $1")
	require.Len(t, args, 1)
	assert.Equal(t, "%进击的%", args[0])
}

func TestBuildEnrichmentListSQL_QueryEscapesLIKEMetacharacters(t *testing.T) {
	t.Parallel()

	_, _, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:  1,
		Query: "100%_x",
	})

	require.Len(t, args, 1)
	assert.Equal(t, `%100\%\_x%`, args[0], "%, _, and the escape char should be backslash-escaped")
}

func TestBuildEnrichmentListSQL_QueryEmptyAfterTrim(t *testing.T) {
	t.Parallel()

	listSQL, _, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:  1,
		Query: "   ",
	})

	assert.NotContains(t, listSQL, "ILIKE")
	assert.NotContains(t, listSQL, " WHERE ")
	assert.Empty(t, args)
}

func TestBuildEnrichmentListSQL_FilterAndQueryANDed(t *testing.T) {
	t.Parallel()

	listSQL, _, args := buildEnrichmentListSQL(enrichmentListParams{
		Page:   1,
		Filter: "needs-review",
		Query:  "test",
	})

	assert.Contains(t, listSQL, " WHERE ")
	assert.Contains(t, listSQL, " AND ")
	assert.Contains(t, listSQL, "admin_flag = $1")
	assert.Contains(t, listSQL, "title_romaji ILIKE $2")
	require.Len(t, args, 2)
	assert.Equal(t, "needs-review", args[0])
	assert.Equal(t, "%test%", args[1])
}

func TestBuildEnrichmentListSQL_SortAllowList(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		input   string
		wantCol string
	}{
		{"cachedAt alias", "cachedAt", "cached_at"},
		{"cached_at direct", "cached_at", "cached_at"},
		{"titleChinese alias", "titleChinese", "title_chinese"},
		{"title_chinese direct", "title_chinese", "title_chinese"},
		{"titleRomaji alias", "titleRomaji", "title_romaji"},
		{"bangumi_version", "bangumi_version", "bangumi_version"},
		{"bangumiScore alias", "bangumiScore", "bangumi_score"},
		{"anilistId alias", "anilistId", "anilist_id"},
		{"unknown → default cached_at", "garbage", "cached_at"},
		{"empty → default cached_at", "", "cached_at"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			listSQL, _, _ := buildEnrichmentListSQL(enrichmentListParams{
				Page:      1,
				SortField: tc.input,
			})
			assert.Contains(t, listSQL, "ORDER BY "+tc.wantCol+" DESC",
				"sort col mismatch for input %q", tc.input)
		})
	}
}

func TestBuildEnrichmentListSQL_OrderASCDESC(t *testing.T) {
	t.Parallel()

	asc, _, _ := buildEnrichmentListSQL(enrichmentListParams{
		Page:      1,
		SortField: "anilist_id",
		SortOrder: "asc",
	})
	desc, _, _ := buildEnrichmentListSQL(enrichmentListParams{
		Page:      1,
		SortField: "anilist_id",
		SortOrder: "desc",
	})
	other, _, _ := buildEnrichmentListSQL(enrichmentListParams{
		Page:      1,
		SortField: "anilist_id",
		SortOrder: "garbage",
	})

	assert.Contains(t, asc, "ORDER BY anilist_id ASC")
	assert.Contains(t, desc, "ORDER BY anilist_id DESC")
	assert.Contains(t, other, "ORDER BY anilist_id DESC", "non-asc value → DESC default")
}

func TestBuildEnrichmentListSQL_PageOffset(t *testing.T) {
	t.Parallel()

	one, _, _ := buildEnrichmentListSQL(enrichmentListParams{Page: 1})
	two, _, _ := buildEnrichmentListSQL(enrichmentListParams{Page: 2})
	five, _, _ := buildEnrichmentListSQL(enrichmentListParams{Page: 5})

	assert.Contains(t, one, "OFFSET 0")
	assert.Contains(t, two, "OFFSET 30")
	assert.Contains(t, five, "OFFSET 120")
}

func TestBuildEnrichmentListSQL_ProjectionMatchesExpress(t *testing.T) {
	t.Parallel()

	listSQL, _, _ := buildEnrichmentListSQL(enrichmentListParams{Page: 1})

	// Express .select('anilistId titleRomaji titleChinese bgmId
	// bangumiVersion bangumiScore adminFlag'), plus bgm_match_source —
	// the post-Express match-provenance column the admin table surfaces.
	for _, col := range []string{
		"anilist_id",
		"title_romaji",
		"title_chinese",
		"bgm_id",
		"bangumi_version",
		"bangumi_score",
		"admin_flag",
		"bgm_match_source",
	} {
		assert.True(t, strings.Contains(listSQL, col), "projection missing %s", col)
	}
}

func TestIsStrictInteger(t *testing.T) {
	t.Parallel()

	cases := []struct {
		input string
		want  bool
	}{
		{"0", true},
		{"1", true},
		{"12345", true},
		{"-5", true}, // Atoi accepts -5, Itoa(-5) = "-5"
		{"01", false},
		{"+1", false}, // Itoa(1)="1" != "+1"
		{"1.0", false},
		{" 1", false},
		{"1 ", false},
		{"", false},
		{"abc", false},
		{"1e2", false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, isStrictInteger(tc.input))
		})
	}
}

func TestEscapeLikePattern(t *testing.T) {
	t.Parallel()

	cases := []struct {
		input string
		want  string
	}{
		{"", ""},
		{"plain", "plain"},
		{"50%", `50\%`},
		{"a_b", `a\_b`},
		{`a\b`, `a\\b`},
		{"50%_done", `50\%\_done`},
		{"进击的", "进击的"}, // unicode passes through
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, escapeLikePattern(tc.input))
		})
	}
}
