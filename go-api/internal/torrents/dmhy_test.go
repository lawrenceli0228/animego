// Package torrents — dmhy_test.go
//
// Covers FetchDmhy (and its shared rss.go plumbing):
//   - happy path: enclosure-magnet parsing, with the wire-level &amp;
//     in the magnet URL auto-decoded back to & by encoding/xml
//   - fansub bracket parse + CJK title survival
//   - length="0" → empty Size (FormatBytes returns "")
//   - non-magnet enclosure / missing title → item dropped
//   - empty channel → empty slice, no error
//   - error paths: non-2xx, transport error, malformed XML
//   - request is built with ?keyword=<q>
//
// Fixtures are small hand-written XML modelled on real share.dmhy.org
// output; nothing here touches the network (newRewriteClient redirects
// to an httptest server — same trick acgrip/nyaa tests use).
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

// Compile-time: dmhySource satisfies Fetcher; like the other RSS
// scrapes it must NOT implement Capable (no seeders / special budget).
var _ Fetcher = dmhySource{}

func TestDmhySource_DoesNotImplementCapable(t *testing.T) {
	t.Parallel()
	if _, ok := any(dmhySource{}).(Capable); ok {
		t.Fatal("dmhySource should NOT implement Capable")
	}
	assert.Equal(t, Capabilities{}, CapabilitiesOf(dmhySource{}))
	assert.Equal(t, SourceDmhy, dmhySource{}.Name())
}

// dmhyRSSHeader / Footer wrap the per-test <item> blocks in the dmhy
// RSS envelope.  dmhy uses a plain RSS 2.0 feed (no custom namespace).
const dmhyRSSHeader = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>share.dmhy.org</title>`

const dmhyRSSFooter = `
  </channel>
