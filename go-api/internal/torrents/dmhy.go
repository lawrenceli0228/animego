// Package torrents — dmhy.go
//
// 动漫花园 (share.dmhy.org) direct RSS fetcher.  dmhy is the canonical
// Chinese-sub release tracker; animes.garden (garden.go) already
// aggregates a dmhy mirror, but hitting dmhy directly catches releases
// the aggregator hasn't ingested yet and is resilient to garden being
// down.
//
// Endpoint shape:
//
//	GET https://share.dmhy.org/topics/rss/rss.xml?keyword=<q>
//
//	<rss version="2.0">
//	  <channel>
//	    <item>
//	      <title>[字幕组] 番名 - 01 [1080p]</title>
//	      <link>https://share.dmhy.org/topics/view/...</link>
//	      <pubDate>Sat, 01 Jan 2026 00:00:00 +0800</pubDate>
//	      <enclosure url="magnet:?xt=urn:btih:...&amp;dn=..."
//	                 type="application/x-bittorrent" length="0"/>
//	    </item>
//	  </channel>
//	</rss>
//
// The magnet sits DIRECTLY in <enclosure url="..."> (simpler than nyaa,
// which has to synthesise one from an infohash).  dmhy XML-escapes the
// magnet's "&" as "&amp;" on the wire; encoding/xml decodes that back to
// "&" automatically, so the resolved url is already a usable magnet —
// no manual unescape (which would double-decode and corrupt a literal
// &amp;).
//
// Mapping:
//   - title  → item.title
//   - magnet → item.enclosure.url (must start with "magnet:", else drop)
//   - size   → FormatBytes(item.enclosure.length); dmhy often sends
//     length="0" → FormatBytes returns "" (no size), which is fine.
//   - fansub → ParseFansub(title)
//   - date   → item.pubDate
//   - source → SourceDmhy
//
// No seeders (RSS gives none) and no provider.  Does NOT implement
// Capable — like the other RSS scrapes it has no special capabilities.
package torrents

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// SourceDmhy is share.dmhy.org — direct RSS of the 动漫花园 tracker.
// Declared here (not types.go) because dmhy is this file's source.
const SourceDmhy Source = "dmhy"

// dmhyEndpoint is the share.dmhy.org keyword-search RSS endpoint.  The
// query term rides on ?keyword=<q>.
const dmhyEndpoint = "https://share.dmhy.org/topics/rss/rss.xml"

// dmhySource is the Fetcher adapter for share.dmhy.org.  Thin struct in
// the gardenSource mould: it binds the shared *http.Client and delegates
// to FetchDmhy.  Being an RSS scrape it does NOT implement Capable.
type dmhySource struct {
	client *http.Client
}

func (s dmhySource) Name() Source { return SourceDmhy }

func (s dmhySource) Fetch(ctx context.Context, q string) ([]TorrentItem, error) {
	return FetchDmhy(ctx, s.client, q)
}

// FetchDmhy hits dmhy's keyword RSS feed, parses the shared RSS
// envelope, and returns the filtered TorrentItems.  Error behaviour
// matches the other fetchers (network/non-2xx/decode → (nil, err)) via
// the shared fetchRSS helper.
func FetchDmhy(ctx context.Context, httpClient *http.Client, q string) ([]TorrentItem, error) {
	endpoint, err := buildDmhyURL(q)
	if err != nil {
		return nil, fmt.Errorf("dmhy: build url: %w", err)
	}

	feed, err := fetchRSS(ctx, httpClient, "dmhy", endpoint)
	if err != nil {
		return nil, err
	}

	return mapRSSItems(feed.Items, SourceDmhy, dmhyMagnet, dmhySize), nil
}

// buildDmhyURL composes dmhy's RSS URL with ?keyword=<q>.  url.Values
// handles escaping for queries with spaces / brackets / CJK characters.
func buildDmhyURL(q string) (string, error) {
	u, err := url.Parse(dmhyEndpoint)
	if err != nil {
		return "", err
	}
	vals := u.Query()
	vals.Set("keyword", q)
	u.RawQuery = vals.Encode()
	return u.String(), nil
}

// dmhyMagnet resolves the magnet for a dmhy item: it's the enclosure
// url verbatim (already a decoded magnet URI).  Non-magnet values are
// filtered out downstream by mapRSSItems via hasMagnetScheme.
func dmhyMagnet(it rssItem) string {
	return it.Enclosure.URL
}

// dmhySize formats the enclosure @length byte count.  dmhy commonly
// sends length="0", in which case FormatBytes returns "" — an empty
// Size string, the same "no size available" signal the other fetchers
// produce.
func dmhySize(it rssItem) string {
	return FormatBytes(it.Enclosure.Length)
}
