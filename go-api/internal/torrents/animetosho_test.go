// Package torrents — animetosho_test.go
//
// Covers FetchAnimeTosho / FetchAnimeToshoByAniDB and the mapping:
//   - happy path: full field mapping incl. seeders, infohash, size from
//     bytes, and unix timestamp → RFC3339 date
//   - magnet filter: rows without a "magnet:" magnet_uri (and titleless
//     rows) are dropped
//   - schema gaps: entries missing optional fields (seeders absent,
//     timestamp 0, no info_hash) map without panicking
//   - aid feed: ?aid=<id> request shape + an empty aid feed → empty slice
//   - empty array → empty slice, no error; zero-result tripwire fires on a
//     non-empty keyword query (but NOT on the aid feed)
//   - error paths: non-2xx, transport error, malformed JSON
//   - Capable: animeToshoSource advertises SupportsSeeders + a positive
//     Priority (the only Capable source in the package)
//
// Fixtures are small hand-written JSON modelled on real
// feed.animetosho.org output; nothing here touches the network
// (newRewriteClient redirects to an httptest server — same trick the other
// source tests use, and it preserves path + query so we can assert on q /
// aid / only_tor).
package torrents

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Compile-time: animeToshoSource satisfies Fetcher AND — unlike every other
// source in the package — Capable.
var (
	_ Fetcher = animeToshoSource{}
	_ Capable = animeToshoSource{}
)

// ---------------------------------------------------------------------------
// Capable — tosho is the one source that advertises seeders + priority
// ---------------------------------------------------------------------------

func TestAnimeToshoSource_ImplementsCapable(t *testing.T) {
	t.Parallel()

	caps := CapabilitiesOf(animeToshoSource{})
	assert.True(t, caps.SupportsSeeders, "tosho must advertise SupportsSeeders")
	assert.Greater(t, caps.Priority, 0, "tosho must advertise a positive Priority so its seeder rows win ties")
	assert.Equal(t, SourceTosho, animeToshoSource{}.Name())
}

// ---------------------------------------------------------------------------
// FetchAnimeTosho — happy path: full field mapping incl. seeders + date
// ---------------------------------------------------------------------------

