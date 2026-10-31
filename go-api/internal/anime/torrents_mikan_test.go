package anime

// Torrents ?anilistId — Mikan's per-bangumi feed.  The handler resolves the
// anime's Mikan bangumi id from its AniList id, falling back to the
// anime_cache bgm_id, and passes it to the aggregator, which then reads the
// feed instead of searching Mikan by title.  The response shape does not
// change: feed rows are ordinary TorrentItems.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/mikanidmap"
	"github.com/lawrenceli0228/animego/go-api/internal/torrents"
)

// mikanProbeAggregator returns an aggregator whose two Mikan fetches are
// recorded: keyword searches are counted and the per-bangumi feed's ids
// collected, the feed answering feed.  Every other source returns nothing.
func mikanProbeAggregator(t *testing.T, feed []torrents.TorrentItem) (*torrents.Aggregator, *atomic.Int32, func() []int) {
	t.Helper()

	var keyword atomic.Int32
	var mu sync.Mutex
	var feedIDs []int
	none := func(_ context.Context, _ string) ([]torrents.TorrentItem, error) { return nil, nil }

	a, err := torrents.New(
		torrents.WithGardenFn(none),
		torrents.WithAcgFn(none),
		torrents.WithNyaaFn(none),
		torrents.WithDmhyFn(none),
		torrents.WithToshoFn(none),
		torrents.WithMikanFn(func(_ context.Context, _ string) ([]torrents.TorrentItem, error) {
			keyword.Add(1)
			return nil, nil
		}),
		torrents.WithMikanBangumiFn(func(_ context.Context, mikanID int) ([]torrents.TorrentItem, error) {
			mu.Lock()
			feedIDs = append(feedIDs, mikanID)
			mu.Unlock()
			return feed, nil
		}),
	)
	require.NoError(t, err)
	t.Cleanup(a.Close)

	return a, &keyword, func() []int {
		mu.Lock()
		defer mu.Unlock()
		return append([]int(nil), feedIDs...)
	}
}

// torrentInputs answers the handler's lookup with one row carrying bgmID.
func torrentInputs(bgmID *int32) *fakeQuerier {
	return &fakeQuerier{
		getTorrentQueryInputsFn: func(_ context.Context, _ int32) (dbgen.GetTorrentQueryInputsByAnilistIDRow, error) {
			return dbgen.GetTorrentQueryInputsByAnilistIDRow{
				TitleRomaji: strptr("Sousou no Frieren"),
				TitleNative: strptr("葬送のフリーレン"),
				BgmID:       bgmID,
			}, nil
		},
	}
}

// mikanMapFixture is a map in cmd/mikanmap's output shape: AniList 154587
// names page 3141; Bangumi 999001 names page 4001, which no AniList id does;
// AniList 21 is a conflict over pages 228 and 3977, and its Bangumi subject
// 975 names page 228.
func mikanMapFixture(t *testing.T) *mikanidmap.Map {
	t.Helper()
	m, err := mikanidmap.Parse([]byte(`{
  "attribution": "Mikan Project bangumi ids from bangumi-data, CC BY 4.0",
  "bangumiDataVersion": "0.3.231",
  "anilist": {"154587": 3141},
  "bgm": {"975": 228, "400602": 3141, "999001": 4001},
  "anilistConflicts": {"21": [228, 3977]}
}`))
	require.NoError(t, err)
	return m
}

func int32p(v int32) *int32 { return &v }

