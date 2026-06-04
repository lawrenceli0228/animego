// Package torrents — mikan_test.go
//
// Covers FetchMikan and its Mikan-specific mapping:
//   - happy path: .torrent enclosure URL → 40-hex infohash → magnet via
//     buildNyaaMagnet (hash + url-encoded title + both nyaa trackers)
//   - size from the namespaced <torrent><contentLength> (bytes →
//     FormatBytes), NOT the enclosure @length (which Mikan sends as 0)
//   - infohash fallback: when the enclosure URL lacks a hash, recover it
//     from the episode <link>
//   - no hash anywhere → item dropped (buildNyaaMagnet returns the
//     non-magnet link → filtered)
//   - missing title → dropped
//   - date fallback to namespaced torrent pubDate when channel pubDate
//     is absent
//   - error paths: non-2xx, transport error, malformed XML
//   - request is built with ?searchstr=<q>
//
// Fixtures are small hand-written XML modelled on real mikanani.me
// output (including the xmlns:torrent="https://mikanani.me/0.1/"
// namespace); nothing here touches the network.
package torrents

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Compile-time: mikanSource satisfies Fetcher; like the other RSS
// scrapes it must NOT implement Capable.
var _ Fetcher = mikanSource{}

func TestMikanSource_DoesNotImplementCapable(t *testing.T) {
	t.Parallel()
	if _, ok := any(mikanSource{}).(Capable); ok {
		t.Fatal("mikanSource should NOT implement Capable")
	}
	assert.Equal(t, Capabilities{}, CapabilitiesOf(mikanSource{}))
	assert.Equal(t, SourceMikan, mikanSource{}.Name())
}

// 40-hex infohashes reused across the fixtures.
const (
	mikanHashA = "0123456789abcdef0123456789abcdef01234567"
	mikanHashB = "ffffffffffffffffffffffffffffffffffffffff"
)

// mikanRSSHeader / Footer wrap per-test <item> blocks.  The
// xmlns:torrent URI must match mikanNamespaceURI in mikan.go or
// encoding/xml will not resolve the <torrent><contentLength> element.
const mikanRSSHeader = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torrent="https://mikanani.me/0.1/">
  <channel>
    <title>Mikan Project</title>`

const mikanRSSFooter = `
  </channel>
