// Package torrents — nyaa.go
//
// nyaa.si RSS fetcher.  Port of fetchNyaa from
// server/controllers/anime.controller.js:255-287.
//
// Endpoint shape:
//
//	GET https://nyaa.si/?page=rss&q=<term>&c=1_0&f=0
//
//	<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa">
//	  <channel>
//	    <item>
//	      <title>[SomeGroup] Anime - 01</title>
//	      <link>https://nyaa.si/...</link>
//	      <pubDate>...</pubDate>
//	      <nyaa:infoHash>0123...abcdef</nyaa:infoHash>
//	      <nyaa:size>1.5 GiB</nyaa:size>
//	    </item>
//	  </channel>
//	</rss>
//
// nyaa.si does NOT include the magnet URI in the feed.  Express
// constructs one client-side from the infoHash + title + two public
// trackers:
//
//	magnet:?xt=urn:btih:<hash>&dn=<urlencoded-title>
//	  &tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce
//	  &tr=http%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce
//
// Size is the upstream string as-is (no FormatBytes — Nyaa already
// gives human-readable "1.5 GiB").  Source = SourceNyaa.
package torrents

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// nyaaEndpoint is nyaa.si's RSS endpoint.  All query params (page=rss,
// q, c, f) go on the URL by buildNyaaURL.
const nyaaEndpoint = "https://nyaa.si/"

// nyaaCategoryAllAnime is the c=1_0 filter — "all anime".  Same value
// Express sends.
const nyaaCategoryAllAnime = "1_0"

// nyaaFilterNone is f=0 — no remote-banned filter.  Same as Express.
const nyaaFilterNone = "0"

// nyaaNamespaceURI is the XML namespace for nyaa: custom elements.
// Go's encoding/xml requires the full URI in struct tags, not the
// "nyaa:" alias declared on the <rss> element.
const nyaaNamespaceURI = "https://nyaa.si/xmlns/nyaa"

// nyaaTrackers are the two public trackers Express bakes into every
// magnet URI.  Pre-encoded because they're URL parameters inside an
// already-URL-encoded magnet URI.
const (
	nyaaTracker1 = "http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce"
	nyaaTracker2 = "http%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce"
)

// nyaaItem mirrors a single <item> in the nyaa.si RSS feed.
//
// The custom-namespace tags require the full URI form
// "<URI> <localname>" because Go's encoding/xml resolves namespaces by
// URI not by the alias declared in xmlns:nyaa="...".  See
// https://pkg.go.dev/encoding/xml#Unmarshal for the namespace lookup
// rules.
type nyaaItem struct {
	Title    string `xml:"title"`
	Link     string `xml:"link"`
	PubDate  string `xml:"pubDate"`
	InfoHash string `xml:"https://nyaa.si/xmlns/nyaa infoHash"`
	Size     string `xml:"https://nyaa.si/xmlns/nyaa size"`
}

// nyaaRSS is the top-level <rss>.  Same shape as acgRSS — we only need
// the items list.
type nyaaRSS struct {
	XMLName xml.Name   `xml:"rss"`
	Items   []nyaaItem `xml:"channel>item"`
}

// FetchNyaa hits nyaa.si's RSS feed, parses the XML, builds magnet
// URIs from the infoHash + title + tracker constants, and returns the
// filtered TorrentItems.
//
// Error behaviour matches FetchGarden / FetchAcgRip:
//   - Network error → (nil, err)
//   - Non-2xx       → (nil, err) with status
//   - Decode error  → (nil, wrapped xml error)
func FetchNyaa(ctx context.Context, httpClient *http.Client, q string) ([]TorrentItem, error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	endpoint, err := buildNyaaURL(q)
	if err != nil {
		return nil, fmt.Errorf("nyaa: build url: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("nyaa: build request: %w", err)
	}
	req.Header.Set("User-Agent", userAgent)

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("nyaa: http do: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("nyaa: upstream status %d", res.StatusCode)
	}

	var feed nyaaRSS
	if err := xml.NewDecoder(res.Body).Decode(&feed); err != nil {
		return nil, fmt.Errorf("nyaa: decode response: %w", err)
	}

	return mapNyaaItems(feed.Items), nil
}

// buildNyaaURL composes nyaa.si's RSS URL with all four query params.
func buildNyaaURL(q string) (string, error) {
	u, err := url.Parse(nyaaEndpoint)
	if err != nil {
		return "", err
	}
	vals := u.Query()
	vals.Set("page", "rss")
	vals.Set("q", q)
	vals.Set("c", nyaaCategoryAllAnime)
	vals.Set("f", nyaaFilterNone)
	u.RawQuery = vals.Encode()
	return u.String(), nil
}

// mapNyaaItems converts parsed RSS items into TorrentItems and filters
// out entries without a usable magnet URI.
func mapNyaaItems(items []nyaaItem) []TorrentItem {
	out := make([]TorrentItem, 0, len(items))
	for _, it := range items {
		magnet := buildNyaaMagnet(it.InfoHash, it.Title, it.Link)
		if it.Title == "" || !hasMagnetScheme(magnet) {
			continue
		}

		out = append(out, TorrentItem{
			Title:  it.Title,
			Magnet: magnet,
			// Nyaa's size is already a human-readable string ("1.5
			// GiB"); we pass it through unchanged to match Express.
			Size:   it.Size,
			Fansub: ParseFansub(it.Title),
			Date:   stringPtr(it.PubDate),
			Source: SourceNyaa,
		})
	}
	return out
}

// buildNyaaMagnet constructs the magnet URI from the upstream infoHash
// and title.  If the hash is empty, falls back to the upstream <link>
// (which is typically an https URL to nyaa.si — filtered out by the
// magnet: check upstream).
//
// The title is URL-escaped for the &dn= parameter using
// url.QueryEscape.  The trackers are baked in as the two well-known
// public trackers Express uses.
func buildNyaaMagnet(rawHash, title, link string) string {
	hash := strings.TrimSpace(rawHash)
	if hash == "" {
		return link
	}
	return "magnet:?xt=urn:btih:" + hash +
		"&dn=" + url.QueryEscape(title) +
		"&tr=" + nyaaTracker1 +
		"&tr=" + nyaaTracker2
}
