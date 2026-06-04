// Package torrents — aggregator_foranime_test.go
//
// Covers FetchForAnime, the id-keyed counterpart to Fetch:
//   - variant fan-out: each cleaned variant runs the registry fan-out once,
//     so an N-variant call invokes every source N times
//   - cross-variant dedup: the same infohash surfaced under two variants
//     collapses to a single row
//   - AniDB aid feed: a non-nil anidbID folds AnimeTosho's ?aid= feed into
//     the result (and overlap with a keyword hit dedups by infohash)
//   - shared cache: a second call with the same variant set (in any order)
//     is served from cache — the fetchers do NOT re-run, and a one-keyword
//     Fetch never aliases a single-variant FetchForAnime
//   - degrade paths: nil anidbID issues no aid feed; an empty variant set
//     with no aid short-circuits to [] with zero upstream calls
//   - empty-result short TTL still applies via the shared cacheResult path
//
// Registry sources are stubbed via the existing WithXxxFn options; the aid
// feed (FetchAnimeToshoByAniDB, not a registry Fetcher) is exercised through
// an injected rewrite client pointed at an httptest server.
package torrents

import (
	"context"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// magnetWith builds a magnet carrying a valid 40-hex v1 infohash derived
// from an arbitrary seed string.  The seed is hex-encoded (so any input
// yields valid hex digits, unlike pasting the seed in raw) and then padded /
// truncated to exactly 40 chars so parseInfohash accepts it.  Equal seeds
// produce equal hashes → drives cross-source / cross-variant dedup
// deterministically.
func magnetWith(seed string) string {
	h := hex.EncodeToString([]byte(seed))
	for len(h) < hexLenV1 {
		h += "0"
	}
	return "magnet:?xt=urn:btih:" + h[:hexLenV1]
}

// itemWithHash builds a single TorrentItem for src whose magnet carries the
// infohash derived from seed.
func itemWithHash(src Source, seed string) TorrentItem {
	return TorrentItem{
		Title:  "stub-" + string(src) + "-" + seed,
		Magnet: magnetWith(seed),
		Size:   "1 GB",
		Source: src,
	}
}

// ---------------------------------------------------------------------------
// Variant fan-out: each variant runs the registry once
// ---------------------------------------------------------------------------

func TestFetchForAnime_VariantFanOut_RunsEachSourcePerVariant(t *testing.T) {
	t.Parallel()

	var gc, ac, nc atomic.Int32
	// Each source returns a unique infohash per call so nothing dedups —
	// we only want to count fan-out invocations and total rows here.
	var seq atomic.Int32
	uniqueFn := func(src Source, counter *atomic.Int32) fetchFn {
		return func(_ context.Context, _ string) ([]TorrentItem, error) {
			counter.Add(1)
			n := seq.Add(1)
			return []TorrentItem{itemWithHash(src, string(rune('a'+byte(n%26)))+string(rune('a'+byte(n/26))))}, nil
		}
	}

	a := newTestAggregator(t,
		WithGardenFn(uniqueFn(SourceGarden, &gc)),
		WithAcgFn(uniqueFn(SourceAcg, &ac)),
		WithNyaaFn(uniqueFn(SourceNyaa, &nc)),
	)

	out, err := a.FetchForAnime(context.Background(), []string{"Naruto", "ナルト"}, nil)
	require.NoError(t, err)

	// 3 stubbed sources × 2 variants = 6 invocations, 6 rows (all unique).
	assert.Equal(t, int32(2), gc.Load(), "garden runs once per variant")
	assert.Equal(t, int32(2), ac.Load(), "acg runs once per variant")
	assert.Equal(t, int32(2), nc.Load(), "nyaa runs once per variant")
	assert.Len(t, out, 6, "all six unique rows survive (no dedup)")
}

// ---------------------------------------------------------------------------
// Cross-variant dedup: same infohash under two variants → one row
// ---------------------------------------------------------------------------

func TestFetchForAnime_DedupsAcrossVariants(t *testing.T) {
	t.Parallel()

	// garden returns the SAME infohash regardless of the variant it is
	// queried with, so the two variant fan-outs surface a duplicate that
	// must collapse to a single row.
	shared := itemWithHash(SourceGarden, "dupe")
	a := newTestAggregator(t,
		WithGardenFn(func(_ context.Context, _ string) ([]TorrentItem, error) {
			return []TorrentItem{shared}, nil
		}),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
	)

	out, err := a.FetchForAnime(context.Background(), []string{"title-a", "title-b"}, nil)
	require.NoError(t, err)
	require.Len(t, out, 1, "the same infohash under two variants dedups to one row")
	assert.Equal(t, parseInfohash(shared.Magnet), out[0].Infohash, "survivor carries the normalised infohash")
}

// ---------------------------------------------------------------------------
// AniDB aid feed: non-nil anidbID folds in AnimeTosho's ?aid= feed
// ---------------------------------------------------------------------------

func TestFetchForAnime_FoldsInAniDBFeed(t *testing.T) {
	t.Parallel()

	var sawAid atomic.Bool
	// httptest server returns one aid-feed row carrying seeders so we can
	// also confirm the row survives the ranker.  It only answers when the
	// request actually carried ?aid=<id>.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("aid") == "17389" {
			sawAid.Store(true)
			_, _ = w.Write([]byte(`[{"title":"[SubsPlease] Show (1080p) [AID].mkv","magnet_uri":"magnet:?xt=urn:btih:a1dfeed000000000000000000000000000000000","info_hash":"a1dfeed000000000000000000000000000000000","seeders":42,"total_size":1500000000,"timestamp":1735689600,"anidb_aid":17389}]`))
			return
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	a := newTestAggregator(t,
		// Registry sources stubbed empty so the only rows come from the aid feed.
		WithGardenFn(staticFn(nil, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
		// Inject the rewrite client so FetchAnimeToshoByAniDB hits our server.
		WithHTTPClient(newRewriteClient(srv.URL)),
	)

	aid := int32(17389)
	out, err := a.FetchForAnime(context.Background(), []string{"some-title"}, &aid)
	require.NoError(t, err)
	require.True(t, sawAid.Load(), "the aid feed must be requested with ?aid=<id>")
	require.Len(t, out, 1, "the aid-feed row is merged into the result")
	assert.Equal(t, SourceTosho, out[0].Source)
	require.NotNil(t, out[0].Seeders)
	assert.Equal(t, 42, *out[0].Seeders, "aid-feed seeder count survives")
}

// The keyword fan-out and the aid feed overlap in practice (AnimeTosho
// surfaces the same torrent both ways); the overlap must dedup by infohash.
func TestFetchForAnime_AniDBFeedOverlapDedups(t *testing.T) {
	t.Parallel()

	const hash = "0123456789abcdef0123456789abcdef01234567"
	magnet := "magnet:?xt=urn:btih:" + hash

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("aid") != "" {
			// aid feed: same infohash, but WITHOUT seeders.
			_, _ = w.Write([]byte(`[{"title":"aid copy","magnet_uri":"` + magnet + `","info_hash":"` + hash + `","total_size":1000000000,"timestamp":1735689600}]`))
			return
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	seeders := 99
	// garden surfaces the SAME infohash via the keyword fan-out, but WITH a
	// seeder count — dedup must keep the richer (seeder-bearing) copy.
	a := newTestAggregator(t,
		WithGardenFn(func(_ context.Context, _ string) ([]TorrentItem, error) {
			return []TorrentItem{{Title: "garden copy", Magnet: magnet, Source: SourceGarden, Seeders: &seeders}}, nil
		}),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
		WithHTTPClient(newRewriteClient(srv.URL)),
	)

	aid := int32(555)
	out, err := a.FetchForAnime(context.Background(), []string{"dup-title"}, &aid)
	require.NoError(t, err)
	require.Len(t, out, 1, "keyword hit + aid-feed hit for the same torrent dedups to one row")
	require.NotNil(t, out[0].Seeders, "the seeder-bearing copy wins the dedup")
	assert.Equal(t, 99, *out[0].Seeders)
}

// ---------------------------------------------------------------------------
// Shared cache across variants (sorted-join key)
// ---------------------------------------------------------------------------

func TestFetchForAnime_CacheSharedAcrossVariantOrder(t *testing.T) {
	t.Parallel()

	var gc atomic.Int32
	a := newTestAggregator(t,
		WithGardenFn(staticFn([]TorrentItem{itemWithHash(SourceGarden, "cafe")}, &gc)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
	)

	first, err := a.FetchForAnime(context.Background(), []string{"Alpha", "Beta"}, nil)
	require.NoError(t, err)
	require.Len(t, first, 1)
	require.Equal(t, int32(2), gc.Load(), "two variants → garden ran twice on the miss")

	a.cache.Wait()

	// Same variant SET, reversed order + different casing → same cache key.
	second, err := a.FetchForAnime(context.Background(), []string{"beta", "ALPHA"}, nil)
	require.NoError(t, err)
	require.Len(t, second, 1, "cache hit returns the same shape")
	assert.Equal(t, int32(2), gc.Load(), "reordered/recased variant set must reuse the cached entry")
}

// A single-variant FetchForAnime and a one-keyword Fetch for the same string
// must NOT collide — the anime key is namespaced away from the plain key.
func TestFetchForAnime_DoesNotAliasFetchKey(t *testing.T) {
	t.Parallel()

	var gc atomic.Int32
	a := newTestAggregator(t,
		WithGardenFn(staticFn([]TorrentItem{itemWithHash(SourceGarden, "beef")}, &gc)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
	)

	_, err := a.Fetch(context.Background(), "naruto")
	require.NoError(t, err)
	require.Equal(t, int32(1), gc.Load())
	a.cache.Wait()

	// Same string via the anime path — must MISS (distinct namespace), so
	// garden runs again rather than serving Fetch's cached entry.
	_, err = a.FetchForAnime(context.Background(), []string{"naruto"}, nil)
	require.NoError(t, err)
	assert.Equal(t, int32(2), gc.Load(), "anime-keyed lookup must not alias the plain Fetch key")
}

// ---------------------------------------------------------------------------
// Degrade paths
// ---------------------------------------------------------------------------

func TestFetchForAnime_NoVariantsNoAid_ShortCircuits(t *testing.T) {
	t.Parallel()

	var gc, ac, nc atomic.Int32
	a := newTestAggregator(t,
		WithGardenFn(staticFn([]TorrentItem{stubItem(SourceGarden)}, &gc)),
		WithAcgFn(staticFn([]TorrentItem{stubItem(SourceAcg)}, &ac)),
		WithNyaaFn(staticFn([]TorrentItem{stubItem(SourceNyaa)}, &nc)),
	)

	// Only blank variants and no aid → nothing to search.
	out, err := a.FetchForAnime(context.Background(), []string{"", "   ", "\t"}, nil)
	require.NoError(t, err)
	assert.Empty(t, out)
	assert.Equal(t, int32(0), gc.Load(), "no fan-out when there is nothing to search")
	assert.Equal(t, int32(0), ac.Load())
	assert.Equal(t, int32(0), nc.Load())
}

func TestFetchForAnime_NilAniDB_NoFeedRequested(t *testing.T) {
	t.Parallel()

	var hitServer atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hitServer.Store(true)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	a := newTestAggregator(t,
		WithGardenFn(staticFn([]TorrentItem{itemWithHash(SourceGarden, "feed")}, nil)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
		WithHTTPClient(newRewriteClient(srv.URL)),
	)

	out, err := a.FetchForAnime(context.Background(), []string{"title"}, nil)
	require.NoError(t, err)
	require.Len(t, out, 1)
	assert.False(t, hitServer.Load(), "nil anidbID must NOT issue an aid-feed request")
}

// ---------------------------------------------------------------------------
// Empty result still takes the short TTL via the shared cacheResult path
// ---------------------------------------------------------------------------

func TestFetchForAnime_EmptyResult_ShortTTL_ReFetches(t *testing.T) {
	t.Parallel()

	var gc atomic.Int32
	a := newTestAggregator(t,
		WithGardenFn(staticFn(nil, &gc)),
		WithAcgFn(staticFn(nil, nil)),
		WithNyaaFn(staticFn(nil, nil)),
		WithEmptyCacheTTL(50*time.Millisecond),
	)

	out, err := a.FetchForAnime(context.Background(), []string{"obscure"}, nil)
	require.NoError(t, err)
	require.Empty(t, out)
	require.Equal(t, int32(1), gc.Load())

	a.cache.Wait()

	// Within the short window: cached empty, no re-fetch.
	_, err = a.FetchForAnime(context.Background(), []string{"obscure"}, nil)
	require.NoError(t, err)
	assert.Equal(t, int32(1), gc.Load(), "empty result cached within its short TTL")

	// After expiry: re-fetch.
	time.Sleep(150 * time.Millisecond)
	_, err = a.FetchForAnime(context.Background(), []string{"obscure"}, nil)
	require.NoError(t, err)
	assert.Equal(t, int32(2), gc.Load(), "empty anime result must expire fast and re-fetch")
}

// ---------------------------------------------------------------------------
// cleanVariants / animeCacheKey — direct unit coverage
// ---------------------------------------------------------------------------

func TestCleanVariants_TrimsAndDropsEmpties(t *testing.T) {
	t.Parallel()

	got := cleanVariants([]string{"  Naruto  ", "", "   ", "Bleach", "\tOne Piece\n"})
	assert.Equal(t, []string{"Naruto", "Bleach", "One Piece"}, got)
}

func TestAnimeCacheKey_OrderAndCaseInsensitive(t *testing.T) {
	t.Parallel()

	k1 := animeCacheKey([]string{"Alpha", "Beta"}, nil)
	k2 := animeCacheKey([]string{"beta", "ALPHA"}, nil)
	assert.Equal(t, k1, k2, "key is sorted + lowercased so order/case don't matter")

	aid := int32(7)
	withAid := animeCacheKey([]string{"Alpha", "Beta"}, &aid)
	assert.NotEqual(t, k1, withAid, "adding an aid changes the key")
}
