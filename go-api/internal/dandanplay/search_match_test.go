package dandanplay

// search_match_test.go — the dandanplay-search step of /match: a keyword
// that neither the file hash nor anime_cache recognises, because it is a
// release group's own name for the show ("[Judas] Nama-Anaru - S01E08.mkv"
// is 生徒会にも穴はある！).  dandanplay's search knows those names.

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// entryDB answers GetAnimeByAnilistIDForDandanplay from a fixed table.
func entryDB(entries map[int32]string) *fakeDB {
	return &fakeDB{
		byAnilistFn: func(_ context.Context, id int32) (dbgen.GetAnimeByAnilistIDForDandanplayRow, error) {
			title, ok := entries[id]
			if !ok {
				return dbgen.GetAnimeByAnilistIDForDandanplayRow{}, pgx.ErrNoRows
			}
			return dbgen.GetAnimeByAnilistIDForDandanplayRow{
				AnilistID:   id,
				TitleNative: strPtr(title),
				TitleRomaji: strPtr(title),
				Episodes:    i32Ptr(12),
			}, nil
		},
	}
}

// linkedEpisodes returns a 12-episode payload whose dandanplay entry links
// to the given AniList id (0 = no link published).
func linkedEpisodes(links map[int64]int32) func(context.Context, int64) (*EpisodeData, error) {
	return func(_ context.Context, id int64) (*EpisodeData, error) {
		ep := makeEpisodeData(id, "x")
		ep.AniListID = links[id]
		return ep, nil
	}
}

func matchedAnilistID(t *testing.T, out map[string]json.RawMessage) int32 {
	t.Helper()
	var anime struct {
		AnilistID int32 `json:"anilistId"`
	}
	require.NoError(t, json.Unmarshal(out["anime"], &anime))
	return anime.AnilistID
}

func isMatched(t *testing.T, out map[string]json.RawMessage) bool {
	t.Helper()
	var matched bool
	require.NoError(t, json.Unmarshal(out["matched"], &matched))
	return matched
}

func TestMatch_DandanSearch_ResolvesAReleaseGroupsShortName(t *testing.T) {
	var searched []string
	var mu sync.Mutex
	client := &fakeClient{
		searchFn: func(_ context.Context, kw string) ([]DandanAnime, error) {
			mu.Lock()
			searched = append(searched, kw)
			mu.Unlock()
			return []DandanAnime{{DandanAnimeID: 19308, Title: "学生会也有洞！", Type: "tvseries"}}, nil
		},
		episodesDanFn: linkedEpisodes(map[int64]int32{19308: 191656}),
	}
	h := newTestHandlers(entryDB(map[int32]string{191656: "生徒会にも穴はある！"}), client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{
		Keyword:  "Nama-Anaru",
		FileName: "[Judas] Nama-Anaru - S01E08.mkv",
		Episodes: []int{1},
	}))

	require.True(t, isMatched(t, out))
	assert.Equal(t, int32(191656), matchedAnilistID(t, out))
	var source string
	require.NoError(t, json.Unmarshal(out["source"], &source))
	assert.Equal(t, "dandanplaySearch", source)
	assert.Equal(t, []string{"Nama-Anaru"}, searched)
}

func TestMatch_DandanSearch_SearchesTheBareTitleAndKeepsTheRequestedSeason(t *testing.T) {
	var searched string
	var fetched []int64
	var mu sync.Mutex
	client := &fakeClient{
		searchFn: func(_ context.Context, kw string) ([]DandanAnime, error) {
			searched = kw
			return []DandanAnime{
				{DandanAnimeID: 1, Title: "薬屋のひとりごと"},
				{DandanAnimeID: 2, Title: "薬屋のひとりごと 第2期"},
				{DandanAnimeID: 3, Title: "薬屋のひとりごと 第3期"},
			}, nil
		},
		episodesDanFn: func(ctx context.Context, id int64) (*EpisodeData, error) {
			mu.Lock()
			fetched = append(fetched, id)
			mu.Unlock()
			return linkedEpisodes(map[int64]int32{1: 101, 2: 102, 3: 103})(ctx, id)
		},
	}
	h := newTestHandlers(entryDB(map[int32]string{101: "a", 102: "b", 103: "c"}), client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{
		Keyword:  "Kusuriya Season 3",
		FileName: "[Judas] Kusuriya - S03E08.mkv",
		Episodes: []int{1},
	}))

	require.True(t, isMatched(t, out))
	assert.Equal(t, int32(103), matchedAnilistID(t, out))
	assert.Equal(t, "Kusuriya", searched)
	assert.Equal(t, []int64{3}, fetched, "only the season-3 candidate is examined")
}

func TestMatch_DandanSearch_CandidatesNamingDifferentEntriesAreAMiss(t *testing.T) {
	// "Tensei shita" (Judas's name for a different show) brings back the
	// Slime TV series and its OVA: two entries, so neither is chosen.
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			return []DandanAnime{
				{DandanAnimeID: 10, Title: "転生したらスライムだった件"},
				{DandanAnimeID: 11, Title: "転生したらスライムだった件 OVA"},
			}, nil
		},
		episodesDanFn: linkedEpisodes(map[int64]int32{10: 1, 11: 2}),
	}
	h := newTestHandlers(entryDB(map[int32]string{1: "a", 2: "b"}), client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{Keyword: "Tensei shita", Episodes: []int{1}}))
	assert.False(t, isMatched(t, out))
}