func TestFetchAnimeTosho_HappyPath(t *testing.T) {
	t.Parallel()

	// timestamp 1735689600 == 2025-01-01T00:00:00Z.
	const body = `[
	  {
	    "title": "[SubsPlease] Frieren - 01 (1080p) [ABCD].mkv",
	    "magnet_uri": "magnet:?xt=urn:btih:AAAA1111&dn=Frieren&tr=udp://tracker.example:80",
	    "info_hash": "AAAA1111",
	    "seeders": 42,
	    "leechers": 3,
	    "total_size": 1500000000,
	    "timestamp": 1735689600,
	    "anidb_aid": 17389
	  },
	  {
	    "title": "[Group] Show - 02",
	    "magnet_uri": "magnet:?xt=urn:btih:bbbb2222",
	    "info_hash": "BBBB2222",
	    "seeders": 0,
	    "total_size": 0,
	    "timestamp": 0
	  }
	]`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "frieren", r.URL.Query().Get("q"))
		assert.Equal(t, "1", r.URL.Query().Get("only_tor"))
		assert.Equal(t, "AnimeGo/1.0", r.Header.Get("User-Agent"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAnimeTosho(context.Background(), httpClient, nil, "frieren")
	require.NoError(t, err)
	require.Len(t, items, 2)

	it := items[0]
	assert.Equal(t, "[SubsPlease] Frieren - 01 (1080p) [ABCD].mkv", it.Title)
	assert.Equal(t, "magnet:?xt=urn:btih:AAAA1111&dn=Frieren&tr=udp://tracker.example:80", it.Magnet)
	assert.Equal(t, SourceTosho, it.Source)
	assert.Equal(t, "1.5 GB", it.Size, "total_size bytes → FormatBytes")
	assert.Equal(t, "aaaa1111", it.Infohash, "info_hash normalised to lowercase")
	require.NotNil(t, it.Seeders, "tosho reports seeders")
	assert.Equal(t, 42, *it.Seeders)
	require.NotNil(t, it.Date)
	assert.Equal(t, "2025-01-01T00:00:00Z", *it.Date, "unix timestamp → RFC3339 UTC (parseable by rank.go)")
	assert.Nil(t, it.Provider, "tosho never sets provider")

	// Second row: seeders 0 is a genuine known-zero (NOT nil), total_size 0
	// → empty Size, timestamp 0 → nil Date.
	second := items[1]
	require.NotNil(t, second.Seeders, `"seeders":0 is a known zero, not unknown`)
	assert.Equal(t, 0, *second.Seeders)
	assert.Equal(t, "", second.Size, `total_size 0 → empty Size`)
	assert.Nil(t, second.Date, "timestamp 0 → nil Date")
}

// ---------------------------------------------------------------------------
// FetchAnimeTosho — non-magnet / titleless rows are dropped
// ---------------------------------------------------------------------------

func TestFetchAnimeTosho_NonMagnetAndTitlelessDropped(t *testing.T) {
	t.Parallel()

	const body = `[
	  {
	    "title": "[X] http link, not a magnet",
	    "magnet_uri": "https://animetosho.org/view/1",
	    "info_hash": "1111",
	    "total_size": 100
	  },
	  {
	    "title": "",
	    "magnet_uri": "magnet:?xt=urn:btih:2222",
	    "info_hash": "2222",
	    "total_size": 100
	  },
	  {
	    "title": "[Y] Valid",
	    "magnet_uri": "magnet:?xt=urn:btih:3333",
	    "info_hash": "3333",
	    "total_size": 100
	  }
	]`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAnimeTosho(context.Background(), httpClient, nil, "x")
	require.NoError(t, err)
	require.Len(t, items, 1, "only the magnet-bearing item with a title survives")
	assert.Equal(t, "[Y] Valid", items[0].Title)
	assert.Equal(t, "magnet:?xt=urn:btih:3333", items[0].Magnet)
}

// ---------------------------------------------------------------------------
// FetchAnimeTosho — schema gaps must not panic
// ---------------------------------------------------------------------------

func TestFetchAnimeTosho_MissingFieldsNoPanic(t *testing.T) {
	t.Parallel()

	// A row carrying only the two required fields (title + magnet_uri):
	// seeders absent, no info_hash, no total_size, no timestamp, plus an
	// unknown extra column the decoder must ignore.
	const body = `[
	  {
	    "title": "[Z] Bare row",
	    "magnet_uri": "magnet:?xt=urn:btih:cafe",
	    "some_future_field": {"nested": true}
	  }
	]`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)

	var items []TorrentItem
	var err error
	require.NotPanics(t, func() {
		items, err = FetchAnimeTosho(context.Background(), httpClient, nil, "z")
	}, "missing optional fields must not panic")
	require.NoError(t, err)
	require.Len(t, items, 1)

	it := items[0]
	assert.Equal(t, "[Z] Bare row", it.Title)
	assert.Nil(t, it.Seeders, "absent seeders → nil (unknown), not 0")
	assert.Equal(t, "", it.Size, "absent total_size → empty Size")
	assert.Nil(t, it.Date, "absent timestamp → nil Date")
	assert.Equal(t, "", it.Infohash, "absent info_hash → empty Infohash")
}

// ---------------------------------------------------------------------------
// FetchAnimeTosho — empty array + zero-result tripwire
// ---------------------------------------------------------------------------

func TestFetchAnimeTosho_EmptyArray(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAnimeTosho(context.Background(), httpClient, nil, "no-results")
	require.NoError(t, err)
	assert.Empty(t, items, "empty array produces an empty slice without error")
}

func TestFetchAnimeTosho_ZeroResultTripwireFires(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	log := &testLogger{}
	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAnimeTosho(context.Background(), httpClient, log, "frieren")
	require.NoError(t, err)
	assert.Empty(t, items)

	entry, ok := log.findEntry("zero-result")
	require.True(t, ok, "a 200 + zero rows for a non-empty query should warn")
	require.GreaterOrEqual(t, len(entry.args), 2)
	assert.Equal(t, "query", entry.args[0])
	assert.Equal(t, "frieren", entry.args[1])
}

