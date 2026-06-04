// Package torrents — mikan.go
//
// Mikan Project (mikanani.me) keyword-search RSS fetcher.  Mikan is a
// popular Chinese-sub aggregator with broad coverage; its keyword search
// catches releases the other sources miss.
//
// Endpoint shape:
//
//	GET https://mikanani.me/RSS/Search?searchstr=<q>
//
//	<rss version="2.0" xmlns:torrent="https://mikanani.me/0.1/">
//	  <channel>
//	    <item>
//	      <title>[字幕组] 番名 - 01</title>
//	      <link>https://mikanani.me/Home/Episode/<40-hex-infohash></link>
//	      <enclosure type="application/x-bittorrent" length="0"
//	         url="https://mikanani.me/Download/<date>/<40-hex-infohash>.torrent"/>
//	      <torrent xmlns="https://mikanani.me/0.1/">
//	        <link>...</link>
//	        <contentLength>1500000000</contentLength>   <!-- bytes -->
//	        <pubDate>2026-01-01T12:00:00</pubDate>
//	      </torrent>
//	    </item>
//	  </channel>
//	</rss>
//
// Two Mikan-specific quirks the shared rss.go can't cover generically:
//
//  1. No magnet in the feed.  The <enclosure url> is a .torrent file,
//     but its filename — and the <link> path — embed the 40-hex
//     infohash (".../Download/<date>/<HASH>.torrent",
//     ".../Episode/<HASH>").  We regex the hash out and synthesise a
//     magnet via buildNyaaMagnet (reusing nyaa.go's tracker-baked
//     builder rather than duplicating it).  Enclosure url is tried
//     first, then <link> as a fallback.
//
//  2. Size lives in the namespaced <torrent><contentLength> (bytes),
//     not the enclosure @length (which Mikan sends as 0).  Go's
//     encoding/xml resolves the namespace by full URI, so the field tag
//     uses "https://mikanani.me/0.1/ contentLength".
//
// Mapping:
//   - title  → item.title
//   - magnet → buildNyaaMagnet(hashFrom(enclosure.url|link), title, link)
//   - size   → FormatBytes(torrent.contentLength)  (bytes → "X.X GB")
//   - fansub → ParseFansub(title)
//   - date   → item.pubDate (channel-level; falls back to namespaced
//     torrent pubDate when the channel one is absent)
//   - source → SourceMikan
//
// No seeders, no provider; does NOT implement Capable.
package torrents

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
)

// SourceMikan is mikanani.me — keyword-search RSS of the Mikan Project
// aggregator.  Declared here (not types.go) because Mikan is this file's
// source.
const SourceMikan Source = "mikan"

// mikanEndpoint is Mikan's keyword-search RSS endpoint.  The term rides
// on ?searchstr=<q>.
const mikanEndpoint = "https://mikanani.me/RSS/Search"

// mikanNamespaceURI is the XML namespace for Mikan's <torrent> element
// and its children.  encoding/xml resolves namespaced tags by full URI,
// not by the "torrent:" alias declared on <rss>.
const mikanNamespaceURI = "https://mikanani.me/0.1/"

// infoHashRE matches a 40-hex-character BitTorrent v1 infohash anywhere
// in a string.  Mikan embeds it in the .torrent download URL and the
// episode <link>; FindString returns the first match (the hash) or "".
// Anchored to exactly 40 hex chars so surrounding path segments / dates
// can't widen or shorten the capture.
var infoHashRE = regexp.MustCompile(`[0-9a-fA-F]{40}`)

// mikanTorrentExt is Mikan's namespaced <torrent> element, carrying the
// byte-accurate size (and a fallback pubDate).  Kept separate from the
// shared rssItem so the generic envelope stays source-agnostic.
type mikanTorrentExt struct {
	ContentLength string `xml:"https://mikanani.me/0.1/ contentLength"`
	PubDate       string `xml:"https://mikanani.me/0.1/ pubDate"`
}

// mikanItem is one <item> in Mikan's feed: the shared RSS fields plus the
// namespaced <torrent> extension.  Embedding rssItem keeps the common
// title/link/pubDate/enclosure decode identical to the other sources.
type mikanItem struct {
	rssItem
	Torrent mikanTorrentExt `xml:"https://mikanani.me/0.1/ torrent"`
}

// mikanFeed is Mikan's <rss> envelope.  Decoded separately from the
// shared rssFeed because each item carries the namespaced <torrent>
// extension above.
type mikanFeed struct {
	XMLName xml.Name    `xml:"rss"`
	Items   []mikanItem `xml:"channel>item"`
}

