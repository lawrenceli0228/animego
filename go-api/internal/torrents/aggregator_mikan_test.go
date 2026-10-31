// Package torrents — aggregator_mikan_test.go
//
// Covers FetchForAnime with Mikan bangumi pages (AnimeQuery.MikanIDs):
//   - the per-bangumi feed is fetched, and Mikan's keyword search is not;
//     every other source still searches each title variant
//   - without a Mikan id, everything runs as before: Mikan is searched per
//     variant and no feed is fetched
//   - feed rows dedup by infohash against other sources across magnet
//     encodings (hex vs base32), under the existing precedence rule, and
//     against Mikan's own rows
//   - the cache key carries the Mikan pages, in any order
//   - a show Mikan splits over several pages reads every page's feed, up
//     to maxMikanFeeds; one failing page costs only its own rows
//   - a Mikan id alone is enough to search; a failing feed is absorbed
package torrents

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mikanProbe stands in for both Mikan fetches and records how they were
// used: how many keyword searches ran, and which bangumi ids' feeds were
// fetched.
type mikanProbe struct {
	keyword atomic.Int32
	mu      sync.Mutex
	feeds   []int
}

func (p *mikanProbe) options(feed []TorrentItem, feedErr error) []Option {
	return []Option{
		WithMikanFn(func(_ context.Context, _ string) ([]TorrentItem, error) {
			p.keyword.Add(1)
			return nil, nil
		}),
		WithMikanBangumiFn(func(_ context.Context, mikanID int) ([]TorrentItem, error) {
			p.mu.Lock()
			p.feeds = append(p.feeds, mikanID)
			p.mu.Unlock()
			return feed, feedErr
		}),
	}
}

func (p *mikanProbe) feedIDs() []int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]int(nil), p.feeds...)
}

func int32Ptr(v int32) *int32 { return &v }

// mikanFeedRow is a row as FetchMikanByBangumi produces it: the magnet is
// synthesised from the 40-hex hash in the .torrent URL.
func mikanFeedRow(title, hexHash string) TorrentItem {
	return TorrentItem{Title: title, Magnet: buildNyaaMagnet(hexHash, title, ""), Source: SourceMikan}
}