// ---------------------------------------------------------------------------
// FetchAnimeToshoByAniDB — request shape + empty feed, no tripwire
// ---------------------------------------------------------------------------

func TestFetchAnimeToshoByAniDB_HappyPath(t *testing.T) {
	t.Parallel()

	const body = `[
	  {
	    "title": "[SubsPlease] Frieren - 03",
	    "magnet_uri": "magnet:?xt=urn:btih:dead",
	    "info_hash": "DEAD",
	    "seeders": 7,
	    "total_size": 700000000,
	    "timestamp": 1735689600,
	    "anidb_aid": 17389
	  }
	]`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "17389", r.URL.Query().Get("aid"), "aid feed rides on ?aid=")
		assert.Equal(t, "1", r.URL.Query().Get("only_tor"))
		assert.Empty(t, r.URL.Query().Get("q"), "aid feed must not send a keyword")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAnimeToshoByAniDB(context.Background(), httpClient, 17389)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "[SubsPlease] Frieren - 03", items[0].Title)
	require.NotNil(t, items[0].Seeders)
	assert.Equal(t, 7, *items[0].Seeders)
	assert.Equal(t, SourceTosho, items[0].Source)
}

func TestFetchAnimeToshoByAniDB_EmptyFeed(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAnimeToshoByAniDB(context.Background(), httpClient, 999999)
	require.NoError(t, err)
	assert.Empty(t, items, "an empty aid feed is a legitimate no-results, not an error")
}

// ---------------------------------------------------------------------------
// FetchAnimeTosho — error paths
// ---------------------------------------------------------------------------

func TestFetchAnimeTosho_Non2xxStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAnimeTosho(context.Background(), httpClient, nil, "x")
	require.Error(t, err)
	assert.Empty(t, items)
	assert.Contains(t, err.Error(), "tosho")
}

func TestFetchAnimeTosho_TransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // server gone → dial fails

	httpClient := newRewriteClient(url)
	items, err := FetchAnimeTosho(context.Background(), httpClient, nil, "x")
	require.Error(t, err)
	assert.Empty(t, items)
}

func TestFetchAnimeTosho_MalformedJSON(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{not json`))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	_, err := FetchAnimeTosho(context.Background(), httpClient, nil, "x")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode")
}

// ---------------------------------------------------------------------------
// URL builders — query-param encoding
// ---------------------------------------------------------------------------

func TestBuildToshoSearchURL_EncodesQuery(t *testing.T) {
	t.Parallel()

	got, err := buildToshoSearchURL("葬送的 芙莉莲")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(got, toshoEndpoint+"?"), "endpoint base preserved")
	assert.Contains(t, got, "only_tor=1", "only_tor flag present")
	assert.Contains(t, got, "q=", "q param present")
	assert.NotContains(t, got, "葬送", "CJK must be percent-encoded")
	assert.NotContains(t, got, " ", "spaces must be percent-encoded")
}

func TestBuildToshoAniDBURL_EncodesID(t *testing.T) {
	t.Parallel()

	got, err := buildToshoAniDBURL(17389)
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(got, toshoEndpoint+"?"), "endpoint base preserved")
	assert.Contains(t, got, "aid=17389", "aid param present")
	assert.Contains(t, got, "only_tor=1", "only_tor flag present")
	assert.NotContains(t, got, "q=", "aid feed must not carry a keyword param")
}

// ---------------------------------------------------------------------------
// toshoDate — unix → RFC3339 / nil for non-positive
// ---------------------------------------------------------------------------

func TestToshoDate(t *testing.T) {
	t.Parallel()

	assert.Nil(t, toshoDate(0), "timestamp 0 → nil")
	assert.Nil(t, toshoDate(-5), "negative timestamp → nil")

	got := toshoDate(1735689600)
	require.NotNil(t, got)
	assert.Equal(t, "2025-01-01T00:00:00Z", *got)

	// The formatted date must round-trip through rank.go's parser so date
	// ordering works for tosho rows.
	parsed := parseItemDate(got)
	assert.False(t, parsed.IsZero(), "rank.go must be able to parse the tosho date")
	assert.Equal(t, time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), parsed.UTC())
}