// mikanSource is the Fetcher adapter for mikanani.me.  Thin struct in the
// gardenSource mould binding the shared *http.Client and delegating to
// FetchMikan.  Being an RSS scrape it does NOT implement Capable.
type mikanSource struct {
	client *http.Client
}

func (s mikanSource) Name() Source { return SourceMikan }

func (s mikanSource) Fetch(ctx context.Context, q string) ([]TorrentItem, error) {
	return FetchMikan(ctx, s.client, q)
}

// FetchMikan hits Mikan's keyword-search RSS feed, parses the envelope
// (with the namespaced <torrent> extension), synthesises magnets from
// the embedded infohash, and returns the filtered TorrentItems.
//
// Error behaviour matches the other fetchers (network/non-2xx/decode →
// (nil, err)).  The HTTP fetch reuses the shared User-Agent + status
// handling but decodes into mikanFeed (not the shared rssFeed) because
// of the namespaced size element.
func FetchMikan(ctx context.Context, httpClient *http.Client, q string) ([]TorrentItem, error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	endpoint, err := buildMikanURL(q)
	if err != nil {
		return nil, fmt.Errorf("mikan: build url: %w", err)
	}

	feed, err := fetchMikanFeed(ctx, httpClient, endpoint)
	if err != nil {
		return nil, err
	}

	return mapMikanItems(feed.Items), nil
}

// fetchMikanFeed performs the HTTP GET + decode into mikanFeed, mirroring
// fetchRSS's error contract but for Mikan's namespaced envelope.  Kept
// local because the shared fetchRSS hard-codes the plain rssFeed shape
// and Mikan needs the <torrent> extension.
func fetchMikanFeed(ctx context.Context, httpClient *http.Client, endpoint string) (*mikanFeed, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("mikan: build request: %w", err)
	}
	req.Header.Set("User-Agent", userAgent)

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("mikan: http do: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("mikan: upstream status %d", res.StatusCode)
	}

	var feed mikanFeed
	if err := xml.NewDecoder(res.Body).Decode(&feed); err != nil {
		return nil, fmt.Errorf("mikan: decode response: %w", err)
	}
	return &feed, nil
}

// buildMikanURL composes Mikan's RSS URL with ?searchstr=<q>.
func buildMikanURL(q string) (string, error) {
	u, err := url.Parse(mikanEndpoint)
	if err != nil {
		return "", err
	}
	vals := u.Query()
	vals.Set("searchstr", q)
	u.RawQuery = vals.Encode()
	return u.String(), nil
}

// mapMikanItems converts Mikan items into TorrentItems: recover the
// infohash, synthesise a magnet via buildNyaaMagnet, format the size
// from the namespaced contentLength, and apply the same title/magnet
// filter the other sources use.
func mapMikanItems(items []mikanItem) []TorrentItem {
	out := make([]TorrentItem, 0, len(items))
	for _, it := range items {
		hash := mikanInfoHash(it)
		// buildNyaaMagnet returns the raw link (a non-magnet https URL)
		// when the hash is empty, so hasMagnetScheme drops those — same
		// filter the other sources apply.
		magnet := buildNyaaMagnet(hash, it.Title, it.Link)
		if it.Title == "" || !hasMagnetScheme(magnet) {
			continue
		}

		out = append(out, TorrentItem{
			Title:  it.Title,
			Magnet: magnet,
			Size:   FormatBytes(it.Torrent.ContentLength),
			Fansub: ParseFansub(it.Title),
			Date:   mikanDate(it),
			Source: SourceMikan,
		})
	}
	return out
}

// mikanInfoHash extracts the 40-hex infohash for an item.  Mikan embeds
// it in the .torrent enclosure URL (preferred) and the episode <link>
// (fallback); the first 40-hex run in either is the hash.  Returns ""
// when neither carries one — which makes buildNyaaMagnet fall through to
// the non-magnet link and the item gets filtered out.
func mikanInfoHash(it mikanItem) string {
	if h := infoHashRE.FindString(it.Enclosure.URL); h != "" {
		return h
	}
	return infoHashRE.FindString(it.Link)
}

// mikanDate prefers the channel-level <pubDate> and falls back to the
// namespaced <torrent><pubDate> when the channel one is absent, so a
// missing top-level date still yields a usable timestamp.  stringPtr
// maps "" → nil (JSON null), matching the other sources.
func mikanDate(it mikanItem) *string {
	if it.PubDate != "" {
		return stringPtr(it.PubDate)
	}
	return stringPtr(it.Torrent.PubDate)
}
