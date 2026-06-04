// Package torrents — rss.go
//
// Shared RSS-2.0 parsing primitives for the enclosure-style feeds
// (acg.rip / dmhy / Mikan).  acg.rip, dmhy and Mikan all speak the same
// <rss><channel><item> envelope with a <title> / <link> / <pubDate> /
// <enclosure> per item; the only thing that differs between them is how
// the magnet URI is obtained:
//
//   - acg.rip : magnet sits directly in <enclosure url="magnet:...">.
//   - dmhy    : same as acg.rip — magnet directly in the enclosure url
//     (XML-escaped as &amp; on the wire, auto-decoded by encoding/xml).
//   - Mikan   : enclosure points at a .torrent file (no magnet); the
//     40-hex infohash is recovered from the .torrent URL / <link> and a
//     magnet is synthesised via buildNyaaMagnet (see mikan.go).
//
// This file owns the generic envelope (rssFeed / rssItem) plus the two
// pieces of cross-source logic worth sharing: the HTTP fetch+decode loop
// (fetchRSS) and the per-item → TorrentItem mapping (mapRSSItems), the
// latter parametrised by a magnet-resolver so each source plugs in its
// own "where's the magnet" rule without re-implementing the
// filter/fansub/date plumbing.
//
// acgrip.go is deliberately left on its own decode path so this
// extraction cannot perturb its existing, separately-tested behaviour —
// dmhy.go and mikan.go are the consumers here.
package torrents

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
)

// rssEnclosure mirrors the RSS <enclosure> element.  url carries either
// the magnet URI directly (acg.rip / dmhy) or an https link to a
// .torrent file (Mikan); length is the byte count some feeds put here.
// Both are decoded with XML entities already resolved by encoding/xml,
// so a wire value of "magnet:?xt=...&amp;dn=..." arrives as a proper
// "magnet:?xt=...&dn=..." with no manual unescape needed (and none
// wanted — unescaping again would corrupt a genuinely literal &amp;).
type rssEnclosure struct {
	URL    string `xml:"url,attr"`
	Length string `xml:"length,attr"`
	Type   string `xml:"type,attr"`
}

// rssItem is one <item> in a generic RSS-2.0 feed.  Unknown child
// elements (custom namespaces, per-source extras) are silently ignored
// by encoding/xml — sources that need a namespaced element (e.g. Mikan's
// <torrent><contentLength>) embed this struct and add their own fields
// rather than bloating the shared shape.
type rssItem struct {
	Title     string       `xml:"title"`
	Link      string       `xml:"link"`
	PubDate   string       `xml:"pubDate"`
	Enclosure rssEnclosure `xml:"enclosure"`
}

// rssFeed is the top-level <rss> envelope.  Only <channel><item>
// elements are decoded; channel metadata is ignored.
type rssFeed struct {
	XMLName xml.Name  `xml:"rss"`
	Items   []rssItem `xml:"channel>item"`
}

// magnetResolver derives the magnet URI for one parsed RSS item.
//
// Returning a non-magnet string (or "") causes mapRSSItems to drop the
// item via hasMagnetScheme — the same filtering every legacy fetcher
// applies.  This is the single seam by which each source supplies its
// own magnet rule:
//   - dmhy   : return the enclosure url as-is (it's already a magnet).
//   - Mikan  : recover the infohash from the .torrent url/link and
//     synthesise a magnet via buildNyaaMagnet.
type magnetResolver func(item rssItem) string

// sizeResolver derives the human-readable size string for one parsed
// item.  Sources differ on where the size lives (enclosure @length vs a
// namespaced element) and what unit it's in, so each supplies its own;
// returning "" yields an empty Size, matching the legacy fetchers'
// behaviour when no size is available.
type sizeResolver func(item rssItem) string

// fetchRSS performs the shared HTTP GET + RSS decode used by the
// enclosure-style sources.  It mirrors the error contract of the legacy
// per-source fetchers exactly so partial-failure tolerance in the
// aggregator is unchanged:
//   - network/transport error → (nil, wrapped err)
//   - non-2xx status          → (nil, err carrying the status)
//   - XML decode failure       → (nil, wrapped xml err)
//
// name is the short source tag used only to prefix error messages
// (e.g. "dmhy", "mikan") so an oncall grep can attribute a failure.
// The User-Agent header matches the rest of the package for parity in
// upstream logs.
func fetchRSS(ctx context.Context, httpClient *http.Client, name, endpoint string) (*rssFeed, error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("%s: build request: %w", name, err)
	}
	req.Header.Set("User-Agent", userAgent)

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: http do: %w", name, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s: upstream status %d", name, res.StatusCode)
	}

	var feed rssFeed
	if err := xml.NewDecoder(res.Body).Decode(&feed); err != nil {
		return nil, fmt.Errorf("%s: decode response: %w", name, err)
	}
	return &feed, nil
}

// mapRSSItems converts parsed RSS items into TorrentItems using the
// supplied per-source magnet/size resolvers, applying the filtering and
// field-mapping rules shared by every enclosure-style source:
//
//   - drop items with an empty title OR a non-magnet resolved URI
//     (hasMagnetScheme), exactly as acg.rip / nyaa / garden do;
//   - fansub via ParseFansub on the title;
//   - date via stringPtr on <pubDate> (nil → JSON null when absent);
//   - source stamped from the caller's Source constant.
//
// Size comes from the size resolver so each source controls its own unit
// handling (enclosure @length bytes vs a namespaced contentLength).
func mapRSSItems(items []rssItem, src Source, magnet magnetResolver, size sizeResolver) []TorrentItem {
	out := make([]TorrentItem, 0, len(items))
	for _, it := range items {
		m := magnet(it)
		if it.Title == "" || !hasMagnetScheme(m) {
			continue
		}

		out = append(out, TorrentItem{
			Title:  it.Title,
			Magnet: m,
			Size:   size(it),
			Fansub: ParseFansub(it.Title),
			Date:   stringPtr(it.PubDate),
			Source: src,
		})
	}
	return out
}