</rss>`

// ---------------------------------------------------------------------------
// FetchMikan — happy path: infohash from .torrent URL → magnet
// ---------------------------------------------------------------------------

func TestFetchMikan_HappyPath(t *testing.T) {
	t.Parallel()

	const body = mikanRSSHeader + `
    <item>
      <title>[喵萌奶茶屋] 番名 - 01 [1080p]</title>
      <link>https://mikanani.me/Home/Episode/` + mikanHashA + `</link>
      <enclosure type="application/x-bittorrent" length="0"
        url="https://mikanani.me/Download/20260101/` + mikanHashA + `.torrent"/>
      <torrent xmlns="https://mikanani.me/0.1/">
        <link>https://mikanani.me/Home/Episode/` + mikanHashA + `</link>
        <contentLength>1500000000</contentLength>
        <pubDate>2026-01-01T12:00:00</pubDate>
      </torrent>
    </item>` + mikanRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "frieren", r.URL.Query().Get("searchstr"))
		assert.Equal(t, "AnimeGo/1.0", r.Header.Get("User-Agent"))
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchMikan(context.Background(), httpClient, "frieren")
	require.NoError(t, err)
	require.Len(t, items, 1)

	it := items[0]
	assert.Equal(t, "[喵萌奶茶屋] 番名 - 01 [1080p]", it.Title)
	assert.Equal(t, SourceMikan, it.Source)
	assert.Nil(t, it.Provider, "mikan never sets provider")

	// Size comes from the namespaced contentLength (bytes), not the
	// enclosure length="0".
	assert.Equal(t, "1.5 GB", it.Size, "size must come from <torrent><contentLength>, not enclosure length=0")

	// Magnet must be synthesised via buildNyaaMagnet: hash + url-encoded
	// title + BOTH nyaa trackers.
	assert.True(t, strings.HasPrefix(it.Magnet, "magnet:?xt=urn:btih:"+mikanHashA),
		"magnet must embed the infohash from the .torrent URL")
	assert.Contains(t, it.Magnet, "&dn=")
	assert.Contains(t, it.Magnet, "&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce")
	assert.Contains(t, it.Magnet, "&tr=http%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce")

	// &dn= must decode back to the original title.
	dn := extractMagnetParam(t, it.Magnet, "dn")
	assert.Equal(t, "[喵萌奶茶屋] 番名 - 01 [1080p]", dn)

	require.NotNil(t, it.Fansub)
	assert.Equal(t, "喵萌奶茶屋", *it.Fansub)
	require.NotNil(t, it.Date)
	assert.Equal(t, "2026-01-01T12:00:00", *it.Date, "channel pubDate absent → falls back to torrent pubDate")
}

// ---------------------------------------------------------------------------
// FetchMikan — infohash recovered from <link> when enclosure URL lacks one
// ---------------------------------------------------------------------------

func TestFetchMikan_InfoHashFallbackToLink(t *testing.T) {
	t.Parallel()

	// Enclosure URL has NO 40-hex hash; the episode <link> does.
	const body = mikanRSSHeader + `
    <item>
      <title>[Sub] Fallback - 02</title>
      <link>https://mikanani.me/Home/Episode/` + mikanHashB + `</link>
      <enclosure type="application/x-bittorrent" length="0"
        url="https://mikanani.me/Download/20260101/file.torrent"/>
      <torrent xmlns="https://mikanani.me/0.1/">
        <contentLength>800000000</contentLength>
        <pubDate>2026-01-02T00:00:00</pubDate>
      </torrent>
    </item>` + mikanRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchMikan(context.Background(), httpClient, "x")
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.True(t, strings.HasPrefix(items[0].Magnet, "magnet:?xt=urn:btih:"+mikanHashB),
		"infohash must be recovered from <link> when the enclosure URL has none")
	assert.Equal(t, "800 MB", items[0].Size)
}

// ---------------------------------------------------------------------------
// FetchMikan — no hash anywhere / missing title → dropped
// ---------------------------------------------------------------------------

func TestFetchMikan_NoHashAndMissingTitleDropped(t *testing.T) {
	t.Parallel()

	const body = mikanRSSHeader + `
    <item>
      <title>[X] No hash in URL or link</title>
      <link>https://mikanani.me/Home/Episode/not-a-hash</link>
      <enclosure type="application/x-bittorrent" length="0"
        url="https://mikanani.me/Download/20260101/file.torrent"/>
      <torrent xmlns="https://mikanani.me/0.1/">
        <contentLength>100</contentLength>
      </torrent>
    </item>
    <item>
      <title></title>
      <link>https://mikanani.me/Home/Episode/` + mikanHashA + `</link>
      <enclosure type="application/x-bittorrent" length="0"
        url="https://mikanani.me/Download/20260101/` + mikanHashA + `.torrent"/>
      <torrent xmlns="https://mikanani.me/0.1/">
        <contentLength>100</contentLength>
      </torrent>
    </item>
    <item>
      <title>[Y] Valid</title>
      <link>https://mikanani.me/Home/Episode/` + mikanHashB + `</link>
      <enclosure type="application/x-bittorrent" length="0"
        url="https://mikanani.me/Download/20260101/` + mikanHashB + `.torrent"/>
      <torrent xmlns="https://mikanani.me/0.1/">
        <contentLength>100</contentLength>
      </torrent>
    </item>` + mikanRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchMikan(context.Background(), httpClient, "x")
	require.NoError(t, err)
	require.Len(t, items, 1, "only the hash-bearing item with a title survives")
	assert.Equal(t, "[Y] Valid", items[0].Title)
}

// ---------------------------------------------------------------------------
// FetchMikan — channel pubDate preferred over torrent pubDate
// ---------------------------------------------------------------------------

func TestFetchMikan_ChannelPubDatePreferred(t *testing.T) {
	t.Parallel()

	const body = mikanRSSHeader + `
    <item>
      <title>[Sub] Has both dates - 03</title>
      <link>https://mikanani.me/Home/Episode/` + mikanHashA + `</link>
      <pubDate>Sat, 03 Jan 2026 09:00:00 GMT</pubDate>
      <enclosure type="application/x-bittorrent" length="0"
        url="https://mikanani.me/Download/20260103/` + mikanHashA + `.torrent"/>
      <torrent xmlns="https://mikanani.me/0.1/">
        <contentLength>100</contentLength>
        <pubDate>2026-01-03T09:00:00</pubDate>
      </torrent>
    </item>` + mikanRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchMikan(context.Background(), httpClient, "x")
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.NotNil(t, items[0].Date)
	assert.Equal(t, "Sat, 03 Jan 2026 09:00:00 GMT", *items[0].Date,
		"channel-level pubDate wins over the namespaced torrent pubDate")
}

// ---------------------------------------------------------------------------
// FetchMikan — error paths
// ---------------------------------------------------------------------------

func TestFetchMikan_Non2xxStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchMikan(context.Background(), httpClient, "x")
	require.Error(t, err)
	assert.Empty(t, items)
	assert.Contains(t, err.Error(), "mikan")
}

func TestFetchMikan_TransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	httpClient := newRewriteClient(url)
	_, err := FetchMikan(context.Background(), httpClient, "x")
	require.Error(t, err)
}

func TestFetchMikan_MalformedXML(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<oops>`))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	_, err := FetchMikan(context.Background(), httpClient, "x")
	require.Error(t, err)
}