func TestFetchForAnime_MikanID_ReadsTheFeedInsteadOfSearchingMikan(t *testing.T) {
	t.Parallel()

	var probe mikanProbe
	var gardenCalls atomic.Int32
	feed := []TorrentItem{mikanFeedRow("[Sub] Show - 01", hashA)}
	a := newTestAggregator(t, append(probe.options(feed, nil),
		WithGardenFn(staticFn(nil, &gardenCalls)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
	)...)

	out, err := a.FetchForAnime(context.Background(), AnimeQuery{
		Variants: []string{"Sousou no Frieren", "葬送的芙莉莲"},
		MikanIDs: []int32{3141},
	})
	require.NoError(t, err)

	assert.Equal(t, []int{3141}, probe.feedIDs(), "the feed is fetched once, for the anime's Mikan id")
	assert.Zero(t, probe.keyword.Load(), "with a Mikan id, Mikan is not searched by title")
	assert.Equal(t, int32(2), gardenCalls.Load(), "the other sources still search every variant")
	require.Len(t, out, 1)
	assert.Equal(t, "[Sub] Show - 01", out[0].Title)
	assert.Equal(t, SourceMikan, out[0].Source)
}

func TestFetchForAnime_NoMikanID_SearchesMikanAsBefore(t *testing.T) {
	t.Parallel()

	var probe mikanProbe
	a := newTestAggregator(t, append(probe.options(nil, nil),
		WithGardenFn(staticFn(nil, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
	)...)

	_, err := a.FetchForAnime(context.Background(), AnimeQuery{
		Variants: []string{"Sousou no Frieren", "葬送的芙莉莲"},
	})
	require.NoError(t, err)

	assert.Equal(t, int32(2), probe.keyword.Load(), "Mikan is searched once per variant, as before")
	assert.Empty(t, probe.feedIDs(), "no Mikan id, no per-bangumi feed")
}

// The same torrent in the Mikan feed (hex magnet) and from another source
// (base32 magnet) comes back once, and the copy kept follows the existing
// rule: more seeders wins; on equal seeders, the higher-ranked source.
// Mikan rows never carry a seeder count and Mikan ranks below every other
// source, so the other source's copy is the one kept.
func TestFetchForAnime_MikanFeedDedupsAcrossSourcesAndEncodings(t *testing.T) {
	t.Parallel()

	feed := []TorrentItem{mikanFeedRow("[Sub] Show - 01 (Mikan)", knownV1Hex)}
	base32Magnet := "magnet:?xt=urn:btih:" + knownV1Base32

	cases := []struct {
		name       string
		other      Option
		wantSource Source
	}{
		{
			// Neither row has a seeder count, so the source rank decides:
			// dmhy is registered before mikan.
			name: "no seeders on either: dmhy outranks mikan",
			other: WithDmhyFn(staticFn([]TorrentItem{
				{Title: "[Sub] Show - 01 (dmhy)", Magnet: base32Magnet, Source: SourceDmhy},
			}, nil)),
			wantSource: SourceDmhy,
		},
		{
			name: "tosho's copy with a seeder count",
			other: WithToshoFn(staticFn([]TorrentItem{
				{Title: "[Sub] Show - 01 (tosho)", Magnet: base32Magnet, Source: SourceTosho, Seeders: intPtr(12)},
			}, nil)),
			wantSource: SourceTosho,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var probe mikanProbe
			a := newTestAggregator(t, append(probe.options(feed, nil),
				WithGardenFn(staticFn(nil, nil)),
				WithAcgFn(staticFn(nil, nil)),
				WithNyaaFn(staticFn(nil, nil)),
				tc.other,
			)...)

			out, err := a.FetchForAnime(context.Background(), AnimeQuery{
				Variants: []string{"Show"},
				MikanIDs: []int32{3141},
			})
			require.NoError(t, err)
			require.Len(t, out, 1, "the hex and base32 copies are one torrent")
			assert.Equal(t, tc.wantSource, out[0].Source)
			assert.Equal(t, knownV1Hex, out[0].Infohash, "the survivor carries the normalised hex hash")
		})
	}
}

// Two Mikan rows for one torrent (say a feed row and a keyword-search row,
// one hash in upper case) collapse too.  Same source, same seeders: the
// first seen is kept.
func TestDedupByInfohash_MikanRowsCollapse(t *testing.T) {
	t.Parallel()

	upper := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	fromFeed := mikanFeedRow("feed copy", hashA)
	fromSearch := TorrentItem{Title: "search copy", Magnet: "magnet:?xt=urn:btih:" + upper, Source: SourceMikan}

	out := dedupByInfohash([]TorrentItem{fromFeed, fromSearch}, map[Source]int{SourceMikan: 1})
	require.Len(t, out, 1)
	assert.Equal(t, "feed copy", out[0].Title)
	assert.Equal(t, hashA, out[0].Infohash)
}

func TestAnimeCacheKey_IncludesTheMikanID(t *testing.T) {
	t.Parallel()

	variants := []string{"Alpha"}
	without := animeCacheKey(variants, nil, nil, nil)
	with3141 := animeCacheKey(variants, nil, []int32{3141}, nil)
	with3821 := animeCacheKey(variants, nil, []int32{3821}, nil)

	assert.NotEqual(t, without, with3141, "a Mikan id changes the key")
	assert.NotEqual(t, with3141, with3821, "different Mikan ids, different keys")
	// An aid and a Mikan id with the same number must not alias.
	assert.NotEqual(t, animeCacheKey(variants, int32Ptr(7), nil, nil), animeCacheKey(variants, nil, []int32{7}, nil))
}

// A request without a Mikan id must not be answered from the cache entry of
// one with it (their Mikan rows come from different fetches), and vice
// versa; the same request twice is a hit.
func TestFetchForAnime_CacheSeparatesMikanID(t *testing.T) {
	t.Parallel()

	var probe mikanProbe
	var gardenCalls atomic.Int32
	a := newTestAggregator(t, append(probe.options([]TorrentItem{mikanFeedRow("feed", hashA)}, nil),
		WithGardenFn(staticFn([]TorrentItem{itemWithHash(SourceGarden, "cafe")}, &gardenCalls)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
	)...)
	withID := AnimeQuery{Variants: []string{"Show"}, MikanIDs: []int32{3141}}

	_, err := a.FetchForAnime(context.Background(), AnimeQuery{Variants: []string{"Show"}})
	require.NoError(t, err)
	a.cache.Wait()
	require.Equal(t, int32(1), probe.keyword.Load())

	_, err = a.FetchForAnime(context.Background(), withID)
	require.NoError(t, err)
	a.cache.Wait()
	assert.Equal(t, []int{3141}, probe.feedIDs(), "adding the Mikan id misses the keyword-only entry")
	assert.Equal(t, int32(2), gardenCalls.Load())

	_, err = a.FetchForAnime(context.Background(), withID)
	require.NoError(t, err)
	assert.Equal(t, []int{3141}, probe.feedIDs(), "the same request again is served from cache")
	assert.Equal(t, int32(2), gardenCalls.Load())
}

func TestFetchForAnime_MikanIDAlone_IsEnoughToSearch(t *testing.T) {
	t.Parallel()

	var probe mikanProbe
	a := newTestAggregator(t, probe.options([]TorrentItem{mikanFeedRow("feed", hashA)}, nil)...)

	out, err := a.FetchForAnime(context.Background(), AnimeQuery{MikanIDs: []int32{3141}})
	require.NoError(t, err)
	assert.Equal(t, []int{3141}, probe.feedIDs())
	require.Len(t, out, 1)
}

// A failing feed costs only its own rows: it is logged, the other sources'
// rows come back, and Mikan is still not searched by title for this request.
func TestFetchForAnime_MikanFeedFailure_IsAbsorbed(t *testing.T) {
	t.Parallel()

	var probe mikanProbe
	log := &testLogger{}
	a := newTestAggregator(t, append(probe.options(nil, errors.New("mikan: upstream status 502")),
		WithGardenFn(staticFn([]TorrentItem{itemWithHash(SourceGarden, "beef")}, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
		WithLogger(log),
	)...)

	out, err := a.FetchForAnime(context.Background(), AnimeQuery{Variants: []string{"Show"}, MikanIDs: []int32{3141}})
	require.NoError(t, err, "a failing feed is a partial failure, not an error")
	require.Len(t, out, 1)
	assert.Equal(t, SourceGarden, out[0].Source)
	assert.Zero(t, probe.keyword.Load())
	_, found := log.findEntry("mikan bangumi-feed failed")
	assert.True(t, found)
}

// perPageFeeds answers each Mikan page with its own rows and records which
// pages were read; a page in failing errors instead.
func perPageFeeds(rows map[int][]TorrentItem, failing map[int]bool, fetched *[]int, mu *sync.Mutex) Option {
	return WithMikanBangumiFn(func(_ context.Context, mikanID int) ([]TorrentItem, error) {
		mu.Lock()
		*fetched = append(*fetched, mikanID)
		mu.Unlock()
		if failing[mikanID] {
			return nil, errors.New("mikan: upstream status 502")
		}
		return rows[mikanID], nil
	})
}

// Re:Zero's fourth season is two Mikan pages, 丧失篇 and 夺还篇; each lists
// releases the other does not.  Both feeds are read, and Mikan is still not
// searched by title.
func TestFetchForAnime_SeveralMikanPages_ReadsEveryFeed(t *testing.T) {
	t.Parallel()

	var (
		mu       sync.Mutex
		fetched  []int
		keywords atomic.Int32
	)
	rows := map[int][]TorrentItem{
		3951: {mikanFeedRow("[ANi] Re：从零开始的异世界生活 第四季 - 11", hashA)},
		4052: {mikanFeedRow("[百冬练习组&LoliHouse] Re:从零开始的异世界生活 - 76", hashB)},
	}
	a := newTestAggregator(t,
		WithMikanFn(func(_ context.Context, _ string) ([]TorrentItem, error) {
			keywords.Add(1)
			return nil, nil
		}),
		perPageFeeds(rows, nil, &fetched, &mu),
		WithGardenFn(staticFn(nil, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
	)

	out, err := a.FetchForAnime(context.Background(), AnimeQuery{
		Variants: []string{"Re:Zero kara Hajimeru Isekai Seikatsu 4th Season"},
		MikanIDs: []int32{3951, 4052},
	})
	require.NoError(t, err)

	assert.ElementsMatch(t, []int{3951, 4052}, fetched, "each page's feed is read once")
	assert.Zero(t, keywords.Load(), "with Mikan pages, Mikan is not searched by title")
	assert.ElementsMatch(t,
		[]string{"[ANi] Re：从零开始的异世界生活 第四季 - 11", "[百冬练习组&LoliHouse] Re:从零开始的异世界生活 - 76"},
		titlesOf(out), "rows from both pages come back")
}

// One page failing costs only that page's rows.
func TestFetchForAnime_OneMikanPageFails_KeepsTheOther(t *testing.T) {
	t.Parallel()

	var (
		mu      sync.Mutex
		fetched []int
	)
	rows := map[int][]TorrentItem{4052: {mikanFeedRow("from 4052", hashB)}}
	a := newTestAggregator(t,
		WithMikanFn(staticFn(nil, nil)),
		perPageFeeds(rows, map[int]bool{3951: true}, &fetched, &mu),
		WithGardenFn(staticFn(nil, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
		WithLogger(&testLogger{}),
	)

	out, err := a.FetchForAnime(context.Background(), AnimeQuery{Variants: []string{"Show"}, MikanIDs: []int32{3951, 4052}})
	require.NoError(t, err)
	assert.Equal(t, []string{"from 4052"}, titlesOf(out))
}

// A map entry with many pages reads no more than maxMikanFeeds of them, the
// first ones, in the order given.
func TestFetchForAnime_MikanPages_AreBounded(t *testing.T) {
	t.Parallel()

	var (
		mu      sync.Mutex
		fetched []int
	)
	a := newTestAggregator(t,
		WithMikanFn(staticFn(nil, nil)),
		perPageFeeds(nil, nil, &fetched, &mu),
		WithSourceRate(1000, 10),
	)

	pages := []int32{11, 12, 13, 14, 15, 16}
	_, err := a.FetchForAnime(context.Background(), AnimeQuery{MikanIDs: pages})
	require.NoError(t, err)
	assert.ElementsMatch(t, []int{11, 12, 13, 14}, fetched)
	assert.Len(t, fetched, maxMikanFeeds)
}

// The pages are a set: the same pages in another order are the same entry,
// and a different set is a different one.
func TestAnimeCacheKey_MikanPagesInAnyOrder(t *testing.T) {
	t.Parallel()

	variants := []string{"Alpha"}
	both := animeCacheKey(variants, nil, []int32{3951, 4052}, nil)
	assert.Equal(t, both, animeCacheKey(variants, nil, []int32{4052, 3951}, nil))
	assert.NotEqual(t, both, animeCacheKey(variants, nil, []int32{3951}, nil))
	assert.NotEqual(t, animeCacheKey(variants, nil, []int32{12, 3}, nil), animeCacheKey(variants, nil, []int32{1, 23}, nil),
		"page ids are separated, not concatenated")
}
