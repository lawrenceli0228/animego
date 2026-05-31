// Package torrents — acgrip_test.go
//
// Covers:
//   - happy path (valid RSS → parsed items)
//   - enclosure missing → falls back to <link>; non-magnet link → filtered
//   - empty channel → empty slice (no error)
//   - non-2xx upstream → empty slice + error
//   - decode failure on malformed XML → wrapped error
//   - URL is constructed with ?term=<q>
package torrents

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// acgRSSHeader is the shared XML declaration + <rss><channel> wrapper.
// Tests fill in the inner <item> block per case.  Kept as a helper to
// keep individual test bodies focused on the mapping under test.
const acgRSSHeader = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>acg.rip</title>`

const acgRSSFooter = `
  </channel>
</rss>`

// ---------------------------------------------------------------------------
// FetchAcgRip — happy path
// ---------------------------------------------------------------------------

func TestFetchAcgRip_HappyPath(t *testing.T) {
	t.Parallel()

	const body = acgRSSHeader + `
    <item>
      <title>[SubsPlease] Show - 01 [1080p]</title>
      <link>https://acg.rip/t/1234</link>
      <pubDate>Sat, 01 Jan 2026 12:00:00 GMT</pubDate>
      <enclosure url="magnet:?xt=urn:btih:aaa" length="1234567890" type="application/x-bittorrent"/>
    </item>
    <item>
      <title>[VCB] Other - 02</title>
      <link>https://acg.rip/t/5678</link>
      <pubDate>Sat, 01 Jan 2026 13:00:00 GMT</pubDate>
      <enclosure url="magnet:?xt=urn:btih:bbb" length="500000" type="application/x-bittorrent"/>
    </item>` + acgRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "naruto", r.URL.Query().Get("term"))
		assert.Equal(t, "AnimeGo/1.0", r.Header.Get("User-Agent"))
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAcgRip(context.Background(), httpClient, "naruto")
	require.NoError(t, err)
	require.Len(t, items, 2)

	assert.Equal(t, "[SubsPlease] Show - 01 [1080p]", items[0].Title)
	assert.Equal(t, "magnet:?xt=urn:btih:aaa", items[0].Magnet)
	assert.Equal(t, "1.2 GB", items[0].Size) // 1234567890 → 1.234... → 1.2 GB
	require.NotNil(t, items[0].Fansub)
	assert.Equal(t, "SubsPlease", *items[0].Fansub)
	assert.Equal(t, SourceAcg, items[0].Source)
	assert.Nil(t, items[0].Provider, "acg never sets provider")

	assert.Equal(t, "500 KB", items[1].Size) // 500000 → 500 KB (round down)
}

// ---------------------------------------------------------------------------
// FetchAcgRip — fallback to <link> when enclosure missing
// ---------------------------------------------------------------------------

func TestFetchAcgRip_EnclosureMissingFallsBackToLink(t *testing.T) {
	t.Parallel()

	// First item: no enclosure, link is non-magnet → filtered out.
	// Second item: no enclosure, link IS a magnet → kept.
	const body = acgRSSHeader + `
    <item>
      <title>[X] No Enclosure, HTTP Link</title>
      <link>https://acg.rip/t/1234</link>
      <pubDate>Sat, 01 Jan 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>[Y] No Enclosure, Magnet Link</title>
      <link>magnet:?xt=urn:btih:ccc</link>
      <pubDate>Sat, 01 Jan 2026 13:00:00 GMT</pubDate>
    </item>` + acgRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAcgRip(context.Background(), httpClient, "x")
	require.NoError(t, err)
	require.Len(t, items, 1, "only the item with a magnet-prefix link should survive")
	assert.Equal(t, "magnet:?xt=urn:btih:ccc", items[0].Magnet)
	assert.Equal(t, "[Y] No Enclosure, Magnet Link", items[0].Title)
}

// ---------------------------------------------------------------------------
// FetchAcgRip — empty channel
// ---------------------------------------------------------------------------

func TestFetchAcgRip_EmptyChannel(t *testing.T) {
	t.Parallel()

	const body = acgRSSHeader + acgRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAcgRip(context.Background(), httpClient, "no-results")
	require.NoError(t, err)
	assert.Empty(t, items, "empty channel produces empty slice without error")
}

// ---------------------------------------------------------------------------
// FetchAcgRip — error paths
// ---------------------------------------------------------------------------

func TestFetchAcgRip_Non2xxStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchAcgRip(context.Background(), httpClient, "x")
	require.Error(t, err)
	assert.Empty(t, items)
	assert.Contains(t, err.Error(), "acgrip")
}

func TestFetchAcgRip_TransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	httpClient := newRewriteClient(url)
	items, err := FetchAcgRip(context.Background(), httpClient, "x")
	require.Error(t, err)
	assert.Empty(t, items)
}

func TestFetchAcgRip_MalformedXML(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<not-xml`))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	_, err := FetchAcgRip(context.Background(), httpClient, "x")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode")
}

// ---------------------------------------------------------------------------
// Shared helper — see comment on newRewriteClient
// ---------------------------------------------------------------------------

// newRewriteClient builds an *http.Client whose transport rewrites
// every outgoing request to point at the given test URL.  Shared
// across acgrip / nyaa / aggregator tests so each package-level
// endpoint constant stays a const in production while still being
// httptest-friendly.
func newRewriteClient(targetURL string) *http.Client {
	return &http.Client{Transport: &rewriteTransport{base: http.DefaultTransport, target: targetURL}}
}
