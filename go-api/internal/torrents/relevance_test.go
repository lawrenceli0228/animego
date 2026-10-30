package torrents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Titles as stored for the two fixture shows, read from the public
// /api/anime/{id} endpoint on 2026-10-31 (titleRomaji, titleNative,
// titleEnglish, titleChinese, titleHant).
var (
	reZeroS4Titles = []string{
		"Re:Zero kara Hajimeru Isekai Seikatsu 4th Season",
		"Re:ゼロから始める異世界生活 4th season",
		"Re:ZERO -Starting Life in Another World- Season 4",
		"Re：从零开始的异世界生活 第四季 丧失篇",
		"Re：從零開始的異世界生活 4",
	}
	frierenS2Titles = []string{
		"Sousou no Frieren 2nd Season",
		"葬送のフリーレン 第2期",
		"Frieren: Beyond Journey’s End Season 2",
		"葬送的芙莉莲 第二季",
		"葬送的芙莉蓮 第二季",
	}
)

// relevanceFixtureRow is one row of testdata/relevance-*.json: the title
// and source of a row the live endpoint returned for the show on
// 2026-10-31, and whether it is a release of that show.  Magnets and
// infohashes are deliberately not stored.
type relevanceFixtureRow struct {
	Title    string `json:"title"`
	Source   string `json:"source"`
	Relevant bool   `json:"relevant"`
}

func loadRelevanceFixture(t *testing.T, name string) []relevanceFixtureRow {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	require.NoError(t, err)
	var rows []relevanceFixtureRow
	require.NoError(t, json.Unmarshal(raw, &rows))
	return rows
}

// TestFilterRelevant_ReZeroS4Fixture: of the 317 rows served for Re:Zero
// season 4, 128 are Re:Zero; the other 189 came from dmhy's keyword search
// matching "4th Season" (一念永恒 第4季, 转生史莱姆 第四季, Boku no Hero
// Academia 4th Season, 文豪野犬, 阿松, 东离剑游纪, 出租女友, 棒球大联盟,
// 零之使魔, 一骑当千, 游戏王5D's, JMAX OP/ED FLACs ...).  Exactly the 128
// must survive.
func TestFilterRelevant_ReZeroS4Fixture(t *testing.T) {
	t.Parallel()

	rows := loadRelevanceFixture(t, "relevance-189046.json")
	require.Len(t, rows, 317)

	m := newRelevanceMatcher(reZeroS4Titles)
	kept := 0
	for _, r := range rows {
		got := m.matches(r.Title)
		if got {
			kept++
		}
		assert.Equal(t, r.Relevant, got, "[%s] %s", r.Source, r.Title)
	}
	assert.Equal(t, 128, kept)
}

// TestFilterRelevant_FrierenS2Fixture: every one of the 312 rows served
// for Frieren season 2 is Frieren — Simplified, Traditional, English,
// romaji, Cantonese-dub and batch titles alike — and none may be dropped.
func TestFilterRelevant_FrierenS2Fixture(t *testing.T) {
	t.Parallel()

	rows := loadRelevanceFixture(t, "relevance-182255.json")
	require.Len(t, rows, 312)

	m := newRelevanceMatcher(frierenS2Titles)
	for _, r := range rows {
		require.True(t, r.Relevant)
		assert.True(t, m.matches(r.Title), "[%s] %s", r.Source, r.Title)
	}
}