func TestTorrents_ByAnilistID_ResolvesTheMikanIDFromTheAnilistID(t *testing.T) {
	t.Parallel()

	var gotAnilist int32
	var gotBgm *int32
	lookup := func(anilistID int32, bgmID *int32) []int32 {
		gotAnilist, gotBgm = anilistID, bgmID
		return []int32{3141}
	}

	agg, keyword, feedIDs := mikanProbeAggregator(t, nil)
	rec := httptest.NewRecorder()
	Torrents(agg, torrentInputs(int32p(400602)), lookup).ServeHTTP(rec,
		httptest.NewRequest(http.MethodGet, "/api/anime/torrents?anilistId=154587", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int32(154587), gotAnilist, "the lookup gets the request's AniList id")
	require.NotNil(t, gotBgm, "and the anime's bgm_id from anime_cache")
	assert.Equal(t, int32(400602), *gotBgm)
	assert.Equal(t, []int{3141}, feedIDs(), "the resolved id's feed is fetched")
	assert.Zero(t, keyword.Load(), "Mikan is not searched by title once its page is known")
}

// End to end through the real lookup: an AniList id the map does not hold
// falls back to the anime_cache bgm_id; one it holds needs no bgm_id.
func TestTorrents_ByAnilistID_MikanLookupWithBgmFallback(t *testing.T) {
	t.Parallel()

	m := mikanMapFixture(t)
	cases := []struct {
		name     string
		query    string
		bgmID    *int32
		wantFeed []int
	}{
		{"AniList hit", "anilistId=154587", nil, []int{3141}},
		{"bgm fallback", "anilistId=777", int32p(999001), []int{4001}},
		{"miss on both", "anilistId=777", int32p(5), nil},
		{"miss, no bgm_id", "anilistId=777", nil, nil},
		// No one page has all of a conflicted show's releases: every page's
		// feed is read, and its own bgm_id does not narrow that to one.
		{"conflicted AniList id, own bgm_id", "anilistId=21", int32p(975), []int{228, 3977}},
		{"conflicted AniList id, no bgm_id", "anilistId=21", nil, []int{228, 3977}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			agg, keyword, feedIDs := mikanProbeAggregator(t, nil)
			rec := httptest.NewRecorder()
			Torrents(agg, torrentInputs(tc.bgmID), m.Lookup).ServeHTTP(rec,
				httptest.NewRequest(http.MethodGet, "/api/anime/torrents?"+tc.query, nil))

			require.Equal(t, http.StatusOK, rec.Code)
			assert.ElementsMatch(t, tc.wantFeed, feedIDs())
			if tc.wantFeed == nil {
				assert.Equal(t, int32(2), keyword.Load(), "no Mikan id: Mikan is searched for each title, as before")
			} else {
				assert.Zero(t, keyword.Load())
			}
		})
	}
}

// Feed rows serialise exactly like every other row: the same envelope and
// the same keys, with seeders and provider absent as for any RSS source.
func TestTorrents_ByAnilistID_MikanFeedKeepsTheResponseShape(t *testing.T) {
	t.Parallel()

	const hash = "f7f11b17b95b00313ededdeb0d2c2057c13309e9"
	date := "2026-08-12T06:12:15.638227"
	fansub := "H-Enc"
	feed := []torrents.TorrentItem{{
		Title:  "[H-Enc] 葬送的芙莉莲 第二季 (BDRip 1080p HEVC FLAC)",
		Magnet: "magnet:?xt=urn:btih:" + hash + "&dn=x",
		Size:   "28.2 GB",
		Fansub: &fansub,
		Date:   &date,
		Source: torrents.SourceMikan,
	}}

	agg, _, _ := mikanProbeAggregator(t, feed)
	lookup := func(int32, *int32) []int32 { return []int32{3821} }
	rec := httptest.NewRecorder()
	Torrents(agg, torrentInputs(nil), lookup).ServeHTTP(rec,
		httptest.NewRequest(http.MethodGet, "/api/anime/torrents?anilistId=182255", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
	require.Len(t, parsed.Data, 1)

	row := parsed.Data[0]
	keys := make([]string, 0, len(row))
	for k := range row {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	assert.Equal(t, []string{"date", "fansub", "infohash", "magnet", "size", "source", "title"}, keys)
	assert.Equal(t, "mikan", row["source"])
	assert.Equal(t, hash, row["infohash"])
	assert.Equal(t, date, row["date"])
	assert.Equal(t, "28.2 GB", row["size"])
}
