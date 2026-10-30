package torrents

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// titled builds a row with a given title and an infohash derived from it,
// so distinct titles never dedup into each other.
func titled(src Source, title string) TorrentItem {
	return TorrentItem{Title: title, Magnet: magnetWith(title), Source: src}
}

func titlesOf(items []TorrentItem) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Title
	}
	return out
}

const (
	reZeroHit = "[ANi] Re：從零開始的異世界生活 第四季 - 60 [1080P][Baha][WEB-DL][AAC AVC][CHT]"
	bnhaStray = "【MMSUB】★10月新番★[我的英雄学院 第四季 / Boku no Hero Academia 4th Season][23][WebRip 1080p AVC-8bit AAC][简繁外挂字幕]"
	bnhaRaw   = "[Erai-raws] Boku no Hero Academia 4th Season - 23 [1080p]"
)

// The known regression: Re:Zero's native title ends in an ASCII
// "4th season", so dmhy's keyword search returns My Hero Academia's fourth
// season alongside Re:Zero's.  Those rows must be dropped from the keyword
// hits while the Re:Zero row survives.
func TestFetchForAnime_DropsKeywordHitsForAnotherShow(t *testing.T) {
	t.Parallel()

	a := newTestAggregator(t,
		WithGardenFn(staticFn([]TorrentItem{titled(SourceGarden, reZeroHit)}, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn([]TorrentItem{titled(SourceNyaa, bnhaRaw)}, nil)),
		WithDmhyFn(staticFn([]TorrentItem{titled(SourceDmhy, bnhaStray)}, nil)),
	)

	out, err := a.FetchForAnime(context.Background(), AnimeQuery{
		Variants:    reZeroS4Titles[:4],
		MatchTitles: reZeroS4Titles,
	})
	require.NoError(t, err)
	assert.Equal(t, []string{reZeroHit}, titlesOf(out))
}

// Rows from the id feeds are this show by construction: a per-bangumi or
// AniDB feed row is kept even when its title matches none of the anime's
// titles (fansubs title releases however they like).
func TestFetchForAnime_IDFeedRowsAreNeverFiltered(t *testing.T) {
	t.Parallel()

	const oddMikanTitle = "[LoliHouse] ReZ S4 - 05 [WebRip 1080p HEVC-10bit AAC]"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"title":"[Group] Unrelated Looking Name - 05.mkv","magnet_uri":"magnet:?xt=urn:btih:a1dfeed000000000000000000000000000000000","info_hash":"a1dfeed000000000000000000000000000000000","total_size":1500000000,"timestamp":1735689600}]`))
	}))
	defer srv.Close()

	a := newTestAggregator(t,
		WithGardenFn(staticFn([]TorrentItem{titled(SourceGarden, bnhaRaw)}, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
		WithMikanBangumiFn(func(context.Context, int) ([]TorrentItem, error) {
			return []TorrentItem{titled(SourceMikan, oddMikanTitle)}, nil
		}),
		WithHTTPClient(newRewriteClient(srv.URL)),
	)

	aid := int32(17389)
	out, err := a.FetchForAnime(context.Background(), AnimeQuery{
		Variants:    reZeroS4Titles[:4],
		MatchTitles: reZeroS4Titles,
		AnidbID:     &aid,
		MikanID:     int32Ptr(3821),
	})
	require.NoError(t, err)
	assert.ElementsMatch(t,
		[]string{oddMikanTitle, "[Group] Unrelated Looking Name - 05.mkv"},
		titlesOf(out),
		"both id-feed rows kept; the keyword stray dropped")
}

// Without match titles there is nothing to check against, so nothing is
// dropped — the behaviour before the filter existed.
func TestFetchForAnime_NoMatchTitles_NoFiltering(t *testing.T) {
	t.Parallel()

	a := newTestAggregator(t,
		WithGardenFn(staticFn([]TorrentItem{titled(SourceGarden, reZeroHit)}, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn([]TorrentItem{titled(SourceNyaa, bnhaRaw)}, nil)),
	)

	out, err := a.FetchForAnime(context.Background(), AnimeQuery{Variants: reZeroS4Titles[:4]})
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{reZeroHit, bnhaRaw}, titlesOf(out))
}

// The ?q= path searches whatever the user typed; there is no anime to
// match against, so every hit is returned.
func TestFetch_ManualQuery_NoFiltering(t *testing.T) {
	t.Parallel()

	a := newTestAggregator(t,
		WithGardenFn(staticFn([]TorrentItem{titled(SourceGarden, reZeroHit)}, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn([]TorrentItem{titled(SourceNyaa, bnhaRaw)}, nil)),
	)

	out, err := a.Fetch(context.Background(), "4th Season")
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{reZeroHit, bnhaRaw}, titlesOf(out))
}

// The match titles decide which hits survive, so two requests with the
// same variants but different match titles must not share a cache entry.
func TestAnimeCacheKey_IncludesMatchTitles(t *testing.T) {
	t.Parallel()

	v := []string{"Alpha"}
	assert.NotEqual(t, animeCacheKey(v, nil, nil, nil), animeCacheKey(v, nil, nil, []string{"Alpha", "阿尔法"}))
	assert.Equal(t,
		animeCacheKey(v, nil, nil, []string{"Alpha", "阿尔法"}),
		animeCacheKey(v, nil, nil, []string{"阿尔法", "ALPHA"}),
		"order and case of the match titles don't matter")
}

func TestRelevanceMatcher_Cases(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		titles []string
		hit    string
		want   bool
	}{
		{"BNHA 4th Season is not Re:Zero 4th season", reZeroS4Titles, "[SubsPlease] Boku no Hero Academia 4th Season - 01 (1080p)", false},
		{"Re:Zero romaji release", reZeroS4Titles, "[SubsPlease] Re Zero kara Hajimeru Isekai Seikatsu - 60 (1080p) [ABCD1234].mkv", true},
		{"Re:Zero English release", reZeroS4Titles, "Re:ZERO -Starting Life in Another World- S04E01 1080p WEB", true},
		{"Traditional-only release matches via title_hant", []string{"葬送的芙莉莲 第二季", "葬送的芙莉蓮 第二季"}, "[Baha] 葬送的芙莉蓮 - 30 [1080P][WEB-DL][CHT]", true},
		{"Traditional release without the hant title still shares most bigrams", []string{"葬送的芙莉莲 第二季"}, "[Baha] 葬送的芙莉蓮 - 30", true},
		{"sharing only 异世界 is not enough", reZeroS4Titles, "[字幕组] 异世界悠闲农家 第二季 - 01", false},
		{"latin words match whole words: re is not inside hero or release", []string{"Re"}, "[Group] Hero Release Collection", false},
		{"one-word core needs that word", []string{"Re 4th Season"}, "[Group] Re - 01", true},
		{"one-bigram core needs the whole pair", []string{"阿松 第四季"}, "[黑白字幕组]阿松 第四季 [01]", true},
		{"one-bigram core rejects a reorder", []string{"阿松 第四季"}, "[字幕组]松阿 第四季 [01]", false},
		{"season tokens alone never match", []string{"Re 4th Season"}, "[Group] Slime 4th Season - 01", false},
		{"full-width text folds before matching", []string{"Frieren"}, "[Ｇ] ＦＲＩＥＲＥＮ - 01", true},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, newRelevanceMatcher(tc.titles).matches(tc.hit))
		})
	}
}

// Season, part and arc markers are stripped from the core; they are the
// very tokens a wrong show shares.
func TestCoreOf_StripsSeasonMarkers(t *testing.T) {
	t.Parallel()

	tests := []struct {
		title   string
		words   []string
		bigrams []string
	}{
		{"Re:Zero kara Hajimeru Isekai Seikatsu 4th Season", []string{"re", "zero", "kara", "hajimeru", "isekai", "seikatsu"}, []string{}},
		{"Re：从零开始的异世界生活 第四季 丧失篇", []string{"re"}, []string{"从零", "零开", "开始", "始的", "的异", "异世", "世界", "界生", "生活"}},
		{"Re：從零開始的異世界生活 4", []string{"re"}, []string{"從零", "零開", "開始", "始的", "的異", "異世", "世界", "界生", "生活"}},
		{"Frieren: Beyond Journey’s End Season 2", []string{"frieren", "beyond", "journeys", "end"}, []string{}},
		{"葬送のフリーレン 第2期", []string{}, []string{"葬送", "送の", "のフ", "フリ", "リー", "ーレ", "レン"}},
		{"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2", []string{"mushoku", "tensei", "ii", "isekai", "ittara", "honki", "dasu"}, []string{}},
		{"Kimetsu no Yaiba S2", []string{"kimetsu", "no", "yaiba"}, []string{}},
		{"Mob Psycho 100", []string{"mob", "psycho", "100"}, []string{}},
	}
	for _, tc := range tests {
		c := coreOf(tc.title)
		assert.Equal(t, tc.words, c.words, tc.title)
		assert.Equal(t, tc.bigrams, c.bigrams, tc.title)
	}

	assert.Equal(t, 0, coreOf("第四季").size(), "a title that is only a marker has no core")
	assert.Equal(t, 0, coreOf("4th Season").size())
}

// filterRelevant with no usable title returns the input untouched, and
// never mutates its input.
func TestFilterRelevant_NoTitlesKeepsAll(t *testing.T) {
	t.Parallel()

	in := []TorrentItem{titled(SourceDmhy, bnhaRaw), titled(SourceDmhy, reZeroHit)}
	assert.Equal(t, in, filterRelevant(in, nil))
	assert.Equal(t, in, filterRelevant(in, []string{"", "  ", "第2期"}))

	out := filterRelevant(in, reZeroS4Titles)
	assert.Equal(t, []string{reZeroHit}, titlesOf(out))
	assert.Equal(t, bnhaRaw, in[0].Title, "input slice not modified")
}