// ---------------------------------------------------------------------------
// buildMikanURL — searchstr param encoding
// ---------------------------------------------------------------------------

func TestBuildMikanURL_EncodesSearchstr(t *testing.T) {
	t.Parallel()

	got, err := buildMikanURL("葬送的 芙莉莲")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(got, mikanEndpoint+"?"), "endpoint base preserved")
	assert.Contains(t, got, "searchstr=", "searchstr param present")
	assert.NotContains(t, got, "葬送", "CJK must be percent-encoded")
	assert.NotContains(t, got, " ", "spaces must be percent-encoded")
}

// ---------------------------------------------------------------------------
// mikanInfoHash — unit coverage of the extraction precedence
// ---------------------------------------------------------------------------

func TestMikanInfoHash_PrefersEnclosureThenLink(t *testing.T) {
	t.Parallel()

	// Enclosure hash wins when both are present.
	withBoth := mikanItem{Torrent: mikanTorrentExt{}}
	withBoth.Enclosure.URL = "https://mikanani.me/Download/x/" + mikanHashA + ".torrent"
	withBoth.Link = "https://mikanani.me/Home/Episode/" + mikanHashB
	assert.Equal(t, mikanHashA, mikanInfoHash(withBoth), "enclosure URL hash takes precedence")

	// Falls back to link when enclosure has none.
	linkOnly := mikanItem{}
	linkOnly.Enclosure.URL = "https://mikanani.me/Download/x/file.torrent"
	linkOnly.Link = "https://mikanani.me/Home/Episode/" + mikanHashB
	assert.Equal(t, mikanHashB, mikanInfoHash(linkOnly), "falls back to <link> hash")

	// Neither → empty.
	none := mikanItem{}
	none.Enclosure.URL = "https://mikanani.me/Download/x/file.torrent"
	none.Link = "https://mikanani.me/Home/Episode/none"
	assert.Equal(t, "", mikanInfoHash(none), "no 40-hex anywhere → empty")
}
