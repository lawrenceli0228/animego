// Package torrents — acgrip.go
//
// acg.rip RSS fetcher.  Port of fetchAcgRip from
// server/controllers/anime.controller.js:184-206.
//
// Endpoint shape:
//
//	GET https://acg.rip/.xml?term=<q>
//
//	<rss>
//	  <channel>
//	    <item>
//	      <title>[SubsPlease] Ep 1</title>
//	      <link>https://acg.rip/...</link>
//	      <pubDate>Sat, 01 Jan 2026 00:00:00 GMT</pubDate>
//	      <enclosure url="magnet:?xt=..." length="1234567890"
//	                 type="application/x-bittorrent"/>
//	    </item>
//	  </channel>
//	</rss>
//
// Mapping (verbatim from Express):
//   - title       → item.title
//   - magnet      → item.enclosure.url, fallback item.link
//   - size        → FormatBytes(item.enclosure.length)
//   - fansub      → ParseFansub(title)
//   - date        → item.pubDate
//   - source      → SourceAcg
//
// Filter: drop items whose magnet doesn't start with "magnet:".
package torrents

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// acgEndpoint is the acg.rip RSS XML endpoint.
const acgEndpoint = "https://acg.rip/.xml"

// acgEnclosure mirrors the <enclosure> element.  acg.rip puts the
// magnet URI directly in the @url attribute (not the typical http link)
// and the byte count in @length.
type acgEnclosure struct {
	URL    string `xml:"url,attr"`
	Length string `xml:"length,attr"`
	Type   string `xml:"type,attr"`
}

// acgItem is one <item> in the RSS feed.  Unknown elements are
// silently dropped by encoding/xml — acg.rip occasionally adds custom
// fields and we don't want a strict decoder failing on those.
type acgItem struct {
	Title     string       `xml:"title"`
	Link      string       `xml:"link"`
	PubDate   string       `xml:"pubDate"`
	Enclosure acgEnclosure `xml:"enclosure"`
}

// acgRSS is the full RSS envelope.  We only care about <channel><item>
// elements; everything else (channel metadata, generator, etc.) is
// ignored.
type acgRSS struct {
	XMLName xml.Name  `xml:"rss"`
	Items   []acgItem `xml:"channel>item"`
}

// FetchAcgRip hits acg.rip's RSS feed for the search term, parses the
// XML, and returns the filtered set of TorrentItems.
//
// Error behaviour mirrors FetchGarden:
//   - Network error → (nil, err) for aggregator partial-tolerance.
//   - Non-2xx       → (nil, err) carrying the status.
//   - Decode error  → (nil, wrapped xml error).
func FetchAcgRip(ctx context.Context, httpClient *http.Client, q string) ([]TorrentItem, error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	endpoint, err := buildAcgURL(q)
	if err != nil {
		return nil, fmt.Errorf("acgrip: build url: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("acgrip: build request: %w", err)
	}
	req.Header.Set("User-Agent", userAgent)

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("acgrip: http do: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("acgrip: upstream status %d", res.StatusCode)
	}

	var feed acgRSS
	if err := xml.NewDecoder(res.Body).Decode(&feed); err != nil {
		return nil, fmt.Errorf("acgrip: decode response: %w", err)
	}

	return mapAcgItems(feed.Items), nil
}

// buildAcgURL composes acg.rip's XML endpoint with ?term=<q>.  Uses
// url.Values to handle escaping for queries with spaces / brackets /
// CJK characters.
func buildAcgURL(q string) (string, error) {
	u, err := url.Parse(acgEndpoint)
	if err != nil {
		return "", err
	}
	vals := u.Query()
	vals.Set("term", q)
	u.RawQuery = vals.Encode()
	return u.String(), nil
}

// mapAcgItems converts parsed RSS items to TorrentItems with the
// Express mapping rules: enclosure[url] wins over link, size formatted
// from enclosure[length], fansub bracket-parsed, filter out non-magnet
// URIs.
func mapAcgItems(items []acgItem) []TorrentItem {
	out := make([]TorrentItem, 0, len(items))
	for _, it := range items {
		magnet := it.Enclosure.URL
		if magnet == "" {
			magnet = it.Link
		}
		if it.Title == "" || !hasMagnetScheme(magnet) {
			continue
		}

		out = append(out, TorrentItem{
			Title:  it.Title,
			Magnet: magnet,
			Size:   FormatBytes(it.Enclosure.Length),
			Fansub: ParseFansub(it.Title),
			Date:   stringPtr(it.PubDate),
			Source: SourceAcg,
		})
	}
	return out
}
