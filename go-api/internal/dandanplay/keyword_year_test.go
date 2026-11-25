package dandanplay

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// A release year at the end of a file's title ("Hunter x Hunter 2011
// S01E05", "Super no Ura de Yani Suu Futari 2026 S01E11") is what tells a
// remake from its original — but anime_cache's titles do not carry it, and
// its tokenised ILIKE requires every keyword token to appear.

func TestSplitTrailingYear(t *testing.T) {
	cases := []struct {
		in   string
		base string
		year int32
	}{
		{"Hunter x Hunter 2011", "Hunter x Hunter", 2011},
		{"Super no Ura de Yani Suu Futari 2026", "Super no Ura de Yani Suu Futari", 2026},
		{"Ranma 1/2 2024", "Ranma 1/2", 2024},
		{"Kusuriya Season 3", "Kusuriya Season 3", 0},
		{"Mob Psycho 100", "Mob Psycho 100", 0},
		{"Uchuu Senkan Yamato 2199", "Uchuu Senkan Yamato 2199", 0},
		{"2011", "2011", 0},
		{"", "", 0},
	}
	for _, c := range cases {
		base, year := splitTrailingYear(c.in)
		assert.Equal(t, c.base, base, "base of %q", c.in)
		assert.Equal(t, c.year, year, "year of %q", c.in)
	}
}

func yearRow(anilistID, bgmID, year int32, romaji string) dbgen.SearchAnimeCacheForDandanplayRow {
	return dbgen.SearchAnimeCacheForDandanplayRow{
		AnilistID:   anilistID,
		BgmID:       i32Ptr(bgmID),
		TitleRomaji: strPtr(romaji),
		SeasonYear:  i32Ptr(year),
		Episodes:    i32Ptr(12),
	}
}

func phase2WithRows(t *testing.T, rows []dbgen.SearchAnimeCacheForDandanplayRow, keyword string) (int32, []string) {
	t.Helper()
	var patterns []string
	db := &fakeDB{
		searchFn: func(_ context.Context, p *string) ([]dbgen.SearchAnimeCacheForDandanplayRow, error) {
			patterns = append(patterns, *p)
			return rows, nil
		},
	}
	client := &fakeClient{
		episodesBgmFn: func(_ context.Context, id int32) (*EpisodeData, error) {
			return makeEpisodeData(int64(id), "x"), nil
		},
	}
	out := unmarshalMatch(t, postMatch(t, newTestHandlers(db, client, nil), MatchRequest{
		Keyword:  keyword,
		Episodes: []int{1},
	}))
	if !isMatched(t, out) {
		return 0, patterns
	}
	var source string
	require.NoError(t, json.Unmarshal(out["source"], &source))
	require.Equal(t, "animeCache", source)
	return matchedAnilistID(t, out), patterns
}

func TestMatch_Phase2_ATrailingYearPicksThatYearsEntry(t *testing.T) {
	rows := []dbgen.SearchAnimeCacheForDandanplayRow{
		yearRow(136, 51, 1999, "Hunter x Hunter"),
		yearRow(11061, 52, 2011, "Hunter x Hunter (2011)"),
	}
	got, patterns := phase2WithRows(t, rows, "Hunter x Hunter 2011")
	assert.Equal(t, int32(11061), got)
	require.NotEmpty(t, patterns)
	assert.False(t, strings.Contains(patterns[0], "2011"), "the year is not a title token: %q", patterns[0])
}

func TestMatch_Phase2_AYearNoEntryPremieredInStillMatches(t *testing.T) {
	// A WEB release tags the year it came out, which need not be the
	// year AniList files the show under.
	rows := []dbgen.SearchAnimeCacheForDandanplayRow{
		yearRow(196187, 61, 2025, "Super no Ura de Yani Suu Futari"),
	}
	got, _ := phase2WithRows(t, rows, "Super no Ura de Yani Suu Futari 2026")
	assert.Equal(t, int32(196187), got)
}
