// Package torrents — nyaa_test.go
//
// Covers:
//   - happy path: valid RSS with custom nyaa: namespace → parsed items
//   - magnet construction includes hash + url-encoded title + 2 trackers
//   - title with special chars (#, &, spaces, CJK) URL-encoded in &dn=
//   - size pass-through (no FormatBytes — nyaa returns "1.5 GiB" already)
//   - empty infoHash + non-magnet link → item dropped
//   - error paths: non-2xx, transport error, malformed XML
//   - request includes the four expected query params
package torrents

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// nyaaRSSHeader / Footer — same idea as the acgRSS pair, with the
// nyaa: namespace declaration on the root element.  The xmlns:nyaa
// URI must match nyaaNamespaceURI in nyaa.go or encoding/xml will not
// resolve the custom-element tags.
const nyaaRSSHeader = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:nyaa="https://nyaa.si/xmlns/nyaa">
  <channel>
    <title>Nyaa</title>`

const nyaaRSSFooter = `
  </channel>
</rss>`

// ---------------------------------------------------------------------------
// FetchNyaa — happy path + namespace handling
// ---------------------------------------------------------------------------

func TestFetchNyaa_HappyPath(t *testing.T) {
	t.Parallel()

	const body = nyaaRSSHeader + `
    <item>
      <title>[SomeGroup] Anime - 01</title>
      <link>https://nyaa.si/view/1234</link>
      <pubDate>Sat, 01 Jan 2026 12:00:00 GMT</pubDate>
      <nyaa:infoHash>0123456789abcdef0123456789abcdef01234567</nyaa:infoHash>
      <nyaa:size>1.5 GiB</nyaa:size>
    </item>` + nyaaRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify all four query params.
		q := r.URL.Query()
		assert.Equal(t, "rss", q.Get("page"))
		assert.Equal(t, "naruto", q.Get("q"))
		assert.Equal(t, "1_0", q.Get("c"))
		assert.Equal(t, "0", q.Get("f"))
		assert.Equal(t, "AnimeGo/1.0", r.Header.Get("User-Agent"))
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchNyaa(context.Background(), httpClient, "naruto")
	require.NoError(t, err)
	require.Len(t, items, 1)

	it := items[0]
	assert.Equal(t, "[SomeGroup] Anime - 01", it.Title)
	assert.Equal(t, SourceNyaa, it.Source)
	assert.Equal(t, "1.5 GiB", it.Size, "Nyaa size is passed through verbatim — no FormatBytes")
	require.NotNil(t, it.Fansub)
	assert.Equal(t, "SomeGroup", *it.Fansub)

	// Magnet must include hash, urlencoded title, and BOTH trackers.
	assert.Contains(t, it.Magnet, "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")
	assert.Contains(t, it.Magnet, "&dn=")
	assert.Contains(t, it.Magnet, "&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce")
	assert.Contains(t, it.Magnet, "&tr=http%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce")

	// The title's spaces / hyphens must be URL-escaped under &dn=.
	// url.QueryEscape encodes space → "+" — we accept either form
	// since both decode to the same magnet.
	dn := extractMagnetParam(t, it.Magnet, "dn")
	assert.Equal(t, "[SomeGroup] Anime - 01", dn,
		"&dn= should decode back to the original title")
}

// TestFetchNyaa_SpecialCharsInTitle covers the URL-escape edge case
// the task brief calls out: '#', '&', spaces, and CJK characters must
// all survive a round trip through the &dn= parameter.
func TestFetchNyaa_SpecialCharsInTitle(t *testing.T) {
	t.Parallel()

	const body = nyaaRSSHeader + `
    <item>
      <title>[喵萌奶茶屋&amp;Lol] Show #1 - 01</title>
      <link>https://nyaa.si/view/1</link>
      <pubDate>...</pubDate>
      <nyaa:infoHash>abcdef0123456789abcdef0123456789abcdef01</nyaa:infoHash>
      <nyaa:size>900 MiB</nyaa:size>
    </item>` + nyaaRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchNyaa(context.Background(), httpClient, "x")
	require.NoError(t, err)
	require.Len(t, items, 1)

	// Encoded form should not contain raw '#' or '&' in dn — they must
	// appear as %23 / %26 (QueryEscape rules).
	dnEncoded := extractDnRaw(items[0].Magnet)
	assert.NotContains(t, dnEncoded, "#", "raw # in &dn= would break the magnet URI")
	assert.Contains(t, dnEncoded, "%23", "expected # escaped as %23")
	// '&' inside the title must be %26-encoded so it doesn't terminate
	// the dn parameter.
	assert.Contains(t, dnEncoded, "%26", "expected & escaped as %26")

	// Round-trip: decoding dn should yield the original title.
	dn := extractMagnetParam(t, items[0].Magnet, "dn")
	assert.Equal(t, "[喵萌奶茶屋&Lol] Show #1 - 01", dn)
}

// ---------------------------------------------------------------------------
// FetchNyaa — missing hash + non-magnet link → dropped
// ---------------------------------------------------------------------------

func TestFetchNyaa_EmptyHashFallsBackToLink(t *testing.T) {
	t.Parallel()

	const body = nyaaRSSHeader + `
    <item>
      <title>[X] No Hash, HTTP Link</title>
      <link>https://nyaa.si/view/1234</link>
      <pubDate>...</pubDate>
      <nyaa:infoHash></nyaa:infoHash>
      <nyaa:size>500 MiB</nyaa:size>
    </item>
    <item>
      <title>[Y] Has Hash</title>
      <link>https://nyaa.si/view/5678</link>
      <pubDate>...</pubDate>
      <nyaa:infoHash>ffffffffffffffffffffffffffffffffffffffff</nyaa:infoHash>
      <nyaa:size>800 MiB</nyaa:size>
    </item>` + nyaaRSSFooter

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchNyaa(context.Background(), httpClient, "x")
	require.NoError(t, err)
	require.Len(t, items, 1, "only the item with a hash → magnet should survive")
	assert.Equal(t, "[Y] Has Hash", items[0].Title)
}

// ---------------------------------------------------------------------------
// FetchNyaa — error paths
// ---------------------------------------------------------------------------

func TestFetchNyaa_Non2xxStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	items, err := FetchNyaa(context.Background(), httpClient, "x")
	require.Error(t, err)
	assert.Empty(t, items)
	assert.Contains(t, err.Error(), "nyaa")
}

func TestFetchNyaa_TransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	httpClient := newRewriteClient(url)
	_, err := FetchNyaa(context.Background(), httpClient, "x")
	require.Error(t, err)
}

func TestFetchNyaa_MalformedXML(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<oops>`))
	}))
	defer srv.Close()

	httpClient := newRewriteClient(srv.URL)
	_, err := FetchNyaa(context.Background(), httpClient, "x")
	require.Error(t, err)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// extractMagnetParam parses the magnet URI and returns the named
// query parameter's decoded value.  Magnet URIs are a special-cased
// scheme but the query-string portion follows standard URL-encoded
// form rules, so net/url.ParseQuery works directly on the substring
// after '?'.
func extractMagnetParam(t *testing.T, magnet, name string) string {
	t.Helper()
	i := strings.Index(magnet, "?")
	require.NotEqual(t, -1, i, "magnet must contain ?")
	values, err := url.ParseQuery(magnet[i+1:])
	require.NoError(t, err)
	return values.Get(name)
}

// extractDnRaw returns the raw (still URL-encoded) value of the dn
// parameter — without ParseQuery decoding it.  Used by the
// special-chars test to verify the wire-level percent-encoding,
// not just the round-trip decode.
func extractDnRaw(magnet string) string {
	i := strings.Index(magnet, "&dn=")
	if i < 0 {
		return ""
	}
	tail := magnet[i+len("&dn="):]
	end := strings.Index(tail, "&")
	if end < 0 {
		return tail
	}
	return tail[:end]
}
