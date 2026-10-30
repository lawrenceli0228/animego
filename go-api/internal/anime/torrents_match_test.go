package anime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/torrents"
)

// title_hant is matched but never searched.  A release titled only in
// Traditional Chinese shares too few character pairs with the Simplified
// title to pass the relevance filter on its own (进击的巨人 vs 進擊的巨人:
// 2 of 4 pairs), so whether it survives shows whether the handler passed
// title_hant into MatchTitles.  The search itself must still use only the
// four original titles.
func TestTorrents_ByAnilistID_MatchesOnTraditionalTitle(t *testing.T) {
	t.Parallel()

	const (
		hantRelease = "[Baha] 進擊的巨人 - 01 [1080P][WEB-DL][AAC AVC][CHT]"
		strayHit    = "[Group] Some Other Show 4th Season - 01 [1080p]"
	)
	hits := []torrents.TorrentItem{
		{Title: hantRelease, Magnet: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111", Source: torrents.SourceGarden},
		{Title: strayHit, Magnet: "magnet:?xt=urn:btih:2222222222222222222222222222222222222222", Source: torrents.SourceGarden},
	}

	tests := []struct {
		name string
		hant *string
		want []string
	}{
		{"with title_hant the Traditional release is kept", strptr("進擊的巨人"), []string{hantRelease}},
		{"without title_hant it is not", nil, []string{}},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var (
				mu      sync.Mutex
				queries []string
			)
			agg, err := torrents.New(
				torrents.WithGardenFn(func(_ context.Context, q string) ([]torrents.TorrentItem, error) {
					mu.Lock()
					queries = append(queries, q)
					mu.Unlock()
					return hits, nil
				}),
				torrents.WithAcgFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return nil, nil }),
				torrents.WithNyaaFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return nil, nil }),
				torrents.WithDmhyFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return nil, nil }),
				torrents.WithMikanFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return nil, nil }),
				torrents.WithToshoFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return nil, nil }),
			)
			require.NoError(t, err)
			t.Cleanup(agg.Close)

			q := &fakeQuerier{
				getTorrentQueryInputsFn: func(_ context.Context, _ int32) (dbgen.GetTorrentQueryInputsByAnilistIDRow, error) {
					return dbgen.GetTorrentQueryInputsByAnilistIDRow{
						TitleRomaji:  strptr("Shingeki no Kyojin"),
						TitleNative:  strptr("進撃の巨人"),
						TitleEnglish: strptr("Attack on Titan"),
						TitleChinese: strptr("进击的巨人"),
						TitleHant:    tc.hant,
					}, nil
				},
			}

			rec := httptest.NewRecorder()
			Torrents(agg, q, nil).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/torrents?anilistId=16498", nil))
			require.Equal(t, http.StatusOK, rec.Code)

			var body struct {
				Data []torrents.TorrentItem `json:"data"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			got := make([]string, 0, len(body.Data))
			for _, it := range body.Data {
				got = append(got, it.Title)
			}
			assert.Equal(t, tc.want, got)

			mu.Lock()
			defer mu.Unlock()
			assert.ElementsMatch(t,
				[]string{"Shingeki no Kyojin", "進撃の巨人", "Attack on Titan", "进击的巨人"}, queries,
				"only the four original titles are searched; title_hant is never a variant")
		})
	}
}

func TestBuildTorrentMatchTitles_IncludesHantAndSkipsBlanks(t *testing.T) {
	t.Parallel()

	got := buildTorrentMatchTitles(dbgen.GetTorrentQueryInputsByAnilistIDRow{
		TitleRomaji:  strptr("Sousou no Frieren 2nd Season"),
		TitleNative:  nil,
		TitleEnglish: strptr("   "),
		TitleChinese: strptr("葬送的芙莉莲 第二季"),
		TitleHant:    strptr(" 葬送的芙莉蓮 第二季 "),
	})
	assert.Equal(t, []string{"Sousou no Frieren 2nd Season", "葬送的芙莉莲 第二季", "葬送的芙莉蓮 第二季"}, got)
}