</rss>`

// ---------------------------------------------------------------------------
// FetchDmhy — happy path: magnet straight from the enclosure
// ---------------------------------------------------------------------------

func TestFetchDmhy_HappyPath(t *testing.T) {
	t.Parallel()

	// The magnet's "&" are XML-escaped as "&amp;" on the wire, exactly
	// as dmhy sends them.  encoding/xml must decode them back to a
	// usable magnet with literal "&" separators.
	const body = dmhyRSSHeader + `
    <item>
      <title>[喵萌奶茶屋] 葬送的芙莉莲 / Sousou no Frieren - 01 [1080p]</title>
      <link>https://share.dmhy.org/topics/view/1.html</link>
      <pubDate>Sat, 01 Jan 2026 00:00:00 +0800</pubDate>
      <enclosure url="magnet:?xt=urn:btih:aaaa1111&amp;dn=Frieren&amp;tr=udp://tracker.example:80" type="application/x-bittorrent" length="1500000000"/>
    </item>
    <item>
      <title>[Sub] Show - 02</title>
      <link>https://share.dmhy.org/topics/view/2.html</link>
      <pubDate>Sat, 01 Jan 2026 01:00:00 +0800</pubDate>
      <enclosure url="magnet:?xt=urn:btih:bbbb2222" type="application/x-bittorrent" length="0"/>
    </item>` + dmhyRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "frieren", r.URL.Query().Get("keyword"))
		assert.Equal(t, "AnimeGo/1.0", r.Header.Get("User-Agent"))
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchDmhy(context.Background(), httpClient, "frieren")
	require.NoError(t, err)
	require.Len(t, items, 2)

	it := items[0]
	assert.Equal(t, "[喵萌奶茶屋] 葬送的芙莉莲 / Sousou no Frieren - 01 [1080p]", it.Title)
	// The &amp; entities must be decoded to literal & in the magnet.
	assert.Equal(t, "magnet:?xt=urn:btih:aaaa1111&dn=Frieren&tr=udp://tracker.example:80", it.Magnet)
	assert.NotContains(t, it.Magnet, "&amp;", "XML entity must be decoded, not left as &amp;")
	assert.Equal(t, "1.5 GB", it.Size)
	require.NotNil(t, it.Fansub)
	assert.Equal(t, "喵萌奶茶屋", *it.Fansub)
	assert.Equal(t, SourceDmhy, it.Source)
	assert.Nil(t, it.Provider, "dmhy never sets provider")
	require.NotNil(t, it.Date)
	assert.Equal(t, "Sat, 01 Jan 2026 00:00:00 +0800", *it.Date)

	// Second item: length="0" → FormatBytes returns "" (no size).
	assert.Equal(t, "magnet:?xt=urn:btih:bbbb2222", items[1].Magnet)
	assert.Equal(t, "", items[1].Size, `length="0" yields an empty Size`)
}

// ---------------------------------------------------------------------------
// FetchDmhy — non-magnet enclosure / missing title are dropped
// ---------------------------------------------------------------------------

func TestFetchDmhy_NonMagnetAndMissingTitleDropped(t *testing.T) {
	t.Parallel()

	const body = dmhyRSSHeader + `
    <item>
      <title>[X] HTTP enclosure, not a magnet</title>
      <link>https://share.dmhy.org/topics/view/1.html</link>
      <pubDate>Sat, 01 Jan 2026 00:00:00 +0800</pubDate>
      <enclosure url="https://share.dmhy.org/some.torrent" type="application/x-bittorrent" length="100"/>
    </item>
    <item>
      <title></title>
      <link>https://share.dmhy.org/topics/view/2.html</link>
      <pubDate>Sat, 01 Jan 2026 00:00:00 +0800</pubDate>
      <enclosure url="magnet:?xt=urn:btih:cccc3333" type="application/x-bittorrent" length="100"/>
    </item>
    <item>
      <title>[Y] Valid</title>
      <link>https://share.dmhy.org/topics/view/3.html</link>
      <pubDate>Sat, 01 Jan 2026 00:00:00 +0800</pubDate>
      <enclosure url="magnet:?xt=urn:btih:dddd4444" type="application/x-bittorrent" length="100"/>
    </item>` + dmhyRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchDmhy(context.Background(), httpClient, "x")
	require.NoError(t, err)
	require.Len(t, items, 1, "only the magnet-bearing item with a title survives")
	assert.Equal(t, "[Y] Valid", items[0].Title)
	assert.Equal(t, "magnet:?xt=urn:btih:dddd4444", items[0].Magnet)
}

// ---------------------------------------------------------------------------
// FetchDmhy — empty channel
// ---------------------------------------------------------------------------

func TestFetchDmhy_EmptyChannel(t *testing.T) {
	t.Parallel()

	const body = dmhyRSSHeader + dmhyRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchDmhy(context.Background(), httpClient, "no-results")
	require.NoError(t, err)
	assert.Empty(t, items, "empty channel produces an empty slice without error")
}

// ---------------------------------------------------------------------------
// FetchDmhy — error paths
// ---------------------------------------------------------------------------

func TestFetchDmhy_Non2xxStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchDmhy(context.Background(), httpClient, "x")
	require.Error(t, err)
	assert.Empty(t, items)
	assert.Contains(t, err.Error(), "dmhy")
}

func TestFetchDmhy_TransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	httpClient := newRewriteClient(url)
	items, err := FetchDmhy(context.Background(), httpClient, "x")
	require.Error(t, err)
	assert.Empty(t, items)
}

func TestFetchDmhy_MalformedXML(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<not-xml`))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	_, err := FetchDmhy(context.Background(), httpClient, "x")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode")
}

// ---------------------------------------------------------------------------
// buildDmhyURL — keyword param encoding
// ---------------------------------------------------------------------------

func TestBuildDmhyURL_EncodesKeyword(t *testing.T) {
	t.Parallel()

	got, err := buildDmhyURL("葬送的 芙莉莲")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(got, dmhyEndpoint+"?"), "endpoint base preserved")
	assert.Contains(t, got, "keyword=", "keyword param present")
	// Spaces / CJK must be percent-encoded, never raw.
	assert.NotContains(t, got, "葬送", "CJK must be percent-encoded")
	assert.NotContains(t, got, " ", "spaces must be percent-encoded")
}
