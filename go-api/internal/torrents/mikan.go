// Package torrents — mikan.go
//
// Mikan Project (mikanani.me) RSS fetchers.  Mikan is a popular
// Chinese-sub aggregator with broad coverage; its keyword search catches
// releases the other sources miss, and its per-bangumi feed lists every
// fansub group's releases for one season, full history included.
//
// Endpoint shapes (both feeds share the item format below):
//
//	GET https://mikanani.me/RSS/Search?searchstr=<q>
//	GET https://mikanani.me/RSS/Bangumi?bangumiId=<id>
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
//   - size   → FormatBinaryBytes(torrent.contentLength)  (bytes → "X.X GiB")
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
	"strconv"
)

// SourceMikan is mikanani.me — the Mikan Project aggregator's RSS feeds,
// keyword search and per-bangumi alike.  Declared here (not types.go)
// because Mikan is this file's source.
const SourceMikan Source = "mikan"

// mikanEndpoint is Mikan's keyword-search RSS endpoint.  The term rides
// on ?searchstr=<q>.
const mikanEndpoint = "https://mikanani.me/RSS/Search"

// mikanBangumiEndpoint is Mikan's per-bangumi RSS endpoint: every release
// for one Mikan bangumi page (one season), newest first.  The id rides on
// ?bangumiId=<id>.
const mikanBangumiEndpoint = "https://mikanani.me/RSS/Bangumi"

// mikanBangumiMaxBytes bounds how much of a per-bangumi feed is read.  A
// season's page fits; the pages of very long-running shows list thousands
// of releases and pass it.  Those are cut here, and since the feed lists
// the newest releases first, the cut drops the oldest.  The bound also
// keeps such a show's response to a list the magnet modal can render, and
// its download inside the request's time budget.
const mikanBangumiMaxBytes = 1 << 20

// mikanDrainBytes is how much of an unread body is drained before closing
// it, so the connection can be reused.  A feed that was cut is closed
// without draining.
const mikanDrainBytes = 64 << 10

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

	// 0: the keyword search reads its whole response, as it always has.
	feed, err := fetchMikanFeed(ctx, httpClient, endpoint, 0)
	if err != nil {
		return nil, err
	}

	return mapMikanItems(feed.Items), nil
}

// FetchMikanByBangumi reads Mikan's per-bangumi RSS feed for one Mikan
// bangumi id and returns its releases as TorrentItems tagged SourceMikan.
// It is the id-keyed counterpart to FetchMikan's keyword search: same item
// format, same parsing and mapping.
//
// At most mikanBangumiMaxBytes of the feed are read, and no more than ctx
// allows.  A feed cut by either keeps the items that ended before the cut,
// which are the newest.  Other errors match FetchMikan (network / non-2xx /
// decode → (nil, err)); an id below 1 is an error and sends no request.
func FetchMikanByBangumi(ctx context.Context, httpClient *http.Client, mikanID int) ([]TorrentItem, error) {
	return fetchMikanBangumi(ctx, httpClient, mikanID, mikanBangumiMaxBytes)
}

// fetchMikanBangumi is FetchMikanByBangumi with the size bound as a
// parameter, so tests can cut a small feed at an exact byte.
func fetchMikanBangumi(ctx context.Context, httpClient *http.Client, mikanID int, maxBytes int64) ([]TorrentItem, error) {
	if mikanID < 1 {
		return nil, fmt.Errorf("mikan: invalid bangumi id %d", mikanID)
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	endpoint, err := buildMikanBangumiURL(mikanID)
	if err != nil {
		return nil, fmt.Errorf("mikan: build bangumi url: %w", err)
	}

	feed, err := fetchMikanFeed(ctx, httpClient, endpoint, maxBytes)
	if err != nil {
		return nil, err
	}

	return mapMikanItems(feed.Items), nil
}

// fetchMikanFeed performs the HTTP GET + decode into mikanFeed, mirroring
// fetchRSS's error contract but for Mikan's namespaced envelope.  Kept
// local because the shared fetchRSS hard-codes the plain rssFeed shape
// and Mikan needs the <torrent> extension.
//
// maxBytes > 0 makes the read bounded: at most maxBytes of the body are
// decoded, and a feed cut by that bound or by ctx keeps every item that
// ended before the cut.  encoding/xml appends each <item> to feed.Items
// once it is complete and drops the one an error interrupts, and the error
// here is the cut; TestFetchMikanBangumi_CutsAtTheByteBound and
// TestFetchMikanByBangumi_DeadlineKeepsTheItemsReadSoFar pin that.  A cut
// that leaves no complete item is an error.  maxBytes 0 reads the whole
// body, and any decode error fails the fetch.
func fetchMikanFeed(ctx context.Context, httpClient *http.Client, endpoint string, maxBytes int64) (*mikanFeed, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("mikan: build request: %w", err)
	}
	req.Header.Set("User-Agent", userAgent)

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("mikan: http do: %w", err)
	}
	cut := false
	defer func() {
		if !cut {
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, mikanDrainBytes))
		}
		_ = res.Body.Close()
	}()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("mikan: upstream status %d", res.StatusCode)
	}

	body := io.Reader(res.Body)
	var limited *io.LimitedReader
	if maxBytes > 0 {
		limited = &io.LimitedReader{R: res.Body, N: maxBytes}
		body = limited
	}

	var feed mikanFeed
	if err := xml.NewDecoder(body).Decode(&feed); err != nil {
		cut = limited != nil && (limited.N == 0 || ctx.Err() != nil)
		if !cut || len(feed.Items) == 0 {
			return nil, fmt.Errorf("mikan: decode response: %w", err)
		}
	}
	return &feed, nil
}

// buildMikanBangumiURL composes Mikan's per-bangumi RSS URL with
// ?bangumiId=<id>.
func buildMikanBangumiURL(mikanID int) (string, error) {
	u, err := url.Parse(mikanBangumiEndpoint)
	if err != nil {
		return "", err
	}
	vals := u.Query()
	vals.Set("bangumiId", strconv.Itoa(mikanID))
	u.RawQuery = vals.Encode()
	return u.String(), nil
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
			Size:   FormatBinaryBytes(it.Torrent.ContentLength),
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