func TestMatch_DandanSearch_ACandidateThatCannotBePlacedIsAMiss(t *testing.T) {
	// The right answer may be a new show dandanplay has not linked yet.
	// Skipping it would leave the other candidate as the only one, and bind
	// the file to the wrong show.
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			return []DandanAnime{
				{DandanAnimeID: 60, Title: "New Show"},
				{DandanAnimeID: 61, Title: "Other Show"},
			}, nil
		},
		episodesDanFn: linkedEpisodes(map[int64]int32{60: 0, 61: 7}),
	}
	h := newTestHandlers(entryDB(map[int32]string{7: "Other Show"}), client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{Keyword: "Show", Episodes: []int{1}}))
	assert.False(t, isMatched(t, out))
}

func TestMatch_DandanSearch_ACandidateThatFailsToLoadIsAMiss(t *testing.T) {
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			return []DandanAnime{
				{DandanAnimeID: 70, Title: "Show A"},
				{DandanAnimeID: 71, Title: "Show B"},
			}, nil
		},
		episodesDanFn: func(ctx context.Context, id int64) (*EpisodeData, error) {
			if id == 70 {
				return nil, errors.New("upstream 429")
			}
			return linkedEpisodes(map[int64]int32{71: 8})(ctx, id)
		},
	}
	h := newTestHandlers(entryDB(map[int32]string{8: "Show B"}), client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{Keyword: "Show", Episodes: []int{1}}))
	assert.False(t, isMatched(t, out))
}

func TestMatch_DandanSearch_TwoListingsOfOneEntryStillMatch(t *testing.T) {
	// dandanplay lists some shows twice (a Japanese and a Chinese title)
	// with both linking to the same AniList entry.
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			return []DandanAnime{
				{DandanAnimeID: 20, Title: "超巡！超条先輩"},
				{DandanAnimeID: 21, Title: "超巡！超条前辈"},
			}, nil
		},
		episodesDanFn: linkedEpisodes(map[int64]int32{20: 500, 21: 500}),
	}
	h := newTestHandlers(entryDB(map[int32]string{500: "超巡！超条先輩"}), client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{Keyword: "Choujun", Episodes: []int{1}}))
	require.True(t, isMatched(t, out))
	assert.Equal(t, int32(500), matchedAnilistID(t, out))
}

func TestMatch_DandanSearch_NoCandidateOfTheRequestedSeasonIsAMiss(t *testing.T) {
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			return []DandanAnime{
				{DandanAnimeID: 30, Title: "アニメ野性のさけび"},
				{DandanAnimeID: 31, Title: "野生のラスボスが現れた！"},
			}, nil
		},
		episodesDanFn: linkedEpisodes(map[int64]int32{30: 1, 31: 2}),
	}
	h := newTestHandlers(entryDB(map[int32]string{1: "a", 2: "b"}), client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{Keyword: "Yasei no Season 2", Episodes: []int{1}}))
	assert.False(t, isMatched(t, out))
	assert.Equal(t, int32(0), client.episodesDanCalls.Load(), "nothing of season 2 to examine")
}

func TestMatch_DandanSearch_TooManyCandidatesIsAMiss(t *testing.T) {
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			out := make([]DandanAnime, 0, maxSearchCandidates+1)
			for i := 0; i <= maxSearchCandidates; i++ {
				out = append(out, DandanAnime{DandanAnimeID: int64(40 + i), Title: "Same Name"})
			}
			return out, nil
		},
		episodesDanFn: linkedEpisodes(map[int64]int32{40: 9, 41: 9, 42: 9, 43: 9}),
	}
	h := newTestHandlers(entryDB(map[int32]string{9: "a"}), client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{Keyword: "Same", Episodes: []int{1}}))
	assert.False(t, isMatched(t, out))
	assert.Equal(t, int32(0), client.episodesDanCalls.Load())
}

func TestMatch_DandanSearch_AnEntryNotInTheCatalogueIsAMiss(t *testing.T) {
	// Matching is only useful with an AniList id to bind; without one the
	// library would get a card it cannot sync.
	client := &fakeClient{
		searchFn: func(_ context.Context, _ string) ([]DandanAnime, error) {
			return []DandanAnime{{DandanAnimeID: 50, Title: "Unknown Show"}}, nil
		},
		episodesDanFn: linkedEpisodes(map[int64]int32{50: 0}),
	}
	h := newTestHandlers(&fakeDB{}, client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{Keyword: "Unknown", Episodes: []int{1}}))
	assert.False(t, isMatched(t, out))
}

func TestMatch_DandanSearch_NotTriedWithoutAKeyword(t *testing.T) {
	client := &fakeClient{}
	h := newTestHandlers(&fakeDB{}, client, nil)

	out := unmarshalMatch(t, postMatch(t, h, MatchRequest{FileName: "x - 01.mkv", Episodes: []int{1}}))
	assert.False(t, isMatched(t, out))
	assert.Equal(t, int32(0), client.searchCalls.Load())
}

func TestStripSeasonWords(t *testing.T) {
	cases := map[string]string{
		"Kusuriya Season 3":           "Kusuriya",
		"Kusuriya season3":            "Kusuriya",
		"Ao no Hako 2nd Season":       "Ao no Hako",
		"葬送的芙莉蓮 第二季":                  "葬送的芙莉蓮",
		"無職轉生 第3期":                    "無職轉生",
		"Nama-Anaru":                  "Nama-Anaru",
		"Mato Seihei no Slave 2":      "Mato Seihei no Slave 2",
		"Season":                      "Season",
		"  Tokyo Revengers Season 4 ": "Tokyo Revengers",
	}
	for in, want := range cases {
		assert.Equal(t, want, stripSeasonWords(in), "stripSeasonWords(%q)", in)
	}
}
